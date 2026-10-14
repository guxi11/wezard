# 回执路由表实施 task 清单

> 配套 `docs/evolve/receipt-router.md` (§9 细化定稿为唯一依据)。实施者 = light 档 wizard, 逐个执行。
> 每个 task 独立可验收; 未列出前置的只依赖编号比它小且已标 ✔ 的 task。
> 全程通用约束: `npm run typecheck` 必须过; 动 receipts/jobs/peers 相关行为后跑 `node scripts/receipt-regress/run.mjs` (T11 重写前跑旧版, 只要求不比基线差); 共享工作树, 提交只 stage 本 task 的文件。

## T1 router 纯核心 + journal

- **目标**: 新建 `daemon/router.ts`: `Route`/`Receiver`/`Op` 类型 (§9.1/§9.2 字段定稿), 纯函数 `step(table, op)`、`open/move/mark/release/answer/hand/drop/gc` 的 op 构造器, 派生查询 `waiting(e)`/`chain(e)`/`owedBy(W)`/`awaitedBy(W)`/`subtree(e)`/`speaksToHuman(e)`, journal 读写 (appendFileSync 先写后改内存、尾行撕裂丢弃、中间行坏拒绝启动) 与压实 (`row` 快照行 + tmp/rename)。
- **涉及文件**: 新增 `daemon/router.ts`; `daemon/index.ts` 只在 boot 时 fold 一次并加 `GET /routes?owner=` 诊断端点 (按 wizard 渲染它的行)。
- **验收**: typecheck 过; daemon 起来后 `~/.wezard/routes.jsonl` 被创建; 手造一份含撕裂尾行的 jsonl, boot 后尾行被丢、其余 fold 正确; `GET /routes` 返回空表。无行为变化。
- **前置**: 无。

## T2 轮次归属 serves + onFinal 影子模式

- **目标**: `MessageInput`/`MessageEvent` 增加 `serves?: string` (message-events.ts); 所有 `events.accept` 调用点带上 serves (人话=根 event 占位, 派活=子行 event 占位 —— 此 task 里占位值可为 `""`, T3 才接真值; 但字段与透传必须就位)。`MessageAdapters` 增 `final(event)` 回调, `result()`/`recovered` 路径调它; index.ts 里实现为调 `router.onFinal(target, serves, {text, error})`, **影子模式**: 算出的 op 只写日志不落盘不投递, 与 receipts watcher 并跑对账。
- **涉及文件**: `daemon/message-events.ts`, `daemon/index.ts` (284 附近 recovered/result 回调、各 accept 点), `daemon/router.ts` (onFinal)。
- **验收**: typecheck 过; 一次真实 tell_peer 扇出两件, daemon.log 里影子 onFinal 的判定 (done/need/进展) 与 receipts watcher 实际投递一致; 人话事件的 serves 落盘可见。
- **前置**: T1。

## T3 入口切换: open / move

- **目标**: §9.5 写入点表的全部入口改调 `router.open`/`router.move` 并产出真 event: `/peers/tell` (`tellPeerAsInner`)、`/dispatch`、`spawn_wizard`/`clone_wizard` 带 task、停放放行、workflow plan 节点、人话入站、定时任务开火。`returnOpOf` 的 return/for 校验迁入入口 (chain/receipt/answer 旧写法此处仍映射, 删除留给 T10)。`re` 按 event 找行解析 owner。events.accept 的 serves 接真值。receipts.register 仍在调用 (双写, 投递仍走旧 watcher)。
- **涉及文件**: `daemon/index.ts` (1626 tellPeerAsInner、2872 dispatch、3035 spawn、950 release、329 人话、3968/4061 定时任务), `daemon/workflow-plans.ts` (PlanOrigin→`{event}`), `daemon/receiver-stack.ts` (只保留 returnOpOf/for 校验, 其余待 T10 删), `mcp/server.ts` (`re` 文档改述为 event id, 参数面不动)。
- **验收**: typecheck 过; 每件派活在 `GET /routes` 里看到对应行 (owner/receiver/deadlineAt 正确); transfer 调用产生 `move` op; `for` 挂错帧仍 400 且列出欠着的 event; 旧 receipts 行为不变 (回执照常回)。
- **前置**: T2。

## T4 投递切换: outbox → rcpt 收件箱 + chat final

- **目标**: `router.onFinal` 摘掉影子模式: `answer` op 落盘后, receiver=wizard → `events.accept({id:"rcpt:<event>:<rev>", …, serves:receiver.event})` 入箱; receiver=chat → 走现有 `events.delivery`/`recoverEventFinal` final 通道。inject 适配层做同 serves 的 queued rcpt 合并 (9.3)。`eventFinalGate` 改为只读路由表 (根行 open 且 `waiting(root)` 为空才放行 final)。旧 receipts watcher 的投递路径 (`enqueueOutcome`/`consume`/`pump`) 停用 (watcher 还在跑但不再投递 —— register 改为 watch:false 语义, 只留槽供对账)。
- **涉及文件**: `daemon/index.ts` (958 deliver、1573 eventFinalGate、1500-1570 events 适配器), `daemon/message-events.ts` (合并注入), `daemon/receipts.ts` (register 调用点包一层, 不删符号)。
- **验收**: typecheck 过; 真实扇出三件: 回执各进各的收件箱、同笔合并成一轮; reload 落在 answered 与 hand 之间 → 重放不双投 (rcpt id 判重); 人话根行有未落定子行时群里不出 final, 子行齐后 final 进群; receipts.json 不再增长。
- **前置**: T3。

## T5 NEED / error / re 往返 + wait_peer

- **目标**: `mark need/error` (带 body 入箱) 与 `re` → `mark open` 的往返接通; `wait_peer` 改从 `awaitedBy(self)` 按 event 取 outcome, 取走即 `hand` (排队中的 rcpt 事件撤单)。
- **涉及文件**: `daemon/index.ts` (2058-2077 wait_peer、tellPeerAsInner 的 re 分支), `daemon/router.ts` (mark/re 语义)。
- **验收**: typecheck 过; A 派 B, B 交 `NEED:`, A 收到 need 回执且行仍 open; A `re` 该 event, B 续答, A 收到 done; wait_peer 取走后回执不再 paste 第二遍。
- **前置**: T4。

## T6 失败合成与级联

- **目标**: sweeper 扫 `deadlineAt` → `answer timeout` (正文 = 守护进程说明 + owner 最后一句, 沿用 receipts.failure 文案); 注入事件 `finished` 无 result 累计 3 次 → `answer silent`; pane 死 + 5s 宽限 → `answer dead`; `stop_wizard`/`close_job`/interrupt → `subtree(e)` 级联 `answer canceled` (叶子先落, 发起者即 receiver 的不投); held 行前置失败 → `answer canceled` 带前置快照。子行 `deadlineAt = min(自带, 父行)` 在 open 时夹。
- **涉及文件**: `daemon/router.ts` (sweeper), `daemon/index.ts` (1500-1548、3231、3455 cancel 调用点), `daemon/receipts.ts` (failure 文案迁入 router 副作用层)。
- **验收**: typecheck 过; deadline:60 派一件不答的活 → 60s 后发话方收到 timeout 回执; stop_wizard 中层 → 子树全部 canceled、各 receiver 收到回执; 带 after 的活前置失败 → 不投且发话方收到 canceled。
- **前置**: T4。

## T7 孤儿与升级

- **目标**: 父行先 handed 后子行才交差 → 照常投 receiver, 信封标 `late`, 那一轮终句只进 rolepage; receiver wizard 已被 stop/注销 → 沿 `chain(e)` 找第一个活着的 receiver 以 `via .W (已不在)` 投给它, 到根 → 进根所在群 (Dead Letter)。
- **涉及文件**: `daemon/router.ts` (late/升级判定), `daemon/index.ts` (投递层 via 信封), `shared/reminder.ts` (信封加 `late`/`via` —— 此处新增属性, 旧属性删除留给 T10)。
- **验收**: typecheck 过; 父超时后子交差 → receiver 收到标 late 的回执; 收掉中间层后叶子交差 → 结论升级到再上一层 (或群)。
- **前置**: T4。

## T8 handoff 与 boot 恢复

- **目标**: handoff 删 `receipts.transfer` 清点钉答案; 新会话简报贴回后对 `owedBy(W)` 中 open 的行各注入「继续 `<event>`」(`route:<event>:resume`, 一轮一笔)。boot: fold 后 `answered` 未 `hand` 重入箱、`held` 重查前置、旧 `receipts.json`/`holds.json`/`answer-transfers.json` 改名 `.bak`。
- **涉及文件**: `daemon/handoff.ts` (181 附近、index.ts:1042 欠账续答), `daemon/index.ts` (1136-1155 恢复块)。
- **验收**: typecheck 过; 一件活进行中 handoff → 新会话收到「继续」且交差照回执; reload 后 answered 未 hand 的件重投一次且仅一次; 旧状态文件被改名且不再被读。
- **前置**: T4。

## T9 读侧切换

- **目标**: 名册/peek/list_jobs/rolepage 的 `receipts.states()` 全部改读路由表 + 一次 pane 探测 (turn-state 词表不变); 方向闸 `chainNow` 改读 `chain(e)`; `topOnlyMuted` 改读 `speaksToHuman(serves)`; `pending_items` 的 ledger 改投影 (主键 turn→event, `for/stack/mode`→receiver 快照, digest/render 不动); 删 `hasAnswerChildren`/`parentKOf`/`owedBy`/`stackDeps` 旧实现。
- **涉及文件**: `daemon/index.ts` (1085-1122、1262-1330、1351、2209、2385、2481、2797、2831、3507), `daemon/direction.ts`, `daemon/pending-items.ts`, `shared/turn-state.ts` (TurnSlot 适配行状态)。
- **验收**: typecheck 过; 名册的「在等/欠着」与 `GET /routes` 一致; 方向闸防环/链深行为不变 (构造链 W→B→C, B→W 被拦); topOnly 群里干活的 wizard notify 仍被退回、顶层不受影响; pending_items 全表/增量提醒照常出。
- **前置**: T3。

## T10 删除旧机制

- **目标**: §9.6 清单执行: `daemon/receipts.ts`、`daemon/receiver-stack.ts`、`daemon/answer-transfer.ts` 整文件删; message-events 删 continuation 代数与 `k`/`stack`/`mode`/`replyTo` 字段; mirror-bridge 删 answer 移交那组方法; reminder 信封删 `k`/`reply-to`/`turn`/`re`; MCP 删 `chain`/`receipt`/`answer` 参数; charter (`renderCharter` 里回执/件号的措辞) 与 CLAUDE.md 相关段落同步改。切换窗口选在 `GET /status` 无在途件时。
- **涉及文件**: 上述 + `daemon/mirror-bridge.ts` (3508-3577、7370-7371)、`mcp/server.ts`、`daemon/wizard.ts` (charter)、`CLAUDE.md`。
- **验收**: typecheck 过; 全仓 grep 不到 `ParentK`/`kAttr`/`receiver-stack`/`answer-transfer`/`awaitingContinuation`; daemon 起来且一次完整 人→管家→lead→执行 链路跑通。
- **前置**: T5、T6、T7、T8、T9。

## T11 回归重写与全量验收

- **目标**: 重写 `scripts/receipt-regress/run.mjs` 覆盖: 扇出全回/部分失败、同一对并发两件、W 同时欠三笔交错回来、同笔回执合并、NEED 往返 (自答/上冒)、transfer 两连跳 + 叶子 NEED 直达、RESULT 提前收口后 late、stop 中层级联、receiver 被 stop 后升级、reload 落在 answered 与 hand 之间 (不重投)、撕裂尾行。
- **涉及文件**: `scripts/receipt-regress/`。
- **验收**: 新 regress 全绿; CHANGELOG 以 **BREAKING** 记本次改造。
- **前置**: T10。

## 依赖总序

T1 → T2 → T3 → T4 → {T5, T6, T7, T8, T9} (互不依赖, 可并行但建议按号做) → T10 → T11
