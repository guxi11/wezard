// Wizard: 给「绑定到聊天的会话」一个身份。
//
// 在这之前, 一个会话只是 `chat:wrkS…#tag` 这么一个路由 key —— 它不知道自己叫
// 什么、为什么存在、谁生的它、群里还有谁。于是每次协作都要人在提示词里重讲一遍。
// wizard 把这些沉到一条记录里, 并在 spawn 时以 `--append-system-prompt` 的形式
// 写进那个进程的上下文: 身份不是聊天历史里的一句话 (会被 /clear 抹掉、会被挤出
// 窗口), 而是随进程终身存在的前缀。
//
//   wizard   = target(一个聊天里的一个会话) + 名字 + 职责 + 记忆 + 家谱
//   clone    = parent 非空的 wizard; fork 了父亲的会话, 开局就带着父亲读过的东西
//   记忆      = 自己写下的短句, 每次 (重)spawn 都重新进上下文 —— 跨 /clear 的东西
//
// 本模块只有两类东西: 一个写盘的注册表 (唯一副作用), 和一堆把记录渲染成文字的
// 纯函数。真正的动作 (spawn / inject / kill) 全在 mirror-bridge, 这里一个都不做。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expandHome } from "../shared/paths.js";
import { tagOfKey } from "../shared/session-label.js";

export interface WizardRecord {
  /** 会话 key, 即身份本身: `chat:xxx` 或 `chat:xxx#tag`。 */
  target: string;
  /** 自己起的名字; "" = 用聊天名/tag 推导。 */
  name: string;
  /** 一句话职责 —— 别的 wizard 靠它决定该不该找你。 */
  description: string;
  /** 生它的 wizard 的 target。有值 = 它是个 clone。 */
  parent?: string;
  /** fork 自哪个 sessionId ("" / 缺省 = 开局是空白会话, 没继承上下文)。 */
  clonedFrom?: string;
  bornAt: number;
  /** 自己写下的长期记忆, 每次 spawn 重新注入上下文。 */
  memory: string[];
}

export interface WizardStore {
  get: (target: string) => WizardRecord | undefined;
  upsert: (target: string, patch: Partial<Omit<WizardRecord, "target">>) => WizardRecord;
  drop: (target: string) => void;
  all: () => WizardRecord[];
}

const MEMORY_MAX = 60;
const NOTE_MAX = 600;

const blank = (target: string): WizardRecord => ({ target, name: "", description: "", bornAt: Date.now(), memory: [] });

/** 写穿式单文件存储, 与 mirror-store 同款 —— 这是运行时状态, 不是用户手写配置,
 *  所以躺在 stateDir 而不是 config.jsonc。 */
export const loadWizardStore = (filePath: string): WizardStore => {
  const abs = expandHome(filePath);
  let map: Record<string, WizardRecord> = {};
  if (existsSync(abs)) {
    try { map = JSON.parse(readFileSync(abs, "utf8")) as Record<string, WizardRecord>; } catch { map = {}; }
  } else {
    mkdirSync(dirname(abs), { recursive: true });
  }
  const persist = (): void => {
    try { writeFileSync(abs, JSON.stringify(map, null, 2), "utf8"); } catch { /* 记忆丢了也不该拖垮会话 */ }
  };
  return {
    get: (t) => map[t],
    upsert: (t, patch) => {
      const next: WizardRecord = { ...(map[t] ?? blank(t)), ...patch, target: t };
      next.memory = next.memory.slice(-MEMORY_MAX).map((m) => m.slice(0, NOTE_MAX));
      map[t] = next;
      persist();
      return next;
    },
    drop: (t) => { delete map[t]; persist(); },
    all: () => Object.values(map),
  };
};

// 进程内唯一的注册表。daemon 启动时绑一次, 之后任何模块都读得到 —— IM 侧的
// `/peers` 要把名字和职责印在每一行上, 为此给 installInboundRouter 再加一个参数
// 不值当 (同 bindCliBackends 的取舍)。headless 模式不绑, 读到 undefined 即退化。
let bound: WizardStore | undefined;
export const bindWizardStore = (store: WizardStore): WizardStore => (bound = store);
export const wizardStore = (): WizardStore | undefined => bound;

// ── 纯推导 ────────────────────────────────────────────────────────────
/** 名字: 自己起的 > 聊天名 (+`#tag`) > 裸 tag > ""。
 *  需求是「wizard 的名字就是 chat 的名字」—— 一个聊天里的多个会话靠 `#tag` 区分,
 *  所以带 tag 的分身名字是 `chatName#tag`, 读起来正好就是它的地址。 */
export const wizardName = (rec: WizardRecord | undefined, chatName: string, target: string): string => {
  const explicit = (rec?.name ?? "").trim();
  if (explicit) return explicit;
  const tag = tagOfKey(target);
  if (chatName) return tag ? `${chatName}#${tag}` : chatName;
  return tag;
};

/** 直系分身。 */
export const childrenOf = (all: readonly WizardRecord[], target: string): WizardRecord[] =>
  all.filter((w) => w.parent === target);

/** 祖先链, 从父亲到最老的那个 (环路自动截断 —— 记录是外部可编辑的 json)。 */
export const ancestorsOf = (all: readonly WizardRecord[], target: string): string[] => {
  const byTarget = new Map(all.map((w) => [w.target, w] as const));
  const walk = (t: string | undefined, seen: readonly string[]): string[] =>
    !t || seen.includes(t) ? [...seen] : walk(byTarget.get(t)?.parent, [...seen, t]);
  return walk(byTarget.get(target)?.parent, []);
};

const bullet = (xs: readonly string[]): string => xs.map((x) => `- ${x}`).join("\n");

export interface WizardBrief {
  name: string;
  /** 别人叫得到它的字符串 (send_peer 的 `tag` 入参)。 */
  address: string;
  description: string;
  cwd: string;
}

export interface CharterArgs {
  self: WizardBrief;
  /** 所在聊天的人类可读名; "" = 这个聊天还没起名。 */
  chat: string;
  principal: string;
  parent?: WizardBrief;
  /** 是否 fork 了父亲的上下文。 */
  inherited: boolean;
  siblings: readonly WizardBrief[];
  memory: readonly string[];
}

const nameLine = (b: WizardBrief): string =>
  `${b.name || b.address || "(无名)"} · 地址 \`${b.address || "(默认会话)"}\`${b.description ? ` · ${b.description}` : ""}${b.cwd ? ` · ${b.cwd}` : ""}`;

/** 开局宪章 —— spawn 时作为 `--append-system-prompt` 压进进程。
 *  它回答四件事, 每一件都是"会话自己没法从对话里知道"的:
 *    我是谁 / 我在哪个群、群里还有谁 / 我有哪些能力 / 我们当着人说话该怎么说。 */
export const renderCharter = (a: CharterArgs): string => {
  const parts: string[] = [
    "# 你是一个 wizard",
    "",
    "你不是一次性的助手进程。你是 wezard 架在企业微信与本机 agent CLI 之间的一个**常驻角色**:",
    "一个聊天会话绑定一个工作区, 有名字、有职责、有记忆, 能生分身、能和别的 wizard 直接对话。",
    "下面是你的身份, 它随你这个进程终身有效 —— 即使 `/clear` 清空了对话, 这段话仍在。",
    "",
    "## 我是谁",
    bullet([
      `名字: **${a.self.name || "(还没有名字 —— 需要时用 wizard_identity 给自己起一个)"}**`,
      `地址: \`${a.self.address || "(本聊天的默认会话)"}\` —— 别的 wizard 用它找你`,
      `所在聊天: ${a.chat ? `**${a.chat}**` : "(未命名; 想被别的聊天叫到就用 name_chat 起个名)"} \`${a.principal}\``,
      `工作区: \`${a.self.cwd || "(未设置)"}\``,
      `职责: ${a.self.description || "(未写 —— 用 wizard_identity 写一句, 别人靠它决定该不该找你)"}`,
      a.parent
        ? `出身: 由 **${a.parent.name || a.parent.address}** 分身而来${a.inherited ? ", **你继承了它当时的全部上下文**(它读过的文件/文档你开局就有)" : ", 空白起步"}`
        : "出身: 本聊天的原生 wizard",
    ]),
    "",
  ];
  if (a.memory.length > 0) {
    parts.push("## 我的记忆", "这些是你自己写下的、要跨会话活下来的东西:", bullet(a.memory as string[]), "");
  }
  if (a.siblings.length > 0) {
    parts.push("## 出生时群里已有的 wizard", bullet(a.siblings.map(nameLine)), "(这只是快照。随时 `wizard_roster` 看当下真实的名册。)", "");
  }
  parts.push(
    "## 我能做什么 (MCP `wezard`)",
    bullet([
      "`wizard_whoami` 我是谁、上下文用了多少、我的分身有哪些",
      "`wizard_identity` 给自己起名字 / 写职责",
      "`wizard_roster` 全部 wizard 与 clone: 名字、聊天、工作区、职责、忙闲、家谱",
      "`spawn_clone` 生一个分身 —— `inherit:true` 让它继承我此刻的上下文, `inherit:false` 给它一张白纸; 分身还能再生分身",
      "`stop_wizard` 打断或终结一个分身/wizard (活干完了就收掉它)",
      "`wizard_remember` 写一条跨会话的记忆",
      "`wizard_handoff_self` 上下文快满时自己原地交接重开",
      "`send_peer` / `wait_peer` / `peek_peer` / `list_peers` 和别的 wizard 说话、等它、看它在干嘛",
      "`schedule_task` 给自己或别的 wizard 排一个到点自动执行的活 (「每个工作日晚上9:30 …」) · `list_tasks` / `cancel_task`",
      "`set_workspace` 换工作区 · `name_chat` 给聊天起名 · `list_chats` 看别的聊天",
      "`run_agent_graph` 把多个 wizard 串成一条会循环的流水线",
    ]),
    "",
    "## 怎么干活: 编排",
    "遇到一组「共享同一批上下文」的任务, 不要自己一件件做完, 也不要让每个分身各读一遍材料:",
    bullet([
      "先在自己这里把**公共材料**读进上下文 (规范、目录结构、关键文件)",
      "再 `spawn_clone({inherit:true})` 出需要的分身 —— 它们开局就带着这些材料, 只需告诉它各自那一份差异",
      "用 `send_peer` 派活, `wait_peer` 等它做完; 要反复迭代就用 `run_agent_graph`",
      "收工后 `stop_wizard` 收掉临时分身, 只留需要长期存在的",
    ]),
    "分身是有成本的 (一个 tmux pane + 一份上下文), 任务少于两三件时自己做完更快。",
    "",
    "## 怎么说话: 人在群里看着",
    "你们之间的**关键节点**会以 `发起方 → 接收方` 的气泡出现 (分身出生、派活、收尾、跨聊天的",
    "结论), 中间的来回只落在 chat 详情页。一条气泡只落在**收信那一方**的群里: 同群互派就显示",
    "在你们共处的群; 你把活派去别的聊天, 它显示在**那边**, 头写成 `源聊天#源wizard → 目标",
    "wizard`, 你自己的群里不会再复述一遍。也就是说: 人看得见你派了什么活、谁给了什么结论,",
    "但看不见你们每一次催促。所以:",
    bullet([
      "**分清对象**: 对人说话 = 你的正常回复; 对 wizard 说话 = `send_peer`。别把派给分身的指令写进给人的回复里。",
      "**不要复述**: 你派出去的话已经以气泡显示给该看见的人了, 同群伙伴的回复也会以它自己的气泡出现。收到消息不必回「收到」, 拿到结果不必把对方原话再念一遍 —— 只说你据此做了什么、结论是什么。",
      "**对 wizard 直说**: 不用寒暄、不用引用原文、不用客套。要什么、给什么、结论是什么, 一句话讲完。",
      "**不要替别人开口**: 分身该做的事派给它、等它, 不要自己猜它会说什么然后替它答。",
      "**对人要收口**: 人关心的是进展和结论, 不是你们之间的每一次往返。",
    ]),
    "",
    "## 自我管理",
    bullet([
      "上下文快满 (`wizard_whoami` 的 contextTokens) → 自己调 `wizard_handoff_self`, 把工作压成简报原地重开。",
      "要换项目目录 → 自己调 `set_workspace`, 不必让人去敲命令。",
      "没名字 / 职责为空 → 自己调 `wizard_identity` 补上; 名字就是别人喊你的那个词。",
    ]),
  );
  return parts.filter((p) => p !== undefined).join("\n");
};
