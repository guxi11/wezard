# wezard 的原语代数 —— 以 Lisp / SICP 为镜

> 起草: `.ev-lisp` · 2026-10-02 · 读过: CLAUDE.md、`mcp/server.ts` 全部工具描述、`daemon/{jobs,receipts,graph,wizard}.ts`、`shared/trigger.ts`、`~/.wezard/tasks/trace-loop.task.mjs`
> 状态: 草案, 供 `.evolve` 汇总。不涉及代码改动。

## 0. 结论先行

1. wezard 已经有**两个求值器**, 只是没被这样叫过:
   - **LLM 自己**: 读 charter (求值规则) + 消息 (表达式), 每一轮 = 一次 `apply`。`if` / 循环 / 拆分这些控制流它做得比任何 DSL 都好。
   - **守护进程**: `graph.ts` (seq + loop)、`trigger.ts` (时钟 ∧ 筛子)、`receipts.ts` (continuation 投递)、`jobs.ts` (计数 join)。它擅长 LLM 不擅长的: **跨时间等、数数、熬过 reload、计时**。
2. 能归约成 **8 个原语**: `make` · `send/k` · `observe` · `define` (remember) · `set!` · `stop` · `delay` (schedule) · `ask` (人)。现有 35 个工具里大约一半是这 8 个的派生或观察镜头。
3. 回执就是 continuation, 而且已经是 CPS 的了 —— 但**只有成功的 k, 没有失败的 k**: 对方超时 / 不答 / 发话方一直忙, 回执静默丢弃 (`receipts.ts` 的「不回注」分支)。这是当前代数里最实在的洞, 比任何新语法都值。
4. 编排**可以**是数据 (一棵 `Flow` AST, 与 `Trigger` 同构: 构造器 = 字面量工厂, 可存、可渲染、可续跑), 但它只该覆盖「LLM 不擅长的那一层」—— 等待、计时、竞速、跨 reload。别让 LLM 写 s-expression。
5. clone 是**多次可重入的 continuation** (`--fork-session` = 把「读到此刻的我」当 k, 用不同参数各调一次)。这是 wezard 最独特、最该被强调的原语。但只可重入到第一次重开为止: clone 的 `WizardRecord.memory` 是空的, `/clear` 或交接后父的 self 记忆就丢了 (memory.md §4.6)。

---

## 1. 镜子: SICP 三要素 ↔ wezard

| SICP 1.1 | Lisp | wezard 现状 |
|---|---|---|
| 原始表达式 | 数、符号、原语过程 | 一段文本 (prompt)、一个 wizard (`.name`) |
| 组合手段 | `(f a b)`、`cond`、`begin` | LLM 在一轮里连发 tool call; `graph` 的 steps; `and(clock, …guards)` |
| 抽象手段 | `define`、`lambda` | 名字 (全局唯一)、工单 (作用域)、task 文件 (存盘的 lambda)、charter (过程体) |

更细的对应:

| Lisp 概念 | wezard 对应 | 备注 |
|---|---|---|
| 符号 / 绑定 | `.name` → target key → pane | 名字是地址, rename 不 rekey —— 正是「符号 ≠ 存储位置」 |
| 闭包 = 代码 + 环境 | wizard = charter + transcript (代码) × cwd / home / memory (环境) | 一个 wizard 就是一个**有状态的闭包** (actor 更准) |
| 环境模型 (帧链) | memory 作用域 `self → chat → workspace → CLAUDE.md` | `renderCharter` 就是在 spawn 时把帧链**展开成快照** —— 静态作用域, 改了要等下次 spawn 才可见 |
| `apply` | 一轮 (turn) | 输入 = 粘进输入框的文本 + 信封; 输出 = 最后一条 assistant 消息 |
| continuation | 回执 (`receipts.ts`) | tell 时登记 k, 对方 idle 后把它的答案 `paste` 进发话方 = `(k answer)` |
| 多次 continuation (`call/cc` 重入) | `clone_wizard` | fork 出的每个分身都是「从这一刻继续」, 只是喂进不同的 task |
| `delay` / thunk | `schedule_task` | 存盘的 thunk + 时钟; `gate` 是 force 前的守卫 |
| `dynamic-wind` / 作用域资源 | `open_job` … `close_job` | 退出作用域时回收「为它生出来的」分身 |
| 代数效应 / 条件系统 | PreToolUse 审批 | **环境性**的 handler, 包住每一次工具调用, LLM 看不见也不该调用 |
| 元循环求值器 | charter 是 `eval` 的规则书, LLM 是解释器 | 改 charter / 工具描述 = 改语言语义 (CLAUDE.md 也说了: 描述就是发现机制) |
| 流 (惰性序列) | transcript (jsonl 追加) | `read_chat` 的 `since/until/limit` 就是对流的 take/drop |

---

## 2. 原语

判据: **一个原语改变世界的一个维度, 且不能由其他原语组合出来**。维度是: 人口 (有哪些 wizard)、时间 (谁在跑一轮)、持久环境、活体属性、未来、人。

### 2.1 八个原语

```
(make  :ctx blank|fork  :from w?  :owner self|nil  :cwd :model :chat :job)  → w
(send  w text  :k self|nil|job  :when now|idle  :public bool)           → ()   ; 回执 = (k answer)
(observe lens  :narrow …)                                              → text ; 纯读
(define scope fact)          ; scope ∈ self | chat | workspace          → ()   ; 写环境帧
(set!  w attr value)         ; attr ∈ name | job | model | cwd | chatName
(stop  w  :mode interrupt|end|forget)
(delay trigger  :gate g  thunk)                                        → task ; 到点 force
(ask   human question  :choices …)                                     → answer (作为下一轮回来)
```

| 原语 | 维度 | 语义要点 | 为什么不能由别的组合 |
|---|---|---|---|
| `make` | 人口 + | 新 pane、新名字; `:ctx fork` = 带走此刻上下文 | 唯一能增加人口的 |
| `send/k` | 时间 (驱动一轮) | 文本落入对方输入框; k 决定答案回到谁 | 唯一能让别的 agent 执行的 |
| `observe` | 无 (纯) | 读 transcript / 名册 / 注册表, 不唤醒任何人 | 唯一无副作用的; 其他都写 |
| `define` | 持久环境 | 跨交接/重启, 下次 spawn 生效 (出生后写的 self 记忆**活不过 `/clear`**: 宪章不重渲染, 见 memory.md §4.1) | 活体属性 (`set!`) 随会话死; 它不 |
| `set!` | 活体属性 | 改名、职责、模型、工作区 | 不改人口、不驱动轮; 但 `cwd` 会触发重启, 见 §4 |
| `stop` | 人口 − / 打断 | `interrupt` 停一轮, `end` 收 pane, `forget` 抹身份 | 唯一能减少人口的 |
| `delay` | 未来 | 守护进程持有时钟; 到点 = 某人在那一刻 `send` | LLM 不能跨轮 sleep; 时间只能交给 daemon |
| `ask` | 人 | 结构化地问人, 答案作为新一轮回来 | 人不是 wizard: 没有 transcript 可读、没有 idle 可等 |

**`ask` 的诚实说明**: 它几乎是 `notify` + 「人在群里回话 = 新的一轮」的组合, 只多了按钮卡片这一层结构。算原语是因为它是**唯一把控制交给人**的出口 (和审批卡同一条通路), 将来做 Flow 时 `(ask …)` 必须是一个能挂起的节点。

### 2.2 不是原语的东西

- **`join`/`await` 不是 LLM 层原语**。有了 `send/k`, 等待就是「什么也不做, k 自己会来」。`jobs.ts` 的计数是 k 的**组合子** (`(join-k n)`: 把 n 个 k 合成一个, 第 n 次才说「齐了」)。只有在 Flow 数据层 (§3) 它才是节点。
- **审批不是 LLM 原语**, 是包住所有原语的 effect handler。LLM 能做的只有 `ask`。
- **`notify` 不是原语**: `(send chat text :k nil)` —— 地址是聊天而不是 wizard, 不要回执。保留它的理由是**可读性**, 不是正交性 (见 §5)。

### 2.3 现有工具 → 原语映射

| 工具 | 归约 | 处置 |
|---|---|---|
| `spawn_wizard` | `make :ctx blank :owner self` | **原语入口**, 保留 |
| `clone_wizard` | `make :ctx fork` (+ 可选 `send task`) | **原语入口**, 保留 |
| `new_claude_session` | `make :ctx blank :owner nil` | 并入 `spawn_wizard({detached:true})` (inventory R4), 降为别名 |
| `tell_peer` | `send/k` | **原语入口**, 保留 |
| `send_peer` | = `tell_peer` | 别名, 过渡期后删 |
| `wait_peer` | 同步 join over k | 保留为「同一轮硬依赖」的逃生口, 描述里已经是不推荐 |
| `notify` | `send chat :k nil` | sugar, 保留 (对 LLM 区分「驱动」与「告诉人」是真有用的) |
| `stop_wizard` | `stop` | 原语入口 |
| `wizard_remember` | `define` | 原语入口 |
| `wizard_identity` / `set_model` / `name_chat` | `set!` 的三个属性 | 保留分开 (见 §5: 合并不值) |
| `set_workspace` | `set! cwd` ≡ `stop end` + `make` 同名 | sugar, 保留 (时序要 daemon 做) |
| `wizard_handoff_self` / `handoff` | `send "压成简报" :k →` `stop end` → `make` 同名 → `send brief` | 派生, 但**必须**由 daemon 实现: 自己不能在自己那一轮里等自己 idle |
| `schedule_task` / `cancel_task` | `delay` / `stop` 一个 task | 原语入口 |
| `open_job` / `close_job` | 作用域 (`dynamic-wind`) + `join-k` + 收工时 `stop` 成员 | 组合子, 保留 |
| `run_agent_graph` / `graph_status` / `stop_graph` | 受限 Flow 解释器 (只有 seq + loop) | 用 §3 的 `run_flow` 泛化后取代 |
| `wizard_whoami` / `wizard_roster` / `peek_peer` / `read_chat` / `list_chats` / `list_jobs` / `list_tasks` / `list_claude_sessions` / `route_candidates` | `observe` 的 9 个镜头 | 保留分开 |
| `switch_claude_session` | `set!` 聊天→会话的绑定 | 人用, 不进 wizard 的编排词汇 |
| `config_set` | 全局 `set!` | 人用, 不进编排词汇 |
| `wecom_doc_*` | 外部世界的 FFI | 不在代数内 |

---

## 3. 组合手段

### 3.1 在 LLM 层: 控制流就是上下文

LLM 本身就是 `begin`/`if`/`cond`。在 wizard 的上下文里组合是这样的:

| 形式 | 写法 (LLM 视角) | 现状 |
|---|---|---|
| 串行 | `send a` → 等回执 → 据此 `send b` | ✅ CPS, 天然 |
| 并行 fan-out | 一轮里连发 n 个 `send … :job J` | ✅ |
| fan-in | 回执带「第 i 份 / 共 n 份 / 全部到齐」 | ✅ `join-k` 由 daemon 数 |
| 条件 | LLM 读回执自己判断 | ✅ 比任何谓词 DSL 都强 |
| 循环 | 回执来了再派一轮 | ✅ 但 reload 后靠 LLM 自己记得 |
| 超时 | — | ❌ k 永不被调用 = 静默 |
| 重试 | 依赖超时信号 | ❌ 同上 |
| 竞速 | `wait_peer need:1` | ⚠️ 只取首个, 不收掉输家 |

超时与重试**卡在同一处**: k 只有成功分支, 补一个失败 continuation 两格同时打开; 竞速另缺「收掉输家」(§4 #3), 与失败 k 无关:

```
(send w text :k self)        ; 现在: 只在 answer 非空时调 (k answer)
(send w text :k self :deadline 20m)
  ; 补上: 超时 / 不答 / 对方死掉 → 也调 k, 只是信封里 status=timeout|silent|dead
  ; 工单计数同样把它算作「有了定论」—— 最后一份即使是超时, 也要发「全部到齐」
```

**现在的具体后果**: `receipts.ts` 里 `body` 为空 → `"receipt: 没有答这一句, 不回注"`; 对方超过 `TARGET_WAIT_SEC=3600` → 同样静默。工单里若**最后**一份是这种, 发起者永远收不到「全部到齐」, 只能靠人提醒去 `peek_peer`。charter 里写的「中途有一份迟迟不来, peek 一眼」就是在给这个洞打补丁。

### 3.2 在数据层: `Flow` AST

`trigger.ts` 是先例: 封闭枚举换成小 AST, 构造器只是字面量工厂, 一棵树能存进 json、能回显成人话、能在详情页画出来。`graph.ts` 的 `steps × rounds × until` 就是这棵树的一个**特例** (seq 套 loop)。泛化:

```ts
type Flow =
  | { op: "send";    to: Ref; prompt: string; deadline?: Dur }          // 叶子: 一轮
  | { op: "seq";     body: Flow[] }
  | { op: "par";     body: Flow[]; need?: number; cancelRest?: boolean } // need<n 且 cancelRest = race
  | { op: "if";      test: Pred; then: Flow; else?: Flow }
  | { op: "loop";    body: Flow; until: Pred; max: number }
  | { op: "timeout"; after: Dur; body: Flow; else?: Flow }
  | { op: "retry";   times: number; body: Flow }                        // = loop until ok
  | { op: "let";     bind: Record<string, MakeSpec>; body: Flow }       // 作用域 wizard, 退出即 stop (= job)
  | { op: "ask";     question: string; choices?: string[] };            // 挂起等人

type Ref  = string;                                   // `.name` 或 let 绑定的名字
type Pred =
  | { contains: string; in?: Ref }                    // 现在的 `until`
  | { status: "ok" | "timeout" | "silent" | "dead" }  // 依赖 §3.1 的失败 k
  | { judge: Ref; question: string };                 // 让一个 wizard 答 yes/no —— LLM 当谓词
```

值在环境里流动, 沿用 graph 的模板: `{{last}}` / `{{<name>}}` / `{{round}}`。

**三条设计约束**, 每一条都来自现有代码的教训:

1. **解释器必须可续跑** (`graph.ts` 的 run 只活在内存, reload 即丢; `jobs.ts` 头注释正是因此把控制流留在 LLM 那边)。解法是 CEK 机: 落盘 `(Control = AST 里的路径, Env = 已得到的值, Kont = 帧栈)`。每个 `send` 叶子的答案**本来就在对方 transcript 里**, 按信封定位 (`replyToPeer`) 就能在重启后取回 —— `receipts.ts` 已经证明了这条路走得通。
2. **重放 = 重新渲染, 不是重新执行**。LLM 不确定, 确定性重放是假承诺。能给的是: 渲染整棵树 + 每个叶子的 (prompt, 答案) + 「从节点 X 起重跑」。
3. **构造器给 LLM, 不给 s-expression**。LLM 写 JSON tool args 比写括号可靠; s-expr 只用于文档与 rolepage 渲染 (和 `describeTrigger` 同一个位置)。

### 3.3 三个真实编排的表达式

**例 1 · `.evolve` 这次的调研扇出** (运行时才知道分几路 → 应该留在 LLM 层, 不写成 Flow)

```lisp
(let-job "evolve: 原语与经验调研"                      ; open_job … close_job
  ((claw (make :ctx blank :model opus :cwd "~/develop/Guxi11/weclaude"))
   (lisp (make :ctx blank :model opus :cwd "~/develop/Guxi11/weclaude")))
  (par (send claw "调研 openclaw 与 dsh → 可迁移经验, 写 docs/evolve/research/claw.md")
       (send lisp "以 SICP 起草原语代数, 写 docs/evolve/research/primitives-lisp.md"))
  ;; 两份回执到齐 → evolve 自己在上下文里汇总
  (close-job (summarize {{claw}} {{lisp}})))
```

要点: 这正是 `jobs.ts` 说的「分几路是想出来的」—— 留给 LLM; daemon 只记账 + 数数。

**例 2 · fix ⇄ review 直到 LGTM, 每轮限时, 卡住重试一次** (静态形状、要熬过 reload → 适合 Flow)

```lisp
(let ((fix    (make :ctx fork  :from self))           ; 带着读过的模块
      (review (make :ctx blank :model opus)))
  (loop :max 5 :until (contains "LGTM" :in review)
    (seq (retry 1
           (timeout 20m (send fix "按评审意见改: {{review}}")
                    :else (send fix "/stop 后汇报卡在哪")))
         (send review "审这次改动, 通过就回 LGTM: {{fix}}"))))
```

JSON 形状 (LLM 实际写的):

```json
{ "op": "let", "bind": { "fix": { "ctx": "fork" }, "review": { "ctx": "blank", "model": "opus" } },
  "body": { "op": "loop", "max": 5, "until": { "contains": "LGTM", "in": "review" },
    "body": { "op": "seq", "body": [
      { "op": "retry", "times": 1, "body": { "op": "send", "to": "fix", "prompt": "按评审意见改: {{review}}", "deadline": "20m" } },
      { "op": "send", "to": "review", "prompt": "审这次改动, 通过就回 LGTM: {{fix}}" } ] } } }
```

今天的 `run_agent_graph` 能写出其中的 seq + loop + until, 写不出 timeout / retry / let 回收, 且 reload 即丢。

**与「控制流不进 daemon」的张力**: `run_flow` 就是把控制流搬进 daemon —— `jobs.ts` 头注释、a2a-frameworks L1 (graph 降为 job + 预算)、openclaw-dsh §3.2B 都反对这一步。它只在「无人在场也要跑完的静态形状」上站得住; 没有这种真实需求之前, a2a 的 L1 (rounds/until 变成 job 的预算字段, 控制流留在发起 wizard) 更便宜。

**例 3 · trace-loop 定时任务** (已经存在, 改写成代数看它的形状)

```lisp
(delay (and (every 1h) (between "09:00" "21:00"))          ; Trigger AST, 已有
  :gate (lambda (ctx) (> (sh-count "logs/traces/inbox") 0)) ; 已有, 子进程 + 超时
  (let ((w (make :ctx blank :owner task)))                  ; fresh: true
    (send w "处理 {{pending}} 条 trace, 修完 push main")))   ; 干完自动 stop
```

观察: task 的 body 现在是「一段 prompt 给一个白板 wizard」—— 即固定为 `(let ((w (make))) (send w prompt))`。若 task 的 body 可以是任意 Flow, **定时与流水线就统一了**: `delay` 只负责「何时 force」, 「force 什么」交给 Flow 解释器。

竞速顺带一提 (不单列例子): `(par :need 1 :cancelRest true (send (make :ctx fork :model haiku) q) (send (make :ctx fork :model opus) q))` —— 两个分身从同一上下文起跑, 先答的赢, 输家 `stop`。需要 §4 的 race-cancel。

---

## 4. 缺失的, 按值排序

| # | 缺什么 | 代数里的位置 | 值不值 | 代价 |
|---|---|---|---|---|
| 1 | **失败 continuation**: 超时 / 不答 / 对方死 → 仍然回执, `status` 写进信封; 工单把它算定论 | `send/k` 的 k-err | **最高**。超时、重试、「全部到齐」的可靠性都卡在这 | 小: `receipts.ts` 的三个 `settle` 分支改为投一份 status 回执 |
| 2 | **`send` 的 `deadline`** | 同上 | 高 | 小: `TARGET_WAIT_SEC` 改为每次发话可传 |
| 3 | **race 收尾**: `need:1` 后自动 `stop` 输家 | `par :cancelRest` | 中 (多模型对比、多路探路时有用) | 小 |
| 4 | **结构化返回值**: 回执里 `RESULT:` 之后可选带 json, 信封解析成值 | 让 `Pred` 能 branch on 值, 而非子串 | 中。只有 Flow 层需要; LLM 层自己读得懂文本 | 中 |
| 5 | **可续跑的 Flow 解释器** (`run_flow`), 取代 `run_agent_graph` | §3.2 | 中。真实需求是「循环跑过夜还要活过 reload」; 只有 fix⇄review 这类静态形状用得上 | 大 |
| 6 | **task body = Flow** | `delay` × Flow | 中低。等 5 落地后顺手 | 小 (在 5 之上) |
| 7 | **作用域记忆的动态可见性** (`define chat` 后同群活着的 wizard 立刻知道) | 环境模型: 现在是 spawn 时快照 = 静态作用域 | 高。`notices.ts` 通路现成但**没接上记忆** (memory.md §4.1), 长寿 wizard 永远看不到新规矩 | 低: steward `onMerged` → notices |

---

## 5. 好看但不值的

| 诱惑 | 为什么不做 |
|---|---|
| 让 LLM 写 s-expression / 自造 Lisp 方言 | LLM 写 JSON tool args 稳定得多; 括号只用于渲染与文档 |
| 把 9 个 `observe` 镜头合成一个 `observe(lens)` | 工具名就是发现机制 (CLAUDE.md 明说); 合并后 LLM 不再「想到」去 peek。正交性在**实现层** (都读 transcript) 已经有了, 不必暴露到接口 |
| 把 `set!` 三个属性 (身份 / 模型 / 聊天名) 合一 | 同上, 且 `set_model` 有它自己的 catalog 协商 |
| 把 `notify` 并进 `send` | 「驱动 agent」与「告诉人」在 LLM 眼里是两件事; 合并会诱发对人说话时误触发一轮 |
| 暴露 `call/cc` / 显式 continuation 对象给 LLM | 回执已经是隐式 CPS; 让 LLM 自己管 k 只会出错 |
| 宏系统 / 用户自定义特殊形式 | task 文件 (`.task.mjs`) 已是「存盘的代码」, 够了; 第二套元编程没人维护 |
| 惰性流抽象 (turn stream 组合子) | transcript 本身就是流, `read_chat since/until/limit` 已是 take/drop |
| 确定性重放 | LLM 非确定, 承诺不了; 只做渲染 + 从某节点重跑 |
| 把**所有**编排都写成 Flow | 「分几路是想出来的」那类活 (例 1) 写成数据反而更差; Flow 只覆盖静态形状 + 需要熬时间的 |

**分层原则**: LLM 是最好的 `if`; 数据层解释器只接 LLM 做不了或做不稳的 —— **等待、计时、计数、竞速收尾、熬过 reload**。界线画在这里, 两个求值器就不会互相抢活。

---

## 6. 建议的推进顺序

1. 失败 continuation + `deadline` (§4 #1 #2) —— 改 `receipts.ts` 与信封 `kind`, 不加新工具。立刻让 charter 里「迟迟不来就 peek」那段可以删掉。
2. race 收尾 (`wait_peer need:1` 的 `cancelRest`, 或 job 级 `race:true`)。
3. `new_claude_session` → `spawn_wizard({detached:true})` 别名化; `send_peer` 过渡期结束后删除。
4. 有真实的过夜循环需求再做 `run_flow` (CEK 落盘, 构造器 + `describeFlow`, rolepage 渲染); 做完后 `run_agent_graph` 降为它的 `seq+loop` 别名, task body 接 Flow。
