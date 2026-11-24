// 受限会话的工具面 —— 声明式注册表 (人 2026-11-23: 「抽离通用的 REPL 问题解决方案, 不要每次再遇到」)。
//
// 同型 bug 已经两次: 引导化身 (25179b4) 与 monitor (5066898) 都因为「只看外层工具名」被
// CodeBuddy 的 REPL 外壳整个关死 —— CodeBuddy 只把 REPL 暴露成直接工具, 真正的调用写在
// code 脚本里。现在所有受限会话都必须在这里注册一个 face; 判定只走 faceRefusal:
//   没匹配 → ""; 外层名在白名单 → ""; 代码执行外壳 → 下钻脚本 (exec-surface) 每一项调用
//   都必须是本 face 的白名单; 其余 → face.refuse(action)。
// **新增受限会话只注册 face, 不要另写只看外层工具名的拒绝逻辑** (tests/tool-face.test.ts
// 会替每个 face 自动跑同一组断言; 见 docs/dev-guide.md「受限会话的工具面」)。
import type { WizardRecord } from "./wizard.js";
import { MONITOR_TOOLS } from "./wizard.js";
import { GUIDE_TOOLS, isGuideManifestation } from "./onboarding.js";
import { EXEC_SHELLS, execToolRefusal, shortToolOf } from "./exec-surface.js";

export interface ToolFace {
  /** 日志 / 测试里的名字。 */
  name: string;
  /** 这条记录归不归本 face 管。 */
  match: (rec: WizardRecord | undefined) => boolean;
  /** 允许的工具 (短名, 如 chat_reply)。 */
  tools: ReadonlySet<string>;
  /** 越界时的拒绝理由; what 是外层工具名或脚本里的调用拼写。 */
  refuse: (what: string) => string;
}

/** 引导化身 (新群引导): 只在 room 里说话 + 一次受控绑定。 */
const guideRefuse = (what: string): string =>
  "引导会话只有 chat_reply / chat_say (本群 room) / onboard_bind 三件工具 (" + what + " 被拒): "
  + "话用 chat_reply / chat_say 说进 room, 目录与绑定用 onboard_bind 交给 daemon, 不要调别的工具或命令。";

/** room 的 perceptron: 读账本 + 一份名单判决。 */
const monitorRefuse = (what: string): string =>
  "perceptron 只有 room_read / read_channel / wizard_roster / room_activate / handoff 五件工具 (" + what + " 被拒): "
  + "你的活是读账本然后 room_activate 一份名单判决, 不发言、不派活、不改文件。";

export const TOOL_FACES: readonly ToolFace[] = [
  { name: "guide", match: (rec) => isGuideManifestation(rec), tools: GUIDE_TOOLS, refuse: guideRefuse },
  { name: "monitor", match: (rec) => rec?.kind === "monitor", tools: MONITOR_TOOLS, refuse: monitorRefuse },
];

/** 这条记录属于哪个 face (没有 = undefined)。 */
export const faceOf = (rec: WizardRecord | undefined): ToolFace | undefined => TOOL_FACES.find((f) => f.match(rec));

/** 受限会话调了某个工具 / 路由时的唯一判定 ("" = 放行)。纯函数。
 *  toolInput 只在代码执行外壳 (EXEC_SHELLS) 下用得上 —— 那时放行与否看脚本里实际调了什么。 */
export const faceRefusal = (rec: WizardRecord | undefined, action: string, toolInput?: unknown): string => {
  const face = faceOf(rec);
  if (!face) return "";
  const short = shortToolOf(action);
  if (face.tools.has(short)) return "";
  if (EXEC_SHELLS.has(short)) {
    const code = toolInput !== null && typeof toolInput === "object" ? (toolInput as { code?: unknown }).code : undefined;
    return execToolRefusal(code, face.tools, face.refuse);
  }
  return face.refuse(action);
};
