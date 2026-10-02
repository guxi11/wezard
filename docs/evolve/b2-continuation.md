# B2 · continuation 补全: 审查 + 实现草稿

> `.ev-proto` · 2026-10-02 · 审的是 [roadmap.md](roadmap.md) 的 B2 ①–⑤ (⑥ 是 UI, 不在本文范围)
> 对照代码: `daemon/receipts.ts` · `daemon/jobs.ts` · `shared/reminder.ts` · `daemon/peers.ts` (`replyToPeer` / `answerOf` / `extractResult` / 信封渲染) · `daemon/index.ts` (`tellPeer`、clone/spawn 的 `receipts.register`、`deliver`) · `daemon/graph.ts` (`waitForIdle`) · `daemon/mirror-bridge.ts` (`idleVerdict` / `untilIdle`)

## 0. 结论

B2 方向对, 但按 roadmap 的写法直接做, 有三处会落空、两处会引入回环。

| # | 问题 | 严重度 | 处理 |
|---|---|---|---|
| P1 | **回执等待用错了「闲」的判定**: `awaitReply` 用 `waitForIdle(s.to, deps.isBusy)`, 也就是 pane 的 spinner。停在**本地**对话框上的 wizard (hook 回落成 `ask`、AskUserQuestion 等; 走 wezard 长轮询的那种审批期间 spinner 大概率还在, 未实测) 没有 spinner, 被判成「闲」, 长工具调用的间隙也可能误判; `answerOf` 见那一轮还开着, 返回 "", 记一次 `fruitless`。连着 3 次 (约 20s ramp + 3×2.5s 确认, 每圈 ~30s), 回执就**静默丢弃**。`index.ts` 已经给了 `deps.untilIdle` (注册表 status, 把悬着的审批算作不闲), 但 receipts 只在发话方那一侧用它 | 高 (可能是 `.receiptmiss` 的成因之一, 未实测) | 第一个提交就把 awaitReply 改走 `untilIdle`, 再把「卡在审批」显式化为 `blocked` (§2.1)。在这之前, 不能删 charter 里「迟迟不来就 peek」那一句 |
| P2 | **「全部到齐」数的是已登记的 slot, 不是工单成员**: `meta.total = ofJob(from, job).length`。第 1 份回来时第 5 路还没派出去, 就会报 `1/1 全部到齐`。另外 slot 按 **(from, to) 一对**为键: 同一对在工单 J2 里又说一句, J1 那份就被顶掉, J1 的总数少一 | 高 | total 取 `max(工单成员数, slot 数, expect)`; open_job 加可选 `expect` (§2.5) |
| P3 | **失败分支不止 roadmap 列的三种**。现在静默丢弃的路径有五条: ①对方超时 ②对方停了 3 次都没答 ③对方 pane 死了 (`paneBusy` 对死 pane 报「闲」, 最后落进 ②) ④**发话方忙满 1800s 就放弃** (`SENDER_WAIT_SEC`) ⑤`deliver` 失败。roadmap 只覆盖 ①②③。④ 最隐蔽: 发起者在长工具调用里, 回执到了反而被扔掉 | 中 | ①②③ 合成失败回执投递; ④ 发话方活着就一直等 (上限是 slot 的保留期); ⑤ 记 `status=undelivered` 留给 observe |
| L1 | **NEED 打开了一条回环通道**: 分身 `NEED:` → 发起者 `tell_peer({re})` → 分身又 `NEED:`…… 现在唯一的刹车 (`maxTurns`) 排在 B4 | 中 | 每个 turn 的 NEED 往返过 3 次 (`legs > 3`) 起, 信封**提示**对方直接给 `RESULT:` 并写清假设 —— 不在 daemon 里拒 (见 §3); 硬刹车是工单的 `maxTurns` (B2a ⑦) |
| L2 | **超时后的迟到答案**: 投了 `timeout` 之后对方又答出来, 要不要再投一次? 投就是同一件活出两个终态, 工单计数也会出错 | 中 | **不投**。终态不可变 (A2A / MCP tasks 都这么规定); 迟到的答案用 peek 能读到, 要追就 `tell_peer({re})` (§2.2) |

另外, roadmap 写的「派生 (不新增存储)」不完全成立: 终态 (`done` / `timeout` / `canceled`…) 在 reload 之后、或 pane 已经没了之后, 无法从实时探测里重新算出来, 必须落进 Slot。好在只是在已经落盘的 Slot 上多几个字段, 不需要新文件。

## 1. 现状模型 (改之前先认清)

- **一对 wizard 同一时刻只有一份在飞**: `slots: Map<"from\0to", Slot>`, 新的一句 `gen+1` 把旧的作废 (`stale`)。turn id 的设计要么顺着这个模型, 要么推翻它。**建议顺着**: 「同一对又说了一句」本来就意味着上一句的回执不再需要, 推翻要重写 `claim` / `sentAt` / `wait_peer` 的定位, 不值。
- **答句定位靠信封**: `answerOf` 在对方 transcript 里找挂着 `kind=peer from=.我` 的那一句 user 行, 往后取这一轮的终句, 三态 (`undefined` 老 wizard / `""` 还没答 / 文本)。
- **回执注入不登记新的 watcher** (`deliver` 直接 `injectText`, 不走 `tellPeer`), 所以回执天然不会再产生回执。NEED 必须保住这一点: 发起者答 NEED 只能显式调 `tell_peer({re})`, 不能让「收到 NEED 那一轮的回复」自动回送。
- **规矩随信封传播, charter 只是快照**: 在跑的 wizard 读不到新的 charter, 但每一次注入都带着当时渲染的信封。所以 `NEED:` / `ARTIFACT:` 的约定**写进 peer 信封的正文**, 第二天所有在跑的 wizard 就都懂了, 不必等它们重生。

## 2. 设计

### 2.1 状态集 (`shared/turn-state.ts`, 新)

```ts
export type Terminal = "done" | "timeout" | "silent" | "dead" | "canceled" | "claimed";
export type TurnState = "working" | "blocked" | "needs-input" | Terminal;

/** 纯函数: 终态以 Slot 为准, 未终态的由两个实时探测补上。 */
export const turnState = (s: { status?: Terminal; need?: boolean }, probe: { parked: boolean }): TurnState =>
  s.status ?? (s.need ? "needs-input" : probe.parked ? "blocked" : "working");

export const renderTurnState = (st: TurnState, ageMs: number): string => …  // "working 12m" / "blocked(审批) 3m" / "timeout"
```

- 不设 `queued`: `when:"idle"` 期间 `tellPeer` 是阻塞的, 还没登记 slot, 发起者在自己的工具调用里看得到。
- `parked` = `!idleVerdict && openToolUses.length > 0`, 由 mirror-bridge 新增一个 `parkedNow(target)` 暴露 (复用 `idleVerdict` 里那段判断)。
- `claimed` = 被 wait_peer 取走; 对工单计数等同于 done。
- 不设 `rejected`: wizard 拒绝一件活就是 `RESULT: 不做, 因为…`, 不值得为它单开一个状态。

### 2.2 Slot 增量 (`daemon/receipts.ts`)

```ts
export interface Slot extends Tell {
  …现有字段…
  turn: string;          // "t" + 6 hex; 同一个 turn 的续问 (re) 沿用
  legs: number;          // 这个 turn 来回了几次 (1 = 首次派); NEED 往返的刹车
  deadlineAt: number;    // 绝对时刻; 缺省 at + 3600s, 上限 at + 12h (< KEEP_MS)
  status?: Terminal;     // 终态, 写一次不再改
  need?: boolean;        // 上一次收口是 NEED: (非终态)
}
```

`awaitReply` 的返回值从 `string` 改成 `Outcome`:

```ts
type Outcome =
  | { status: "done"; body: string }
  | { status: "need"; body: string }
  | { status: "timeout" | "silent" | "dead"; body: string };  // body = 合成的一句 + 对方最后一句的摘要
```

改法 (都是在现有循环里改):
1. `waitForIdle(s.to, deps.isBusy, …)` 换成 `deps.untilIdle(s.to, …)` (**修 P1**)。`aborted` 回调 (`claimed || stale`) 要搬过去: `untilIdle` 现在不接 abort, 需要加一个可选参数, 或者在外面用 `Promise.race` 套一层每秒检查一次的轮询。
2. 每一圈先查 `paneLive(s.to)`, 死了就返回 `dead`, 不再落进 `fruitless`。
3. 跳出循环时: `Date.now() >= deadlineAt` → `timeout`; `fruitless >= MAX_FRUITLESS` → `silent`。
4. 拿到正文后用 `parseClosing(body)` 分出 `done` 和 `need` (§2.4)。

`watch`:

| outcome | slot 写什么 | 投不投 | 工单计数 |
|---|---|---|---|
| done | `status=done` | 投原文 | +1 |
| need | `need=true`, **不写 status**, `resolved=false` | 投原文, 信封 `status=need` | 不变 |
| timeout / silent / dead | `status=…` | 投合成正文 | +1 (计为定论) |
| 被 wait_peer 取走 | `status=claimed` | 不投 | +1 |
| 被新的一句顶掉 (stale) | 不写 (key 已归新 slot) | 不投 | 由新 slot 接手 |

发话方那一侧 (**修 P3 的 ④**): `SENDER_WAIT_SEC` 不再是「放弃」的时限, 改成「发话方的 pane 还活着就一直等, 直到 `s.at + KEEP_MS`」。回执在 `serial` 里排队, 不会叠进同一个输入框。

### 2.3 turn id 与 `re` (`daemon/index.ts` `tellPeer` · `daemon/receipts.ts` `register`)

- `register(tell, watch, { re?, deadlineSec? })` 返回 `{ at, turn }`。
  - 没有 `re` → 新 turn, `legs=1`。
  - 有 `re` → 在 `slots` 里找 `turn === re` 并且 `from/to` 与这次相同的那份: 找到就**沿用** `turn`、`job`、`channel`, `legs+1`; 找不到 (方向反了 / 已超过 24h / 写错了) → 当作新 turn, 回包里写 `reUnknown: true`。
  - `legs > 3` → 仍然注入, 但信封正文多一句「这件活已经来回 3 次, 这一次请直接给 RESULT, 拿不准就写清假设」。不在 daemon 里拒绝: 拒绝之后模型会换个通路接着乒乓 (**修 L1**)。
- **turn 必须在注入之前生成**, 因为它要写进信封。`tellPeer` 已经是先取 `at` 再注入, 照这个顺序即可。clone/spawn 带 `task` 的路径 (`index.ts` 里 `taskAt` 那一段) 同样要在注入开场白之前生成, 并把它作为 `register` 的入参传进去, 不能让 `register` 自己现生一个。
- 回包加 `turn`, MCP 描述里说一句「要续问就 `tell_peer({re: turn})`」。
- `deadline` 入参单位是秒 (60–43200), 写进 `deadlineAt`。交接转移 (`transfer`) 时 `at` 被改锚到 `carryAt`, `deadlineAt` 也要顺延: `max(deadlineAt, carryAt + 600_000)`。否则对方一交接, 这份回执就提前超时。

### 2.4 收口三态 (`daemon/peers.ts`, 与 `extractResult` 放在一起)

```ts
export interface Closing { kind: "result" | "need" | "none"; text: string; artifacts: { path: string; note: string }[] }
export const parseClosing = (text: string): Closing
```

- 标记: `RESULT:` / `结论:` → result; `NEED:` / `需要:` → need。**取最后一个标记**, 规则与 `extractResult` 相同: 模型常先把格式复述一遍。
- `ARTIFACT: <path> — <note>` 可以出现多行, 位置不限 (结论前后都行)。路径以 `/`、`~` 或 `docs/` 这类相对路径开头; 不校验文件是否存在, 只做展示。
- `extractResult` 改成在 `parseClosing` 上包一层 (`kind==="result" ? text : ""`), 现有调用点不动。
- 没有任何标记 → `none`, 当作 done 处理 (退化成现行为)。

### 2.5 工单计数 (`daemon/jobs.ts` · `receipts.ts` meta)

- `ReceiptDeps` 加 `jobTotal?: (job: string) => number`, 由 `index.ts` 用 `jobs.get(id)?.members.length` 实现。
- `meta.total = max(jobTotal(job), ofJob(from, job).length, job.expect ?? 0)`; `done` 只数 `status` 已落定的 (needs-input 不算)。
- `open_job({ expect? })`: 「打算派几路」写进 JobRecord。不写就按成员数 —— 仍有第 1 份先回来的窗口, 所以描述里建议 fan-out 时写上 (**修 P2 的前半**)。
- `ofJob` 把 `x.job === job` 的 slot 都算进来; 跨工单被顶掉的那份 (P2 后半) 由 `jobTotal` 兜底计数, 它的结论丢了 —— 用 `status` 写进 `JobMember.outcome` 补救:
  ```ts
  export interface JobMember { …; outcome?: Terminal | "needs-input"; artifacts?: string[] }
  jobs.settle(id, target, outcome, artifacts)   // 新增, receipts 每落一份终态调一次
  ```
- `renderJobClose` 每个成员后面加上 `· timeout` 这类非 done 的状态, 产物另起一行 `  ↳ path — note`。

### 2.6 信封属性 (`shared/reminder.ts`)

| 信封 | 新增属性 | 值 |
|---|---|---|
| `kind=peer` (派活 / 续问) | `turn` | `t3fa9c1` |
| | `re` | 续问时 = 同一个 turn (有它就说明「这是对上一轮的追问 / 对你 NEED 的答复」) |
| | `deadline` | ISO 时刻, 只写不读 (给模型看的) |
| `kind=peer receipt=1` | `turn` | 对应的 turn |
| | `status` | `done` / `need` / `timeout` / `silent` / `dead` |
| | (已有) `job` `done` `total` `complete` | `complete` 只在 status 不为 need 时可能是 1 |

```ts
envelopeAttrs.peer(from, chat?, t?: { turn: string; re?: string; deadline?: number })
envelopeAttrs.receipt(from, chat?, job?, t?: { turn: string; status: ReceiptStatus })
interface Envelope { …; turn?: string; re?: string; status?: ReceiptStatus }
```

**兼容**:
- `attrsOf` 本来就收任意属性, 老读者 (rolepage / read_chat) 遇到新属性直接忽略, 不用改 LEGACY 表。
- 老信封没有 `turn`: `answerOf` 先按 `turn` 找 user 行, 找不到再退回现在的「`from` + 发话时刻」, 三态不变。
- 老 MCP 进程 (正在跑的 wizard) 不传 `re` / `deadline` / `expect` → daemon 取默认值, 行为与现在一致。
- 老 wizard 不知道 NEED → 它照旧写 RESULT, 走 done 分支。
- 正文 (prose): peer 私聊信封在 RESULT 那一句后面加一句「要对方补信息就收口成 `NEED: <问题>`; 交付了文件就加 `ARTIFACT: <路径> — 一句话` (可以多行)」。回执信封按 `status` 换第一句:
  - need: 「它在问你 —— 用 `tell_peer({name, re: "<turn>"})` 答; 这一份不计入工单」
  - timeout / silent / dead: 「它没答完 (原因 …) —— 自己判断: 换人、`re` 追问, 或者在汇总里如实写缺了这一份」
  - 现有的「不要为收到回执而回话」只留给 done。

### 2.7 取消 (`/wizard/stop`)

`receipts.cancel(target, by)`: 对方被 interrupt 或 end 时, 所有发往它、还没落定的 slot 写 `status=canceled`。发起 stop 的那一份不投 (它自己知道); 其他发话方的照常投一份 canceled 回执 —— 第三方需要知道它的活被别人掐了。注意 `end` 之后 pane 会死, 不处理的话 awaitReply 会把同一份再报成 `dead`, 所以 `cancel` 要先于 kill 执行。

## 3. 回环 / 双投清单

| 场景 | 现状 | B2 之后 | 防线 |
|---|---|---|---|
| 回执引出回执 | 不会: deliver 不登记 watcher | 同左 | **NEED 的答复只能走显式 `tell_peer`**, 永远不让「收到 NEED 那一轮」的回复自动回送 |
| NEED 乒乓 | — | 可能 | `legs > 3` 信封升级措辞 (只提示); 工单 `maxTurns` 做硬上限 |
| timeout 后迟到答案 | 丢 | 丢 (终态不可变) | 回执正文告诉发起者可以 `re` 追问 |
| wait_peer 与回执同时取 | `claimed` 占位 | 同左, `status=claimed` | 不变 |
| 同一对两句连发 | 旧的作废 | 同左; 有 `re` 时 turn 延续 | 不变 |
| 失败回执成批到达 (fan-out 同时超时) | — | N 份在 `serial` 里排队 | 不变 |
| reload 正好落在投递途中 | `resume` 重投 (`claimed` 重置) | 同左; `status` 只在投递成功之后写, 所以重投拿到的仍是同一个 outcome | 写 status 与 `settle` 放在同一次 save 里 |
| 交接中的答方 | `transfer` | 同左, 加 `deadlineAt` 顺延 | §2.3 |

## 4. 观察面 (roadmap B2 ⑤)

- `wizard_roster` 每个 wizard 加一行 `欠: .a(working 12m) .b(blocked 3m)` 和 `等: .c(needs-input)`。来源是 `receipts.states()`, 用 `turnState` 算。
- `peek_peer` 头部写出它身上所有在飞 turn 的状态。
- `list_jobs` 每个成员后面加 `· <state>`, 工单标题后面加 `3 done · 1 blocked · 1 needs-input`。
- 新增 `Receipts.states(filter?) → { from, to, turn, job, state, ageMs }[]`, 只读, 不落盘。

## 5. 提交顺序 (每步都能独立 reload 验证)

1. **P1 修复**: awaitReply 改走 `untilIdle`, 加 `dead` 判定, 加 `status` 字段, 投失败回执。验证: 派一个分身去跑一条需要审批的命令, 晾 2 分钟不点 → 回执不应丢; 点掉之后正常回来。
2. **发话方不放弃** (P3 ④) + `jobTotal` / `expect` (P2)。验证: open_job(expect:3), 先 clone 一路, 等它回来 → 应显示 1/3。
3. **turn / re / deadline** + 信封属性 + `answerOf` 按 turn 定位。验证: `tell_peer({deadline:90})` 给一个慢活 → 收到 timeout 回执; 再 `re` 追问 → 拿到答案。
4. **parseClosing**: NEED / ARTIFACT, `legs` 提示, 回执与收工气泡的渲染。验证: 让分身故意 NEED 一次 → 工单计数不前进; 答复之后正常收口。
5. **observe**: turn-state 进 roster / peek / list_jobs, 以及 cancel。

涉及的文件: `daemon/receipts.ts` `daemon/jobs.ts` `daemon/peers.ts` `shared/reminder.ts` `shared/turn-state.ts`(新) `daemon/index.ts` (tellPeer / clone 路径 / stop / deliver / open_job) `daemon/mirror-bridge.ts` (`parkedNow`, `untilIdle` 的 abort) `mcp/server.ts` (tell_peer `re` `deadline`; open_job `expect`)。注意: `index.ts` 和 `mcp/server.ts` 也在 B1 的范围里, 两批并行时要先排好谁先合。
