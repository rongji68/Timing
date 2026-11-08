// 同步：拉取服务器上的新密文 -> 本地解密合并；把本地修改加密后上传。
// 冲突时（两台设备改了同一条记录）在本机解密后合并，不丢数据。
import * as S from './store.js';
import { encryptRecord, decryptRecord, deriveKeys } from './crypto.js';

// 接口一律用相对路径（api/...），程序放在子路径下（如 GitHub Pages 的 /仓库名/）也能工作。
// server：null = 尚未检测；true = 有同步服务器；false = 当前网址只提供程序本身（如 GitHub Pages），仅本机使用。
const state = { token: null, user: null, key: null, lastSeq: 0, status: 'off', error: '', lastSync: 0, server: null };
const listeners = new Set();
let running = null, again = false, es = null, timer = null;

export function syncState() { return { ...state, key: !!state.key }; }
export function onSyncState(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function setStatus(status, error = '') {
  state.status = status; state.error = error;
  listeners.forEach(f => f(syncState()));
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  const r = await fetch(path, { method: opts.body ? 'POST' : 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let j = {};
  try { j = await r.json(); } catch (e) { /* ignore */ }
  if (!r.ok) { const e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
  return j;
}

/** 检测当前网址是否有同步服务器 */
export async function probeServer() {
  try {
    const r = await fetch('api/ping', { cache: 'no-store' });
    const j = await r.json();
    state.server = !!j.ok;
  } catch (e) {
    // 离线时无法判断：保留上次结果；从未判断过则视为没有服务器
    if (navigator.onLine === false && state.server !== null) return state.server;
    state.server = navigator.onLine === false ? (await S.getMeta('hasServer', false)) : false;
  }
  await S.setMeta('hasServer', state.server);
  listeners.forEach(f => f(syncState()));
  return state.server;
}

export async function init() {
  state.token = await S.getMeta('token');
  state.user = await S.getMeta('user');
  state.key = await S.getMeta('encKey');
  state.lastSeq = await S.getMeta('lastSeq', 0);
  if (state.token && state.key) {
    setStatus('idle');
    startLive();
    syncNow();
  } else setStatus('off');
  probeServer();
  S.onChange(src => { if (src === 'local') schedule(250); });
  window.addEventListener('online', () => syncNow());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { syncNow(); startLive(); } });
  timer = setInterval(() => syncNow(), 60000);
}

function deviceName() {
  const ua = navigator.userAgent;
  return /iPhone|iPad/.test(ua) ? 'iOS' : /HarmonyOS|OpenHarmony/.test(ua) ? '鸿蒙' : /Android/.test(ua) ? 'Android'
    : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : '浏览器';
}

/** 登录或注册。keepLocal=true 时把本机已有数据上传到该账号 */
export async function login(user, password, { register = false, invite = '' } = {}) {
  setStatus('busy');
  try {
    const { authKey, encKey } = await deriveKeys(user, password);
    const r = await api(register ? 'api/register' : 'api/login', { body: { user, authKey, invite, device: deviceName() } });
    const prevUser = await S.getMeta('user');
    if (prevUser !== user) {
      await S.markAllDirtyForNewAccount();
      state.lastSeq = 0; await S.setMeta('lastSeq', 0);
    }
    state.token = r.token; state.user = user; state.key = encKey;
    await S.setMeta('token', r.token); await S.setMeta('user', user); await S.setMeta('encKey', encKey);
    setStatus('idle');
    startLive();
    await syncNow();
  } catch (e) {
    setStatus(state.token ? 'error' : 'off', e.message);
    throw e;
  }
}

export async function logout() {
  try { await api('api/logout', { body: {} }); } catch (e) { /* ignore */ }
  state.token = null; state.key = null;
  await S.delMeta('token'); await S.delMeta('encKey');
  if (es) { es.close(); es = null; }
  setStatus('off');
}

export function schedule(ms = 500) {
  clearTimeout(schedule.t);
  schedule.t = setTimeout(() => syncNow(), ms);
}

export function syncNow() {
  if (!state.token || !state.key) return Promise.resolve();
  if (running) { again = true; return running; }
  running = (async () => {
    try {
      do {
        again = false;
        setStatus('busy');
        await pull();
        const conflicts = await push();
        if (conflicts) again = true;
      } while (again);
      state.lastSync = Date.now();
      setStatus(navigator.onLine === false ? 'offline' : 'idle');
    } catch (e) {
      if (e.status === 401) {
        state.token = null; await S.delMeta('token');
        setStatus('off', '登录已过期，请重新登录');
      } else setStatus('offline', e.message === 'Failed to fetch' ? '无法连接服务器' : e.message);
    } finally { running = null; }
  })();
  return running;
}

/** 合并同一条记录的两个版本：以较新修改为准；但若一方已结束计时而另一方仍在计时，保留结束时间 */
export function merge(a, b) {
  if (!a) return b;
  if (!b) return a;
  const [newer, older] = (a.mtime || 0) >= (b.mtime || 0) ? [a, b] : [b, a];
  const out = { ...newer };
  if (out.t === 'session' && out.end == null && older.end != null) { out.end = older.end; out.paused = older.paused; }
  out.mtime = Math.max(a.mtime || 0, b.mtime || 0);
  return out;
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

async function pull() {
  for (let guard = 0; guard < 1000; guard++) {
    const j = await api('api/changes?since=' + state.lastSeq);
    const out = [];
    for (const r of j.records) {
      const local = S.getRec(r.id);
      let data = null;
      if (!r.deleted) {
        try { data = await decryptRecord(state.key, r.id, r.blob); }
        catch (e) { console.warn('无法解密记录', r.id); continue; }
      }
      if (local && local.dirty) {
        // 本机也改过：合并后保持待上传，base 更新为服务器最新版本
        if (local.deleted && data) out.push({ id: r.id, base: r.seq, dirty: false, deleted: false, ver: local.ver, data });
        else if (!local.deleted && !data) out.push({ ...local, base: r.seq });           // 对方删了、本机改了：保留本机修改
        else if (local.deleted && !data) out.push({ ...local, base: r.seq, dirty: false });
        else {
          const m = merge(local.data, data);
          out.push(same(m, data) ? { id: r.id, base: r.seq, dirty: false, deleted: false, ver: local.ver, data }
            : { ...local, base: r.seq, data: m });
        }
      } else {
        out.push({ id: r.id, base: r.seq, dirty: false, deleted: !data, ver: local?.ver || 0, data });
      }
    }
    await S.saveSynced(out);
    if (j.records.length) state.lastSeq = j.records[j.records.length - 1].seq;
    await S.setMeta('lastSeq', state.lastSeq);
    if (!j.more) break;
  }
}

async function push() {
  const dirty = S.dirtyRecords();
  let conflicts = 0;
  for (let i = 0; i < dirty.length; i += 400) {
    const batch = dirty.slice(i, i + 400);
    const payload = [];
    for (const r of batch) {
      payload.push({ id: r.id, base: r.base, deleted: r.deleted,
        blob: r.deleted ? null : await encryptRecord(state.key, r.id, r.data) });
    }
    const j = await api('api/push', { body: { records: payload } });
    const updated = [];
    for (const res of j.results) {
      const sent = batch.find(r => r.id === res.id);
      const cur = S.getRec(res.id);
      if (!sent || !cur) continue;
      if (res.seq) {
        updated.push({ ...cur, base: res.seq, dirty: cur.ver !== sent.ver });
      } else if (res.conflict) {
        conflicts++;
        const c = res.current;
        let data = null;
        if (!c.deleted) { try { data = await decryptRecord(state.key, res.id, c.blob); } catch (e) { continue; } }
        if (cur.deleted && data) updated.push({ id: cur.id, base: c.seq, dirty: false, deleted: false, ver: cur.ver, data });
        else if (!cur.deleted && !data) updated.push({ ...cur, base: c.seq });
        else if (cur.deleted && !data) updated.push({ ...cur, base: c.seq, dirty: false });
        else {
          const m = merge(cur.data, data);
          updated.push(same(m, data) ? { id: cur.id, base: c.seq, dirty: false, deleted: false, ver: cur.ver, data }
            : { ...cur, base: c.seq, data: m, dirty: true });
        }
      }
    }
    await S.saveSynced(updated, 'sync');
  }
  return conflicts;
}

// ---------- 实时推送：服务器有新数据时立即拉取
function startLive() {
  if (!state.token || es || typeof EventSource === 'undefined') return;
  es = new EventSource('api/events?token=' + encodeURIComponent(state.token));
  es.onmessage = ev => { if (+ev.data > state.lastSeq) schedule(100); };
  es.onerror = () => {
    if (es && es.readyState === EventSource.CLOSED) { es = null; setTimeout(startLive, 5000); }
  };
}
