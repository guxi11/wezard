// 派活方向闸 (金字塔第 4 步): 一句 tell_peer 该不该投 —— 纯判定, 只拒不改投递路径。
//
// 工单树里「谁能给谁派活」是结构, 不是礼貌: 只靠宪章说「别越级、别横向」, 模型一忙就忘。
// 这里把能由守护进程拦的那几条拦下来; 拦的理由写清对的做法, 调用方 (模型) 读了就知道改道。
// 只看 `kind === "task"` 的派活 (除了防环: ask 也拦); `fyi` 永远放行 —— 知会不占对方一轮。
import { ancestorsOf, type JobRecord } from "./jobs.js";

/** 发话方的 peer k 链 (它在答谁、谁又在答谁…, 不含人) 到这么长就不许再往下派 task:
 *  人→管家→lead→子 lead→执行, 执行手上的链已有 3 个上级; 再往下派说明该把活交还上级重新拆。 */
export const K_CHAIN_MAX = 3;

export interface DirectionIn {
  self: string;
  target: string;
  kind: "task" | "ask" | "fyi";
  /** `re` 续问 (同一件活接着说): 不是新活, 只受 1 / 3 / 防环约束。 */
  re: boolean;
  /** 这句话归到哪张工单 ("" = 不带)。 */
  jobId: string;
  /** 全部工单 (函数自己筛开着的)。 */
  jobs: readonly JobRecord[];
  /** 发话方此刻这一轮的 k 链: 它在答谁、谁又在答谁… (target key, 近的在前; 见 receipts.ancestorsOf)。 */
  chain: readonly string[];
  nameOf: (target: string) => string;
}

const isMember = (j: JobRecord, t: string): boolean => j.members.some((m) => m.target === t);
/** 还在这张单里干活的执行者 / lead (已落定的、专家、评审不算「归它管」)。 */
const isActive = (j: JobRecord, t: string): boolean => j.members.some((m) => m.target === t && !m.outcome && (m.role ?? "exec") !== "expert" && m.role !== "reviewer");

/** 拒的理由; 放行 = undefined。 */
export const checkDirection = (i: DirectionIn): string | undefined => {
  if (i.kind === "fyi") return undefined;
  const nm = i.nameOf;
  // 4 防环: 它正在等你答, 你却反过来给它派活 / 提问 —— 两边互等。
  // 只覆盖私聊 peer 轮: 公开轮 (人在群里开的) 的父 k 是 chat, 链上没有 wizard。
  if (i.chain.includes(i.target)) return `${nm(i.target)} 正等着你这一轮的答复 (你在答它派的活, 或答的是它上游的上游) —— 反过来派活 / 提问会互相干等; 要问它就以 \`NEED:\` 收口, 它会带着答案来找你`;
  if (i.kind !== "task") return undefined;
  const open = i.jobs.filter((j) => j.status === "open");
  const byId = new Map(open.map((j) => [j.id, j] as const));
  const get = (id: string): JobRecord | undefined => byId.get(id);
  const job = get(i.jobId);
  // 1 带工单的 task 只许开单者发: 成员领了活就干, 不向旁人再派。
  if (job && job.owner !== i.self) return `工单 ${job.id} 的活只能由开单者 ${nm(job.owner)} 派; 你是成员 —— 要问谁一句用 kind:"ask", 要谁来干就以 \`NEED:\` 告诉 ${nm(job.owner)}`;
  // 3 不越级: 目标归下一层的 lead 管, 上层只能经 lead。
  const owned = open.find((j) => j.owner !== i.self && isActive(j, i.target) && ancestorsOf(get, j).some((a) => a.owner === i.self));
  if (owned) return `${nm(i.target)} 归 ${nm(owned.owner)} 管 (工单 ${owned.id}), 你是它上级单的开单者 —— 派活 / 打回经 ${nm(owned.owner)} (\`tell_peer\` ${nm(owned.owner)}, 带 \`re\` 续它那件); 只想看进展用 peek_peer / read_chat`;
  if (i.re) return undefined;
  // 2 同一张单里成员之间不横向派新 task (哪怕没带 job); re 续问不拦 (成员 ask 兄弟、兄弟 NEED 回来, 得能答)。
  const sibling = open.find((j) => j.owner !== i.self && j.owner !== i.target && isMember(j, i.self) && isMember(j, i.target));
  if (sibling) return `你和 ${nm(i.target)} 同是工单 ${sibling.id} 的成员, 成员之间不横向派 task —— 问一句用 kind:"ask"、知会用 kind:"fyi"; 要它干活以 \`NEED:\` 告诉开单者 ${nm(sibling.owner)}, 由它派`;
  // 5 链深: 再往下派说明该交还上级拆。
  if (i.chain.length >= K_CHAIN_MAX) return `你这一轮已在 ${i.chain.length} 层派活链的底部 (${i.chain.map(nm).reverse().join(" → ")} → 你), 不再往下派 task —— 活太大就以 \`NEED:\` 请上级重新拆, 或自己做完`;
  // 6 专家只答 ask; 一个 wizard 同时只在一张开着的单里当未落定的 exec。
  const lent = open.find((j) => j.owner === i.self && j.members.some((m) => m.target === i.target && m.role === "expert"));
  if (lent) return `${nm(i.target)} 是工单 ${lent.id} 里借来的专家, 只答 kind:"ask"; 要它领活先从原单释放 (以 role:"exec" 重新归入工单)`;
  const busyIn = job && open.find((j) => j.id !== job.id && j.members.some((m) => m.target === i.target && (m.role ?? "exec") === "exec" && !m.outcome));
  if (busyIn) return `${nm(i.target)} 已在工单 ${busyIn.id} 里领着一份没落定的活, 一个 wizard 同时只在一张开着的单里当执行者 —— 等它交差, 或换个人`;
  return undefined;
};
