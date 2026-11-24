# room ↔ 信息源多对一绑定 · 设计稿

状态: **待拍板** (未写实现)。分支基于当前 main; 改动面见 §10。

## 0. 背景与问题

人的原话 (2026-11-24):

> 在 channel room 里说话时, room host 好像没有处理, 直接新起一个 room 和 host 接待了。预期是 room host 在自己收到了信息之后再判断: 自己处理 / 新起 room。为此彻底加一个新能力: 允许企业微信里的群聊和 channel 里的 topic 与 wezard room 变成多对一的关系 —— 一个 room 可以绑定多个信息源, 并可以灵活地在多个信息源里回复。应用: ① channel host 判定是自己的任务, 就直接绑定自己要回复的这个帖子的 topic 进当前的 room; ② host 判定这个对话和之前的某个 room 高度相关, 也可以绑定。绑定时要看条件和相关程度, 与「是否复用已有 wizard」的逻辑相通。

现状追踪 (为什么人会看到「直接新起 room 和 host」):

- 频道里 @ 机器人: 企微两路推帧 —— 原生帧 (chatid = 帖子自己的 opk… 群) 与 topic_at_bot 事件。
- 原生帧进 `daemon/inbound.ts` → `route()` → `resolve(chat:opk…)` → `stewardReception` (`daemon/steward.ts` `stewardRoute`): 该 base 无绑定化身 → `openManifestation` 领号新开一个实例。
- 同句 topic_at_bot 配上对 → `daemon/channel.ts` `postBorn` → `daemon/index.ts` `channelPostBorn`: 建帖子 room + 该新实例坐 host + 起 monitor。
- **频道 room 的 host 全程没有被问过**: 帖子 room 的诞生与接待是配对事件的确定性副作用, 没有任何判定环节。没被 @ 的新帖/评论才落频道 room (行带 post) 由 monitor 判激活 —— 那条路已经有「先落接待处、再判」的形状, @ 路径没有。

## 1. 现状模型速写

- room id = base principal 原样 (`chat:<topic_id>` 频道 / `chat:<opk…>` 帖子 / `chat:<群id>` 群 / `user:…` 单聊); 账本 `<stateDir>/rooms/<id>.jsonl`; 状态 = fold (`shared/room.ts`)。
- **room 与信息源是恒等关系** (1:1), 没有绑定概念: 源 = room, room = 源。`isBoundRoom` = 非 dm/adhoc。
- 出站 `roomMirror` (`daemon/index.ts`) 按 **row.room** 分流: 频道 room → `channelOutboundOf` (re 到带 post 的行 = 评论回原帖, 其余 = 新帖); 帖子 room → 一律评论根帖; 其余 → 群消息。**出站只看 room, 不知道「这通对话发生在哪个源」**。
- 管家绑定: 频道级 `wrc.channel.steward.<topic_id> = 类名`; 帖子 → 频道经 `daemon/channel-posts.ts` 的 {channel, post} 映射复用同一个类, 但**实例按 room 各开** (人 2026-11-23: 不把频道 room 的实例拉进帖子 room)。

## 2. 目标 / 非目标

目标:
1. **源与 room 解耦**: 一个 room 可绑定多个信息源 (多对一); 消息按绑定落进 room, 回复按「对话发生的源」回出去。
2. **接待由 host 判定**: 新源首触不再自动开 room + 新实例; 落在接待处 (reception), 由收到消息的 host 判定: 自己处理 (绑进本 room) / 绑进高度相关的旧 room / 另起 room (现行为)。
3. 判定有据: 绑定/推荐时给出证据与相关度 (与 `delegate`/`route_candidates` 的证据体系同构), 带阈值与硬门。
4. 存量兼容: 现有 1:1 (恒等) 行为一比特不变; reload 自愈; 不 push、不 reload, 部署时机人定。

非目标 (本轮不做):
- 单聊 (`user:…`) 作为可绑定源 (人只点了群聊与 channel topic; 单聊本身就是「一人的 room」, 收益低, 后续再议)。
- 一源多 room (多对多): **一个源同一时刻只绑一个 room** (§5 硬门), 多对一而不是多对多。
- 跨 bot 绑定 (源属 bot A 的 room 绑进 bot B 的 room) —— 硬门拒绝。
- 帖子 room 之间共用实例 (人 2026-11-23 已拍板各开实例; 本设计不改实例归属, 只改「话落哪个 room / 回哪个源」)。

## 3. 数据模型

### 3.1 概念分离

- **source (信息源)**: 企微侧的一个收发地址 = base principal。本轮可绑定: `chat:<群id>` (群) · `chat:<opk…>` (频道帖子)。频道 (`chat:<topic_id>`) 本身就是 room, 不需要绑自己。
- **room**: 账本与成员/duty 的容器 (不变)。
- **主源 (primary)**: room id 对应的那个源。**副源 (secondary)**: 经绑定落进本 room 的其余源。room id 规则不变 = 主源 principal —— `isBoundRoom` / 消息 id / 存量账本文件 / chatPolicy / chat-name 全部零换键。

### 3.2 绑定的存储 (推荐 A, 待拍板)

**A. 账本 op 为唯一事实 (推荐)**: 新 op 落进**目标 room** 的账本, fold 出 `RoomState.bindings`:

```ts
{ op: "bind";   at; room; source: string /*副源 base*/; by: Who; why?: string }
{ op: "unbind"; at; room; source: string; by: Who; why?: string }
// fold: bindings: Map<source, { at; by; why? }>  (unbind 删条目)
```

- 与契约「room 状态 = 账本 fold, 不读别处」同构; 审计天然在账本里 (谁在何时为什么把哪个源绑进来); replay/重放一致。
- daemon 内存维护 **source → roomId 索引**: boot 扫 `rooms/*.jsonl` 折出全部 bind (纯缓存, 可重建)。配 **对账闸**: boot 重建后与逐 room fold 的 bindings 全量比对, 差一笔就 fail-closed 拒绝绑定写 (路由回落恒等, 不炸主流程) —— 「内存态 = 盘上重放」的硬约束。
- 成本: boot 多读全部账本 (现状 lazy; 数量级 ~百以内, 每文件几十 KB, 可接受。若将来量大再加固化缓存, 闸不变)。

**B. 侧表为事实** (`room-sources.json`, 风格同 `channel-posts.json`): 简单、boot 快, 但账本外出现第二份「谁绑在哪」的事实, 与契约相抵触, 且审计要另写 system 行 → 双写漂移面。不推荐, 列为备选。

### 3.3 行级: `src` 字段

`MsgRow.src?: string` —— 这一行**从哪个源进来** (副源 base); 缺省 = 主源 (= room id, 不落字段)。频道 room 已有的 `post` 字段语义不变 (它是频道内「帖子」细分, 与 src 正交: 频道 room 的行 src 恒缺省)。判据统一:

- 入站: 落行时由 daemon 按实际入口写死 (重放不再推断, 与 `closes`/`to` 同纪律)。
- 出站: re 到 `<id>` → 查那条行的 src = **这通对话的源** (§4.2)。

## 4. 路由

### 4.1 入站 (源 → room)

```
roomOf(source) = bindIndex.get(source) ?? source        // 恒等回落 = 存量行为
```

改动点:
- `daemon/index.ts` 人话落 room 的口子 (`channelIngest` / 群路径 `dispatch` 前的 room 解析): 先查索引。
- **频道 @ 机器人首触改走接待**: 原生帧配对成功 (`postBorn`) 时**不再自动开帖子 room + 新实例**; 人话落频道 room (行带 post + `mention:"bot"` + `src: chat:<opk…>`), 直达频道 room 的 host。host 判定 (§5) 才决定帖子 room 诞不诞生 / 绑不绑。未配上对的兜底路径同此 (落频道 room, 现状本就如此)。
- `stewardReception` 只对**恒等路径** (未被绑定的源) 生效 —— 源已绑进 room R 时, 裸消息的接待对象 = **R 的 host** (不是源的类绑定化身); `stewardRoute` 增加「先查绑定索引」一步。

### 4.2 出站 (room → 源)

`roomMirror` 的分流依据从「row.room」改为「**本行的目标源**」:

| 行 | 目标源 | 传输 |
|---|---|---|
| `reply` re 到 `<id>` | 那条行的 `src` (缺省 = 主源) | 按源类型: 帖子源 → `send_reply` 评论根帖; 群源 → 群消息; 频道主源 → 现行 `channelOutboundOf` 不变 |
| `say` / `file` / notify | **主源** (缺省) | 同上按主源类型 |
| 占位气泡覆盖 | 人话行的发生源 (那条行的 src) | 现行 cover 机制, 换成按 src 找流 |

- 帖子源的 `{channel, post}` 仍从 `channel-posts.json` 查 —— 绑定不改企微侧地址, 只改「话进哪个账本」。
- 主动发往**副源** (非 re 场景): 本轮不给 say 加 source 参数 (非目标, 保持最小面); 需要时 re 那个源里的行即可。
- 出站无额度 (出站预算已于 2026-11-20 删除); 副源多了以后一个 room 可能集中打一个源 —— 观察后再议是否加按源上限 (待拍板 §11-4)。

## 5. host 判定 (绑定的决策面)

### 5.1 决策时刻

**新源首触 reception**: 频道 @ 首触 (§4.1) 落频道 room 唤醒 host 时。host 三个出口:

1. **自己处理** → `room_bind({source: "chat:<opk…>", room: 本room})`: 之后该帖子的评论全落本 room, 本 room 的 re 回复以评论回原帖。帖子 room 不诞生, 不开新实例。
2. **高度相关的旧 room** → host 依证据 (§5.2) 判给某个旧 room (典型: 之前那个帖子 room / 之前那个群 room): 绑进它 (权限见 §6), 或 `chat_ask` 那个 room 的 host 让它接手判定。
3. **另起 room** → 帖子 room 诞生 + 领号新实例 (今天的行为), 并且**把新 host 实例同步拉进频道 room** (人 2026-11-24 追加): 走 hub 正常 join (via `spawn`, by = 判定者 —— host 本人或超时兜底时 DAEMON), 不走 join-req 等批。频道 host 从此在成员表里看得到每个帖子 host —— 判定新消息落哪个已有帖子 room / 复用哪个实例的「已知成员」视图。
   - 拉进来的是**普通成员**: ord = nextOrd, 频道 host (最早加入序) 的 host 身份不动; 不订阅 (`watch` 默认关), 频道里未点名的人话按 §B-3 只醒 monitor/host, **不会唤醒它**; 被点名则照常醒 (频道 host 与它横向沟通的通道)。

**兜底**: host 被唤醒后 `rooms.binding.decideTimeoutMin` (缺省 10) 内没有 bind 也没有显式「另起」→ daemon 自动走出口 3 (不丢话、不卡接待: 现行行为就是兜底)。监督线: overdue 两级提醒照常生效。

### 5.2 证据与相关度 (与复用 wizard 同构)

`room_bind` 不带参数 dry-run (或配一个 `binding_candidates` 只读工具) 时, daemon 给出**候选 room + 证据行**, 排序与否决与 `route_candidates` 同一套词汇:

| 证据 (强→弱) | 说明 |
|---|---|
| 同 asker | 发话人在候选 room 近期说过话 (行作者匹配) |
| 正文相关 | 入站正文 vs 候选 room 近期 N 行的规范化 trigram 重叠率 (阈值 `simMin`, 缺省 0.3) |
| 职责匹配 | 候选 room host 的 responsibility / charter 与正文关键词 |
| 近期接待 | 该源的历史消息曾落在候选 room (解绑再来的回访) |

否决 (veto, daemon 硬判): 目标 room host 不在座 (空 room) · 目标 room 近 `busyWindowMin` 无活动且未结 duty 为 0 (死 room) · 跨 bot · 源已绑在别处。

**硬门 (daemon, 判定面之外)**: ① 同 bot; ② 源未被绑定 (一源一 room, 想换先 unbind); ③ 目标 room 存在且有 host; ④ 源类型 ∈ {群, 帖子}; ⑤ 源不能是目标 room 的主源 (恒等没意义)。

阈值归 `rooms.binding.*` 配置 (simMin / decideTimeoutMin / busyWindowMin), 全部 hot-read。

### 5.3 与「复用已有 wizard」的关系

| | 复用 wizard (delegate/route_candidates) | 绑定源 (本设计) |
|---|---|---|
| 复用什么 | 身份 (哪个 wizard 干) | 对话 (哪份账本承载) |
| 判定者 | daemon `decide` 确定性取首个 + veto | **host 模型判**, daemon 只给证据 + 硬门 |
| 成本线 | 冷缓存大 ctx → 唤醒成本 | 绑定 = 0 新实例 (省一份上下文); 另起 = 新实例一份 |
| 否决词 | 弱证据 / busy / 不值 / 冷缓存 | 空 room / 死 room / 跨 bot / 已绑定 |

共用心法: 证据分层 + 硬否决 + 成本显式; 绑定判定**故意**留给模型 (相关度是语义判断), 不做确定性 decide。

## 6. 权限与审计

- `room_bind` / `room_unbind`: 目标 room 的 **host 或人** 可写; 判定 host 不是目标 room 的 host 时 (场景②) —— **待拍板 §11-3**: A. 必须先 `chat_ask` 目标 host (推荐, 与协作纪律一致) / B. 允许直接绑, daemon 写 system 行通知目标 host。
- 审计 = bind op 本身 (by/why 在行上); rolepage 在 room 卡片列绑定的源 (读 fold)。
- 工具面三处联动 (docs/dev-guide.md 清单): `mcp/tools.ts` 注册 + `daemon/` 路由 + `renderCharter` 一行 (何时用 / 谁能绑 / 解绑回落)。

## 7. 兼容 / 自愈 / 迁移

- **存量零数据迁移**: 无绑定 → 恒等回落, 现行为逐字节不变。唯一「迁移」是 boot 索引重建 + 对账闸 (§3.2), 属代码路径非数据改写; 红线照走: 线上先备份 `~/.wezard/state/rooms` (字节原样), 演练至少一遍真 daemon (临时 HOME + 临时端口) 验「内存索引 = 账本重放」。
- reload: bind 索引随 boot 重建; 在途轮次不受影响 (行上 src 已落死)。
- 解绑: 源回落恒等 —— 帖子源下一条消息时帖子 room 才按需诞生 (现行 lazy 语义); 群源回到自己的 1:1 room (原 room 与管家实例原样保留, 解绑即恢复)。
- **频道成员补拉自愈**: boot (与 `settleBoundChannel` / `channel-rebind` 同钩子) 幂等补拉**存量**帖子 room 的 host 实例进频道 room —— 条件: 频道已绑定、频道 room 有 host、实例仍在册 (stop/忘掉的跳过)。与 channel-rebind 的补座位同风格; 一频道一帖一实例本是现状实例数, 成员表变长只是把它们显出来。若频道 room 尚无 wizard host (引导期), 不拉 —— 首个被拉者会按最早序变成 host。
- `channel-rebind` (频道换绑工作区) 正交: 换的是类与实例; 本设计换的是话的去处。帖子源被绑进别的 room 时, 频道换绑不动绑定。
- 出站占位气泡 / 审批卡 / AskUserQuestion: 按「发生源」路由 (§4.2 表), 审批卡投 asker 私聊的现行逻辑不变。

## 8. 分阶段实施 (plan 骨架, 定稿后建 plan)

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 模型 | `bind/unbind` op + fold `bindings` + `src` 字段 + boot 索引与对账闸 | 单测: fold/重放/对账闸 fail-closed; 存量账本 fold 不变 (哈希对比) |
| P2 出站 | `roomMirror` 按行 src 分流 (reply 跟线程, say 主源) | 回归: 现有群/频道/帖子出站全绿 (src 缺省路径 = 现行为) |
| P3 频道首触 | @ 首触落频道 room + 超时兜底另起 + `room_bind/unbind` 工具 + 硬门 + 另起时新 host 拉进频道 room (join) | 真机: 频道 @ 一句 → host 收到; bind → 后续评论落本 room、回复评论回原帖; unbind → 回落; 另起 → 新 host 出现在频道成员表, 未点名人话不醒它, 频道 host 身份不变 |
| P4 群源 + 证据 | 群源绑定入站路径 + dry-run 证据/阈值/veto | 真机: 群绑进旧 room、对话两向通; 跨 bot/已绑定被拒 |
| 收口 | charter 行 + dev-guide 清单 + CHANGELOG Unreleased + build/测试全绿 | 交付另报, 不 push 不 reload |

## 9. 风险

- 首触延迟: host 忙时接待要等它本轮结束 (唤醒泵既有语义), 超时兜底兜住最坏情况 = 现行为。
- 频道 room 变高流量: 绑多个热帖后一个 room 承多源, 出站集中打一个源 —— 观察项 (§11-4)。
- `src` 是新行字段: 老账本无 src, 读侧一律回落主源, 与 `post` 的读法同纪律。

## 10. 改动面清单 (实现时核对)

`shared/room.ts` (op/fold/judge 硬门/读侧) · `daemon/rooms.ts` (索引装载) · `daemon/index.ts` (roomMirror 分流 / channelIngest / channelPostBorn 延迟+新 host 拉进频道 room / settleBoundChannel boot 补拉 / ensureBoundRoom 查索引) · `daemon/steward.ts` (stewardRoute 查索引) · `daemon/inbound.ts` (dispatch 前源解析) · `mcp/tools.ts` + `daemon/room-bind.ts` (新) · `shared/config.ts` (rooms.binding.*) · `daemon/wizard.ts` charter 行 · web/rolepage 绑定展示 · docs/dev-guide.md · CHANGELOG。

## 11. 待人拍板

1. **绑定存储**: A 账本 op + boot 索引 (推荐, 契约同构) / B 侧表。
2. **首触超时**: host 10 分钟不判 → 自动另起 room (推荐) —— 时长与「不判就兜底」本身是否接受。
3. **跨 room 绑定权限**: 场景②里判定 host 绑进别人的 room: A 先 chat_ask 目标 host (推荐) / B 直接绑 + 通知。
4. **按源限流**: 出站已无额度, 副源集中时是否要加按源上限。
5. **解绑语义**: 帖子源解绑后帖子 room 保持「下一条消息时才诞生」(推荐) 还是立即补开。
