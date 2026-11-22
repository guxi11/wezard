# 开发者清单: 三种常见改动要动哪几处

三个问题: 加一个 MCP 工具 / 加一种 room 行类型 (或给行加字段) / 加一种 reminder kind。每条给「文件 + 函数/表名 · 为什么 · 怎么测」。
以现行代码为准, 写于 v3 分支; 机制总览看 [CLAUDE.md](../CLAUDE.md), room 契约看 [docs/room/contract.md](room/contract.md)。

---

## 1. 加一个 MCP 工具

工具面只有一份: [mcp/tools.ts](../mcp/tools.ts) 的 `createWezardServer()`。stdio 与 http 两种传输都调它, 所以**两种传输都不用额外动**。

**要动的**

1. [mcp/tools.ts](../mcp/tools.ts) — 在 `createWezardServer()` 里 `server.registerTool(name, {title, description, inputSchema}, handler)`。
   - handler 一律是「`daemonPost(path, body)` → `unwrap(name, r)`」: 一次 POST, 不持有任何 WeCom 状态。读侧工具回的是 daemon 排好的文本, 用 `unwrapText`。
   - 要用 `z.object(...).strict()` 的写法, 用 `currentAddressSchema({...})`: 退役的 `tag` / `tags` 参数会被当场拒。
   - **`selfRef()` 不用自己调**: `daemonPost` 已把 `{sessionId, tmuxPane}` 摊进每个 POST 体。只有 `daemonGet` 不带, 所以要知道「谁在问」的工具必须走 POST。身份来源: stdio 读 env, http 读 `mcpIdentity` (`daemon/mcp-http.ts` 的 `identityOf` 从 `x-wezard-pane` / `x-wezard-session` 头进 ALS)。
   - **罕用工具门**: 想让它默认不占模型上下文就用 `registerRare(...)` 代替 `server.registerTool`, 只有 `WEZARD_MCP_EXTRA=1` 才挂 (现有 `list_claude_sessions` / `switch_claude_session` / `list_chats`)。每个默认注册的工具都吃上下文, 先问自己值不值。
2. [mcp/output.ts](../mcp/output.ts) `present(tool, raw, input)` — `unwrap` 会过它。**它对 `delegate` / `chat_*` / `room_*` / `spawn_wizard` / `clone_wizard` / `wizard_identity` 等按名白名单 `pick` 回包字段**; 新工具不在表里则原样回, 不用改。但如果给已有工具的回包加字段 (如 `roomReply` 的 `closes`), 这里没列就到不了模型。
3. daemon 侧路由, 在 [daemon/index.ts](../daemon/index.ts) 里 `http.register("POST /<域>/<动作>", handler)` — 现有的成块在一起 (`/room/*`、`/wizard/*`、`/tasks/*`、`/config/*`)。成组的路由可以像 `registerPlanRoutes` ([daemon/plan-http.ts](../daemon/plan-http.ts)) 那样拆文件, 再在 index.ts 里挂。
   - 认调用者: `const { self, body } = await readPeerBody(req)` (内部走 `resolveSelf`, 优先 pane id, 因为 sessionId 在 `/clear` 后会过期); `self` 为空就 400。room 类再 `roomSelfOf(self)` 拿 uid。
   - **写敏感状态的路由包 `guarded(...)`** (要 `x-wezard-token`): 现有 `/config/set`、`/tasks/schedule`、`/claim/*`。MCP 两种传输都会带口令, 所以包了也不影响工具; 但裸 curl 就进不来。`POST /mcp` 本身已验口令。
4. [daemon/wizard.ts](../daemon/wizard.ts) `renderCharter` — 在 `## 我能做什么` 那段 `bullet([...])` 里加一行 **「何时用」**。
   - 分工: charter 行回答「什么时候该选它」(Claude Code 把 MCP schema 放在 ToolSearch 后面, 只有 charter 常驻); 工具 `description` 写机制、参数、边界。两处别互相复述。
   - 稀有 / 人侧工具不进 charter (没人该主动想起它)。

**不用动的 (默认已覆盖)**

- 审批: [shared/allow-rules.ts](../shared/allow-rules.ts) `isWezardMcpTool` 对 `mcp__wezard__*` 内置豁免, 不发卡。
- 管家手刹: [daemon/steward-guard.ts](../daemon/steward-guard.ts) 对名字含 `wezard` 的一律 `free`。
- 引导化身: [daemon/onboarding.ts](../daemon/onboarding.ts) `GUIDE_TOOLS` 是白名单 (`chat_reply` / `chat_say` / `onboard_bind`), 新工具**默认被拒**, 符合预期。
- 按会话注入的 MCP 配置 ([shared/session-mcp.ts](../shared/session-mcp.ts)) 不列工具名。

**rolepage 上显示成「提示行」(可选)**: 工具若是「派活 / 发话」性质, 在 [shared/tool-hints.ts](../shared/tool-hints.ts) `HINT_TOOL` 正则加名字, 并在 [shared/detail-render.ts](../shared/detail-render.ts) `hintOf` 的 `switch` 加一支。不加也能用, 只是过程框里是普通工具调用。

**怎么测**

- `npx tsx tests/charter.test.ts` — 只断言 9 个核心工具名出现在 charter 里 (`wizard_roster` / `delegate` / `chat_*` / `room_open|read|watch` / `handoff`); **没有任何测试要求「注册的工具 = charter 里列的工具」**, 漏写 charter 行是静默的, 靠自己核对。
- `npx tsx tests/chat-record.test.ts` 第 4 节的 `toolNames()` 是现成的探针 (`createWezardServer()` + `InMemoryTransport` + `client.listTools()`), 想断言「新工具在清单里 / `registerRare` 的不在」就照抄它。
- `npx tsx tests/tool-hints.test.ts` (改了 `HINT_TOOL` / `hintOf` 时); `npx tsx tests/session-mcp.test.ts` (只测注入配置, 不测工具清单)。
- 路由本身: 起 daemon 后 `curl` 或在真实 pane 里调一次; 带口令的路由先 `cat ~/.wezard/daemon-token` 当 `x-wezard-token`。

**生效方式**: http 传输 (默认 `daemon.mcpTransport:"http"`) 每个请求现建一份注册表, `reload` daemon 后新请求就是新工具面; stdio 的 pane 是长驻子进程, 要开新会话。已在跑的 CLI 对新工具的发现时机由 CLI 自己决定 (多数要新会话或 `/mcp` 重连, 未逐个验证)。

---

## 2. 加一种 room 行类型 (或给行加字段)

账本是 `<stateDir>/rooms/<id>.jsonl`, 一行一个 `RoomOp`, 状态 = fold。**行是 append-only 且要读回旧文件**, 所以一切新增都得向后兼容。

**先选形状, 能不加新类型就别加**

- 一条 daemon 写的「说明性」系统行: 复用 `kind:"system"` + 新的 `sys:"<机器标记>"` (现有 `after-wake` / `overdue-remind` / `overdue-group` / `notice` / `instance-ended` …)。`sys` 只用于去重与机器分流, 不给模型推断。零结构改动。
- 给 `msg` 行加可选字段: 改 `MsgRow` + `Draft` (下面 a)。
- 新 `op` (成员 / 元数据类, 不占 seq): 如 `name` / `notice` / `watch`。
- 新 `MsgKind`: 最重, 见 d。

**a. 类型与 fold — [shared/room.ts](../shared/room.ts)**

- `MsgRow` / 各 `*Op` 接口 + `RoomOp` 联合; 新字段**必须可选** (`?`), 读的地方带缺省。
- `Draft` (append 前的草稿) 加同名可选字段, 并在 `judge()` 里 `draftRow` 那一段显式展开 (`...(d.x ? { x: d.x } : {})`) — 不展开就不会落盘, 这是最常见的漏改。
- `applyOp` 的 `switch (op.op)` **没有 `default`**: 读到不认识的 `op` 会被静默忽略, 所以旧 daemon 读新账本不会炸, 但也读不到新语义。新 op 要在这里加 `case`。
- 会开 / 关 duty 的: 改 `dutiesOpenedBy` (开) 与 `judge` 的 ③ 段 `closes` (关)。duty 不落第二份, 全是 fold 派生。
- **发言权**: `judge` ① 段, `system` / `trigger` 只允许 `isDaemon`; 新的 daemon 专用 kind 要加进那条 403。status 写入权在 ③。
- **唤醒**: `wakeTargets(s, row, ctx)` 的 `switch (row.kind)`, 未列的 kind 走 `default` = 唤醒 `to` 里点名的 wizard (+ 绑定 room 里无人点名的人话 → host)。新 kind 若不该唤醒谁, 要显式加 `case`。预算 (`WAKE_BUDGET`) 在 judge ⑧ 统一扣。
- **镜像进企微**: `mirrors(row)` 的规则是「绑定 room ∧ `msg` ∧ origin 非 inbound/migrate ∧ kind 非 trigger」, **新 `MsgKind` 默认会被镜像出去**。不该进群的得改这条规则 (并更新契约 §3a); 靠字段区分可见性不行 — 契约明说「没有别的例外」。
- 要占 seq 的是 `msg`; `open/name/notice/join/leave/seen/move/watch` 不占。

**b. 唯一追加门 — [daemon/room-hub.ts](../daemon/room-hub.ts)**

- `msg` 行一律 `hub.append(room, draft)` (内部 `judge` → `store.append` → `fanout` → `closedHook` / `reconcileAfter`); `join/leave/move/watch/name/notice/open` 这类结构行走 `hub.write(room, ops)` (不经 judge, 带 canceled 的 leave 仍会扇出)。别绕过它直接调 `RoomStore.append`: 会丢镜像、唤醒、after 对账。
- HTTP 入口在 [daemon/index.ts](../daemon/index.ts) 的 `/room/*` 块: 新字段要在对应 handler 里从 body 读出并放进 `Draft`; 回包形状由 `roomReply` 决定 (回给模型前还要过 `present`, 见 §1)。
- 唤醒泵无队列: 待投递 = 账本里 `wake∋uid` 且 `seq > seen` 的行, 所以**新字段只要在行里就会被重放**, 不用另存状态。

**c. 落盘兼容 — [daemon/rooms.ts](../daemon/rooms.ts)**

- `parseJournal`: 末尾半行丢弃、**中段坏行整个 room 失败 (`RoomBroken` → 503)**。别写会产生非 JSON 行的东西; 新字段值必须是 JSON 可序列化的。
- 旧 jsonl 读得回的前提: 新字段可选 + 读侧带缺省 + 不改既有字段含义。改含义就得写迁移 (`shared/room-migrate.ts` 是一次性的老数据迁移, 不是版本升级机制)。
- 写入 fsync-per-append; `roomsDirOf(stateDir)` 是目录的唯一推导, 不要本地 `join(…, "rooms")`。

**d. 读模型与显示**

- [shared/room.ts](../shared/room.ts) `renderMsgLine`: 注入头 / `room_read` 一行的样子 (只给模型看; 读侧不解析回来当事实)。想让模型看见新字段在这里加。
- [shared/room-view.ts](../shared/room-view.ts): `toRoomMsg` 是**字段白名单**, 线上形状 `RoomMsg` 没有的字段 rolepage 看不到 (`for` / `after` / `planId` / `interrupt` 目前就不在)。要显示就同时改 `RoomMsg` + `toRoomMsg`。`renderRoomRead` 渲染 `room_read`; `buildRoomFact` 出 room 卡; `dutyFacts` 出待办。
- 前端 [web/chat.js](../web/chat.js): `KIND_TAG` (kind → 中文标签, 缺了就没标签) 与 `DUTY_KIND`。路由在 [shared/chat-http.ts](../shared/chat-http.ts) (`/api/room`、`/api/world` …), daemon 与独立 svr 共用; svr 是另一个进程, 通过 POST 收 `WorldFacts` ([shared/world.ts](../shared/world.ts)), 新 room 级字段要进 `WorldFacts` 才到得了 svr。
- 其它按 `kind` / `sys` 扫账本的消费者: [daemon/room-overdue.ts](../daemon/room-overdue.ts)、[daemon/room-watchdog.ts](../daemon/room-watchdog.ts)、[daemon/notices.ts](../daemon/notices.ts) — 新行是否应被它们计入 (逾期 / 活动), 自己 grep 一遍。

**e. 文档**: 行 schema 的真相是代码; [docs/room/contract.md](room/contract.md) §2 是它的人读版, **改了行 schema 就同步** (它目前没列 `interrupt` / `sys`, 见交代里的不一致)。镜像 / 唤醒 / 逾期规则变了同步 §3a / §3b / §4a。

**怎么测**

- 纯逻辑: [tests/room-fixture.ts](../tests/room-fixture.ts) 的 `room()` / `say()` (judge + apply, 被拒直接抛) 搭账本, 再断言 `wakeTargets` / `mirrors` / duty。参考 `tests/room-duty.test.ts` (开关账)、`room-human-duty.test.ts`、`room-id-list.test.ts`、`room-notice.test.ts` (新 op + 读侧 + charter 一整条线)。
- 追加门 + 泵: `tests/room-hub.test.ts`、`room-gone.test.ts`、`room-interrupt.test.ts`、`room-after-wake.test.ts`、`room-leave-cancel.test.ts`。
- 落盘 / 兼容: `tests/room-ledger-dir.test.ts`; 老数据: `tests/room-migrate.test.ts`。
- 读侧: `tests/room-view.test.ts`、`room-view-api.test.ts`、`room-history.test.ts`。
- 前端渲染: `LD_LIBRARY_PATH=$HOME/.cache/wezard-shot-libs/root/usr/lib/x86_64-linux-gnu node tests/room-graph.dom.mjs`, 再 `node scripts/shot.mjs` 截图自己看 (见末节)。

---

## 3. 加一种 reminder kind

reminder = 挂在一句话尾巴上的 `<system-reminder wezard="<kind>" …>…</system-reminder>`。两个读者: 模型读正文; 代码只读开标签上的**属性** (所以改措辞不牵连解析)。全部定义在 [shared/reminder.ts](../shared/reminder.ts)。

**要动的**

1. `REMINDER_KINDS` — 加一行 `kind: { attr: "M" | "C" }`。**属性只写两类**: `M` = 有代码把它读回来; `C` = 模型要原样抄进 `re` / `for` / `drop` 的 id。两者都不是的 (给模型看的语义) 写正文, 不进属性。没属性就写 `{}`。表是 `as const satisfies`, `Kind` / `KindAttrs` 自动派生。
   - 渲染时 `unregisteredAttrs` 会**静默丢掉**没登记的属性 (类型只挡字面量, 挡不住展开进来的)。属性一直不出现先查这里。
2. `TAIL_ORDER` — 若是尾巴上的旁注块, 把名字放进去决定位置 (现序: `envelope, message-event, hint, lead, after, mention, chatlog, roster, pending`; 信封必须打头, `parseEnvelope` 取最后一个信封)。表外的排最后。**preamble 类** (如 `charter`, 只随 pane 首条注入、不在尾巴) 不进 `TAIL_ORDER`。
3. 写入方: `renderReminder({ wezard: "<kind>", … }, lines)` (永远以 `\n` 起头 — 读侧的正则锚行首), 再交给注入口:
   - 人话 / 同伴: 经 `opts.envelope` 或 `renderTail(envelope, …旁注)` ([daemon/mirror-bridge.ts](../daemon/mirror-bridge.ts) `injectText`, [daemon/inbound.ts](../daemon/inbound.ts));
   - 名册类增量: 放进 [daemon/notices.ts](../daemon/notices.ts) 的信箱, 下一次注入随带。
   - `renderTail` 只收**渲染好的块**, 块外的字会被丢, 别喂正文。
4. 读回 (只有被代码读的才需要): `parseEnvelope` 只认 `wezard=envelope` 且 `kind ∈ ENVELOPE_KINDS` (`peer|human|task`)。新的**信封种类**要同时改 `ENVELOPE_KINDS`、`Envelope.kind`、`envelopeOfAttrs`, 以及读它的 [daemon/peers.ts](../daemon/peers.ts) (`talkTurns` / 标记归属) 与 `mirror-bridge.ts` 的 `openingOf` 一带。非信封的旁注块 (hint / roster 一类) **不需要** parse。
5. 读侧 strip / collapse — **通常什么都不用加**:
   - `stripMeta` ([daemon/peers.ts](../daemon/peers.ts) `META_RE`)、`cleanUserText` ([daemon/mirror-bridge.ts](../daemon/mirror-bridge.ts) `META_TAG_RE`)、`stripReminders` (`REMINDER_RE`) 都是按 `<system-reminder>` 标签名通吃, 与 kind 无关。**别另起标签名** — 那才需要改这三处。
   - rolepage: [shared/detail-render.ts](../shared/detail-render.ts) `splitReminders` → `reminderLabel` ([shared/reminder.ts](../shared/reminder.ts)), 默认标签 = kind 名 (`<roster>`); 想要自定义标签 (如 `回执 · x · need`) 或标成机器块 (`machine`, 样式 `.rem-m`) 在 `reminderLabel` 加分支。
   - 若该块会在首条注入前出现并要被识别 (像 charter), 看 [shared/charter-rearm.ts](../shared/charter-rearm.ts) 是怎么用 `parseReminders` 认 `wezard="charter"` 的。

**vm 沙箱测试的坑** (最容易在这里栽)

[tests/pane-delivery.test.ts](../tests/pane-delivery.test.ts) 与 [tests/maintenance-scheduler.test.ts](../tests/maintenance-scheduler.test.ts) 不 import mirror-bridge, 而是 **按字符串锚点从 `daemon/mirror-bridge.ts` 源码里截一段, 转译后在只含显式注入标识符的 `new Function` / `vm.createContext` 里跑**:

| 测试 | 截取区间 (起 → 止锚点) | 注入表 |
| --- | --- | --- |
| pane-delivery (inject) | `const inject = async (` → `// ── Per-session injection queue` | `new Function("withPaneInput","injectViaTmux","injectViaSpawn","backendForPath", …)` |
| pane-delivery (injectText) | `    injectText: async (` → `    interruptPane:` | 测试里的 `env` 对象 (`renderTail` / `envelopeFor` / `noticeSuffixFor` / `charterPrefixOf` …) |
| maintenance-scheduler | `  const maintenance = createKeyedScheduler(4);` → `  const pickerTimer =` | `vm.createContext({...})` |

所以:

- **只要这几段代码里新用到了任何模块级标识符** (新 import、新的模块级函数 / 常量, 不止是 import), 就要同步加进对应注入表, 否则报 `X is not defined`。典型: 在 `injectText` 里调了新的 reminder 渲染函数。c6f3c31 起 `injectText` 用 `envelopeFor`, 0492e38 就是补这个。
- 锚点字符串被改名 / 挪走, 测试会在 `assert(start >= 0 && end > start)` 上直接断。动这些行的缩进或注释时留意。
- 改这几段前后跑: `npx tsx tests/pane-delivery.test.ts && npx tsx tests/maintenance-scheduler.test.ts`。

**怎么测**

- `npx tsx tests/chat-record.test.ts` (第 2 节: `renderTail` 排序、`stripReminders`、`parseEnvelope` 不被旁注干扰、`reminderLabel`) — 加了新块就照 `chatlog` 那段抄断言。
- `npx tsx tests/inject-event-marker.test.ts` (`withMsg` / `envelopeFor` / `carriesMsg`)、`tests/reminder-legacy.test.ts` (老转录里的信封仍读得回, 改 `envelopeOfAttrs` 必跑)。

---

## 通用规矩

- **改 daemon 后**: `npm run build && ./cli/wezard.sh reload && systemctl --user restart wezard-svr.service` (macOS 用 `launchctl kickstart -k "gui/$(id -u)/com.wezard.svr"`)。`reload` 只重启 daemon, 不动 svr; 只改了 rolepage / svr 数据面时 svr 也要重启才生效。先 `npm run typecheck`, 它不含 tests。
- **测试**是单个脚本, 没有 `npm test`: `npx tsx tests/<f>.test.ts` (`.mjs` 用 `node`)。改哪块跑哪块, 并看 [docs/room/test-baseline.md](room/test-baseline.md) 里的基线。
- **改 charter**: 改 `renderCharter` 的代码本身**不会**通知在跑的 wizard — 它们只在 `/new`、`/clear`、压缩、死 pane 重生、spare 池认领时重新读到。但经 `config_set` 改配置、而 charter 里读了该配置时, daemon 会渲染前后两份 charter 并让受影响的 wizard (和调用者) `handoff`。因此动 charter 相关配置要**攒成一批**再改, 别逐项 `config_set` 把全员折腾几遍; 档位行被当作出生快照, 改档位不触发。
- **前端改动** (`web/chat.js` / `web/chat.css` / rolepage 渲染): 改完 build + reload (它截的是正在跑的 daemon) 后 `node scripts/shot.mjs --role <名字>` 截图, 用 `Read` 亲眼看; 窄屏加 `--mobile`; 首次先 `sh scripts/shot-setup.sh`。本机内存小, 截图脚本有单实例锁, 别多个分身同时截。
- **共用工作区提交**: 多个 wizard 共用一个 git index, 提交前用临时 index 只放自己的文件 (`I=$(mktemp); GIT_INDEX_FILE=$I git read-tree HEAD; GIT_INDEX_FILE=$I git add <paths>; GIT_INDEX_FILE=$I git diff --cached --stat; GIT_INDEX_FILE=$I git commit …; git reset -q -- <paths>`)。别用 `git stash`。
- **版本号变更必须同步 [CHANGELOG.md](../CHANGELOG.md)** (见 CLAUDE.md「Release / changelog」)。
