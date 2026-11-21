# 平台推进 · 进展文档

> 负责人 `OliveOwen` (平台常驻 lead, parent `wezard-1`) · 建于 2026-11-22 · 分支 `v3`
> 每轮「平台推进」先读这份, 收尾时更新它。admin 随时可读; 有里程碑或需要拍板时才经 `wezard-1` 汇报。

## 使命

把 wezard 做成成熟、强大的 agent 编排协作平台。每一轮自问「现在最值得改进的一件事是什么」, 在四条线上持续推进:
① UI/UX (rolepage、卡片、IM 侧交互) · ② 代码 (死代码、重复、测试、可靠性、可观测) · ③ 模型 (room / duty / route / plan / 身份与记忆的概念一致) · ④ 文档 (CLAUDE.md / README / 技术说明与代码一致, 开发者指南)。

## 每轮规矩

1. 读本文 → `wizard_roster` / `pending_items` / `plan_list` (别重复派、别撞文件) → `free -m`。
2. 可用 < 700MB, 或活着的 wizard (含我) 已 ≥ 4: 只做轻量工作 (读码 / 设计 / 文档 / 小改动自己做), 不起新 wizard。否则最多起 1 个 light/standard。
3. 选 1 件做完: typecheck、相关 tests 通过数不减少、前端改动截图 (`node scripts/shot.mjs`, 串行)。
4. 小步 commit, `git diff --cached` 只含自己的 hunk; 不 stash / reset / checkout 别人的改动。
5. 更新本文并提交; 交差的分身 `stop_wizard`。没值得做的事就回 QUIET。
6. 不可逆 / 对外的事 (push、发布、改 `~/.wezard/config.jsonc` / 权限 / secrets、删状态、改服务定义、群发) 和**改语义的大重构** (数据模型、落盘格式、删 MCP 工具、改 charter 文案): 先在 `docs/evolve/` 写方案, 经 `wezard-1` 报 admin 拍板。

## 测试基线 (2026-11-22, 逐个 `npx tsx tests/<f>`, 120s 超时)

**109 / 113 通过** (2026-11-22 加 room-gone 后复跑; 早先 108 / 112、102 / 106)。失败 4 个: `codex-hooks` / `codex-session` (本机没装 `codex`, spawn ENOENT, 环境问题) · `codex-backend` (断言 `'/opt/codex'` 实得 `'codex'`, 待查) · `wizard-stream` (「W-2 多出 room 里的其他行」, 疑为 `762482b` 删掉「全部消息」all 链路后断言没跟上, 属 rolepage detail 线)。每次改动后对照, 通过数不能减少。

## 优先级清单

### P0 — 正确性 / 直接误导模型
- [x] **提醒文案指向已退役的 `wait_peer`** —— 人话里点名 wizard 时注入的 mention 提醒 (`daemon/peers.ts` `peerMentionPart`) 让模型调用一个已不存在的工具。改成 `chat_ask · peek_peer`。(本轮)
- [ ] **charter 仍列 `wait_peer`** (`daemon/wizard.ts` 「我能做什么」与「派完就放手」两行)。工具已从 `mcp/tools.ts` 删除, 模型照 charter 去调会失败。改 charter 文案会触发全体 handoff 提醒 → **待拍板** (见下)。
- [ ] 测试基线里的真失败: `codex-backend` 断言 (是否真回归) · `wizard-stream` W-2 断言 (rolepage detail 线, 先问 `IrisIrwin` 是否在它手上)。

### P1 — 死代码 / 包体 / 可靠性
- [x] **chat_ask 给已结束 (stop_wizard end) 的 wizard 静默丢失**: hub 认 `gone` → 给提问者写 `undelivered` 系统行; 其他失败打 warn。(本轮)
- [ ] **跟进: 被结束的 wizard 被唤醒时要不要自动白板重生** —— `stop_wizard` 描述写的是「之后再找它是一个空白会话」, 人那边 `/kill` 后下条消息也会自动重开, 但 room 唤醒没有这条路 (`injectText` 对无绑定目标直接 gone)。自动重生要定: 模型/档位与 cwd 从哪来 (绑定随 /kill 一起删了)、内存闸、要不要先问 parent。改的是语义 → 先写方案报 admin。
- [x] **vendor.js 去掉无人使用的 d3** (~280KB 未压缩, 每次冷加载 rolepage 都要下): `shared/chat-render.ts` 不再拼 `d3.min.js`, 删 `web/d3.min.js`。关系图早已换成自写的 stress majorization。(本轮)
- [x] **`daemon/peers.ts` 回执时代遗留删净** (~260 行): `parseClosing` 一族、`addressedResults`、`replyClosedBefore` / `openingTurn`、`renderTask/Peer/ReceiptEnvelope`、`tailTurns`; `tsc --noUnusedLocals` 逐轮确认, 测试里只测回执措辞的一条断言同删。(本轮)
- [ ] `shared/turn-state.ts` `TurnState` / `WorldFacts.inflight` 恒空 —— 收成类型或删。
- [ ] `shared/reminder.ts` 已退役 attr; tests 里 `topOnly` / `speech` 死数据; 注释里残留 `tell_peer` / `router` / `read_chat`。
- [ ] svr 重启后名册缺席 30~70s: daemon 应在 svr 上线时立即补推 `WorldFacts`。
- [ ] lead 标记 (`WizardRecord.lead`) 写入后从不清除。
- [ ] `/help` 文案陈旧。

### P2 — 模型 / 文档 / 体验
- [ ] `docs/evolve/README.md` 与 `roadmap.md` 大段描述已退役的 receipts / jobs / tell_peer, 与现行 room 模型冲突: 加醒目的「历史文档」头, 或重写成现行路线图。
- [ ] 开发者指南: 新加一个 MCP 工具 / 一个 room 行类型 / 一个 reminder kind 要动哪几处 (现在只能读 CLAUDE.md 长段落)。
- [ ] 上下文成本: charter 体积、handoff 可靠性 (daemon.log: `handoff: 放弃` 15 次 / `打断后仍未静下来` 21 次, 24h 内)。
- [ ] daemon 内存 / 并发治理 (本机 3.7GB)。

## 待 admin 拍板

1. **charter 删 `wait_peer` 两处** (已报, 未批) (`daemon/wizard.ts:1087` 工具行整行删, `:1120` 「不 `wait_peer` 守着」改「不守着」)。纯修正 (工具已不存在), 但会让所有 chartered wizard 收到 handoff 提醒。推荐: 批准, 与下一次必要的 charter 改动合并发出, 减少一次全体提醒。

2. ~~room vs dm A~G~~ admin 回复: A、C 不要; D 改为「dm 统一为 room 特殊形式 + history 参数」(已完成 d986e7a); B 未批; E/F/G 未表态。原文: (见 [research/room-vs-dm-collaboration.md](research/room-vs-dm-collaboration.md) §5)。推荐先批 A (lead 派活信封加一句「小队一个 room」, 零代码) 与 B (多个非成员 chat_ask 自动开 adhoc); G (charter 判据) 与 #1 合并发出。

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

## 已知坑

- **测试基线失败**: 见上「测试基线」。`tests/charter.test.ts` 断言 charter 含「不 `wait_peer` 守着」—— 改 charter 时要一起改。
- daemon.log 里 `spawn-tmux: pane creation failed` (duplicate session) 与 `launch failure with --model` (No conversation found) 的成串 warn 都早于 2026-11-21 `spawn-tmux.ts` 的修复, 之后未再出现。
- `web/chat.js` 正由 `LeoLane` (关系图) / `IrisIrwin` (视角 / detail) 改, 别并行动它。
- 多 wizard 共用 git index: 提交前 `git diff --cached`, 必要时临时 index。
