// 没起名的 room 怎么显示: 一律用成员名 —— 不再有「私聊」「临时 room」这种认不出是哪件事的兜底。
// 起了名 (host 的 room_name / room_open 的 title) 永远优先, 这里只管「没名字」的那一档。
// web/chat.js 的 memberNames 与它同口径 (静态页不能 import ts): 改一处要改两处。

/** 两位 `A ↔ B`; 三位 `A·B·C`; 更多 `A·B·C 等N人`; 一位只有名字; 没有成员给空串 (调用方再退回短代号)。 */
export const memberLabel = (names: readonly string[]): string => {
  const ns = names.filter(Boolean);
  if (ns.length <= 1) return ns[0] ?? "";
  if (ns.length === 2) return ns.join(" ↔ ");
  return ns.slice(0, 3).join("·") + (ns.length > 3 ? ` 等${ns.length}人` : "");
};
