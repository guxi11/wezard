# 频道改造: 每个 topic 一个 room · 频道只留 host 身份绑定 · 图上框出频道 —— 设计稿

状态: **设计稿 (待 admin 拍板 §9)**; 未写实现。lead = `.VictorNash`。取代 `docs/room/multi-source-binding.md` 里「频道首触接待」那一半 (§4.1 / §5.1) 与 `docs/room/channel-monitor.md` 里「频道 room」的那一半; 群源绑定 (P4) 不在本次删除范围。

admin 原话 (经 `.wezard-1` 转): 「另外，在channel里，我想了下，感觉还是每个topic起一个room吧，channel可以没有room，仅能绑定一种host身份关系。按照这个方向重新调整。可视化的部分，把一个channel内的room框起来」

术语沿用 channel-monitor.md: **频道** = 企微 channel (代码 `topic_id`); **帖子 / topic** = 频道里的一条帖 (代码 `post_id`; 原生 @ 帧的 chatid 是帖子自己的 `chat:opk…`)。

## 0. 现状 (以代码为准)

| 东西 | 现在 |
|---|---|
| 频道 room | `chat:<topic_id>`, kind `channel`。没 @ 的新帖、还没配上 opk 的评论、频道 @ 的**首触**都落这里 (行带 `post` / `src` / `mention`) |
| 帖子 room | `chat:<opk…>`, kind `topic-post`; 只有在帖子被 @ 过 (原生帧 ↔ topic_at_bot 配上对, 才知道 opk) **并且** host `room_fork` / 超时兜底 (`rooms.binding.decideTimeoutMin`) 之后才诞生 |
| 首触判定 | 频道 host 被唤醒, 三条出口: `room_bind` 把帖子源绑进本 room / `chat_ask` 别的 host 绑 / `room_fork` 另起; 不判 → 10 分钟后自动另起 (`decideOnFirstTouch` / `pendingFirstTouches`) |
| 频道 → host | `wrc.channel.steward.<topic_id>` = 管家**类名**; 每个 room 坐这个类在**本 room** 的实例 (人 2026-11-23) |
| 帖子 host 进频道 room | 另起时新 host 以普通成员拉进频道 room; boot 补拉 (`planChannelBackfill`) |
| 出站 | 频道 room: `chat_say` = 发新帖, `chat_reply` re 到带 `post` 的行 = 评论原帖; 帖子 room: 一律评论根帖 |
| 引导 | 未绑定频道: 引导化身 `chat:<topic_id>#guide` 住频道 room, `onboard_bind` 写 `wrc.channel.steward`, 之后 `settleBoundChannel` 给频道 room 与各帖子 room 坐实例 |
| perceptron | 每个有 wizard 成员的 bound room 懒建一个 (`keyOf(room,"monitor")`), 引导期不建 |
| 图 | 频道 room 与帖子 room 都是普通节点, 帖子 → 频道一条弱连线 (`r.channel.id`), **无容器** (channel-monitor.md §2.5 当时明确「不画容器」—— 本次 admin 推翻) |

问题: 一个帖子的话被拆成两本账 (首触 / 未配对评论在频道 room, 之后在帖子 room); 帖子 room 的诞生取决于「有没有人 @ 过」与「host 判没判」, 是多余的决策面。

## 1. 结论 (推荐)

1. **每个帖子从第一条事件起就是它自己的 room** (新帖 / 评论 / @ 都直接落它), 不再有「先落频道再判」。
2. **频道没有 room**。频道剩下的只有一条事实: **频道 → host 身份** (`wrc.channel.steward.<topic_id>` = 类名, 现有配置项, 不新增存储)。
3. topic room 的 host = 该身份在**本 room** 的实例 (沿用 2026-11-23 「不同 room 不同实例」), 不预起 pane, 首次唤醒冷启动。
4. 删: 频道首触接待、`room_fork`、`rooms.binding.decideTimeoutMin`、帖子源 `room_bind`、帖子 host 补拉进频道 room。**BREAKING**, 见 §7。
5. 留: 群源 `room_bind` / `room_unbind` (P4, 与频道无关)、`read_channel` (频道历史仍有用, 按 topic_id 读)、perceptron 机制。
6. 图: 同一频道的 topic room 用一个**框** (hull) 包起来, 框标题 = 频道名 + 🎩 host 身份; 旧频道 room (存量, 只读) 画在框内的角上。

## 2. 数据模型

### 2.1 topic room id —— 由 (topic_id, post_id) 决定, 不再由 opk 决定

```
topicRoomId(topic, post) = "topic:" + topic + "/" + post        // 新建一律用它
```

- **为什么不是 `chat:<opk…>`**: opk 只在帖子被 @ 过、两路帧配上对之后才知道; 没 @ 过的帖子永远没有 opk。room id 必须在第一条事件 (topic_event 新帖) 就能算出, 且之后被 @ 也不变 —— 只有 (topic_id, post_id) 满足。opk 降级为**入站别名** (原生 @ 帧 chatid → 哪个 topic room), 存在 `channel-posts.json` 里 (现状已存 `opk → {channel, post}`)。
- 新前缀 `topic:` 的好处: 频道归属从 id 本身就读得出 (`topic:<T>/<P>` → 频道 T), 读模型 / 图分组不再查 channel-posts 映射; `isBoundRoom` (非 dm / adhoc) 自然为真; 不含 `#`, `keyOf` / `baseOfKey` 照常 (实例 target = `topic:T/P#<实例名>`); 文件名走 `encodeURIComponent`。
- 代价: 审一遍 `startsWith("chat:")` / `/^(user|chat|group):/` 的 37 处 (11 个文件), 凡是「bound room 就该是 chat: / user:」的假设都要认 `topic:`。主要是出站 (`planOutbound`)、`sourceRouteHook`、`channelRefOf`、`spawn-tmux` / `mirror-bridge` 里取 chatid 的地方 —— topic room 永远不走群消息出站, 只走 `send_reply`。
- **存量帖子 room 原 id 不动** (换 id = 消息 id 的 roomHash8 全变, 转录里的 `[id]` 全失效): 解析顺序见 §3.1, 已诞生的 `chat:<opk>` room 就是那个帖子的 room。

### 2.2 频道 → host 身份

- 存储: **`wrc.channel.steward.<topic_id>` = 类名** (现有, 经 `config-writer` 写, hot)。不新增文件、不在任何账本里。
- 写入口 (都已存在): `onboard_bind` (频道引导)、`POST /mirror/channel/rebind` (换绑工作区)、`config_set wrc.channel.steward.<topic>` (人 / 有权 wizard)。
- 换绑语义: 与现行 `rebindChannel` 同 —— 新类在**每个**该频道的 topic room 的实例坐到最前 (ord ≤ 1, 即 host); 旧 host 不离开、不 cancel 它手上的件。
- 「仅能绑定一种」: 一个频道一个类名 (映射值是字符串, 天然唯一)。频道级不再有成员表 / 账本 / perceptron。

### 2.3 频道元数据 (不是 room)

需要一个「已知频道」的列表给图做框标题、给 read_channel / 引导认频道: 继续用 `channel-posts.json` 里 `chat:<topic_id> → {channel, post:""}` 那条 (`learnChannelRoom` 现在就写它, 改名 `learnChannel`)。频道显示名沿用 chat-name 键 `chat:<topic_id>` (人起的名字不迁)。

### 2.4 行字段

- topic room 的行**不带 `post`** (room 自己就是那个帖子), 也不带 `src` (不再有副源)。
- `mention:"bot"` 照旧 (直达 host, 不过 perceptron)。
- 存量频道 room 里的 `post` / `src` 行只读保留, 读侧不变。

## 3. 路由

### 3.1 入站: 事件 → topic room (一个纯函数)

```ts
topicRoomOf({topic, post, opk?}) =
     opk && roomOfSource(opk)            // 存量: 帖子源曾被 room_bind 绑进某 room → 继续落那里 (只读兼容, 不再新增)
  ?? opk && roomExists("chat:" + opk)    // 存量: 已诞生的旧帖子 room
  ?? legacyPostRoomOf(topic, post)       // 同上, 按 channel-posts 反查 (事件路径没有 opk 时)
  ?? "topic:" + topic + "/" + post       // 新的一律这个
```

| 入口 | 现在 | 改后 |
|---|---|---|
| topic_event 新帖 (没 @) | 频道 room + `post` | `topicRoomOf` (首条即开 room) |
| topic_reply_event 评论, 已配对 | 帖子 room | `topicRoomOf` |
| topic_reply_event 评论, 未配对 | 频道 room + `post` | `topicRoomOf` (不再需要配对) |
| topic_at_bot, 原生帧到了 | inbound 走帖子 base / 首触落频道 room | inbound 等配对 (现 2s), 换成 `topicRoomOf` 落行, `mention:"bot"` |
| topic_at_bot, 原生帧没到 (兜底) | 已配对 → 帖子 room; 未配对 → 频道 room | `topicRoomOf` + `mention:"bot"` |

- room 不存在就开: `open {kind:"topic-post"}` + 该频道 host 身份在本 room 的实例 `join founder` (身份记录懒落, 不起 pane)。频道还没绑 host → 只开 room, 人话交引导 (§5)。
- 原生 @ 帧与 topic_at_bot 的双路去重机制 (`noteNativeChannelFrame` / `awaitNative`) 不动; 只换「落哪个 room」。

### 3.2 出站

- topic room: `chat_say` / `chat_reply` / `send_file` / `notify` **一律 `send_reply` 评论回根帖** (现帖子 room 语义, 被拒回退新帖带引用的兜底保留)。`planOutbound` 对 `topic:` 前缀直接从 id 取 (topic, post), 旧 `chat:<opk>` 帖子 room 照旧查 channel-posts。
- 删 `channelOutboundOf` 的「频道 room 里 re 评论 = 评论回原帖, 否则发新帖」分支 —— 只剩存量频道 room 用它 (§6)。
- **wizard 主动发新帖** (以前 = 频道 room 里 `chat_say`): 推荐 `chat_say({room:"chat:<topic_id>", text})` —— 频道 id 当一个「开新帖」的虚地址: daemon `send_post` 拿回 `post_id`, 开 `topic:<T>/<post_id>` (调用方作 founder, 频道 host 实例若不是它则另行入座), 这行落进新 room。见 §9-③。定时任务 / notify 指向频道同理。
- 审批卡: 频道不支持按钮卡, 仍按 `lastAsker` 改投问话人私聊 (现状)。

## 4. host 与 perceptron

- topic room host = 频道 host 身份在本 room 的实例 (`roomStewardOf(room, channel)`, 现成)。
- **perceptron**: 现规则「每个有 wizard 成员的 bound room 懒建一个」照搬到 topic room 会让「每个帖子一个 perceptron 身份」, 帖子多了身份与冷启动都线性涨。推荐: **一个频道一个共享 perceptron** (`chat:<topic_id>#monitor`, 以 role:"monitor" 入座该频道每个 topic room), 它一次被唤醒可能收到多个 room 的段 (渲染本来就支持多 room 批), `room_activate` 的 `re` 自带 room。代价 = 改 perceptron 身份键与入座点; 收益 = 身份数与 pane 冷启动回到「每频道一个」, 与改造前相同。见 §9-①。
- @ 机器人 → 直达 host (不变)。

## 5. 引导 (onboarding) 交界

- 状态键仍是频道 `chat:<topic_id>` (`needsOnboarding` / `onboarding.begin` 不变 —— 键不需要是 room)。
- 引导化身 `chat:<topic_id>#guide` **入座人说话的那个 topic room** (首次 founder; 同频道别的帖子再来人话就 `join` 那个 room —— 一个频道一条引导, 可同时是多个 topic room 的成员)。
- `onboard_bind` 从调用方的 room 推回频道 (`topic:` 前缀直接拆, 旧 room 查映射), 写 `wrc.channel.steward.<topic>`; 落定 = 对引导所在的**每个** topic room 做 `guideHandoffOps` (本 room 实例 join → 引导名下 duty move → 引导 leave), 再 `reapGuideAfterTurn`。`settleBoundChannel` 改为遍历该频道所有 topic room (§6 的索引)。
- 引导期不建 perceptron (现规则 `channelMonitorWanted` 不变)。

## 6. 存量与迁移 (零数据改写)

- **旧帖子 room (`chat:<opk>`)**: 原样就是该帖子的 topic room (§3.1 解析顺序), 账本 / 成员 / 消息 id 都不动; kind 仍读时算 `topic-post`, 归属频道读 channel-posts。
- **旧频道 room (`chat:<topic_id>`)**: 冻结为**只读存档** —— 入站再也不落它; 里面未关的 duty 仍可由 holder `chat_reply` 关 (出站沿用 `channelOutboundOf`: re 到带 post 的行 = 评论那帖, 这样老问题还能答回原处); 新的 `chat_say` 指向它 = §3.2 的开新帖。图上画在频道框内, 标「旧频道 room (存档)」。不迁行、不改写 (行里的 `post` / `src` 是历史事实, 改写会破坏 fsync 账本的 append-only)。
  - 可选 (§9 不拍也行): boot 时对存档频道 room 里「未关、且对应帖子已有 topic room」的人话 duty 写一行 daemon `system` 指路 (「这个帖子之后在 <room>」), 不关账。默认不做。
- **已有的帖子源 bind op** (帖子 `chat:<opk>` 被 `room_bind` 进别的 room): fold 照读, §3.1 首位尊重它 (对话不中途分家); 新的帖子源 bind 拒 400; `room_unbind` 仍可解 → 回落 topic room。
- **频道 room 里补拉的帖子 host 成员**: 不动 (存档 room 里的历史)。
- **配置**: `rooms.binding.decideTimeoutMin` 删 —— zod 遇旧键忽略 + warn, 不拒启动 (契约 §7 同纪律)。`wrc.channel.steward` 不变。
- **会话**: charter 与 MCP schema 变 (room_fork 删、room_bind 描述改、频道语义改) → 频道相关 wizard 需要 `handoff` / `/new` 才看到新规矩; 走 `config_set` 同款「charter 前后 diff → 通知 handoff」机制不适用 (那是配置驱动), 在 CHANGELOG 写明需重启频道 wizard。
- 本机无频道数据 (rooms/ 下没有 channel / 帖子 room), 迁移的真机演练只能靠临时 HOME + 构造账本。

## 7. 工具 / 配置去留

| 项 | 去留 | 说明 |
|---|---|---|
| `room_fork` (MCP + `POST /room/fork`) | **删 BREAKING** | 没有首触接待, 帖子天然是 room |
| `rooms.binding.decideTimeoutMin` + `decideOnFirstTouch` / `pendingFirstTouches` | **删 BREAKING** | 同上 |
| `room_bind` 帖子源 (`chat:<opk>`) | **删 BREAKING** (400) | 群源保留; 描述改写, 去掉「频道 @ 先交你判」 |
| `room_unbind` | 留 | 群源 + 存量帖子源 |
| `planChannelBackfill` (帖子 host 补拉进频道 room) | **删** | 没有频道 room |
| `latestSrcOf` 缺省源 | 留给群源 | 帖子不再有 src |
| `read_channel` | 留 | topic room 唤醒头补 `topic=<topic_id>`, 参数不变 |
| `chat_say` / `chat_reply` 频道语义 | **改 BREAKING** | topic room 一律评论根帖; 开新帖 = `chat_say({room:"chat:<topic_id>"})` |
| `POST /mirror/channel/rebind` | 改 | 不再要求频道 room 存在; 遍历 topic room 坐新类实例 |
| charter 行「频道 @ 先交你判…」 | 改 | 换成一行「频道: 每个帖子一个 room, 回话 = 评论根帖, 开新帖 = chat_say 频道 id」 |
| `rooms.binding.simMin` / `busyWindowMin` | 留 | 群源 dry-run 证据 |
| RoomKind `channel` | 留 (只读) | 存档频道 room 用 |

## 8. 与外部接入 / perceptron / 其他的交界

- **外部接入 (external-gateway)**: 接待 wizard 住审批人私聊, 卡走私聊; 与频道无交集。唯一点: 若外部 agent 想向频道发言, 走 §3.2 的「频道 id 虚地址开新帖」, 不新增面。
- **.me**: `meChannelSay` 的 `src` 改成 topic room id (发生地), `post` 不再需要; 行为不变 (发生地零行)。
- **overdue / 看门狗 / 唤醒泵**: 只认 room, 不受影响。
- **rolepage 读模型**: `RoomFact.channel = {id, name, host?}` 对 topic room (含旧 `chat:<opk>`) 和存档频道 room 都给; `/api/world` 新增 `channels: [{id, name, host: {identity, name}?, rooms: [...]}]` 给前端画框。svr 走 `WorldFacts` 推送, 字段加法兼容。

## 9. 要 admin 拍板的点 (各附推荐)

1. **perceptron 粒度**: (A, 推荐) 一个频道一个共享 perceptron, 入座该频道所有 topic room —— 身份 / 冷启动数与改造前持平; (B) 每个 topic room 一个 (现规则直推), 实现最少, 但帖子一多身份线性涨、每条无 @ 新帖都可能冷启动一个 perceptron pane (本机 3.7GB)。
2. **「一种 host 身份」的粒度**: (A, 推荐) 频道绑的是**类**, 每个 topic room 坐该类在本 room 的实例 (沿用 2026-11-23 拍板; 各帖子上下文互不污染, 实例只落记录不预起 pane); (B) 频道绑**一个实例**, 所有 topic room 共用它当 host —— 身份最少, 但所有帖子挤进一个会话的上下文, 并发帖子串行等它。
3. **wizard 主动开新帖**: (A, 推荐) `chat_say({room:"chat:<topic_id>"})` 作虚地址 → 发帖 + 开新 topic room (调用方 founder); (B) 不支持 wizard 开帖, 只在已有帖子下评论。依赖真机确认 `send_post` 回包带 `post_id` (测试桩是这么写的, 无真机证据)。

无阻塞项时的默认: 1-A / 2-A / 3-A (2-A 即现状, 不拍也照此做), 3-A 若真机回包没有 post_id 则退到 3-B。

## 10. 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 后端 | §2-§7: `topicRoomOf` + 入站四路改落点 + 出站 `topic:` + 删 fork / 首触 / 补拉 / decideTimeout + 帖子源 bind 拒 + 引导改住 topic room + rebind 遍历 + perceptron 粒度 + 读模型 `channel` / `channels` + charter / 工具描述 | `npm run typecheck`; 改写 `tests/channel-*.test.ts`、`room-bind-tool`、`onboarding`、`channel-steward` 等; 新增 topicRoomOf / 存量解析 / 存档频道 room 只读 的断言; build + reload, wsConnected |
| P2 前端 | rolepage 关系图: 同频道 topic room 套框 (hull), 框标题 = 频道名 + 🎩 host; 存档频道 room 在框内; 窄屏可读 | `node scripts/shot.mjs` 桌面 + `--mobile` 截图 (演示数据, `--redact`/`--forbid`), 亲眼核对; `tests/room-graph.dom.mjs` |
| 收口 | contract.md / channel-monitor.md / multi-source-binding.md 加修订头, CLAUDE.md 频道一节, README 若提到, CHANGELOG [Unreleased] (BREAKING) | 文档链接 / 命令复核 |
