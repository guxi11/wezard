# daemon 接线 · 工作单 (lead 专属: daemon/index.ts 与 mcp/server.ts 只有 lead 改)

基线: room-model @ d486663 = 核心 12e7ef4 + hub 6da4f59 + 迁移 6a6ffd9 + 工具面 d486663; typecheck、build 绿。
下一步 (按合并顺序): 本单做完 → 合 room-ui (711353b) → 改写测试 → CHANGELOG [Unreleased] BREAKING → 检查点 2。
依据: contract.md (§2 / §3 / §3a / §3b / §5 / §7)、cutmap.md (各条带 file:line, 基准 12e7ef4; 合并后行号有漂移, 按函数名找)。

## A. 新增: hub 实例化与 HTTP
1. boot: `openRoomStore(join(home, "rooms"))` + `createRoomHub({...ports})`。ports 的来源:
   - wizardOf(uid) → `wizards.byUid(uid)` → {target, name, parentUid: uidOf(parent 记录)}
   - nameOf / roomLabel: wizard → `.名字`; 人 → humanName; room → 聊天名 (chat-name), dm/adhoc → 成员名拼接
   - idle → `m.idleNow(target)`; interrupt → `bridge.interruptPane(target)` (不传 teardown); paste → `bridge.injectText(target, text, {requireIdle: true})`, 结果映射为 ok / uncertain / failed
   - mirror(row, cover):
     - 有 cover → 先试 `finishPlaceholder(target, cover.ext, md)`, 返回 false 再退回普通发送
     - file 行 → `sendMedia`
     - topic room (chat:<topic>) → `postAsTopic`
     - 其它 → `postAs(作者, room, text)`
     - wx → `wx.sendFinal`
2. 占位气泡 frame 缺口 (cutmap A-4): daemon 侧维护 `msgid → frame` 表 (内存 + state/bubble-frames.json, TTL = bubble.expires), inbound 落人话行时写入。
3. `/room/*` 共 14 条 POST 路由 (brief.md 的 HTTP 契约):
   - selfRef → uid; room 缺省用 `hub.defaultRoom(uid)`, 有多个候选时 400
   - chat_ask / chat_say 带 to 时, 单个非成员 → `dm:<我>|<它>` (D-1)
   - interrupt 鉴权: 直属 parent / host / 人
   - 回包统一 `{ok, room, id, seq?, status?, duplicate?, degraded?, woke?}`; members / read 回纯文本 (read 用 `renderRoomRead`)
4. 落盘与 uid 回填: 新实例 `mintUid`; spawn / clone / delegate 的 `room?` 参数 → join via:"spawn"; 实例结束 → 对每个 room 执行 `leaveOps`。
5. rooms/ 总量护栏: boot 时与每天一次统计, 超过 1G 打 warn, 并发一条 [wezard] 系统行 (cutover.md「磁盘与保留期」)。

## B. 接入
- inbound 人话:
  - 原 `events.accept` 包层换成 `hub.append(room, {author: human, kind: "say", origin: "inbound", ext: msgid, bubble, to: .name 点名})`
  - 点名对象不是成员时先 join (via:"mention")
  - 没有 host 时走 onboarding; slash 命令照旧直接 dispatch
- mirror idle → `hub.onIdle(uid)`。
- 定时任务 / plan 提醒: 改为 append `kind:"trigger"` 行 (cutmap G-1 / G-2)。
- handoff carry: 直接 `injectText`, 不进账本 (cutmap G-3)。
- 审批卡 `bindCardChannel`: 改为本轮唤醒它的绑定 room。
- steward 手闸 (approval.ts): 只看 role, 删 topOnly / speech 条件。
- room-ui 要的 4 个接线点 (PaulEvans 回执):
  - read 处理器换成 `renderRoomRead`, `parseWhen` 从 shared/room-view 取
  - `audienceOf` 已删
  - `collectWorldFacts` 加 rooms / names / uid
  - `createChatRoutes` 第 4 参传 room store

## C. 删除 (cutmap C / D 表)
- router.ts、message-events.ts (先把 messageId 的去重换成 ext)、strict-gate、members、chat-records (`chatPrincipalOf` 搬走)、idle-nudge、strict-switch、pending-items (`pending_items` 改成查 open duty)、dispatch.ts
- chat-seen 只删 `speechDefaultOf`
- mirror 终句投递链: 删 C 表 16 项; 先把 `recoverEventFinal` 里补写 turn 记录的三行搬进 tail 恢复路径
- 删 /peer、/peers/tell、tell_peer 路由; inbound 命令里删 /owed、/strict、/chats
- config: `chatPolicy.topOnly` / `speech` 移出 schema (旧键忽略 + warn, 不拒启动)
- CharterArgs 的 topOnly / speech (OliveDavis 留的)、`renderReceiptEnvelope`、信封 RESULT 认领
- parseEnvelope 读侧: askerOf / openingOfSelf / servesOfTurn / receiptOfTurn / channelOf 改成从本轮 wake 求
- §7: 每个绑定 pane 标为待 /new, 下次唤醒先 /new 再注入
- 文案: grep.md §1 (CLAUDE.md、CODEBUDDY、README、docs/v3-design 改写; docs/evolve 加废弃头) 与 §6 的剩余项

## D. 测试
- 先跑全量, 剔除 13 个基线红 (见 OliveDavis 回执); 因旧语义而红的测试, 按设计稿 G 节表改写或删除
- 必须绿: room-duty / room-leave-cancel / room-interrupt / room-hub / room-migrate / room-view / room-view-api / charter / tool-hints / room-watchdog

### D1. 旧语义红的处理原则 (2026-11-19 上级定, 写死)

- **删, 只有一种情况**: 测的**对象已经不存在** —— 断言对象是 router / message-events / strict-gate / strict-switch / members / chat-records / idle-nudge / receipts / obligations / pending-items / dispatch 这些已删模块的**导出本身** (函数签名、内部数据结构、它们的状态文件格式)。
- **测的是行为, 一律改写成新语义, 不许删**: 回执投递、终句提醒、休眠唤醒、镜像进企微、host 求值、成员加减、交接、路由到谁 —— 这些行为在 room 模型里都还在 (换成 duty / reply / wake / mirror / members), 改写成断言新路径的同一行为。「改起来麻烦」「旧夹具难迁」不构成删除理由。一个文件里既有对象断言又有行为断言, 只删对象部分, 行为部分改写。
- **design.md G 表是参考, 本原则优先**: G 表写「删除」而文件里有行为断言的, 按本原则改写, 并在删除记录里注明与 G 表的出入。
- **每条删除留一行** (写进 docs/room/verify-<commit>.md 的「删除记录」节): `文件 | 原断言 (测试名或 assert 文案) | 为什么判为「对象已不存在」(指出被删的导出 / 文件)`。没有这一行的删除视为回归。
- **基线红不由执行者自己判**: 输入是验证报告 (verify-fd4715b.md) 给出的分类 —— 基线红 14 个不动, 只处理报告列出的旧语义红与真断言不一致。