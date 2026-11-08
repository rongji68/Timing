// 界面公共部件：选择器、转义、轻提示、悬停提示、弹窗（可叠加）、确认框、弹出菜单、偏好设置
import * as S from './store.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 偏好（只保存在本设备）
export const DEFAULT_PREFS = {
  warnHours: 4, confirmStop: false, autoStopOthers: false, theme: 'auto',
  hideTimer: false, showHelp: true, fontSize: 15, fontFamily: 'system',
  taskStatuses: ['urgent', 'waiting', 'completed'], taskSort: 'recent', taskSortAsc: false,
  searchFields: ['name', 'tags', 'desc', 'noteAll'], noteKind: 'noteAll', taskCols: null, colWidths: {},
  statRange: '30', statGroup: 'tag', statSplit: 'even', statGran: 'auto', statTrend: 'stack',
  remNotify: true, remAutoClose: true, remAutoSec: 60, tagView: 'tree', layout: 'auto', backupDays: 7,
};
export const prefs = { ...DEFAULT_PREFS };
export async function loadPrefs() { Object.assign(prefs, await S.getMeta('prefs', {})); }
export async function savePrefs() { await S.setMeta('prefs', { ...prefs }); }

export const FONTS = {
  system: ['系统默认', 'system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "HarmonyOS Sans SC", sans-serif'],
  hei: ['黑体', '"PingFang SC", "Heiti SC", "Microsoft YaHei", "SimHei", sans-serif'],
  song: ['宋体', '"Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", serif'],
  kai: ['楷体', '"Kaiti SC", "STKaiti", "KaiTi", serif'],
  round: ['圆体', '"Yuanti SC", "YouYuan", "PingFang SC", sans-serif'],
};
// ---------- 界面布局：电脑版（左侧导航、表格、多列）/ 手机版（底部导航、卡片列表）
const deskMQ = window.matchMedia('(min-width: 1000px)');
export function isDesk() { return prefs.layout === 'desk' || (prefs.layout !== 'mobile' && deskMQ.matches); }
export function onLayoutChange(fn) { deskMQ.addEventListener('change', () => { applyAppearance(); fn(); }); }

export function applyAppearance() {
  document.body.classList.toggle('desk', isDesk());
  const r = document.documentElement;
  if (prefs.theme === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', prefs.theme);
  const fs = Math.min(22, Math.max(12, +prefs.fontSize || 15));
  r.style.setProperty('--fs', fs + 'px');
  r.style.setProperty('--font', (FONTS[prefs.fontFamily] || FONTS.system)[1]);
}

// ---------- 轻提示
export function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), ms);
}

// ---------- 悬停提示：data-tip = 数据提示（总是显示）；data-help = 操作帮助（可在设置中关闭）
export function showTip(text, x, y) {
  const tip = $('#tip');
  if (!text) { tip.hidden = true; return; }
  tip.textContent = text; tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let left = x + 14, top = y + 14;
  if (left + w > innerWidth - 6) left = Math.max(6, x - w - 14);
  if (top + h > innerHeight - 6) top = Math.max(6, y - h - 14);
  tip.style.left = left + 'px'; tip.style.top = top + 'px';
}
export function bindTips() {
  let helpTimer = null;
  document.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest?.('[data-tip]');
    if (el) { clearTimeout(helpTimer); showTip(el.dataset.tip, e.clientX, e.clientY); return; }
    const h = prefs.showHelp && e.target.closest?.('[data-help]');
    if (h) {
      const { clientX: x, clientY: y } = e;
      if ($('#tip').hidden || $('#tip').textContent !== h.dataset.help) {
        clearTimeout(helpTimer); showTip(null);
        helpTimer = setTimeout(() => showTip(h.dataset.help, x, y), 500);
      }
      return;
    }
    clearTimeout(helpTimer);
    if (!e.target.closest?.('canvas')) showTip(null);
  });
  document.addEventListener('click', e => {
    const el = e.target.closest?.('[data-tip]');
    if (el && !e.target.closest('button,a,input,select')) {
      showTip(el.dataset.tip, e.clientX, e.clientY);
      clearTimeout(showTip.t); showTip.t = setTimeout(() => showTip(null), 3500);
    } else if (!e.target.closest?.('canvas')) { clearTimeout(helpTimer); showTip(null); }
  });
  window.addEventListener('scroll', () => showTip(null), { passive: true });
}

// ---------- 弹窗：每次新建一个 <dialog>，可以叠加（例如在事务详情里再打开计时记录）
export function modal(title, bodyHtml, { wide = false, onClose = null } = {}) {
  const d = document.createElement('dialog');
  if (wide) d.classList.add('wide');
  d.innerHTML = `<div class="dlg-inner"><header><h2>${esc(title)}</h2>
    <button type="button" class="icon" data-close aria-label="关闭">✕</button></header><div class="dlg-body">${bodyHtml}</div></div>`;
  document.body.appendChild(d);
  $('[data-close]', d).onclick = () => d.close();
  d.addEventListener('close', () => { onClose && onClose(); d.remove(); });
  d.showModal();
  return d;
}
export function confirmBox(msg, okText = '确定', danger = false) {
  return new Promise(res => {
    let done = false;
    const d = modal('请确认', `<p class="confirm-msg">${esc(msg)}</p><div class="btns">
      <button type="button" class="btn" data-no>取消</button>
      <button type="button" class="btn ${danger ? 'danger solid' : 'primary'}" data-yes>${esc(okText)}</button></div>`,
      { onClose: () => { if (!done) res(false); } });
    $('[data-yes]', d).onclick = () => { done = true; res(true); d.close(); };
    $('[data-no]', d).onclick = () => { done = true; res(false); d.close(); };
  });
}

// ---------- 弹出菜单：items = [{label, act, danger, disabled}] 或 '-'（分隔线）
export function popMenu(items, x, y, onPick) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'popmenu';
  m.innerHTML = items.map((it, i) => it === '-' ? '<hr>' :
    `<button type="button" data-i="${i}" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}>${esc(it.label)}</button>`).join('');
  document.body.appendChild(m);
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(6, Math.min(x, innerWidth - w - 6)) + 'px';
  m.style.top = Math.max(6, Math.min(y, innerHeight - h - 6)) + 'px';
  m.onclick = e => {
    const b = e.target.closest('[data-i]'); if (!b) return;
    closeMenu(); onPick(items[+b.dataset.i]);
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', closeMenu.outside = ev => { if (!m.contains(ev.target)) closeMenu(); }, true);
    window.addEventListener('scroll', closeMenu, { once: true, passive: true });
  }, 0);
}
/** 弹出面板（可含复选框等，点击面板外关闭）。align='right'（默认）时 x 为面板右边缘，'left' 时为左边缘 */
export function popPanel(html, x, y, { align = 'right' } = {}) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'popmenu panel';
  m.innerHTML = html;
  document.body.appendChild(m);
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(6, Math.min(align === 'left' ? x : x - w, innerWidth - w - 6)) + 'px';
  m.style.top = Math.max(6, Math.min(y, innerHeight - h - 6)) + 'px';
  setTimeout(() => {
    document.addEventListener('pointerdown', closeMenu.outside = ev => { if (!m.contains(ev.target)) closeMenu(); }, true);
  }, 0);
  return m;
}
export function closeMenu() {
  $$('.popmenu').forEach(m => m.remove());
  if (closeMenu.outside) { document.removeEventListener('pointerdown', closeMenu.outside, true); closeMenu.outside = null; }
}

// ---------- 下载文件
export function download(name, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function deviceName() {
  const ua = navigator.userAgent;
  return /iPhone|iPad/.test(ua) ? 'iOS' : /HarmonyOS|OpenHarmony/.test(ua) ? '鸿蒙' : /Android/.test(ua) ? 'Android'
    : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : '浏览器';
}
