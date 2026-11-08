// 可缩放时间轴（canvas）：滚轮/双指缩放，拖动平移，悬停查看，点击编辑。
import { startOfDay, addDays, startOfWeek, startOfMonth, addMonths, WEEK, fmtDur, fmtDateTime, fmtTime, DAY, HOUR } from './stats.js';

const MIN = 60e3;
const STEPS = [
  [MIN, 'm'], [5 * MIN, 'm'], [10 * MIN, 'm'], [15 * MIN, 'm'], [30 * MIN, 'm'],
  [HOUR, 'h'], [2 * HOUR, 'h'], [3 * HOUR, 'h'], [6 * HOUR, 'h'], [12 * HOUR, 'h'],
  [DAY, 'd'], [2 * DAY, 'd'], [7 * DAY, 'w'], [1, 'M'], [3, 'M'], [6, 'M'], [12, 'M'],
];

export class Timeline {
  constructor(canvas, { onHover, onClick } = {}) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    this.onHover = onHover || (() => {}); this.onClick = onClick || (() => {});
    this.rows = []; this.segs = []; this.t0 = 0; this.t1 = 1; this.bounds = [0, 1];
    this.pointers = new Map();
    this.rowH = 24; this.axisH = 38;
    this.bind();
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(canvas);
  }

  /** rows: [{key,name,color}]；segs: [{a,b,row,s}] */
  setData(rows, segs, from, to) {
    const keepView = this.bounds[0] === from && this.bounds[1] === to && this.t1 > this.t0;
    this.rows = rows; this.segs = segs; this.bounds = [from, to];
    if (!keepView) this.fit();
    this.draw();
  }
  fit() {
    const [from, to] = this.bounds;
    let lo = Infinity, hi = -Infinity;
    for (const s of this.segs) { lo = Math.min(lo, s.a); hi = Math.max(hi, s.b); }
    if (!isFinite(lo)) { lo = from; hi = Math.min(to, Date.now()); }
    const pad = Math.max((hi - lo) * 0.03, 10 * MIN);
    this.t0 = Math.max(from, lo - pad); this.t1 = Math.min(to, hi + pad);
    if (this.t1 - this.t0 < 30 * MIN) { const m = (this.t0 + this.t1) / 2; this.t0 = m - 15 * MIN; this.t1 = m + 15 * MIN; }
    this.draw();
  }
  showRange(a, b) { this.t0 = a; this.t1 = b; this.clamp(); this.draw(); }

  get labelW() { return this.c.clientWidth < 500 ? 76 : 120; }
  X(t) { const w = this.c.clientWidth - this.labelW - 8; return this.labelW + (t - this.t0) / (this.t1 - this.t0) * w; }
  T(x) { const w = this.c.clientWidth - this.labelW - 8; return this.t0 + (x - this.labelW) / w * (this.t1 - this.t0); }

  clamp() {
    const [from, to] = this.bounds;
    const maxSpan = Math.max((to - from) * 1.1, HOUR);
    let span = Math.min(Math.max(this.t1 - this.t0, 5 * MIN), maxSpan);
    let mid = (this.t0 + this.t1) / 2;
    mid = Math.min(Math.max(mid, from), to);
    this.t0 = mid - span / 2; this.t1 = mid + span / 2;
  }
  zoom(f, x) {
    const t = x == null ? (this.t0 + this.t1) / 2 : this.T(x);
    this.t0 = t - (t - this.t0) * f; this.t1 = t + (this.t1 - t) * f;
    this.clamp(); this.draw();
  }
  pan(dx) {
    const dt = dx / (this.c.clientWidth - this.labelW - 8) * (this.t1 - this.t0);
    this.t0 -= dt; this.t1 -= dt; this.clamp(); this.draw();
  }

  bind() {
    const c = this.c;
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) this.pan(-(e.deltaX || e.deltaY));
      else this.zoom(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - rect.left);
    }, { passive: false });
    c.addEventListener('pointerdown', e => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
      this.moved = false;
    });
    c.addEventListener('pointermove', e => {
      const rect = c.getBoundingClientRect();
      const p = this.pointers.get(e.pointerId);
      if (!p) { this.hover(e.clientX - rect.left, e.clientY - rect.top, e); return; }
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const before = Math.abs(a.x - b.x);
        p.x = e.clientX; p.y = e.clientY;
        const after = Math.abs(a.x - b.x);
        if (before > 10 && after > 10) this.zoom(before / after, (a.x + b.x) / 2 - rect.left);
        this.moved = true;
      } else {
        const dx = e.clientX - p.x;
        if (Math.abs(e.clientX - p.x0) > 4 || Math.abs(e.clientY - p.y0) > 4) this.moved = true;
        p.x = e.clientX; p.y = e.clientY;
        if (this.moved) { this.pan(dx); this.onHover(null); }
      }
    });
    const up = e => {
      const rect = c.getBoundingClientRect();
      const wasTap = this.pointers.size === 1 && !this.moved;
      this.pointers.delete(e.pointerId);
      if (wasTap) {
        const hit = this.hit(e.clientX - rect.left, e.clientY - rect.top);
        if (hit) { if (e.pointerType === 'mouse') this.onClick(hit); else this.onHover(hit, e.clientX, e.clientY, true); }
        else this.onHover(null);
      }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', e => this.pointers.delete(e.pointerId));
    c.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') this.onHover(null); });
    c.addEventListener('dblclick', e => { const r = c.getBoundingClientRect(); this.zoom(0.5, e.clientX - r.left); });
  }

  hit(x, y) {
    const row = Math.floor((y - this.axisH) / this.rowH);
    if (row < 0 || row >= this.rows.length || x < this.labelW) return null;
    let best = null, bd = 6;
    for (const s of this.segs) {
      if (s.row !== row) continue;
      const x0 = this.X(s.a), x1 = this.X(s.b);
      const d = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
      if (d < bd || (d === 0 && best && x1 - x0 < this.X(best.b) - this.X(best.a))) { bd = d; best = s; }
    }
    return best;
  }
  hover(x, y, e) {
    const h = this.hit(x, y);
    this.c.style.cursor = h ? 'pointer' : 'grab';
    this.onHover(h, e.clientX, e.clientY);
  }

  ticks() {
    const w = this.c.clientWidth - this.labelW - 8;
    const span = this.t1 - this.t0;
    let step = STEPS[STEPS.length - 1];
    for (const s of STEPS) {
      const ms = s[1] === 'M' ? s[0] * 30 * DAY : s[0];
      if (ms / span * w >= 64) { step = s; break; }
    }
    const [n, u] = step;
    const out = [];
    let t;
    if (u === 'M') { t = startOfMonth(this.t0); const m = new Date(t).getMonth(); t = addMonths(t, -(m % n)); }
    else if (u === 'w') t = startOfWeek(this.t0);
    else if (u === 'd') t = startOfDay(this.t0);
    else { const d0 = startOfDay(this.t0); t = d0 + Math.floor((this.t0 - d0) / n) * n; }
    for (let guard = 0; t <= this.t1 && guard < 500; guard++) {
      out.push(t);
      t = u === 'M' ? addMonths(t, n) : u === 'd' || u === 'w' ? addDays(t, n / DAY) : t + n;
      if (u === 'h' || u === 'm') { const d = startOfDay(t); if (d > out[out.length - 1] && t !== d && t - d < n) t = d; }
    }
    return { list: out, unit: u };
  }

  colors() {
    const cs = getComputedStyle(this.c);
    const v = n => cs.getPropertyValue(n).trim();
    return { text: v('--text-1'), text2: v('--text-2'), grid: v('--grid'), surface: v('--surface'), now: v('--warn'), band: v('--band') };
  }
  resolve(col, cs) {
    if (!col.startsWith('var(')) return col;
    return cs.getPropertyValue(col.slice(4, -1)).trim();
  }

  draw() {
    const c = this.c, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth;
    if (!W) return;
    const H = this.axisH + Math.max(1, this.rows.length) * this.rowH + 6;
    c.style.height = H + 'px';
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const col = this.colors(), cs = getComputedStyle(c);
    const L = this.labelW, R = W - 8;
    const fs = parseFloat(cs.getPropertyValue('--fs')) || 15;
    ctx.font = `${Math.round(fs * 0.8)}px ${cs.getPropertyValue('--font') || 'system-ui, sans-serif'}`;
    this.rowH = Math.max(24, Math.round(fs * 1.6));
    ctx.textBaseline = 'middle';

    // 行背景与名称
    this.rows.forEach((r, i) => {
      const y = this.axisH + i * this.rowH;
      if (i % 2 === 0) { ctx.fillStyle = col.band; ctx.fillRect(L, y, R - L, this.rowH); }
      ctx.fillStyle = this.resolve(r.color, cs);
      ctx.beginPath(); ctx.arc(8, y + this.rowH / 2, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col.text;
      let name = r.name;
      while (ctx.measureText(name).width > L - 22 && name.length > 1) name = name.slice(0, -2) + '…';
      ctx.fillText(name, 16, y + this.rowH / 2);
    });

    // 刻度
    const { list, unit } = this.ticks();
    ctx.save(); ctx.beginPath(); ctx.rect(L, 0, R - L, H); ctx.clip();
    ctx.textAlign = 'left';
    let lastMajor = null;
    for (const t of list) {
      const x = this.X(t);
      const d = new Date(t);
      const major = unit === 'M' ? d.getMonth() === 0 : (unit === 'd' || unit === 'w') ? d.getDate() === 1 : t === startOfDay(t);
      ctx.strokeStyle = col.grid; ctx.lineWidth = major ? 1.2 : 0.6;
      ctx.beginPath(); ctx.moveTo(x + 0.5, major ? 4 : 20); ctx.lineTo(x + 0.5, H - 4); ctx.stroke();
      ctx.fillStyle = col.text2;
      let minor;
      if (unit === 'm' || unit === 'h') minor = fmtTime(t);
      else if (unit === 'd' || unit === 'w') minor = `${d.getMonth() + 1}/${d.getDate()}`;
      else minor = `${d.getMonth() + 1}月`;
      ctx.fillText(minor, x + 3, 28);
      if (major || lastMajor == null) {
        let lab = unit === 'M' ? `${d.getFullYear()}年` : (unit === 'd' || unit === 'w') ? `${d.getFullYear()}年${d.getMonth() + 1}月`
          : `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[(d.getDay() + 6) % 7]}`;
        ctx.fillStyle = col.text; ctx.fillText(lab, Math.max(L + 2, x + 3), 11);
        lastMajor = t;
      }
    }

    // 记录条
    const rh = this.rowH - 8;
    for (const s of this.segs) {
      if (s.b < this.t0 || s.a > this.t1) continue;
      const x0 = Math.max(L - 2, this.X(s.a)), x1 = Math.min(R + 2, this.X(s.b));
      const y = this.axisH + s.row * this.rowH + 4;
      ctx.fillStyle = this.resolve(this.rows[s.row].color, cs);
      ctx.globalAlpha = s.s && s.s.end == null ? 0.55 : 1;
      const w = Math.max(1.5, x1 - x0);
      const r = Math.min(3, w / 2);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x0, y, w, rh, r); else ctx.rect(x0, y, w, rh);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (w > 60 && s.s) {
        ctx.fillStyle = '#fff';
        const label = fmtDur((s.b - s.a) / 1000, true);
        if (ctx.measureText(label).width < w - 8) ctx.fillText(label, x0 + 4, y + rh / 2);
      }
    }
    // 当前时间线
    const nx = this.X(Date.now());
    if (nx > L && nx < R) { ctx.strokeStyle = col.now; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(nx, 14); ctx.lineTo(nx, H - 4); ctx.stroke(); }
    ctx.restore();
  }
}

export function segTip(seg, taskName) {
  const s = seg.s;
  const end = s.end == null ? '计时中' : fmtDateTime(s.end);
  return `${taskName}\n${fmtDateTime(s.start)} → ${end}\n时长 ${fmtDur(((s.end ?? Date.now()) - s.start) / 1000, true)}` + (s.note ? `\n${s.note}` : '');
}
