# 修复单: monitor activate 判决行看着像 monitor 发言, duty 归属写成「来自 .monitor-2」(t8)

## 现场 (2026-11-23 人报, duty 6b664ebb.433 / 4229c91d.19-20)

人在测试频道问「你分析一下, 你如何判断是恢复帖子还是在 channel 里发新的消息?」(4229c91d.19, 人话), monitor 判决激活 OliveBrown-2 (4229c91d.20), OliveBrown-2 正常接话 (4229c91d.21)。但人在 rolepage 看到注入段落里:

- `[4229c91d.20] .monitor-2 → .OliveBrown-2 (re 4229c91d.19): （正文为空）` —— 像 monitor 发了条空消息;
- 注入尾 `你要交代: 4229c91d.19 (human, 来自 .monitor-2)` —— 人话的 duty 归属写成 monitor 派的。

## 逐条判定

### ③ 该行有没有进企微频道? —— 没有, 符合预期, 不修

shared/room.ts mirrors 谓词: `kind !== "trigger"` 一律不出站。4229c91d.20 是 kind:"trigger" origin:"tool", 没有出站。人看到的是 rolepage/注入的**内部账本渲染**, 不是企微消息。

### ① 渲染形态 —— 偏差, 修

shared/room.ts renderMsgLine 对 trigger activate 行无特殊处理, 渲染成「作者 → 收话人: 空正文」的消息形态。设计 (§2.2): monitor 不发言, 判决行是系统行为。对照: after-wake / overdue / 定时任务的 trigger 行 author 是 DAEMON 且带正文, 看着就是系统行; activate 行 author 是 monitor + 正文空 → 看着像 monitor 发言。

**修法**: renderMsgLine 对 `kind === "trigger" && sys === "activate"` 输出系统形态, 形如 `[id] [wezard] monitor 判决: 交给 <to 名单> 回应 (re <id>)`; to 为空 (判不回应) 形如 `[id] [wezard] monitor 判决: 不回应 (re <id>)`。不以 monitor 名义出现。**只精确匹配 sys:"activate"**, 其他 trigger (after-wake/overdue/定时) 一律不动。rolepage 的 room 历史 (shared/room-view.ts 用同一 renderMsgLine) 一并修好, 无需另改。

### ② duty 归属 —— bug, 修

shared/room.ts dutiesOpenedBy 的 activate 分支: `msg: row.re?.[0] ?? row.id` 挂了原话 id, 但 `base.asker = row.author` = **monitor**。注入尾「来自 X」取 d.asker → 显示「来自 .monitor-2」; 语义上这条 duty 的源头是人话, asker 应为原话行的人。

**修法**: applyOp 的 msg case 里 op 行先入 byId 再开 duty, activate 行的 re 原话**必然已在 byId** —— 给 dutiesOpenedBy 加只读参数 (建议 `reAuthorOf?: (id: string) => Who | undefined` 或直接传 byId 查询函数), activate 分支 `asker` 取 `reAuthorOf(row.re?.[0]) ?? row.author` (查不到回落, 防乱序旧账)。**不要**改 duty 的 kind/slot/msg 语义。

**连带行为核一遍** (预期内变化, 单测覆盖):
- room-hub 注入 owe 行显示「来自 人」;
- answered 分支 (d.asker.kind === "human") 从不命中变为可命中 (OliveBrown-2 need 反问后人另发新话 → 「对方的答复可能就在上面」提示) —— 正确语义;
- 离场 canceled 的 wake (asker.kind === "wizard" 才唤醒 asker): 从唤醒 monitor-2 变为不唤醒 —— 正确 (人问的话, 没答完人也不用叫醒谁);
- 存量: duties 从账本 op 流重算, 修复 reload 后 4229c91d.19 的 duty 归属自动纠正, 无需数据迁移。

## 单测

- renderMsgLine: activate 判决行 (带 to / 不带 to) 渲染为系统形态且不含 monitor 署名; after-wake / 定时 trigger 原样。
- dutiesOpenedBy / applyOp: activate 开的 duty asker = 原话人; re 行缺失回落 row.author; msg/slot/kind 不变。
- 顺手断言 mirrors: activate trigger 行不出站 (已有规则, 防回归)。

## 验收

- tsc + build + 相关单测绿 (codex 两红基线); reload。
- 真机: 频道 room 里再触发一次 monitor activate, rolepage/注入里判决行显示系统形态, duty 显示「来自 人」; OliveBrown-2 照常接话。
- 修完由 .AliceLane 亲验后在 wezard dev 群对人交代, 再继续三件套验收。

## 规矩

同前: 一次一个提交者, pathspec commit, 不手改 room JSONL, 完成后 chat_reply 交代。

## 进度

- [x] ① renderMsgLine 系统形态 (仅 sys:"activate") — 渲染为 `[id] [wezard] monitor 判决: 交给 X 回应 (re Y)` / `不回应`; after-wake 等 trigger 原样
- [x] ② dutiesOpenedBy asker 取原话人 (applyOp 传 byId 查询, 查不到回落 row.author); msg/slot/kind 不变
- [x] 单测三组 (tests/room-monitor.test.ts ⑪⑫; ⑤ asker 断言改为原话人)
- [x] tsc + build + 相关单测绿 (room-monitor / monitor / room-after-wake / chat-record / inject-view / wake-tail / room-hub)
- [ ] reload + 真机再触发一次 monitor activate 验收
