// 群消息「艾特了别人」的判定 (纯函数, 入站在消息进任何 room / monitor 之前用)。
//
// 目标: 消息里有 @, 但没有一个是冲着本机器人的, 剩下的 @ 又确实是在叫人 (不是文件路径 / 资源)
// → 这句话是说给别人的, wezard 不接。判定与 inbound 的 stripAt / atBot 刻意分开: 那两个靠
// 「群里第一个不像文件的 @token 就当机器人名」, 而这里要回答的恰恰是「这个 token 是不是本机器人」,
// 只能拿已知的机器人名 (`wrc.botNames` + 内置 wezard) 比 —— 机器人名未知时调用方不该拦 (fail-open)。
//
// 一个 `@` 算「叫人」要同时满足:
//   ① 前一个字符不是邮箱 / URL 的组成字符 `[A-Za-z0-9_.%+\-/\\:=?&#~]` —— `a@b.com`、`git@host`、
//      `https://medium.com/@user`、`?u=@x` 都不是艾特。CJK 紧贴 (`你好@张三`) 和 `(@张三)` 算艾特。
//   ② 所在的整词 (按空白切) 不是 `scheme://…` 的 URL。
//   ③ token (`@` 之后到空白 / 下一个 `@` 为止, 去掉尾部标点) 非空, 且不是资源:
//        - 含 `/` 或 `\` (`@src/foo.ts`、`@a/b`、npm scope `@types/node`)
//        - 以扩展名结尾 `.xxx` (1~8 个字母数字: `@foo.ts`、`@README.md`、`@.env`、`@bob.com`)
//      边界假设: 带点的真人名 (`@john.smith`) 会被当成文件 → 不拦 (宁可放过, 不误杀); 机器人 /
//      群成员名里没有点与斜杠。
//   ④ 「全员」(`@all` / `@everyone` / `@here` / `@所有人`) 也冲着本机器人, 当作艾特了机器人。
// 艾特本机器人 = token 以某个机器人名开头, 且其后不是名字字符 (中文紧贴 `@wezard请看` 仍认, `@wezardx` 不认)。

const NAME_CHAR = /[A-Za-z0-9_]/u;
const BEFORE_BLOCK = /[A-Za-z0-9_.%+\-/\\:=?&#~]/u;
const URL_WORD = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
const TRAIL_PUNCT = /[\s,.;:!?)\]}>'"，。；：！？、）】》」』”’…]+$/u;
const EXT_SHAPE = /\.[A-Za-z0-9]{1,8}$/u;
const EVERYONE = new Set(["all", "everyone", "here", "所有人"]);

/** token 是文件路径 / 包名 / 域名这类资源。 */
export const looksLikeResource = (token: string): boolean => /[/\\]/u.test(token) || EXT_SHAPE.test(token);

/** 正文里每个「像在叫人」的 @token (已去尾标点, 未剔资源)。 */
const atTokens = (text: string): string[] =>
  text.split(/\s+/u).filter((w) => w && !URL_WORD.test(w)).flatMap((w) =>
    [...w.matchAll(/@/gu)]
      .filter((m) => !((m.index ?? 0) > 0 && BEFORE_BLOCK.test(w[(m.index ?? 0) - 1] ?? "")))
      .map((m) => (w.slice((m.index ?? 0) + 1).split("@")[0] ?? "").replace(TRAIL_PUNCT, ""))
      .filter(Boolean));

const isBot = (botNames: readonly string[], token: string): boolean =>
  EVERYONE.has(token.toLowerCase()) ||
  botNames.some((n) => {
    const name = n.toLowerCase();
    const t = token.toLowerCase();
    return !!name && t.startsWith(name) && !(NAME_CHAR.test(name.at(-1) ?? "") && NAME_CHAR.test(t[name.length] ?? ""));
  });

/** 这句话里「叫的是别人」的 @ 名字: 有艾特本机器人 → 空 (放行); 否则 = 剔掉资源后剩下的 @token。 */
export const mentionedOthers = (botNames: readonly string[], text: string): string[] => {
  const tokens = atTokens(text);
  return tokens.some((t) => isBot(botNames, t)) ? [] : tokens.filter((t) => !looksLikeResource(t));
};

/** 这句话是说给别人的 (有人被艾特, 且没有一个是本机器人)。 */
export const addressesOthers = (botNames: readonly string[], text: string): boolean => mentionedOthers(botNames, text).length > 0;
