// 本地数据：IndexedDB 中保存明文记录（本机使用，查找统计都在本地完成），内存中保留一份便于快速访问。
// 每条本地记录：{ id, base, dirty, deleted, ver, data }
//   base  = 该记录在服务器上的版本号（0 表示服务器上还没有）
//   dirty = 本地有修改尚未上传
//   data  = { t: 'tag'|'task'|'session', ...字段, mtime }

const DB_NAME = 'tsdq';
let db;
const recs = new Map();              // id -> 本地记录（含已删除的墓碑）
export const tags = new Map();       // id -> data
export const tasks = new Map();
export const sessions = new Map();
export const reminders = new Map();
const listeners = new Set();

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function tx(stores, mode = 'readonly') { return db.transaction(stores, mode); }

export async function open() {
  db = await new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('records', { keyPath: 'id' });
      d.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const all = await req(tx('records').objectStore('records').getAll());
  for (const r of all) { recs.set(r.id, r); index(r); }
}

const MAPS = { tag: tags, task: tasks, session: sessions, reminder: reminders };
export const TYPES = Object.keys(MAPS);
function mapFor(t) { return MAPS[t] || null; }

function index(r) {
  for (const m of Object.values(MAPS)) m.delete(r.id);
  if (!r.deleted && r.data) { const m = mapFor(r.data.t); if (m) m.set(r.id, r.data); }
}

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
let notifyTimer = null;
function notify(source) {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => listeners.forEach(f => f(source)), 0);
}

// ---------- meta（设置、登录信息、同步进度）
export async function getMeta(k, dflt = null) {
  const v = await req(tx('meta').objectStore('meta').get(k));
  return v === undefined ? dflt : v;
}
export async function setMeta(k, v) { await req(tx('meta', 'readwrite').objectStore('meta').put(v, k)); }
export async function delMeta(k) { await req(tx('meta', 'readwrite').objectStore('meta').delete(k)); }

// ---------- 本地修改
export function newId(prefix) {
  const a = crypto.getRandomValues(new Uint8Array(10));
  return prefix + '-' + [...a].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 14);
}

async function writeRecs(list) {
  const t = tx('records', 'readwrite');
  const os = t.objectStore('records');
  for (const r of list) os.put(r);
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
}

/** 保存若干条数据（新增或修改），标记为待上传 */
export async function put(...items) {
  const now = Date.now();
  const list = items.map(data => {
    data.mtime = now;
    const old = recs.get(data.id);
    const r = { id: data.id, base: old ? old.base : 0, dirty: true, deleted: false, ver: (old?.ver || 0) + 1, data };
    recs.set(r.id, r); index(r);
    return r;
  });
  await writeRecs(list);
  notify('local');
}

export async function remove(...ids) {
  const list = [];
  for (const id of ids) {
    const old = recs.get(id);
    if (!old || old.deleted) continue;
    const r = { id, base: old.base, dirty: true, deleted: true, ver: (old.ver || 0) + 1, data: null };
    recs.set(id, r); index(r); list.push(r);
  }
  await writeRecs(list);
  notify('local');
}

// ---------- 同步模块使用
export function dirtyRecords() { return [...recs.values()].filter(r => r.dirty); }
export function getRec(id) { return recs.get(id); }
export async function saveSynced(list, source = 'sync') {
  for (const r of list) { recs.set(r.id, r); index(r); }
  await writeRecs(list);
  if (list.length) notify(source);
}
export async function clearAll() {
  const t = tx(['records', 'meta'], 'readwrite');
  t.objectStore('records').clear();
  t.objectStore('meta').clear();
  await new Promise(res => { t.oncomplete = res; });
  recs.clear(); for (const m of Object.values(MAPS)) m.clear();
  notify('local');
}
/** 换账号时：保留本地数据，但全部标记为待上传到新账号 */
export async function markAllDirtyForNewAccount() {
  const list = [];
  for (const r of recs.values()) {
    if (r.deleted) { recs.delete(r.id); continue; }
    r.base = 0; r.dirty = true; list.push(r);
  }
  const t = tx('records', 'readwrite');
  t.objectStore('records').clear();
  await new Promise(res => { t.oncomplete = res; });
  await writeRecs(list);
}

// ---------- 常用查询
export function taskSessions(taskId) {
  return [...sessions.values()].filter(s => s.task === taskId);
}
export function taskReminders(taskId) {
  return [...reminders.values()].filter(r => r.task === taskId);
}
export function runningSessions() {
  return [...sessions.values()].filter(s => s.end == null).sort((a, b) => a.start - b.start);
}
export function sessionEnd(s, now = Date.now()) { return s.end == null ? now : s.end; }

/** 标签的完整路径名，如 “科研 / 项目A” */
export function tagPath(id) {
  const parts = [];
  let t = tags.get(id), guard = 0;
  while (t && guard++ < 10) { parts.unshift(t.name); t = t.parent ? tags.get(t.parent) : null; }
  return parts.join(' / ');
}
export function tagRoot(id) {
  let t = tags.get(id), guard = 0;
  while (t && t.parent && tags.get(t.parent) && guard++ < 10) t = tags.get(t.parent);
  return t ? t.id : id;
}
export function tagDescendants(id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tags.values()) if (t.parent && out.has(t.parent) && !out.has(t.id)) { out.add(t.id); grew = true; }
  }
  return out;
}
