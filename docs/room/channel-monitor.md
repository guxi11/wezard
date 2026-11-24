# 频道 / 帖子 room 与 monitor —— 定稿 (2026-11-23)

> **修订 (2026-11-24, monitor → perceptron, 人拍板 9e7dbc47.4 / 090407fa.3; 门控二次纠正 9e7dbc47.9)**:
> ① 判决输出**名单** (多目标) + `reason`, 落一条 `perceive` op (`{duty, to[], asker, by, why?}`) —— 仍不写消息行, 名单逐个开 duty, fold 记 verdict 供 rolepage (人话行挂「感知 → .A, .B · 理由」chip); **空判决不落任何记录**。
> ② **门控替换 §2.2 的「频道落定即建」, 且不按成员数 (人二次拍板: channel 里只有一个 wizard 也需要感知)**: 是否建 / 是否接管 = 该 room 是否存在 wizard 成员 (含单管家 room / 频道), 频道 / 帖子 / **群**一视同仁, **不回落 host 兜底**; 例外: 单聊 (人私聊 = 直接说给全局管家) / `.me` 独立对话 / 引导中的群与频道 (`needsOnboarding` / `channelMonitorWanted` 守卫) —— 这几类照旧落 host。judge 的 `toMonitor` 另加 `origin!=="migrate"`。
> ③ **懒建不预起 pane**: 建 perceptron 的唯一入口是 room-hub append 钩子 (第一条需要感知的人话触发), 只建身份 + join; 首次唤醒由泵冷启动 (档位由 steward-model 强制), 闲时可被 pane 资源回收。原 ensureMonitor 的预建调用点 (boot / 频道落定 / 换绑 / steward 自愈) 全部删除。
> ④ 宪章 / 工具描述改写: 候选 = 本 room wizard 成员减自己, 逐个**结合其职责**判断, 名单「少而准」; 概念面改叫 perceptron (账本 role 值与 WizardKind 沿用 "monitor", 旧 assign op / activate trigger 行重放兼容)。

人在 wezard dev 群里拍板 (6b664ebb.361 → .370)。术语: **频道** = 企微 channel (代码 topic_id); **帖子** = 人说的 topic (代码 post_id, 原生帧 chatid = 帖子自己的 chat:opk…)。

## 1. 结论

1. **频道和帖子都是 room**, 类似 Slack 的 channel 和 thread。
   - 频道 room id = chat:<topic_id>, kind = channel。账本一行就是频道里的一个顶层帖子。
   - 帖子 room id = chat:opk…, kind = topic-post。账本是这个帖子下的评论。
   - graph 里两者都是普通 room 节点, 不画容器/包含关系; 归属由 channel 指针表达 (不做成员关系)。
   - **每个 room 的 host 是它自己的实例** (人 2026-11-23 二次拍板): 频道绑的是类 / 身份, 频道 room 与
     每个帖子 room 各自解析**本 room** 的化身 (类 = 领号新开), 互不共用 —— 老口径「帖子 room 坐频道
     那个实例」已废。帖子 room 的实例不预起 pane, 第一次被唤醒时冷启动。
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
8. **换绑 = 建 / 复用目录的管家类 + 写频道表 + 每个 room 坐上新类的本 room 实例**
   (人 2026-11-23「绑定工作区为 cc-wecom」; `POST /mirror/channel/rebind`, 实现在 daemon/channel-rebind.ts)。
   - 频道 = 一条 `<bot, steward, workspace>` 的类绑定 (`wrc.channel.steward.<topic>` 存**类名**);
     换绑后这个频道的管家身份就是新目录的类, 帖子级的旧 `chatPolicy.<帖子>.steward` 一并清掉。
   - 新实例坐 **1 号座** (host = 加入序最小的 wizard 成员), 所以 host 真的换人。
   - **旧 host 不离开 room**: 它手上可能还有没交代的件, leave 会把它们全部 canceled (那是人的提问)。
     它只是不再是 host / 不再算本 room 的管家 (手闸与宪章随之不再算它), 会话、名字、记录一个都不动。
   - 幂等: 已绑这个类 = 只补座位; 本 room 已有这个类的实例 = 不写任何 op。

## 2. 规则改动

### 2.1 shared/room.ts (纯核心)
- **join 行可带 role:"monitor"**, 成员态里保留这个字段。
- **hostOf 跳过 monitor 成员**: 调用方 roomHost、canRename、join-req 的唤醒都走 hostOf, 一处改全部生效。
- **wakeTargets 的 default 分支**: 绑定 room 里没点名、也没 @ 机器人的人话:
  - room 里有 monitor 成员 → 只唤醒 monitor, **不开 duty** (这一行不进 host 槽位);
  - 没有 monitor → 照旧唤醒 host。
  - @ 机器人的人话 → 照旧给 host。所以入站要把 "@ 了机器人" 作为行上的显式字段写进来, 比如 mention:"bot"。不靠正文猜。
- **新 op `assign` (2026-11-23 人定: 判决完全不写消息行)**: {duty = 人话 msgId, to, asker = 人话作者, by = monitor}
  - 效果: 在 to 名下为 duty 那条人话开 duty (via:"assign"), 不占 seq、不写 msg 行、不镜像;
  - 被激活者只看到人的原话 + 「你要交代: <id> (human, 来自 人)」, 不知道 monitor 存在; 审计只在 daemon.log;
  - 唤醒泵: 行本身在未读里且有 assign op 开的未关 duty = 待唤醒 (不靠 trigger 行的 wake 列表);
  - to 为空 = 判定不回应: 不落 op、不开 duty、不留账本行。
  - **存量兼容**: 旧账本的 trigger sys:"activate" 行照旧重放开 duty (dutiesOpenedBy 的 activate 分支与 t8 渲染保留), 新行为不再产生。
- **judgeActivate 校验**: 只有 monitor 能判决; re 必须是本 room 最后一条人话; to 是本 room 的 wizard 成员; 同一条人话只能激活一次 (含存量 trigger 行)。
- **move 行**: 读侧 fold 保留, 老账本里的 move 行照常折叠; 写入方随 room_transfer 一起删。

### 2.2 monitor 身份与生命周期 (daemon)
- 新 WizardKind "monitor", 档位 light (可配)。一个 room 一个, 由 daemon 自动建、自动拉进 room:
  - 频道 room: 第一次见到这个频道时建;
  - 帖子 room: 帖子 room 诞生时建。
- **工具面硬限** (参照 approval.ts:2140 guideRefusal, REPL 下钻同 25179b4):
  - 只放行 room_read、read_channel、wizard_roster、room_activate、handoff;
  - 其余工具一律拒绝, 包括 chat_say / chat_reply / chat_ask / notify / send_file / 改文件。
- **MCP 新工具 room_activate({re, to?})**: re 是最后一条用户消息的 id, to 是名字; 不给 to = 不回应。判决只落 assign op + daemon.log, **不写消息行**(2026-11-23)。charter 里给 monitor 一段专用说明, 其它 wizard 的 charter 不列这个工具。
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
  - topic_at_bot: 原生帧照旧进帖子 room (点名 host —— 入站按 `compat_info.source=channel` 判「@ 了机器人」, 行上记 `mention:"bot"`, 不靠正文猜)。原生帧没到的兜底: 帖子已配对写进帖子 room, 没配对写频道 room, **两条都标** mention:"bot" (这一路本来就是 @, 落到哪个 room 都直达 host)。普通评论 (topic_reply_event) 不标, 照旧交给 monitor 判。
- **配对**: learnChannelPost 同时记下 post_id ↔ opk ↔ topic_id (channel.ts:760 那一刻三个 id 都在手里)。channel-posts.json 的值从 topic_id 扩成 {channel, post}, 读侧兼容旧格式 (只有 topic_id 的字符串)。
- **帖子 room 诞生**: 帖子的 room 自己领一个**本 room** 的管家实例当 host (不拉频道 room 那个); 已绑定
  频道里归属由 channel 指针表达, 不再把帖子 host 加进频道 room。
- **出站** (2026-11-23 补, 人报「帖子下评论提问却发了一条新帖」; 选择编码在动作里, 不加工具参数):
  - 频道 room: `chat_reply` 且 re 指向的原话行带 `post` (帖子下的人话) → `send_reply` 评论回那个帖子; 其余 (`chat_say` 主动说 / re 的不是评论) → `send_post` 发新帖。频道 room 的人话行两个来源 (topic_event 新帖 / 未配对的 topic_reply_event 评论) 都带 `post`, 所以对一条新帖正文的回话同样回在它下面;
  - 帖子 room 一律 send_reply, 评论到根帖下面 (不变)。
  - send_reply 评论回原帖对**没 @ 过机器人**的帖子同样可用 (2026-11-23 真机实测, 人报纠正: 早先「bot 只能评论 @ 过它的帖子」的说法不成立, 出处是讨论口径非官方文档/实测)。errcode 被拒时回退 `send_post` 发新帖, 正文开头带 `> 回 <名字>: <原话前 80 字>` 引用标注 (原先只 warn → 交代静默丢失, 2026-11-23 修); 回退仅作兜底, 不按 @ 与否预判, 回退记 log.warn。
  - 分支判定是 `daemon/channel.ts` `channelOutboundOf` (纯函数): reply 行按 re 顺序查第一条带 post 的原话行。charter 与 chat_say / chat_reply 工具描述同步写明这套语义 (此前只有群语义, 管家自述机制全错)。
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
- [x] 2.5 读模型 + graph
- [ ] 3 验收
