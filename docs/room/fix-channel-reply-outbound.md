# 修复单: 频道管家「评论回原帖 vs 发新帖」的选择 + charter 频道语义 (t9)

## 现场 (2026-11-23 人报, duty 6b664ebb.436 / 4229c91d.19-21)

人在频道帖子里评论提问 (4229c91d.19, 落频道 room, 带 post 字段指向根帖), OliveBrown-2 被 activate 接话 (4229c91d.21, chat_reply re .19 落频道 room) —— 出站**发了一条全新帖子** (send_post), 人的原帖下面没有任何回应。人的原话: 「在 channel room 里的管家, 为什么不能判断是回复这个帖子 (创建 topic room), 还是创建新的帖子?」

OliveBrown-2 的自述还把机制讲错了 (「回复就挂在原消息下面」「派活的消息头上带着 topic, 回复会落回那个话题」) —— 它从没被告知频道语义。

## 判定: 设计缺口, 补 (人已在群里确认「这是缺口」)

设计文档原口径「频道 room 一律 send_post」没有「评论回原帖」的路径。但频道 room 里 re 到的评论人话**自带 post 字段** (= send_reply 需要的频道 post_id, 见 channel-posts.ts:69), 路径是现成的。

## 修法

### ① 出站: re 到带 post 的评论 → send_reply 回原帖 (缺省即回帖)

daemon/index.ts roomMirror 的 isTopicChat 分支: 行是 reply 且 `re` 指到的原话行带 `post` 字段 → `sendTopicReply(topicId, 原话行的 post, body)` 评论回该帖; 其余 (chat_say 主动说 / notify / re 的原话不带 post) 照旧 sendTopicPost。

这样不需要新工具参数, 选择编码在动作里, 缺省规则清晰:
- **回话** (chat_reply re 一条评论) = 评论回原帖下面;
- **主动说** (chat_say 不带 re) = 频道发新帖;
- re 的原话是新帖正文 (行上无 post, 需先核实现场: topic_post_event 入站的行带不带自己的 post_id —— 带的话同样 send_reply 回它, 语义更一致; 不带则 send_post)。

帖子 room (已配对) 出站不变 (一律 send_reply 到根帖)。改完同步更新 channel-monitor.md §2.3 出站口径与 CHANGELOG。

### ② charter + 工具描述写明频道语义

- daemon/wizard.ts renderCharter (index.ts setCharterProvider 挂的): 补一段频道/帖子 room 语义 —— 频道 room 的出站规则、re 到评论=回帖 vs 主动说=新帖、帖子 room 是帖子评论区。给所有 wizard 讲还是只给绑定频道的管家讲, 按现有 charter 结构选最小侵入的做法 (通用段落即可, 别按 room 定制)。
- chat_say / chat_reply 的工具描述 (MCP 工具 schema 的 description): 把上面的缺省规则写进去, 管家自述错误的根源是工具描述里只有群语义。

### ③ 事故链核实结论 (无需代码修复, 交代时说明)

账本 seq 12-18 已核: .12 人话 → activate → OliveBrown-2 无 pane (t7 前) → .14 undelivered 系统行 → pane 起来后 OliveBrown-2 补交 .15 (done); .16 人重发同句 → .17 activate → .18 正常交代。自述的「待办被转走 / 回 .12 被拒」都是 pane 缺失期的连锁, t7 后不再发生; 「同一句发三次不合并」是设计行为 (每条人话独立开 duty 独立交代)。t8 修完 asker 后 undelivered 的通知对象也会从 monitor 回归人。

## 单测

- roomMirror 出站分支: reply re 带 post 评论 → send_reply (断言用的 post id); re 不带 post / say / notify → send_post; 帖子 room 不变。
- charter 渲染: 含频道语义段落。
- 现有 channel 系测试跟随新口径改 (行为改写, 非删除)。

## 验收

- tsc + build + 相关单测绿; reload。
- 真机: 人在帖子下再评论一句, OliveBrown-2 的交代应**评论回原帖** (不是新帖); 管家主动 chat_say 仍是新帖。
- 修完由 .AliceLane 亲验后在 wezard dev 群对人交代, 再继续三件套。

## 规矩

同前: 一次一个提交者, pathspec commit, 不手改 room JSONL, 完成后 chat_reply 交代。

## 进度

- [ ] ① roomMirror: re 带 post 的 reply → send_reply
- [ ] ② charter + 工具描述频道语义
- [ ] 文档口径 + CHANGELOG
- [ ] 单测
- [ ] tsc + build 绿 + reload
