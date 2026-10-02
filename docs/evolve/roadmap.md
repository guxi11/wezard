# 路线图

> 牵头 `.evolve` · 总纲见 [README.md](README.md)
> 排序原则: 先堵安全洞, 再补原语语义, 再修记忆通路, 最后收工具面; 同一批内各路改**不相交的文件**, 避免并行冲突。
> 状态: ⬜ 未开始 · 🟡 进行中 · ✅ 已落地 (附 commit)

## 批次总览

| 批 | 主题 | 内容 | 主要文件 | 成本 |
|---|---|---|---|---|
| **B1** | 安全 + 上下文卫生 | ① hook 不再免审 `config_set` 写 / `set_model default` · ② spawn 失败不留僵尸身份 · ③ 工具描述清掉 send_peer/wait_peer 过期引导, 压缩 send_peer / schedule_task / model 参数 / tell_peer 描述 · ④ charter 瘦身: 名册只列有职责的, 「能做什么 / 编排 / 说话」三节与描述去重 (L0 一行一工具) · ⑤ CLAUDE.md MCP 段与 `/help` 过期措辞 | `hooks/pre-tool-use.sh` · `daemon/index.ts` (clone 路由) · `mcp/server.ts` · `daemon/wizard.ts` · `CLAUDE.md` · `daemon/inbound.ts` | 小 |
| **B2** | continuation 补全 + 状态可见 | ① 回执失败分支: timeout / silent / dead 也投递, 信封带 `status`, 工单计为定论 · ② `tell_peer({deadline})` 取代写死的 3600s · ③ 信封 turn id + 回执 `re` + `tell_peer({re})` 续问 (④ 的 `NEED:` 要靠它答回去) · ④ 收口三态 `RESULT:` / `NEED:` (needs-input, 不推进工单计数) / `ARTIFACT:` (收工气泡列产物) · ⑤ 派生 `TurnState` 进 roster / peek / list_jobs · ⑥ UI: 「卡在审批」第四态 · `/api/world` 瘦身 + 304 · 消息游标分页。①–④ 同改 `receipts.ts` + 信封, 归一个实现者串行做, 不并行拆; 先与 `.receiptmiss` (正在查回执丢失, 同一条链路) 对齐 | `daemon/receipts.ts` · `shared/reminder.ts` · `daemon/jobs.ts` · `daemon/peers.ts` · `shared/turn-state.ts` (新) · `shared/world.ts` · `shared/chat-http.ts` · `web/chat.js` | 中 |
| **B3** | 记忆通路 + 一件事的视图 | ① 合并后 notices 推给在跑的 wizard (与 `.memsteward` 对 `onMerged` 接口; 整理者读 CLAUDE.md / auto-memory 作已知) · ② self 记忆跨 `/clear` · clone 继承父 self 记忆 · self 满额不再 FIFO 静默丢 · ③ 交接简报 / 收工结论归档 `memory/episodes/` · ④ 上下文临近压缩时挂一行「先 remember」提醒 · ⑤ 共享记忆注入设上限, 超了截尾并附全文路径 (现 `clipForCharter` 截头) · ⑥ UI: 回执 chip + 序号 · 工单一等会话 `j:<id>` · 关系图按工单高亮 · 只读待办托盘 | `daemon/notices.ts` · `daemon/wizard.ts` · `daemon/handoff.ts` · `daemon/jobs.ts` · `daemon/mirror-bridge.ts` · `shared/role-view.ts` · `shared/role-render.ts` · `shared/detail-store.ts` | 中 |
| **B4** | 工具面收敛 + 编排体验 | ① `handoff({name?})` 合并两个交接工具 · ② `spawn_wizard({detached})` 吸收 new_claude_session · ③ graph 三件套 / list_claude_sessions / switch / list_chats 降出 charter 与默认面 · ④ `tell_peer({kind: task\|ask\|fyi})` · ⑤ 定时任务 `QUIET` 静默哨兵 + 点名目标忙则顺延 · ⑥ graph 降格: `rounds`/`until` 并入工单预算 (`maxTurns` / `deadline`) 防乒乓, `run_agent_graph` 变成 job + 预算的语法糖 · ⑦ 工单 `accept` 条件, 空 `RESULT` 自动打回一次 · ⑧ 按 turn 取消 (依赖 B2 ③), 打断不误伤别人派的活 · ⑨ 竞速收尾: `need:1` 后自动 stop 输家 · ⑩ 工单记账依赖 `after:[id]`, 回执信封报「已解锁」| `mcp/server.ts` · `daemon/index.ts` · `daemon/tasks.ts` · `daemon/jobs.ts` · `daemon/wizard.ts` | 中 |
| **B5** | 按需 (有真实需求再开) | 回执可选 schema / 结构化返回 (close_job 机械合并) · Flow AST `run_flow` (仅当出现「无人值守必须跑完」的真实需求才重开, 默认不做) · transcript 投影化 (单源折叠) · `recall` 检索 (grep/BM25) · 共享 md「钉住 + 索引」格式 · 整理者 reflect · rolepage 写票据 (页面上点审批 / 打断) · 指挥台视图 (Plan 视图画 ledger + TurnState 的实际轨迹, 不存 `expr`) · 记忆可见 · per-wizard 审批策略 · `clone_wizard({at})` 历史点分叉 | — | 大 |

## 验收标准 (每批通用)

1. 实现者之外至少一个 wizard review 过 diff, 意见处理完。
2. `npm run typecheck` 通过; `npm run build && ./cli/wezard.sh reload` 后 `./cli/wezard.sh status` 正常。
3. 实际跑一次行为验证 (派一个 wizard / 触发一次回执 / 打开 rolepage), 结论写进收口。
4. 逐单元 commit, 只 stage 自己的文件; `CHANGELOG.md` `[Unreleased]` 记一条。
5. 群里一句进展。

## 进度

| 批 | 状态 | commit | 备注 |
|---|---|---|---|
| B1 | ⬜ | | |
| B2 | ⬜ | | |
| B3 | ⬜ | | 前置已就绪: `.memsteward` `c53392f` 加了 `StewardDeps.onMerged` (只报内容真变了的 md) 与 `refsOf`; 接线在 `index.ts`, md↔wizard 用 `memoryPath(stateDir, scope, …)` 正向算后比对, 跳过 `isInternalKey` |
| B4 | ⬜ | | |
