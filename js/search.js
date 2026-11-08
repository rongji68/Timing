// 搜索语法：不区分大小写。
//   与（同时包含）：空格、&、+      或（包含其一）：逗号、|、/
//   “与”优先：例 “NSFC 修改 / 评审” = (含 NSFC 且含 修改) 或 (含 评审)
// 中英文符号均可（，＆＋｜／；）。
export function parseQuery(q) {
  const groups = String(q || '').toLowerCase().split(/[,，;；|｜/／]/)
    .map(g => g.trim().split(/[\s&＆+＋]+/).filter(Boolean)).filter(g => g.length);
  return groups.length ? groups : null;
}

/** 返回判断函数 text => boolean；查询为空时返回 null（表示不过滤） */
export function matcher(q) {
  const groups = parseQuery(q);
  if (!groups) return null;
  return text => {
    const t = String(text || '').toLowerCase();
    return groups.some(and => and.every(w => t.includes(w)));
  };
}

export const SEARCH_HELP = '同时包含：空格、&、+；包含其一：逗号、|、/。例：“NSFC 修改 / 评审”';
export const SEARCH_PLACEHOLDER = '搜索（空格 & + = 与；逗号 | / = 或）';
