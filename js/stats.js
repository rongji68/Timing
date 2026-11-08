// 统计计算（全部在本机完成）
import * as S from './store.js';
import { matcher } from './search.js';

export const HOUR = 3600e3, DAY = 86400e3;
export const STATUS = { urgent: '紧急', waiting: '等待', completed: '完成' };
export const NO_TAG = '__none__';

export function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
export function addDays(t, n) { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); }
export function startOfWeek(t) { const d = new Date(startOfDay(t)); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return d.getTime(); }
export function startOfMonth(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(1); return d.getTime(); }
export function addMonths(t, n) { const d = new Date(t); d.setMonth(d.getMonth() + n); return d.getTime(); }

/** 预设时间范围 -> [from, to) */
export function presetRange(p, now = Date.now()) {
  const today = startOfDay(now), tomorrow = addDays(today, 1);
  switch (p) {
    case 'today': return [today, tomorrow];
    case 'yesterday': return [addDays(today, -1), today];
    case 'week': return [startOfWeek(now), addDays(startOfWeek(now), 7)];
    case 'lastweek': return [addDays(startOfWeek(now), -7), startOfWeek(now)];
    case 'month': return [startOfMonth(now), addMonths(startOfMonth(now), 1)];
    case 'lastmonth': return [addMonths(startOfMonth(now), -1), startOfMonth(now)];
    case 'year': { const d = new Date(today); d.setMonth(0, 1); return [d.getTime(), addMonths(d.getTime(), 12)]; }
    case '7': return [addDays(today, -6), tomorrow];
    case '14': return [addDays(today, -13), tomorrow];
    case '30': return [addDays(today, -29), tomorrow];
    case '90': return [addDays(today, -89), tomorrow];
    case '365': return [addDays(today, -364), tomorrow];
    case 'all': {
      let min = today;
      for (const s of S.sessions.values()) if (s.start < min) min = s.start;
      return [startOfDay(min), tomorrow];
    }
  }
  return [today, tomorrow];
}

/** 一个事务按分组方式映射到若干 [key, 名称, 权重] */
function groupsOfTask(task, opt) {
  if (!task) return [['?', '（已删除的事务）', 1]];
  if (opt.groupBy === 'task') return [[task.id, task.name, 1]];
  if (opt.groupBy === 'status') return [[task.status || 'waiting', STATUS[task.status] || '等待', 1]];
  // 按标签
  let ids = (task.tags || []).filter(id => S.tags.has(id));
  if (opt.groupBy === 'tagRoot') ids = [...new Set(ids.map(S.tagRoot))];
  if (!ids.length) return [[NO_TAG, '（无标签）', 1]];
  const w = opt.split === 'full' ? 1 : 1 / ids.length;
  return ids.map(id => [id, opt.groupBy === 'tagRoot' ? S.tags.get(id).name : S.tagPath(id), w]);
}

function taskPasses(task, opt) {
  if (!task) return !opt.tagFilter && !opt.statusFilter?.length;
  if (opt.statusFilter && opt.statusFilter.length && !opt.statusFilter.includes(task.status || 'waiting')) return false;
  if (opt.tagFilter) {
    const allowed = S.tagDescendants(opt.tagFilter);
    if (!(task.tags || []).some(id => allowed.has(id))) return false;
  }
  return true;
}

/** 把区间 [a,b) 在若干边界处切开，回调每一段 */
function splitBy(a, b, nextBoundary, cb) {
  let x = a;
  while (x < b) {
    const nb = Math.min(nextBoundary(x), b);
    cb(x, nb);
    x = nb;
  }
}
export function bucketFn(gran) {
  if (gran === 'day') return { start: startOfDay, next: t => addDays(startOfDay(t), 1) };
  if (gran === 'week') return { start: startOfWeek, next: t => addDays(startOfWeek(t), 7) };
  return { start: startOfMonth, next: t => addMonths(startOfMonth(t), 1) };
}
export function autoGranularity(from, to) {
  const days = (to - from) / DAY;
  return days <= 62 ? 'day' : days <= 400 ? 'week' : 'month';
}

/**
 * 计算统计。opt: { from, to, groupBy: task|tag|tagRoot|status, split: even|full,
 *                  tagFilter, statusFilter: [], keyword, gran, staleMs, taskIds: Set }
 */
export function compute(opt) {
  const now = Date.now();
  const { from, to } = opt;
  const kwMatch = matcher(opt.keyword);                 // 空格=与，逗号=或
  const gran = opt.gran || autoGranularity(from, to);
  const bf = bucketFn(gran);
  const groups = new Map();         // key -> {key,name,secs,count}
  const buckets = new Map();        // bucketStart -> Map(key -> secs)
  const hourly = new Array(24).fill(0);
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const intervals = [];             // 用于计算“实际占用”（去掉重叠）
  const segs = [];                  // 时间轴用：{s, a, b, keys}
  let total = 0, count = 0, longest = null, stale = 0;

  for (const s of S.sessions.values()) {
    // 计时超过阈值仍未停止的（多半是忘记停止），不计入统计，提示用户修正
    if (s.end == null && opt.staleMs && now - s.start >= opt.staleMs) { if (s.start < to) stale++; continue; }
    const end = s.end == null ? now : s.end;
    const a = Math.max(s.start, from), b = Math.min(end, to);
    if (!(b > a)) continue;
    if (opt.taskIds && !opt.taskIds.has(s.task)) continue;
    const task = S.tasks.get(s.task);
    if (!taskPasses(task, opt)) continue;
    if (kwMatch && !kwMatch((task?.name || '') + ' ' + (task?.desc || '') + ' ' + (s.note || ''))) continue;
    const gs = groupsOfTask(task, opt);
    const dur = (b - a) / 1000;
    count++;
    intervals.push([a, b]);
    if (!longest || end - s.start > longest.end - longest.start) longest = { ...s, end };
    segs.push({ s, a, b, keys: gs.map(g => g[0]) });
    for (const [key, name, w] of gs) {
      let g = groups.get(key);
      if (!g) groups.set(key, g = { key, name, secs: 0, count: 0 });
      g.secs += dur * w; g.count += 1;
      total += dur * w;
      splitBy(a, b, bf.next, (x, y) => {
        const k = bf.start(x);
        let m = buckets.get(k);
        if (!m) buckets.set(k, m = new Map());
        m.set(key, (m.get(key) || 0) + (y - x) / 1000 * w);
      });
    }
    // 时段分布按“实际时间”计，不受多标签影响
    splitBy(a, b, t => { const d = new Date(t); d.setMinutes(60, 0, 0); return d.getTime(); }, (x, y) => {
      const d = new Date(x);
      const sec = (y - x) / 1000;
      hourly[d.getHours()] += sec;
      heat[(d.getDay() + 6) % 7][d.getHours()] += sec;
    });
  }

  // 去重叠后的实际占用时长
  intervals.sort((p, q) => p[0] - q[0]);
  let union = 0, ca = null, cb = null;
  for (const [a, b] of intervals) {
    if (ca == null || a > cb) { if (ca != null) union += cb - ca; ca = a; cb = b; }
    else if (b > cb) cb = b;
  }
  if (ca != null) union += cb - ca;

  const list = [...groups.values()].sort((a, b) => b.secs - a.secs);
  const days = Math.max(1, Math.round((Math.min(to, startOfDay(now) + DAY) - from) / DAY));
  // 补齐空桶，图表横轴连续
  const bucketKeys = [];
  for (let k = bf.start(from); k < to; k = bf.next(k)) bucketKeys.push(k);
  return { from, to, gran, stale, groups: list, total, union: union / 1000, count, days, longest, buckets, bucketKeys, hourly, heat, segs };
}

// ---------- 格式化
/** 时长统一显示为 小时:分钟:秒（分钟、秒各两位），如 0:05:09、12:30:00、305:07:45。第二个参数为兼容旧调用，已不起作用 */
export function fmtDur(sec, _short = false) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
export function fmtHours(sec) {
  const h = sec / 3600;
  return h >= 100 ? h.toFixed(0) : h >= 10 ? h.toFixed(1) : h.toFixed(2);
}
const pad = n => String(n).padStart(2, '0');
export function fmtDate(t) { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function fmtTime(t) { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
export function fmtDateTime(t) { return fmtDate(t) + ' ' + fmtTime(t); }
/** 日期时间到秒：2026-11-07 14:03:09 */
export function fmtDateTimeSec(t) { const d = new Date(t); return `${fmtDate(t)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
export const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
export function fmtDay(t) {
  const d = new Date(t), today = startOfDay(Date.now());
  const k = startOfDay(t);
  const label = k === today ? '今天' : k === addDays(today, -1) ? '昨天' : `周${WEEK[(d.getDay() + 6) % 7]}`;
  return `${fmtDate(t)} ${label}`;
}
/** datetime-local 输入框的值 <-> 时间戳 */
export function toInput(t) {
  if (t == null) return '';
  const d = new Date(t);
  return `${fmtDate(t)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromInput(v) { return v ? new Date(v).getTime() : null; }
