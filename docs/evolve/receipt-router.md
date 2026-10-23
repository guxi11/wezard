# Receiver task routing and durable recovery

> 当前唯一权威设计，依据 `daemon/router.ts`、`daemon/message-events.ts`、`daemon/index.ts` 与 `shared/turn-state.ts`。实现基线：`1646fa6` 及其后续修正。本文描述当前行为，不是迁移步骤。

## 责任边界

- `router.ts` 是 receiver task 的账本：每个 event 有 owner、receiver、状态、job/batch 关联和结论；JSONL journal 以 op 追加，启动时 fold，压实时保留仍可被迟到输入引用的记录。
- `message-events.ts` 是输入与最终发送的耐久队列：保存输入身份、`serves`、`inputIds`、执行状态、暴露状态、结果绑定及最终投递 outbox。它不以 transcript 文本猜测路由归属。
- `jobs.ts` 记录 fan-out 成员、预算和完成账目；它与 route ledger 通过 event/job 关联，不替代 route 状态。
- `turn-state.ts` 只在读取时将 route 行和 pane 状态映射为工作状态，不保存第二份真相。

## 任务与 receiver

一个 route event 表示一件 task。owner 是当前执行并欠答的一方，receiver 是结论与追问的上游接收者。对于同一 owner 和 wizard receiver，最多保留一件 unfinished task。route 与 receipt fact 的 `batch` 都是可选字段；缺省时按原值读取，不推断或补写，无 batch 的 inbox 回执不参与批次合并。重复 `open` 或 owner `move` 后的重复任务会合并，`mergedInto` alias 让历史 event 仍解析到当前 task。`open/move` 与 merge 分两次 journal append；boot fold 后再次归并重复 unfinished rows，以修复两次写入之间崩溃的窗口。这是当前写入协议的恢复行为，不是旧版迁移。

`kind` 表示消息意图并参与派活方向闸；route 创建及 receiver 由 `return` 决定。`return` 缺省为 `self`，`none` 不建 route，`self` / `detach` 新建或补充 receiver task，`transfer` 沿已有 route 转移 owner。当前 MCP `fyi` 文案承诺不收回执，但实现不会自动将它转换为 `return:"none"`；要确保不建 route，需显式指定 `return:"none"`。`NEED:` 和 CLI error 是中间状态，分别表现为 `need`、`error`，只有显式续问或最终结果才推进任务。owner 的移交由 `move` 改归属，不另造旧任务副本。

wizard task 的终结结果必须用 `@.name RESULT:` 指明接收者；裸 `RESULT:` 会被明确反馈拒绝。一轮可以包含多个接收者。chat root 的裸 `RESULT:` 合法，按自身 `serves` 结案并保留 input coverage。daemon 在输入结果落库时生成 `resultRoutes`，把每段绑定到对应 event，并记录产生该结果的 `inputIds`。这些输入必须已由同一 session/turn 消费且被结果覆盖，才能提交 answer；新输入若在旧结果处理期间到达，不会被旧结果顺带结案。daemon 不根据 speaker 猜 wizard task 的接收者。

## 投递与恢复

消息 event 与 route answer 是两层持久记录。入站消息以稳定 id/fingerprint 去重；替换和退役在同一 store 写入。输入状态分别记录 `execution` 与 `exposure`：只有可证明未暴露的输入才能安全重试。若 paste/transport 可能已发生而证据不足，事件进入 `uncertain` 并保留原 session/transcript 身份；不会在替代 pane 上盲目重放。

route answer 先写入 journal，再创建 durable inbox event `rcpt:<event>:<revision>` 或 chat final。收件箱接受与投递状态独立持久；最终 outbox 按 chunk 记录 pending、waiting-ack、delivered、uncertain 或 failed。明确负 ACK 表示未送达，可以重试；ACK 不确定则停在 uncertain，直到观察或显式 reconciliation 提供证据。相同输入、route revision 与 delivery identity 重放是幂等的。

启动恢复与后台 pump 依据持久事件、transcript/session evidence、pane 归属、route journal 和 outbox ACK 协调。已观察到输入消费但尚无终句时继续观察；有终句时以 `serves` 和结果绑定结案；handoff cut/restored 标记隔离交接切断的终句并在 handoff 自己的恢复路径中补偿。已暴露输入不会因为“pane 不见了”就变成 dead 结论。

## 期限与失败

route 不使用自动失败期限。`NO_DEADLINE = Number.MAX_SAFE_INTEGER` 是有限 JSON 数值哨兵，`hasDeadline` 才能区分它与真实期限；不可把它转换为 Date 或 timer。message event 上的 `deadline` 是调度和有效性信息，不是 route 失败定时器。

当前没有 route sweeper 按 deadline、pane 死亡宽限或无结果次数生成 `timeout`、`silent`、`dead`。错误、NEED、取消和结果均须由各自的事件/控制路径产生；不确定的 transport 或 session 状态保留为不确定，交由证据恢复。

持久化格式不做旧版自动迁移。route 与 receipt fact 的 `batch` 均可选，启动不会因缺少它而拒绝；缺省时不推断、不补写，无 batch 的 inbox 回执不合批。boot 当前其他校验边界是：未 finalized 且带 route 身份（`serves`、`route:` 或 `rcpt:`）的 message event 必须使用 `NO_DEADLINE`；未 finalized 的 receipt event 必须有有效且非空的 receipt facts；若未 finalized event 存在 `resultRoutes`，每个绑定必须有效并含 `inputs` 数组；仍未送达的 quiet outbox event 必须有 purpose。outbox coverage 字段缺失本身不会触发整体启动拒绝。重复 unfinished route 由 boot merge 恢复，不作为旧格式拒绝。daemon 不会归档或改写旧 receipts/holds 状态文件。`receiptsFile` 配置仍是 workflow nodes/plans 文件的路径前缀，与已退役的 receipt 状态文件用途无关。

## 写入与状态转换

| 事件 | 持久化顺序 | 结果 |
|---|---|---|
| 普通 task 派发（会建 route） | `openDispatchRow` 先写 route `open`（或复用已有 pair）；随后 `acceptPeerDispatch` 调用 `events.accept` 持久化 message event | `serves` 关联输入与 route；接受失败时清理由本次新开的 route。`op: none` 不开 route |
| transfer 派发 | `openDispatchRow` 只返回既有 `serves`，不先改 owner；`acceptPeerDispatch` 先由 `events.accept` 持久化 message event，随后 event 的 `accepted` 投影写 route `move` | transfer owner 投影发生在 event durable 之后；`transferReply` 只刷新回复气泡。未暴露时接受失败会取消 event 并回滚转移 |
| `re` 续问 | 复用原 route；先持久化续问 message event，接受后将 `need` / `error` route 标回 `open` | 仍是同一 event，不新建 task |
| `NEED:` / CLI error | route 写 `mark`，再接受带事实的 durable receipt | route 仍未完成，可续问 |
| 最终 RESULT | 校验 address、event 和 `inputIds` coverage，再写 answer | route 落定，随后创建 inbox/chat delivery |
| owner 转移 | journal 写 `move`，相关重复 unfinished task 归并 | event alias 保持可解析 |
| daemon reload | fold route journal，恢复 event/outbox pump | 依照 exposure 与外部证据重试、观察或停在 uncertain |
| ACK uncertain | outbox 保存 uncertain 与发送身份 | 禁止自动盲重发 |

## 旧设计的处置

receiver stack、transcript watcher、按 `from→to` 的单槽 receipts continuation、自动 deadline/silent/dead 合成以及 T10 分步切换清单均已退役。对应旧文档只保留到本文的淘汰指针；其中通用研究结论不构成当前实现契约。当前实现仍需要 route merge aliases、batch 保留和有限 `NO_DEADLINE`，这些属于现行语义。
