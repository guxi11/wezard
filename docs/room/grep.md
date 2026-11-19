# room 模型 · 旧名字/旧概念 grep 清单

只读调研，未改任何文件。依据：`docs/room/contract.md` §3。
检索词（大小写不敏感，含中文）：tell_peer · read_chat · chat_members · list_chats · wait_peer · topOnly / top-only · 顶层模式 · chatPolicy · speech · strict / implicit / 严格模式 / /strict / /owed · priority · public · fyi · return · NEED: · PROGRESS: · RESULT:
处置三种：**删** · **改写**（附一句新写法）· **保留**（附理由）。

---

## 1. 仓库 /Users/zyy/develop/Guxi11/cc-wecom-room 的非代码

### 1.1 CLAUDE.md（架构主文档，9 处；全部要改写）

| 文件:行 | 命中片段 | 处置 |
|---|---|---|
| CLAUDE.md:10 | `the wizard's whole tool surface ... (`tell_peer`, `peek_peer`, `read_chat`, `spawn_wizard`…)` | 改写：工具面改成 room 组（chat_say/chat_ask/chat_reply/notify/send_file + room_*）+ wizard 管理组 |
| CLAUDE.md:58 | `Read-side tools (`wizard_roster` / `peek_peer` / `read_chat`) answer in plain text` | 改写：`read_chat` → `room_read`，读的是 room 账本 |
| CLAUDE.md:61 | `**Chats are public channels, wizard↔wizard is private by default.** `tell_peer` injects with `channel:""` ... `public:true` ... `chatPolicy.<chat>.topOnly`` | 删整段「public / topOnly / 公开频道」：room 模型里可见性由 room 成员决定 |
| CLAUDE.md:62 | `**`tell_peer` delivery policy** (`priority`) ... normal / urgent / now` | 删：priority 参数没了；投递策略归 room/wake |
| CLAUDE.md:63 | ``return` selects route behavior (`self` … `fyi` … `none` / `detach` / `transfer`) … `NO_DEADLINE`` | 改写：改成 room 消息 + chat_reply status；删 return/fyi 路由语义 |
| CLAUDE.md:83 | ``daemon/plans.ts` owns the stricter fsync journal` | 保留：英文 stricter 与本次概念无关 |
| CLAUDE.md:90 | `**不加 `--strict-mcp-config`** 否则会连用户自己的 MCP 一起挡掉` | 保留：CLI 参数，不是治理模式 |
| CLAUDE.md:93 | `collaboration tools (... `read_chat`, plus `peek_peer` / `tell_peer` / `wait_peer` ...) all send `selfRef()`` | 改写：清掉 read_chat / tell_peer / wait_peer，补 room_* 与 chat_* |
| CLAUDE.md:102 | ``--max-time` ... must be **strictly larger** than `approval.longPollSec`` | 保留：英文 strictly，无关 |

### 1.2 README.md（用户文档，13 处）

| 文件:行 | 命中片段 | 处置 |
|---|---|---|
| README.md:29 | `派完就放手 — ... 对方反问（`NEED:`）就接着答，闲着不交差会被追问一句` | 改写：改成「对方用 chat_reply 回，status 标 need 就是反问」 |
| README.md:30 | `🔝 **顶层模式** — 开了之后群里只有管家和你点名的那个说话` | 删：顶层模式不存在；换成「群就是一个 room，成员都看得见」 |
| README.md:35 | `「把这个群改成顶层模式」「hard 档换成 opus·max」` | 改写：示例换成「把 X 拉进这个 room」「hard 档换成 opus·max」 |
| README.md:155 | `读、搜、跑命令每轮最多 4 次（`chatPolicy.<群>.stewardBudget`）` | 保留：管家手闸与 stewardBudget 不在删除清单 |
| README.md:157 | `**转交默认是公开的，但顶层模式默认开着**：... `chatPolicy.<群>.topOnly = false` ...` | 删整段：转交=在 room 里派活，无「公开/私聊」开关 |
| README.md:159 | `**顶层模式**（**默认开**）... 你在这个群里只和**顶层 wizard** 打交道` | 删整段；若要保留管家收口，改写成「群里的 wizard 都在同一 room，结论谁都可以回」 |
| README.md:183 | `\| 这个群关掉顶层模式（默认是开的） \| 关顶层模式，wizard 之间的往来回到群里可见 \|` | 删该表行 |
| README.md:189 | `receiver 收到 `NEED:` 后用显式 `re` 继续同一件 ... 对方正忙时默认等它这一轮结束再投` | 改写：「对方 chat_reply 带 status:need 时按同一 room 续派；投递由 room 事件排队」 |
| README.md:197 | `当前工具与地址只使用现行名称：`delegate`、`tell_peer`、`handoff`` | 改写：现行名称改成 `delegate`、`chat_say`/`chat_ask`/`chat_reply`、`handoff` |
| README.md:225 | ``kind` 表示消息意图；route 是否创建及其 receiver 由 `return` 决定` | 改写：删 kind/return，改为「room 账本里 msg 行 + chat_reply.status 定终态」 |
| README.md:297 | `\| 这个群关掉顶层模式 \| 写 `chatPolicy.<群>.topOnly = false`，即时生效 \|` | 删该表行；同表可换成 `room_leave` / `room_invite` 用法 |
| README.md:303 | `改动若影响到 wizard 的宪章（比如顶层模式开关），受影响的 wizard 会在下一条消息里收到「交接一下才按新规矩办」` | 改写：例子换成 room 成员/配置变化，机制保留（宪章重武装） |
| README.md:404 | `...顶层模式、rolepage、缓存冷热判定...`（目录/索引行） | 改写：删「顶层模式」，补 room 模型一节 |

### 1.3 docs/（当前设计文档 → 改写；docs/evolve 历史 → 保留）

| 文件:行 | 命中片段 | 处置 |
|---|---|---|
| docs/v3-design.md:25 | `**其余显示面**: read_chat 纯文本 `.a: .b` ...` | 改写：`room_read` |
| docs/v3-design.md:29 | `公开 peer 轮 `🧙‍♂️ me： 🧙‍♂️ you`` | 改写：room 内都是公开轮，删「公开/私聊」二分 |
| docs/v3-design.md:43 | `\| daemon/peers.ts / role-render.ts / web/chat.js \| read_chat、rolepage 渲染跟进 \|` | 改写：`room_read`、rolepage |
| docs/v3-design.md:48 | `受影响路径: quote 路由、read_chat 比对（`canonContains`）` | 改写：`room_read` 比对 |
| docs/v3-design.md:64 | `\| 解析 · 回执署名 \| @接收者 RESULT \| **新写法裸 `@name RESULT:`** ...` | 删：终句不再有路由语义 |
| docs/v3-design.md:66 | `\| 系统面 · read_chat \| 聊天流纯文本 ...` | 改写：`room_read` |
| docs/v3-design.md:81 | `charter `renderStewardRules`, topOnly 默认开时配 steward 手刹` | 改写：手刹保留，删 topOnly 条件 |
| docs/v3-design.md:155 | `无 bot 级接待层; topOnly 默认开把群内交互压到管家一层` | 改写：删 topOnly 半句 |
| docs/v3-design.md:203 | `学徒**代表人** → 读面全量 (roster/read_chat 与全局管家同级)` | 改写：`room_members` / `room_read` |
| docs/v3-design.md:220 | `③ 行首 `.name` 与 `🧙‍♂️ name` 双寻址; ④ pars...` | 保留：地址表示层，未被 room 模型删除（仅确认） |
| docs/probe-steward.mjs:25 | `for (const k of Object.keys(cfg.chatPolicy ?? {})) bases.add(k)` | 保留（代码）：探测脚本；chatPolicy 键若删需同步，交 lead |
| docs/evolve/v3-p7-retirement-candidates.md:3-70（32 处） | `implicit 模式退役之前… strict 取代它… /strict --all …` | 保留（历史）：整篇是 P7 退役计划，room 切换后自然作废，可在文件头加一行「已随 room 模型废弃」 |
| docs/evolve/pyramid-jobs.md:27,29,74,104,105（5） | `只许 `ask` / `fyi` ... 只能 `read_chat` / `peek_peer` ... 顶层模式` | 保留（历史）：旧编排提案，不追改 |
| docs/evolve/receipt-router.md:16,18,51,63（4） | `route 创建及 receiver 由 `return` 决定 ... `@.name RESULT:`` | 保留（历史）：receipt-router 方案档案 |
| docs/evolve/b2-reply-routing.md:3 | `当前结果按 route event 与显式 `@.name RESULT:` 绑定` | 保留（历史） |
| docs/evolve/README.md（13） | `说 (`tell_peer`) / 看 (`peek_peer` `read_chat`) ... `wait_peer` = 同步 join` | 保留（历史调研） |
| docs/evolve/research/inventory.md（32） | `\| 1 \| tell_peer \| 往另一个 wizard 输入框说一句…` 等调用频次表 | 保留（历史调研数据） |
| docs/evolve/research/a2a-frameworks.md（22） | `每次 tell_peer 一个 turn id ... `NEED:` 收口 = needs-input` | 保留（历史调研） |
| docs/evolve/research/primitives-lisp.md（9） | `\| `tell_peer` \| `send/k` \| **原语入口**, 保留 \|` | 保留（历史调研） |
| docs/evolve/research/memory.md（4） / openclaw-dsh.md（6） / ui.md（1） | `peek_peer / read_chat / route_candidates` | 保留（历史调研） |
| docs/evolve/roadmap.md:31-35（5） | `显式 `@.name RESULT:` ... tell_peer `priority`` | 保留（历史进度表） |

### 1.4 commands/ 与 .claude-plugin/

| 文件:行 | 命中片段 | 处置 |
|---|---|---|
| commands/audit.md, commands/update.md | 无命中 | —— |
| .claude-plugin/plugin.json, marketplace.json | 无命中 | —— |

### 1.5 仓库根其他非代码文档（不在指定范围，补录）

| 文件:行 | 命中片段 | 处置 |
|---|---|---|
| AGENTS.md | 无命中 | —— |
| CODEBUDDY.md:10,58,61,62,63,83,90,93,102 | 与 CLAUDE.md 同文（镜像） | 改写：跟随 CLAUDE.md 一起改 |
| 技术说明.md:3 | `...wizard 之间如何编排与收回执、顶层模式管住了什么...` | 改写：删「顶层模式」，换 room 模型 |
| 技术说明.md:271 | `以管家的名义 `tell_peer` 投出去` | 改写：`chat_say` 到 room |
| 技术说明.md:293 | `exist --> tell["以管家名义 tell_peer<br/>(默认公开, 顶层模式下私聊)"]` | 改写：删括号内说明 |
| 技术说明.md:313 | `任何 `tell_peer` 派新活（`kind:"task"`、不带 `re`、`priority` 不是 `now`）` | 改写：冷门控条件按新工具重述 |
| 技术说明.md:329 | `**手闸**（`steward-guard.ts`）...` | 保留：手闸机制不在删除清单 |
| 技术说明.md:392 | ``kind` 表示消息意图；route 创建和 receiver 由 `return` 决定...` | 删：return/kind 路由语义 |
| 技术说明.md:399,401 | `A->>D: tell_peer(kind=task)` / `D->>B: 按 priority 注入` | 改写：时序图换成 room 账本投递 |
| 技术说明.md:460 | `图 13｜同一次 tell_peer 的两种走向` | 删/改写 |
| 技术说明.md:464 | `a[".a 调 tell_peer"] --> pub{"public?"}` | 删：public 分支不存在 |
| 技术说明.md:474 | `要不要公开由发话的 wizard 自己判断（`tell_peer` 的描述里写着...`public`）` | 删 |
| 技术说明.md:487 | `### 顶层模式：人只和顶层 wizard 说话` | 删整节 |
| 技术说明.md:489 | `**默认就开**（`chatPolicy.<base principal>.topOnly` 不写 = 开...` | 删 |
| 技术说明.md:491-498 | topOnly 开关对照表 / 宪章多一节 / 配置键只认确定聊天 id | 删 491-496；498 的「管家宪章带一行顶层模式」删 |
| 技术说明.md:500 | `提醒机器 (`top-only-nudge.ts`) 与那组配置一并删掉` | 保留（历史叙述）或整段删 |
| 技术说明.md:539 | `config_get({path?}) ...` | 保留：配置机制无关 |
| 技术说明.md:548 | `模型档位、`chatPolicy.*`、mirror 的各项开关…` | 保留：chatPolicy 表本身保留（只删 topOnly/speech 键） |
| 技术说明.md:562 | `不用 `--strict-mcp-config`` | 保留：CLI 参数 |
| 技术说明.md:570 | `路由 `route_candidates` / `delegate` 与 `tell_peer` 冷门控` | 改写：换新工具名 |
| 审批配置.md:127 | `**管家手闸**（`daemon/steward-guard.ts`）...` | 保留：手闸不在删除清单 |

**本节命中数：CLAUDE.md 9 · README 13 · docs/v3-design 10 · docs/evolve 约 132（全部历史档案） · 技术说明 17 · CODEBUDDY 9 · 审批配置 1。**

---

## 2. /Users/zyy/develop/Guxi11/aiconfig（rules/ 与其余 md）

| 文件:行 | 命中片段 | 处置 |
|---|---|---|
| aiconfig/rules/chat.md | 无命中 | —— |
| aiconfig/rules/code.md:18 | `confirm no implicit dependencies (reflection, dynamic dispatch...)` | 保留：英文 implicit 与治理模式无关 |
| aiconfig/skills/** | 仅 `priority` / `strict` / `implicit` / `Need` 等英文通用词（learn-codebase、design-doc-mermaid、skill-creator、openai-docs 等） | 保留：全部误命中，与 wezard 无关 |

**本节相关命中 0（其余 40+ 行是英文通用词的误命中）。**

---

## 3. ~/.wezard/memory、templates、tasks、config.jsonc

| 文件:行 | 命中片段 | 处置 |
|---|---|---|
| ~/.wezard/memory/chats/chat_wrkSFfCgAARRjbH-nA8y9h6gJT63pRIg.md:3 | `... 同伴派发的轮次还会被 topOnly 判为「不对人说话」，chat_reply 义务无法销账` | 改写：「非成员在 room 里不能发言，需 room_invite」；删 topOnly 说法 |
| ~/.wezard/memory/workspaces/-Users-zyy-develop-Tencent-aiservice-daily-eng-case-triage.md:14 | `终句正文别写 `@name RESULT:` —— 信封解析器会把正文里的 @name 当收件人抓走` | 改写：「终句无路由语义，完成只认 chat_reply 的 status」 |
| ~/.wezard/memory/workspaces/-Users-zyy-develop-Guxi11-cc-wecom.md:10 | `严格治理(P7): 存量群全 implicit, 转 strict 须人 /strict apply; 单聊永远 implicit...` | 删：P7 治理整段作废；保留 sparePool 一句 |
| ~/.wezard/memory/workspaces/-Users-zyy-develop-Guxi11-cc-wecom.md:11 | `strict 义务链(2026-11-18...): 催答/补发指令直投本群管家 ... re 豁免 topOnly ... chat_members` | 改写：义务模型按 room 重述；`chat_members`→`room_members`；删 topOnly |
| ~/.wezard/memory/workspaces/-Users-zyy-develop-Guxi11-cc-wecom.md:12 | `strict 出站不挂义务... 成员发言即放行 chat_say/chat_reply/notify/send_file ... topOnly 含 chat_reply` | 改写：room 内成员即可发言；额度与「一次到位」保留 |
| ~/.wezard/memory/episodes/*.jsonl、memory/log/*.jsonl | 大量 `strict` / `tell_peer` / `return:"transfer"` | 保留：append-only 历史日志，不回写 |
| ~/.wezard/templates/ | 空目录，无文件 | —— |
| ~/.wezard/tasks/memory-steward.task.mjs.retired:52 | `全部处理完用一行 RESULT: 汇报每份记忆...` | 保留：已 retired |
| ~/.wezard/tasks/review-summary-nightly-2.task.mjs:39 | prompt 内编排步骤（含旧工具名待核） | 改写：检查 prompt 并把 tell_peer/RESULT 换成 chat_say/chat_reply |
| ~/.wezard/tasks/rr-quiet-2a5e14.task.mjs、refresh-cookies.task.mjs | 无相关命中 | —— |
| ~/.wezard/config.jsonc:171 | `// ... topOnly: 顶层模式, wizard↔wizard 全部私聊, 不冒泡。` | 删注释 |
| ~/.wezard/config.jsonc:174,177,181 | `"topOnly": true` | 删键（迁移脚本统一清） |
| ~/.wezard/config.jsonc:178,184,187,190 | `"speech": "strict"` | 删键 |
| ~/.wezard/config.jsonc:193,196 | `"steward": "study"` | 保留：steward 绑定不在删除清单 |

**本节命中数：memory md 5 行（3 个文件） · config.jsonc 8 行 · tasks 1 行。**

---

## 4. ~/.wezard/wizards.json 各 wizard 的 self 记忆

全部为 chat/user 级记忆的副本，按 key 计 **19 个身份、45 条命中**。内容只有 5 种模板：

| key（wizard/chat） | 条数 |
|---|---|
| chat:wrkSFfCgAAA-A31cTLDg3D1LpN4-gnEw | 2 |
| chat:wrkSFfCgAAAZt62Wkdu9sMwbr22i9RtA | 2 |
| chat:wrkSFfCgAAJPakmle_-POOqbXefXVWDA | 2 |
| chat:wrkSFfCgAATRPyryDI65IHon3LysQwXg | 2 |
| user:T03880027A | 2 |
| chat:wrkSFfCgAAkxj5kEdjOzEidYcbhwth5Q | 2 |
| chat:wrkSFfCgAADY8OC-LeSGiR1NMLGmjKAw | 2 |
| chat:wrkSFfCgAAdLK9MhQ-8Zj94iF4_sqphg#review-1029 | 1 |
| chat:opkSFfCgAAVRnKfGju403GbTZctB4n3w | 2 |
| chat:CiCMd9om566YLDwXqJ7FSwUrZA5JXvpTO27J5XUrYYnm6xAB | 2 |
| chat:opkSFfCgAA2Au9xxHemevRdydjKENNCQ | 2 |
| chat:opkSFfCgAAxZzesrg9gdLNTlwRm2FVsQ | 2 |
| chat:opkSFfCgAAW0TAn23Dibo1eO0zCU9pYg | 2 |
| chat:wrkSFfCgAAX-67zPltdlSurAS-p2QTmA | 2 |
| user:T03880027A#v3p7 | 12 |
| chat:wrkSFfCgAAMt_tGS90h45SfmSH9mShnQ#wezard | 2 |
| chat:wrkSFfCgAARRjbH-nA8y9h6gJT63pRIg#GraceVance | 1 |
| chat:wrkSFfCgAAdLK9MhQ-8Zj94iF4_sqphg#review-1118 | 1 |
| chat:wrkSFfCgAAQFUCEo9NoQs9E1Zz7CBg3w#wezard-15 | 2 |

前 30 条片段（去重后其实只有 5 句，重复的以「×N」标）：

| # | 片段 | 处置 |
|---|---|---|
| 1 | 对人说话的终句不要带 RESULT:/NEED: 前缀 —— 那是回执语义标记，会原样漏进聊天气泡（×15） | 改写：终句无任何路由语义，删「回执标记」说法 |
| 2 | 技术取舍不归管家裁决……把人的原话转回原执行者（tell_peer re），让它自己继续、自己向人收口（×15） | 改写：tell_peer re → 在 room 里 chat_say/@ 该实例继续 |
| 3 | wezard 回执轮终句必须以行首 `.收件人 RESULT:` 收口；写成普通 prose 会导致 resultRoutes={}（×1，GraceVance） | 删：不认行首收件人 |
| 4 | ledger resume 死循环的正解：终句行首直接写 RESULT: 结论（不带收件人前缀）……先 tell_peer 给同链存活上级（×1，review-1118） | 改写：改用 chat_reply status 落定，删 RESULT/tell_peer |
| 5 | .review-1029 的 route e242a15.1 已办结……收到 resume 固定只回一行 `@.auto-task-revi-14 RESULT: 已办结`（×1） | 改写：把该句换成正面的 chat_reply 文本，删 route/RESULT |
| 6 | S2 已放行……read_chat({role:"wezard"}) 可读全文……按群开严格模式（×1 v3p7） | 改写：`room_read({room})`；删严格模式口径 |
| 7 | S2 已交付……9 条验收数字全有夹具（tests/strict-*）（×1） | 保留（历史交付记录） |
| 8 | S3 已放行……① 新群默认 strict……③ 频道 strict 终句……④ read_chat strict 群改读 chat-records（×1） | 保留（历史） |
| 9 | S3 范围……read_chat strict 群改读 chat-records……owed/passed/overdue（×1） | 保留（历史） |
| 10 | S3 验收数字① 新建聊天首条 100% strict……③ strict 群 read_chat 与 chat-records 一致（×1） | 保留（历史） |
| 11 | S3 已交付（两版本，各 ×1） | 保留（历史） |
| 12 | S3 已上线 21:18……known-chats.json 42 legacy/0 fresh……（×1） | 保留（历史） |
| 13 | P7 全部收口……不执行 /strict apply、不动 sparePool.maxTotal=4（×1） | 保留（历史） |
| 14 | S3b 已上线……strict 群 turn 出气泡压制（×1） | 保留（历史） |
| 15 | S3c 已上线……strict 群入消息正文=账本原文（×1） | 保留（历史） |
| 16 | S3c 已验收……人在真 strict 群 aiconfig 发话（×1） | 保留（历史） |
| 17-30 | 上面 1/2 两条模板在其余 chat key 上的重复（×13） | 改写：同 1、2 |

**结论：需改写 3 类模板（1/2/5/6 句），其余为历史交付记录可留。**

---

## 5. 各 CLI 项目记忆（只列文件:行）

| 文件:行 | 处置 |
|---|---|
| ~/.codebuddy/projects/Users-zyy-develop-Tencent-wwmngnjlogic/memory/MEMORY.md:4 | 删：wait_peer/fyi 已不存在 |
| 同上/memory/self_receipt_delivery.md:3,7,9,11 | 删：整篇讲 tell_peer(fyi) 直投 |
| ~/.codebuddy/projects/.../aiservice-daily-eng-case-triage/memory/reference_wezard_wait_peer.md:2,3,7,10 | 删：wait_peer 已删 |
| 同上/memory/MEMORY.md:24 | 删：索引行同步删 |
| 同上/memory/feedback_result_recipient_check.md:13,17 | 改写：@.name RESULT 排障 → chat_reply status 排障 |
| 同上/memory/feedback_wezard_peer_prompt_serial.md:13 | 改写：wait_peer → room 事件顺序 |
| 同上/memory/feedback_ledger_resume_loop.md:16,23,29,36 | 改写：删 tell_peer / RESULT: 说法 |
| 同上/memory/project_spawn_pane_no_boot.md:3,9,11 | 保留：spawn 首轮问题与工具名无关 |
| ~/.codebuddy/projects/.../daily-eng-case-triage-ServiceAIDomain/memory/project_wezard_fanout_pitfall.md:8 | 保留（fanout 机制） |
| ~/.codebuddy/projects/.../Guxi11-cc-wecom/memory/project_chat_name_recycling.md:2,3,7,11 | 改写：read_chat → room_read；名字复用问题保留 |
| 同上/memory/MEMORY.md:19,22,28 | 改写：三行索引同步 |
| 同上/memory/project_human_msg_queue_priority.md:9 | 保留：讲 message-events priority，与 tell_peer 的 priority 参数无关 |
| 同上/memory/project_regress_resident_contract.md:13 | 保留：接口字段快照（若 /peers/tell 删除需同步，交 lead） |
| 同上/memory/project_strict_send_file_delivery.md:2,3,7,9,10 | 删：strict/topOnly 口径作废 |
| 同上/memory/reference_lisct_conventions.md:9 | 保留：lisct 自己的「顶层模式」命名，与 wezard 无关 |
| ~/.claude-internal/projects/.../daily-eng-case-triage/memory/*.md（8 行） | 保留：attribution-priority 等业务词，误命中 |
| ~/.codebuddy/projects/.../weclaw/memory/*.md（strict JSON / priority 等） | 保留：误命中 |

---

## 6. 仓库代码里对模型说话的字符串（只列，处置统一为「代码改动由 lead 负责」）

按文件命中数：

```
daemon/index.ts 173 · daemon/wizard.ts 43 · mcp/tools.ts 42 · daemon/mirror-bridge.ts 37
daemon/peers.ts 28 · daemon/strict-switch.ts 27 · daemon/inbound.ts 19 · daemon/channel.ts 19
daemon/chat-seen.ts 18 · shared/role-view.ts 17 · daemon/onboarding.ts 17 · daemon/router.ts 16
daemon/idle-nudge.ts 14 · daemon/chat-name.ts 11 · shared/session-label.ts 10 · shared/chat-http.ts 10
daemon/message-events.ts 9 · shared/tool-hints.ts 8 · shared/detail-render.ts 8 · daemon/config-api.ts 8
shared/reminder.ts 7 · shared/plan.ts 7 · daemon/strict-gate.ts 6 · daemon/approval.ts 6 · shared/config.ts 5
（daemon/index.ts 的 173 多为路由注册与 /peers/tell 等路径字面量，非文案）
```

典型「面向模型」的字符串（mcp 描述 / 宪章 / 提醒 / 错误文案）：

| 文件:行 | 命中片段 | 处置 |
|---|---|---|
| mcp/tools.ts:121,148,150,155,164,166 | tell_peer 的 `return` / `kind`(task·ask·fyi) / `priority` / PROGRESS: 描述 | 代码改动由 lead 负责（整段工具定义重写为 chat_* + room_*） |
| mcp/tools.ts:445,454,474,487,498,505,513,523,527,530,542,559,579-593,628-634,650 | chat_members / list_chats / read_chat / tell_peer / wait_peer 工具与描述 | 代码改动由 lead 负责 |
| mcp/tools.ts:284 | `要么由 tell_peer + 回执覆盖。路由都还在; WEZARD_MCP_EXTRA=1` | 代码改动由 lead 负责 |
| mcp/tools.ts:851,893,910,926 | delegate / spawn / clone / pending_items 描述里引用 tell_peer / wait_peer | 代码改动由 lead 负责 |
| shared/tool-hints.ts:5,43,96,129,138,139,159,180 | `HINT_TOOL` 正则里列 tell_peer 等旧工具名 | 代码改动由 lead 负责（正则清单换代） |
| shared/reminder.ts:37,41,76,176,183,185,186,191,200,212 | 信封 kind/from/scope、`fyi`、`RESULT:` 终句、read_chat 归档注释 | 代码改动由 lead 负责 |
| daemon/wizard.ts:610,637,639,683,966,989,995,996,997,1028,1029,1044,1050,1052,1054,1065,1072,1116,1134-1145,1160,1161,1164,1169,1173,1174,1178,1181 | 宪章全文：tell_peer/read_chat/wait_peer、topOnly 节、`行首 .name RESULT:`、priority | 代码改动由 lead 负责（renderCharter 整章重写） |
| daemon/notices.ts:214 | 「这几列只在点名 `to` / tell_peer 时要看」 | 代码改动由 lead 负责 |
| daemon/idle-nudge.ts:92,93 | 催答/追问文案（旧回执语义） | 代码改动由 lead 负责 |
| daemon/handoff.ts:239,241,289 | 「只有显式 `RESULT:` / `NEED:` 才算数」、`@receiver RESULT:` 交差提示 | 代码改动由 lead 负责 |
| shared/task-template.ts:1 | `dispatch / tell_peer 的 taskFile+params` | 代码改动由 lead 负责（注释） |
| mcp/output.ts:48 | tell_peer 回包 pick 字段含 priority | 代码改动由 lead 负责 |
| daemon/memory-steward.ts:75,81 | 「一行 RESULT: 汇报」「不要 notify / tell_peer 任何人」 | 代码改动由 lead 负责 |
| daemon/pending-items.ts:8,166,262 | `tell_peer({name, re:true})` 使用指引 | 代码改动由 lead 负责 |
| daemon/route.ts:377,385,474,512 | 冷门控提示「优先 tell_peer re」 | 代码改动由 lead 负责 |
| daemon/strict-switch.ts / strict-gate.ts / chat-seen.ts / channel.ts / onboarding.ts | strict/implicit/speech/topOnly 判定与文案 | 代码改动由 lead 负责（整模块退役） |
| shared/config.ts:… | `ChatPolicy` 的 `topOnly` / `speech` 字段与 describe | 代码改动由 lead 负责 |
| web/chat.js:2 · shared/detail-render.ts:6 · shared/role-render.ts:1 · shared/role-view.ts:17 | rolepage/govbar 里 strict / owed / 顶层模式渲染 | 代码改动由 lead 负责 |

---

## 7. wizard 既有上下文（切换方式与作废范围）

- 每个 wizard 的宪章在 spawn 时由 `renderCharter` 渲染并 park 在 `~/.wezard/state/charters/<sid>.md`；它**不是系统提示**，而是作为第一条注入的 `<system-reminder wezard="charter">` 进入会话。因此旧宪章里的 tell_peer / read_chat / wait_peer / topOnly / 行首 RESULT: 等描述会原样留在**已经跑着的会话**里。
- 切换手段是**强制 `/new`**：`onContextCut` → `armCharter` 会重新武装宪章，新会话读到的是新版 `renderCharter`；`/clear`、compact、死 pane 重生、spare-pool 领取同样重新武装。不 `/new` 的常驻会话必须手工结束（`stop_wizard`）或交接（`handoff`），否则继续按旧口径说话。
- 现有旧宪章文件：**~/.wezard/state/charters/ 下 200 个**（一个会话一份）。切换后这些文件全部作废，不必逐个改；建议切换时整体清空该目录（或让它随会话结束自然失效），避免旧会话被 resume 时复用旧文本。
- 同理：`~/.wezard/state/session-hooks.json` / `session-mcp.json` 是按会话注入的工具面，工具名换代后**新 pane 自动拿新的**，旧 pane 仍挂旧 MCP，需重开。

