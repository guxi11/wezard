// P7-S3 ② 存量群切换 strict 的独立命令 (只做不执行: 命令落地, 但不随 S3 代码对任何
// 存量聊天自动生效 —— 切换永远是一次显式的 /strict apply)。
//
// 纯函数面: 命令解析 + 预演计划 (受影响 wizard 清单)。写配置 / 宪章守卫在 daemon/index.ts
// 接线 (guardCharter: chatPolicy 进宪章, 受影响的 wizard 自动挂交接提醒)。
//
// 用法 (IM 命令, 任何聊天里发):
//   /strict                  预演: 本聊天切 strict 会动谁 (默认 dry-run, 不写任何东西)
//   /strict daily cc-wecom   预演: 点名的聊天 (聊天名或 base principal)
//   /strict --all            预演: 全部存量 implicit 群 (known-chats 册里的 legacy 群)
//   /strict apply …          执行: 同上任意一种, apply 在最前才写配置
import { chatPolicyOf } from "./chat-name.js";
import { knownChatsOf } from "./chat-seen.js";
import type { Config } from "../shared/config.js";

export interface StrictCommand { apply: boolean; all: boolean; refs: string[] }

const STRICT_RE = /^\/strict(?:\s+(.+))?$/i;

/** "/strict [apply] [--all|聊天…]" → 命令; 别的文本 → undefined。 */
export const parseStrictCommand = (text: string): StrictCommand | undefined => {
  const m = STRICT_RE.exec(text.trim());
  if (!m) return undefined;
  const tokens = (m[1] ?? "").split(/\s+/).filter(Boolean);
  const apply = tokens[0]?.toLowerCase() === "apply";
  const rest = apply ? tokens.slice(1) : tokens;
  const all = rest.some((t) => /^--all$/i.test(t));
  const refs = rest.filter((t) => !/^--all$/i.test(t));
  return { apply, all, refs };
};

export interface SwitchFacts {
  /** 聊天名/base → 显示名 (有名字用名字, 没有就 base 原样)。 */
  chatLabel: (base: string) => string;
  /** home 在这个聊天的 wizard 名单 (宪章会变的那批)。 */
  wizardsOf: (base: string) => string[];
  /** 绑定的管家名 (无 = "")。 */
  stewardOf: (base: string) => string;
  /** 成员表行数。 */
  memberCount: (base: string) => number;
}

export interface SwitchRow {
  base: string;
  label: string;
  /** 切换前的生效 speech。 */
  from: "implicit" | "strict";
  /** 存量 (boot 快照在册 legacy) — 本命令的目标人群; false = S3 后首见 (已默认 strict)。 */
  legacy: boolean;
  /** 单聊: 不在本命令范围 (要开单聊 strict 显式写 config)。 */
  private: boolean;
  /** 受影响 wizard: home 在此 + 管家 (去重)。 */
  wizards: string[];
  steward: string;
  members: number;
}

export interface SwitchPlan {
  rows: SwitchRow[];
  /** 认不出的聊天名。 */
  miss: string[];
  /** --all 的候选全集 (存量 implicit 群)。 */
  candidates: string[];
}

const rowOf = (cfg: Config, base: string, facts: SwitchFacts): SwitchRow => {
  const steward = facts.stewardOf(base);
  const wizards = [...new Set([...facts.wizardsOf(base), ...(steward ? [steward] : [])])];
  return {
    base,
    label: facts.chatLabel(base),
    from: chatPolicyOf(cfg, base).speech,
    legacy: knownChatsOf(cfg).isLegacy(base),
    private: !base.startsWith("chat:"),
    wizards,
    steward,
    members: facts.memberCount(base),
  };
};

/** 预演计划: 目标 = 点名的聊天 (refs), --all 的候选全集, 或调用方本聊天 (refs 空)。 */
export const planStrictSwitch = (
  cfg: Config,
  input: { refs: string[]; all: boolean; selfBase: string },
  resolveBase: (ref: string) => string,
  facts: SwitchFacts,
): SwitchPlan => {
  // --all 的候选: 存量 (legacy) 且群聊且生效 implicit 的全部聊天。
  const candidates = input.all || input.refs.length === 0
    ? knownChatsOf(cfg).rows()
        .filter((r) => r.legacy && r.chat.startsWith("chat:") && chatPolicyOf(cfg, r.chat).speech === "implicit")
        .map((r) => r.chat)
    : [];
  if (input.all) {
    const rows = candidates.map((base) => rowOf(cfg, base, facts));
    return { rows, miss: [], candidates };
  }
  const miss: string[] = [];
  const bases: string[] = [];
  for (const ref of input.refs.length ? input.refs : [input.selfBase]) {
    const base = resolveBase(ref);
    if (!base) { miss.push(ref); continue; }
    if (!bases.includes(base)) bases.push(base);
  }
  // refs 空 = 本聊天: 单聊也如实报告 (private 标记), 让人看到为什么不能切。
  return { rows: bases.map((base) => rowOf(cfg, base, facts)), miss, candidates };
};

/** 渲染预演/执行报告 (人读的一段话)。 */
export const renderSwitchReport = (plan: SwitchPlan, mode: "dry" | "apply"): string => {
  const switching = plan.rows.filter((r) => !r.private && r.from === "implicit");
  const head = mode === "dry"
    ? "[wezard] /strict 预演 (dry-run, 什么都不写; 确认无误再加 apply 执行)"
    : switching.length
      ? "[wezard] /strict apply 已执行, 写入 " + switching.length + " 个聊天:"
      : "[wezard] /strict apply: 没有需要切换的聊天 (见下)";
  const line = (r: SwitchRow): string => {
    const tag = r.private ? "单聊 — 不在切换范围 (要开单聊 strict 显式写 config)"
      : r.from === "strict" ? (r.legacy ? "已是 strict, 不动" : "S3 后首见已是 strict, 不动")
      : r.legacy ? "存量 implicit → strict"
      : "未在册 (没发生过往来) → strict";
    const affected = r.wizards.length
      ? "受影响 wizard " + r.wizards.length + " 个 (" + r.wizards.join(" ") + ") — 宪章变, 自动挂交接提醒" + (r.members ? "; 成员表 " + r.members + " 行" : "")
      : "没有 wizard 住在这里 (无人需要交接)";
    return "- " + r.label + " (" + r.base + ") · " + tag + " · " + affected;
  };
  const body = plan.rows.length ? plan.rows.map(line) : [];
  const tail = [
    ...plan.miss.length ? ["认不出的聊天: " + plan.miss.join("、") + " (wizard_roster / /chats 看名字)"] : [],
    ...mode === "dry" && switching.length ? ["执行: /strict apply" + (plan.rows.length === 1 ? "" : " <同样的聊天列表>")] : [],
  ];
  return [head, ...body, ...tail].filter(Boolean).join("\n");
};
