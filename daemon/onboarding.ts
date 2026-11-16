// 新群引导 (人 2026-11-16 拍板): bot 被拉进新群后不闲聊 —— daemon 直接接管裸消息,
// 引导人依次落两件事: ① 管家的 workspace ② 绑定管家。两件都落齐, 引导退出, 之后的
// 裸消息按既有 stewardRoute 落到绑定的管家化身。引导是强制的: 不设跳过、不设超时
// (人原话「保证引导流程, 直到绑定了一个 workspace 和管家」)。
//
// 这里只放判定、状态与写入; 消息编排 (拦截、应答) 在 inbound.ts 的 guideGate。
// workspace 是**身份级**的 (拍板 A): 绑已有管家时它自带工作区, 第 ① 步收的路径不
// 适用 —— 应答里明说; 新建管家时写进锚点记录的 workspace 字段, 该身份在任何群的
// 化身都从它起 (wizard.ts 的 identityWorkspaceOf)。
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ChatPolicy, type Config } from "../shared/config.js";
import { patchJsonc } from "../shared/config-writer.js";
import { expandHome } from "../shared/paths.js";
import { stripSigil } from "../shared/session-label.js";
import { appointedChannelSteward, appointedSteward } from "./steward.js";
import type { WizardStore } from "./wizard.js";

export type OnboardingStep = "workspace" | "steward";

export interface OnboardingState {
  step: OnboardingStep;
  /** 人确认过的工作区 (step 为 steward 时必有)。 */
  workspace?: string;
}

/** 引导是否该接管这个群: 机器已认领 + 群 principal + 没绑管家 + 没有 untagged 默认会话
 *  (存量群 / 已引导群走老路 —— 绑定一落盘本判定即转 false, 不需要完成标记)。
 *  单聊 (user:*) 不引导: 人私聊的默认接待 = 全局管家 (v3 §3)。频道 (chat:<topic_id>)
 *  不走 message.text 入站, 到不了这里的调用方; 频道管家表照查一道以防万一。 */
export const needsOnboarding = (cfg: Config, store: WizardStore | undefined, base: string): boolean =>
  !!cfg.defaultChat
  && base.startsWith("chat:")
  && !appointedChannelSteward(cfg, base)
  && !appointedSteward(cfg, base)
  && !store?.get(base);

/** 与 wizard 名字同一套字符集 (wizard 地址语法: 不能含 # / : 与空白)。 */
export const WIZARD_NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u;

// ── 在途状态 ──────────────────────────────────────────────────────────
// <stateDir>/onboarding.json 只记**还没走完**的群; 走完的凭据是 config 里的绑定,
// 不在状态里 —— crash / reload 后凭 config 就能接着判, 状态只是断点续传。
const statePath = (cfg: Config): string => join(expandHome(cfg.daemon.stateDir), "onboarding.json");

const readStates = (cfg: Config): Record<string, OnboardingState> => {
  try {
    const raw: unknown = JSON.parse(readFileSync(statePath(cfg), "utf8"));
    const out: Record<string, OnboardingState> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (v && typeof v === "object" && (((v as OnboardingState).step === "workspace") || ((v as OnboardingState).step === "steward"))) {
          out[k] = v as OnboardingState;
        }
      }
    }
    return out;
  } catch { return {}; }
};

export interface OnboardingStore {
  /** 在途引导; 不在途 = undefined。 */
  get(base: string): OnboardingState | undefined;
  /** 进入 (或继续) 引导, 返回当前步。 */
  begin(base: string): OnboardingStep;
  /** workspace 落定 → 进入管家步。 */
  setWorkspace(base: string, cwd: string): OnboardingStep;
  /** 绑定落盘后清掉在途状态。 */
  finish(base: string): void;
}

export const loadOnboardingStore = (cfg: Config): OnboardingStore => {
  const db = readStates(cfg);
  const save = (): void => {
    try {
      mkdirSync(dirname(statePath(cfg)), { recursive: true });
      writeFileSync(statePath(cfg), JSON.stringify(db, null, 2) + "\n");
    } catch { /* 断点续传是锦上添花, 写失败不挡引导本身 */ }
  };
  return {
    get: (b) => db[b],
    begin: (b) => { db[b] = db[b] ?? { step: "workspace" }; save(); return db[b]!.step; },
    setWorkspace: (b, cwd) => { db[b] = { step: "steward", workspace: cwd }; save(); return "steward"; },
    finish: (b) => { if (db[b]) { delete db[b]; save(); } },
  };
};

// ── 纯输入解析 ────────────────────────────────────────────────────────

/** 人给的 workspace: 展开 ~、剥引号; 必须存在且是目录。 */
export const validateWorkspace = (raw: string): { ok: true; abs: string } | { ok: false; reason: string } => {
  const p = expandHome((raw ?? "").trim().replace(/^["']+|["']+$/g, ""));
  if (!p.startsWith("/")) return { ok: false, reason: "要绝对路径 (可 ~ 开头)" };
  let st: ReturnType<typeof statSync>;
  try { st = statSync(p); } catch { return { ok: false, reason: p + " 不存在" }; }
  if (!st.isDirectory()) return { ok: false, reason: p + " 不是目录" };
  return { ok: true, abs: p };
};

/** 管家步的输入 → 名字候选: 剥 .x / 记号 / 引号, 截掉粘连的 @mention (名字不含 @),
 *  只取第一个空白分隔 token。空 = 没给出名字。 */
export const stewardNameInput = (raw: string): string => {
  const head = stripSigil(raw).replace(/["']/g, "").split("@")[0] ?? "";
  return head.trim().split(/\s+/)[0] ?? "";
};

// ── 写入 ──────────────────────────────────────────────────────────────

/** 把管家绑定写进 config (热): chatPolicy.<base>.steward。宪章守卫由调用方包。 */
export const bindSteward = (cfg: Config, sourcePath: string, base: string, name: string): void => {
  const policy = cfg.chatPolicy ?? {};
  const cur = policy[base] ?? ChatPolicy.parse({});
  cfg.chatPolicy = { ...policy, [base]: { ...cur, steward: name } };
  patchJsonc(sourcePath, [{ path: ["chatPolicy", base, "steward"], value: name }]);
};

// ── 话术 (纯) ─────────────────────────────────────────────────────────

export const renderWorkspacePrompt = (): string =>
  "[wezard] 新群引导 ①/② · 工作区\n请回复本群管家要工作的目录 (绝对路径, 可 ~ 开头)。引导完成前我只做引导, 不闲聊。";

export const renderStewardPrompt = (workspace: string): string =>
  "[wezard] 新群引导 ②/② · 管家\n· 绑已有管家: 回复它的名字 (如 .fix)\n· 新建管家: 回复一个新名字 (1-32 位字母/数字/_/-), 它将工作在 " + workspace;

export const renderDone = (name: string, workspace: string): string =>
  "[wezard] ✅ 引导完成: 管家 ." + name + " 已就位 (工作区 " + workspace + ")。之后直接说话就是找它; 给它改名用 /name <新名字>。";
