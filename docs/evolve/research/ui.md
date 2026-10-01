# rolepage UI 审计: 让人看懂并操纵一群 wizard

> evolve 第一批 · `.ev-ui` · 2026-10-02
> 范围: `shared/role-view.ts` `shared/role-render.ts` `shared/chat-http.ts` `shared/world.ts` `web/chat.js` `web/chat.css`。
> 实测: 本机 svr `127.0.0.1:17891`, 视角 `.evolve`, 那时它刚开出工单 `J04a4f2`, 派出 7 个 `ev-*`。
> 浏览器扩展没连上, 页面表现是靠 API 回包加代码推出来的, 没有截图。

## 0. 一句话结论

rolepage 已经是一个**做得不错的「单个 role 的 IM」**: 三轴、换视角、未读、session 分段、关系树、日程都有了。
但它的基本单位是**消息和会话**, 而人管一群 wizard 时想的是**一件事 (工单 / 编排)** 和**谁卡住了**。
所以最值钱的改动只有两条:
**① 把工单做成一等会话** (fan-out 一眼看完),
**② 给忙闲状态补上「卡在审批 / 等回执」, 再加一个全局待办托盘** (知道该去哪)。
其余都是在这两条基础上补全。

---

## 1. 现状速写 (目前已有的)

| 能力 | 落点 | 评价 |
|---|---|---|
| 三轴 role → chat → target | URL `role/conv/with/session`, `convsOf` / `talkOf` / `talkArgs`; `a:<x>\|p1,p2` 能把对话按人跨会话排开 | 与 `read_chat` 同一套轴, 设计干净 |
| 换视角 | 点气泡对面的空白; FLIP 动效; 任一票据都能看全部 role | 核心交互, 很好 |
| 私聊 / 公开 | `channel === ""` → `p:<对端>` 私窗; 公开 → `c:<base>` 群窗 | 语义正确, 但「这条私聊属于哪件事」看不出来 |
| 工单 | ① 入消息顶上一枚 `📋 J04a4f2` chip (`role-render.ts inMeta`); ② 日程视图里一行 `jobRow`; ③ 关系图 `job` 边 | 散在三处, 哪处都不能点进去 |
| 回执 | `from.receipt=true` 的轮没有入消息, 出消息算在发起者头上 | 页面上**认不出来**, 没有 chip、序号、工单号 |
| 忙闲 | `stTag`: 执行中 / 空闲 / 已关闭 三态 | 缺「卡在审批」, 这恰恰是人最需要介入的状态 |
| 审批 | `renderApprovalItem`: 🔐 工具名 + `待审批` 徽章, 藏在过程框 (`.steps`, 默认折叠) 里 | 不汇总, 也不能操作 (没有 POST 路由) |
| 关系图 | 家谱 + 派活合成有向树, 边带 kind/次数/工单号 (悬停提示) | 一个 role 的网络看得清; 一件事看不清 |
| 日程 | 12h 刻度条 + 任务卡 (rule / gate / prompt / 出错) + 工单行 | 定时这部分做得好; 工单只是个附带列表 |
| 记忆 | **完全没有** | `WorldFactWizard` 没有 memory 字段, `~/.wezard/memory/*.md` 没有对外提供 |
| 性能 | SSE 增量 + sig 去重; 世界快照只在看得见时轮询 | 有两个肥点, 见 §3.8 |
| 移动端 | 一个 760px 断点, 侧栏和主区互切 | 能用; 悬停类信息在触屏上看不到; 没有暗色 |

---

## 2. 证据: 一次 fan-out 现在长什么样 (实测 `.evolve`)

`/api/role?role=…#evolve` 回包里 `convs` 共 8 项:

```
c:user:ZhangYuanYuan        249 条, 14 个子项   ← 人所在的群
p:…#ev-proto / ev-ui / ev-tools / ev-mem / ev-lisp / ev-claw   各 2 条
p:user:ZhangYuanYuan        2 条
```

- **一件事被拆成了 6 个以上的私聊项**, 和群混在一起按时间排, 侧栏里看不出它们属于同一个工单 `J04a4f2`。`ev-a2a` 还没开口, 所以压根不在列表里。
- 想知道「齐了没有」, 只能逐个点开私窗, 或者去日程视图看 `jobRow`。可 `jobRow` 只有成员名 + 忙闲灯 + 任务首行 90 字, **没有「已回执 / 还在跑 / 卡住」**: `JobMember` 只记了 `target/task/spawned/at`。
- 回执的序号守护进程**其实知道**: `daemon/receipts.ts` 的 `ReceiptMeta.done/total`。但 `TurnFrom` 只存了 `receipt: true`, 序号没落盘, 页面拿不到。
- 关系图上 7 条 `evolve → ev-*` 边各带 `jobs:["J04a4f2"]`, 可工单号只出现在悬停提示里, 没法按工单筛选或高亮。
- `/api/world` 回包 105KB, `jobs` 11 条, 包括别的聊天里的工单 (如 `Je62e13`, 成员任务全文好几段)。前端每 6s 拉一次, 再在客户端按 role 过滤。

---

## 3. 改进清单 (按 收益/成本 排序)

成本: **S** ≈ 半天内, 纯前端或加一个字段 · **M** ≈ 1–2 天, 跨 daemon/view/前端 · **L** ≈ 要先定设计。

### ① 工单成为一等会话 `j:<jobId>` — 收益 ★★★★★ · 成本 M
- **证据**: §2; 工单散在 chip / 日程 / 关系图三处, 哪处都不能点进去; 侧栏一件事占 N 项。
- **建议**:
  - view 层新增会话 kind `job`: key `j:<id>`, 内容 = `turn.from.job === id` 的全部轮次 (派活入 + 成员出 + 回执) 加上开工/收工两条 post, 按时间排开。实现上就是在 `talkOf` 旁边加一个按 job 过滤, 一个纯函数就够。
  - 侧栏: 同一 job 的私聊项**折成一项** (头像拼成马赛克, 标题 = 工单标题, 副标题 `3/7 回执 · 1 卡住`), 子项 = 成员, 复用现成的 `ConvSub` / 子项画法。
  - 入消息上的 `📋 J…` chip、日程 `jobRow`、关系图边的工单号, 一律能点, 点了打开 `j:<id>`。
- **涉及**: `shared/role-view.ts` (`ConvKind` 加 `job`, `convsOf` 聚合, `talkArgs` 认 `j:`), `shared/chat-http.ts` (`windowFrags` / SSE `pushTurn` 的 inWin 判定), `shared/role-render.ts` (chip 变链接), `web/chat.js` (侧栏 / 头部 / 日程 / 关系图点击)。
- **前提**: 先核实回执轮的 `from.job` 是否总会写上 (`receipts.ts` 的 `Slot.job` 有值, 但要确认 `deliver` 落盘时带进了 `TurnFrom`)。

### ② 第四种忙闲状态: 「卡在审批」 — 收益 ★★★★★ · 成本 S
- **证据**: `stTag` 只有 run / idle / off。daemon 其实已经算出了「停在哪个工具上」: `mirror-bridge.ts:5498` `const waiting = busy ? [] : openToolUses(jsonl)`, 但没有进 `WorldFactWizard`。工单里一个成员停在审批卡上, 页面上和「空闲」长得一模一样, 而人恰恰最该在这时候介入。
- **建议**: `WorldFactWizard` / `RoleStatus` 加 `waiting?: string[]` (工具名)。`stTag` 多一态 `wait` (紫色, 与 `badge.pending` 同色), 文案 `待审批 · Bash`。侧栏 quiet 模式下它**也要亮** (现在 quiet 只亮 run)。
- **涉及**: `daemon/index.ts` (facts provider), `shared/world.ts`, `shared/role-view.ts` (`Directory.status`), `web/chat.js` (`stTag` / `stateOf`), `web/chat.css`。

### ③ 回执看得出来: chip + 序号 — 收益 ★★★★ · 成本 S
- **证据**: 回执轮的出消息在发起者的私窗里, 看上去就是「发起者对成员说了一句话」(`messagesOfTurn` 里 `to = who`), 没有任何标记。
- **建议**: `TurnFrom` 加 `done?/total?`, `deliver` 时从 `ReceiptMeta` 写进去。出消息的 `meta` 行加一枚 `📨 回执 · .ev-ui · J04a4f2 3/7`, 第 7 份写成 `全部到齐`。① 的工单窗里, 回执就是成员那条出消息的「已送达」标记。
- **涉及**: `shared/detail-store.ts` (`TurnFrom`), `daemon/index.ts` (回执 deliver → turn 记录), `shared/role-render.ts`, `shared/detail-render.ts` (meta 行)。

### ④ 全局「要我处理」托盘 — 收益 ★★★★ · 成本 S(只读) / L(可操作)
- **证据**: 待审批只是轮次过程框 (默认折叠) 里的一枚徽章; 坏掉的 gate 只在那个 role 的日程入口上染红。要从 30+ 个 wizard 里找出哪些在等人, 现在没有地方可看。
- **建议**: 页头右侧放一个铃铛 badge, 内容 = 卡在审批的 wizard (②) + `/status.pending` 待审批卡 + gate 出错的定时 + 超时没回执的工单成员。每条都深链到对应的轮次 / 视角。
  - **第一阶段只读**: 审批照旧在企微里点。
  - 要在页面上直接点 ✅/❌, 就得给 svr 加写路由。但现在的票据 = 「任一有效票据看全部 role」(`chat-http.ts` 头注释), 让它带上写权限会把风险面整个放大。必须另发一个短期写票据, 并单独走一次设计评审, 所以记为 L。
- **涉及**: `shared/world.ts` (facts 加 `pendingApprovals`), `shared/chat-http.ts` (`/api/world` 或独立 `/api/inbox`), `web/chat.js`。

### ⑤ 记忆可见 (先只读) — 收益 ★★★★ · 成本 M
- **证据**: 页面上没有任何地方看得到 wizard 的 `memory` (`wizards.json`)、群/工作区共享记忆 (`~/.wezard/memory/{chats,workspaces}/*.md`), 也看不到等着整理者合并的提议 (`memory/inbox`)。人不知道「它记住了什么」, 也就没法纠正。
- **建议**: 名片的关系 / 日程入口旁加「记忆」, 打开一栏分三段: 自己 / 本群 / 本工作区, 外加「待整理 N 条」。第一阶段只读, 每段标出源文件路径 (人可以直接改 md)。在页面上编辑要走写路由, 风险同 ④, 留到以后。
- **涉及**: `shared/world.ts` (facts 加 memory 摘要; 独立 svr 靠 daemon 推送), `daemon/wizard-memory.ts` (读), `shared/chat-http.ts`, `web/chat.js` (新视图, 复用日程视图的 `psec` 版式)。

### ⑥ 关系图按工单筛选 / 高亮 — 收益 ★★★ · 成本 S
- **证据**: 边上已经带着 `jobs[]`, 但只出现在 `tlab` 的悬停提示里。
- **建议**: `wtools` 加一排工单 chip (只列当前时间窗里开过的)。选中一个 → 非成员的节点和边变淡, 成员卡片显示 ②③ 的状态。点工单 chip 的同时, 右栏打开 `j:<id>`。
- **涉及**: `web/chat.js` (`jobEdges` / `treeHTML` / `wtools`), `web/chat.css`。

### ⑦ `/api/world` 瘦身 + 304 — 收益 ★★★ · 成本 S
- **证据**: 105KB × 每 6s; 所有聊天的工单连同成员任务**全文**都在里面, 前端只用任务首行 (`jobRow` 截了 90 字)。
- **建议**: 服务端把 `members[].task` 截到首行 / 120 字, 全文留给 ① 的工单窗按需去取。加 `sig` → `If-None-Match` 返回 304: 名册多数时候没变, 不必每 6s 重传一遍。
- **涉及**: `shared/chat-http.ts` (`world` handler, `recentFacts`), `web/chat.js` (轮询带 etag)。

### ⑧ 「载入更早」改成按游标分页 — 收益 ★★★ · 成本 S
- **证据**: `loadMsgs('0', …)`, 也就是 `limit=0` = 全量。实测 `.evolve` 的群窗 425 条一次 **956KB / 服务端渲染全部片段**, 手机上会卡。
- **建议**: `/api/msgs` 加 `before=<ts>&limit=60`, 按钮每次往前取一页。`keepView()` 锚点逻辑照旧可用。
- **涉及**: `shared/chat-http.ts` (`msgs`), `web/chat.js` (`loadMsgs` / `#more`)。

### ⑨ 群窗降噪开关 — 收益 ★★★ · 成本 S
- **证据**: 人所在的群 249 条 / 14 个子项, wizard 的过程消息和人话混在一起。ping 已经折叠了, 但「只看结论」还做不到。
- **建议**: 头部加两个开关: 「只看人话 + 终句」(过程框整体隐藏, 出消息只留 `final` 那一段) 和「隐藏私聊回执」。状态存 URL 或 localStorage。
- **涉及**: `web/chat.js`, `web/chat.css` (纯前端, `.steps` 已经有 folded 态)。

### ⑩ 触屏与暗色 — 收益 ★★ · 成本 S–M
- **证据**:
  - 很多信息只在悬停时出现: 截断全文 (`clipTip` 挂在 mouseover 上)、关系图入口的副标题、边上的工单号、日程刻度。触屏上全都拿不到。
  - `chat.css` / `detail-render.ts` 里 `prefers-color-scheme` 出现 0 次。
  - 关系树在 760px 以下是否能横向滚动, 没能在真机上验证 (浏览器扩展没连上)。
- **建议**: 悬停信息改成「长按 / 点 ⓘ 展开」的统一 popover。颜色先收成 `:root` token, 再补暗色 (detail-render 的内联 CSS 也要一起改)。
- **涉及**: `web/chat.css`, `shared/detail-render.ts` (内联样式), `web/chat.js`。

### ⑪ 人的「指挥台」落点 — 收益 ★★★ · 成本 M
- **证据**: 票据默认落在某个 wizard 的视角上 (`landingOf`)。人想先看「现在谁在干什么」, 得去关系图一层层展开。没有一张 roster 表 (名字 / 忙闲 / 当前工单 / 最后一句 / 上下文用量), 而 `wizard_roster` 给模型的正是这张表。
- **建议**: 人的视角 (`human:<id>`) 默认打开一张「指挥台」: 上面是 ④ 的待办托盘, 中间是**开着的工单卡片** (每张一条进度条), 下面是活着的 wizard 表格, 按「卡住 > 执行中 > 空闲」排序。每行点进去就是 `switchRole`。
- **涉及**: `shared/role-view.ts` (纯函数汇总), `web/chat.js` (新视图; 数据全来自 `/api/world`)。

---

## 4. 若「编排表达式 / 工单」成为一等对象, rolepage 怎么呈现

前提假设 (与 `.ev-lisp` 的原语代数对齐): 一次编排 = 一个可求值的表达式, 例如
`(job "调研" (par (tell ev-claw …) (tell ev-mem …)) (then close))`,
`run_agent_graph` 是 `(loop n (seq a b c) :until …)`。
页面上的原则: **表达式是数据, 页面画的是它求值的轨迹**。

1. **对象**: `Plan { id, expr(AST), owner, status, nodes: [{path, wizard, state, turnIds, receipt}] }`。工单是 `par` 的特例, graph run 是 `loop/seq` 的特例。两者共用一个渲染器, 不再一个进日程、一个只有消息 chip (`🕸 轮 r/R · 步 s/S`)。
2. **三种视图, 同一份数据**:
   - **树 (结构)**: 把 AST 缩进画出来 (`par` 并排, `seq` 竖排), 每个叶子 (一次 tell) 是一张成员卡, 挂 ②③ 的状态。人一眼看出「这件事的形状」。
   - **泳道 (时间)**: 每个成员一行, x 轴是时间, 条 = 它跑的轮次, 点 = 回执, 竖线 = 收工。fan-out 能不能一眼看完, 就靠这张图。
   - **对话 (内容)**: 即 ① 的 `j:<id>` 会话窗, 按时间排开。
3. **入口**: 侧栏顶部「进行中」分组 (开着的 Plan 排在所有会话之前)。关系图上一条带工单的边, 点了打开这个 Plan。日程视图里只留「定时」(往后看), 工单移出去。
4. **操纵 (第二阶段, 依赖写票据)**: 在 Plan 视图上 **打断某个成员** (`stop_wizard`)、**重派** (对某个叶子重新求值)、**收工** (`close_job`)。对应的都是现成的 MCP 原语, 页面只是另一个调用方, 不另造控制流。这正符合 `jobs.ts` 头注释的精神: 控制流留在发起者那里, 页面只是视图加一个按钮。
5. **存储**: 表达式和节点状态要落盘才能重画。`jobs.json` 加 `expr` 和每个成员的 `state/receiptAt`; graph run 现在只在内存 (reload 即丢), 要成为一等对象就得同样写进 ledger。这一步是 L, 但没有它, 「编排可视化」只能看活着的那一次运行。

---

## 5. 建议的落地顺序

| 批次 | 内容 | 合计成本 | 解锁 |
|---|---|---|---|
| 1 | ② 卡在审批 · ③ 回执 chip+序号 · ⑦ world 瘦身 · ⑧ 游标分页 | 4×S | 状态可信, 大群不卡 |
| 2 | ① 工单会话 · ⑥ 关系图工单筛选 · ④ 只读托盘 | M + 2×S | **fan-out 一眼看完** |
| 3 | ⑪ 指挥台 · ⑤ 记忆只读 · ⑨ 降噪 | 2×M + S | 人有一个「先看哪」的落点 |
| 4 | §4 Plan 对象 + 泳道 · ④/⑤ 写操作 (写票据) | L | 在页面上操纵 |
| 随时 | ⑩ 触屏 / 暗色 | S–M | 手机上能用 |

## 6. 与现有局部 wizard 的边界

- ② 动到 `.busytag` 的组件 (`stTag`), ⑨ 动到 `.collapsetool` / `.pingfold` 的折叠, ① 的侧栏折叠项动到 `.sidebarsubitem` / `.unread` (未读水位要按 job 再算一份), ⑥ 动到 `.graph`, ⑧ 动到 `.loadmore`。派活时应该让这些 wizard 认领, 而不是新生一个。
- ③④ 的数据侧 (回执序号落盘、pending 汇总) 与 `.receiptmiss` 排查的链路是同一条, 建议一起做。
