# wezard 演进总纲

> 牵头 `.evolve` · 2026-10-02 · 依据 `research/` 下 6 份调研 (每份的出处与证据都在原文里, 这里只留结论与取舍)
> 路线图与批次进度见 [roadmap.md](roadmap.md)

| 调研 | 作者 | 一句话 |
|---|---|---|
| [primitives-lisp.md](research/primitives-lisp.md) | `.ev-lisp` | 8 个原语 + 两个求值器; 回执是只有成功分支的 continuation |
| [inventory.md](research/inventory.md) | `.ev-tools` | 35 个工具, 4 个动词撑起 80% 调用, 13 个零调用; 模型可免审改审批配置 |
| [a2a-frameworks.md](research/a2a-frameworks.md) | `.ev-proto` | 缺的是「一次委托」这个名词 (turn id + 状态), 不缺通路 |
| [openclaw-dsh.md](research/openclaw-dsh.md) | `.ev-claw` | 压缩前刷记忆、静默哨兵、自描述分层、transcript 投影 |
| [memory.md](research/memory.md) | `.ev-mem` | 问题不是太多, 是注入时机僵、无检索、几套记忆各说各话 |
| [ui.md](research/ui.md) | `.ev-ui` | 页面单位是消息, 人想的是「一件事」和「谁卡住了」 |

## 1. 核心判断

1. **wezard 已经有两个求值器, 分工要画死。** LLM 是最好的 `if` / 拆分 / 汇总; 守护进程擅长 LLM 做不了的: **跨时间等、数数、计时、熬过 reload**。任何新机制先问「它属于哪一边」—— 控制流不进 daemon (`jobs.ts` 头注释的取舍继续成立), daemon 不替模型判断。
2. **原语核心已经事实存在**: 说 (`tell_peer`) / 看 (`peek_peer` `read_chat`) / 生 (`spawn` `clone`) / 等 (回执) 占 30 天 1133 次调用的 ~80%。演进不是造新语言, 而是**补齐这几个原语的语义缺口, 并把其余工具降为别名、镜头或人侧操作**。
3. **最实在的语义洞在 continuation 上**: 回执只在对方答了时才投递; 超时 / 不答 / 死掉 → 静默丢弃 (`receipts.ts:177` 不答/超时, `:207` 发话方一直忙), 工单最后一份若是这种, 发起者永远等不到「全部到齐」。补上失败分支, 超时 / 重试两格打开 (竞速另需收掉输家: `cancelRest` 或按 turn 的 cancel), charter 里「迟迟不来就 peek」的补丁可以删。
4. **一次委托要有名字。** A2A 的 Task、MCP tasks、LangGraph interrupt 都把「派出去的一件活」做成有 id、有状态的东西。wezard 的同类信息散在 receipts Slot / JobMember / paneIsBusy / openToolUses / wait_peer 的 stale 五处。**派生** (不新增存储) 一个 `TurnState` + 信封里的 turn id, 模型、回执、rolepage 三处共用。
5. **上下文是预算, 不是仓库。** charter ~4.4k tok 里 1/3 是只会过期的出生名册, 另有 ~2.5k 与工具描述复述; 在 Claude Code 上工具描述是 deferred 的 (只有名字常驻), 所以**charter 是唯一保证在场的那份**。自描述分三层: L0 charter 一行「何时用」→ L1 工具描述讲参数与边界 → L2 文档按需读。
6. **记忆的病在时机与检索, 不在体积。** 所有记忆只在出生时进 system prompt: 在跑的 wizard 看不到新规矩, `/clear` 后自己的 self 记忆也没了; 交接简报这类最好的情景摘要用完即删。先修通路 (notices 推送、跨 /clear、episode 归档), 再谈检索。
7. **UI 的单位要从「消息」升到「一件事」。** 工单成为一等会话, 忙闲补上「卡在审批」, 一个「要我处理」的托盘 —— 人管一群 wizard 时只关心这两件事: 这件事到哪了、谁在等我。
8. **安全先于一切**: hook 对 `mcp__*wezard__*` 一律放行, 而 `config_set` 能写 `danger_skip_all` / `allow_from` —— 模型可以不经人点卡就关掉审批。这是第一批第一件。

## 2. 原语代数

完整推导见 [primitives-lisp.md](research/primitives-lisp.md)。采纳 8 个原语, 并按「两个求值器」分层:

```
(make  :ctx blank|fork :from w :owner self|nil :cwd :model :job)  → w      ; spawn / clone
(send  w text :k self|nil|job :kind task|ask|fyi :deadline :public) → ()   ; 回执 = (k status answer)
(observe lens :narrow …)                                           → text  ; roster/peek/read_chat/whoami…
(define scope fact)                                                         ; remember (self|chat|workspace)
(set!  w attr value)                                                        ; identity / model / workspace / chat name
(stop  w :mode interrupt|end|forget)
(delay trigger :gate g thunk)                                      → task  ; schedule
(ask   human question :choices …)                                          ; 把控制交给人
```

| 原语 | 现有入口 | 要补的语义 |
|---|---|---|
| `make` | `spawn_wizard` `clone_wizard` (`new_claude_session` = `:owner nil`) | spawn 加 `detached` 吸收 new_claude_session; 失败不留僵尸身份 |
| `send/k` | `tell_peer` (`send_peer` 别名) | **失败 k** (timeout/silent/dead) · `deadline` · turn id + `re` · 收口三态 `RESULT:` / `NEED:` / `ARTIFACT:` · `kind` |
| `observe` | 9 个镜头 | 统一输出 `TurnState`; 镜头保持分开 (工具名就是发现机制) |
| `define` | `wizard_remember` | 写完对在跑的 wizard 可见; self 可 replace; episode 归档 |
| `set!` | `wizard_identity` `set_model` `set_workspace` `name_chat` | 不合并 |
| `stop` | `stop_wizard` | — |
| `delay` | `schedule_task` | `QUIET` 哨兵 (有事才说); 点名目标忙则顺延 |
| `ask` | CLI AskUserQuestion / 审批卡 | wizard↔wizard 的 `NEED:` 是它的同构 |

**组合子** (由 daemon 实现, 因为它们要等 / 数 / 计时): `job` = 作用域 + `join-k` (计数) + 收工回收; `handoff` = 写简报 → 重开 → 贴回; `wait_peer` = 同步 join (保留为同轮硬依赖的逃生口)。

**不做的**: 让 LLM 写 s-expression; 把 observe 镜头合成一个工具; 宏 / 自定义特殊形式; 确定性重放; daemon 里跑模型生成的编排脚本; 自动认领任务的调度器; 向量记忆; 默认心跳。理由见各调研的「不该学」一节。

**Flow AST (`run_flow`) 的位置**: 只覆盖「静态形状 + 要熬时间」的编排 (fix⇄review 跑过夜), 可续跑 (CEK 落盘)。**等真实需求出现再做**; 在那之前 `run_agent_graph` 三件套 (30 天零调用) 降出 charter 与默认面。

## 3. 工具面处置

依据 [inventory.md](research/inventory.md) §4, 注意「工具名是地址」—— 不删旧名, 只降级为别名。

| 处置 | 工具 |
|---|---|
| 原语入口, 保留 | tell_peer · spawn_wizard · clone_wizard · stop_wizard · wizard_remember · schedule_task · open_job/close_job · notify |
| 观察镜头, 保留 | wizard_roster · peek_peer · read_chat · wizard_whoami · route_candidates · list_tasks · list_jobs |
| 别名, 描述压到一行 | send_peer (→tell_peer) · new_claude_session (→spawn `detached`) · handoff + wizard_handoff_self (→合并为 `handoff({name?})`) |
| 降出 charter / 默认面 | run_agent_graph · graph_status · stop_graph · list_claude_sessions · switch_claude_session · list_chats |
| 写路径交给人 (hook 不再免审) | config_set (写) · set_model `scope:"default"` |
| 领域插件, 不在代数内 | wecom_doc_* |

## 4. 四个维度的改进 (摘要)

| 维度 | 头三件 (按收益/成本) |
|---|---|
| **架构 / 协议** | 失败 continuation + deadline · turn id / `NEED:` / `ARTIFACT:` 收口 · 派生 `TurnState` |
| **用法** (charter / 描述 / 编排) | 审批免审漏洞 · 描述里 send_peer/wait_peer 的过期引导清零 · charter 瘦身 (名册只列有职责的, 三层自描述去重) |
| **记忆** | 合并后经 notices 推给在跑的 wizard · self 记忆跨 /clear + clone 继承 · 交接简报 / 收工结论归档为 episode (+ 压缩前刷记忆提醒) |
| **UI** | 「卡在审批」第四态 · 回执 chip + 序号 · 工单一等会话 `j:<id>` (+ 只读待办托盘) |

批次划分、负责人、验收标准见 [roadmap.md](roadmap.md)。

## 5. 协作纪律

- 每批: 实现者 ≥2 人互相 review → `npm run build && ./cli/wezard.sh reload` 验证 → 逐单元 commit (只 stage 自己的文件) → CHANGELOG `[Unreleased]` 记账 → 群里一句进展。
- 记忆整理链路 (`daemon/memory-steward.ts`) 归 `.memsteward`; 记忆批次只在接口处 (`onMerged` / `refsOf`) 与它对齐, 不改它的文件。
- rolepage 局部已有认领者 (`.busytag` `.graph` `.unread` `.loadmore` `.receiptmiss`…), UI 批次派活前先查 roster, 能认领的交给它们。
- 只有破坏性 / 方向性分歧才停下来问人。
