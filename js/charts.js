// SVG 图表（无第三方库）。颜色用 CSS 变量，深浅色模式自动切换。
import { fmtHours, fmtDur, fmtDate, WEEK, DAY } from './stats.js';

export const OTHER = '__other__';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export { esc };

/** 最多 8 个颜色；超过 8 组时取前 7 组 + “其他” */
export function palette(groups) {
  const top = groups.length > 8 ? groups.slice(0, 7) : groups.slice(0, 8);
  const map = new Map(top.map((g, i) => [g.key, `var(--s${i + 1})`]));
  const color = key => map.get(key) || 'var(--s-other)';
  const folded = groups.length > 8
    ? [...top, { key: OTHER, name: `其他（${groups.length - 7} 项）`, secs: groups.slice(7).reduce((a, g) => a + g.secs, 0),
      count: groups.slice(7).reduce((a, g) => a + g.count, 0) }]
    : top;
  return { color, folded, topKeys: new Set(top.map(g => g.key)) };
}

function pct(x, total) { return total > 0 ? (x / total * 100) : 0; }
function fmtPct(p) { return p >= 10 ? p.toFixed(0) + '%' : p.toFixed(1) + '%'; }

// ---------- 环形图 + 图例
export function donut(st, pal) {
  const total = st.total;
  const R = 80, r = 52, cx = 100, cy = 100;
  let a0 = -Math.PI / 2;
  const arcs = [];
  if (total <= 0) {
    arcs.push(`<circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" style="fill:none;stroke:var(--grid);stroke-width:${R - r}"/>`);
  }
  for (const g of pal.folded) {
    if (total <= 0) break;
    const frac = g.secs / total;
    if (frac <= 0) continue;
    const gap = pal.folded.length > 1 ? 0.012 : 0;
    const a1 = a0 + frac * Math.PI * 2;
    const s = a0 + gap / 2, e = Math.max(s + 0.001, a1 - gap / 2);
    const large = e - s > Math.PI ? 1 : 0;
    const P = (rad, ang) => `${(cx + rad * Math.cos(ang)).toFixed(2)},${(cy + rad * Math.sin(ang)).toFixed(2)}`;
    const d = frac >= 0.9999
      ? `M${P(R, 0)}A${R},${R} 0 1 1 ${P(R, Math.PI)}A${R},${R} 0 1 1 ${P(R, 0)}M${P(r, 0)}A${r},${r} 0 1 0 ${P(r, Math.PI)}A${r},${r} 0 1 0 ${P(r, 0)}Z`
      : `M${P(R, s)}A${R},${R} 0 ${large} 1 ${P(R, e)}L${P(r, e)}A${r},${r} 0 ${large} 0 ${P(r, s)}Z`;
    arcs.push(`<path d="${d}" fill-rule="evenodd" style="fill:${pal.color(g.key)}" class="hov"
      data-tip="${esc(g.name)}&#10;${fmtDur(g.secs, true)} · ${fmtPct(pct(g.secs, total))}"/>`);
    a0 = a1;
  }
  const svg = `<svg viewBox="0 0 200 200" class="donut" role="img" aria-label="用时占比">
    ${arcs.join('')}
    <text x="100" y="96" text-anchor="middle" class="donut-big" style="font-size:${fmtDur(total).length > 8 ? 17 : 21}px">${fmtDur(total)}</text>
    <text x="100" y="116" text-anchor="middle" class="donut-small">时:分:秒</text></svg>`;
  const legend = pal.folded.map(g => `<li><i style="background:${pal.color(g.key)}"></i>
    <span class="lg-name">${esc(g.name)}</span><span class="lg-val">${fmtDur(g.secs)}</span>
    <span class="lg-pct">${fmtPct(pct(g.secs, total))}</span></li>`).join('');
  return `<div class="donut-wrap">${svg}<ul class="legend">${legend || '<li class="muted">暂无数据</li>'}</ul></div>`;
}

// ---------- 排行（同时也是“表格视图”，列出全部分组）
export function ranking(st, pal, { onClickAttr = '' } = {}) {
  const max = st.groups[0]?.secs || 1;
  const rows = st.groups.map(g => `<tr ${onClickAttr ? `data-${onClickAttr}="${esc(g.key)}"` : ''}>
    <td class="rk-name"><i style="background:${pal.color(g.key)}"></i>${esc(g.name)}</td>
    <td class="rk-bar"><div style="width:${(g.secs / max * 100).toFixed(1)}%;background:${pal.color(g.key)}"></div></td>
    <td class="num">${fmtDur(g.secs)}</td><td class="num">${fmtPct(pct(g.secs, st.total))}</td>
    <td class="num">${g.count}</td><td class="num">${fmtDur(g.secs / Math.max(1, g.count), true)}</td></tr>`).join('');
  return `<table class="rank"><thead><tr><th>名称</th><th></th><th class="num">时长</th><th class="num">占比</th>
    <th class="num">次数</th><th class="num">平均时长</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="muted">暂无数据</td></tr>'}</tbody></table>`;
}

// ---------- 坐标轴刻度
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
function bucketLabel(t, gran) {
  const d = new Date(t);
  if (gran === 'month') return `${d.getFullYear() % 100}/${d.getMonth() + 1}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function bucketTitle(t, gran) {
  if (gran === 'day') return fmtDate(t) + ' 周' + WEEK[(new Date(t).getDay() + 6) % 7];
  if (gran === 'week') return fmtDate(t) + ' 起一周';
  const d = new Date(t); return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}

// ---------- 堆叠柱状图：每天/周/月的用时分配
export function stacked(st, pal, width = 720) {
  const keys = st.bucketKeys;
  const H = 230, padL = 36, padB = 26, padT = 22;
  const W = Math.max(width, 200);
  const innerW = W - padL - 8, innerH = H - padB - padT;
  const totals = keys.map(k => { const m = st.buckets.get(k); let s = 0; if (m) for (const v of m.values()) s += v; return s; });
  const rawMax = Math.max(...totals, 0) / 3600;
  const useMin = rawMax > 0 && rawMax < 1;                 // 不到 1 小时改用分钟作单位
  const U = useMin ? 60 : 3600;
  const maxH = niceMax(Math.max(...totals, 0) / U);
  const bw = innerW / Math.max(1, keys.length);
  const barW = Math.max(1, Math.min(36, bw - 2));
  const y = h => padT + innerH - h / maxH * innerH;
  let out = '';
  for (let i = 0; i <= 4; i++) {
    const v = maxH * i / 4, yy = y(v);
    out += `<line x1="${padL}" x2="${W - 8}" y1="${yy}" y2="${yy}" class="grid"/>
      <text x="${padL - 4}" y="${yy + 4}" text-anchor="end" class="axis">${+v.toFixed(2)}</text>`;
  }
  const labelEvery = Math.ceil(keys.length / Math.max(1, Math.floor(innerW / 44)));
  keys.forEach((k, i) => {
    const m = st.buckets.get(k);
    const x = padL + i * bw + (bw - barW) / 2;
    let acc = 0;
    const order = [...pal.folded.map(g => g.key)];
    const parts = [];
    if (m) {
      const other = [...m.entries()].filter(([kk]) => !pal.topKeys.has(kk)).reduce((a, [, v]) => a + v, 0);
      for (const key of order) {
        const v = key === '__other__' ? other : (m.get(key) || 0);
        if (v > 0) parts.push([key, v]);
      }
    }
    const tipLines = parts.map(([key, v]) => `${(pal.folded.find(g => g.key === key) || {}).name}: ${fmtDur(v, true)}`);
    const tip = esc(`${bucketTitle(k, st.gran)}  合计 ${fmtDur(totals[i], true)}\n` + tipLines.join('\n'));
    parts.forEach(([key, v], j) => {
      const h0 = acc / U, h1 = (acc + v) / U;
      acc += v;
      const top = y(h1), bot = y(h0);
      const hh = Math.max(0, bot - top - (j < parts.length - 1 ? 1.5 : 0));
      const rx = j === parts.length - 1 ? Math.min(3, barW / 2, hh / 2) : 0;
      out += `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${hh.toFixed(1)}" rx="${rx}"
        style="fill:${pal.color(key === '__other__' ? '' : key)}"/>`;
    });
    out += `<rect x="${(padL + i * bw).toFixed(1)}" y="${padT}" width="${bw.toFixed(1)}" height="${innerH}" class="hit" data-tip="${tip}"/>`;
    if (i % labelEvery === 0) out += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="axis">${bucketLabel(k, st.gran)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="用时分配">
    <text x="4" y="11" class="axis">${useMin ? '分钟' : '小时'}</text>${out}</svg>`;
}

// ---------- 一天 24 小时的时段分布
export function hourly(st, width = 720) {
  const H = 190, padL = 36, padB = 24, padT = 22, W = Math.max(width, 200);
  const innerW = W - padL - 8, innerH = H - padB - padT;
  const daysN = Math.max(1, st.days);
  const vals = st.hourly.map(v => v / 3600 / daysN * 60);       // 平均每天该小时内的分钟数
  const maxV = niceMax(Math.max(...vals, 0));
  const bw = innerW / 24, barW = Math.max(2, bw - 3);
  const y = v => padT + innerH - v / maxV * innerH;
  let out = '';
  for (let i = 0; i <= 4; i++) {
    const v = maxV * i / 4, yy = y(v);
    out += `<line x1="${padL}" x2="${W - 8}" y1="${yy}" y2="${yy}" class="grid"/><text x="${padL - 4}" y="${yy + 4}" text-anchor="end" class="axis">${+v.toFixed(0)}</text>`;
  }
  vals.forEach((v, h) => {
    const x = padL + h * bw + (bw - barW) / 2, top = y(v), hh = Math.max(0, padT + innerH - top);
    out += `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${hh.toFixed(1)}" rx="${Math.min(3, hh / 2, barW / 2)}" style="fill:var(--s1)"/>
      <rect x="${(padL + h * bw).toFixed(1)}" y="${padT}" width="${bw.toFixed(1)}" height="${innerH}" class="hit"
      data-tip="${h}:00–${h + 1}:00&#10;平均每天 ${v.toFixed(1)} 分钟&#10;合计 ${fmtDur(st.hourly[h], true)}"/>`;
    if (h % 3 === 0) out += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 7}" text-anchor="middle" class="axis">${h}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="时段分布">
    <text x="4" y="11" class="axis">分钟/天</text>${out}</svg>`;
}

// ---------- 星期 × 小时 热力图
export function heatmap(st, width = 720) {
  const padL = 30, padT = 6, padB = 20, W = Math.max(width, 260);
  const cw = (W - padL - 4) / 24, ch = Math.min(26, Math.max(14, cw * 0.9));
  const H = padT + ch * 7 + padB;
  const weeks = Math.max(1, st.days / 7);
  let max = 0;
  for (const row of st.heat) for (const v of row) max = Math.max(max, v);
  let out = '';
  st.heat.forEach((row, wd) => {
    out += `<text x="${padL - 6}" y="${padT + wd * ch + ch / 2 + 4}" text-anchor="end" class="axis">${WEEK[wd]}</text>`;
    row.forEach((v, h) => {
      const lvl = max > 0 ? Math.min(8, Math.ceil(v / max * 8)) : 0;
      out += `<rect x="${(padL + h * cw + 1).toFixed(1)}" y="${(padT + wd * ch + 1).toFixed(1)}" width="${(cw - 2).toFixed(1)}" height="${(ch - 2).toFixed(1)}" rx="3"
        style="fill:var(--q${lvl})" class="hov" data-tip="周${WEEK[wd]} ${h}:00–${h + 1}:00&#10;平均每周 ${(v / 60 / weeks).toFixed(0)} 分钟&#10;合计 ${fmtDur(v, true)}"/>`;
    });
  });
  for (let h = 0; h < 24; h += 3) out += `<text x="${(padL + h * cw + cw / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle" class="axis">${h}</text>`;
  const scale = `<div class="heat-scale"><span>少</span>${[1, 2, 3, 4, 5, 6, 7, 8].map(i => `<i style="background:var(--q${i})"></i>`).join('')}<span>多</span></div>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="星期与时段分布">${out}</svg>${scale}`;
}

// ---------- 对比折线图：每个分组一条线（多事务对比）
export function lines(st, pal, width = 720) {
  const keys = st.bucketKeys;
  const H = 230, padL = 36, padB = 26, padT = 22, W = Math.max(width, 200);
  const innerW = W - padL - 12, innerH = H - padB - padT;
  const series = pal.folded.map(g => ({ g, vals: keys.map(k => {
    const m = st.buckets.get(k); if (!m) return 0;
    if (g.key === OTHER) { let s = 0; for (const [kk, v] of m) if (!pal.topKeys.has(kk)) s += v; return s; }
    return m.get(g.key) || 0;
  }) }));
  let maxV = 0;
  for (const s of series) for (const v of s.vals) maxV = Math.max(maxV, v / 3600);
  const useMin = maxV > 0 && maxV < 1, U = useMin ? 60 : 3600;
  maxV = niceMax(useMin ? maxV * 60 : maxV);
  const step = keys.length > 1 ? innerW / (keys.length - 1) : 0;
  const X = i => padL + (keys.length > 1 ? i * step : innerW / 2);
  const Y = v => padT + innerH - v / U / maxV * innerH;
  let out = '';
  for (let i = 0; i <= 4; i++) {
    const v = maxV * i / 4, yy = padT + innerH - v / maxV * innerH;
    out += `<line x1="${padL}" x2="${W - 8}" y1="${yy}" y2="${yy}" class="grid"/><text x="${padL - 4}" y="${yy + 4}" text-anchor="end" class="axis">${+v.toFixed(2)}</text>`;
  }
  const markers = keys.length <= 45;
  for (const s of [...series].reverse()) {
    const col = pal.color(s.g.key === OTHER ? '' : s.g.key);
    const pts = s.vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    out += `<polyline points="${pts}" style="fill:none;stroke:${col};stroke-width:2;stroke-linejoin:round;stroke-linecap:round"/>`;
    if (markers) out += s.vals.map((v, i) => v > 0 ? `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="3.5" style="fill:${col};stroke:var(--surface);stroke-width:1.5"/>` : '').join('');
  }
  const labelEvery = Math.ceil(keys.length / Math.max(1, Math.floor(innerW / 44)));
  const bw = keys.length > 1 ? step : innerW;
  keys.forEach((k, i) => {
    const lines = series.filter(s => s.vals[i] > 0).sort((a, b) => b.vals[i] - a.vals[i]).map(s => `${s.g.name}: ${fmtDur(s.vals[i], true)}`);
    const tip = esc(bucketTitle(k, st.gran) + '\n' + (lines.join('\n') || '无记录'));
    out += `<rect x="${(X(i) - bw / 2).toFixed(1)}" y="${padT}" width="${bw.toFixed(1)}" height="${innerH}" class="hit" data-tip="${tip}"/>`;
    if (i % labelEvery === 0) out += `<text x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="axis">${bucketLabel(k, st.gran)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="对比折线"><text x="4" y="11" class="axis">${useMin ? '分钟' : '小时'}</text>${out}</svg>`;
}
