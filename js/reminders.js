// 提醒：数据、到点检测、弹窗、声音、系统通知、编辑和管理界面。
// 网页只有打开着才能提醒（电脑上程序开着即可，被其他窗口挡住也行；手机需程序在前台）。
//
// 记录格式：
// { t:'reminder', id:'rm-…', task:'tk-…', kind:'once'|'after'|'repeat', at: 下次提醒时间(ms),
//   every: 0|N, unit: 's'|'min'|'h'|'d'|'w'|'M'|'y',   // every>0 表示到点后按此间隔重复
//   text:'提醒词', sound:'bell'|'beep'|'voice'|'music'|'flash', snooze: 默认延后分钟, enabled, lastFired }
import * as S from './store.js';
import * as St from './stats.js';
import { $, $$, esc, modal, toast, confirmBox, prefs, savePrefs } from './ui.js';

export const UNITS = { s: '秒', min: '分钟', h: '小时', d: '天', w: '周', M: '月', y: '年' };
export const SOUNDS = { bell: '铃声', beep: '提示音', voice: '语音', music: '音乐', flash: '闪屏（无声）' };
export const KINDS = { once: '定时提醒', after: '时长后提醒', repeat: '重复提醒' };
const SNOOZES = [1, 3, 5, 10, 15, 30, 60];

let hooks = { startTask: null, isRunning: () => false };
const fired = new Set();          // 本次打开页面后已弹出过的 “id@at”，避免重复弹出
const cards = new Map();          // id -> { el, at, timer }

export function addInterval(t, every, unit) {
  const d = new Date(t);
  switch (unit) {
    case 's': return t + every * 1000;
    case 'min': return t + every * 60e3;
    case 'h': return t + every * 3600e3;
    case 'd': d.setDate(d.getDate() + every); return d.getTime();
    case 'w': d.setDate(d.getDate() + 7 * every); return d.getTime();
    case 'M': d.setMonth(d.getMonth() + every); return d.getTime();
    case 'y': d.setFullYear(d.getFullYear() + every); return d.getTime();
  }
  return t + every * 60e3;
}
/** 重复提醒：从 at 开始按间隔推进，直到晚于 now */
export function nextAfter(r, now = Date.now()) {
  if (!(r.every > 0)) return null;
  let t = r.at, guard = 0;
  while (t <= now && guard++ < 100000) t = addInterval(t, r.every, r.unit);
  return t;
}
export function describe(r) {
  const rep = r.every > 0 ? `每 ${r.every} ${UNITS[r.unit] || ''}` : '一次';
  return `${KINDS[r.kind] || '提醒'} · ${rep}`;
}
export function taskHasReminder(taskId) {
  for (const r of S.reminders.values()) if (r.task === taskId && r.enabled) return true;
  return false;
}

// ======================================================== 声音
let actx = null;
function ctx() {
  if (!actx) { const C = window.AudioContext || window.webkitAudioContext; if (C) actx = new C(); }
  return actx;
}
/** 浏览器要求先有用户操作才能出声：第一次点击页面时解锁 */
export function unlockAudio() {
  const once = () => { const c = ctx(); if (c && c.state === 'suspended') c.resume(); };
  document.addEventListener('pointerdown', once, { once: true, capture: true });
  document.addEventListener('keydown', once, { once: true, capture: true });
}
function tone(c, freq, start, dur, { type = 'sine', gain = 0.25, decay = true } = {}) {
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + 0.01);
  if (decay) g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  else { g.gain.setValueAtTime(gain, start + dur - 0.03); g.gain.exponentialRampToValueAtTime(0.0001, start + dur); }
  o.connect(g).connect(c.destination);
  o.start(start); o.stop(start + dur + 0.05);
}
export function playSound(kind, text = '') {
  if (navigator.vibrate) try { navigator.vibrate([300, 150, 300]); } catch (e) { /* ignore */ }
  if (kind === 'flash') { flash(); return; }
  if (kind === 'voice' && 'speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance('提醒：' + (text || '时间到了'));
    u.lang = 'zh-CN';
    speechSynthesis.cancel(); speechSynthesis.speak(u);
    return;
  }
  const c = ctx(); if (!c) return;
  if (c.state === 'suspended') c.resume();
  const t0 = c.currentTime + 0.05;
  if (kind === 'beep') {
    for (let i = 0; i < 3; i++) tone(c, 1000, t0 + i * 0.3, 0.15, { type: 'square', gain: 0.12, decay: false });
  } else if (kind === 'music') {
    [523, 659, 784, 1047, 784, 659, 784].forEach((f, i) => tone(c, f, t0 + i * 0.22, 0.4, { gain: 0.2 }));
  } else {                                       // 铃声：三次带泛音的“叮”
    for (let i = 0; i < 3; i++) for (const [f, g] of [[880, 0.22], [1320, 0.1], [2200, 0.05]]) tone(c, f, t0 + i * 0.9, 1.2, { gain: g });
  }
}
function flash() {
  document.body.classList.remove('flash'); void document.body.offsetWidth;
  document.body.classList.add('flash');
  setTimeout(() => document.body.classList.remove('flash'), 2200);
}

// ======================================================== 系统通知
export async function requestNotify() {
  if (!('Notification' in window)) { toast('此浏览器不支持系统通知'); return 'unsupported'; }
  const p = await Notification.requestPermission();
  toast(p === 'granted' ? '已允许系统通知' : '未获得通知权限，可在浏览器设置中开启');
  return p;
}
export function notifyState() { return 'Notification' in window ? Notification.permission : 'unsupported'; }
async function systemNotify(title, body, tag) {
  if (!prefs.remNotify || notifyState() !== 'granted') return;
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) await reg.showNotification(title, { body, tag, renotify: true, icon: 'icon-192.png' });
    else new Notification(title, { body, tag, icon: 'icon-192.png' });
  } catch (e) { /* 部分手机浏览器只允许通过 Service Worker 通知 */ }
}

// ======================================================== 到点检测与弹窗
export function init(h) {
  hooks = { ...hooks, ...h };
  unlockAudio();
  let layer = $('#rem-layer');
  if (!layer) { layer = document.createElement('div'); layer.id = 'rem-layer'; document.body.appendChild(layer); }
  S.onChange(() => reconcile());
}

/** 每秒调用：找出到点的提醒并弹出 */
export function check(now = Date.now()) {
  for (const r of S.reminders.values()) {
    if (!r.enabled || !(r.at <= now)) continue;
    const key = r.id + '@' + r.at;
    if (fired.has(key)) continue;
    fired.add(key);
    fire(r, now);
  }
}

function fire(r, now) {
  const task = S.tasks.get(r.task);
  const late = now - r.at > 90e3;
  const title = r.text || task?.name || '提醒';
  playSound(r.sound || 'bell', r.text || task?.name || '');
  systemNotify('⏰ ' + title, (task ? task.name : '') + (late ? `（原定 ${St.fmtDateTime(r.at)}）` : ''), r.id);
  showCard(r, late);
}

function showCard(r, late) {
  closeCard(r.id);
  const task = S.tasks.get(r.task);
  const el = document.createElement('div');
  el.className = 'rem-card';
  const rep = r.every > 0;
  el.innerHTML = `
    <div class="rem-head"><span class="bell">🔔</span><b>提醒</b><span class="rem-count" data-count></span>
      <button class="icon" data-a="ok" aria-label="关闭">✕</button></div>
    <div class="rem-text">${esc(r.text || task?.name || '时间到了')}</div>
    ${task && r.text ? `<div class="rem-task">事务：${esc(task.name)}</div>` : ''}
    <div class="rem-time">${late ? '原定 ' + St.fmtDateTime(r.at) + '（错过时程序未打开）' : St.fmtDateTime(r.at)}${rep ? ' · ' + describe(r) : ''}</div>
    <div class="rem-btns">
      <button class="btn primary" data-a="ok">知道了</button>
      <span class="snz"><button class="btn" data-a="snooze">延时</button>
        <select data-snz>${SNOOZES.map(m => `<option value="${m}" ${m === (r.snooze || 5) ? 'selected' : ''}>${m} 分钟</option>`).join('')}</select></span>
      ${rep ? '<button class="btn" data-a="stop">停止重复</button>' : ''}
      ${task && hooks.startTask && !hooks.isRunning(task.id) ? '<button class="btn" data-a="start">▶ 开始计时</button>' : ''}
    </div>`;
  $('#rem-layer').appendChild(el);
  const card = { el, at: r.at, timer: null };
  cards.set(r.id, card);
  el.onclick = async e => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'start') { await hooks.startTask(r.task); return; }
    await act(r.id, a, +$('[data-snz]', el).value);
  };
  if (prefs.remAutoClose) {
    let sec = Math.max(5, +prefs.remAutoSec || 60);
    const cnt = $('[data-count]', el);
    cnt.textContent = sec + 's';
    card.timer = setInterval(() => {
      sec--; cnt.textContent = sec + 's';
      if (sec <= 0) act(r.id, 'ok');
    }, 1000);
    el.addEventListener('pointerdown', () => { clearInterval(card.timer); cnt.textContent = ''; }, { once: true });
  }
}
function closeCard(id) {
  const c = cards.get(id);
  if (!c) return;
  clearInterval(c.timer); c.el.remove(); cards.delete(id);
}
/** 处理提醒：ok=知道了，snooze=延时，stop=停止重复 */
async function act(id, a, snoozeMin = 5) {
  const r = S.reminders.get(id);
  closeCard(id);
  if (!r) return;
  const now = Date.now();
  if (a === 'snooze') await S.put({ ...r, at: now + snoozeMin * 60e3, lastFired: now });
  else if (a === 'stop' || !(r.every > 0)) await S.put({ ...r, enabled: false, lastFired: now });
  else await S.put({ ...r, at: nextAfter(r, now), lastFired: now });
}
/** 另一台设备已处理（时间改变或停用）时，关闭本机的弹窗 */
function reconcile() {
  for (const [id, c] of cards) {
    const r = S.reminders.get(id);
    if (!r || !r.enabled || r.at !== c.at) closeCard(id);
  }
}

// ======================================================== 编辑提醒
export function reminderDialog(id, { task = '' } = {}) {
  const now = Date.now();
  const r = id ? S.reminders.get(id) : { t: 'reminder', id: S.newId('rm'), task, kind: 'after', at: now + 25 * 60e3, every: 0, unit: 'min',
    text: '', sound: 'bell', snooze: 5, enabled: true, created: now };
  if (!r) return;
  const isNew = !id;
  const tasks = [...S.tasks.values()].sort((a, b) => (b.status !== 'completed') - (a.status !== 'completed') || a.name.localeCompare(b.name, 'zh'));
  const afterMin = r.kind === 'after' && r.every > 0 ? toMinutes(r.every, r.unit) : 25;
  const d = modal(isNew ? '设置提醒' : '修改提醒', `
    <label class="fld"><span>事务</span><select id="r-task"><option value="">（不关联事务）</option>${tasks.map(t => `<option value="${t.id}" ${t.id === r.task ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
    <label class="fld"><span>提醒词</span><input id="r-text" value="${esc(r.text)}" placeholder="例如：休息一下 / 去开会"></label>
    <div class="fld"><span>提醒方式</span><div class="seg" id="r-kind">${Object.entries(KINDS).map(([k, l]) => `<button type="button" data-k="${k}" class="${r.kind === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <div class="kind-pane" data-pane="once">
      <label class="fld"><span>提醒时间</span><input type="datetime-local" id="r-at" value="${St.toInput(r.kind === 'once' ? r.at : now + 3600e3)}"></label>
      <div class="quick">快捷：${[['今天 12:00', 12], ['今天 18:00', 18], ['明天 9:00', 33]].map(([l, h]) => `<button type="button" class="btn small" data-hour="${h}">${l}</button>`).join('')}</div>
    </div>
    <div class="kind-pane" data-pane="after">
      <div class="row2"><label class="fld"><span>多久之后提醒</span><input type="number" id="r-after" min="1" value="${afterMin >= 60 && afterMin % 60 === 0 ? afterMin / 60 : afterMin}"></label>
      <label class="fld"><span>单位</span><select id="r-after-u"><option value="min">分钟</option><option value="h" ${afterMin >= 60 && afterMin % 60 === 0 ? 'selected' : ''}>小时</option></select></label></div>
      <div class="quick">快捷：${[5, 10, 15, 25, 30, 45, 60, 90, 120].map(m => `<button type="button" class="btn small" data-min="${m}">${m < 60 ? m + '分' : m / 60 + '小时'}</button>`).join('')}</div>
      <label class="fld chk"><input type="checkbox" id="r-after-rep" ${r.kind === 'after' && r.every > 0 ? 'checked' : ''}> 到点后按同样时长重复提醒（适合番茄钟、定时休息）</label>
      ${!isNew && r.kind === 'after' ? `<p class="muted small">保存后将从现在重新开始计算。当前下次提醒：${St.fmtDateTime(r.at)}</p>` : ''}
    </div>
    <div class="kind-pane" data-pane="repeat">
      <label class="fld"><span>首次提醒时间</span><input type="datetime-local" id="r-start" value="${St.toInput(r.kind === 'repeat' ? r.at : now + 3600e3)}"></label>
      <div class="row2"><label class="fld"><span>每隔</span><input type="number" id="r-every" min="1" value="${r.kind === 'repeat' ? r.every || 1 : 1}"></label>
      <label class="fld"><span>单位</span><select id="r-unit">${Object.entries(UNITS).map(([u, l]) => `<option value="${u}" ${(r.kind === 'repeat' ? r.unit : 'd') === u ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
    </div>
    <div class="row2">
      <label class="fld"><span>提示方式</span><select id="r-sound">${Object.entries(SOUNDS).map(([k, l]) => `<option value="${k}" ${r.sound === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="fld"><span>默认延时</span><select id="r-snooze">${SNOOZES.map(m => `<option value="${m}" ${m === (r.snooze || 5) ? 'selected' : ''}>${m} 分钟</option>`).join('')}</select></label>
    </div>
    <label class="fld chk"><input type="checkbox" id="r-en" ${r.enabled ? 'checked' : ''}> 启用</label>
    ${notifyState() === 'default' ? `<p class="hint">提示：允许“系统通知”后，程序在后台时也会弹出通知。<button type="button" class="btn small" data-notify>允许系统通知</button></p>` : ''}
    <p class="muted small">提醒只在程序打开时生效（电脑上开着即可；手机需在前台）。程序关闭期间错过的提醒，下次打开时会补弹。</p>
    <div class="btns">
      ${isNew ? '' : '<button type="button" class="btn danger left" data-del>删除</button>'}
      <button type="button" class="btn" data-try>试听</button>
      <button type="button" class="btn" data-cancel>取消</button>
      <button type="button" class="btn primary" data-save>保存</button>
    </div>`);
  let kind = r.kind;
  const showPane = () => {
    $$('.kind-pane', d).forEach(p => p.hidden = p.dataset.pane !== kind);
    $$('#r-kind button', d).forEach(b => b.classList.toggle('on', b.dataset.k === kind));
  };
  showPane();
  $('#r-kind', d).onclick = e => { const b = e.target.closest('[data-k]'); if (b) { kind = b.dataset.k; showPane(); } };
  $$('[data-min]', d).forEach(b => b.onclick = () => {
    const m = +b.dataset.min;
    if (m >= 60 && m % 60 === 0) { $('#r-after', d).value = m / 60; $('#r-after-u', d).value = 'h'; } else { $('#r-after', d).value = m; $('#r-after-u', d).value = 'min'; }
  });
  $$('[data-hour]', d).forEach(b => b.onclick = () => {
    const h = +b.dataset.hour, base = St.startOfDay(Date.now());
    $('#r-at', d).value = St.toInput(base + h * 3600e3);
  });
  const nb = $('[data-notify]', d); if (nb) nb.onclick = async () => { await requestNotify(); nb.parentElement.remove(); };
  $('[data-try]', d).onclick = () => playSound($('#r-sound', d).value, $('#r-text', d).value || '试听');
  $('[data-cancel]', d).onclick = () => d.close();
  $('[data-save]', d).onclick = async () => {
    const out = { ...r, task: $('#r-task', d).value, text: $('#r-text', d).value.trim(), kind, sound: $('#r-sound', d).value,
      snooze: +$('#r-snooze', d).value, enabled: $('#r-en', d).checked };
    const t = Date.now();
    if (kind === 'once') {
      out.at = St.fromInput($('#r-at', d).value); out.every = 0;
      if (!out.at) { toast('请填写提醒时间'); return; }
      if (out.at <= t && out.enabled) { toast('提醒时间已过，请选择将来的时间'); return; }
    } else if (kind === 'after') {
      const n = +$('#r-after', d).value, u = $('#r-after-u', d).value;
      if (!(n > 0)) { toast('请填写时长'); return; }
      out.at = addInterval(t, n, u);
      out.every = $('#r-after-rep', d).checked ? n : 0; out.unit = u;
    } else {
      const st = St.fromInput($('#r-start', d).value), n = Math.floor(+$('#r-every', d).value);
      if (!st || !(n > 0)) { toast('请填写首次时间和间隔'); return; }
      if (n < 10 && $('#r-unit', d).value === 's') { toast('按秒重复时，间隔至少 10 秒'); return; }
      out.every = n; out.unit = $('#r-unit', d).value;
      out.at = st > t ? st : nextAfter({ ...out, at: st }, t);
    }
    await S.put(out);
    d.close();
    toast(`已设置提醒：${St.fmtDateTime(out.at)}`);
    if (prefs.remNotify && notifyState() === 'default') requestNotify();
  };
  const del = $('[data-del]', d);
  if (del) del.onclick = async () => { if (await confirmBox('删除这个提醒？', '删除', true)) { await S.remove(r.id); d.close(); } };
}
function toMinutes(n, u) { return u === 'h' ? n * 60 : u === 'd' ? n * 1440 : n; }

// ======================================================== 提醒管理
export function managerDialog() {
  const d = modal('提醒管理', `<div class="toolbar"><div class="seg" id="rm-f"><button data-f="all" class="on">全部</button><button data-f="on">已启用</button><button data-f="off">已停用</button></div>
    <button class="btn primary" data-new>＋ 新建提醒</button></div><div class="scroll-x" id="rm-list"></div>`, { wide: true });
  let f = 'all';
  const draw = () => {
    if (!d.isConnected) return;
    const list = [...S.reminders.values()].filter(r => f === 'all' || (f === 'on' ? r.enabled : !r.enabled))
      .sort((a, b) => (b.enabled - a.enabled) || a.at - b.at);
    $('#rm-list', d).innerHTML = list.length ? `<table class="rank rem-table"><thead><tr><th>启用</th><th>事务</th><th>提醒词</th><th>方式</th><th>下次提醒</th><th>延时</th><th>提示</th></tr></thead><tbody>
      ${list.map(r => `<tr data-id="${r.id}" class="${r.enabled ? '' : 'off'}"><td><input type="checkbox" data-en ${r.enabled ? 'checked' : ''}></td>
        <td>${esc(S.tasks.get(r.task)?.name || '—')}</td><td>${esc(r.text || '')}</td><td>${describe(r)}</td>
        <td class="num">${r.enabled ? St.fmtDateTime(r.at) : '—'}</td><td class="num">${r.snooze || 5} 分</td><td>${SOUNDS[r.sound] || ''}</td></tr>`).join('')}
      </tbody></table><p class="muted small">点击一行修改。</p>` : '<p class="muted pad">没有提醒</p>';
  };
  draw();
  const off = S.onChange(draw);
  d.addEventListener('close', off);
  $('#rm-f', d).onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; f = b.dataset.f; $$('#rm-f button', d).forEach(x => x.classList.toggle('on', x === b)); draw(); };
  $('[data-new]', d).onclick = () => reminderDialog(null);
  $('#rm-list', d).onclick = async e => {
    const tr = e.target.closest('[data-id]'); if (!tr) return;
    const r = S.reminders.get(tr.dataset.id); if (!r) return;
    if (e.target.matches('[data-en]')) {
      const en = e.target.checked;
      let at = r.at;
      if (en && at <= Date.now()) at = r.every > 0 ? nextAfter(r) : (r.kind === 'after' ? Date.now() + 25 * 60e3 : at);
      if (en && at <= Date.now()) { e.target.checked = false; toast('这个定时提醒的时间已过，请点击修改时间'); return; }
      await S.put({ ...r, enabled: en, at });
      return;
    }
    reminderDialog(r.id);
  };
}
