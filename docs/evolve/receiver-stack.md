# 回执的金字塔路由: receiver stack (现状与方案, 定稿)

> `.rcptstack` · 2026-10-13 · 只研究 + 出方案, 未改代码 · 人已拍板 (见 §5), 本批实施 ①-③
> 人的原话: 「receipt 应该按照金字塔结构来传递: 在 dispatch/tell 的时候, 调用者可以显式传递 receiver stack 或者是否 transfer (自己不再接受回执), 然后由 daemon 来判断这个交派任务的 receipt 应该传给谁。路径要统一且优雅。」
> 对照: `daemon/receipts.ts` · `daemon/index.ts` · `daemon/answer-transfer.ts` · `daemon/message-events.ts` · `daemon/mirror-bridge.ts` · `daemon/peers.ts` · `daemon/direction.ts` · `shared/reminder.ts` · `mcp/server.ts`; 前作 `b2-reply-routing.md` (父 k 的由来)

## 0. 一句话

现在的「父 k + deferred + relay」已经是一个**隐式的、只有一层深的调用栈**: 每件子活只记它的直接父 (`k`), 祖先靠从回执槽往回走临时拼出来; 调用者能做的选择只有两个 —— 挂上 (默认) 或不挂 (`chain:false`)。「尾调用」(`answer:"transfer"`) 只为「人在 topOnly 群里问的那一轮」单独实现了一套协议。
方案: **栈由 daemon 物化并随件落盘; 调用者不递栈, 只对自己那一帧下操作** —— `return: "self" | "transfer" | "detach" | "none"` 加上可选的 `for: <件号>` (挑自己欠着的哪一笔)。daemon 用一套规则 (defer / relay / adopt) 裁决每份回执的去向, peer 帧与 chat 帧走同一套, 把现在三条并行的续回实现收成一条。

## 1. 现状

### 1.1 数据: 父 k 只记一层

| 东西 | 位置 | 内容 |
|---|---|---|
| `ParentK` | `receipts.ts:93-104` | `{chat, channel, turn}` = 那一轮是人/定时在群里开的; `{peer, from, turn}` = 那一轮是 `from` 私聊派来的件 `turn` |
| `Tell.k` / `Slot.k` | `receipts.ts:233-234` | 子活登记时冻结的父 k, 落盘 (`receipts.json`) |
| 信封 `k` / `reply-to` | `reminder.ts:119-126`, 回执投递 `index.ts:957-981` | 回执轮的开头信封写着 k (下一跳继承) 与 reply-to (这轮终句去哪) |
| `Hold.k` | `receipts.ts:193-208` | 停放 (after) 件冻结的父 k, 放行时沿用 |
| `MessageEvent.k / replyTo` | `message-events.ts:15-16` | 新的持久化注入队列上的同一对字段 |

### 1.2 父 k 怎么算: 读调用者「这一轮」的开头信封

`parentKOf(self)` (`index.ts:1089-1093`) → `receipts.parentOf` (`receipts.ts:1028-1037`), 只看 self transcript 里开这一轮的那句 user 行:

| 开头信封 | k |
|---|---|
| `quiet` (fyi / receipt:false 派来的) | 无 |
| 回执 (`receipt=1`) | 继承回执信封上的 `k` |
| 私聊 peer 派来的, 且那份槽 (X→self) 未落定 | `{peer, from: X, turn}` |
| 其余, 且 `channel` 非空 (人 / 定时 / 公开轮) | `{chat, channel, turn: eventId ?? opening ms}` |
| 私聊轮 (`channel === ""`) | 无 |

k 的**写入点** (改入口前必须全找到, 共 7 处):
1. `tellPeerAsInner` `index.ts:1567`: `planned ? planned.origin.k : held ? held.k : actor?.k ?? (chain===false ? undefined : legs>1 ? turn.k : parentKOf(self))`
2. `dispatch` `index.ts:2770-2772`: `dispatchOrigin.k = parentKOf(self)` —— **不看 chain** (MCP 的 dispatch 也没有 `chain` 参数, `mcp/server.ts:848-862`)
3. `bearAs` (spawn/clone 带 task) `index.ts:2930`
4. workflow plan 的 origin `index.ts:3128`
5. 停放 `receipts.hold` → `Hold.k`; 放行 `index.ts:950` 原样带回
6. 续问 / 追问 / 打回复制: `receipts.prepare` `:925-931`、`continuation` `:913-917`、`reask` `:918-924`、`watch` 里的 rebound `:697`
7. 交接 `carryOpts` `index.ts:1028-1034` (欠账续答那一轮挂发话方的信封, 下一跳据此再推)

### 1.3 路由规则 (peer 侧, `receipts.ts`)

- **谁收回执**: 永远是 `Slot.from` (发话方自己) —— `consume` 把回执 paste 进 `from` 的输入框 (`:567-628`)。
- **子活挂住上游** (deferred, `:685-690`): 上游件 P (X→A) 的 watcher 取到 A 的终句时, 若 A 在答 P 那一轮里派出了 k = P 的子活 (`children` `:372-376`, 含停放件) 还没落定 → A 那句「已派」不是定论: 不投、不计数, `P.deferred = true`, 不再守。
- **回执轮续回** (`routeOf` `:389-397`, 只在投递那一刻算): 子回执投进 A 时, 同一发话方同一 k 的兄弟 (`siblings` `:379-382`) 还没落定 → 这一轮 `channel:""`、不写 reply-to, 只进 rolepage; 都落定了 → `k.kind==="chat"` 则 reply-to = 那个群 (终句进群); `k.kind==="peer"` 且 P 未落定未取走 → reply-to = `.X`, 投递 ACK 落盘后 `relay(P, sentAt)` (`:400-404`, `finishMail` `:559-566`) 把 P 的锚挪到这份回执、重新 arm。P 的 `answerOf` 认 `reply-to=.X` + `k=peer:<turn>:…` 的回执信封作为问话 (`peers.ts:598-599`)。
- **子活失败也是定论**: timeout/silent/dead/canceled 照常投递并参与 routeOf; 子活没送进 A (A 不在、wait_peer 取走) → `release` (`:414-417`) 也会叫醒 P, 锚不动。
- **chain:false**: k 为空 → routeOf 第一行就返回 `channel:""`, 不挂住任何人 (`:391`)。
- **job 计数**: 按成员记, 终态写一次 —— `account` → `deps.settleJob` (`:549-556`), 数字来自账本 `jobTally`, 不来自槽 (`:587-592`); deferred 的 P 不计数直到续回出定论; 顶掉一份未落定工单活的新句继承工单 (`register` `:737`)。
- **timeout/silent/dead/canceled**: `awaitReply` (`:467-511`) 合成失败正文 (`failure` `:514-529`), 走与 done 同一条 inbox 投递; `cancel` (`:989-1014`) 发起方自己那份不投, 别的发话方各收一份。

### 1.4 chat 侧: 另一套续回

人在群里开的那一轮 (MessageEvent E) 派了活:
- `peerEvents.accepted` `index.ts:1492`: 子活事件被接受时 `events.defer(E, true)` → `E.awaitingContinuation`。
- 子回执事件带 `replyTo={chat, turn:E}` 时 `message-events.ts:160-165` 把 E 的 `currentContinuation` 指到它、代数 +1。
- 终句是否发进群由 `eventFinalGate` (`index.ts:1539`) 判: 不在等续、没有 `pendingDelivery`、没有 `hasAnswerChildren`、不是已移交回答权的源。
- 回执轮出了终句, `recoverEventFinal` (`mirror-bridge.ts:3433-3453`) 沿 replyTo 把它记成 E 的答案并 `queueFinal` 进群。

即同一个「子活没回完, 上一层的交代先压着; 最后一份回来那一轮替上一层交代」的语义, peer 侧是 `Slot.deferred + relay`, chat 侧是 `MessageEvent.awaitingContinuation + continuationGeneration`, 两份代码。

### 1.5 transfer: 只有 chat 帧有尾调用, 而且是第三套协议

`answer:"transfer"` (`index.ts:1588-1590` 前置, `:1795-1833` 执行, `answer-transfer.ts` 全文):
- 前置极窄: 当前轮必须是**真人**在 **topOnly** 群里问的 (`k.kind==="chat"`), 且不带 job / re / node / after / chain:false / receipt:false / fyi, 没有别的子活, 目标闲着且手上没活。
- 语义: 目标接手人的回答权 + 控制权, 抢过原气泡 (`takeAnswer`), 目标终句由 `deliverAnswer` 唯一交付给人 —— **不回给派活方**; 源这轮之后的产出全部静默 (`lostAnswer` `index.ts:1073`, `setAnswerSilencer` `:1088`, `topOnlyMuted` `:1233-1243`)。
- 落盘是独立的 `AnswerTransfer` 行 (reserved→active→delivering→delivered/uncertain), 回执槽上只挂一个 `answerTransfer` id, `watch` 里单走一支 (`receipts.ts:706-720`)。
- peer 帧 (A 在答上游 wizard U) 没有尾调用: A 必须留着, 收 B 的回执、再用一整轮转述给 U。

### 1.6 topOnly 收口

`topOnlyMuted` (`index.ts:1233-1243`): 这一轮「为同伴干活」(私聊 peer 派来的, 或回执轮且 k 是 peer) 就不许 notify 进 topOnly 群; 再叠加移交回答权的三条特判 (源已移交 / 目标已落定 / 目标进行中)。即「我这一轮的终句归谁」在这里又被按信封重新推了一遍。

## 2. 现有机制的缺口

| # | 缺口 | 现象 | 根因 |
|---|---|---|---|
| G1 | peer 帧没有尾调用 | A 只是把 U 的活整件转给 B, 仍要占一轮、一份上下文去转述; B 的 NEED / 失败也要 A 中转; 金字塔每多一层就多一跳延迟和一次失真 | transfer 只为 chat 帧实现 (1.5) |
| G2 | 「这件子活为哪笔欠账派的」只能靠推断 | 推断 = 本轮开头信封 (1.2)。两句话挤进一个输入框被当成一轮读掉时只认第一句, 第二个发话方的欠账挂不上子活; 交接后一轮续一笔欠账 (`carryRest`) 外, 模型无法在别的轮里说「这件是替 X 那笔派的」; 侧支回执轮 (无 k) 里想替真正的上游派活也挂不上 | 调用者没有表达「为哪一帧」的参数 |
| G3 | 栈不落盘, 祖先现拼 | `ancestorsOf` (`receipts.ts:1038-1048`) 沿槽往上走, 槽被同一对的新一句顶掉 / 24h 过期就截断 —— 方向闸的防环 / 链深 (`direction.ts:39,54`) 跟着漏; 反过来第一跳「按定义在途」, 上游已落定时仍被当在等, 可能误拦 | 只存直接父 |
| G4 | dispatch 不能 `chain:false` | dispatch 永远挂到当前帧 (`index.ts:2771`), 旁支活只能改用 tell_peer | 参数面不齐 |
| G5 | 三套续回实现 | peer deferred/relay、chat awaitingContinuation、answer transfer 各自记账; topOnly 闸、eventFinalGate、hasAnswerChildren 又各自重推一次「终句归谁」 | 没有统一的「欠账 (obligation)」抽象 |
| G6 | 正交参数互相打架 | `receipt:false` / `kind:fyi` / `chain:false` / `answer:"transfer"` 都在回答「回执去哪」, 却是四个独立开关, 组合规则只能靠 `:1588` 那一长串互斥 | 同一个维度被拆成多个布尔 |

不是缺口 (方案不必管): 依赖顺序 (`after`)、评审打回 (`accept` + rebound)、一对一槽位 (`parked`) —— 它们说的是「什么时候投 / 投什么」, 不是「回给谁」。

## 3. 方案

### 3.1 核心抽象: 帧 = 一笔欠账

```ts
/** 「owner 欠 creditor 一个交代」。就是现在的 ParentK, 只是承认它是一笔可被栈引用的欠账。 */
type Frame =
  | { kind: "chat"; channel: string; turn: string }   // owner 欠人: 群里那一轮 (MessageEvent)
  | { kind: "peer"; from: string; turn: string };     // owner 欠 from: 回执槽 from→owner 的件 turn
/** 一件子活的 receiver stack: 它的结论最终要逐层冒到哪儿去, 近的在前。 */
type Stack = readonly Frame[];
```

每件派出去的活 c (发话方 A → 目标 B, 件号 tc) 落盘三样:
- `stack: Stack` —— A 派它时所服务的那一帧及其全部祖先 (`stack[0]` 就是今天的 `k`)。
- `mode: "self" | "transfer"` —— c 的结论先交 A (A 再续一轮), 还是直接顶替 A 对 `stack[0]` 的交代。
- 现有字段不动 (`from/to/turn/job/...`)。

`stack` 由 daemon 在派活那一刻算出: 选定帧 f (见 3.2 `for`) → `stack = [f, ...stackOf(f)]`, `stackOf(f)` 读 f 那笔欠账自己落盘的 stack (peer 帧 = 槽 `f.from→A` 的 `stack`; chat 帧 = `[]`, 人是根)。**整条链随件冻结, 不再现拼** (修 G3)。

### 3.2 调用者面: 不递栈, 只对自己那一帧下操作

为什么不让调用者传一个原样的栈: 帧是欠账, 只有 daemon 能证明「谁在等谁」。调用者手写栈 = 能把回执投进它没在服务的群、投给没在等它的 wizard, 也能伪造链头绕开方向闸和 topOnly。所以「显式」落在**操作**上, 栈本身是 daemon 物化的数据。

tell_peer / dispatch / spawn_wizard / clone_wizard (带 task) 统一两个参数:

```ts
return?: "self" | "transfer" | "detach" | "none";   // 默认 "self"
for?: string;                                         // 件号 / 群轮 id: 这件活为我欠着的哪一笔派的; 默认 = 本轮开头那笔
```

| `return` | 含义 | 物化结果 | 取代 |
|---|---|---|---|
| `self` (默认) | 子结论先回我, 我据此再交代上一层 | `stack=[f,…]`, `mode:"self"` | 默认 chain |
| `transfer` | 尾调用: 我把这一帧整件交出去, 自己不再收回执、不再对 f 交代 | `stack=[f,…]`, `mode:"transfer"` | `answer:"transfer"` (并推广到 peer 帧) |
| `detach` | 与我在服务的任何一帧无关的旁支: 结论回我, 但不挂住上游 | `stack=[]`, `mode:"self"` | `chain:false` |
| `none` | 放出去不管, 无人收回执 | 不登记槽 | `receipt:false`; `kind:"fyi"` 隐含它 |

`for` 的校验: 必须是 **self 此刻欠着、尚未交代**的一笔 —— 某个未落定未取走的槽 `X→self` 的件号, 或一个以 self 为 target、终句未发的 chat MessageEvent。查不到 → 400 并列出 self 欠着的那几笔 (与 `re` 的 `reUnknown` 不同: 挂错帧会把别人的交代压住, 不能静默降级)。不给 `for` 时 = 今天的 `parentOf` 推断 (修 G2, 默认行为不变)。

### 3.3 daemon 裁决规则 (一套, 帧无关)

对每一笔欠账 F (peer 帧 = 回执槽; chat 帧 = MessageEvent) 统一三种状态迁移:

**R1 defer** (今天 `receipts.ts:685-690` + `index.ts:1492`):
F 的 owner 交出终句时, 若存在 `stack[0]===F`、`mode:"self"`、未落定的子活 → 这句不是定论, F 置 `deferred`。

**R2 relay** (今天 `routeOf` + `relay` + `recoverEventFinal`):
`mode:"self"` 的子回执投进 owner 时, 兄弟 = 同 owner 同 `stack[0]` 未落定者。有兄弟 → 这一轮只进 rolepage; 没有 → reply-to = `stack[0]` 的 creditor (群名 / `.X`), 回执轮的终句就是 F 的答案: peer 帧改锚重守 (现状), chat 帧推进 continuation 代数 (现状)。

**R3 adopt** (新; 今天 chat 帧的 answer transfer 是它的特例):
`mode:"transfer"` 的子活 c 登记时, F 置 `delegate = {to: B, turn: tc}`:
- F 的 watcher 不再读 A 的 transcript, A 的 pane 死活与 F 无关 (`awaitReply` 跳过 A 的 paneLive / dead 判定)。
- A 这一轮及之后对 F 的任何产出都不算 F 的答案; A 对 f 再派活 / notify → 409 (今天 `lostAnswer` 的推广)。
- c 落定 (含 need / error / 失败) → **以 c 的 outcome 直接落到 F** 并按 F 的去向投递: peer 帧 = 回执投给 X, 信封 `from=.A via=.B`; chat 帧 = 走现有 answer-transfer 交付通道 (气泡接管、`deliverAnswer`)。c 自己的槽随即 settle, 不投给 A。
- 连续尾调用 (B 再 transfer 给 C): C 的栈 = B 所服务帧的栈 = 仍以 F 开头, F.delegate 前移到 C —— 一跳直达, 中间层不经手。

由此 topOnly 的判定化成一句 (修 G5): **这一轮能对人说话 ⇔ 本轮所服务帧的 creditor 是 chat 帧** —— 人开的轮、`stack[0]` 是 chat 的回执轮、被 chat 帧 adopt 的接手轮; 管家在自家群的豁免照旧。`topOnlyMuted` 里三条移交特判、`eventFinalGate` 里的 `hasAnswerChildren` / `answers.*` 都退化为「读帧状态」。

### 3.4 与现有约束的兼容

| 方面 | 规则 |
|---|---|
| job 计数 | 计数仍挂在「件是哪张单的成员」上, 不挂在栈上。adopt 时 F 落定只 `settleJob` 一次 (F 所在的单); c 本身不是成员, 不计。`return:"transfer"` 与 `job` (A 作开单者把子活记进自己的单) 互斥 —— A 交出了这一帧, 没人会 close_job。F 在 U 的单里且有验收 (`accept`) → 验收作用在 F 落定时的正文上, 打回 (rebound) 沿 delegate 打给叶子 B。 |
| `expect` / `maxTurns` | 不变: 预算算在派活方 (A 的 transfer 不花 U 的预算)。 |
| reply-to 续回 | `mode:"self"` 完全等同现状 (R2 就是现在的 routeOf / relay)。transfer 没有 A 的回执轮, 不存在续回。 |
| NEED 逐层上冒 | `self`: 照旧由 A 先答。`transfer`: B 的 NEED 直达 U —— A 交出这一帧即意味着放弃中转; 想自己接 NEED 就别 transfer (宪章写一句)。U 用 `re: <F 的件号>` 答, daemon 按 `F.delegate` 转给叶子 (同件号续问)。 |
| 期限 | c 不带 `deadline` 时继承 `F.deadlineAt` (F 的期限不因转手而延长); 带了就取二者较早者。 |
| `stop_wizard` / `cancel` | `cancel(target=A)` 不能再把 `delegate` 过的 F 落成 canceled (今天按 `to===A` 一刀切, `receipts.ts:993`) —— F 已不在 A 手上; 收掉叶子 B 才 cancel F。 |
| `wait_peer` 取走 | U 取走 F → F.claimed; c 落定时 adopt 无处可投, 等同今天的 `release`, c 静默 settle。 |
| 方向闸 | `chain` 改读冻结的 `stack` 的 peer 帧 owner 列表 (精确, 不截断)。transfer 之后 A 不再在 B 的链上 → B 可以反过来问 A (A 已脱身, 正确)。`K_CHAIN_MAX` 按 stack 深度算, transfer 不增深。 |
| 互斥 | `transfer` 与 `re`、`node`、`after`、`kind:"fyi"` 互斥 (与今天一致); 与 self 在同一帧下还有未落定子活互斥 (歧义: 谁来交代); 一帧只能被 transfer 一次 (`answers.reserve` 的独占性推广到 peer 帧)。 |
| 停放 (after) | Hold 冻结 `stack` + `mode` (取代 `Hold.k`), 放行原样带回。v1 不开放 `after` + `transfer`。 |
| 交接 | 欠账转进新会话时帧不变 (身份不变); `carryRest` 每一笔欠账开一轮的做法保留, 但新会话里派活可用 `for` 精确挂到任一笔。 |

## 4. 迁移

旧 MCP 进程会在跑很久 (同 `send_peer` 别名的理由), 旧字段**永久接受**, 只在描述里标「旧写法」。

| 步 | 内容 | 行为变化 |
|---|---|---|
| ① 收口写入点 | 新增 `resolveReturn(self, body, origin?) → {stack, mode, frame}`, 1.2 列的 7 个写入点全部改调它; Slot / Hold / MessageEvent / ledger 增 `stack`、`mode`, `k` 保留为 `stack[0]` 的冗余 (旧读者照读)。读老盘: 无 `stack` 的行按 `[k]` + 现拼祖先兜底。`ancestorsOf` 改读 `stack`。 | 无 (仅 G3 精确化)。必须跑 `node scripts/receipt-regress/run.mjs`。 |
| ② 参数面 | MCP 四个工具加 `return` / `for`; 旧字段映射: `chain:false`→`detach`, `receipt:false`→`none`, `answer:"transfer"`→`transfer`; 同时给出新旧且矛盾 → 400。dispatch 顺带获得 `detach` (修 G4)。`for` 上线 (修 G2)。transfer 此步仍只放行 chat 帧 + 今天的前置。 | 新能力, 旧调用不变。 |
| ③ peer 帧 adopt | 实现 R3 的 peer 分支: `Slot.delegate`、watcher 跳过、cancel 排除、re 转叶子、回执信封 `via`。 | 修 G1。 |
| ④ 并账 | 抽 `Obligation` 接口 (`state / defer / relay / adopt / creditor`), peer 槽与 chat MessageEvent 各做一个适配器; answer-transfer 的气泡协议降为 chat 适配器的 adopt 实现细节; `topOnlyMuted` / `eventFinalGate` / `hasAnswerChildren` 改读帧状态。 | 修 G5; 行为不变, 删重复。 |

`receipt-regress` 需新增的场景: transfer 两连跳直达; transfer 后 stop 源头不殃及上游; transfer 叶子 NEED 直达 U 且 U 的 re 落到叶子; `for` 挂到非开头那笔欠账; dispatch detach 不挂住上游; 老盘无 stack 行的续守。

## 5. 决议 (2026-10-13 人已拍板, 方案定稿)

1. **已定 · 只开放操作, 不传原样的栈**: 调用者只用 `return` (`self/transfer/detach/none`) + `for`, 栈由 daemon 物化 —— 理由见 3.2 (帧是 daemon 才能证明的欠账)。「跳过 n 层直接交给祖父」= 中间每层连续 transfer; v1 不提供 `return:{pop:n}`。
2. **已定 · wizard 间 transfer 后接手方的 NEED 直达上游**, 绕过「NEED 逐层上冒」: transfer 即放弃中转; 上游用 `re: <F 的件号>` 答, daemon 按 `F.delegate` 转给叶子。想自己接 NEED 就别 transfer (宪章写一句)。
3. **已定 · 第 ④ 步 (Obligation 并账) 另起一批**: 本批只做 ①-③ (关掉 G1-G4); ④ 在 peer adopt 稳定后单独立项, 风险集中在 chat 气泡协议。
