// room 注入文本的解析器 —— 纯函数, 无 IO。
//
// 守护进程唤醒一个 wizard 时贴进它输入框的是这样一段 (shared/room-hub 的 render):
//
//   【wezard-15 ↔ DavidPrice】(dm:w9506e9e4142d|wa4fcd5bff4eb) · 更早还有 3 条没列, 用 room_read 翻
//   [d2581c34.7] .DavidPrice (re d2581c34.2) [done]: 已完成, commit 90d4f04…
//   你要交代: d2581c34.7 (task, 来自 .wezard-15) —— 用 chat_reply({re, text, status}) 交代。
//
// 一次注入可以带多个 room 块 (块之间空一行), 每块可以有多行账本行。rolepage 要把它们
// 逐条拆回消息, 所以解析必须按原格式认出来 —— 认不出就整段放弃 (调用方按原文画),
// 绝不猜。账本行正文本身在注入里被压成一行并被截断, 所以显示时优先按行 id 回账本取全文。
//
// 这里只做「字 → 结构」。名字的解析 / 账本回查 / 渲染都在调用方 (shared/role-render)。

import { EXT_LABEL_PREFIX } from "./external.js";

export interface InjectLine {
  /** 账本行 id ([d2581c34.7])。 */
  id: string;
  /** 行里写的作者名 (原样, 可能带 .); "" = 这一行认不出作者。 */
  author: string;
  /** 显式给的去处 (→ 后的名字, 多个)。 */
  to: string[];
  /** 这一行答的那几行。 */
  re: string[];
  /** done / passed / canceled / need / progress / error / timeout。 */
  status?: string;
  /** 注入里带的正文 (已压成一行, 可能带 …(+N) 截断标记)。 */
  text: string;
  /** 正文尾部的附件名。 */
  files: string[];
}

export interface InjectBlock {
  /** 注入当时的 room 显示名 (【】里那一段)。 */
  label: string;
  /** room id —— 只有旧格式 (`【label】(roomId)`) 有; 新格式 (`【label】#hash8 标记`) 用 roomHash。 */
  room?: string;
  /** 新格式房头里的 8 位 room hash (反查 room 由调用方做, 这里保持纯函数)。 */
  roomHash?: string;
  /** 新格式房头里的出站等级标记: 群 / 单 / 私 / 临。 */
  mark?: string;
  /** 头一行后缀里的提醒 (上次投递不确定 / 更早还有 N 条)。 */
  notes: string[];
  lines: InjectLine[];
  /** 「你要交代: …」那一行点到的消息 id。 */
  owe: string[];
  /** 这一块的原文 (逐字, 用于「点开看注入原文」)。 */
  raw: string;
}

// 两种房头都要认: 新 `【label】#hash8 标记` (缺省格式), 旧 `【label】(roomId)` (存量转录回放)。
const HEAD_NEW_RE = /^【([^】\n]*)】#([0-9a-f]{8})(?: ([^\s·]+))?([^\n]*)$/;
const HEAD_OLD_RE = /^【([^】\n]*)】\(([^)\n]*)\)([^\n]*)$/;
const HEAD_RE = { test: (l: string): boolean => HEAD_NEW_RE.test(l) || HEAD_OLD_RE.test(l) };
const headOf = (line: string): { label: string; room?: string; roomHash?: string; mark?: string; suffix: string } | undefined => {
  const n = HEAD_NEW_RE.exec(line);
  if (n) return { label: n[1]!.trim(), roomHash: n[2]!, ...(n[3] ? { mark: n[3] } : {}), suffix: n[4]! };
  const o = HEAD_OLD_RE.exec(line);
  return o ? { label: o[1]!.trim(), room: o[2]!.trim(), suffix: o[3]! } : undefined;
};
const OWE_RE = /^你要交代:\s*(.*)$/;
const STATUSES = new Set(["done", "passed", "canceled", "need", "progress", "error", "timeout"]);

/** 头后缀 (「 · 上次投递不确定… · 更早还有 N 条…」) → 提醒列表。 */
const notesOf = (suffix: string): string[] =>
  suffix.split(" · ").map((s) => s.trim()).filter(Boolean);

/** 一行的前缀 = 作者 / 去处 / re / status; 正文从第一个 `]: ` 之后开始 (正文里再有也不影响)。 */
const parseLine = (line: string): InjectLine | undefined => {
  const cut = line.indexOf("] ");
  if (!line.startsWith("[") || cut < 0) return undefined;
  const id = line.slice(1, cut);
  const after = line.slice(cut + 2);
  const sep = after.indexOf(": ");
  if (sep < 0) return undefined;
  let rest = after.slice(0, sep);
  let status: string | undefined;
  const st = rest.match(/\s\[([a-z]+)\]$/);
  if (st && STATUSES.has(st[1]!)) { status = st[1]; rest = rest.slice(0, st.index).trimEnd(); }
  let re: string[] = [];
  const rm = rest.match(/\s\(re ([^)]*)\)$/);
  if (rm) { re = rm[1]!.split(",").map((s) => s.trim()).filter(Boolean); rest = rest.slice(0, rm.index).trimEnd(); }
  const arrow = rest.lastIndexOf(" → ");
  const author = arrow < 0 ? rest : rest.slice(0, arrow);
  const to = arrow < 0 ? [] : rest.slice(arrow + 3).split(",").map((s) => s.trim()).filter(Boolean);
  const text = after.slice(sep + 2);
  const fm = text.match(/\s📎([^\n]*)$/);
  const files = fm ? fm[1]!.split(",").map((s) => s.trim()).filter(Boolean) : [];
  return {
    id: id.trim(), author: author.trim(), to, re, ...(status ? { status } : {}),
    text: fm ? text.slice(0, fm.index).trimEnd() : text, files,
  };
};

/** 一个注入块的 room 全 id: 旧格式直接有; 新格式只有 hash, 反查由调用方注入 (shared 保持纯)。 */
export const blockRoom = (b: InjectBlock, roomOfHash?: (hash: string) => string | undefined): string =>
  b.room ?? (b.roomHash ? roomOfHash?.(b.roomHash) ?? "" : "");

const oweOf = (line: string): string[] | undefined => {
  const m = line.match(OWE_RE);
  if (!m) return undefined;
  const body = m[1]!.split("——")[0]!;
  return body.split(";").map((s) => s.trim().split(" (")[0]!.trim()).filter(Boolean);
};

/** 一段注入原文 → 若干 room 块。不是注入 (头一行不是【…】(…)) → undefined。 */
export const parseInjection = (raw: string): InjectBlock[] | undefined => {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const heads = lines.flatMap((l, i) => (HEAD_RE.test(l) ? [i] : []));
  if (!heads.length || heads[0] !== 0) return undefined;
  const blocks: InjectBlock[] = [];
  for (let h = 0; h < heads.length; h++) {
    const from = heads[h]!;
    const to = heads[h + 1] ?? lines.length;
    const own = lines.slice(from, to);
    const hd = headOf(own[0]!)!;
    const block: InjectBlock = {
      label: hd.label, ...(hd.room !== undefined ? { room: hd.room } : {}),
      ...(hd.roomHash ? { roomHash: hd.roomHash } : {}), ...(hd.mark ? { mark: hd.mark } : {}),
      notes: notesOf(hd.suffix), lines: [], owe: [], raw: own.join("\n").trimEnd(),
    };
    for (const l of own.slice(1)) {
      if (!l.trim()) continue;
      const owe = oweOf(l);
      if (owe) { block.owe = owe; continue; }
      const parsed = parseLine(l);
      if (parsed) block.lines.push(parsed);
    }
    blocks.push(block);
  }
  return blocks;
};

// 外部调用方 (ext:<名字>) 的标签是「外部·<名字>」—— 一个 daemon 作者, 不是人话。
const isHumanAuthor = (author: string): boolean =>
  !!author && !author.startsWith(".") && author !== "wezard" && !author.startsWith(EXT_LABEL_PREFIX);

/** 一次唤醒里这一轮是谁在哪开的口: 取「你要交代」点到的行里**最后一条人话行** (live 路径只看触发行, 同口径);
 *  有交代行、但点到的都不是人话 (如同伴 chat_ask 唤醒, 未读上下文里恰好有人对别人说的话) = undefined;
 *  根本没有交代行 (room_watch 订阅者没有 duty) 才回落到全部行里最后一条人话。没有人话行 = undefined。
 *  作者认形状: 行里 wizard 写作 `.名字`、daemon 写作 `wezard`, 其余就是人 (nameOf 对人渲染 userid)。
 *  人话信封删了之后, 重载接回这一轮的出处只剩这一处 —— 与 parseInjection 读同一个唤醒头 / 行头。 */
export const humanOpening = (raw: string): { room: string; roomHash?: string; mark?: string; speaker: string } | undefined => {
  const blocks = parseInjection(raw) ?? [];
  const lines = blocks.flatMap((b) => b.lines.map((l) => ({ block: b, line: l, owed: b.owe.includes(l.id) })));
  const pool = lines.some((x) => x.owed) ? lines.filter((x) => x.owed) : lines;
  const hit = pool.filter((x) => isHumanAuthor(x.line.author)).at(-1);
  if (!hit) return undefined;
  const b = hit.block;
  // 新格式只有 hash (反查在调用方, 见 daemon/turn-opening); 旧格式还是全 id。
  return {
    room: b.room ?? "#" + (b.roomHash ?? ""),
    ...(b.roomHash ? { roomHash: b.roomHash } : {}), ...(b.mark ? { mark: b.mark } : {}),
    speaker: hit.line.author,
  };
};
