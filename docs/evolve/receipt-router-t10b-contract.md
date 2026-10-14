# T10b 交接契约 —— `receipts.ts` 核心 + turn→event 主键迁移

> 落盘者: `.rcptt1` (T10a 执行者)。派活方: `.wezard`。
> 依据: `docs/evolve/receipt-router.md` §9.6 / `docs/evolve/receipt-router-tasks.md` T10 卡。
> 交接点: **T10a 已完成并绿**, T10b 在此快照之上开工 —— 不与你并行, `daemon/index.ts` 单 owner。

## 0. 交接点与安全网

- T10a 后工作树: `npm run typecheck` **绿**, `npm run build` + `./cli/wezard.sh reload` **过**, live 探针过 (见 §7)。
- 快照 (不要 `git checkout` 整文件 —— T1–T9 全部在未提交的工作树里):
  - `~/t10-bak/s0/` = T10a 开工前的绿态 (**含 `daemon/answer-transfer.ts`**)
  - `~/t10-bak/s2/` = T10a 完成后的绿态 (`index.ts` / `mirror-bridge.ts` / `peers.ts` / `wizard.ts` / `mcp/server.ts` / `CLAUDE.md`)
- 开工前先看 `GET /routes` 有没有 `deadlineAt` 已过的在飞行 —— 有就先等它收口或推期限, 再 reload。

## 1. T10a 已改 / 已删 (对照)

| 文件 | 动作 |
|---|---|
| `daemon/answer-transfer.ts` | **整文件删** |
| `daemon/index.ts` | `answers` / `setAnswerSilencer` / `answerSends` / `deliverTransferredAnswer` / `lostAnswer` / `terminalAnswerTurn` / `controlSnapshot`(带 `turn`) / `controlValid`(带 answer 判据) / `answerContext` / `answerSourceOpening` / `rawAnswer` / 两道 lost/terminal 守卫 / `controlTransfer` / `const answer` / `trackedTell.answerTransfer` / `answerContext` 分支 / answer-transfer 的 `renderReminder` / `if (answer !== "transfer")` 包裹层 / **`injectText` 投递路径整段 (~136 行)** / `events.delivery` 的 `transfer` 分支 / `/dispatch` 的 `answer` 参数与 answer-transfer 409 闸 |
| `daemon/mirror-bridge.ts` | 接口 7 个方法 + `answerBubbles` / `AnswerBubble` / `answerLine` / `writeAnswerProgress` / `updateAnswerProgress` / `answerContext` / `prepareAnswer` / `cancelAnswerPreparation` / `stopAnswerProgress` / `takeAnswer` / `deliverAnswer` / `silenceAnswer` / `answerSilent` / `activePeerTurn`(字段 + 4 处赋值) + exports 两项 |
| `mcp/server.ts` | `tell_peer` / `dispatch` / `spawn_wizard` / `clone_wizard` 删 `chain` / `receipt` / `answer` 三个参数及 `tellBody` / `Offspring` / `bear` 的对应行; `re` 描述改成 event id (`e…` / `<event>.<n>`); `RETURN_DOC` / `FOR_DOC` / `return` / `after` / `kind` 改述 receiver 边语义 |
| `daemon/peers.ts` | `renderReceiptEnvelope` 的 `via` 文案改**升级**语义 (不再说「接手作答 / transfer」); 「按下面的件号续问」→ `event` |
| `daemon/wizard.ts` | 4 处「件号」措辞 → 同一笔 / `event` |
| `CLAUDE.md` | 第 63 行整段 `receipts.ts` → `daemon/router.ts`; 另 3 处 (`k` / slot / pair) 措辞 |

### 1.1 一处必须知道的发现 (T10b 会撞上)

`tellPeerAsInner` 里 `injectText` 那条**同步投递路径** (原 2096–2226 行) **只服务 `answer:"transfer"`**: 结构是
`if (answer !== "transfer") { …events.accept…; return {…} }` + 「transfer 才往下走」。所以 `waitSec` / `untilIdle` / `interruptPane` / `dispatchGuard` / `trackedTell` / `accountWorkflow` / `jobs.attach` / `jobs.spend` / `relayPeer` / `physicalExposure` 全在 transfer 分支里, 是**死代码**。T10a 整段删掉后, 所有派活只剩 `events.accept`(T4 持久化路径) 一条。

## 2. T10b 范围 (未删)

### 2.1 文件与量

| 文件 | 剩余 |
|---|---|
| `daemon/receipts.ts` (80KB) | **整删** |
| `daemon/receiver-stack.ts` (8.9KB) | **整删** (但见 §2.2) |
| `daemon/index.ts` | `receipts.*` **49** 处 + 旧类型/函数符号 **52** 处 + turn 引用 **155** 处 |
| `daemon/message-events.ts` | 9 处旧类型 (`Tell`/`ParentK`/`HeldSeen`/`Frame`/`ReturnMode`) + 6 处 turn + `replyTo` |
| `daemon/workflow-plans.ts` | `ParentK` / `Prereq`; `PlanOrigin` `{k,stack,chain}` → `{event}` |
| `daemon/mirror-bridge.ts` | 31 处 turn (`TurnFrom.turn` / `env.turn`) |
| `daemon/peers.ts` | 7 处 turn + `TurnTag` (`renderPeerEnvelope` / `replyToPeer` / `lastAsk`) |
| `shared/reminder.ts` | 4 处 turn + `TurnTag` + `Envelope.turn/re/replyTo/k` + `ReceiptRoute.replyTo/k` |
| `shared/turn-state.ts` | `LegacyTurnSlot` (T9 留底) |

`index.ts` 的 `receipts.*` 成员分布:
`states`5 · `prereqs`5 · `cancel`5 · `pending`4 · `register`3 · `prepare`3 · `cancelHeld`3 · `watching`2 · `frameSlot`2 · `yielded`1 · `stop`1 · `stackFor`1 · `resume`1 · `parentOf`1 · `leafOf`1 · `inbox`1 · `handover`1 · `continuation`1 · `confirmDelivery`1 · `commit`1 · `cancelKeys`1 · `askerOf`1 · `ancestorsOf`1 · `Hold`1。

**假阳性提醒**: `cfg.wrc.mirror.receiptsFile` 是**配置路径**, 还被 workflow 存档用作前缀 —— `createWorkflowNodes(\`${receiptsFile}.nodes.json\`)`、`loadWorkflowPlans(\`${receiptsFile}.plans.json\`)` (`shared/config.ts:95` 是键定义)。删 `receipts.ts` 时**别顺手删这个配置键**: 要么保留键名 (语义改成「回执与工作流存档的基线路径」), 要么一并改 workflow 落盘路径并处理迁移。`.nodes.json` / `.plans.json` **不能**与旧状态文件一起改名。
`daemon/handoff.ts` 与 `daemon/peers.ts` 的 `receipts.*` 命中是**注释**, 实际零调用。

### 2.2 `receiver-stack` 为什么建议与 `receipts.ts` 一体做 (对 `.wezard` 原分工的偏差说明)

原分工把 `receiver-stack` 退役放进 T10a, 但代码依赖是反向的:

- `daemon/receipts.ts:26` 直接 `import { framing, type Frame, type ReturnMode, type Owed } from "./receiver-stack.js"`, 文件内 69 处旧类型 / 11 处 receiver-stack 函数依赖;
- `daemon/index.ts` 的**在飞派活路径**仍依赖它: `resolveReturn`(→ `ret.op` / `ret.frame` / `ret.stack` / `ret.served`)、`framing`(→ `framed`, 写进 tell 与信封)、`frozenReturn`(held / planned 分支)、`leafRelayOf`(`relayToLeaf`)。

所以 T10a 阶段删它只有两条路: (a) 把 ~125 行搬进**即将被删的** `receipts.ts` (纯搬运, T10b 再删一次); (b) 同时把 `resolveReturn`/`framing` 换成 receiver 边计算 —— 那已经是 T10b 的核心 (§9.5)。**建议 (b), 二者一体做**, 因此 T10a 未动 receiver-stack; 卡的验收 grep 里 `receiver-stack` 一项由 T10b 收口。

## 3. 类型契约 (T10b 必须遵守)

1. **主键 = event id** (`e`+6hex / `<parent>.<n>`)。旧件号 (`t`+6hex) 作废: `newTurn()` / `canonicalTurn()` 删除; 注入事件 id 由 `p:<self>:<target>:<turn>:<legs>` 改成 §9.3 的 `route:<event>` / `route:<event>:r<legs>`。
2. **信封属性**: `TurnTag.turn` → `TurnTag.event`; `Envelope` 删 `turn`/`re`/`replyTo`/`k`, 增 `event`/`serves`; `envelopeAttrs.peer` 只写 `event`; `envelopeAttrs.receipt` 保留 `status`/`job`/`done`/`total`/`asker-*`/`audience`/`via`/`late`, 去掉 `reply-to`/`k`。`LEGACY` 表**不动** —— 它产出的旧字段建议映射到 `event` (旧件号在 `router.get` 未命中即视为「不知道」, 与现状等价), 不要新增 legacyTurn 影子字段。
3. **attempt 键**: `workflow.byTurn(self, turn)` → `byEvent(self, event)`; `workflow.begin(...)` 的键参改传 event id; §9.5 计划节点 `PlanOrigin` `{k,stack,chain}` → `{event}`。
4. **派生查询替代 (一一对应)**:
   - `receipts.pending(self,target)` (同一对一个槽) → `router.awaitedBy(self).filter(r => r.owner === target)`; `open.turn` → 行的 `event`, `open.need`/`open.deferred` → 行的 `status`/`waiting`
   - `receipts.prereqs(self,afters,seen)` (after 前置态) → 逐 `router.get(e)`: 无行 → `unknown`; `outcome.status === "done"` → done; 有 `outcome` 非 done → failed(带 seen); `waiting(e)` 非空或 status ∈ {open,need,error} → pending
   - `receipts.states()` → `router.rows()` + 一次 pane 探测 (**样本已在 index.ts 的 `inflight`**, 1400 行附近)
   - `receipts.frameSlot(self,frame)` / `rowFrame` → `router.get(event)` + `receiver` 边; `frameSlot(...).job` → 行的 `job`
   - `receipts.leafOf` → `re` 按 event 直接取行 (owner 已随 `move` 更新), **不需要叶子跳转** → `relayToLeaf` 整块可删
   - `receipts.ancestorsOf` → `router.chain(event).map(r => r.owner)` (**样本: index.ts 的 `chainNow`**)
   - `receipts.askerOf(self,env)` → `env.asker` (T3 起信封已带)
   - `receipts.prepare(self,target,re)` → 新 helper: `re` 有行且 status ∈ {open,need,error} → 沿用该行的 event / `legs+1` / `job`; 否则新 event。**T5 已落 `reTarget` 逻辑, 直接沿用** (含 accept 后的 `ops.mark({status:"open"})` 回拉)
   - `receipts.register` / `watching` / `commit` / `confirmDelivery` / `resume` / `inbox` / `stop` → **删** (T4 `deliverRoute` + T8 `replayAnswered`/`settleHeld` 已接管; boot 的 `receipts.resume()` 与 answers 恢复块 T10a 已清)
   - `receipts.cancel` / `cancelHeld` / `cancelKeys` → **删** (T6 `cancelOps`/`cancelRoutes` 已接管); `cancelRoots` 里的 `rowFrame.get` 改按行的 `receiver`/`job` 判
   - `receipts.continuation(from,to,turn)` (idle-nudge) → 按 event 造 tell, 走 `acceptContinuation`
   - `receipts.Hold` / `holdsFile` → **删** (held 语义已在行上: `status:"held"` + `after[]`; boot 重查 = `settleHeld()`)
   - `receipts.parentOf` / `hasAnswerChildren(self, ParentK)` → `router.waiting(servesEvent)`
5. **⚠️ 一个真实功能缺口 (不是纯删除)**: `settleHeld()` 现在只 `commit(ops.release)` —— **没有人负责把放行后的活投出去**。旧的注入在 `createReceipts` 的 `release` dep 里 (`tellPeerAs(h.from, h.body, afterNote(...), {...})`)。T10b 必须补: `release` 之后按行的 owner / 信封 (存哪?) 走 `route:<event>` 注入。**这需要先决定 held 行怎么保存「它要注入什么」** (建议: 行上加 `text`/`kind`/`job` 快照, 或在 open op 时一并落一份注入载荷)。这是 T10b 唯一需要新设计的地方。
6. **状态文件**: `receipts.json` / `holds.json` / `answer-transfers.json` —— §9.6 要求 boot 时**条件**改名 `.bak`: 窗口条件 = `GET /status` 无在途件 **或** `GET /routes` 无 `open|need|error|held` 行; 不满足就这次不归档, 下次 boot 再试。T8 已确认把这条留给 T10b。pending 账本归档后老件号键行自然消失 (`pending-items.ts` 主键 T9 已改 event)。

## 4. 建议顺序与门

1. `shared/reminder.ts` 信封属性迁移 (`turn`/`re`/`replyTo`/`k` → `event`/`serves`) + 四个消费者 (`index.ts` / `peers.ts` / `mirror-bridge.ts` / `message-events.ts`)。
2. `index.ts`: 旧 `receipts.*` → §3.4 的派生查询; `re` / `for` / `after` 的件号参数面在入口一次性换成 event id。
3. 补 §3.5 的停放放行注入 (唯一的真缺口)。
4. `receiver-stack` 的 `returnOpOf` 校验逻辑迁入 `openDispatchRow` 入口, 删 `resolveReturn` / `framing` / `frozenReturn` / `leafRelayOf` / `Stack` 机器。
5. 删 `daemon/receipts.ts` + `daemon/receiver-stack.ts`; 清 `message-events.ts` / `workflow-plans.ts` / `turn-state.ts` 的字段与类型 (`k`/`stack`/`mode`/`replyTo`/`awaitingContinuation`/`continuationGeneration`/`currentContinuation`/`parentGeneration`/`defer`/`continueResult`/`LegacyTurnSlot`)。
6. 状态文件条件归档。

**每步 `npm run typecheck` 必须绿再往下; build 前必须绿** —— `tsconfig.json` 没设 `noEmitOnError`, 带类型错也会 emit, 坏 dist 一 reload 就是 crash loop (`SyntaxError: … does not provide an export named …`)。

## 5. 验收 (T10 卡)

- `npm run typecheck` 过;
- `grep -rn "ParentK\|kAttr\|receiver-stack\|answer-transfer\|awaitingContinuation" daemon mcp shared` 为空;
- daemon 起来且一次完整 人→管家→lead→执行 链路跑通。

## 6. 坑 (交付给 T10b)

- **别在条件恒真时把 `if (…) { … }` 换成裸块 `{ … }`**: TS 会把块尾判成不可达 → 块**之后**的代码被判 unreachable → 收窄全部失效, 表现成一堆**假错** (`'x' is possibly 'undefined'`、`Property 'op' does not exist on type 'Resolved'`)。就地删掉 `if` 的花括号并整体**反缩进**。
- 按「起点锚 → 终点锚」写 `cut` 脚本时, 先确认两锚之间**只有**要删的东西 —— T10a 第一刀把 `onOutcome` 里 `workflow.outcome` / `advancePlans` / `ledger.outcome` 三条语句一起切掉了。
- 探针遗留行 (`eacf0f7` / `efe7686` / `e4228b5` / `e4ad83b` / `e1d6817` / `e5d60f1.*` / `eebed43.*`) 是 T6/T7 的料, **别清**。
- 共享工作树可能有别人 WIP; 判自己的改动只看自己碰的行/符号。

## 7. T10a 的 live 验证 (交接凭证)

`dispatch({spawn:true, tier:"mini", name:"t10aprobe", task:"只回一行: RESULT: t10a-probe-ok"})` 之后 `GET /routes`:

```
e8e276b  handed  owner=…#t10aprobe  → …#rcptt1 (detach)
         dl=2026-10-14T12:06:39Z  done: RESULT: t10a-probe-ok
```

即 `open → answer(done) → hand` 三拍齐, 探针已 `stop_wizard({forget:true})` 收掉。

## 8. T10a 的副作用: 测试/夹具

`scripts/receipt-regress/run.mjs` **不受影响** (不引用 answer-transfer)。
引用被删模块、现在会**运行时**报错的:

- `tests/workflow-http-fixture.mjs:17` —— `import {…} from '../daemon/answer-transfer.ts'` (这个夹具在 HEAD 就是红的, 且按字符串切片从 `daemon/index.ts` 取代码, 见 T10 卡的注意项)。它同时切了 `daemon/index.ts` 的字面量 (`lostAnswer:` / `terminalAnswerTurn:` / `controlSnapshot` / `controlValid`), T10a 已改了这些字面量 → 夹具的切片锚点需要一并更新。**归 T11 (回归重写) 处理, T10a 未动 `tests/`。**
- `tests/answer-transfer.test.ts` —— 整个文件针对已退役协议, 建议 T11 删除。
- `tests/message-format.test.ts:30` —— 只是一句断言文案含 "answer-transfer", 无依赖, 可留可改。

`tests/**` 不在 `tsconfig.json` 的 `include` 里, 所以 **typecheck 不受影响**。
