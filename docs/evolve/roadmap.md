# 路线图

> 牵头 `.evolve` · 总纲见 [README.md](README.md)
> 排序原则: 先堵安全洞, 再补原语语义, 再修记忆通路, 最后收工具面; 同一批内各路改**不相交的文件**, 避免并行冲突。
> 状态: ⬜ 未开始 · 🟡 进行中 · ✅ 已落地 (附 commit)

## 批次总览

| 批 | 主题 | 内容 | 主要文件 | 成本 |
|---|---|---|---|---|
| **B1** | 安全 + 上下文卫生 | ① hook 不再免审 `config_set` 写 / `set_model default` · ② spawn 失败不留僵尸身份 · ③ 工具描述清掉 send_peer/wait_peer 过期引导, 压缩 send_peer / schedule_task / model 参数 / tell_peer 描述 · ④ charter 瘦身: 名册只列有职责的, 「能做什么 / 编排 / 说话」三节与描述去重 (L0 一行一工具) · ⑤ CLAUDE.md MCP 段与 `/help` 过期措辞 | `hooks/pre-tool-use.sh` · `daemon/index.ts` (clone 路由) · `mcp/server.ts` · `daemon/wizard.ts` · `CLAUDE.md` · `daemon/inbound.ts` | 小 |
| **B2a** | receiver task 与 durable recovery | 已由 [receipt-router.md](receipt-router.md) 的实现替代：单 unfinished task per owner/receiver、显式多接收者 RESULT、input coverage、持久 route/inbox/outbox、暴露证据与 uncertain ACK 恢复。deadline 不产生 timeout/silent/dead route 终态。旧 watcher/continuation 设计仅作历史，见各退役指针。 | `daemon/router.ts` · `daemon/message-events.ts` · `daemon/index.ts` · `shared/turn-state.ts` | ✅ `1646fa6` |
| **B2b** | 状态可见 (UI) | 「卡在审批」第四态 · `/api/world` 瘦身 + 304 · 消息游标分页。与 B2a 文件不相交, 可并行, 各自验收 | `shared/world.ts` · `shared/chat-http.ts` · `web/chat.js` · `web/chat.css` · `daemon/index.ts` (facts provider 一处) | 小 |
| **B3** | 记忆通路 + 一件事的视图 | ① 合并后 notices 推给在跑的 wizard (与 `.memsteward` 对 `onMerged` 接口; 整理者读 CLAUDE.md / auto-memory 作已知) · ② self 记忆跨 `/clear` · clone 继承父 self 记忆 · self 满额不再 FIFO 静默丢 · ③ 交接简报 / 收工结论归档 `memory/episodes/` · ④ 上下文临近压缩时挂一行「先 remember」提醒 · ⑤ 共享记忆注入设上限, 超了截尾并附全文路径 (现 `clipForCharter` 截头) · ⑥ UI: 回执 chip + 序号 · 工单一等会话 `j:<id>` · 关系图按工单高亮 · 只读待办托盘 | `daemon/notices.ts` · `daemon/wizard.ts` · `daemon/handoff.ts` · `daemon/jobs.ts` · `daemon/mirror-bridge.ts` · `shared/role-view.ts` · `shared/role-render.ts` · `shared/detail-store.ts` | 中 |
| **B4** | 工具面收敛 + 编排体验 | ① `handoff({name?})` 合并两个交接工具 · ② `spawn_wizard({detached})` 吸收 new_claude_session · ③ graph 三件套 / list_claude_sessions / switch / list_chats 降出 charter 与默认面 · ④ `tell_peer({kind: task\|ask\|fyi})` · ⑤ 定时任务 `QUIET` 静默哨兵 + 点名目标忙则顺延 · ⑥ graph 降格: `rounds`/`until` 并入工单 `maxTurns`，`run_agent_graph` 变成 job + 预算的语法糖 · ⑦ 工单 `accept` 条件, 空 `RESULT` 自动打回一次 · ⑧ 按 turn 取消, 打断不误伤别人派的活 · ⑨ 竞速收尾 · ⑩ 工单依赖 `after:[id]` · **遗留收尾** ⑪ `/config/set` 路由鉴权 · ⑫ reload 窗口里的孤儿 tmux 窗口 · ⑬ forget 冷记录时摘出开着的工单 · ⑭ `/compact` 与自动压缩后补回 self 记忆 · ⑮ `ask_user` 提问卡带 sessionId。 | `mcp/server.ts` · `daemon/index.ts` · `daemon/tasks.ts` · `daemon/jobs.ts` · `daemon/wizard.ts` · `daemon/mirror-bridge.ts` · `daemon/ask.ts` | 中 |
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
| B1 | ✅ | `928b870` `77c0c02` `70aae40` `bba80a4` `4a73514` `b9c4f01` | charter 5.1k→2.6k tok, 工具定义 20.4k→17.8k tok。 留后: `/config/set` 路由不鉴权 (本机任意进程可写) · reload 窗口内的孤儿 tmux 窗口只 warn 不 kill · forget 冷记录未摘出开着的工单成员 · CLI 免审收紧后 `npm run build && ./cli/wezard.sh reload` 要过审批卡 |
| B2a | ✅ | `1646fa6` | receiver task 单槽归并与 alias · 显式 `@.name RESULT:` 多接收者 · `inputIds` coverage · durable route/inbox/outbox · ACK 不确定性保护 · event/transcript/session 证据恢复。deadline 不自动合成 route 失败。 |
| B2b | ✅ | `ce3bca0` `062cc13` `671c82d` `c5cfdb5` `a03b407` | 等人点第四态 (按 `getMirrorTarget` 归属) · `/api/world` 首行截取 + ETag/304 (实测命中) · `/api/msgs` 游标分页, 游标失效按时刻兜底, 无时刻则整窗重载。 已知: facts 缓存 10s, 点完卡紫灯最多滞后 10s · `ask_user` 的 generic pending 不带 sessionId, 不亮灯 |
| B3a | ✅ | `0644bb6` `77687bb` `b168a43` `733cb12` | ①–④ 落地, ⑤ 无需改 (`clipForCharter` 本就截尾附路径)。 留后: 120k 提醒未实测, 对 `[1m]` 模型偏早 · `/compact` 不改 jsonl, 不触发 self 记忆补发 · 收工结论归档 episodes 等 B2a |
| 批外 | ✅ | `03db344` `77bdc91` `2a39085` `042609b` | 不在批次表里、由人直接提的改动: tell_peer `priority` (normal 等闲 / urgent 打断再投 / now 插话；当时保留 `when` 旧 MCP 别名，现已退役) · 唤醒冷且大的 wizard 回包带 `wakeCost` · 管家分派偏省钱 (候选表给缓存冷热、唤醒代价) · 出生名册只列 2 天内动过的同群 wizard。B4 ④ 的 `tell_peer({kind})` 与 priority 并存前要先对一遍 |
| B3b | 🟡 | `81f02b9` `a005fc6` `147ace7` `85d65ee` `0cb4cf2` `1ef967d` `1b3745d` `bbdaf33` `27540e9` · `19ce3d8` `6fbdaf4` · `dd2f892` `45db75c` `a3596be` `d4cd983` | 回执回归脚本 `scripts/receipt-regress/run.mjs` (9 条, 改 receipts / jobs / peers 必跑) · 终态只留 `turn-state` 的 Terminal 一份 · NEED 往返只提示不设硬上限 (硬刹车是工单预算) · wait_peer 与投递双投修复 · 收工后迟到的回执不再催 close_job · `chain:false` 旁支 · **工单不进群**: 开工/收工不发气泡, 带 job 的派活回执一律私聊, 群里只留发起者的收口 · tmux 注入改具名 buffer (跨 pane 串台) · 收工结论存进 episodes · 记忆提醒线按模型窗口算 · 回执 chip + 序号 · 在飞活托盘。 **待人**: 工单页与关系图按工单高亮已做好未提交, 等人对 [job-page.md](job-page.md) 的意见。 留后: 并发 spawn 会认错新会话 sid (already bound) |
| B4 | 🟡 | `e608f58` | 工单 `J0d262f`, 三路: `.ev-tools` ①–④ · `.ev-proto` ⑤–⑩ · `.ev-mem` ⑪–⑯。已落: ⑭ `/compact` 与自动压缩后补回 self 记忆 |
