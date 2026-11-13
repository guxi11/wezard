# wezard v3 设计稿

> 状态: 待人确认 (本文档是设计稿, 未开始实现)。分支 `v3` (自 `v2.9.0` tag)。
> 六条人话需求 → 章节映射: ① §1 表示层; ② §2 身份系统 + §3 管家指定; ③ §4 roster 金字塔; ④ §5 组团; ⑤ §6 channel; ⑥ §7 学徒。
> 每节结构: 现在的机制 (已对照代码核实) → 改成什么 → 落点 (文件/数据结构) → 破坏性影响 → 迁移方式。

---

## 1. 表示层: `.name` → `🧙‍♂️ name` (需求 ①)

### 1.1 现在的机制

**出站 (wizard → 群)**: 气泡头由 `shared/session-label.ts` 的渲染原子拼出 ——
`tagHead(target)` 产 `.name`, `withLinkedTagHeader` / `withTagHeader` (session-label.ts:325/338) 把头挂在每条出站 markdown 前 (`daemon/mirror-bridge.ts` 所有 `replyStream` 调用点)。两条豁免:
- **isHost** (session-label.ts): 群默认 wizard (untagged target) 在自己群里**不报名** —— 头整个不写。
- 非 host 的名字包反引号 (``.name``) 与 default wizard 区分。
审批卡徽标 `tagBadge` 同样 host 豁免。公开 peer 轮的头是 `.me: .它` (`speakerHead`)。

**反解 (机器读回)**: `HEADER_RE` (session-label.ts, `.name:` / ``.name`` / `[.name](url):` 三形态, 行首锚定 + 冒号结尾) ← `parseTagHeader` / `rawTagHeader` 剥头。它的唯一机器消费者是**引用即路由** (`daemon/inbound.ts` parseQuote, ~464 行): 人 quote 一条 bot 气泡, quote 文本自带 `.name` 头, 反解出 `tag`(路由目标) / `srcTag`(源会话, 用于去重比对)。

**行首寻址**: `NAME_TOKEN` / `nameTokenRe` (session-label.ts:47) —— 入站消息清洗后**落在开头**的那一个 `.x` 是路由目标 (inbound.ts parseTag), 认不认识都算; 正文里的 `.fix` 只是提及 (`MENTION_RE` + `linkTags` 挂 rolepage 链接)。

**envelope 属性** (`shared/reminder.ts`): 与文本表示**完全无关**。轮次归属 / 回执 / 去向 / 提交见证全部读 `REMINDER_KINDS.envelope` 登记过的属性 (kind/from/scope/chat/chat-key/msg/event/receipt/status/audience), `parseEnvelope` 取最后一个信封。

**其余显示面**: read_chat 纯文本 `.a: .b` (SPEAKER_KIT 的 said/speakerHead); rolepage 头像 emoji + 名字 (`nameHead`); charter / roster 用 `addr()` 渲染 `.name` (`daemon/wizard.ts`)。

### 1.2 改成什么

- **渲染** (给人看): `tagHead` → `🧙‍♂️ name` (去掉点号); 气泡头 `🧙‍♂️ name：` (全角冒号, 与人的原话一致); 公开 peer 轮 `🧙‍♂️ me： 🧙‍♂️ you`; 审批卡徽标、roster、charter、read_chat、rolepage、help 文案全部跟进。**参数层不变**: `tell_peer({name:"fix"})` 仍收裸名, 只有显示层带 🧙‍♂️ (`mcp/tools.ts` name 参数描述补一句)。
- **反解** (机器读回): `HEADER_RE` 扩为**双态** —— 新形态 `🧙‍♂️ name：` / `[🧙‍♂️ name](url)：` 与旧形态 `.name:` / `[.name](url):` **长期并存**。`parseTagHeader` / `rawTagHeader` 双态剥离。🧙‍♂️ 是 ZWJ 序列 (U+1F9D9 U+200D U+2642 U+FE0F, 4 code points / 12 UTF-8 字节), 正则按 codepoint 序列字面量写, 不许 `.` 通配。
- **管家报名**: 废除 isHost 的「头不写」豁免 —— 管家在自己群里回复同样带 `🧙‍♂️ name：` (人的原话明确要求)。isHost 保留给 voiceOf (替谁说话) 的语义判定, 只是不再压掉头的渲染。微信通道 (`isWxChat`, 链接降文字) 的降级逻辑照旧。
- **quote 直接回答语义**: 「直接回答某个 wizard」= quote 它的气泡 (反解出的 `tag` 即投递目标), 这在「引用即路由」上已存在; 变化在**默认路由** —— 不带 quote、不带行首点名的裸消息, 不再落「本聊天默认 wizard」, 改落「本聊天当前管家」(§3/§5)。行首 `.name` / `🧙‍♂️ name` 点名保留为与 quote 等价的显式寻址 (待人拍板 ①)。
- **md-chunk / 预算**: 头变长 ~12 字节; `TAG_HEADER_BUDGET` (mirror-bridge.ts:946, 按「头 + 正文 2 个链接」留的余量) 复核放宽 ~24 字节。md-chunk 按行块切、从不切行中, ZWJ 序列不会被切开 —— 加一条单测钉死。

### 1.3 落点

| 位置 | 改动 |
|---|---|
| `shared/session-label.ts` | `tagHead`/`linkedTagHead`/`chatHead`/`tagBadge`/`said`/`speakerHead`/`SPEAKER_KIT` (渲染原子); `HEADER_RE`/`parseTagHeader`/`rawTagHeader` (双态反解); `MENTION_RE`/`linkTags` (正文提及换新表示) |
| `daemon/inbound.ts` | `parseTag` 行首寻址双态; `parseQuote` 走双态 parseTagHeader (本身不改); help 文案 (~200 行「写作 .name」段) |
| `daemon/mirror-bridge.ts` | `TAG_HEADER_BUDGET` 放宽; 出站头无逻辑改动 (走 session-label 原子) |
| `daemon/wizard.ts` | `addr()`/`nameLine`/`renderRoster`/`renderCharter` 名字行、`renderLeadRules` 的 `@.name` 措辞 |
| `daemon/peers.ts` / `shared/role-render.ts` / `web/chat.js` | read_chat、rolepage 渲染跟进 |
| `mcp/tools.ts` | name 类参数描述: 「显示带 🧙‍♂️, 参数写裸名」 |

### 1.4 破坏性影响与迁移

- 旧气泡 (transcript 里全部存量 `.name:` 头) 必须永远剥得掉 —— 双态 HEADER_RE 长期保留, 不设退役期。受影响路径: quote 路由、read_chat 比对 (`canonContains`)、跨会话转发、rolepage 折叠。
- 企微 markdown 链接文本里的 emoji (`[🧙‍♂️ fix](url)`) 需实测渲染; 微信通道降文字路径同步实测。
- `parseEnvelope` / `withMsg` / `REMINDER_KINDS` / `TAIL_ORDER` **零改动** —— 表示层与信封层的分界就是本节的设计约束: **文本前缀只承担两件事** (quote 携带的路由信息、行首显式寻址), 其余一切机器判定 (轮次归属、回执、去向、提交见证) 仍只认 envelope 属性。
- 无数据迁移; 一版切表示 + 双态解析即完成。

---

## 2. 身份系统: 身份 = 角色 + workspace, 跨群隔离会话 (需求 ②) 〔重点 b〕

### 2.1 现在的机制

- target = `chat:xxx#slot` / `user:xxx#slot` (`shared/session-label.ts` tagOfKey/baseOfKey/keyOf): **身份绑死在「出生聊天的某条会话」上**。`daemon/wizard.ts` `WizardRecord` 以 target 为主键, 全局唯一 name 是地址; 一个 wizard = 一条会话。
- 跨群出现靠「从别的群点名」: `resolveName` (inbound.ts) 名册全局命中 → 投到那个 target; 回复 channel 落问话群 (`TurnDetailRecord.channel`), **但上下文仍是同一个 pane** —— A 群和 B 群对同一个 wizard 说话, 共享一份会话历史。
- 工作区: per-target `{runningCwd, pendingCwd, defaultCwd}` (mirror-bridge.ts:2734); 新会话落 `cfg.wrc.cwd` 默认兜底目录 → charter 的 cwdUnconfirmed 问句 → `set_workspace` 排 pendingCwd → `handoff` 重启 CLI 换目录 (index.ts:759/2673)。
- 管家 = 聊天的 untagged 默认会话 (`settleName` 取聊天名), charter `renderStewardRules`, topOnly 默认开时配 steward 手刹 (`daemon/steward-guard.ts`, approval.ts:2129 按 `!tagOfKey(owner)` 判)。
- 账本: routes.jsonl / message-events / tasks / plans 的 owner/receiver **全部是 target 字符串** (`referencedTargets` 注释明说: 这些只认字符串)。

### 2.2 改成什么

**两层模型**: 身份 (identity) 全局, 化身 (manifestation) 按聊天。

- `WizardRecord` 增加字段 `identity` (身份 id) + `role`; **同一身份的多条 wizard 记录 (每群一条) 共享 identity id**。target 字符串形状**不变** (`chat:xxx#slot` 里的 slot 语义变为「身份在该群的化身槽」), 因此 routes / message-events / tasks / plans 的 owner 全部无需改写, **兼容读旧账**。
- `identity` 的归组键 = **角色 + workspace** (`role` 是人给的职责名, `workspace` 是目录): 同角色同目录的两个调用点命名, 落到同一身份; 名字唯一性从 wizard 级**升到身份级** (`byName` → 身份; 寻址 `名字 → 身份 → 在当前 chat 的化身, 无则按身份的 workspace spawn`)。
- 「跨群隔离会话」= 同一身份在不同 chat 各有一条化身 (各自 pane / transcript / 上下文); peers / busy / roster 按身份聚合, 化身可展开。
- **set_workspace + handoff 流程退役**: workspace 是身份属性, 新化身的目录来自身份, 不再有「默认兜底目录」与 cwd 问句 (charter cwdUnconfirmed 段删除)。`set_workspace` 工具保留但语义变为「改身份的 workspace, 此后新建化身生效」; `handoff` 保留为纯上下文管理 (清上下文 + 简报), 不再是换目录必经路。
- 群管家指定: 见 §3。

### 2.3 落点

| 位置 | 改动 |
|---|---|
| `daemon/wizard.ts` | `WizardRecord` + `identity`/`role`/`kind` ("global-steward"|"steward"|"apprentice"|"worker"); `byName`/`claim`/`rename`/`evictStaleName` 唯一性升到身份级; `settleAll` boot 迁移; `drop` 拦截不可退役身份 (§7) |
| `daemon/inbound.ts` | `resolveName`: 名字 → 身份 → 本 chat 化身 / 新化身 (workspace = 身份的); 裸消息默认路由 → 当前管家 (§3) |
| `daemon/mirror-bridge.ts` | spawn 路径: 新化身目录取身份 workspace; `setPendingCwd` 语义降级 |
| `daemon/index.ts` | `set_workspace` handler 改写; handoff 的 workspaceSwitch 分支保留但不再是主路径 |
| `daemon/wizard.ts` charter | `renderCharter`: 「home 群」→「本化身所在群 + 身份的全部化身」; 删 cwd 问句 |
| `daemon/peers.ts` | 邻居发现: baseOfKey 同群 → 按身份聚合展示 |
| `shared/role-view.ts` | role id 支持 identity id: 身份页并置各化身轮次 (化身页保留) |

### 2.4 破坏性影响与迁移

- **旧账兼容 (关键设计)**: 存量每条 wizard 记录 1:1 生成身份 (identity id = 原 target 串, 稳定不变; role 缺省空, workspace = 该记录当前 cwd)。byName 行为不变 (一名一记录 → 一名一身份)。**routes.jsonl / message-events / tasks / plans 一个字不改**, 读回时 owner (target) 经注册表归并到身份; 新事件 owner 仍写「该轮所在化身」的 target。
- 迁移在 boot 时幂等执行 (迁移前备份 `wizards.json`); 迁移不产生新名字冲突 (1:1)。
- 破坏点: ① 跨群点名从此**不再共享上下文** (旧行为: 一个会话服务所有群) —— 这正是需求要的隔离, 但对依赖旧行为的存量习惯 (在 B 群续问 A 群开的话茬) 是行为变化, 发布说明要写; ② `resolveName` 的「本聊天新开 slot」兜底语义变化; ③ charter 措辞重渲染需要 config_set 式自动交接 (已有机制)。

---

## 3. 管家指定: 全局管家 → 群管家 (需求 ② 后半 + ④ 的一部分)

### 3.1 现在的机制: 新群首条消息 → auto-spawn 默认 wizard (untagged, 兜底目录) → cwd 问句 → set_workspace/handoff。管家 = untagged 会话, 无「指定」动作。

### 3.2 改成什么

- **全局管家** (`kind:"global-steward"`): 每个 bot 实例 boot 时保证存在 (home = defaultChat, workspace 人指定, 缺省 `~/.wezard/workspace`)。职责: 未绑定聊天的接待、管家指定的执行者、组团名单维护。它本身也是身份 × 聊天的化身模型 (在每个新群有自己的化身, 互隔离)。
- **指定**: 人在新群里对全局管家说「让 X 当这个群的管家」→ 全局管家落 `chatPolicy.<chat>.steward = "<身份名>"` (新配置字段, hot, 走 config-writer; 或封装 MCP `appoint_steward`)。绑定后该群裸消息路由到指定身份在本群的化身 (无则 spawn, 目录 = 身份 workspace)。
- **steward 手刹跟随绑定**: approval.ts:2129 的判定从「untagged target」改为「该 chat 绑定的管家化身」; 未绑定的聊天不 arm 手刹 (全局管家有单独的接待纪律)。
- 新群不再 auto-spawn 兜底目录 wizard; `/new` 在管家化身上仍是「本化身重开」。

### 3.3 落点 / 迁移

- `shared/config.ts` `ChatPolicy` + `steward?: string`; `daemon/chat-name.ts` `chatPolicyOf` 透出; `daemon/index.ts` 路由默认值 + boot 迁移; `daemon/approval.ts` 手刹判定; charter `renderStewardRules` 措辞 (L1 语义照旧)。
- 迁移: boot 时把每个存量聊天的 untagged wizard 自动写进该聊天的运行时绑定 (行为不变), 不自动写 config 落盘 —— 人显式改过才落盘 (推荐口径, 见待人拍板 ⑤ 附注)。

---

## 4. roster 金字塔: 渐进式披露 (需求 ③)

### 4.1 现在的机制: `renderRoster` (wizard.ts) 平铺一行一个 (名/状态/群/目录/模型/ctx/家谱 + 职责/专长/最近摘要/在飞); `wizard_roster` 有 query/chat 收窄; charter 出生名册 ROSTER_MAX=15 快照。全机 1154 个身份时平铺不可用。

### 4.2 改成什么

| 层 | 名字 | 内容 | 行数 / token 预算 | 触发 |
|---|---|---|---|---|
| L0 | 在场 | 我 + 本群管家 + 学徒 + 本 chat 48h 活跃化身, 各一行; 尾行汇总「全机 N 身份 · M 群 · 忙 x 闲 y 冷 z」 | ≤12 行 / ~500 tok | 默认返回 |
| L1 | 本群 | 本 chat 全部化身 (含冷), 含家谱关系 | ≤40 行 / ~1500 tok | `wizard_roster({chat:…})` 或 L0 尾行的展开提示 |
| L2 | 组团 | 按聊天分组的全机身份概览 (无 summary/turns) | ≤60 行 / ~2500 tok | `wizard_roster({scope:"all"})` |
| L3 | 个体 | 单个身份详情 | — | `peek_peer` (已有, 不变) |

- **自动降级**: 调用方 ctx ≥ `handoffAt(model)` 或结果超预算 → 只回 L0 + 收窄建议; 管家 (本轮 steward 角色) 调用默认 L0。
- **升级**: 显式参数; L0 汇总行做 fuzzy miss 提示 (叫的名字在 L1/L2 时给一行「该身份存在, 用 … 展开」)。
- charter 出生名册缩为 L0 快照 (ROSTER_MAX 15 → 8: 同群活跃 + 全局管家 + 学徒)。

### 4.3 落点: `daemon/wizard.ts` (renderRoster 分层 + rosterLines)、`daemon/index.ts` /wizard/roster (参数 + 预算选择)、`mcp/tools.ts` 描述、charter。破坏性: 无数据迁移; `wizard_roster` 返回形状变短 (调用方是模型, 描述里写清分层即可)。

---

## 5. 组团: 一个机器人 = 一个团队 (需求 ④)

### 5.1 现在的机制: 一实例一 bot (进程隔离, `bots[]` 仅 legacy); 每聊天的默认会话即「该群的管家」, 各群互相独立, 无 bot 级接待层; topOnly 默认开把群内交互压到管家一层。

### 5.2 改成什么

- **组团 = 本 bot 实例名下全部身份的集合** (roster L2 即组团视图); `sameBot` 隔离保留 —— 跨 bot 只在 channel 相见 (§6)。
- **bot 会话的初步接待 = 全局管家** (§3): 任何未绑定管家的聊天/频道/私聊, 首条消息落全局管家的化身; 它绑定指定管家后, 后续消息进指定管家 (按群隔离会话 = §2 化身模型, 天然满足)。
- 组团内权限: 管家指定、身份建档建议 (spawn 时的 role/workspace 提案)、跨群调度 (把某身份引到新群) 都收在全局管家; 普通身份照旧横向协作。
- 多 bot (多实例): 组团即实例; 实例间零共享 (现状口径不变, 见记忆「多 bot 要硬隔离」)。

### 5.3 落点 / 破坏 / 迁移: 同 §3 (组团是 §2+§3 的视图, 无独立数据结构); `/chats` (index.ts:4104) 升级为组团视图; charter 里补一段「本组团」(全局管家与管家的章程带, 普通身份只带 L0)。

---

## 6. channel: 与其他机器人沟通协作 (需求 ⑤)

### 6.1 现在的机制: `daemon/channel.ts` 把 topic 事件伪装成 group 消息 (`dispatch` 造 fake frame: chatid=topicId, chattype=group) → 走普通 inbound/mirror 路径, 频道即 `chat:<topic_id>`。每 bot 一个「判官」(-p 一次性进程, runJudgeOnce) 决定该不该回应, 放行才交给主 wizard; 出站 send_post/send_reply, 审批卡改投问话人私聊 (lastAsker), 未被 @ 的帖只能主动发 (replyOk)。他 bot 作者在缓存里是 `bot:<aibotid>` (authorOf), 本地缓存 ChannelStore + read_channel 可读。同 bot wizard 互相看得见 (`sameBot`), 跨 bot 无寻径 —— 频道是唯一总线。

### 6.2 改成什么

- **频道 = 该 bot 的一个「群」**, 完整套用 §2/§3: 全局管家接待新频道 → 指定 channel 管家 (`chatPolicy.<topic-chat>.steward`), 该身份在此频道的化身按群隔离。
- **感知其他机器人**: 判官 prompt 的 others 段 (buildJudgePrompt 现在只列同 bot wizard) 扩展为含 `bot:` 作者; channel 管家的 charter / 注入上下文附「本频道最近活跃的机器人」(从 ChannelStore 聚合)。`read_channel` 已能读全文。
- **沟通**: 出站 post/reply 即与他 bot 通信 (机制已通); 跨 bot 身份映射 = `bot:<aibotid>` 稳定 id + 消息头 `🧙‍♂️ name：` 自称名 (§1 的新表示在频道里成为跨 bot 事实上的自我介绍协议) —— 不做主动发现协议 (待人拍板 ②)。
- **判官演进**: 仍做第一道「该不该本 bot 答」; 放行后不再进「默认会话」而是进 channel 管家化身 (组团内再分派)。
- 审批卡投私聊 (lastAsker)、replyOk、频道历史缓存/回填全部照旧。

### 6.3 落点: `daemon/channel.ts` (dispatch 目标 = 管家化身; judge prompt others 段)、`daemon/channel-context.ts` (上下文附 bot 作者聚合)、§3 的绑定表。破坏性: 频道路由目标从「频道默认会话」变为「频道管家化身」—— 存量频道 boot 迁移同 §3.3。迁移: 判官/缓存/出站零迁移。

---

## 7. 学徒: 全局唯一、代表人、主动做事、连续唯一会话 (需求 ⑥) 〔重点 c〕

### 7.1 现在的机制 (冲突点清单)

- 身份可退役 (`drop`/forget)、可被 `evictStaleName` 顶名、pane 回收保身份但杀 pane;`/new`/context cut 后靠 `armCharter` 重注入宪章 —— 身份存活, 上下文丢失是常态。
- `handoff`: 清上下文 + 简报重开 (identity 不动) —— 与「连续身份」兼容, 与「连续上下文」冲突。
- 定时任务 `promptWantsFreshWizard` (tasks.ts) 会把「建一个 wizard 去…」解释成 fresh 白板执行体; `fresh:true` 每次新建白板。
- 审批: 会话级 auto-allow window (`allow_window`) 与 skipAll 是按会话记忆的豁免。

### 7.2 改成什么

- **身份**: `kind:"apprentice"`, 每 bot 实例全局唯一 (boot 保证存在, 名字人定, 缺省「学徒」); workspace 人指定 (缺省 `~`); home = 与 owner 的单聊 (`user:<owner>`), 不属于任何群/组团, 但可被人授权进群发言。
- **连续且唯一的会话**: 唯一 manifestation —— `/new` 对学徒禁用 (CLI 侧拦不住就 daemon 拦: 学徒的 /new 改为「整理记忆 + 原会话继续」); pane 死亡 → respawn 同身份 (memory 保留, transcript --resume 接续); `drop`/`evictStaleName`/`stop_wizard` 逻辑退役对 `kind:"apprentice"` 一律拒绝。
- **与 handoff / context cut 的相处**: handoff 保留为学徒的**上下文管理工具** (简报压缩), 但: ① 学徒的 charter 写死「交接前先 wizard_remember」; ② 学徒的提醒线提前 (`handoffAt` 打五折), 鼓励小步交接而非撑满; ③ context cut 时 armCharter 重注入 (已有机制) + 附「你是学徒, 连续身份」句。
- **输入源与主动做事的触发面**: ① 人私聊 bot 点名学徒 (待人拍板 ③: 私聊默认接待是全局管家还是学徒 —— 推荐全局管家, 学徒被点名才上); ② scheduler: `schedule_task` 以学徒为 target, `promptWantsFreshWizard` 对学徒 target 强制 false、TaskRecord.fresh 拒绝; ③ 管家/全局管家/人 `tell_peer` 派活; ④ 自主巡检: 学徒可给自己 schedule_task (定时汇总/巡检/备忘)。
- **与组团/群管家的权限关系**: 学徒**代表人** → 读面全量 (roster/read_chat 与全局管家同级), 不受 steward 手刹 (它不是管家); 写面照常走审批卡, **卡永远到人** —— 学徒会话禁用 auto-allow window 与 skipAll 豁免 (approval.ts 会话豁免记录处按 kind 拦); 群管家可横向派活给学徒, 学徒进群发言带 `🧙‍♂️ 学徒：` 头。

### 7.3 落点 / 破坏 / 迁移

- `daemon/wizard.ts` (kind 字段 + drop/evict 拦截 + 唯一性保留名)、`daemon/tasks.ts` (fresh 豁免)、`daemon/approval.ts` (会话豁免拦截)、`daemon/spawn-tmux.ts` + mirror-bridge (学徒 respawn 同身份)、`daemon/inbound.ts` (私聊接待)、charter 学徒节。
- 破坏: `promptWantsFreshWizard` 的例外是第一条「角色感知」进调度器; 学徒禁 /new 是行为收紧。
- 迁移: 新概念无旧账; boot 建档一次, 幂等。

---

## 8. 分阶段实施 plan

> 阶段边界 = 能被独立验收; 括号内为依赖。**先改身份寻址还是先改表示**: 先改表示 (P1) —— 它纯渲染 + 双态解析、无数据迁移、验收直观, 且新表示是后续所有阶段 UI 面的统一语言; 身份寻址 (P2) 是 P3-P6 的地基, 紧随其后。

| 阶段 | 内容 | 依赖 | 验收标准 |
|---|---|---|---|
| **P0** | v3 分支 + 本设计稿入库 | — | 本文档在 v3 分支; 人确认设计 |
| **P1** | 表示层 (§1) | 无 | ① 全部出站路径 (气泡/审批卡徽标/notify/help) 新头; ② quote 旧气泡仍路由 (parseTagHeader 双态单测); ③ 行首 `.name` 与 `🧙‍♂️ name` 双寻址; ④ parseEnvelope/withMsg 零改动回归; ⑤ md-chunk 不切 emoji + 分页预算复核; ⑥ rolepage/read_chat/roster 一致; ⑦ 企微/微信 markdown 实测 |
| **P2** | 身份系统 (§2) | P1 (仅表示统一, 可并行) | ① boot 幂等迁移 (备份 + 1:1 + identity 字段); ② 同一身份两个群两化身互不串 (路由/回执/信封回归); ③ 旧 routes/message-events replay 不炸; ④ byName 唯一性升级; ⑤ charter 无 cwd 问句 |
| **P3** | 组团与管家指定 (§3/§5) | P2 | ① 新群首条 → 全局管家; ② 指定后裸消息进指定管家化身; ③ 存量群行为不变 (自动绑定); ④ steward 手刹跟随绑定; ⑤ set_workspace+handoff 旧流程不再触发 |
| **P4** | roster 金字塔 (§4) | P2 (渲染部分可提前) | L0/L1/L2 行数与 token 实测达标; 自动降级触发; charter 名册 L0 化; fuzzy miss 提示 |
| **P5** | channel 组团化 (§6) | P2+P3 | 频道消息落 channel 管家化身; 判官放行路径回归; 他 bot 感知行; 双 bot 实例频道通信实测 |
| **P6** | 学徒 (§7) | P2 (可与 P4/P5 并行) | 唯一性 (重名/重生/退役全被拦); pane 死亡 → 同身份 respawn 且记忆保留; fresh 豁免; 会话豁免禁用; 定时触发落唯一会话 |

**第一个建议做的阶段: P1** (理由如上引言)。

---

## 9. 待人拍板 (有歧义处给推荐, 不自作主张)

1. **quote 语义收紧程度** (需求 ①): 「只有 quote 才是直接回答」是否意味着**废除**行首 `.name` / `🧙‍♂️ name` 点名寻址? 推荐**保留**行首点名 (与 quote 等价): 移动端手打 emoji/quote 都不便, 保留是纯增量; 被废的只是「裸消息落默认 wizard」这一旧默认 (改为落管家)。
2. **跨机器人身份映射** (需求 ⑤): 没有中心名册可用。推荐只认 `bot:<aibotid>` 稳定 id + 消息头 `🧙‍♂️ name：` 自称名 (被动、零协议); 若要更强 (频道置顶自我介绍帖 / 发现协议) 需要他 bot 侧配合, 跨团队协调成本高。
3. **学徒的默认接待面** (需求 ⑥): 人私聊 bot 时, 默认接待是全局管家还是学徒? 推荐全局管家 (与群聊一致的组团入口), 学徒被点名/定时/被派活才启动轮次。
4. **学徒的粒度**: 「全局唯一」按 bot 实例还是按机器? 推荐**每 bot 实例一个** (与「组团 = 实例」对齐; 多实例下每组团一个, 各代表各自 owner 的利益)。
5. **存量群的管家绑定是否落盘**: boot 自动绑定推荐只写运行时表 (`/chats` 可见), 人显式指定过才写 config —— 避免一次迁移把所有人的 config 都改了。附注: 同一身份可否管家多个群 —— 推荐**可以** (这正是「身份 × 聊天」化身模型的自然结果, 每群一个化身)。
6. **正文提及的表示** (需求 ① 附带): 正文里指 `.fix` 的提及是否也换 `🧙‍♂️ fix`? 推荐换 (单一人机语言), 但工具参数永远收裸名。
