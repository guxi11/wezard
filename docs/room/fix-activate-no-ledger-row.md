# 修复单: monitor 判决不进消息记录 (t10①) + 未 @ 帖子评论回帖被拒无回退 (t10②)

## 现场 (2026-11-23 人报, duty 6b664ebb.444)

① 人: 「monitor判决可以完全不进消息记录吗? wizard不需要知道有monitor这个环节吧, 只要激活就有消息记录作为输入的, 何须这个?」—— t8 的系统行渲染方案被推翻: 判决**完全不写 msg 行**, 被激活的 wizard 只看到人的原话; 留痕进 daemon.log (现已有 "monitor: activate" 日志行)。

② 人: 「当channel里的消息没有艾特机器人时, 能回复这条帖子吗?」—— 企微官方限制 (YaraKing 口径): bot 只能评论 **@ 过机器人**的帖子。现状: t9 后 chat_reply 对带 post 的评论一律 send_reply; `sendTopicReply` 被 errcode 拒时**只 log warn, 无回退** —— 没 @ 过的帖子的交代**静默丢失** (账本已 done, 人看不到)。

## 修法

### ① 激活不写 msg 行 (重设计, 改掉 t8 的系统行方案)

目标形态: monitor 判决 → 被激活的管家收到「人的原话 (未读行) + 你要交代: <msg id> (human, 来自 人)」, 全程**没有任何 monitor 署名/判决的消息行**。

- room_activate (index.ts ~1793) 改为**不 append msg 行**: 开 duty 走**非 msg op** (建议 `op:"assign"`: {duty: 人话 msgId, slot: 被激活者, asker: 人} — 字段按 Duty 现有结构), applyOp 加 case 折算进 s.duties (账本重放一致); 然后直接 kick 泵唤醒被激活者。
- **泵的注入要成立**: 现在 owe 过滤靠 triggers (唤醒它的行)。没有 trigger 行后, 需要让「assign 开的 duty + 人话未读行」同样进注入 —— 读 deliverWake 的实际选取逻辑再定 (可能 assign op 需要带 wake 效果, 或 owe 过滤放宽到「held duty 的 msg 行本身在未读里」)。目标: 注入含人话原文 + owe 行, 不含任何 monitor 痕迹。
- **补投链路保持**: 杀 monitor pane → 人话 wake monitor 失败 → monitor 重生 → 未读人话投递 → activate → assign + kick。t3-accept 的杀 pane 验收照跑。
- **游标**: 被激活者 seen 按人话行推进, 语义不变。
- **overdue / waker 查找** (room-hub.ts:340 附近靠 trigger 行找 waker): 无 trigger 行后改为 duty.msg 行 (人话) 或 assign op —— 核对 overdue 提醒仍能找到「最早叫醒它的那一行」。
- **monitor 硬闸** (room-hub.ts:91): 改成 monitor **不能写任何 msg 行** (activate 走 op 路径, 不过 append)。
- **存量兼容**: 旧账本里的 activate trigger 行重放照旧开 duty (dutiesOpenedBy activate 分支与 t8 渲染保留, 对存量仍正确); 新行为不再产生。
- 审计: daemon.log 已有 "monitor: activate" (含 re/to), 够审计; 不进账本。

### ② 评论被拒 → 回退新帖 (带引用标注)

- `sendTopicReply` errcode (企微拒) 时**回退 sendTopicPost**, 新帖正文带引用上下文: 引用原话片段或至少标注「回 <原话摘要>」—— 别让交代静默丢失。回退发生记 log.warn。
- 可选预判: 判定 `channelOutboundOf` 时若原话行的 post **未配对** (从未被 @, 无 opk) → 大概率评论会被拒 —— 可直接走新帖+标注, 省一次被拒往返。配对信息在 channel.ts 的配对表里, 核实取用路径; 拿不准就只做运行期 errcode 回退 (简单可靠)。
- 把真实行为与企微限制写进 channel-monitor.md 与 charter/工具描述 (管家要知道: 没 @ 过 bot 的帖子它评论不了, 会自动改发新帖带引用)。

## 单测

- ①: assign op 开 duty + fold 重放一致; 注入 (被激活者) 含人话原文 + owe (human, 来自 人) 且无 monitor 行; monitor append msg 行被硬闸拒; 旧 activate trigger 行重放照旧。
- ②: sendTopicReply errcode → 回退 sendTopicPost 且正文带引用; 未配对 post 预判分支 (若做)。
- 既有 room-monitor / strict-channel / monitor 等测试跟随新口径改 (行为改写, 非删除)。

## 验收

- tsc + build + 全套相关单测绿; reload。
- 真机: 人在**没 @ bot 的帖子**下评论 → monitor 激活 → 管家交代以**新帖 (带引用)** 出现 (评论回不去是企微限制); 在 @ 过 bot 的帖子下评论 → 交代评论回原帖。被激活管家的注入里无任何 monitor 痕迹。
- 杀 monitor pane 的补投验证照 t3-accept 跑。
- 修完由 .AliceLane 亲验后在 wezard dev 群对人交代 (含企微限制的说明), 再继续三件套。

## 规矩

同前: 一次一个提交者, pathspec commit, 不手改 room JSONL, 完成后 chat_reply 交代。

## 进度

- [ ] ① room_activate 改 assign op + kick, 不写 msg 行
- [ ] ① 泵注入/overdue/补投三链路核对与修
- [ ] ① monitor 硬闸收严
- [ ] ② 评论被拒回退新帖 (带引用) + (可选) 未配对预判
- [ ] 文档 + charter + 工具描述
- [ ] 单测
- [ ] tsc + build 绿 + reload
