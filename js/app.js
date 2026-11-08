import * as S from './store.js';
import * as Sync from './sync.js';
import * as St from './stats.js';
import * as Ch from './charts.js';
import * as R from './reminders.js';
import { Timeline, segTip } from './timeline.js';
import { convertOld, applyImport, exportBackup, exportSubset } from './importer.js';
import { cryptoAvailable } from './crypto.js';
import { VERSION, BUILD_TIME } from './version.js';   // 版本号由 tools/发布新版本.py 自动维护
import { matcher, SEARCH_HELP, SEARCH_PLACEHOLDER } from './search.js';
import { $, $$, esc, prefs, loadPrefs, savePrefs, applyAppearance, FONTS, toast, showTip, bindTips, modal, confirmBox,
  popMenu, popPanel, download, deviceName, isDesk, onLayoutChange } from './ui.js';

const STATUS_LABEL = St.STATUS;
const VIEW_TITLES = { timer: '计时', log: '记录', stats: '统计', settings: '设置' };
let view = 'timer';
let installPrompt = null;           // 浏览器提供的“安装应用”事件（Chrome / Edge）
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches || navigator.standalone === true;
const ui = { taskSearch: '', taskLimit: 150, taskTag: '', remOnly: false, selTask: null, filtersOpen: false,
  logDays: 14, logFilter: 'all', logSearch: '', statFrom: null, statTo: null, statTag: '', statStatus: [], statKw: '' };

// ======================================================== 启动
async function main() {
  if (!cryptoAvailable()) {
    document.body.innerHTML = `<div class="fatal">此页面需要通过 HTTPS（或本机 localhost）打开，浏览器才允许使用加密功能。</div>`;
    return;
  }
  await S.open();
  await loadPrefs();
  ensurePersistentStorage();
  applyAppearance();
  bindTips();
  $$('.tabs button').forEach(b => b.onclick = () => show(b.dataset.view));
  $('#sync-badge').onclick = () => show('settings');
  $('#help-btn').onclick = helpDialog;
  $('#app-ver').textContent = `版本 ${VERSION}`;
  $('#app-ver').title = `构建于 ${BUILD_TIME}`;
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  onLayoutChange(() => render());
  S.onChange(() => renderSoon());
  Sync.onSyncState(renderSyncBadge);
  R.init({ startTask, isRunning: id => S.runningSessions().some(s => s.task === id) });
  await Sync.init();
  renderSyncBadge(Sync.syncState());
  show(location.hash.slice(1) || 'timer');
  setInterval(tick, 1000);
  // Service Worker：离线缓存，也是“安装为独立应用”的条件之一（HTTPS 或本机 localhost 下可用）
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname)))
    navigator.serviceWorker.register('sw.js').catch(() => {});
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; if (view === 'settings') renderInstall(); });
  window.addEventListener('appinstalled', () => { installPrompt = null; toast('已安装为独立应用'); if (view === 'settings') renderInstall(); });
}

function show(v) {
  if (!['timer', 'log', 'stats', 'settings'].includes(v)) v = 'timer';
  view = v;
  $$('.view').forEach(el => el.hidden = el.id !== 'v-' + v);
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  if (location.hash.slice(1) !== v) history.replaceState(null, '', '#' + v);
  $('#page-title').textContent = VIEW_TITLES[v];
  render();
}
let renderTimer = null;
function renderSoon() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 30); }
function render() {
  if (view === 'timer') renderTimerView();
  else if (view === 'log') renderLog();
  else if (view === 'stats') renderStats();
  else if (view === 'settings') renderSettings();
  renderRunningBadge();
}
/** 输入框正在编辑时不要重绘它所在的区域（避免打断输入），失去焦点后再补绘 */
function busy(el, again = renderSoon) {
  const ae = document.activeElement;
  if (el && ae && el.contains(ae) && ae.matches('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=date]),textarea')) {
    if (!el.dataset.pending) { el.dataset.pending = '1'; ae.addEventListener('blur', () => { delete el.dataset.pending; setTimeout(again, 50); }, { once: true }); }
    return true;
  }
  return false;
}

// ======================================================== 汇总（每个事务的累计、次数、最近）
function staleMs() { return (+prefs.warnHours || 4) * St.HOUR; }
function taskAgg() {
  const agg = new Map();
  const now = Date.now(), sm = staleMs();
  for (const s of S.sessions.values()) {
    let a = agg.get(s.task);
    if (!a) agg.set(s.task, a = { total: 0, count: 0, last: 0, lastStop: 0, lastDone: null, first: Infinity, longest: 0, lastSession: null, running: [] });
    const isStale = s.end == null && now - s.start >= sm;
    const end = isStale ? s.start : (s.end ?? now);
    const dur = Math.max(0, end - s.start) / 1000;
    a.total += dur; a.count++;
    if (dur > a.longest) a.longest = dur;
    if (s.start < a.first) a.first = s.start;
    if (end > a.last) a.last = end;
    if (s.end != null && s.end > a.lastStop) { a.lastStop = s.end; a.lastDone = s; }   // 最后停止：已结束的计时中最晚的一次
    if (!a.lastSession || s.start > a.lastSession.start) a.lastSession = s;
    if (s.end == null) a.running.push(s);
  }
  return agg;
}
function sortedTasksForSelect(agg = taskAgg()) {
  return [...S.tasks.values()].sort((a, b) => (agg.get(b.id)?.last || b.created || 0) - (agg.get(a.id)?.last || a.created || 0));
}
function tagChips(task, max = 3) {
  const ids = (task.tags || []).filter(id => S.tags.has(id));
  const chips = ids.slice(0, max).map(id => `<span class="chip">${esc(S.tags.get(id).name)}</span>`).join('');
  return chips + (ids.length > max ? `<span class="chip">+${ids.length - max}</span>` : '');
}

// ======================================================== 计时操作
/** 开始计时。计时备注默认：该事务第一次计时用事务说明，以后沿用上一次的计时备注 */
async function startTask(taskId, note) {
  const now = Date.now();
  const running = S.runningSessions();
  if (running.some(s => s.task === taskId)) return;
  if (note === undefined) {
    let last = null;
    for (const s of S.sessions.values()) if (s.task === taskId && (!last || s.start > last.start)) last = s;
    note = last ? (last.note || '') : (S.tasks.get(taskId)?.desc || '');
  }
  const upd = [];
  if (prefs.autoStopOthers) for (const s of running) if (now - s.start < staleMs()) upd.push({ ...s, end: now });
  upd.push({ t: 'session', id: S.newId('ss'), task: taskId, start: now, end: null, note, dev: deviceName() });
  await S.put(...upd);
  toast('开始计时：' + (S.tasks.get(taskId)?.name || ''));
}
async function stopSession(sid, { paused = false, at = null, force = false } = {}) {
  const s = S.sessions.get(sid);
  if (!s || s.end != null) return;
  // 计时时间过长，多半是忘记停止：先让用户确认实际结束时间
  if (!force && at == null && Date.now() - s.start >= staleMs()) { sessionDialog(sid, { staleHint: true }); return; }
  if (!paused && prefs.confirmStop && !(await confirmBox(`停止计时“${S.tasks.get(s.task)?.name || ''}”？`, '停止'))) return;
  const end = at ?? Date.now();
  await S.put({ ...s, end: Math.max(end, s.start), paused: paused || undefined });
  toast((paused ? '已暂停：' : '已停止：') + fmtElapsed(s.start, end));
}
async function toggleTask(id) {
  const running = S.runningSessions().filter(s => s.task === id);
  if (running.length) { for (const s of running) await stopSession(s.id); return; }
  await startTask(id);
}
function fmtElapsed(a, b = Date.now()) { return St.fmtDur((b - a) / 1000); }

function tick() {
  const now = Date.now();
  $$('[data-since]').forEach(el => {
    el.textContent = prefs.hideTimer && !el.classList.contains('peek') ? '计时中…' : St.fmtDur((now - +el.dataset.since) / 1000);
  });
  R.check(now);
  if (view === 'stats' && tick.n++ % 30 === 0 && S.runningSessions().length) renderSoon();
  renderRunningBadge();
}
tick.n = 1;
function renderRunningBadge() {
  const n = S.runningSessions().length;
  const b = $('#run-badge');
  b.hidden = n === 0;
  b.textContent = n > 1 ? `${n} 项计时中` : '计时中';
  document.title = n ? `⏱ ${n} · 时间都去哪儿了` : '时间都去哪儿了';
}

// ======================================================== 视图：计时
function buildTimerShell(root) {
  root.dataset.built = '1';
  root.innerHTML = `
    <div class="notice" id="backup-remind" hidden></div>
    <div class="timer-grid">
      <div class="timer-main">
        <div class="run-head"><h2 id="run-title">正在计时</h2>
          <label class="hide-toggle" data-help="勾选后隐藏计时数字，保护专注；按住计时数字可临时查看"><input type="checkbox" id="hide-timer" ${prefs.hideTimer ? 'checked' : ''}> 隐藏计时数字</label></div>
        <div class="running" id="run-area"></div>
        <div class="task-controls">
        <div class="toolbar">
          <input type="search" id="task-search" placeholder="${SEARCH_PLACEHOLDER}" data-help="${esc(SEARCH_HELP)}">
          <button class="btn primary" data-act="new-task" data-help="新建一个事务">＋<span class="lbl"> 新建事务</span></button>
          <button class="btn mobile-only" id="mf-toggle" data-help="显示 / 收起搜索范围、标签、排序等筛选项">筛选</button>
          <button class="btn mf" data-act="reminders" data-help="查看和管理所有提醒">🔔 提醒管理</button>
        </div>
        <div class="scope-row mf" id="scope-row"></div>
        <div class="scope-more mf" id="scope-more" hidden></div>
        <div class="filters">
          <span class="flabel">状态：</span><div class="seg multi" role="group" id="task-status" data-help="可多选；都不选时显示全部"></div>
          <button class="btn small toggle mf" id="rem-only" data-help="只显示设置了提醒的事务">🔔 有提醒</button>
          <select id="task-tag" class="mf" data-help="按标签筛选（含下级标签）"></select>
          <span class="sortbox mf"><select id="task-sort" data-help="排序方式">
            ${[['recent', '最后停止'], ['total', '累计时长'], ['count', '计时次数'], ['lastDur', '上次时长'], ['avg', '平均时长'], ['name', '名称'], ['created', '创建时间'], ['status', '状态']]
              .map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
            <button class="btn small" id="sort-dir" data-help="切换升序 / 降序"></button></span>
        </div>
        <div class="task-summary" id="task-summary"></div>
        </div>
        <div class="task-scroll" id="task-scroll"><div id="task-list"></div><div id="task-more"></div></div>
      </div>
      <aside class="timer-side" id="task-panel"></aside>
    </div>`;
  const search = $('#task-search', root);
  search.value = ui.taskSearch;
  search.oninput = () => { ui.taskSearch = search.value; ui.taskLimit = 150; renderTimerView(); };
  // 搜索范围
  $('#scope-row', root).addEventListener('change', e => {
    if (e.target.id === 'sf-note-on') setNoteMode(e.target.checked ? $('#sf-note').value : '');
    else if (e.target.id === 'sf-note') { prefs.noteKind = e.target.value; if (noteMode()) setNoteMode(e.target.value); }
    else {
      const f = e.target.dataset.sf;
      const set = new Set(prefs.searchFields);
      if (f) { e.target.checked ? set.add(f) : set.delete(f); }
      prefs.searchFields = [...set];
    }
    savePrefs(); renderTimerView();
  });
  $('#scope-row', root).addEventListener('click', e => {
    if (e.target.closest('#sf-more')) { const m = $('#scope-more'); m.hidden = !m.hidden; renderScope(); }
  });
  $('#scope-more', root).addEventListener('change', e => {
    const nf = e.target.dataset.sf;
    if (NOTE_FIELDS.includes(nf)) setNoteMode(e.target.checked ? nf : '');       // 两个计时备注勾选框互斥
    else {
      const f = e.target.dataset.sf; if (!f) return;
      const set = new Set(prefs.searchFields);
      e.target.checked ? set.add(f) : set.delete(f);
      prefs.searchFields = [...set];
    }
    savePrefs(); renderTimerView();
  });
  $('#scope-more', root).addEventListener('click', e => {
    const b = e.target.closest('[data-sfa]'); if (!b) return;
    if (b.dataset.sfa === 'all') { prefs.searchFields = SEARCH_FIELDS.map(x => x[0]).filter(k => k !== 'noteLast'); prefs.noteKind = 'noteAll'; }   // 计时备注取“全部”
    if (b.dataset.sfa === 'default') { prefs.searchFields = [...DEFAULT_FIELDS]; prefs.noteKind = 'noteAll'; }
    if (b.dataset.sfa === 'close') { $('#scope-more').hidden = true; renderScope(); return; }
    savePrefs(); renderTimerView();
  });
  $('#task-status', root).onclick = e => {
    const b = e.target.closest('[data-st]'); if (!b) return;
    const set = new Set(prefs.taskStatuses);
    set.has(b.dataset.st) ? set.delete(b.dataset.st) : set.add(b.dataset.st);
    prefs.taskStatuses = [...set]; savePrefs(); renderTimerView();
  };
  $('#task-sort', root).onchange = e => {
    prefs.taskSort = e.target.value; prefs.taskSortAsc = ['name', 'status'].includes(e.target.value); savePrefs(); renderTimerView();
  };
  $('#sort-dir', root).onclick = () => { prefs.taskSortAsc = !prefs.taskSortAsc; savePrefs(); renderTimerView(); };
  $('#task-tag', root).onchange = e => { ui.taskTag = e.target.value; renderTimerView(); };
  $('#rem-only', root).onclick = () => { ui.remOnly = !ui.remOnly; renderTimerView(); };
  // 手机版：搜索范围、标签、排序等次要筛选项收在“筛选”按钮里
  $('#mf-toggle', root).onclick = () => { ui.filtersOpen = !ui.filtersOpen; renderTimerView(); };
  $('#hide-timer', root).onchange = e => { prefs.hideTimer = e.target.checked; savePrefs(); tick(); };
  bindColResize(root);
  // 按住计时数字临时查看
  const peekOn = e => { const el = e.target.closest('.rc-elapsed'); if (el) { el.classList.add('peek'); tick(); } };
  const peekOff = () => { $$('.rc-elapsed.peek').forEach(el => el.classList.remove('peek')); tick(); };
  root.addEventListener('pointerdown', peekOn);
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => root.addEventListener(ev, peekOff));
  root.addEventListener('input', e => {
    const inp = e.target.closest('[data-note]'); if (!inp) return;
    clearTimeout(inp.t);
    inp.t = setTimeout(() => { const s = S.sessions.get(inp.dataset.note); if (s) S.put({ ...s, note: inp.value }); }, 700);
  });
  $('#backup-remind', root).onclick = async e => {
    const b = e.target.closest('[data-bk]'); if (!b) return;
    if (b.dataset.bk === 'now') await exportFull();
    else { await S.setMeta('backupSnooze', St.fmtDate(Date.now())); renderBackupReminder(); }
  };
  root.addEventListener('contextmenu', e => {
    const li = e.target.closest('.task[data-tid]'); if (!li) return;
    e.preventDefault(); taskMenu(li.dataset.tid, e.clientX, e.clientY);
  });
  root.addEventListener('click', async e => {
    if (e.target.closest('.col-resize')) return;
    const th = e.target.closest('#task-list th[data-sort]');
    if (th) {
      const k = th.dataset.sort;
      prefs.taskSortAsc = prefs.taskSort === k ? !prefs.taskSortAsc : ['name', 'status'].includes(k);
      prefs.taskSort = k; savePrefs(); renderTimerView(); return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.dataset.id;
    switch (b.dataset.act) {
      case 'toggle': await toggleTask(id); break;
      case 'stop': await stopSession(id); break;
      case 'stop-now': await stopSession(id, { force: true }); break;
      case 'pause': await stopSession(id, { paused: true }); break;
      case 'fix': case 'edit-session': sessionDialog(id); break;
      case 'open-task': openTask(id); break;
      case 'menu': { const r = b.getBoundingClientRect(); taskMenu(id, r.left, r.bottom + 4); break; }
      case 'new-task': newTaskDialog(); break;
      case 'cols': colChooser(b); break;
      case 'reminders': R.managerDialog(); break;
      case 'more-tasks': ui.taskLimit += 200; renderTimerView(); break;
    }
  });
}

function renderTimerView() {
  const root = $('#v-timer');
  if (!root.dataset.built) buildTimerShell(root);
  const agg = taskAgg();
  renderBackupReminder();
  renderRunArea(agg);
  renderTaskList(agg);
  // 电脑版：选中事务时右侧显示详情面板；未选中时不占位置，表格占满宽度
  const panel = $('#task-panel');
  const showPanel = isDesk() && ui.selTask && S.tasks.has(ui.selTask);
  panel.hidden = !showPanel;
  if (showPanel && !busy(panel)) renderTaskPanel(panel, ui.selTask, agg);
  root.querySelector('.timer-grid').classList.toggle('two', !!showPanel);
}

function renderRunArea(agg) {
  const el = $('#run-area');
  if (busy(el)) return;
  const now = Date.now();
  const running = S.runningSessions();
  const fresh = running.filter(s => now - s.start < staleMs()).sort((a, b) => b.start - a.start);
  const stale = running.filter(s => now - s.start >= staleMs());
  const card = (s, warn) => {
    const t = S.tasks.get(s.task);
    return `<div class="run-card ${warn ? 'warn' : ''}" data-sid="${s.id}">
      <div class="rc-top"><span class="rc-name" data-act="open-task" data-id="${s.task}">${esc(t?.name || '（已删除的事务）')}</span>
        <span class="rc-elapsed" data-since="${s.start}" data-help="${prefs.hideTimer ? '按住可临时查看' : '本次已计时'}">${prefs.hideTimer ? '计时中…' : fmtElapsed(s.start)}</span></div>
      <div class="rc-meta">开始于 ${St.fmtDateTime(s.start)}${s.dev ? ' · ' + esc(s.dev) : ''}${agg.get(s.task) ? ` · 累计 ${St.fmtDur(agg.get(s.task).total)}` : ''}</div>
      ${warn ? `<div class="rc-warn">⚠ 已连续计时超过 ${Math.floor((now - s.start) / St.HOUR)} 小时，可能忘记停止。可以设定实际结束时间。</div>` : ''}
      <input class="rc-note" data-note="${s.id}" placeholder="计时备注（自动保存）" value="${esc(s.note || '')}" data-help="本次计时的备注，自动保存">
      <div class="rc-btns">
        ${warn ? `<button class="btn primary" data-act="fix" data-id="${s.id}">设定结束时间</button>`
          : `<button class="btn danger" data-act="stop" data-id="${s.id}" data-help="停止当前计时并保存记录">■ 停止</button>
             <button class="btn" data-act="pause" data-id="${s.id}" data-help="暂停；之后在事务上点 ▶ 继续">❚❚ 暂停</button>`}
        <button class="btn" data-act="edit-session" data-id="${s.id}" data-help="修改开始时间、事务或计时备注">修改</button>
        ${warn ? `<button class="btn" data-act="stop-now" data-id="${s.id}">停止于现在</button>` : ''}
      </div></div>`;
  };
  // 只有真正在进行的计时才算“正在计时”；疑似忘记停止的列在下方提示中
  let html = fresh.length ? `<div class="run-cards">${fresh.map(s => card(s, false)).join('')}</div>` : `<div class="empty-run">点击下方事务左边的 ▶ 开始计时。</div>`;
  if (stale.length) html += `<details class="stale" ${fresh.length ? '' : 'open'}><summary>⚠ ${stale.length} 项计时可能忘记停止（超过 ${prefs.warnHours} 小时）</summary>${stale.sort((a, b) => b.start - a.start).map(s => card(s, true)).join('')}</details>`;
  $('#run-title').textContent = fresh.length ? '正在计时' : '当前没有计时';
  el.innerHTML = html;
}

function taskSortKey(agg) {
  const k = prefs.taskSort;
  const ORDER = { urgent: 0, waiting: 1, completed: 2 };
  return t => {
    const a = agg.get(t.id);
    switch (k) {
      case 'total': return a?.total || 0;
      case 'count': return a?.count || 0;
      case 'avg': return a?.count ? a.total / a.count : 0;
      case 'name': return t.name;
      case 'created': return t.created || 0;
      case 'first': return a && isFinite(a.first) ? a.first : 0;
      case 'longest': return a?.longest || 0;
      case 'lastDur': return a?.lastDone ? a.lastDone.end - a.lastDone.start : 0;
      case 'recent': return a?.lastStop || 0;
      case 'remind': { const r = nextReminder(t.id); return r ? -r.at : -Infinity; }
      case 'status': return ORDER[t.status || 'waiting'];
      default: return a?.last || t.created || 0;
    }
  };
}

// ---------- 电脑版事务表格的列
const dash = '<span class="muted">—</span>';
const NAME_COL = { k: 'name', l: '名称', w: 0, sort: 'name' };     // 名称列始终显示；w=0 表示自动占满剩余宽度
const TASK_COLS = [
  { k: 'status', l: '状态', w: 70, sort: 'status', cell: t => { const st = t.status || 'waiting'; return `<span class="st st-${st} ${st === 'waiting' ? 'plain' : ''}">${STATUS_LABEL[st]}</span>`; } },
  { k: 'tags', l: '标签', w: 150, cell: t => `<div class="ti-sub">${tagChips(t, 4)}</div>` },
  { k: 'total', l: '累计时长', w: 96, num: 1, sort: 'total', cell: (t, a) => St.fmtDur(a?.total || 0) },
  { k: 'count', l: '次数', w: 60, num: 1, sort: 'count', cell: (t, a) => a?.count || 0 },
  { k: 'lastDur', l: '上次时长', w: 90, num: 1, sort: 'lastDur', cell: (t, a) => a?.lastDone ? St.fmtDur((a.lastDone.end - a.lastDone.start) / 1000) : dash },
  { k: 'avg', l: '平均时长', w: 90, num: 1, sort: 'avg', cell: (t, a) => a?.count ? St.fmtDur(a.total / a.count) : dash },
  { k: 'longest', l: '最长一次', w: 90, num: 1, sort: 'longest', cell: (t, a) => a?.count ? St.fmtDur(a.longest) : dash },
  { k: 'recent', l: '最后停止', w: 192, num: 1, sort: 'recent', cell: (t, a) => a?.lastStop ? St.fmtDateTimeSec(a.lastStop) : dash },
  { k: 'first', l: '首次计时', w: 192, num: 1, sort: 'first', cell: (t, a) => a && isFinite(a.first) ? St.fmtDateTimeSec(a.first) : dash },
  { k: 'created', l: '创建时间', w: 192, num: 1, sort: 'created', cell: t => t.created ? St.fmtDateTimeSec(t.created) : dash },
  { k: 'desc', l: '说明', w: 220, cell: t => `<div class="cell-text" title="${esc(t.desc || '')}">${esc(t.desc || '')}</div>` },
  { k: 'noteLast', l: '最后一次计时备注', w: 220, cell: (t, a) => `<div class="cell-text" title="${esc(a?.lastSession?.note || '')}">${esc(a?.lastSession?.note || '')}</div>` },
  { k: 'remind', l: '下次提醒', w: 150, sort: 'remind', cell: t => { const r = nextReminder(t.id); return r ? `<span title="${esc(r.text || '')}">🔔 ${St.fmtDateTime(r.at)}</span>` : dash; } },
];
const DEFAULT_COLS = ['status', 'tags', 'total', 'count', 'lastDur', 'avg', 'recent'];
function visibleCols() {
  const want = prefs.taskCols && prefs.taskCols.length ? prefs.taskCols : DEFAULT_COLS;
  return want.map(k => TASK_COLS.find(c => c.k === k)).filter(Boolean);
}
function nextReminder(taskId) {
  let best = null;
  for (const r of S.reminders.values()) if (r.task === taskId && r.enabled && (!best || r.at < best.at)) best = r;
  return best;
}
const colW = c => (prefs.colWidths || {})[c.k] || c.w;
function colgroup(cols) {
  return `<colgroup><col style="width:46px"><col data-col="name" ${colW(NAME_COL) ? `style="width:${colW(NAME_COL)}px"` : ''}>${cols.map(c => `<col data-col="${c.k}" style="width:${colW(c)}px">`).join('')}<col style="width:44px"></colgroup>`;
}
/** 按保存的列宽设置表格宽度：名称列未调整过时自动占满剩余宽度（至少 200px），否则按各列宽度之和，超出时横向滚动 */
function applyColWidths() {
  const table = $('#task-list .tasktable'); if (!table) return;
  const cols = visibleCols();
  const others = 46 + 44 + cols.reduce((a, c) => a + colW(c), 0);
  const nameW = colW(NAME_COL);
  for (const col of $$('col[data-col]', table)) {
    const k = col.dataset.col;
    const w = k === 'name' ? nameW : colW(TASK_COLS.find(c => c.k === k));
    col.style.width = w ? w + 'px' : '';
  }
  table.style.width = nameW ? (others + nameW) + 'px' : '100%';
  table.style.minWidth = nameW ? '100%' : (others + 200) + 'px';
}
function bindColResize(root) {
  root.addEventListener('pointerdown', e => {
    const h = e.target.closest('.col-resize'); if (!h) return;
    e.preventDefault(); e.stopPropagation();
    const k = h.dataset.col, th = h.closest('th');
    const x0 = e.clientX, w0 = th.getBoundingClientRect().width;
    prefs.colWidths = { ...(prefs.colWidths || {}) };
    h.setPointerCapture(e.pointerId);
    document.body.classList.add('col-resizing');
    const move = ev => { prefs.colWidths[k] = Math.round(Math.max(k === 'name' ? 120 : 44, w0 + ev.clientX - x0)); applyColWidths(); };
    const up = () => { h.removeEventListener('pointermove', move); document.body.classList.remove('col-resizing'); savePrefs(); h.resizeEnd = Date.now(); };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up, { once: true });
    h.addEventListener('pointercancel', up, { once: true });
  });
  // 双击边缘恢复该列默认宽度
  root.addEventListener('dblclick', e => {
    const h = e.target.closest('.col-resize'); if (!h) return;
    prefs.colWidths = { ...(prefs.colWidths || {}) }; delete prefs.colWidths[h.dataset.col]; savePrefs(); applyColWidths();
  });
}
function colChooser(btn) {
  const r = btn.getBoundingClientRect();
  const shown = new Set(visibleCols().map(c => c.k));
  const p = popPanel(`<div class="colpick"><div class="colpick-h">表格中显示的列</div>
    <label class="chk-inl disabled"><input type="checkbox" checked disabled> 名称（始终显示）</label>
    ${TASK_COLS.map(c => `<label class="chk-inl"><input type="checkbox" data-c="${c.k}" ${shown.has(c.k) ? 'checked' : ''}> ${c.l}</label>`).join('')}
    <div class="btns left"><button class="btn small" data-x="cols">恢复默认列</button><button class="btn small" data-x="widths">恢复默认列宽</button></div>
    <p class="muted small">拖动表头右边缘可调整列宽，双击边缘恢复该列默认宽度。</p></div>`, r.left, r.bottom + 4, { align: 'left' });
  p.addEventListener('change', e => {
    const k = e.target.dataset.c; if (!k) return;
    const order = TASK_COLS.map(c => c.k);
    const set = new Set(visibleCols().map(c => c.k));
    e.target.checked ? set.add(k) : set.delete(k);
    prefs.taskCols = order.filter(x => set.has(x));
    if (!prefs.taskCols.length) prefs.taskCols = ['total'];
    savePrefs(); renderTimerView();
  });
  p.addEventListener('click', e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x === 'cols') prefs.taskCols = [...DEFAULT_COLS];
    if (b.dataset.x === 'widths') prefs.colWidths = {};
    savePrefs(); renderTimerView();
    $$('input[data-c]', p).forEach(i => { i.checked = visibleCols().some(c => c.k === i.dataset.c); });
  });
}

// 可搜索的字段（“其他…”面板中全部列出；前 5 项也直接显示在搜索框下方）
const SEARCH_FIELDS = [
  ['name', '名称'], ['tags', '标签'], ['desc', '说明'], ['remind', '提醒'], ['noteLast', '最后一次计时备注'], ['noteAll', '全部计时备注'],
  ['tagPath', '标签的上级标签'], ['status', '状态（紧急/等待/完成）'], ['pinned', '置顶（搜“置顶”）'], ['dev', '计时设备（Mac、iOS…）'],
  ['created', '创建日期'], ['lastUsed', '最后停止日期'], ['sessDate', '计时日期（任一次）'],
];
// 搜索框下方直接列出的字段。计时备注：勾选框表示是否搜索，下拉框选择“最后一次 / 全部”（二者只能选一）；
// “其他”面板中两者是两个勾选框，勾选其一时自动取消另一个。
const MAIN_FIELDS = ['name', 'tags', 'desc', 'remind'];
const DEFAULT_FIELDS = ['name', 'tags', 'desc', 'noteAll'];      // 默认搜索范围（与 ui.js 的 DEFAULT_PREFS 一致）
const NOTE_FIELDS = ['noteLast', 'noteAll'];
function noteMode() { return prefs.searchFields.includes('noteAll') ? 'noteAll' : prefs.searchFields.includes('noteLast') ? 'noteLast' : ''; }
function setNoteMode(m) {
  prefs.searchFields = prefs.searchFields.filter(k => !NOTE_FIELDS.includes(k));
  if (m) { prefs.searchFields.push(m); prefs.noteKind = m; }
}
function renderScope() {
  const f = new Set(prefs.searchFields);
  const extra = [...f].filter(k => !MAIN_FIELDS.includes(k) && !NOTE_FIELDS.includes(k)).length;
  const more = $('#scope-more');
  const label = k => SEARCH_FIELDS.find(x => x[0] === k)[1];
  const nm = noteMode(), kind = nm || prefs.noteKind || 'noteLast';
  $('#scope-row').innerHTML = `<span class="flabel">搜索范围：</span>
    ${MAIN_FIELDS.map(k => `<label class="chk-inl"><input type="checkbox" data-sf="${k}" ${f.has(k) ? 'checked' : ''}> ${label(k)}</label>`).join('')}
    <span class="note-pick" data-help="勾选后搜索计时备注；下拉框选择搜最后一次还是全部计时备注">
      <input type="checkbox" id="sf-note-on" ${nm ? 'checked' : ''} aria-label="搜索计时备注"><select id="sf-note" class="mini">
      ${NOTE_FIELDS.map(k => `<option value="${k}" ${kind === k ? 'selected' : ''}>${label(k)}</option>`).join('')}</select></span>
    <button class="btn small ${more.hidden ? '' : 'on'} toggle" id="sf-more" data-help="展开全部可搜索字段，可多选">其他${extra ? `（${extra}）` : ''} ${more.hidden ? '▾' : '▴'}</button>`;
  if (!more.hidden) {
    more.innerHTML = `<div class="sf-grid">${SEARCH_FIELDS.map(([k, l]) => `<label class="chk-inl"><input type="checkbox" data-sf="${k}" ${f.has(k) ? 'checked' : ''}> ${l}</label>`).join('')}</div>
      <p class="muted small">“最后一次计时备注”和“全部计时备注”只能选其一。日期按表格中的格式搜索：年-月-日（如 ${St.fmtDate(Date.now())}），可只输入前几位，如 ${St.fmtDate(Date.now()).slice(0, 7)} 表示该月。</p>
      <div class="btns left"><button class="btn small" data-sfa="all">全选</button><button class="btn small" data-sfa="default">恢复默认（名称、标签、说明、全部计时备注）</button><button class="btn small" data-sfa="close">收起</button></div>`;
  }
}
/** 按选定的搜索字段拼出一个事务的可搜索文本 */
function searchText(t, f, agg, notesAll) {
  const parts = [];
  if (f.has('name')) parts.push(t.name);
  if (f.has('desc')) parts.push(t.desc || '');
  if (f.has('tags')) parts.push((t.tags || []).map(id => S.tags.get(id)?.name || '').join(' '));
  if (f.has('tagPath')) parts.push((t.tags || []).map(id => S.tagPath(id)).join(' '));
  if (f.has('remind')) parts.push(S.taskReminders(t.id).map(r => r.text || '').join(' '));
  if (f.has('noteLast')) parts.push(agg.get(t.id)?.lastSession?.note || '');
  if (f.has('noteAll') && notesAll) parts.push(notesAll.get(t.id) || '');
  if (f.has('status')) parts.push(STATUS_LABEL[t.status || 'waiting']);
  if (f.has('pinned') && t.pinned) parts.push('置顶');
  if (f.has('dev') || f.has('sessDate')) {
    for (const s of S.taskSessions(t.id)) { if (f.has('dev') && s.dev) parts.push(s.dev); if (f.has('sessDate')) parts.push(St.fmtDate(s.start)); }
  }
  if (f.has('lastUsed') && agg.get(t.id)?.lastStop) parts.push(St.fmtDateTimeSec(agg.get(t.id).lastStop));
  if (f.has('created') && t.created) parts.push(St.fmtDateTimeSec(t.created));
  return parts.join(' \u0001 ');          // 字段之间用不可见分隔符，避免跨字段误匹配
}

function renderTaskList(agg) {
  renderScope();
  const q = matcher(ui.taskSearch);
  const fields = new Set(prefs.searchFields.length ? prefs.searchFields : ['name']);
  const statuses = new Set(prefs.taskStatuses.length ? prefs.taskStatuses : ['urgent', 'waiting', 'completed']);
  const tagAllowed = ui.taskTag ? S.tagDescendants(ui.taskTag) : null;
  let notesAll = null;
  if (q && fields.has('noteAll')) {
    notesAll = new Map();
    for (const s of S.sessions.values()) if (s.note) notesAll.set(s.task, (notesAll.get(s.task) || '') + ' ' + s.note);
  }
  // 先按搜索、标签、提醒筛选（用于各状态计数），再按状态筛选
  const matched = [...S.tasks.values()].filter(t => {
    if (tagAllowed && !(t.tags || []).some(id => tagAllowed.has(id))) return false;
    if (ui.remOnly && !R.taskHasReminder(t.id)) return false;
    if (q && !q(searchText(t, fields, agg, notesAll))) return false;
    return true;
  });
  let list = matched.filter(t => statuses.has(t.status || 'waiting'));
  renderSummary(agg, matched, list, !!(q || tagAllowed || ui.remOnly));
  renderFilterToggle();
  const key = taskSortKey(agg), dir = prefs.taskSortAsc ? 1 : -1;
  list.sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    const ka = key(a), kb = key(b);
    const c = typeof ka === 'string' ? ka.localeCompare(kb, 'zh') : ka - kb;
    return c * dir || a.name.localeCompare(b.name, 'zh');
  });
  const totalN = list.length;
  list = list.slice(0, ui.taskLimit);
  // 筛选栏状态
  $('#rem-only').classList.toggle('on', ui.remOnly);
  const tagSel = $('#task-tag');
  if (tagSel.dataset.n !== String(S.tags.size) + '|' + ui.taskTag) { tagSel.innerHTML = tagOptions(ui.taskTag, '全部标签'); tagSel.dataset.n = S.tags.size + '|' + ui.taskTag; }
  $('#task-sort').value = prefs.taskSort;
  $('#sort-dir').textContent = prefs.taskSortAsc ? '↑ 升序' : '↓ 降序';

  const empty = S.tasks.size ? '没有符合条件的事务' : '还没有事务。点“＋ 新建事务”开始，或在“设置”里导入旧数据。';
  const rowInfo = t => {
    const a = agg.get(t.id);
    const isRun = a?.running.length;
    const paused = !isRun && a?.lastSession?.paused;
    const st = t.status || 'waiting';
    const cls = `task ${isRun ? 'running' : ''} ${paused ? 'paused' : ''} ${ui.selTask === t.id && isDesk() ? 'sel' : ''}`;
    const play = `<button class="play ${isRun ? 'on' : paused ? 'resume' : ''}" data-act="toggle" data-id="${t.id}" data-help="${isRun ? '停止计时' : paused ? '继续计时' : '开始计时'}">${isRun ? '■' : '▶'}</button>`;
    const marks = `${paused ? '<span class="st st-paused">已暂停</span>' : ''}${R.taskHasReminder(t.id) ? '<span class="bell-mark" data-help="设置了提醒">🔔</span>' : ''}`;
    const more = `<button class="icon more-btn" data-act="menu" data-id="${t.id}" aria-label="更多操作" data-help="更多操作">⋯</button>`;
    return { a, st, cls, play, marks, more };
  };
  if (isDesk()) {
    // 电脑版：表格。点表头排序，拖动表头右边缘调列宽，表头最右边的按钮选择显示哪些列
    const cols = visibleCols();
    const sortMark = k => prefs.taskSort === k ? (prefs.taskSortAsc ? ' ↑' : ' ↓') : '';
    const th = c => `<th class="${c.num ? 'num' : ''} ${c.sort ? 'sortable' : ''}" ${c.sort ? `data-sort="${c.sort}"` : ''} data-col="${c.k}">${c.l}${c.sort ? sortMark(c.sort) : ''}<i class="col-resize" data-col="${c.k}" title="拖动调整列宽"></i></th>`;
    const tagCol = cols.some(c => c.k === 'tags');
    $('#task-list').innerHTML = `<table class="tasktable">${colgroup(cols)}<thead><tr><th class="c-play"><button class="icon col-btn" data-act="cols" aria-label="选择显示的列" data-help="选择表格中显示的列">☰</button></th>${th(NAME_COL)}${cols.map(th).join('')}
      <th class="c-more"></th></tr></thead><tbody>
      ${list.map(t => {
        const info = rowInfo(t);
        return `<tr class="${info.cls}" data-tid="${t.id}"><td class="c-play">${info.play}</td>
          <td class="c-name"><div class="ti-main" data-act="open-task" data-id="${t.id}"><div class="ti-name">${t.pinned ? '<span class="pin">📌</span>' : ''}${esc(t.name)}${info.marks}</div>
            ${!tagCol && (t.tags || []).length ? `<div class="ti-sub">${tagChips(t, 4)}</div>` : ''}</div></td>
          ${cols.map(c => `<td class="${c.num ? 'num' : ''} c-${c.k}">${c.cell(t, info.a)}</td>`).join('')}
          <td class="c-more">${info.more}</td></tr>`;
      }).join('') || `<tr><td colspan="${cols.length + 3}" class="muted pad">${empty}</td></tr>`}</tbody></table>`;
    applyColWidths();
  } else {
    // 手机版：卡片列表
    $('#task-list').innerHTML = `<ul class="tasklist">${list.map(t => {
      const { a, st, cls, play, marks, more } = rowInfo(t);
      return `<li class="${cls}" data-tid="${t.id}">${play}
        <div class="ti-main" data-act="open-task" data-id="${t.id}">
          <div class="ti-name">${t.pinned ? '<span class="pin">📌</span>' : ''}${esc(t.name)}
            ${st !== 'waiting' ? `<span class="st st-${st}">${STATUS_LABEL[st]}</span>` : ''}${marks}</div>
          <div class="ti-sub">${tagChips(t)}<span class="ti-stat"><span class="nw">累计 ${St.fmtDur(a?.total || 0)}</span> · <span class="nw">${a?.count || 0} 次</span>${a?.lastDone ? ` · <span class="nw">上次 ${St.fmtDur((a.lastDone.end - a.lastDone.start) / 1000)}</span>` : ''}${a?.lastStop ? ` · <span class="nw">${St.fmtDate(a.lastStop).slice(5)} ${St.fmtTime(a.lastStop)}</span>` : ''}</span></div>
        </div>${more}</li>`;
    }).join('') || `<li class="muted pad">${empty}</li>`}</ul>`;
  }
  $('#task-more').innerHTML = totalN > ui.taskLimit ? `<button class="btn more" data-act="more-tasks">显示更多（共 ${totalN} 项）</button>` : '';
}

/** 手机版“筛选”按钮：显示已改动的筛选项个数；展开时显示全部筛选项 */
function renderFilterToggle() {
  const def = DEFAULT_FIELDS;
  const fieldsChanged = prefs.searchFields.length !== def.length || def.some(k => !prefs.searchFields.includes(k));
  const n = (fieldsChanged ? 1 : 0) + (ui.taskTag ? 1 : 0) + (ui.remOnly ? 1 : 0) + (prefs.taskSort !== 'recent' || prefs.taskSortAsc ? 1 : 0);
  const b = $('#mf-toggle');
  b.textContent = (ui.filtersOpen ? '收起' : '筛选') + (n ? `（${n}）` : '') + (ui.filtersOpen ? ' ▴' : ' ▾');
  b.classList.toggle('on', !!ui.filtersOpen || n > 0);
  $('#v-timer').classList.toggle('filters-open', !!ui.filtersOpen);
}
/** 表格上方：查找结果与全部事务的个数、计时次数、总时长，以及各状态的个数 */
function renderSummary(agg, matched, shown, filtering) {
  const sum = arr => {
    const r = { n: arr.length, secs: 0, cnt: 0, urgent: 0, waiting: 0, completed: 0 };
    for (const t of arr) { const a = agg.get(t.id); r.secs += a?.total || 0; r.cnt += a?.count || 0; r[t.status || 'waiting']++; }
    return r;
  };
  const all = sum([...S.tasks.values()]), m = sum(matched), sh = sum(shown);
  const statuses = new Set(prefs.taskStatuses);
  // 状态按钮上显示（搜索结果中）各状态的个数
  $('#task-status').innerHTML = Object.entries(STATUS_LABEL).map(([k, l]) =>
    `<button class="${statuses.has(k) ? 'on' : ''}" data-st="${k}">${l} <span class="cnt">${m[k]}</span></button>`).join('');
  const line = (label, r, cls = '') => `<span class="sum-item ${cls}"><b>${label}</b> ${r.n} 个事务 · 计时 ${r.cnt} 次 · 共 ${St.fmtDur(r.secs)}
    <span class="sum-st">（<i class="st-urgent">紧急 ${r.urgent}</i>　<i>等待 ${r.waiting}</i>　<i class="st-completed">完成 ${r.completed}</i>）</span></span>`;
  $('#task-summary').innerHTML = (filtering || shown.length !== all.n ? line(filtering ? '查找到' : '当前显示', sh, 'found') : '') + line('全部', all, 'total');
}

function openTask(id) {
  if (!S.tasks.has(id)) return;
  if (isDesk() && view === 'timer') { ui.selTask = id; renderTimerView(); }
  else taskDialog(id);
}

function taskMenu(id, x, y) {
  const t = S.tasks.get(id); if (!t) return;
  const isRun = S.runningSessions().some(s => s.task === id);
  const items = [
    { label: isRun ? '■ 停止计时' : '▶ 开始计时', act: 'toggle' },
    { label: '查看 / 编辑详情…', act: 'detail' },
    '-',
    ...Object.entries(STATUS_LABEL).filter(([k]) => k !== (t.status || 'waiting')).map(([k, l]) => ({ label: `设为“${l}”`, act: 'status', v: k })),
    { label: t.pinned ? '取消置顶' : '置顶', act: 'pin' },
    { label: '复制事务', act: 'copy' },
    { label: '设置提醒…', act: 'remind' },
    '-',
    { label: '删除事务…', act: 'delete', danger: true },
  ];
  popMenu(items, x, y, async it => {
    switch (it.act) {
      case 'toggle': await toggleTask(id); break;
      case 'detail': isDesk() && view === 'timer' ? openTask(id) : taskDialog(id); break;
      case 'status': await S.put({ ...t, status: it.v }); toast(`已设为“${STATUS_LABEL[it.v]}”`); break;
      case 'pin': await S.put({ ...t, pinned: !t.pinned }); break;
      case 'copy': await copyTask(id); break;
      case 'remind': R.reminderDialog(null, { task: id }); break;
      case 'delete': await deleteTask(id); break;
    }
  });
}
async function copyTask(id) {
  const t = S.tasks.get(id); if (!t) return;
  const nt = { ...t, id: S.newId('tk'), name: t.name + '（副本）', pinned: false, created: Date.now() };
  await S.put(nt);
  toast('已复制为“' + nt.name + '”');
  openTask(nt.id);
}
async function deleteTask(id) {
  const t = S.tasks.get(id); if (!t) return false;
  const sess = S.taskSessions(id), rems = S.taskReminders(id);
  if (!(await confirmBox(`删除事务“${t.name}”及其 ${sess.length} 条计时记录${rems.length ? `、${rems.length} 个提醒` : ''}？此操作会同步到所有设备。`, '删除', true))) return false;
  await S.remove(id, ...sess.map(s => s.id), ...rems.map(r => r.id));
  if (ui.selTask === id) ui.selTask = null;
  toast('已删除');
  return true;
}

function tagOptions(selected, emptyLabel) {
  const roots = [...S.tags.values()].filter(t => !t.parent || !S.tags.has(t.parent)).sort(tagOrder);
  const out = [`<option value="">${esc(emptyLabel)}</option>`];
  const walk = (t, depth) => {
    out.push(`<option value="${t.id}" ${t.id === selected ? 'selected' : ''}>${'　'.repeat(depth)}${t.pinned ? '📌' : ''}${esc(t.name)}</option>`);
    [...S.tags.values()].filter(c => c.parent === t.id).sort(tagOrder).forEach(c => walk(c, depth + 1));
  };
  roots.forEach(t => walk(t, 0));
  return out.join('');
}
function tagOrder(a, b) { return (!!b.pinned - !!a.pinned) || a.name.localeCompare(b.name, 'zh'); }

// ======================================================== 事务详情面板（宽屏在右侧，手机在弹窗中）
const panelState = new Map();      // taskId -> { range, chart, from, to }
function renderTaskPanel(el, id, agg = taskAgg()) {
  const t = S.tasks.get(id);
  if (!t) { el.innerHTML = '<div class="panel-empty">该事务已被删除</div>'; return; }
  const a = agg.get(id) || { total: 0, count: 0, running: [] };
  const sess = S.taskSessions(id).sort((x, y) => y.start - x.start);
  const rems = S.taskReminders(id).sort((x, y) => (y.enabled - x.enabled) || x.at - y.at);
  const ps = panelState.get(id) || { range: '30', chart: 'bar' };
  panelState.set(id, ps);
  const isRun = a.running.length > 0;
  const st = t.status || 'waiting';
  el.dataset.task = id;
  el.innerHTML = `
    <div class="tp-head">
      <button class="play ${isRun ? 'on' : ''}" data-pa="toggle" data-help="${isRun ? '停止计时' : '开始计时'}">${isRun ? '■' : '▶'}</button>
      <input class="tp-name" data-f="name" value="${esc(t.name)}" maxlength="200" data-help="事务名称，修改后自动保存">
      <button class="icon more-btn" data-pa="menu" aria-label="更多操作">⋯</button>
      ${el.id === 'task-panel' ? '<button class="icon more-btn" data-pa="close" aria-label="收起详情" data-help="收起详情面板">✕</button>' : ''}
    </div>
    <div class="tp-row">
      <div class="seg" data-help="事务状态">${Object.entries(STATUS_LABEL).map(([k, l]) => `<button data-pa="status" data-v="${k}" class="${st === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <button class="btn small toggle ${t.pinned ? 'on' : ''}" data-pa="pin">📌 ${t.pinned ? '已置顶' : '置顶'}</button>
    </div>
    <label class="fld"><span>说明</span><textarea data-f="desc" rows="3" placeholder="事务说明（自动保存）">${esc(t.desc || '')}</textarea></label>
    <div class="fld"><span>标签 <button class="btn small" data-pa="tags">编辑标签</button></span>
      <div class="tp-tags">${(t.tags || []).filter(x => S.tags.has(x)).map(x => `<span class="chip">${esc(S.tagPath(x))}</span>`).join('') || '<span class="muted small">无</span>'}</div></div>
    <div class="fld"><span>提醒 <button class="btn small" data-pa="remind">＋ 设置提醒</button></span>
      <ul class="tp-rems">${rems.map(r => `<li data-rem="${r.id}" class="${r.enabled ? '' : 'off'}">🔔 ${r.enabled ? St.fmtDateTime(r.at) : '已停用'} · ${esc(r.text || R.describe(r))}${r.text ? `<span class="muted small"> · ${R.describe(r)}</span>` : ''}</li>`).join('') || '<li class="muted small">无</li>'}</ul></div>
    <div class="tp-stats">
      <div class="tp-sum"><b>累计 ${St.fmtDur(a.total, true)}</b> · ${a.count} 次${a.count ? ` · 平均 ${St.fmtDur(a.total / a.count, true)}` : ''}${sess.length ? ` · 首次 ${St.fmtDate(sess[sess.length - 1].start)}` : ''}</div>
      <div class="tp-chart-ctl">
        <div class="seg">${[['7', '7天'], ['14', '14天'], ['30', '30天'], ['90', '90天'], ['365', '一年'], ['custom', '自定义']].map(([v, l]) => `<button data-pa="range" data-v="${v}" class="${ps.range === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="seg">${[['bar', '柱状'], ['line', '折线']].map(([v, l]) => `<button data-pa="chart" data-v="${v}" class="${ps.chart === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      </div>
      ${ps.range === 'custom' ? `<div class="tp-custom"><input type="date" data-pc="from" value="${St.fmtDate(ps.from || St.presetRange('30')[0])}"> ～ <input type="date" data-pc="to" value="${St.fmtDate(ps.to || Date.now())}"></div>` : ''}
      <div class="tp-chart"></div>
    </div>
    <div class="subhead">计时记录（${sess.length}） <button type="button" class="btn small" data-pa="add-sess">＋ 补录</button></div>
    <ul class="sesslist">${sess.slice(0, 60).map(s => sessRow(s, false)).join('') || '<li class="muted">暂无记录</li>'}</ul>
    ${sess.length > 60 ? `<p class="muted small">仅显示最近 60 条，更多请到“记录”页搜索。</p>` : ''}`;
  // 单事务趋势图
  let from, to;
  if (ps.range === 'custom') { from = ps.from || St.presetRange('30')[0]; to = St.addDays(St.startOfDay(ps.to || Date.now()), 1); }
  else [from, to] = St.presetRange(ps.range);
  const stt = St.compute({ from, to, groupBy: 'task', taskIds: new Set([id]), staleMs: staleMs(), gran: ps.range === '365' ? 'week' : (to - from) / St.DAY > 120 ? 'week' : 'day' });
  const pal = Ch.palette(stt.groups);
  const w = Math.max(260, el.clientWidth - 30);
  $('.tp-chart', el).innerHTML = (stt.total > 0 ? '' : '<p class="muted small">这段时间没有记录</p>') + (ps.chart === 'line' ? Ch.lines(stt, pal, w) : Ch.stacked(stt, pal, w));
  bindTaskPanel(el, id);
}
function bindTaskPanel(el, id) {
  if (el.dataset.bound === id) return;
  el.dataset.bound = id;
  const cur = () => S.tasks.get(el.dataset.task);
  el.onchange = async e => {
    const f = e.target.dataset.f, t = cur();
    if (f === 'name' && t) {
      const v = e.target.value.trim();
      if (!v) { e.target.value = t.name; toast('名称不能为空'); return; }
      if (v !== t.name) await S.put({ ...t, name: v });
    }
    const pc = e.target.dataset.pc;
    if (pc) {
      const ps = panelState.get(el.dataset.task);
      ps[pc] = St.fromInput(e.target.value + 'T00:00');
      renderTaskPanel(el, el.dataset.task);
    }
  };
  el.oninput = e => {
    if (e.target.dataset.f !== 'desc') return;
    clearTimeout(el.descT);
    const ta = e.target;
    el.descT = setTimeout(() => { const t = cur(); if (t && ta.value !== (t.desc || '')) S.put({ ...t, desc: ta.value }); }, 600);
  };
  el.onclick = async e => {
    const li = e.target.closest('[data-sess]');
    if (li) { sessionDialog(li.dataset.sess); return; }
    const rl = e.target.closest('[data-rem]');
    if (rl) { R.reminderDialog(rl.dataset.rem); return; }
    const b = e.target.closest('[data-pa]'); if (!b) return;
    const t = cur(); if (!t) return;
    const ps = panelState.get(t.id);
    switch (b.dataset.pa) {
      case 'toggle': await toggleTask(t.id); break;
      case 'close': ui.selTask = null; renderTimerView(); break;
      case 'menu': { const r = b.getBoundingClientRect(); taskMenu(t.id, r.left - 120, r.bottom + 4); break; }
      case 'status': await S.put({ ...t, status: b.dataset.v }); break;
      case 'pin': await S.put({ ...t, pinned: !t.pinned }); break;
      case 'tags': { const sel = await pickTags(new Set(t.tags || [])); if (sel) await S.put({ ...cur(), tags: [...sel] }); break; }
      case 'remind': R.reminderDialog(null, { task: t.id }); break;
      case 'add-sess': sessionDialog(null, { task: t.id }); break;
      case 'range': ps.range = b.dataset.v; renderTaskPanel(el, t.id); break;
      case 'chart': ps.chart = b.dataset.v; renderTaskPanel(el, t.id); break;
    }
  };
}
/** 手机/窄屏：在弹窗中显示同样的详情面板，数据变化时自动刷新 */
function taskDialog(id) {
  if (!S.tasks.has(id)) return;
  const d = modal('事务详情', '<div class="task-panel-dlg"></div>', { wide: true });
  const el = $('.task-panel-dlg', d);
  const refresh = () => {
    if (!d.isConnected) return;
    if (!S.tasks.has(id)) { d.close(); return; }
    if (!busy(el, refresh)) renderTaskPanel(el, id);
  };
  const off = S.onChange(refresh);
  d.addEventListener('close', off);
  requestAnimationFrame(refresh);
}

function newTaskDialog() {
  const sel = new Set(ui.taskTag ? [ui.taskTag] : []);
  const d = modal('新建事务', `
    <label class="fld"><span>名称</span><input id="f-name" required maxlength="200"></label>
    <label class="fld"><span>说明</span><textarea id="f-desc" rows="3"></textarea></label>
    <div class="row2">
      <label class="fld"><span>状态</span><select id="f-status">${Object.entries(STATUS_LABEL).map(([v, l]) => `<option value="${v}" ${v === 'waiting' ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="fld chk"><input type="checkbox" id="f-pin"> 置顶</label>
    </div>
    <div class="fld"><span>标签 <button type="button" class="btn small" data-tags>选择标签</button></span><div class="tp-tags" id="f-tags"></div></div>
    <div class="btns">
      <button type="button" class="btn" data-cancel>取消</button>
      <button type="button" class="btn primary" data-save>保存</button>
      <button type="button" class="btn primary" data-save-start>保存并开始计时</button>
    </div>`);
  const drawTags = () => { $('#f-tags', d).innerHTML = [...sel].filter(x => S.tags.has(x)).map(x => `<span class="chip">${esc(S.tagPath(x))}</span>`).join('') || '<span class="muted small">无</span>'; };
  drawTags();
  $('[data-tags]', d).onclick = async () => { const r = await pickTags(sel); if (r) { sel.clear(); r.forEach(x => sel.add(x)); drawTags(); } };
  $('[data-cancel]', d).onclick = () => d.close();
  const save = async () => {
    const name = $('#f-name', d).value.trim();
    if (!name) { $('#f-name', d).focus(); toast('请填写名称'); return null; }
    const t = { t: 'task', id: S.newId('tk'), name, desc: $('#f-desc', d).value, status: $('#f-status', d).value,
      pinned: $('#f-pin', d).checked, tags: [...sel], created: Date.now() };
    await S.put(t);
    d.close();
    return t;
  };
  $('[data-save]', d).onclick = async () => { const t = await save(); if (t) openTask(t.id); };
  $('[data-save-start]', d).onclick = async () => { const t = await save(); if (t) { await startTask(t.id); if (isDesk()) openTask(t.id); } };
  $('#f-name', d).focus();
}

/** 选择标签（弹窗）：标签云 / 树形两种浏览方式，可搜索，回车新建。返回 Set 或 null（取消） */
function pickTags(initial) {
  return new Promise(res => {
    const sel = new Set(initial);
    let mode = prefs.tagView === 'tree' ? 'tree' : 'cloud', done = false;
    const d = modal('选择标签', `
      <div class="toolbar"><input type="search" id="tp-q" placeholder="筛选标签；输入新名称后回车可新建">
        <div class="seg" id="tp-mode"><button data-m="cloud">标签云</button><button data-m="tree">树形</button></div></div>
      <div class="tp-selected" id="tp-sel"></div>
      <div class="tagbox big" id="tp-box"></div>
      <div class="btns"><button type="button" class="btn" data-clear>清空</button><button type="button" class="btn" data-cancel>取消</button><button type="button" class="btn primary" data-ok>完成</button></div>`,
      { onClose: () => { if (!done) res(null); } });
    const draw = () => {
      $$('#tp-mode button', d).forEach(b => b.classList.toggle('on', b.dataset.m === mode));
      $('#tp-sel', d).innerHTML = sel.size ? '已选：' + [...sel].filter(x => S.tags.has(x)).map(x => `<span class="chip on" data-tg="${x}">${esc(S.tagPath(x))} ✕</span>`).join('') : '<span class="muted small">尚未选择</span>';
      const q = $('#tp-q', d).value.trim().toLowerCase();
      if (mode === 'cloud' || q) {
        const all = [...S.tags.values()].map(tg => ({ tg, path: S.tagPath(tg.id) }))
          .filter(x => !q || x.path.toLowerCase().includes(q))
          .sort((a, b) => (!!b.tg.pinned - !!a.tg.pinned) || a.path.localeCompare(b.path, 'zh'));
        $('#tp-box', d).className = 'tagbox big';
        $('#tp-box', d).innerHTML = all.map(x => `<button type="button" class="tagopt ${sel.has(x.tg.id) ? 'on' : ''}" data-tg="${x.tg.id}">${x.tg.pinned ? '📌' : ''}${esc(x.path)}</button>`).join('')
          || '<span class="muted">没有匹配的标签，按回车新建</span>';
      } else {
        const rows = [];
        const walk = (t, depth) => {
          rows.push(`<label class="tree-row" style="padding-left:${depth * 20}px"><input type="checkbox" data-tg="${t.id}" ${sel.has(t.id) ? 'checked' : ''}> ${t.pinned ? '📌' : ''}${esc(t.name)}</label>`);
          [...S.tags.values()].filter(c => c.parent === t.id).sort(tagOrder).forEach(c => walk(c, depth + 1));
        };
        [...S.tags.values()].filter(t => !t.parent || !S.tags.has(t.parent)).sort(tagOrder).forEach(t => walk(t, 0));
        $('#tp-box', d).className = 'tagtree-pick';
        $('#tp-box', d).innerHTML = rows.join('') || '<span class="muted">还没有标签</span>';
      }
    };
    draw();
    $('#tp-q', d).oninput = draw;
    $('#tp-q', d).onkeydown = async e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const name = e.target.value.trim(); if (!name) return;
      let tg = [...S.tags.values()].find(x => x.name === name);
      if (!tg) { tg = { t: 'tag', id: S.newId('tg'), name, parent: null, created: Date.now() }; await S.put(tg); }
      sel.add(tg.id); e.target.value = ''; draw();
    };
    $('#tp-mode', d).onclick = e => { const b = e.target.closest('[data-m]'); if (b) { mode = b.dataset.m; prefs.tagView = mode; savePrefs(); draw(); } };
    d.addEventListener('click', e => {
      const b = e.target.closest('[data-tg]');
      if (!b || b.tagName === 'INPUT') return;
      sel.has(b.dataset.tg) ? sel.delete(b.dataset.tg) : sel.add(b.dataset.tg); draw();
    });
    d.addEventListener('change', e => { const c = e.target.closest('input[data-tg]'); if (c) { c.checked ? sel.add(c.dataset.tg) : sel.delete(c.dataset.tg); draw(); } });
    $('[data-clear]', d).onclick = () => { sel.clear(); draw(); };
    $('[data-cancel]', d).onclick = () => d.close();
    $('[data-ok]', d).onclick = () => { done = true; res(sel); d.close(); };
  });
}

function sessRow(s, withTask = true, overlap = false) {
  const t = S.tasks.get(s.task);
  const end = s.end ?? Date.now();
  const sameDay = St.startOfDay(s.start) === St.startOfDay(end);
  const range = `${St.fmtTime(s.start)}–${s.end == null ? '<b class="live">计时中</b>' : (sameDay ? '' : St.fmtDate(end).slice(5) + ' ') + St.fmtTime(end)}`;
  return `<li class="sess ${s.end == null ? 'live' : ''}" data-sess="${s.id}">
    <span class="s-range">${withTask ? '' : St.fmtDate(s.start).slice(2) + ' '}${range}</span>
    <span class="s-dur">${St.fmtDur((end - s.start) / 1000, true)}</span>
    ${withTask ? `<span class="s-task">${esc(t?.name || '（已删除）')}</span>` : ''}
    <span class="s-note">${overlap ? '<span class="ovl" data-tip="与其他计时有重叠">重叠</span>' : ''}${s.paused ? '<span class="ovl paused">暂停</span>' : ''}${esc(s.note || '')}</span></li>`;
}

// ======================================================== 计时记录编辑 / 补录 / 修正
function sessionDialog(id, preset = {}) {
  const agg = taskAgg();
  const s = id ? S.sessions.get(id) : { t: 'session', id: S.newId('ss'), task: preset.task || '', start: Date.now() - St.HOUR, end: Date.now(), note: '', dev: deviceName() };
  if (!s) return;
  const isNew = !id;
  const tasks = sortedTasksForSelect(agg);
  const d = modal(isNew ? '补录计时' : (s.end == null ? '修改计时（进行中）' : '修改计时记录'), `
    ${preset.staleHint ? `<p class="notice">这项计时已持续 ${St.fmtDur((Date.now() - s.start) / 1000, true)}，可能忘记停止了。请设定实际结束时间；如果确实一直进行到现在，点“现在”。</p>` : ''}
    <label class="fld"><span>事务</span><select id="s-task">${s.task ? '' : '<option value="">请选择…</option>'}${tasks.map(t => `<option value="${t.id}" ${t.id === s.task ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
    <div class="row2">
      <label class="fld"><span>开始</span><input type="datetime-local" id="s-start" value="${St.toInput(s.start)}"></label>
      <label class="fld"><span>结束</span><input type="datetime-local" id="s-end" value="${St.toInput(s.end)}" ${s.end == null ? 'disabled' : ''}></label>
    </div>
    <label class="fld chk"><input type="checkbox" id="s-live" ${s.end == null ? 'checked' : ''}> 仍在计时（没有结束时间）</label>
    <div class="quick">结束于开始后：${[15, 30, 60, 90, 120, 180].map(m => `<button type="button" class="btn small" data-plus="${m}">${m < 60 ? m + '分' : m / 60 + '小时'}</button>`).join('')}
      <button type="button" class="btn small" data-now>现在</button></div>
    <div class="dur-preview" id="s-dur"></div>
    <label class="fld"><span>计时备注</span><textarea id="s-note" rows="2">${esc(s.note || '')}</textarea></label>
    <div class="btns">
      ${isNew ? '' : '<button type="button" class="btn danger left" data-del>删除</button>'}
      <button type="button" class="btn" data-close2>取消</button>
      <button type="button" class="btn primary" data-save>保存</button>
    </div>`);
  const startI = $('#s-start', d), endI = $('#s-end', d), live = $('#s-live', d);
  if (preset.staleHint) { live.checked = false; endI.disabled = false; endI.value = ''; }
  const upd = () => {
    const a = St.fromInput(startI.value), b = live.checked ? Date.now() : St.fromInput(endI.value);
    const el = $('#s-dur', d);
    if (a && b && b > a) { el.textContent = '时长：' + St.fmtDur((b - a) / 1000, true) + (live.checked ? '（仍在计时）' : ''); el.className = 'dur-preview'; }
    else { el.textContent = '结束时间需要晚于开始时间'; el.className = 'dur-preview bad'; }
  };
  upd();
  [startI, endI].forEach(i => i.oninput = upd);
  live.onchange = () => { endI.disabled = live.checked; if (!live.checked && !endI.value) endI.value = St.toInput(Date.now()); upd(); };
  $$('[data-plus]', d).forEach(b => b.onclick = () => { const a = St.fromInput(startI.value); if (!a) return; live.checked = false; endI.disabled = false; endI.value = St.toInput(Math.min(Date.now(), a + b.dataset.plus * 60e3)); upd(); });
  $('[data-now]', d).onclick = () => { live.checked = false; endI.disabled = false; endI.value = St.toInput(Date.now()); upd(); };
  $('[data-close2]', d).onclick = () => d.close();
  $('[data-save]', d).onclick = async () => {
    const task = $('#s-task', d).value;
    const a = St.fromInput(startI.value), b = live.checked ? null : St.fromInput(endI.value);
    if (!task) { toast('请选择事务'); return; }
    if (!a) { toast('请填写开始时间'); return; }
    if (b != null && b <= a) { toast('结束时间需要晚于开始时间'); return; }
    if (a > Date.now() + 60e3) { toast('开始时间不能晚于现在'); return; }
    // datetime-local 只精确到分钟：未改动时保留原始秒数
    const start = St.toInput(s.start) === startI.value ? s.start : a;
    const end = b == null ? null : (St.toInput(s.end) === endI.value ? s.end : b);
    await S.put({ ...s, task, start, end, note: $('#s-note', d).value, paused: b == null ? undefined : s.paused });
    d.close(); toast('已保存');
  };
  const del = $('[data-del]', d);
  if (del) del.onclick = async () => {
    if (!(await confirmBox('删除这条计时记录？', '删除', true))) return;
    await S.remove(s.id); d.close(); toast('已删除');
  };
}

// ======================================================== 视图：记录
function renderLog() {
  const root = $('#v-log');
  if (!root.dataset.built) {
    root.dataset.built = '1';
    root.innerHTML = `<div class="toolbar">
        <input type="search" id="log-search" placeholder="搜索事务名或计时备注（空格 & + = 与；逗号 | / = 或）" data-help="${esc(SEARCH_HELP)}">
        <button class="btn primary" data-act="add" data-help="手动补录一条计时">＋ 补录</button></div>
      <div class="filters"><div class="seg" id="log-filter"></div><span class="muted small">点击一条记录可修改或删除</span></div>
      <div id="log-body"></div>`;
    const search = $('#log-search', root);
    search.oninput = () => { ui.logSearch = search.value; renderLog(); };
    root.onclick = e => {
      const li = e.target.closest('[data-sess]');
      if (li) { sessionDialog(li.dataset.sess); return; }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'add') sessionDialog(null);
      if (b.dataset.act === 'filter') { ui.logFilter = b.dataset.v; renderLog(); }
      if (b.dataset.act === 'more') { ui.logDays += 30; renderLog(); }
    };
  }
  const now = Date.now();
  const from = St.addDays(St.startOfDay(now), -(ui.logDays - 1));
  const warnMs = staleMs();
  const q = matcher(ui.logSearch);
  let list = [...S.sessions.values()];
  // 重叠检测
  const sorted = list.slice().sort((a, b) => a.start - b.start);
  const overlap = new Set();
  let maxEnd = -Infinity, maxId = null;
  for (const s of sorted) {
    if (s.end == null && now - s.start >= warnMs) continue;       // 疑似忘记停止的计时不参与重叠判断
    const end = s.end ?? now;
    if (s.start < maxEnd) { overlap.add(s.id); if (maxId) overlap.add(maxId); }
    if (end > maxEnd) { maxEnd = end; maxId = s.id; }
  }
  const suspicious = s => (s.end == null && now - s.start >= warnMs) || ((s.end ?? now) - s.start >= 12 * St.HOUR);
  if (ui.logFilter === 'suspicious') list = list.filter(suspicious);
  else if (ui.logFilter === 'overlap') list = list.filter(s => overlap.has(s.id));
  else if (!q) list = list.filter(s => (s.end ?? now) >= from);
  if (q) list = list.filter(s => q((S.tasks.get(s.task)?.name || '') + ' ' + (s.note || '')));
  list.sort((a, b) => b.start - a.start);
  const limited = q && ui.logFilter === 'all' && list.length > 500;
  if (limited) list = list.slice(0, 500);
  const days = new Map();
  for (const s of list) {
    const k = St.startOfDay(s.start);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(s);
  }
  const nSusp = [...S.sessions.values()].filter(suspicious).length;
  $('#log-filter').innerHTML = [['all', q ? '全部（搜索中）' : `最近 ${ui.logDays} 天`], ['suspicious', `需检查${nSusp ? `（${nSusp}）` : ''}`], ['overlap', '有重叠']]
    .map(([v, l]) => `<button class="${ui.logFilter === v ? 'on' : ''}" data-act="filter" data-v="${v}">${l}</button>`).join('');
  const html = [...days.entries()].map(([k, arr]) => {
    const st = St.compute({ from: k, to: St.addDays(k, 1), groupBy: 'task', staleMs: warnMs });
    return `<section class="day"><h3>${St.fmtDay(k)}<span class="muted">累计 ${St.fmtDur(st.total, true)}${st.union < st.total - 59 ? ` · 实际 ${St.fmtDur(st.union, true)}` : ''}</span></h3>
      <ul class="sesslist">${arr.map(s => sessRow(s, true, overlap.has(s.id))).join('')}</ul></section>`;
  }).join('');
  $('#log-body').innerHTML = `
    ${ui.logFilter === 'suspicious' ? `<p class="hint">“需检查”包括：仍在计时且超过 ${prefs.warnHours} 小时的记录，以及单次超过 12 小时的记录。</p>` : ''}
    ${limited ? '<p class="hint">匹配的记录较多，只显示最近 500 条。</p>' : ''}
    ${html || '<p class="muted pad">没有记录</p>'}
    ${ui.logFilter === 'all' && !q ? `<button class="btn more" data-act="more">加载更早的记录</button>` : ''}`;
}

// ======================================================== 视图：统计
let timeline = null;
function statRange() {
  if (prefs.statRange === 'custom' && ui.statFrom && ui.statTo) return [ui.statFrom, St.addDays(ui.statTo, 1)];
  return St.presetRange(prefs.statRange);
}
function renderStats() {
  const root = $('#v-stats');
  if (!root.dataset.built) buildStatsShell(root);
  const [from, to] = statRange();
  const groupBy = prefs.statGroup;
  const st = St.compute({ from, to, groupBy, split: prefs.statSplit, tagFilter: ui.statTag, statusFilter: ui.statStatus, staleMs: staleMs(),
    keyword: ui.statKw, gran: prefs.statGran === 'auto' ? null : prefs.statGran });
  const pal = Ch.palette(st.groups);
  const wOf = id => Math.max(240, $(id).clientWidth || 600);
  const stale = $('#st-stale');
  stale.hidden = !st.stale;
  stale.innerHTML = st.stale ? `⚠ 有 ${st.stale} 条计时超过 ${prefs.warnHours} 小时仍未停止（可能忘记停止），暂未计入统计。<button class="btn small" data-goto="suspicious">去修正</button>` : '';
  $('#st-period').textContent = `${St.fmtDate(from)} ～ ${St.fmtDate(to - 1)}（${Math.round((to - from) / St.DAY)} 天）`;
  $('#st-split-wrap').hidden = !groupBy.startsWith('tag');
  $('#st-custom').hidden = prefs.statRange !== 'custom';
  const days = st.days;
  $('#st-tiles').innerHTML = [
    ['累计计时', St.fmtDur(st.total), groupBy.startsWith('tag') && prefs.statSplit === 'full' ? '多标签事务按每个标签全额计入' : '各项计时相加'],
    ['实际占用', St.fmtDur(st.union), '同时进行的计时只算一次'],
    ['日均', St.fmtDur(st.union / days, true), `按 ${days} 天计算实际占用`],
    ['计时次数', st.count, st.count ? `平均时长 ${St.fmtDur(st.union / st.count)}` : ''],
    ['最长一次', st.longest ? St.fmtDur((st.longest.end - st.longest.start) / 1000, true) : '—', st.longest ? esc(S.tasks.get(st.longest.task)?.name || '') : ''],
  ].map(([k, v, sub]) => `<div class="tile"><div class="t-k">${k}</div><div class="t-v">${v}</div><div class="t-sub">${sub}</div></div>`).join('');
  const groupWord = { task: '事务', tag: '标签', tagRoot: '一级标签', status: '状态' }[groupBy];
  $('#st-share-title').textContent = `各${groupWord}用时占比`;
  $('#st-share').innerHTML = Ch.donut(st, pal);
  $$('#st-trend button').forEach(b => b.classList.toggle('on', b.dataset.v === prefs.statTrend));
  $('#st-trend-title').textContent = prefs.statTrend === 'lines' ? `各${groupWord}用时对比` : '用时分配';
  $('#st-stack').innerHTML = prefs.statTrend === 'lines' ? Ch.lines(st, pal, wOf('#st-stack')) : Ch.stacked(st, pal, wOf('#st-stack'));
  $('#st-stack-legend').innerHTML = pal.folded.map(g => `<span><i style="background:${pal.color(g.key === Ch.OTHER ? '' : g.key)}"></i>${esc(g.name)}</span>`).join('');
  $('#st-hourly').innerHTML = Ch.hourly(st, wOf('#st-hourly'));
  $('#st-heat').innerHTML = Ch.heatmap(st, wOf('#st-heat'));
  $('#st-rank-title').textContent = `${groupWord}明细（${st.groups.length} 项）`;
  $('#st-rank').innerHTML = Ch.ranking(st, pal, { onClickAttr: 'gk' });

  // 时间轴：每个分组一行（前 7/8 组 + 其他），顶部一行“全部”
  const rowIndex = new Map();
  const rows = [{ key: '__all__', name: '全部', color: 'var(--text-2)' }];
  pal.folded.forEach(g => { rowIndex.set(g.key, rows.length); rows.push({ key: g.key, name: g.name, color: pal.color(g.key === Ch.OTHER ? '' : g.key) }); });
  const segs = [];
  for (const sg of st.segs) {
    segs.push({ a: sg.a, b: sg.b, row: 0, s: sg.s });
    const seen = new Set();
    for (const k of sg.keys) {
      const r = rowIndex.get(pal.topKeys.has(k) ? k : Ch.OTHER);
      if (r != null && !seen.has(r)) { seen.add(r); segs.push({ a: sg.a, b: sg.b, row: r, s: sg.s }); }
    }
  }
  timeline.setData(rows, segs, from, to);
}

function buildStatsShell(root) {
  root.dataset.built = '1';
  const presets = [['today', '今天'], ['yesterday', '昨天'], ['week', '本周'], ['lastweek', '上周'], ['month', '本月'], ['lastmonth', '上月'],
    ['7', '最近 7 天'], ['14', '最近 14 天'], ['30', '最近 30 天'], ['90', '最近 90 天'], ['365', '最近一年'], ['year', '今年'], ['all', '全部'], ['custom', '自定义…']];
  root.innerHTML = `
    <div class="stat-controls">
      <div class="ctl-row">
        <button class="btn icon" id="st-prev" data-help="上一段">◀</button>
        <select id="st-range">${presets.map(([v, l]) => `<option value="${v}" ${prefs.statRange === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button class="btn icon" id="st-next" data-help="下一段">▶</button>
        <span id="st-custom"><input type="date" id="st-from"> ～ <input type="date" id="st-to"></span>
        <span class="muted small" id="st-period"></span>
      </div>
      <div class="ctl-row">
        <label>分组 <select id="st-group">${[['task', '按事务'], ['tag', '按标签'], ['tagRoot', '按一级标签'], ['status', '按状态']].map(([v, l]) => `<option value="${v}" ${prefs.statGroup === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label id="st-split-wrap" data-help="一个事务有多个标签时：平分 = 时长平均分给各标签（占比合计 100%）；全额 = 每个标签都计入全部时长">多标签 <select id="st-split"><option value="even">平分</option><option value="full">各计全额</option></select></label>
        <label>只看 <select id="st-tag"></select></label>
        <span class="seg" id="st-status" data-help="按事务状态筛选（可多选，不选=全部）">${Object.entries(STATUS_LABEL).map(([v, l]) => `<button data-v="${v}">${l}</button>`).join('')}</span>
        <input type="search" id="st-kw" placeholder="关键词（空格=与，逗号=或）" data-help="${esc(SEARCH_HELP)}">
      </div>
    </div>
    <div class="notice" id="st-stale" hidden></div>
    <div class="tiles" id="st-tiles"></div>
    <div class="grid2">
      <div class="card"><h3 id="st-share-title">用时占比</h3><div id="st-share"></div></div>
      <div class="card"><h3 id="st-rank-title">明细</h3><div class="scroll-y" id="st-rank"></div><p class="muted small">点击一行可深入查看</p></div>
    </div>
    <div class="card"><div class="card-h"><h3 id="st-trend-title">用时分配</h3>
      <div class="tl-btns"><div class="seg" id="st-trend"><button data-v="stack">堆叠柱状</button><button data-v="lines">对比折线</button></div>
      <select id="st-gran"><option value="auto">自动</option><option value="day">按天</option><option value="week">按周</option><option value="month">按月</option></select></div></div>
      <div id="st-stack"></div><div class="legend-row" id="st-stack-legend"></div></div>
    <div class="card"><div class="card-h"><h3>时间轴</h3><div class="tl-btns">
      <button class="btn small" data-tl="in">＋ 放大</button><button class="btn small" data-tl="out">－ 缩小</button>
      <button class="btn small" data-tl="day">今天</button><button class="btn small" data-tl="fit">全部</button></div></div>
      <p class="muted small">滚轮或双指缩放，拖动平移，双击放大；悬停或轻点查看详情，点击可修改。半透明表示仍在计时。</p>
      <canvas id="st-tl"></canvas></div>
    <div class="grid2">
      <div class="card"><h3>一天中的时段分布</h3><div id="st-hourly"></div></div>
      <div class="card"><h3>星期 × 时段</h3><div id="st-heat"></div></div>
    </div>`;
  $('#st-split').value = prefs.statSplit;
  $('#st-gran').value = prefs.statGran;
  $('#st-tag').innerHTML = tagOptions(ui.statTag, '全部标签');
  const setRange = v => { prefs.statRange = v; savePrefs(); renderStats(); };
  $('#st-range').onchange = e => {
    if (e.target.value === 'custom') {
      const [a, b] = St.presetRange('30');
      ui.statFrom = ui.statFrom || a; ui.statTo = ui.statTo || St.addDays(b, -1);
      $('#st-from').value = St.fmtDate(ui.statFrom); $('#st-to').value = St.fmtDate(ui.statTo);
    }
    setRange(e.target.value);
  };
  const shift = dir => {
    const [a, b] = statRange();
    const p = prefs.statRange;
    let na, nb;
    if (['month', 'lastmonth'].includes(p)) { na = St.addMonths(a, dir); nb = St.addMonths(b, dir); }
    else if (p === 'year') { na = St.addMonths(a, 12 * dir); nb = St.addMonths(b, 12 * dir); }
    else { const span = b - a; na = St.startOfDay(a + dir * span + St.HOUR * 3); nb = St.startOfDay(b + dir * span + St.HOUR * 3); }
    ui.statFrom = na; ui.statTo = St.addDays(nb, -1);
    $('#st-from').value = St.fmtDate(ui.statFrom); $('#st-to').value = St.fmtDate(ui.statTo);
    $('#st-range').value = 'custom'; setRange('custom');
  };
  $('#st-prev').onclick = () => shift(-1);
  $('#st-next').onclick = () => shift(1);
  const onDates = () => {
    const a = St.fromInput($('#st-from').value + 'T00:00'), b = St.fromInput($('#st-to').value + 'T00:00');
    if (a && b && b >= a) { ui.statFrom = a; ui.statTo = b; renderStats(); }
  };
  $('#st-from').onchange = onDates; $('#st-to').onchange = onDates;
  $('#st-group').onchange = e => { prefs.statGroup = e.target.value; savePrefs(); renderStats(); };
  $('#st-split').onchange = e => { prefs.statSplit = e.target.value; savePrefs(); renderStats(); };
  $('#st-gran').onchange = e => { prefs.statGran = e.target.value; savePrefs(); renderStats(); };
  $('#st-trend').onclick = e => { const b = e.target.closest('[data-v]'); if (b) { prefs.statTrend = b.dataset.v; savePrefs(); renderStats(); } };
  $('#st-tag').onchange = e => { ui.statTag = e.target.value; renderStats(); };
  $('#st-status').onclick = e => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    const v = b.dataset.v, i = ui.statStatus.indexOf(v);
    i >= 0 ? ui.statStatus.splice(i, 1) : ui.statStatus.push(v);
    b.classList.toggle('on', i < 0); renderStats();
  };
  const kw = $('#st-kw');
  kw.oninput = () => { clearTimeout(kw.t); kw.t = setTimeout(() => { ui.statKw = kw.value; renderStats(); }, 250); };
  $('#st-rank').onclick = e => {
    const tr = e.target.closest('[data-gk]'); if (!tr) return;
    const k = tr.dataset.gk;
    if (prefs.statGroup === 'task' && S.tasks.has(k)) taskDialog(k);
    else if (prefs.statGroup.startsWith('tag') && S.tags.has(k)) {
      ui.statTag = k; $('#st-tag').value = k; prefs.statGroup = 'task'; $('#st-group').value = 'task'; savePrefs(); renderStats();
      toast('已筛选标签“' + S.tags.get(k).name + '”，按事务查看');
    }
  };
  timeline = new Timeline($('#st-tl'), {
    onHover: (seg, x, y) => {
      if (!seg) { showTip(null); return; }
      showTip(segTip(seg, S.tasks.get(seg.s.task)?.name || '（已删除）'), x, y);
    },
    onClick: seg => { showTip(null); sessionDialog(seg.s.id); },
  });
  root.addEventListener('click', e => {
    const g = e.target.closest('[data-goto]');
    if (g) { ui.logFilter = g.dataset.goto; show('log'); return; }
    const b = e.target.closest('[data-tl]'); if (!b) return;
    const act = b.dataset.tl;
    if (act === 'in') timeline.zoom(0.5);
    if (act === 'out') timeline.zoom(2);
    if (act === 'fit') timeline.fit();
    if (act === 'day') { const d = St.startOfDay(Date.now()); timeline.showRange(d, St.addDays(d, 1)); }
  });
  let rw = 0;
  new ResizeObserver(() => { const w = root.clientWidth; if (Math.abs(w - rw) > 40 && view === 'stats') { rw = w; renderSoon(); } }).observe(root);
}

// ======================================================== 视图：设置
function renderSyncBadge(st) {
  const b = $('#sync-badge');
  const map = { off: ['未登录', 'off'], idle: ['已同步', 'ok'], busy: ['同步中…', 'busy'], offline: ['离线', 'warn'], error: ['同步出错', 'warn'] };
  let [txt, cls] = map[st.status] || ['', ''];
  if (st.status === 'off' && st.server === false) { txt = '仅本机'; cls = 'off local'; }
  b.textContent = txt; b.className = 'sync ' + cls;
  b.title = st.error || (st.lastSync ? '上次同步 ' + St.fmtDateTime(st.lastSync) : '');
  if (view === 'settings') renderAccount();
}

function renderSettings() {
  const root = $('#v-settings');
  if (!root.dataset.built) {
    root.dataset.built = '1';
    root.innerHTML = `
      <div class="card" id="acct"></div>
      <div class="card"><h3>计时</h3>
        <label class="fld inline"><span>计时超过多少小时提示“可能忘记停止”</span><input type="number" id="p-warn" min="0.5" max="72" step="0.5" value="${prefs.warnHours}"></label>
        <label class="fld chk"><input type="checkbox" id="p-confirm" ${prefs.confirmStop ? 'checked' : ''}> 停止计时前确认</label>
        <label class="fld chk"><input type="checkbox" id="p-auto" ${prefs.autoStopOthers ? 'checked' : ''}> 开始新计时时，自动停止其他计时（默认允许多项同时计时）</label>
        <label class="fld chk"><input type="checkbox" id="p-hide" ${prefs.hideTimer ? 'checked' : ''}> 隐藏计时数字（专注模式，按住数字可临时查看）</label></div>
      <div class="card"><h3>提醒</h3>
        <p class="small">提醒只在程序打开时生效：电脑上开着即可（被其他窗口挡住也会响）；手机需要程序在前台。程序关闭期间错过的提醒，下次打开时会补弹。</p>
        <div class="fld inline"><span>系统通知（程序在后台时也弹出）：<b id="p-notify-st"></b></span><button class="btn small" id="p-notify">允许系统通知</button></div>
        <label class="fld chk"><input type="checkbox" id="p-remnotify" ${prefs.remNotify ? 'checked' : ''}> 提醒时同时显示系统通知</label>
        <label class="fld chk"><input type="checkbox" id="p-autoclose" ${prefs.remAutoClose ? 'checked' : ''}> 提醒弹窗自动关闭（视为“知道了”）</label>
        <label class="fld inline"><span>自动关闭倒计时（秒，10–300）</span><input type="number" id="p-autosec" min="10" max="300" value="${prefs.remAutoSec}"></label>
        <div class="btns left"><button class="btn" id="p-remmgr">🔔 提醒管理…</button>
          <select id="p-try">${Object.entries(R.SOUNDS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select><button class="btn" id="p-trybtn">试听</button></div></div>
      <div class="card"><h3>外观</h3>
        <label class="fld inline"><span>界面布局</span><select id="p-layout"><option value="auto">自动（按屏幕宽度）</option><option value="desk">电脑版</option><option value="mobile">手机版</option></select></label>
        <label class="fld inline"><span>主题</span><select id="p-theme"><option value="auto">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
        <label class="fld inline"><span>字体</span><select id="p-font">${Object.entries(FONTS).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <label class="fld inline"><span>字号：<b id="p-fs-v">${prefs.fontSize}</b> px</span><input type="range" id="p-fs" min="12" max="22" step="1" value="${prefs.fontSize}"></label>
        <label class="fld chk"><input type="checkbox" id="p-help" ${prefs.showHelp ? 'checked' : ''}> 鼠标悬停时显示操作提示</label>
        <p class="muted small">以上设置只保存在本设备。</p></div>
      <div class="card"><div class="card-h"><h3>标签管理</h3><div class="seg" id="tg-view"><button data-v="tree">树形</button><button data-v="list">列表</button><button data-v="cloud">标签云</button></div></div><div id="tagmgr"></div></div>
      <div class="card"><h3>数据</h3>
        <p>导入旧版数据：选择旧版导出的 JSON、同步文件 <code>sync_data.json</code>，或用 <code>tools/转换旧数据库.py</code> 从 .db 转出的 JSON；也可以导入本程序的备份文件。</p>
        <div class="btns left"><label class="btn primary">选择文件导入<input type="file" id="imp" accept=".json,application/json" hidden></label>
        <button class="btn" id="exp">导出全部备份（JSON）</button>
        <button class="btn" id="exp-part">导出部分数据…</button>
        <button class="btn danger" id="wipe">清除本设备数据</button></div>
        <p class="muted small" id="data-count"></p>
        <p class="small" id="storage-st"></p>
        <label class="fld inline"><span>多少天没备份时提醒（0 = 不提醒；登录同步账号后不提醒）</span><input type="number" id="p-bk" min="0" max="90" value="${prefs.backupDays}"></label></div>
      <div class="card" id="install-card"></div>
      <div class="card"><h3>帮助</h3>
        <div class="btns left"><button class="btn" id="p-helpdlg">使用帮助…</button></div></div>`;
    $('#p-theme').value = prefs.theme;
    $('#p-font').value = prefs.fontFamily;
    $('#p-layout').value = prefs.layout;
    $('#p-layout').onchange = e => { prefs.layout = e.target.value; savePrefs(); applyAppearance(); render(); };
    $('#p-warn').onchange = e => { prefs.warnHours = Math.max(0.5, +e.target.value || 4); savePrefs(); };
    $('#p-confirm').onchange = e => { prefs.confirmStop = e.target.checked; savePrefs(); };
    $('#p-auto').onchange = e => { prefs.autoStopOthers = e.target.checked; savePrefs(); };
    $('#p-hide').onchange = e => { prefs.hideTimer = e.target.checked; savePrefs(); const h = $('#hide-timer'); if (h) h.checked = prefs.hideTimer; };
    $('#p-notify').onclick = async () => { await R.requestNotify(); renderSettings(); };
    $('#p-remnotify').onchange = e => { prefs.remNotify = e.target.checked; savePrefs(); };
    $('#p-autoclose').onchange = e => { prefs.remAutoClose = e.target.checked; savePrefs(); };
    $('#p-autosec').onchange = e => { prefs.remAutoSec = Math.min(300, Math.max(10, +e.target.value || 60)); e.target.value = prefs.remAutoSec; savePrefs(); };
    $('#p-remmgr').onclick = () => R.managerDialog();
    $('#p-trybtn').onclick = () => R.playSound($('#p-try').value, '这是试听');
    $('#p-theme').onchange = e => { prefs.theme = e.target.value; savePrefs(); applyAppearance(); };
    $('#p-font').onchange = e => { prefs.fontFamily = e.target.value; savePrefs(); applyAppearance(); };
    $('#p-fs').oninput = e => { prefs.fontSize = +e.target.value; $('#p-fs-v').textContent = prefs.fontSize; applyAppearance(); };
    $('#p-fs').onchange = () => { savePrefs(); render(); };
    $('#p-help').onchange = e => { prefs.showHelp = e.target.checked; savePrefs(); };
    $('#p-helpdlg').onclick = helpDialog;
    $('#tg-view').onclick = e => { const b = e.target.closest('[data-v]'); if (b) { prefs.tagView = b.dataset.v; savePrefs(); renderTagMgr(); } };
    $('#imp').onchange = onImport;
    $('#exp').onclick = () => exportFull();
    $('#exp-part').onclick = exportDialog;
    $('#p-bk').onchange = e => { prefs.backupDays = Math.max(0, Math.min(90, Math.round(+e.target.value || 0))); e.target.value = prefs.backupDays; savePrefs(); };
    $('#wipe').onclick = async () => {
      if (!(await confirmBox('清除本设备上的全部数据并退出登录？服务器上的加密数据不受影响，重新登录后会再下载。', '清除', true))) return;
      await Sync.logout(); await S.clearAll(); location.reload();
    };
  }
  const ns = R.notifyState();
  $('#p-notify-st').textContent = { granted: '已允许', denied: '已拒绝（请在浏览器设置中开启）', default: '未设置', unsupported: '此浏览器不支持' }[ns] || ns;
  $('#p-notify').hidden = ns !== 'default';
  renderAccount();
  renderInstall();
  renderTagMgr();
  renderStorageState();
  $('#data-count').textContent = `版本 ${VERSION}（构建于 ${BUILD_TIME}）。本设备共有 ${S.tasks.size} 个事务、${S.tags.size} 个标签、${S.sessions.size} 条计时记录、${S.reminders.size} 个提醒。`;
}

function renderAccount() {
  const el = $('#acct');
  if (!el) return;
  const st = Sync.syncState();
  if (!(st.token && st.key) && st.server === false) {
    el.dataset.mode = 'local';
    el.innerHTML = `<h3>数据保存位置</h3>
      <p>当前网址只提供程序本身，<b>没有同步服务器</b>：所有数据只保存在<b>本设备</b>上，不会上传到任何地方，断网也能使用。</p>
      <p class="muted small">数据只有这一份，删除本程序或清除浏览器数据会丢失，请定期“导出全部备份”。以后部署了同步服务器，从服务器网址打开即可登录同步。</p>`;
    return;
  }
  if (st.token && st.key) {
    el.dataset.mode = '';
    el.innerHTML = `<h3>同步账号</h3>
      <p>已登录：<b>${esc(st.user)}</b>　状态：${$('#sync-badge').textContent}${st.lastSync ? '　上次同步：' + St.fmtDateTime(st.lastSync) : ''}</p>
      ${st.error ? `<p class="bad">${esc(st.error)}</p>` : ''}
      <p class="muted small">数据在本机加密后才上传，服务器只保存密文。</p>
      <div class="btns left"><button class="btn primary" id="a-sync">立即同步</button><button class="btn" id="a-out">退出登录</button></div>`;
    $('#a-sync').onclick = () => Sync.syncNow();
    $('#a-out').onclick = async () => { if (await confirmBox('退出登录？本机数据保留，但不再同步。')) Sync.logout(); };
    return;
  }
  if (el.dataset.mode === 'form' && el.querySelector('form') && st.server !== false) {
    const err = el.querySelector('.bad');
    if (err) err.textContent = st.error || '';
    return;
  }
  el.dataset.mode = 'form';
  el.innerHTML = `<h3>同步账号</h3>
    <p class="small">登录后，电脑和手机的数据会自动同步。<b>密码同时用作加密密钥，忘记后数据无法找回</b>，请妥善保管。没有登录也可以只在本机使用。</p>
    <form id="a-form" autocomplete="on">
      <label class="fld"><span>用户名</span><input id="a-user" autocomplete="username" required></label>
      <label class="fld"><span>密码（至少 8 位）</span><input id="a-pw" type="password" autocomplete="current-password" required minlength="8"></label>
      <div id="a-reg" hidden>
        <label class="fld"><span>再次输入密码</span><input id="a-pw2" type="password" autocomplete="new-password"></label>
        <label class="fld"><span>邀请码（第一个账号不需要）</span><input id="a-inv"></label>
      </div>
      <p class="bad">${esc(st.error || '')}</p>
      <div class="btns left"><button class="btn primary" id="a-login" type="submit">登录</button>
        <button class="btn" type="button" id="a-toggle">注册新账号</button></div>
    </form>`;
  let reg = false;
  $('#a-toggle').onclick = () => { reg = !reg; $('#a-reg').hidden = !reg; $('#a-login').textContent = reg ? '注册并登录' : '登录'; $('#a-toggle').textContent = reg ? '已有账号，去登录' : '注册新账号'; $('#a-pw').autocomplete = reg ? 'new-password' : 'current-password'; };
  $('#a-form').onsubmit = async e => {
    e.preventDefault();
    const user = $('#a-user').value.trim(), pw = $('#a-pw').value;
    if (pw.length < 8) { toast('密码至少 8 位'); return; }
    if (reg && pw !== $('#a-pw2').value) { toast('两次密码不一致'); return; }
    $('#a-login').disabled = true; $('#a-login').textContent = '正在生成密钥…';
    try {
      await Sync.login(user, pw, { register: reg, invite: $('#a-inv').value.trim() });
      el.dataset.mode = ''; toast('登录成功，开始同步'); renderAccount();
    } catch (err) {
      $('#a-login').disabled = false; $('#a-login').textContent = reg ? '注册并登录' : '登录';
      el.querySelector('.bad').textContent = err.message === 'Failed to fetch' ? '无法连接服务器' : err.message;
    }
  };
}

// ---------- 本机数据：持久存储、备份
let storagePersisted = null;
/** 请求浏览器把本程序的存储设为“持久”，避免空间紧张时被系统自动清理 */
async function ensurePersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) return;
  try {
    storagePersisted = await navigator.storage.persisted();
    if (!storagePersisted) storagePersisted = await navigator.storage.persist();
  } catch (e) { /* 部分浏览器不支持 */ }
}
async function renderStorageState() {
  const el = $('#storage-st'); if (!el) return;
  let usage = '';
  try { const est = await navigator.storage.estimate(); usage = `已用约 ${(est.usage / 1048576).toFixed(1)} MB。`; } catch (e) { /* ignore */ }
  const last = await S.getMeta('lastBackup', 0);
  const p = storagePersisted === true ? '✅ 存储已设为持久，系统不会自动清理。'
    : storagePersisted === false ? '⚠ 浏览器未同意持久存储，空间紧张时可能被清理。' + (isStandalone() ? '' : '安装为独立应用（添加到主屏幕）后更可靠。') + '请定期导出备份。'
    : '';
  el.textContent = `${p}${usage}上次导出全部备份：${last ? St.fmtDateTimeSec(last) : '从未'}。`;
}
/** 导出全部备份：手机上弹出系统分享面板（可存到“文件”、发到微信等），电脑上直接下载 */
async function exportFull() {
  const name = `时间都去哪儿了-备份-${St.fmtDate(Date.now())}.json`;
  const text = JSON.stringify(exportBackup(), null, 1);
  const mobile = /Mobi|Android|iPhone|iPad|HarmonyOS/.test(navigator.userAgent);
  if (mobile && navigator.canShare) {
    try {
      const file = new File([text], name, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: '时间都去哪儿了 备份' });
        await S.setMeta('lastBackup', Date.now()); toast('已导出备份'); renderSoon(); return;
      }
    } catch (e) { if (e.name === 'AbortError') { toast('已取消导出'); return; } }
  }
  download(name, text);
  await S.setMeta('lastBackup', Date.now());
  toast('已导出备份'); renderSoon();
}
/** 只在本机保存数据（未登录同步）时，超过设定天数没有备份就提醒 */
async function renderBackupReminder() {
  const el = $('#backup-remind'); if (!el) return;
  const st = Sync.syncState();
  const days = +prefs.backupDays || 0;
  const last = await S.getMeta('lastBackup', 0), snooze = await S.getMeta('backupSnooze', '');
  const due = days > 0 && !(st.token && st.key) && S.sessions.size > 0 && Date.now() - last > days * St.DAY && snooze !== St.fmtDate(Date.now());
  el.hidden = !due;
  if (due) el.innerHTML = `💾 数据只保存在本设备上，${last ? `已 ${Math.floor((Date.now() - last) / St.DAY)} 天没有备份` : '还没有导出过备份'}。
    <button class="btn small primary" data-bk="now">立即导出备份</button><button class="btn small" data-bk="later">今天不再提醒</button>`;
}

// ---------- 安装为独立应用（独立窗口，没有浏览器地址栏和标签页）
function renderInstall() {
  const el = $('#install-card'); if (!el) return;
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad/.test(ua), android = /Android|HarmonyOS/.test(ua);
  const safariMac = /Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|Edg/.test(ua);
  let how;
  if (isStandalone()) how = '<p>✅ 当前正以<b>独立应用</b>方式运行。</p>';
  else if (installPrompt) how = '<p>点下面的按钮，程序会安装到电脑或手机上，以后从桌面 / 开始菜单 / 启动台 / 主屏幕打开，是一个独立窗口，没有浏览器的地址栏和标签页。</p><div class="btns left"><button class="btn primary" id="p-install">安装为独立应用</button></div>';
  else if (ios) how = '<p>iPhone / iPad：用 <b>Safari</b> 打开本页 → 点底部“分享”按钮 → “添加到主屏幕”。之后从主屏幕图标打开即为独立应用。</p>';
  else if (safariMac) how = '<p>Mac 上的 Safari：菜单“文件” → “添加到程序坞”（需 macOS 14 及以上）。之后从程序坞打开即为独立窗口。</p>';
  else if (android) how = '<p>安卓 / 鸿蒙：浏览器菜单（⋮）→ “安装应用”或“添加到桌面 / 主屏幕”。</p>';
  else how = '<p>电脑：用 <b>Chrome</b> 或 <b>Edge</b> 打开本页，地址栏右侧会出现“安装”图标（⊕ 或 🖥），点它即可；也可从浏览器菜单 → “投射、保存和分享” / “应用” → “安装此网站为应用”。</p>';
  el.innerHTML = `<h3>独立应用</h3>${how}<p class="muted small">安装需要网址为 HTTPS（如 GitHub Pages 或自己的服务器），或在本机用 localhost 打开。安装后断网也能使用。安装后数据、登录状态与浏览器中相同；程序更新时会自动更新。</p>`;
  const b = $('#p-install');
  if (b) b.onclick = async () => { installPrompt.prompt(); const r = await installPrompt.userChoice; installPrompt = null; renderInstall(); if (r.outcome !== 'accepted') toast('已取消安装'); };
}

// ---------- 标签管理：树形 / 列表 / 标签云
let tagListSort = { k: 'count', asc: false };
function renderTagMgr() {
  const el = $('#tagmgr');
  const mode = ['tree', 'list', 'cloud'].includes(prefs.tagView) ? prefs.tagView : 'tree';
  $$('#tg-view button').forEach(b => b.classList.toggle('on', b.dataset.v === mode));
  const agg = taskAgg();
  const counts = new Map(), totals = new Map();
  for (const t of S.tasks.values()) for (const id of t.tags || []) {
    counts.set(id, (counts.get(id) || 0) + 1);
    totals.set(id, (totals.get(id) || 0) + (agg.get(t.id)?.total || 0));
  }
  const btns = id => { const t = S.tags.get(id); return `<button class="btn small" data-tact="pin">${t.pinned ? '取消置顶' : '置顶'}</button><button class="btn small" data-tact="rename">改名</button><button class="btn small" data-tact="move">移动</button><button class="btn small danger" data-tact="del">删除</button>`; };
  let body = '';
  if (mode === 'tree') {
    const rows = [];
    const walk = (t, depth) => {
      rows.push(`<li style="padding-left:${depth * 18}px" data-tg="${t.id}"><span class="tg-name">${t.pinned ? '📌' : ''}${esc(t.name)}</span>
        <span class="muted small">${counts.get(t.id) || 0} 个事务</span>${btns(t.id)}</li>`);
      [...S.tags.values()].filter(c => c.parent === t.id).sort(tagOrder).forEach(c => walk(c, depth + 1));
    };
    [...S.tags.values()].filter(t => !t.parent || !S.tags.has(t.parent)).sort(tagOrder).forEach(t => walk(t, 0));
    body = `<ul class="tagtree">${rows.join('') || '<li class="muted">还没有标签</li>'}</ul>`;
  } else if (mode === 'list') {
    const k = tagListSort.k, dir = tagListSort.asc ? 1 : -1;
    const list = [...S.tags.values()].map(t => ({ t, path: S.tagPath(t.id), n: counts.get(t.id) || 0, h: totals.get(t.id) || 0 }))
      .sort((a, b) => (!!b.t.pinned - !!a.t.pinned) || dir * (k === 'name' ? a.path.localeCompare(b.path, 'zh') : k === 'count' ? a.n - b.n : a.h - b.h));
    const th = (key, label, cls = '') => `<th class="${cls} sortable" data-sort="${key}">${label}${k === key ? (tagListSort.asc ? ' ↑' : ' ↓') : ''}</th>`;
    body = `<div class="scroll-y tall"><table class="rank tagtable"><thead><tr>${th('name', '标签')}${th('count', '事务数', 'num')}${th('hours', '累计时长', 'num')}<th></th></tr></thead><tbody>
      ${list.map(x => `<tr data-tg="${x.t.id}"><td>${x.t.pinned ? '📌' : ''}${esc(x.path)}</td><td class="num">${x.n}</td><td class="num">${St.fmtDur(x.h)}</td><td class="nowrap">${btns(x.t.id)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">还没有标签</td></tr>'}
      </tbody></table></div>`;
  } else {
    const max = Math.max(1, ...counts.values());
    body = `<div class="tagcloud">${[...S.tags.values()].sort(tagOrder).map(t => {
      const n = counts.get(t.id) || 0;
      return `<button class="cloud-tag" data-tg="${t.id}" data-cloud style="font-size:calc(var(--fs) * ${(0.85 + 0.75 * Math.sqrt(n / max)).toFixed(2)})" data-tip="${esc(S.tagPath(t.id))}&#10;${n} 个事务 · ${St.fmtDur(totals.get(t.id) || 0)}">${t.pinned ? '📌' : ''}${esc(t.name)}</button>`;
    }).join('') || '<span class="muted">还没有标签</span>'}</div><p class="muted small">字越大表示使用越多；点击标签可操作。</p>`;
  }
  el.innerHTML = `<div class="toolbar"><input id="tg-new" placeholder="新标签名称"><select id="tg-parent">${tagOptions('', '（作为一级标签）')}</select>
    <button class="btn primary" id="tg-add">添加</button></div>${body}`;
  $('#tg-add').onclick = async () => {
    const name = $('#tg-new').value.trim(); if (!name) return;
    await S.put({ t: 'tag', id: S.newId('tg'), name, parent: $('#tg-parent').value || null, created: Date.now() });
    toast('已添加标签');
  };
  el.onclick = async e => {
    const s = e.target.closest('[data-sort]');
    if (s) { const k = s.dataset.sort; tagListSort = { k, asc: tagListSort.k === k ? !tagListSort.asc : k === 'name' }; renderTagMgr(); return; }
    const c = e.target.closest('[data-cloud]');
    if (c) {
      const r = c.getBoundingClientRect(), t = S.tags.get(c.dataset.tg);
      popMenu([{ label: t.pinned ? '取消置顶' : '置顶', act: 'pin' }, { label: '改名…', act: 'rename' }, { label: '移动到…', act: 'move' }, '-', { label: '删除…', act: 'del', danger: true }],
        r.left, r.bottom + 4, it => tagAction(t.id, it.act));
      return;
    }
    const b = e.target.closest('[data-tact]'); if (!b) return;
    tagAction(b.closest('[data-tg]').dataset.tg, b.dataset.tact);
  };
}
async function tagAction(id, act) {
  const t = S.tags.get(id); if (!t) return;
  if (act === 'pin') await S.put({ ...t, pinned: !t.pinned });
  else if (act === 'rename') {
    const d = modal('标签改名', `<label class="fld"><span>名称</span><input id="r-name" value="${esc(t.name)}"></label>
      <div class="btns"><button type="button" class="btn primary" id="r-ok">保存</button></div>`);
    $('#r-ok', d).onclick = async () => { const n = $('#r-name', d).value.trim(); if (n) await S.put({ ...t, name: n }); d.close(); };
  } else if (act === 'move') {
    const bad = S.tagDescendants(id);
    const d = modal('移动标签', `<label class="fld"><span>“${esc(t.name)}” 的上级标签</span><select id="m-p">${tagOptions(t.parent || '', '（作为一级标签）')}</select></label>
      <div class="btns"><button type="button" class="btn primary" id="m-ok">保存</button></div>`);
    $$('#m-p option', d).forEach(o => { if (bad.has(o.value)) o.disabled = true; });
    $('#m-ok', d).onclick = async () => { await S.put({ ...t, parent: $('#m-p', d).value || null }); d.close(); };
  } else if (act === 'del') {
    if (!(await confirmBox(`删除标签“${t.name}”？事务本身不会删除；它的下级标签会移到上一级。`, '删除', true))) return;
    const upd = [];
    for (const c of S.tags.values()) if (c.parent === id) upd.push({ ...c, parent: t.parent || null });
    for (const k of S.tasks.values()) if ((k.tags || []).includes(id)) upd.push({ ...k, tags: k.tags.filter(x => x !== id) });
    if (upd.length) await S.put(...upd);
    await S.remove(id);
  }
}

// ---------- 导入
async function onImport(e) {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  let json;
  try { json = JSON.parse(await f.text()); } catch (err) { toast('无法读取：不是有效的 JSON 文件'); return; }
  const { items, report: r } = convertOld(json);
  if (!items.length) { toast('文件中没有可导入的数据'); return; }
  const existing = items.filter(x => S.getRec(x.id) && !S.getRec(x.id).deleted).length;
  const ok = await confirmBox(`将导入 ${r.tasks} 个事务、${r.tags} 个标签、${r.sessions} 条计时记录${r.reminders ? `、${r.reminders} 个提醒` : ''}。` +
    (r.open ? `\n其中 ${r.open} 条没有结束时间，会显示为“可能忘记停止”，可逐条修正。` : '') +
    (r.fixed ? `\n${r.fixed} 条结束时间早于开始时间，已按记录的时长修正。` : '') +
    (existing ? `\n有 ${existing} 条之前导入过，将用文件中的内容覆盖。` : ''), '导入');
  if (!ok) return;
  await applyImport(items);
  toast(`导入完成：${r.sessions} 条计时记录`);
  renderSettings();
}

// ---------- 导出部分数据
function exportDialog() {
  const d = modal('导出部分数据', `
    <div class="fld"><span>导出哪些事务</span>
      <label class="fld chk"><input type="radio" name="x-scope" value="all" checked> 全部事务</label>
      <label class="fld chk"><input type="radio" name="x-scope" value="current"> 计时页当前列表（当前的搜索和筛选结果）</label>
      <label class="fld chk"><input type="radio" name="x-scope" value="status"> 按状态：${Object.entries(STATUS_LABEL).map(([k, l]) => `<label class="inl"><input type="checkbox" data-xs="${k}" ${k !== 'completed' ? 'checked' : ''}> ${l}</label>`).join('')}</label>
      <label class="fld chk"><input type="radio" name="x-scope" value="tag"> 按标签：<select id="x-tag">${tagOptions('', '请选择')}</select></label>
      <label class="fld chk"><input type="radio" name="x-scope" value="kw"> 按关键词：<input id="x-kw" placeholder="空格=与，逗号=或"></label>
    </div>
    <div class="fld"><span>计时记录的时间段</span>
      <label class="fld chk"><input type="radio" name="x-time" value="all" checked> 全部时间</label>
      <label class="fld chk"><input type="radio" name="x-time" value="range"> 从 <input type="date" id="x-from" value="${St.fmtDate(St.presetRange('30')[0])}"> 到 <input type="date" id="x-to" value="${St.fmtDate(Date.now())}"></label>
    </div>
    <div class="fld"><span>格式</span>
      <label class="fld chk"><input type="radio" name="x-fmt" value="json" checked> 备份文件（JSON，可再导入本程序）</label>
      <label class="fld chk"><input type="radio" name="x-fmt" value="csv"> 表格（CSV，可用 Excel 打开，每条计时一行）</label>
    </div>
    <p class="muted small" id="x-count"></p>
    <div class="btns"><button type="button" class="btn" data-cancel>取消</button><button type="button" class="btn primary" data-go>导出</button></div>`);
  const val = n => $(`input[name="${n}"]:checked`, d).value;
  const collect = () => {
    const scope = val('x-scope');
    let ids;
    if (scope === 'current') ids = $$('#task-list [data-tid]').map(li => li.dataset.tid);
    else if (scope === 'status') { const ok = $$('[data-xs]', d).filter(c => c.checked).map(c => c.dataset.xs); ids = [...S.tasks.values()].filter(t => ok.includes(t.status || 'waiting')).map(t => t.id); }
    else if (scope === 'tag') { const tg = $('#x-tag', d).value; const allow = tg ? S.tagDescendants(tg) : null; ids = allow ? [...S.tasks.values()].filter(t => (t.tags || []).some(x => allow.has(x))).map(t => t.id) : []; }
    else if (scope === 'kw') { const m = matcher($('#x-kw', d).value); ids = m ? [...S.tasks.values()].filter(t => m(t.name + ' ' + (t.desc || ''))).map(t => t.id) : []; }
    else ids = [...S.tasks.keys()];
    let from = null, to = null;
    if (val('x-time') === 'range') { from = St.fromInput($('#x-from', d).value + 'T00:00'); to = St.addDays(St.fromInput($('#x-to', d).value + 'T00:00'), 1); }
    return exportSubset(new Set(ids), from, to);
  };
  const preview = () => { const { counts: c } = collect(); $('#x-count', d).textContent = `将导出 ${c.tasks} 个事务、${c.sessions} 条计时记录、${c.tags} 个标签、${c.reminders} 个提醒。`; };
  d.addEventListener('change', preview); d.addEventListener('input', preview);
  if (view !== 'timer' || !$('#task-list')) $('input[value="current"]', d).disabled = true;
  preview();
  $('[data-cancel]', d).onclick = () => d.close();
  $('[data-go]', d).onclick = () => {
    const { backup, csv, counts } = collect();
    if (!counts.tasks) { toast('没有符合条件的事务'); return; }
    const date = St.fmtDate(Date.now());
    if (val('x-fmt') === 'csv') download(`时间都去哪儿了-计时记录-${date}.csv`, csv, 'text/csv;charset=utf-8');
    else download(`时间都去哪儿了-部分备份-${date}.json`, JSON.stringify(backup, null, 1));
    d.close(); toast('已导出');
  };
}

// ---------- 使用帮助
function helpDialog() {
  modal('使用帮助', `<div class="help"><p class="muted small">版本 ${VERSION}（构建于 ${BUILD_TIME}）</p>
<h4>一、计时</h4>
<p>点事务左边的 <b>▶</b> 开始计时，再点 <b>■</b> 停止；也可以在上方“正在计时”卡片里停止、暂停或写<b>计时备注</b>（自动保存）。开始计时时，计时备注会预先填好：该事务第一次计时填入事务说明，以后沿用上一次的计时备注，可直接修改。</p>
<p>可以多项同时计时，电脑和手机也可以同时计时，记录都会保留。勾选“隐藏计时数字”进入专注模式，按住数字可临时查看。</p>
<p>计时超过设定时长（默认 4 小时）会标黄，提示可能忘记停止，点“设定结束时间”修正；这类计时不计入统计。</p>
<h4>二、事务</h4>
<p>点“＋ 新建事务”创建。点击事务查看详情：宽屏在右侧显示，手机弹出窗口。详情里可以直接改名称、说明（关于这件事本身的文字，每个事务一段）、状态、置顶、标签（自动保存），设置提醒，查看该事务的每日用时图（柱状/折线，可选时间段），以及全部计时记录（可修改、删除、补录）。</p>
<p>右键事务（或点右侧 ⋯）可快速：开始/停止、改状态、置顶、复制、设置提醒、删除。</p>
<h4>三、搜索、筛选、排序</h4>
<p>搜索语法：<b>空格、&amp;、+ = 同时包含</b>；<b>逗号、|、/ = 包含其一</b>。例：“NSFC 修改 / 评审”表示（同时含 NSFC 和 修改）或（含 评审）。</p>
<p>搜索框下方是<b>搜索范围</b>：名称、标签、说明、提醒，以及计时备注（勾选后生效，下拉框选择最后一次或全部）；点“其他”展开全部字段（上级标签、状态、置顶、计时设备、各种日期等）多选。日期按表格中的格式（年-月-日）搜索，可只输入前几位。</p>
<p><b>状态</b>：紧急、等待、完成可多选，按钮上的数字是当前结果中各状态的个数；还可按标签、“🔔 有提醒”筛选。表格上方显示查找到和全部的事务数、计时次数、总时长和各状态个数。</p>
<p>电脑版点表头排序，再点一次切换升/降序；拖动表头右边缘调整列宽（双击恢复）；点表头最左边的 ☰ 选择显示哪些列。手机版用排序下拉框。所有时长都以“小时:分钟:秒”显示。置顶的事务总在最前。电脑版表格在自己的区域内滚动，上方的计时和搜索栏保持不动。</p>
<h4>四、提醒</h4>
<p>三种方式：<b>定时提醒</b>（指定日期时刻）、<b>时长后提醒</b>（如 25 分钟后，可勾选按同样时长重复）、<b>重复提醒</b>（每 N 秒/分钟/小时/天/周/月/年）。提示方式：铃声、提示音、语音、音乐、闪屏。</p>
<p>到点弹窗可选“知道了”“延时 N 分钟”“停止重复”“开始计时”；可在设置中让弹窗倒计时自动关闭。在一台设备上处理后，其他设备上的弹窗自动关闭。</p>
<p><b>注意</b>：提醒只在程序打开时生效（电脑上开着即可，被挡住也会响；手机需在前台）。允许“系统通知”后，程序在后台时也会弹出通知。错过的提醒在下次打开时补弹。</p>
<h4>五、记录与统计</h4>
<p>“记录”页按天列出所有计时，显示每日累计和实际占用（重叠只算一次）；“需检查”列出疑似忘记停止和超长记录，“有重叠”列出同时进行的计时。</p>
<p>“统计”页可选时间范围并前后翻页，按事务/标签/一级标签/状态分组，查看占比环形图、明细表、用时分配（堆叠柱状或对比折线）、可缩放时间轴、时段分布和星期×时段热力图。</p>
<h4>六、标签</h4>
<p>标签可多级。设置页的“标签管理”有树形、列表（可按事务数、累计时长排序）、标签云三种视图，可置顶、改名、移动层级、删除。选标签时可用标签云或树形浏览。</p>
<h4>七、数据与同步</h4>
<p>登录同一账号的设备自动同步；数据在本机加密后才上传，服务器看不到内容。<b>密码就是加密钥匙，忘记后无法恢复。</b></p>
<p><b>离线版</b>（手机、电脑通用，从 GitHub Pages 等只放程序的网址打开）：没有同步服务器，右上角显示“仅本机”，数据只存在这台设备上，断网也能用。请定期在设置 → 数据中“导出全部备份”（手机上会弹出分享面板，可存到“文件”或发给自己）；超过设定天数没备份，计时页顶部会提醒。</p>
<p>设置页可导入旧版数据、导出全部备份（JSON）、导出部分数据（按当前筛选/状态/标签/关键词/时间段，JSON 或 Excel 可用的 CSV）。</p>
<h4>八、其他</h4>
<p>鼠标悬停在按钮上会显示操作提示，可在设置中关闭。可在设置中调整主题、字体和字号。可以把程序“添加到主屏幕/桌面”，像 App 一样使用。</p>
</div>`, { wide: true });
}

main();
