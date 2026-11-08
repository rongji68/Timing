// 导入旧版“时间都去哪儿了”的数据（旧版导出的 JSON、同步文件 sync_data.json，或用 tools/转换旧数据库.py 转出的 JSON）
// 以及新版自己导出的备份。
import * as S from './store.js';

// 旧版计时时间是本地时间（无时区）；created_at 由 SQLite 生成，为 UTC。
function parseLocal(v) {
  if (!v) return null;
  const t = new Date(String(v).replace(' ', 'T')).getTime();
  return isNaN(t) ? null : t;
}
function parseUTC(v) {
  if (!v) return null;
  let s = String(v).replace(' ', 'T');
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
  const t = new Date(s).getTime();
  return isNaN(t) ? null : t;
}

/** 返回 { items: [...data], report: {...} }，此时尚未写入 */
export function convertOld(json) {
  if (json && json.format === 'tsdq-backup') return convertBackup(json);
  const items = [];
  const rep = { tags: 0, tasks: 0, sessions: 0, reminders: 0, open: 0, fixed: 0, skipped: 0 };
  const tagIds = new Set();
  for (const t of json.tags || []) {
    tagIds.add(t.id);
  }
  for (const t of json.tags || []) {
    items.push({ t: 'tag', id: 'tg-' + t.id, name: String(t.name || '未命名'), color: t.color || '',
      parent: t.parent_id && tagIds.has(t.parent_id) && t.parent_id !== t.id ? 'tg-' + t.parent_id : null,
      pinned: !!t.is_pinned, created: parseUTC(t.created_at) || Date.now() });
    rep.tags++;
  }
  const tagMap = new Map();
  for (const tt of json.task_tags || []) {
    if (!tagIds.has(tt.tag_id)) continue;
    if (!tagMap.has(tt.task_id)) tagMap.set(tt.task_id, []);
    tagMap.get(tt.task_id).push('tg-' + tt.tag_id);
  }
  const taskIds = new Set();
  for (const t of json.tasks || []) {
    taskIds.add(t.id);
    items.push({ t: 'task', id: 'tk-' + t.id, name: String(t.name || '未命名'), desc: t.description || '',
      status: ['urgent', 'waiting', 'completed'].includes(t.status) ? t.status : 'waiting',
      pinned: !!t.is_pinned, tags: tagMap.get(t.id) || [], created: parseUTC(t.created_at) || Date.now() });
    rep.tasks++;
  }
  for (const w of json.work_history || []) {
    const start = parseLocal(w.start_time);
    if (!start || !taskIds.has(w.task_id)) { rep.skipped++; continue; }
    let end = parseLocal(w.end_time);
    if (end == null) rep.open++;
    else if (end < start) {               // 结束早于开始：按记录的时长修正
      end = start + Math.max(0, +w.duration_seconds || 0) * 1000;
      rep.fixed++;
    }
    items.push({ t: 'session', id: 'ss-' + w.id, task: 'tk-' + w.task_id, start, end, note: w.note || '' });
    rep.sessions++;
  }
  // 提醒：旧版 reminder_type = once / duration / repeat
  const UNIT = { seconds: 's', second: 's', minutes: 'min', minute: 'min', hours: 'h', hour: 'h', days: 'd', day: 'd',
    weeks: 'w', week: 'w', months: 'M', month: 'M', years: 'y', year: 'y',
    '秒': 's', '分钟': 'min', '小时': 'h', '天': 'd', '周': 'w', '月': 'M', '年': 'y' };
  const SOUND = { bell: 'bell', '铃声': 'bell', beep: 'beep', '提示音': 'beep', voice: 'voice', '语音': 'voice',
    music: 'music', '音乐': 'music', flash: 'flash', '闪屏': 'flash' };
  for (const r of json.reminders || []) {
    if (!taskIds.has(r.task_id)) continue;
    const at = parseLocal(r.reminder_time);
    if (!at) continue;
    const type = r.reminder_type || 'once';
    const every = (type === 'repeat' || type === 'duration') ? Math.max(0, +r.repeat_interval || 0) : 0;
    items.push({ t: 'reminder', id: 'rm-' + r.id, task: 'tk-' + r.task_id,
      kind: type === 'duration' ? 'after' : type === 'repeat' ? 'repeat' : 'once',
      at, every, unit: UNIT[r.repeat_unit] || 'min', text: r.reminder_content || '',
      sound: SOUND[r.sound_type] || 'bell', snooze: +r.snooze_minutes || 5, enabled: !!r.enabled,
      created: parseUTC(r.created_at) || Date.now() });
    rep.reminders++;
  }
  return { items, report: rep };
}

function convertBackup(json) {
  const items = (json.records || []).filter(r => r && r.id && S.TYPES.includes(r.t));
  const rep = { tags: 0, tasks: 0, sessions: 0, reminders: 0, open: 0, fixed: 0, skipped: 0 };
  for (const r of items) { rep[r.t + 's']++; if (r.t === 'session' && r.end == null) rep.open++; }
  return { items, report: rep };
}

export async function applyImport(items) {
  for (let i = 0; i < items.length; i += 1000) await S.put(...items.slice(i, i + 1000).map(x => ({ ...x })));
}

export function exportBackup() {
  const records = [...S.tags.values(), ...S.tasks.values(), ...S.sessions.values(), ...S.reminders.values()];
  return { format: 'tsdq-backup', version: 1, exported: new Date().toISOString(), records };
}

/**
 * 导出部分数据。taskIds：要导出的事务；from/to：只导出与该时间段有交集的计时记录（为空则不限）。
 * 返回 { backup, csv, counts }。backup 可以再导入；csv 用 Excel 打开（每条计时一行）。
 */
export function exportSubset(taskIds, from = null, to = null) {
  const tasks = [...taskIds].map(id => S.tasks.get(id)).filter(Boolean);
  const sessions = [...S.sessions.values()].filter(s => taskIds.has(s.task)
    && (from == null || (s.end ?? Date.now()) > from) && (to == null || s.start < to)).sort((a, b) => a.start - b.start);
  const tagIds = new Set();
  for (const t of tasks) for (const id of t.tags || []) { let x = S.tags.get(id), g = 0; while (x && g++ < 10) { tagIds.add(x.id); x = x.parent ? S.tags.get(x.parent) : null; } }
  const tags = [...tagIds].map(id => S.tags.get(id)).filter(Boolean);
  const reminders = [...S.reminders.values()].filter(r => taskIds.has(r.task));
  const backup = { format: 'tsdq-backup', version: 1, exported: new Date().toISOString(), partial: true,
    records: [...tags, ...tasks, ...sessions, ...reminders] };
  const pad = n => String(n).padStart(2, '0');
  const d = t => { const x = new Date(t); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
  const hm = t => { const x = new Date(t); return `${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}`; };
  const hms = sec => { sec = Math.round(sec); return `${Math.floor(sec / 3600)}:${pad(Math.floor(sec % 3600 / 60))}:${pad(sec % 60)}`; };
  const q = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const STATUS = { urgent: '紧急', waiting: '等待', completed: '完成' };
  const rows = [['日期', '开始', '结束', '时长(时:分:秒)', '时长(分钟)', '事务', '状态', '标签', '计时备注']];
  for (const s of sessions) {
    const t = S.tasks.get(s.task);
    rows.push([d(s.start), hm(s.start), s.end == null ? '计时中' : (d(s.end) !== d(s.start) ? d(s.end) + ' ' : '') + hm(s.end),
      s.end == null ? '' : hms((s.end - s.start) / 1000), s.end == null ? '' : ((s.end - s.start) / 60000).toFixed(1), t?.name || '', STATUS[t?.status] || '',
      (t?.tags || []).map(id => S.tagPath(id)).filter(Boolean).join('; '), s.note || '']);
  }
  const csv = '\ufeff' + rows.map(r => r.map(q).join(',')).join('\r\n');
  return { backup, csv, counts: { tasks: tasks.length, sessions: sessions.length, tags: tags.length, reminders: reminders.length } };
}
