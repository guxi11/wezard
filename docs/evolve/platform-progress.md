# 平台推进 · 进展文档

> 负责人 `OliveOwen` (平台常驻 lead, parent `wezard-1`) · 建于 2026-11-22 · 分支 `v3`
> 每轮「平台推进」先读这份, 收尾时更新它。admin 随时可读。
> 2026-11-22 admin 授权 (d6977146.12): **可以直接发言** —— 有里程碑 / 成果 / 要讨论的问题就在 wezard dev 群 `chat_say` 一句 (短、讲结论), 需要别人做的直接 `chat_ask` / `delegate`, 不必绕经 `wezard-1`。

## 使命

把 wezard 做成成熟、强大的 agent 编排协作平台。每一轮自问「现在最值得改进的一件事是什么」, 在四条线上持续推进:
① UI/UX (rolepage、卡片、IM 侧交互) · ② 代码 (死代码、重复、测试、可靠性、可观测) · ③ 模型 (room / duty / route / plan / 身份与记忆的概念一致) · ④ 文档 (CLAUDE.md / README / 技术说明与代码一致, 开发者指南)。

## 每轮规矩

1. 读本文 → `wizard_roster` / `pending_items` / `plan_list` (别重复派、别撞文件); `room_read` wezard dev 群看有没有 admin 的新话。
2. **内存不是不干活的理由** (admin 2026-11-22: 已配 swap + earlyoom)。照常推进, 需要就起执行者; 只是别半分钟内连生多个, 交差即收。
3. 选 1 件做完: typecheck、相关 tests 通过数不减少、前端改动截图 (`node scripts/shot.mjs`, 串行)。
4. 小步 commit, `git diff --cached` 只含自己的 hunk; 不 stash / reset / checkout 别人的改动。
5. 更新本文并提交; 交差的分身 `stop_wizard`; 做成了就在群里报一句 (commit + 测试 + 遗留)。没值得做的事就回 QUIET。
6. 仍须先问 admin 的只有: push / 发布、改 `~/.wezard/config.jsonc` / 权限 / secrets、删状态、改服务定义、群发 —— 直接在群里问。改语义的大改 (数据模型、落盘格式、删 MCP 工具、改 charter 文案) 先在 `docs/evolve/` 写方案, 再在群里讨论。charter 改动攒成一次发出 (每次都会让在跑的 wizard 用旧 charter)。

## 测试基线 (2026-11-22, 逐个 `npx tsx tests/<f>`, 120s 超时)

**117 / 119 通过** (2026-11-22 晚, PaulOwen 全量)。只剩 `codex-hooks` / `codex-session` 失败: 本机没装 `codex`, spawn ENOENT, 属环境问题。`codex-backend` 与 `wizard-stream` 已修: 两处都是断言跟不上有意的退役 (`043219c` 删 bin / claudeBin 覆盖; `762482b` 删「全部消息」all=1), 不是回归。每次改动后对照, 通过数不能减少。

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
- [x] `shared/reminder.ts` 无写入方的退役 attr / 类型删掉 (只读老转录要用的留下并注明); tests 里 `topOnly` / `speech` 夹具删掉; 注释里退役工具名改成现行说法 (`eff3069` `3e03081`, PaulOwen)。
- [x] **svr 重启后名册缺席** (`f0fc2f8`, IrisHill): `svr/facts-store.ts` 每次 POST /w 后原子落盘 `<stateDir>/facts.json`, 启动按 `FACTS_TTL_MS` 读回。实测重启后 3s: 名字 0→61, degraded true→false。
- [x] **lead 标记按件摘** (admin 选 B): `WizardRecord.leadOf` 记派它当 lead 的 task 行; 全关账且无未收尾 plan → 摘 (`leadSettled`; hub `onClosed` / plan 更新 / boot 各跑一遍)。老记录无 leadOf 只在 boot 按「名下没有同伴开的未关 duty」摘 —— 首次 boot 摘了 Grace / IrisIrwin / JackJones / LeoLane, OliveOwen 因常驻 duty 保留。(本轮)
- [x] `/help` 文案陈旧: 协作一节去掉回执 / 工单 / 循环流水线, 改成 room 口径; 改名权限 lead→parent (与 `wizard_identity` 描述一致)。(本轮)
- [x] 源码注释里的 `tell_peer` / `read_chat` / `send_peer` / `wait_peer` 已改 (`3e03081` 等); 运行时文案里已无退役工具名。`scripts/room-cutover/*.mjs` 是迁移映射数据, 保留。

### P2 — 模型 / 文档 / 体验
- [x] `docs/evolve/README.md` 与 `roadmap.md` 加醒目的「历史文档」头: 列出已退役的名词, 指向 `docs/room/contract.md` / `CLAUDE.md` / 本文。没有重写 —— 它们留作决策史。
- [x] 开发者指南 [`docs/dev-guide.md`](../dev-guide.md) (RoseQuincy `afb1743` `06bd575`): 加 MCP 工具 / room 行类型 / reminder kind 各动哪几处 + vm 沙箱截取锚点表。顺带对齐 CLAUDE.md (reminder kind 现状、room 唤醒不挂信封而是 `【label】(roomId)` 头、`daemonPost` 每个 POST 都带 selfRef)、contract.md §2/§6、过时注释。
- [x] `tests/charter.test.ts` 断言默认注册的 MCP 工具都在 charter 名册里 (`c226798`, WendyVance): 合写 `plan_create/get/list/update` 展开比对; 豁免表 `charterExempt` 名字失效也报错。
- [x] ~~下次 charter 攒批: `wecom_doc_*` 要不要进 charter~~ admin 定直接删 (企微文档走官方 skill, admin 另外跟进 skill 安装): `d6b831b` (YaraXu)。
- [ ] **反问后的原 duty 易被遗忘** (实例 7aeb85fc.376): wizard 对人话 `need` → 人另发一条新消息作答 (不引用) → 唤醒头的「你要交代」只列新那条, 原 duty 仍开在 wizard 名下, 60 分钟后被逾期提醒。可考虑: 人答 need 唤醒时, 「你要交代」把该 wizard 对这个人仍开着、回过 need 的 duty 一并列出。改的是唤醒文案, 不动账本。
- [ ] 小清理: `daemon/room-overdue.ts` import 的 `holderOf` 未使用 (`tsc --noUnusedLocals`), 下次清理批带上。
- [x] handoff 可靠性: `c6f3c31` 已实证 —— 2026-11-22 18:30 OliveOwen 自我交接 `简报已贴回 ok:true` (Enter 到确认 212ms); c6f3c31 上线后 4h 内 `handoff: 放弃` 0 次; `打断后仍未静下来` 最后一次在 11-21 16:26, 之后 0 次。
- [ ] 上下文成本: charter 体积。
- [ ] daemon 内存 / 并发治理 (本机 3.7GB)。

## 待 admin 拍板

1. ~~charter 删 `wait_peer` 两处~~ 已批已做 (2026-11-22)。原文: (已报, 未批) (`daemon/wizard.ts:1087` 工具行整行删, `:1120` 「不 `wait_peer` 守着」改「不守着」)。纯修正 (工具已不存在), 但会让所有 chartered wizard 收到 handoff 提醒。推荐: 批准, 与下一次必要的 charter 改动合并发出, 减少一次全体提醒。

2. ~~room vs dm A~G~~ admin 回复: A、C 不要; D 改为「dm 统一为 room 特殊形式 + history 参数」(已完成 d986e7a); B 未批; E/F/G 未表态。原文: (见 [research/room-vs-dm-collaboration.md](research/room-vs-dm-collaboration.md) §5)。推荐先批 A (lead 派活信封加一句「小队一个 room」, 零代码) 与 B (多个非成员 chat_ask 自动开 adhoc); G (charter 判据) 与 #1 合并发出。

3. ~~lead 标记什么时候摘~~ admin 选 B, 已做 (2026-11-22)。原文: (2026-11-22 群里提)。现状: `delegate({lead:true})` / `spawn({lead:true})` 写 `lead: true` 后永不清除; 它驱动三件事 —— charter 多一节 lead 规矩、rolepage 👑、delegate「lead 身份, 独立任务不自动复用」veto。实测 `wizards.json` 5 个 lead (Grace / IrisIrwin / JackJones / LeoLane / OliveOwen), 前四个的 lead 活大多已交差, 却永远戴着 👑、永远不被自动派活。
   - **推荐 B (显式)**: lead 记的是「领了哪一件」—— `WizardRecord` 加可选 `leadOf: <派它那条 chat_ask 的 msg id>`; 那条 duty 被 done / passed / canceled 关掉时 room-hub 摘 lead (还有 active/paused plan 就等 plan 收尾再摘)。合项目口径: 完成只认账本上的显式字段, 不推断。老记录没有 `leadOf`: boot 时若它名下没有同伴开的未关 duty、也没有 active/paused plan, 就摘掉 (会改 `wizards.json` 里 4 条的 flag, 不删记录)。
   - 备选 A (推断): 不加字段, 每次它 chat_reply 关账后, 名下没有同伴开的未关 duty 且无 active plan 就摘。改动更小, 但同时领两件时会摘早。
   - 常驻 duty (OliveOwen 的 d6977146.1) 永不关, 两种方案下它都一直是 lead —— 符合事实。

## 进行中

- 常驻 duty d6977146.1 已 passed 关掉 (admin 授权直接在群里汇报; 否则逾期提醒会每 2h 误报它)。

## 已完成

| 日期 | 事 | commit |
|---|---|---|
| 2026-11-22 | 建本文; vendor.js 去 d3; mention 提醒去 `wait_peer` | `c182134` |
| 2026-11-22 | 研究: 什么时候拉 room / room 里怎么说话 (admin 之问), 账本实测 adhoc 0 / dm 43 / 64% dm 消息提到第三方 | 见 git log |
| 2026-11-22 | room_invite/room_approve `history` 参数 (none/N/from:id/all); dm 显示统一 (多人列全员); ensureDmRoom 补回 / 混入第三人改落 {A,B} adhoc。coder QuinnQuincy, 白板 reviewer RoseReed 通过。遗留: join-req 路径不校验 history; rejoin 不写 seen 未细查; 多个 {A,B} adhoc 取最近活动会合流 | `d986e7a` |
| 2026-11-22 | `daemon/peers.ts` 删回执时代死代码 ~260 行 (我自己做: 活着的 wizard 已 4 个, 不起新人) | 见 git log |
| 2026-11-22 | room hub: 投给已结束 wizard 的 duty 不再静默丢失 (`gone` → `undelivered` 系统行给提问者; 其他失败打 warn)。起因: IrisIrwin 被 /kill 后两次派活都没投进去 | 见 git log |
| 2026-11-22 | lead 按件摘 (方案 B: leadOf + leadSettled); 内存不再挡活 (round 规矩与 platform-push 提示词同步) | 见 git log |
| 2026-11-22 | admin 批「按推荐处理」: charter 删 `wait_peer`; delegate 占用 veto 接上 (只认同伴 chat_ask/delegate 开的 duty); 被结束 wizard 不自动重生 (维持 undelivered 系统行); platform-push 提示词改成「有进展就在群里说」 | 见 git log |
| 2026-11-22 | `/help` 协作一节改成 room 口径; `wizard.ts` 身份注释去 `tell_peer` | 见 git log |
| 2026-11-22 | 删 `shared/turn-state.ts` 与恒空的 `WorldFacts.inflight` / `routeReceiptDutiesOf` / `WizardBrief.turns` (-64 行); 顺带发现 delegate 的占用 veto 恒空 (登记 P1) | 见 git log |
| 2026-11-22 | 测试基线 109→111 / 113: `codex-backend` (bin 覆盖已退役) 与 `wizard-stream` W-2 (all=1 已退役) 改断言现行行为 | 见 git log |
| 2026-11-22 | duty 逾期提醒 (AliceZane `cc80495`), 白板 DavidClark 审出 3 一般 + 若干小, 修于 `f80c80c`: group 等 remind 被读到才报、remind 不受唤醒预算、每 duty 失败隔离、按 holder 计时去重、move 算活动、跳过无主 duty。遗留: 失败隔离断言偏弱; host 换人后行为无专测; 首轮旧 `sys:"overdue-group"` 行不再算已给 (重启后实测未重报) | `cc80495` `f80c80c` |
| 2026-11-22 | 群公告后端 (FrankEvans): 账本 `NoticeOp` + `judgeNotice` (≤500 字, host / 人可改)、`room_name({notice})`、人用 `/notice` (设/看/clear)、改动发「📌 群公告」系统行 + notices.ts 提示、charter「本群公告」节、/api 带 `notice`、room_read 头部。遗留: 同文本 10 分钟内设→清→再设第二条系统行被去重吞; 无账本的新群 `/notice` 回「没有这个 room」; 企微镜像 / `/notice` / 在跑 wizard 提示未在线上实测 | `ca5dbe4` |
| 2026-11-22 | 成员栏一人一行 + 栏顶群公告 (BobAdams): 状态点·名字·👁/⭐/👑·待交代·最近发言, 次要信息进 tooltip, 人在前, 头一行。admin 7aeb85fc.291 / .299 已 done。遗留: 长名与待交代挤; 公告未线上实测 | `b40388d` |
| 2026-11-22 | 人也有 duty (HenryGreen): wizard 对人 need / chat_ask 点名人 → 人名下开 duty (kind `need` / ask / task); 人下一句话关账 (引用对回账本行, 对不上则全关) 并把提问 wizard 补进 `to` 唤醒; 人名下只做 group 级逾期, wizard 等人时不计逾期; 成员栏「反问」。admin 7aeb85fc.300 done。遗留: 同一条连 need 两次开两条; 提问 wizard 离开后它开在人名下的账不取消 | `6dc15c5` `00a3961` |
| 2026-11-22 | svr 冷启动名册不再缺席: 快照落盘 + 按 TTL 读回 (不改推送协议) | `f0fc2f8` |
| 2026-11-22 | handoff 简报回贴不再永远判失败 (LeoKing): fd4715b 删旧沟通层时连 `withMsg` 调用一起删了, 无信封注入不带 message-event 标记, 提交确认永远找不到 → 每次 `handoff: 放弃` (简报其实送到了)。新增 `envelopeFor`, `injectText` 对有 eventId 无信封的注入补标记。核对: handoff 后的「继续 <event>」续答 (`owed: () => []` / `resume` 空桩) 是有意退役 —— room hub 按 seen 游标重投欠账, 不需要它。待验: 下一次真实自我 handoff 时 daemon.log 不再出现「框空了且转录里始终没有这一笔」 | `c6f3c31` |
| 2026-11-22 | 清理 (PaulOwen): picker 哨兵被真实输入抢占 (`PaneInputError` canceled) 只打 debug (24h 36 条 warn 噪音); reminder.ts 退役 attr; tests 死数据; 注释退役工具名。顺带修 c6f3c31 引入的 `pane-delivery` 失败 (vm 沙箱缺 `envelopeFor`)。教训已记 workspace 记忆: 别 git stash; vm 沙箱测试要随 mirror-bridge 新 import 补注入 | `e600ed3` `eff3069` `3e03081` `0492e38` |
| 2026-11-22 | 开发者指南 `docs/dev-guide.md` + CLAUDE.md / 契约 / 注释对齐现行代码 (RoseQuincy, standard)。handoff 修复 `c6f3c31` 线上实证 ok | `afb1743` `06bd575` |
| 2026-11-22 | 测试: 默认 MCP 工具 ⊆ charter 名册, 带防腐烂豁免表 (WendyVance, light)。探出缺口 `wecom_doc_*` 两个, 留给下次 charter 攒批 | `c226798` |
| 2026-11-22 | admin 7aeb85fc.378: 删企微文档 MCP 桥 (两工具 / `/wedoc/*` / `daemon/wedoc.ts`, -487 行, CHANGELOG BREAKING; YaraXu); 关系图「缓存冷」图例改名 + 冷节点淡灰细描边, 成员栏同源 (AliceYoung, 截图核对) | `d6b831b` `b38ab70` |

## 机制笔记: duty 一直不关时 daemon 做什么 (2026-11-22 读码, admin 问)

**没有按时间触发的超时提醒, 也没有超时关账。** 所有动作都由事件触发 (轮次结束 / pane 消失 / 投递失败), 而且每条 duty 只做一次:
- **处理人这一轮结束却没交代** (`room-hub.ts` `onStop` / `onIdle`): 只看「唤醒它的 duty、本轮它还没 chat_reply 过」。支持 Stop hook 的后端 (`hooks/stop.sh` → `/room/stop-check`) 同一轮拦一次让它接着交代; 不支持的在轮终往 pane 贴一条 `REMIND_TEXT`。还不交代 → 给提问者写一条 `sys:"undelivered"` 系统行 (唤醒提问者; 绑定 room 里会进企微)。每条 duty 提醒一次、系统行一条, 之后不再有动作。「已提醒」记号只在内存里, reload 后清空; 但 reload 后 `turns` 也是空的, 所以不会补提醒。
- **只要回过 progress / need**, 这一轮就算交代过了 (`dutyAnswered`): 不提醒、不告状, duty 继续开着, 之后没有任何提醒。
- **处理人在忙**: 看门狗 (`room-watchdog.ts`, `rooms.watchdog.staleMin` 默认 5 分钟、`intervalSec` 默认 60 秒) 只把它计入日志汇总 `busyList`, 不打扰。
- **pane 活着但闲** (漏了 turn_end): 看门狗补一次 `onIdle`, 走上面那条路 (已提醒过的不重复)。
- **pane 没了**: 看门狗两次扫描确认后对它所在的每个 room 走 `leaveOps` —— 它名下的 duty 写 `canceled` (唤醒提问者), 再写一行 `instance-ended`。**这是唯一一种自动关账。**
- **被 stop_wizard 结束 (没有会话绑定)**: 投递时 `gone` → 给提问者写 `undelivered` 系统行 (0077aef), duty 不关。
- **冷 wizard (没有 pane 绑定)**: 看门狗只计数; 有新行要投时 hub 粘贴会重生它。
- plan 提醒 (`plan-reminders.ts`, 30 秒一轮) 反而在 owner 还欠着该 plan 的 duty 时**不提醒** —— 它管的是 plan 没人推, 不是 duty 超时。

**无限期挂着的后果**: rolepage 成员栏一直显示「待交代 N」; delegate 的占用 veto (813530e) 一直挡着它, 不会被自动派新活 (`to` 点名仍可); 它若是 lead, 👑 不摘 (2692790); 提问者要是在等, 只会等下去, 除非它自己 `pending_items` 去看。

**建议 (只是方案, 未做)**: 在看门狗扫描里加一条「逾期」检查, 不改账本格式 (`sys` 本来就是字符串, 只多一个取值):
- 未关、kind 为 ask / task 的 duty, 账本里最后一条碰它的行 (原 ask、reply、trigger) 距今超过 `rooms.dutyOverdueHours` (默认 24, 0 = 关): 给**提问者**写一条 `sys:"overdue"` 系统行 (唤醒它; 绑定 room 里会进企微, 人就看得见), 让提问者决定催、改派还是 canceled。账本里已有这一行、且之后没有新活动就不重复。
- 不自动 canceled —— 完成只认显式关账; 处理人还在, 自动关账会丢活。
- 升级只做一级: 提问者是 wizard 就由它处理; 提问者是人, 或这行在绑定 room 里, 镜像本身就是「让人知道」。要不要第二级 (2×阈值仍没动静再通知 host), 等跑一阵看量再定。

## 已知坑

- **测试基线失败**: 见上「测试基线」。`tests/charter.test.ts` 断言 charter 含「不 `wait_peer` 守着」—— 改 charter 时要一起改。
- daemon.log 里 `spawn-tmux: pane creation failed` (duplicate session) 与 `launch failure with --model` (No conversation found) 的成串 warn 都早于 2026-11-21 `spawn-tmux.ts` 的修复, 之后未再出现。
- `web/chat.js` 正由 `LeoLane` (关系图) / `IrisIrwin` (视角 / detail) 改, 别并行动它。
- 多 wizard 共用 git index: 提交前 `git diff --cached`, 必要时临时 index。
