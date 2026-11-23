// wizard 时间轴的分页: 服务端只回最近一页, 往前翻按游标 (ts) 取。
//
// 为什么要有它: 时间轴 = 视野 (3 天) 内该 role 的全部轮次, 内联过程框 html, 一个话多的 wizard 是 500+ 行 / 1.7MB;
// 切视角时整包下载、整包 innerHTML (23k 个 DOM 节点, 一次强制布局 1s+), 轮询还每 4s 重取一遍。
// 页面首屏只要最近那一页, 其余在「‹ 更早」里按需取。

/** 一页多少行 (一行 = 一条入消息 / 一轮出消息 / 一条账本行 / 一个时代标记)。 */
export const STREAM_PAGE = 40;

export interface StreamPage<T> {
  rows: T[];
  /** 还有更早的行时 = 本页第一行的 ts, 下一页用它做 `before` (严格小于); 没有更早的 = undefined。 */
  earlier?: number;
}

/**
 * 取 `before` (不含) 之前、最近的 `limit` 行; rows 须按 ts 升序。limit ≤ 0 = 不分页, 全给。
 * 同 ts 的行绝不跨页: 游标是「ts < before」, 若一页的边界切在一组同 ts 的行中间, 那些行下一页就取不到了 —— 起点往前挪到这组的头。
 */
export const streamPage = <T extends { ts: number }>(rows: readonly T[], o: { before?: number; limit?: number } = {}): StreamPage<T> => {
  const pool = o.before === undefined ? rows : rows.filter((r) => r.ts < o.before!);
  const limit = o.limit ?? STREAM_PAGE;
  if (limit <= 0 || pool.length <= limit) return { rows: [...pool] };
  const start = Array.from({ length: pool.length - limit }, (_, i) => pool.length - limit - i)
    .find((s) => s === 0 || pool[s - 1]!.ts !== pool[s]!.ts) ?? 0;
  const page = pool.slice(start);
  return start > 0 ? { rows: page, earlier: page[0]!.ts } : { rows: page };
};
