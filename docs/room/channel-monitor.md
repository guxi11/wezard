# 频道 / 帖子 room 与 monitor —— 定稿 (2026-11-23)

人在 wezard dev 群里拍板 (6b664ebb.361 → .370)。术语: **频道** = 企微 channel (代码 topic_id); **帖子** = 人说的 topic (代码 post_id, 原生帧 chatid = 帖子自己的 chat:opk…)。

## 1. 结论

1. **频道和帖子都是 room**, 类似 Slack 的 channel 和 thread。
   - 频道 room id = chat:<topic_id>, kind = channel。账本一行就是频道里的一个顶层帖子。
   - 帖子 room id = chat:opk…, kind = topic-post。账本是这个帖子下的评论。
   - graph 里两者都是普通 room 节点, 不画容器/包含关系; 帖子 room 的 host 默认也是所属频道 room 的成员 (成员关系表达归属)。
2. **帖子 room 在帖子第一次被 @ 时诞生 (方案 i)**。这时 topic_at_bot 事件和原生帧配上对, 才拿得到帖子的 opk 群 id。诞生之前, 这个帖子下的评论都记在频道 room 里: 那一行带 post 字段, 指向根帖。
3. **每个频道 room、每个帖子 room 各有一个 monitor** (原来的 judge 改名而来)。
   - 是 room 成员, 有连续会话, 可以自己 handoff。
   - **不发言, 不当 host, 不持有 duty**。
4. **@ 了机器人就不过 monitor**: 等同于点名 host (管家), 发话人明确知道在找谁。
5. **monitor 只负责激活**, 不转写、不写意图。
   - 它的判决只把**当前最后一条用户消息**变成被激活者名下的 duty。
   - 被激活者按自己的游标读未读记录, 自己看上下文。
6. **monitor 挂了就不投递, 优先重试**: 不回落给管家, 也不静默丢。
7. **删 room_transfer**。

## 2. 规则改动

### 2.1 shared/room.ts (纯核心)
- **join 行可带 role:"monitor"**, 成员态里保留这个字段。
- **hostOf 跳过 monitor 成员**: 调用方 roomHost、canRename、join-req 的唤醒都走 hostOf, 一处改全部生效。
- **wakeTargets 的 default 分支**: 绑定 room 里没点名、也没 @ 机器人的人话:
  - room 里有 monitor 成员 → 只唤醒 monitor, **不开 duty** (这一行不进 host 槽位);
  - 没有 monitor → 照旧唤醒 host。
  - @ 机器人的人话 → 照旧给 host。所以入站要把 "@ 了机器人" 作为行上的显式字段写进来, 比如 mention:"bot"。不靠正文猜。
- **新行类型 trigger sys:"activate"**:
  - 字段: author = monitor, to = [被激活者], re = [最后一条用户消息 id];
  - 效果: 在 to 名下为 re 那条开 duty;
  - 不镜像企微 (trigger 行本来就不镜像), 唤醒 to。
  - to 为空 = 判定不回应: 只记一行, 不开 duty。
- **judge 校验**: 只有 monitor 能写 activate; re 必须是本 room 的人话; 同一条人话只能激活一次。
- **move 行**: 读侧 fold 保留, 老账本里的 move 行照常折叠; 写入方随 room_transfer 一起删。

### 2.2 monitor 身份与生命周期 (daemon)
- 新 WizardKind "monitor", 档位 light (可配)。一个 room 一个, 由 daemon 自动建、自动拉进 room:
  - 频道 room: 第一次见到这个频道时建;
  - 帖子 room: 帖子 room 诞生时建。
- **工具面硬限** (参照 approval.ts:2140 guideRefusal, REPL 下钻同 25179b4):
  - 只放行 room_read、read_channel、wizard_roster、room_activate、handoff;
  - 其余工具一律拒绝, 包括 chat_say / chat_reply / chat_ask / notify / send_file / 改文件。
- **MCP 新工具 room_activate({re, to?})**: re 是最后一条用户消息的 id, to 是名字; 不给 to = 不回应。charter 里给 monitor 一段专用说明, 其它 wizard 的 charter 不列这个工具。
- **失败处理**: monitor 没确认收到 (粘贴失败 / uncertain / pane 死了) → 不投递给任何人; 游标不动, 由 wake pump 重试, pane 死了按冷启动重生。
  - 不写 undelivered 行, 不回落 host; 日志在状态变化时记一行 warn。
  - room-watchdog 不对 monitor 写 canceled, 它名下本来就没有 duty。
- **pane 资源**: 一个 room 一个常驻 pane, 数量会涨。monitor 闲时允许被 pane 资源回收 (身份和绑定保留), 下一条人话冷启动。上线前先确认 pane 上限 / 孤儿清扫不会误杀它, 见 workspace 记忆里的 pane 上限与 ENOMEM 两条。

### 2.3 频道传输 (daemon/channel.ts)
- **删一次性判官**: runJudgeOnce、askJudge、buildJudgePrompt、parseVerdict、judgeAndMaybe、Verdict, 以及配置 wrc.channel.judge, 和 tests/channel-judge.test.ts。
  - task-gate.ts 那个匹配只是同名词, 先核实再动。
- **入站, 不再伪造 chatid = topicId 的帧 (channel.ts:642 dispatch)**:
  - 没被 @ 的新帖 (topic_event) → 频道 room 的一行人话 (带 post);
  - 评论 (topic_reply_event): 这个帖子已经配上 opk 的 → 帖子 room 的一行人话; 还没配上的 → 频道 room 的一行人话 (带 post);
  - topic_at_bot: 原生帧照旧进帖子 room (点名 host)。原生帧没到的兜底: 如果帖子已配对, 写进帖子 room; 没配对就写频道 room 并标 mention:"bot"。
- **配对**: learnChannelPost 同时记下 post_id ↔ opk ↔ topic_id (channel.ts:760 那一刻三个 id 都在手里)。channel-posts.json 的值从 topic_id 扩成 {channel, post}, 读侧兼容旧格式 (只有 topic_id 的字符串)。
- **帖子 room 诞生**: 被点名成为帖子 room host 的管家默认同时加入所属频道 room —— 成员关系表达归属, 不靠 graph 容器; 这些成员一般不在频道 room 里说话。
- **出站**:
  - 频道 room 一律 send_post 发新帖;
  - 帖子 room 一律 send_reply, 评论到根帖下面。
  - 删掉按 lastPost / replyOk 挑一个帖子去评论的逻辑 (channel.ts:558、620; daemon/index.ts:1219)。

### 2.4 删 room_transfer
- 要删的地方: mcp/tools.ts 里的 room_transfer、daemon/index.ts:1733 的 POST /room/transfer、charter 工具清单 (daemon/wizard.ts:1100)、mcp/output.ts 里相关的渲染。
- 交接 = 拉新人进来, 然后自己 room_leave。
- tests/room-overdue.test.ts 里对 move 的断言改成读侧 fold, 删掉的测试留删除记录。

### 2.5 读模型与 graph
- **room 类型**: shared/room-view.ts:53 KIND_BY_PREFIX 不再靠前缀猜。频道 / 帖子的 kind 由 channel-posts 映射在读的时候算出来 (buildRoomFact 现算, 不落账本)。RoomFact 加 channel?: {id, name} 和 rootPost?。
- **/api/world**: 帖子 room 带 channel 指针。
- **web/chat.js graphModel**:
  - 频道 room 与帖子 room 都是普通 room 节点, **不画容器/父子包含关系**; 帖子 room 的归属由 channel 指针表达 (节点上带频道标注或弱连线即可), 不做聚拢/折叠布局。
  - monitor 画成单独的节点样式, 用虚线连到它所在的 room; 不戴 host 礼帽, 不算关联。

## 3. 验收
- 单测:
  - hostOf 跳过 monitor;
  - 有 monitor 时, 没点名的人话只唤醒 monitor、不开 duty;
  - @ 机器人的话直达 host;
  - activate 只给最后一条开 duty, 重复激活被拒, to 为空不开 duty;
  - monitor 调发言类工具被拒 (含 REPL 下钻);
  - 帖子没配对 / 已配对时, 入站分别落到哪个 room;
  - 出站频道 → send_post、帖子 → send_reply。
- typecheck + build + 相关单测全绿。按 CLAUDE.md 截图核对 graph 的频道/帖子 room 节点 (普通节点, 无容器) 与 monitor 节点。
- 真机: 测试频道里各发一次 没 @ 的新帖、@ 机器人的帖子、没 @ 的评论, 核对落到的 room、monitor 的判决行、出站形态。把 monitor 的 pane 杀掉, 核对人话不投递、pane 重生后补投。
- CHANGELOG [Unreleased]: Removed 写 room_transfer 和一次性判官, Added 写 monitor 与频道 / 帖子 room。都是 **BREAKING**。

## 进度 (执行者维护)
- [x] 2.1 纯核心 + 单测
- [x] 2.2 monitor 身份 / 工具面 / 失败重试
- [x] 2.3 频道传输入站 / 出站 / 配对
- [x] 2.4 删 room_transfer
- [ ] 2.5 读模型 + graph
- [ ] 3 验收
