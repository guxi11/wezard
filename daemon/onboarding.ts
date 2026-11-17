// 新群引导 (人 2026-11-16 拍板 + 2026-11-17 改口径): bot 被拉进新群后由一个**真实
// 的引导会话** (base#guide 化身) 在群里对话式引导, 依次落两件事: ① 管家的 workspace
// ② 绑定管家。两件都落齐, 引导告别后收尾, 之后的裸消息按既有 stewardRoute 落到
// 绑定的管家化身。引导是强制的: 不设跳过、不设超时 (人原话「保证引导流程, 直到
// 绑定了一个 workspace 和管家」)。daemon 仍是状态机主人: 判定/校验/落盘/强制全在
// 这里与 guideGate, 引导化身只负责表达。
//
// workspace 是**身份级**的 (拍板 A): 绑已有管家时它自带工作区, 第 ① 步收的路径不
// 适用 —— 应答里明说; 新建管家时写进锚点记录的 workspace 字段, 该身份在任何群的
// 化身都从它起 (wizard.ts 的 identityWorkspaceOf)。
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ChatPolicy, type Config } from "../shared/config.js";
import { patchJsonc } from "../shared/config-writer.js";
import { expandHome } from "../shared/paths.js";
import { keyOf, stripSigil, tagOfKey } from "../shared/session-label.js";
import { appointedChannelSteward, appointedSteward } from "./steward.js";
import type { WizardRecord, WizardStore } from "./wizard.js";

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

// ── 引导会话 (人 2026-11-17 改口径: 要一个真实的对话式引导会话) ────────
// 引导化身是 `base#guide` 这个 tagged slot —— 绝不占 untagged 记录: 那是「该群管家
// 锚点」的保留位 (新建管家时引导会写它), 引导者占了它, 绑定后就会被当成管家复用。
// daemon 仍是状态机主人 (判定/校验/落盘/强制), 引导化身只把 daemon 的指令转成人话。

/** 引导化身记录的职责标记 —— 收尸判定认它 (reload 丢了收尾定时器时的兜底)。 */
export const GUIDE_DESC = "新群引导";
/** 一个群的引导化身 target: 恒为 `base#guide` (名字可能因撞名落成 guide-2, slot 不变)。 */
export const guideTargetOf = (base: string): string => keyOf(base, "guide");
/** 这条记录是不是该群的引导化身 (职责标记 + guide slot 双证)。 */
export const isGuideManifestation = (rec: WizardRecord | undefined): boolean =>
  !!rec && rec.description === GUIDE_DESC && tagOfKey(rec.target) === "guide";

// ── 在途登记 (chatPolicyOf 的 strict 豁免凭据) ────────────────────────
// 出站 tracker 第一句就会把新群登记成首见 strict —— 不豁免的话, 对话式引导第二轮
// 起模型发言就被人只见占位。所以「在途」的群一律按 implicit 出站, 显式 chatPolicy
// 也不豁免它: 绑定落盘之前这个群还谈不上治理。窗口覆盖到告别之后 (收尾 reap 时才
// close), 让最后一句告别能出站; 收尾后第一条人话按正常首见登记, 管家的回复从此走
// 严格门的 chat_reply 流程。只在本进程内有效 (mirror-bridge 与 inbound 同进程)。
const activeBases = new Set<string>();
/** 这个群是否在引导途中 (含告别窗口)。 */
export const isOnboardingActive = (base: string): boolean => activeBases.has(base);
/** 收尾时关掉豁免窗口 (reap 引导化身的那一格调用)。 */
export const closeOnboarding = (base: string): void => { activeBases.delete(base); };

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
  // 在途播种: reload 后 (可能还有在途告别窗口之外的) 断点群继续豁免; finish 只清
  // 状态 (状态机已完), 豁免窗口要等收尾 (closeOnboarding) —— 见上。
  for (const b of Object.keys(db)) activeBases.add(b);
  const save = (): void => {
    try {
      mkdirSync(dirname(statePath(cfg)), { recursive: true });
      writeFileSync(statePath(cfg), JSON.stringify(db, null, 2) + "\n");
    } catch { /* 断点续传是锦上添花, 写失败不挡引导本身 */ }
  };
  return {
    get: (b) => db[b],
    begin: (b) => { db[b] = db[b] ?? { step: "workspace" }; activeBases.add(b); save(); return db[b]!.step; },
    setWorkspace: (b, cwd) => { db[b] = { step: "steward", workspace: cwd }; activeBases.add(b); save(); return "steward"; },
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

// ── 话术 (daemon → 引导化身的注入指令; 纯函数) ───────────────────────
// 每条指令自包含 (reload 换了引导化身也能接上), 并约定: 引导者只转述引导、每次一两
// 句话、不闲聊 —— 表达层约束 (机制层: 状态机/落盘/强制全在 daemon, 模型跳不了步)。
// 指令里不写点号名字示例 (如 `.fix`), 免得被 peerMentions 当成点名标注。

export const renderGuideOpening = (): string =>
  "你是这个新群的引导者 (wezard 被拉进新群后的初始化流程)。只做引导、不闲聊、不回答与引导无关的问题, 每次一两句话。需要人定两件事, 先是第一件: 请友好开场, 并请人回复管家要工作的目录 (绝对路径, 可 ~ 开头)。";

export const renderGuideWorkspaceOk = (workspace: string): string =>
  "workspace 已定: " + workspace + "。请请人进行第二件事 —— 绑定管家: 回复一个已有管家的名字 (例: fix), 或一个新名字 (将在这个目录新建管家)。一两句话讲完。";

export const renderGuideWorkspaceRetry = (reason: string): string =>
  "人刚给的目录不行 (" + reason + ")。请请人重发一个存在的目录 (绝对路径, 可 ~ 开头)。一句话即可。";

export const renderGuideStewardRetry = (reason: string): string =>
  "这个绑定不行 (" + reason + ")。请请人回复一个已有管家的名字 (例: fix), 或一个新名字 (1-32 位字母/数字/_/-)。一句话即可。";

export const renderGuideStewardDone = (name: string, workspace: string, note = ""): string =>
  "引导完成: 管家 " + name + " 已就位 (工作区 " + workspace + "), 绑定已生效。" + (note ? note + " " : "") + "请用一两句话祝贺并告别, 告诉人以后直接在群里说话就是找这位管家; 说完即可, 不必再说别的。";
