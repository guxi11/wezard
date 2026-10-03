// 保温 ping 的识别 —— 一份, 给所有读者用。
// ping 是机器在给 prompt cache 续命, 不是对话: 空闲时钟、引用去重、peek/roster、
// rolepage 时间轴的折叠、关系图卡片的「最近一句」都得对「哪句算 ping」口径一致。
//
// 两种认法:
//   · 按配置认 (isKeepalivePingText + 签名) —— daemon 手里有配置
//   · 按形态认 (isKeepaliveShape) —— svr 没有配置, 历史记录里的 ping 也可能来自改过
//     的旧配置; 只收 `keepalive …` 与裸 `ping`

const normPing = (s: string): string => s.replace(/\s+/gu, "");

/** A sig at the cut length is a prefix of a longer ping; a shorter one IS the whole ping. */
const SIG_LEN = 40;

/** Normalized signature set of the configured ping forms — whitespace-stripped
 *  40-char prefixes, the same shape keepaliveTick feeds keepaliveStamps. */
export const keepalivePingSigs = (...pings: string[]): string[] =>
  pings.map((p) => normPing(p).slice(0, SIG_LEN)).filter((s) => s.length > 0);

/** Is this user-turn text a keepalive ping? Matches every configured form plus
 *  the bare "ping" legacy streak form still present in older transcripts.
 *  Anchored, never a substring: a ping configured as a short word would otherwise
 *  swallow every real line that merely contains it (no reply to the chat, no `from`
 *  on the rolepage). */
export const isKeepalivePingText = (text: string, sigs: readonly string[]): boolean => {
  const n = normPing(text);
  return n.toLowerCase() === "ping" ||
    sigs.some((sig) => sig.length > 0 && (sig.length < SIG_LEN ? n === sig : n.startsWith(sig)));
};

/** 不看配置、按形态认的 ping: `keepalive …` 或裸 `ping`。 */
export const isKeepaliveShape = (text: string | undefined): boolean => {
  const q = normPing(text ?? "").toLowerCase();
  return q === "ping" || q.startsWith("keepalive");
};

/** 一整轮 (问 + 答记在一条里) 是不是保温 ping —— 看开这一轮的那句问话。 */
export const isKeepaliveTurn = (r: { userQuery?: string }): boolean => isKeepaliveShape(r.userQuery);

/** 去掉保温轮次, 只留真话 —— 一轮一条的记录 (turn store) 用它。 */
export const withoutKeepaliveTurns = <T extends { userQuery?: string }>(rs: readonly T[]): T[] =>
  rs.filter((r) => !isKeepaliveTurn(r));

/** Keepalive = the ping query + everything the model says back until the next
 *  user turn — query-based, so a reply that adds more than "pong" still goes,
 *  and a backend that splits one reply across several records (CodeBuddy:
 *  mid-turn narration + final) loses all of them, not just the first. A window
 *  that opens on a bare "pong" lost its ping to the cut; that one goes too.
 *  一句一条的 transcript 用它; 一轮一条的记录用 withoutKeepaliveTurns。 */
export const withoutKeepalive = <T extends { role: string; text: string }>(
  turns: readonly T[],
  pingSigs: readonly string[],
): T[] =>
  turns.reduce<{ kept: T[]; ping: boolean }>(
    (acc, t) => {
      const ping = t.role === "user" ? isKeepalivePingText(t.text, pingSigs) : acc.ping;
      if (!ping) acc.kept.push(t);
      return { kept: acc.kept, ping };
    },
    { kept: [], ping: turns[0]?.role === "assistant" && /^pong\W*$/i.test(turns[0].text.trim()) },
  ).kept;
