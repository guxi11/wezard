// v3 §3 管家指定: 聊天的管家从「默认会话 (untagged)」升为「可绑定的身份」。
//
// 这里只放判定与解析的纯函数, 不写盘、不 spawn:
//   stewardIdentityOf  这个聊天此刻的管家身份 (config 绑定 > 现存默认会话)
//   stewardRoute       裸消息该投给谁 (接待解析; 需要新开化身时给出描述子, 由调用方落盘/起 pane)
//   isStewardTarget    一个 target 是否该聊天的管家化身 —— 手闸 (approval) 与宪章 steward 章的判定面
//   markGlobalSteward  boot 落位: home (defaultChat) 的默认会话标记为全局管家身份的锚点
//
// 「boot 时把存量聊天的 untagged wizard 写进运行时绑定」不另做快照: untagged 记录本身就是
// 事实之源, 每次现读 (stewardIdentityOf 的回落分支) —— 快照反而会在 respawn / forget 之后漂移。
import type { Config } from "../shared/config.js";
import { baseOfKey, keyOf, sameBot, tagOfKey, uniqueTag } from "../shared/session-label.js";
import { identityOf, type WizardKind, type WizardStore } from "./wizard.js";

/** config 里显式绑定的管家身份名 (chatPolicy.<base>.steward); "" = 没绑。 */
export const appointedSteward = (cfg: Config, base: string): string =>
  ((cfg.chatPolicy?.[base] as { steward?: string } | undefined)?.steward ?? "").trim();

/** 频道管家表 (wrc.channel.steward, 键 = 裸 topic_id; §6): 与 chatPolicy 是两张互不覆盖的表,
 *  频道 (chat:<topic_id>) 先查自己的 —— 频道绑定不落 chatPolicy, 群聊绑定也不落频道表。
 *  解析不出 base 里的 topic_id (非 chat: 形状) 时恒空。 */
export const appointedChannelSteward = (cfg: Config, base: string): string => {
  const topicId = base.startsWith("chat:") ? base.slice("chat:".length) : "";
  if (!topicId) return "";
  return ((cfg.wrc.channel.steward ?? {})[topicId] ?? "").trim();
};

/** 该聊天此刻的管家身份 id: config 显式绑定 > 该聊天现存的默认会话 (untagged 记录, 旧行为)。
 *  绑定了但名字解析不到 / 属于别的机器人 → 当作没绑 (回落默认会话): 绑定错由 config 校验报,
 *  接待与手闸不该跟着一个悬空名字一起失效。没有管家 → undefined。 */
export const stewardIdentityOf = (cfg: Config, store: WizardStore | undefined, base: string): string | undefined => {
  const name = appointedChannelSteward(cfg, base) || appointedSteward(cfg, base);
  if (name) {
    const rec = store?.byName(name);
    if (rec && sameBot(base, rec.target)) return identityOf(rec);
  }
  const own = store?.get(base);
  return own ? identityOf(own) : undefined;
};

/** 该身份在一个聊天里的化身记录: untagged 优先 (绑定恰好指向旧默认会话的身份时仍是它),
 *  其余按出生先后 —— 结果与记录顺序无关, 恒定可复现。 */
const manifestationIn = (store: WizardStore, identity: string, base: string) =>
  store.all()
    .filter((w) => identityOf(w) === identity && baseOfKey(w.target) === base)
    .slice()
    .sort((a, b) => Number(!!tagOfKey(a.target)) - Number(!!tagOfKey(b.target)) || a.bornAt - b.bornAt || (a.target < b.target ? -1 : 1))[0];

/** 身份的锚点记录 (target === identity 优先, 否则最老的一条) —— 新化身的名字 / 种类 / 工作区都取它。 */
const anchorOf = (store: WizardStore, identity: string) =>
  store.all()
    .filter((w) => identityOf(w) === identity)
    .slice()
    .sort((a, b) => Number(a.target !== identity) - Number(b.target !== identity) || a.bornAt - b.bornAt)[0];

export interface StewardRoute {
  /** 裸消息的投递目标。 */
  target: string;
  /** 解析认定要在 base 新开一个管家化身 (记录还没落): 调用方须 upsert 记录并起 pane,
   *  目录用 workspace (身份锚点的工作区)。undefined = 无需新开。 */
  fresh?: { identity: string; name: string; kind?: WizardKind; workspace?: string };
}

/** 裸消息 (无点名、无引用) 的接待解析 (§3):
 *  ① config 绑定的管家身份 → 其在本群的化身; 没有化身 → 新开 (名字/种类/工作区取身份锚点)。
 *  ② 该聊天已有默认会话 (untagged 记录) → 它 —— 与旧行为一比一 (bare → base)。
 *  ③ 全新聊天 (连 untagged 记录都没有) → 全局管家 (kind:global-steward, 同 bot) 在本群的化身;
 *     没有化身 → 新开。新群从此不再 auto-spawn 兜底目录的默认会话。
 *  ④ 连全局管家都没有 (home 还没被认领) → base 本身, 与旧「裸消息落本聊天」等形
 *     (dispatch 会回「还没有会话 — 发 /new」)。
 *  纯函数: 不写盘; fresh 只描述要开什么。 */
export const stewardRoute = (
  cfg: Config,
  store: WizardStore | undefined,
  base: string,
  cwdOf?: (target: string) => string,
): StewardRoute => {
  if (!store) return { target: base };
  const open = (identity: string): StewardRoute => {
    const hit = manifestationIn(store, identity, base);
    if (hit) return { target: hit.target };
    const anchor = anchorOf(store, identity);
    if (!anchor?.name) return { target: base };
    const taken = new Set(store.all().filter((w) => baseOfKey(w.target) === base).map((w) => tagOfKey(w.target)).filter(Boolean));
    const workspace = cwdOf?.(anchor.target) || undefined;
    return {
      target: keyOf(base, uniqueTag(anchor.name, taken)),
      fresh: { identity, name: anchor.name, ...(anchor.kind ? { kind: anchor.kind } : {}), ...(workspace ? { workspace } : {}) },
    };
  };
  const bound = appointedChannelSteward(cfg, base) || appointedSteward(cfg, base);
  if (bound) {
    const rec = store.byName(bound);
    if (rec && sameBot(base, rec.target)) return open(identityOf(rec));
  }
  if (store.get(base)) return { target: base };
  const globalSteward = store.all()
    .filter((w) => w.kind === "global-steward" && w.name && sameBot(base, w.target))
    .slice()
    .sort((a, b) => Number(a.target !== identityOf(a)) - Number(b.target !== identityOf(b)) || a.bornAt - b.bornAt)[0];
  if (globalSteward) return open(identityOf(globalSteward));
  return { target: base };
};

/** target 是否「它所在聊天的管家化身」—— 旧判定是 !tagOfKey(target) (默认会话即管家);
 *  新判定 = 它属于该聊天此刻的管家身份 (config 绑定优先)。绑定换人后, 旧默认会话不再是
 *  管家 (手闸不 arm、宪章不再带管家章); 被指定的化身即使是 tagged 也算。没有记录的
 *  target 永远不算 (手闸只管名册里的人)。 */
export const isStewardTarget = (cfg: Config, store: WizardStore | undefined, target: string): boolean => {
  const rec = store?.get(target);
  if (!rec) return false;
  const id = stewardIdentityOf(cfg, store, baseOfKey(target));
  return !!id && identityOf(rec) === id;
};

/** boot 落位 (§3): home (defaultChat) 现存的默认会话标记为全局管家身份的锚点化身
 *  (kind: global-steward)。幂等; home 还没有记录 (未被认领的新装机) 不造幽灵记录 ——
 *  认领 (claim) 落了 defaultChat 之后下一次 boot 自然接上。 */
export const markGlobalSteward = (store: WizardStore, home: string): { marked: boolean; target: string } => {
  const h = home.trim();
  if (!h || !store.get(h) || store.get(h)?.kind === "global-steward") return { marked: false, target: h };
  store.upsert(h, { kind: "global-steward" });
  return { marked: true, target: h };
};
