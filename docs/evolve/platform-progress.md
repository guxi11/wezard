# 平台推进 · 进展文档

> 负责人 `OliveOwen` (平台常驻 lead, parent `wezard-1`) · 建于 2026-11-22 · 分支 `v3`
> 每轮「平台推进」先读这份, 收尾时更新它。admin 随时可读。
> 2026-11-22 admin 授权 (d6977146.12): **可以直接发言** —— 有里程碑 / 成果 / 要讨论的问题就在 wezard dev 群 `chat_say` 一句 (短、讲结论), 需要别人做的直接 `chat_ask` / `delegate`, 不必绕经 `wezard-1`。

## 使命

把 wezard 做成成熟、强大的 agent 编排协作平台。每一轮自问「现在最值得改进的一件事是什么」, 在四条线上持续推进:
① UI/UX (rolepage、卡片、IM 侧交互) · ② 代码 (死代码、重复、测试、可靠性、可观测) · ③ 模型 (room / duty / route / plan / 身份与记忆的概念一致) · ④ 文档 (CLAUDE.md / README / 技术说明与代码一致, 开发者指南)。

## 每轮规矩

1. 读本文 → `wizard_roster` / `pending_items` / `plan_list` (别重复派、别撞文件) → `free -m`。
2. 可用 < 700MB, 或活着的 wizard (含我) 已 ≥ 4: 只做轻量工作 (读码 / 设计 / 文档 / 小改动自己做), 不起新 wizard。否则可起执行者, 活着的总数 (含我) 不超过 4, 交差即收。
3. 选 1 件做完: typecheck、相关 tests 通过数不减少、前端改动截图 (`node scripts/shot.mjs`, 串行)。
4. 小步 commit, `git diff --cached` 只含自己的 hunk; 不 stash / reset / checkout 别人的改动。
5. 更新本文并提交; 交差的分身 `stop_wizard`; 做成了就在群里报一句 (commit + 测试 + 遗留)。没值得做的事就回 QUIET。
6. 仍须先问 admin 的只有: push / 发布、改 `~/.wezard/config.jsonc` / 权限 / secrets、删状态、改服务定义、群发 —— 直接在群里问。改语义的大改 (数据模型、落盘格式、删 MCP 工具、改 charter 文案) 先在 `docs/evolve/` 写方案, 再在群里讨论。charter 改动攒成一次发出 (每次都会让在跑的 wizard 用旧 charter)。

## 测试基线 (2026-11-22, 逐个 `npx tsx tests/<f>`, 120s 超时)

**111 / 113 通过** (2026-11-22)。只剩 `codex-hooks` / `codex-session` 失败: 本机没装 `codex`, spawn ENOENT, 属环境问题。`codex-backend` 与 `wizard-stream` 已修: 两处都是断言跟不上有意的退役 (`043219c` 删 bin / claudeBin 覆盖; `762482b` 删「全部消息」all=1), 不是回归。每次改动后对照, 通过数不能减少。

## 优先级清单

### P0 — 正确性 / 直接误导模型
- [x] **提醒文案指向已退役的 `wait_peer`** —— 人话里点名 wizard 时注入的 mention 提醒 (`daemon/peers.ts` `peerMentionPart`) 让模型调用一个已不存在的工具。改成 `chat_ask · peek_peer`。(本轮)
- [x] **charter 仍列 `wait_peer`**: 「我能做什么」只留 `stop_wizard` 那半句, 「派完就放手」改「不守着」; `tests/charter.test.ts` 加「charter 不含 wait_peer」断言。admin 批 (d6977146.12)。
- [x] 测试基线里的失败: `codex-backend` / `wizard-stream` 都是过时断言 (对应功能有意退役), 已改为断言现行行为。(本轮)

### P1 — 死代码 / 包体 / 可靠性
- [x] **chat_ask 给已结束 (stop_wizard end) 的 wizard 静默丢失**: hub 认 `gone` → 给提问者写 `undelivered` 系统行; 其他失败打 warn。(本轮)
- [x] **决定: 不自动重生** (admin「按推荐处理」, 推荐即不自动)。理由: 被 `stop_wizard end` / `/kill` 结束是有意的; 绑定随之删掉, 模型 / 档位 / cwd 都没了, 重生只能猜; 本机内存紧, 一条迟到的 chat_ask 不该偷偷起一个 pane。现行 `undelivered` 系统行让提问者知道没投到, 由它改派 (`delegate` 会按档白板 spawn)。如果以后要自动, 最小做法是 hub 见 gone 时按 parent 的 cwd + `tierFor` spawn 一个同名白板, 先过 `memoryGuard`。原记录: **跟进: 被结束的 wizard 被唤醒时要不要自动白板重生** —— `stop_wizard` 描述写的是「之后再找它是一个空白会话」, 人那边 `/kill` 后下条消息也会自动重开, 但 room 唤醒没有这条路 (`injectText` 对无绑定目标直接 gone)。自动重生要定: 模型/档位与 cwd 从哪来 (绑定随 /kill 一起删了)、内存闸、要不要先问 parent。改的是语义 → 先写方案报 admin。
- [x] **vendor.js 去掉无人使用的 d3** (~280KB 未压缩, 每次冷加载 rolepage 都要下): `shared/chat-render.ts` 不再拼 `d3.min.js`, 删 `web/d3.min.js`。关系图早已换成自写的 stress majorization。(本轮)
- [x] **`daemon/peers.ts` 回执时代遗留删净** (~260 行): `parseClosing` 一族、`addressedResults`、`replyClosedBefore` / `openingTurn`、`renderTask/Peer/ReceiptEnvelope`、`tailTurns`; `tsc --noUnusedLocals` 逐轮确认, 测试里只测回执措辞的一条断言同删。(本轮)
- [x] `shared/turn-state.ts` 整个删; `WorldFacts.inflight` / `WorldFactInFlight`、`route.ts` `routeReceiptDutiesOf`、`WizardBrief.turns`、peek 里恒空的 inflight 行一并删。(本轮)
- [x] (admin 批, 已做) 接上了: `route.ts` `occupies` 只认别的 wizard 用 chat_ask / delegate 开的 (kind ask/task, asker 是另一个 wizard) 未关 duty; 人话 / join-req / 自己开给自己的不算。常驻 duty 没有专门的标记, 照算 —— 它的持有者是 lead, 本来就被 lead veto 挡着, 不多挡一次。原记录: **delegate 的「任务占用」veto 在生产里从不触发**: `routeRowsOf` (`daemon/index.ts`) 给每行写死 `duties: []`, 而 `route.ts` 的 veto / 渲染都读它。名册那边已有 `dutiesOf` (跨 room 现算 open duty), 喂进来就能恢复。要定: 什么样的 duty 算占用 (常驻 duty 如 d6977146.1 会让 lead 永远被挡 —— lead 本就另有 veto; 人话唤醒开的 duty 在它回复前也会挡) → 改的是派活语义, 先报。
- [ ] `shared/reminder.ts` 已退役 attr; tests 里 `topOnly` / `speech` 死数据; 注释里残留 `tell_peer` / `router` / `read_chat`。
- [ ] svr 重启后名册缺席 30~70s: daemon 应在 svr 上线时立即补推 `WorldFacts`。
- [ ] **lead 标记 (`WizardRecord.lead`) 写入后从不清除** —— 方案见「待 admin 拍板」#3, 已在群里提。
- [x] `/help` 文案陈旧: 协作一节去掉回执 / 工单 / 循环流水线, 改成 room 口径; 改名权限 lead→parent (与 `wizard_identity` 描述一致)。(本轮)
- [ ] 源码注释里还有 ~40 处 `tell_peer` / `read_chat` / `send_peer` / `wait_peer` (daemon/index.ts、mirror-bridge.ts、peers.ts、shared/session-label.ts、tool-hints.ts 等), 只是注释, 不进模型; 碰到哪个文件顺手改。运行时文案里只剩 charter 两处 (待拍板 #1)。

### P2 — 模型 / 文档 / 体验
- [ ] `docs/evolve/README.md` 与 `roadmap.md` 大段描述已退役的 receipts / jobs / tell_peer, 与现行 room 模型冲突: 加醒目的「历史文档」头, 或重写成现行路线图。
- [ ] 开发者指南: 新加一个 MCP 工具 / 一个 room 行类型 / 一个 reminder kind 要动哪几处 (现在只能读 CLAUDE.md 长段落)。
- [ ] 上下文成本: charter 体积、handoff 可靠性 (daemon.log: `handoff: 放弃` 15 次 / `打断后仍未静下来` 21 次, 24h 内)。
- [ ] daemon 内存 / 并发治理 (本机 3.7GB)。

## 待 admin 拍板

1. ~~charter 删 `wait_peer` 两处~~ 已批已做 (2026-11-22)。原文: (已报, 未批) (`daemon/wizard.ts:1087` 工具行整行删, `:1120` 「不 `wait_peer` 守着」改「不守着」)。纯修正 (工具已不存在), 但会让所有 chartered wizard 收到 handoff 提醒。推荐: 批准, 与下一次必要的 charter 改动合并发出, 减少一次全体提醒。

2. ~~room vs dm A~G~~ admin 回复: A、C 不要; D 改为「dm 统一为 room 特殊形式 + history 参数」(已完成 d986e7a); B 未批; E/F/G 未表态。原文: (见 [research/room-vs-dm-collaboration.md](research/room-vs-dm-collaboration.md) §5)。推荐先批 A (lead 派活信封加一句「小队一个 room」, 零代码) 与 B (多个非成员 chat_ask 自动开 adhoc); G (charter 判据) 与 #1 合并发出。

3. **lead 标记什么时候摘** (2026-11-22 群里提)。现状: `delegate({lead:true})` / `spawn({lead:true})` 写 `lead: true` 后永不清除; 它驱动三件事 —— charter 多一节 lead 规矩、rolepage 👑、delegate「lead 身份, 独立任务不自动复用」veto。实测 `wizards.json` 5 个 lead (Grace / IrisIrwin / JackJones / LeoLane / OliveOwen), 前四个的 lead 活大多已交差, 却永远戴着 👑、永远不被自动派活。
   - **推荐 B (显式)**: lead 记的是「领了哪一件」—— `WizardRecord` 加可选 `leadOf: <派它那条 chat_ask 的 msg id>`; 那条 duty 被 done / passed / canceled 关掉时 room-hub 摘 lead (还有 active/paused plan 就等 plan 收尾再摘)。合项目口径: 完成只认账本上的显式字段, 不推断。老记录没有 `leadOf`: boot 时若它名下没有同伴开的未关 duty、也没有 active/paused plan, 就摘掉 (会改 `wizards.json` 里 4 条的 flag, 不删记录)。
   - 备选 A (推断): 不加字段, 每次它 chat_reply 关账后, 名下没有同伴开的未关 duty 且无 active plan 就摘。改动更小, 但同时领两件时会摘早。
   - 常驻 duty (OliveOwen 的 d6977146.1) 永不关, 两种方案下它都一直是 lead —— 符合事实。

## 进行中

(无)

## 已完成

| 日期 | 事 | commit |
|---|---|---|
| 2026-11-22 | 建本文; vendor.js 去 d3; mention 提醒去 `wait_peer` | `c182134` |
| 2026-11-22 | 研究: 什么时候拉 room / room 里怎么说话 (admin 之问), 账本实测 adhoc 0 / dm 43 / 64% dm 消息提到第三方 | 见 git log |
| 2026-11-22 | room_invite/room_approve `history` 参数 (none/N/from:id/all); dm 显示统一 (多人列全员); ensureDmRoom 补回 / 混入第三人改落 {A,B} adhoc。coder QuinnQuincy, 白板 reviewer RoseReed 通过。遗留: join-req 路径不校验 history; rejoin 不写 seen 未细查; 多个 {A,B} adhoc 取最近活动会合流 | `d986e7a` |
| 2026-11-22 | `daemon/peers.ts` 删回执时代死代码 ~260 行 (我自己做: 活着的 wizard 已 4 个, 不起新人) | 见 git log |
| 2026-11-22 | room hub: 投给已结束 wizard 的 duty 不再静默丢失 (`gone` → `undelivered` 系统行给提问者; 其他失败打 warn)。起因: IrisIrwin 被 /kill 后两次派活都没投进去 | 见 git log |
| 2026-11-22 | admin 批「按推荐处理」: charter 删 `wait_peer`; delegate 占用 veto 接上 (只认同伴 chat_ask/delegate 开的 duty); 被结束 wizard 不自动重生 (维持 undelivered 系统行); platform-push 提示词改成「有进展就在群里说」 | 见 git log |
| 2026-11-22 | `/help` 协作一节改成 room 口径; `wizard.ts` 身份注释去 `tell_peer` | 见 git log |
| 2026-11-22 | 删 `shared/turn-state.ts` 与恒空的 `WorldFacts.inflight` / `routeReceiptDutiesOf` / `WizardBrief.turns` (-64 行); 顺带发现 delegate 的占用 veto 恒空 (登记 P1) | 见 git log |
| 2026-11-22 | 测试基线 109→111 / 113: `codex-backend` (bin 覆盖已退役) 与 `wizard-stream` W-2 (all=1 已退役) 改断言现行行为 | 见 git log |

## 已知坑

- **测试基线失败**: 见上「测试基线」。`tests/charter.test.ts` 断言 charter 含「不 `wait_peer` 守着」—— 改 charter 时要一起改。
- daemon.log 里 `spawn-tmux: pane creation failed` (duplicate session) 与 `launch failure with --model` (No conversation found) 的成串 warn 都早于 2026-11-21 `spawn-tmux.ts` 的修复, 之后未再出现。
- `web/chat.js` 正由 `LeoLane` (关系图) / `IrisIrwin` (视角 / detail) 改, 别并行动它。
- 多 wizard 共用 git index: 提交前 `git diff --cached`, 必要时临时 index。
