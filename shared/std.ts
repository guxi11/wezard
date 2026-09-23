// Primitives small enough that every module was re-deriving its own copy.
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Cut at `max` chars, marking the cut with an ellipsis. */
export const truncate = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max)}…`);

/** Same, but says how much was dropped — for tails a reader may want to chase. */
export const truncateWithCount = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}…(+${s.length - max})`;

/** Flatten to a single line first — for text going into a one-line bubble. */
export const clipLine = (s: string, max: number): string => truncate(s.replace(/\s+/g, " ").trim(), max);

/** `Promise.all(xs.map(f))` 但同时在飞的不超过 `limit` 个。
 *
 *  存在的理由是一次真实事故: 一个 `Promise.all` 铺在几百个 target 上, 每个各自
 *  spawn 两次 tmux —— 七百个并发子进程瞬间打穿 fd 上限, tmux server 被拖垮,
 *  守护进程随后崩进重启循环 (同 CLAUDE.md 记的 launchd fd 那一条)。凡是 f 会
 *  spawn 进程或开文件的, 就不该用裸 Promise.all。
 *  结果顺序与输入一致。 */
export const mapLimit = async <T, R>(
  xs: readonly T[],
  limit: number,
  f: (x: T, i: number) => Promise<R>,
): Promise<R[]> => {
  const out = new Array<R>(xs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < xs.length; i = next++) out[i] = await f(xs[i]!, i);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, xs.length)) }, worker));
  return out;
};

/** Substitute `{{…}}` refs from a context map. Unknown keys are left verbatim —
 *  a prompt legitimately containing `{{foo}}` shouldn't be silently emptied. */
export const interpolate = (
  template: string,
  ctx: Readonly<Record<string, string>>,
): string =>
  template.replace(/\{\{\s*#?([\p{L}\p{N}_-]+)\s*\}\}/gu, (whole, key: string) =>
    key in ctx ? ctx[key]! : whole,
  );
