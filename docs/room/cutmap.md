# room 模型 · daemon 沟通层切割图

只读调研, 未改任何文件。基准: worktree /Users/zyy/develop/Guxi11/cc-wecom-room (branch room-model @ 12e7ef4, 基于 origin/v3 cf3e0b3)。
行号均为该基准的当前值。契约见 docs/room/contract.md。

## 0. 现状一句话

**人话和 tell_peer 早就走同一条泵**: 两条链都在 `daemon/message-events.ts` 的 `accept → pump → io.inject` 上落地,
差别只在 "谁写这一行" 和 "inject 走哪个适配器"。所以 room 账本要换的不是 "两条链路", 而是
**这张事件表 + 它上面的顺序/回执/收口语义**; 传输那一层 (paste / idle / Esc / spawn) 原样可复用。

- 人话: `installInboundRouter` 的 dispatch 包装 (daemon/index.ts:551) 里 `events.accept` (index.ts:580)
- 同伴: `tellPeerAsInner` 尾部 `acceptPeerDispatch` (index.ts:3162) → 同一张表
- 泵: `createMessageEvents` (message-events.ts:460), `pump` (965), `inject` (782), `injectable` (877)
- 适配器: index.ts:353-489 (`inject` 402, `ready` 381, `send` 461, `final` 459)

---

## A. 一条消息怎么进 pane

### A-1 人话 inbound
| # | 跳 | 位置 |
|---|---|---|
| 1 | SDK `message.text/image/mixed/voice/file/video` | daemon/inbound.ts:1255 / 1267 起 |
| 2 | 引导闸 `guideGate` (未绑定群先引导) | inbound.ts:1168 (调用 1268) |
| 3 | `.name` 前缀解析 `parseTag` + 路由 `route/ composeInbound` | inbound.ts:56 / 1126 |
| 4 | 授权闸 `gate(...)` | inbound.ts:674 (调用 1275) |
| 5 | 组信封 `send()`: channel/chatName/human envelope/steward hint/notice | inbound.ts:1227-1246 |
| 6 | `bridge.dispatch(...)` (dispatch 已被 index 包过) | inbound.ts:1248 → index.ts:551 |
| 7 | 包层: 非 slash → `router.commit(ops.open)` + `events.accept` | index.ts:577-585 |
| 8 | `watchQueue` 冷目标排队实况写进同一气泡 | index.ts:541, 调用 586 |
| 9 | 泵: `pump` → `injectable` → `io.ready` (人话不看 idle) → `inject` | message-events.ts:1010-1022 |
| 10 | `io.inject` 人话分支 → `pinFrameBot` + `bridge.dispatch` | index.ts:402-420 |
| 11 | `bridge.dispatch` (mirror 大块) | mirror-bridge.ts:8263 |
| 12 | 印章 `pendingChannel/seal` → `startBriefTurn` (开占位气泡 + 记 turn) | mirror-bridge.ts:8389 / 4222 |
| 13 | 真贴: `enqueue(sid, …)` → `inject(...)` → `injectViaTmux`/`injectViaTmuxText`/spawn | 8385 起 / 2418 / 1831 / 2014 / 2317 |

slash 例外: index.ts:552 直接 `bridge.dispatch` (不走事件表); mirror 内 slash 还要等 idle (mirror-bridge.ts:8290)。

### A-2 tell_peer
| # | 跳 | 位置 |
|---|---|---|
| 1 | MCP `tell_peer` → `POST /peer` → `tellPeer` | index.ts:3194 |
| 2 | `tellPeerAsInner`: 解析 target / re / after / plan / return / priority / public | index.ts:2977-3150 |
| 3 | 开/合路由行 `openDispatchRow` | index.ts:1300 起 (调用 ~3146) |
| 4 | `acceptPeerDispatch` → `events.accept` (peer 载荷+信封+Tell) | index.ts:1326 / 3162 |
| 5 | 泵 (同 A-1 #9) | message-events.ts:965 |
| 6 | `io.ready` peer 分支: 前置/停放/idle/parked/priority | index.ts:2655-2663, message-events.ts:1070-1082 |
| 7 | `peerEvents.inject` → urgent: `interruptPane(Esc)`; 其余 `bridge.injectText` | index.ts:2664-2690 |
| 8 | `injectText` 内部: lazy restore → probe → respawn → 章程序言 → seal → `inject` | mirror-bridge.ts:7847-7953 |

### A-3 pane 侧硬能力 (新泵真正要的两个原语 + 它们背后的东西)
| 能力 | 位置 | 说明 |
|---|---|---|
| **粘贴一段文本** | `bridge.injectText(target, text, opts)` mirror-bridge.ts:7847 | **就是你要的 P1**。签名见下方片段; 自带: 冷恢复/探活/respawn、章程序言、seal、`requireIdle`、`guard(phase, identity)` 边界回调 (供上层提交前再校验一次) |
| 贴的底层 | `inject` 2418 → `injectViaTmux` 1831 / `injectViaTmuxText` 2014 / `injectViaSpawn` 2317 | bracketed paste + Enter + 提交见证; spawn 模式给无 tmux 的后端 |
| 同 pane 串行 | `enqueue` 2519 / `queues` 2462 / `INJECT_JOB_TIMEOUT_MS` 2470 | 物理互斥, 新泵照样要它 |
| **先 Esc** | `bridge.interruptPane(target, opts)` mirror-bridge.ts:7956 | **可当 P2**(不传 `teardown`): 只 send-keys Escape; 失败返回 reason。注意 `teardown:true` 会 `events.cancel` + 收气泡, room 模型不要用它 |
| `/new` | `bridge.newSession(target, name, opts)` 6060; inbound `spawnSession` 611 / `ensureSession` 647 | 换会话/换 cwd; 冷目标首条由 injectText 自己 respawn, 不必先 newSession |
| busy 判定 | `idleNow` 6649 / `idleVerdict` 6623 / `isBusy` 6612 / `paneBusy` 6615 / `parkedNow` 6644 | 注册表 > 屏面; idle+悬着工具调用 = 停在审批卡 = 不算闲 |
| 占位气泡 | 建: `startBriefTurn` 4222 (`client.replyStream(frame, streamId, "链接 …", false)`, 4241) + `rememberReplyBubble` 3286; 收: `finishBubble` 3966 / `finishPlaceholder` 3996; 认领: `claimReplyBubble` 3291 | **报警: 气泡要 frame**。见 A-4 |
| 提示气泡 (非占位) | `notifyChat` index.ts:963; `sendStandalone` 3482 / `sendRaw` 3509 | 纯出站 |
| 打断 + 拆 pane | `interruptPane({teardown:true})` 7956 / `killPane` 8007 | stop_wizard 用 |

片段: P1 的契约 (mirror-bridge.ts:7847 头部与返回)
~~~ts
injectText: async (target, text, opts) => {
  const permission = (): boolean => !opts?.guard || opts.guard();
  const denied = { ok: false as const, retryable: true, reason: "inject permission withdrawn before respawn/binding" };
  if (!text.trim()) return { ok: false, retryable: true, reason: "empty text" };
  ...
  if (!a) return { ok: false, retryable: true, reason: "no mirror attached for target", ...(deps.store.get(target) ? {} : { gone: true }) };
  ...
  const r = await inject({ text: full, images: [], cfg, guard: (phase, identity) => permitted() && a.tmuxPane === injectPane && (!opts?.guard || opts.guard(phase, identity)), ... });
~~~
opts (公开签名在 mirror-bridge.ts:2660): `{ channel?, eventId?, envelope?, from?, speaker?, requireIdle?, noRespawn?, handoff?, guard? }`。

### A-4 一个真缺口 (新模型必须补)
占位气泡与 `finishPlaceholder` 的唯一凭据是 **WeCom frame + streamId**, 而 frame 现在只活在
`payload.human.frame` (MirrorDispatchArgs, index.ts:416 `pinFrameBot(e.payload.human!.frame, …)`)。
room 契约的行 schema 里 `bubble: {stream, expires}` **只有 stream/expires, 没有 frame** —
reload 后 (甚至同进程但事件库被换掉后) 无法 `replyStream` 覆盖这条占位。
两种补法, 选一: (a) 行里加 `bubble.frame` (WsFrameHeaders 序列化可行, 体积小);
(b) daemon 内存/落盘一份 `msgid → frame` 表, 由 inbound 在 accept 时写。**推荐 (b)**: 与账本 schema 解耦,
且契约的 `bubble` 字段保持只做 "是否已覆盖" 的记号。

---

## B. 出站到企微的原语

| 原语 | 位置 | 签名 / 说明 |
|---|---|---|
| 通用 markdown 进群 (唯一接缝) | daemon/outbound.ts:29 `deliverToChat(client, chatKey, content, log?)` | `#tag` 头由 `withTagHeader` 加, chatid 剥前缀; 只在 `wezard send` / MCP / 学徒入群走这条 |
| 群内通知 | index.ts:963 `notifyChat(base, markdown)` | **void**, fire-and-forget; `chatIdOf(base)`=baseOfKey 剥 `user:/chat:/group:`; 正文走 `linkTags`; `[wezard]` 前缀由调用方写 |
| 以某 wizard 名义发 | index.ts:999 `postAs(self, dest, text)` | = `notifyChat(dest, headed(ownHead(self), text))` |
| **频道 (topic) 发** | index.ts:1004 `postAsTopic(self, dest, text, msgid?)` | `dest` 是 `chat:<topic_id>`; 走 `sendTopicContent(client, log, topicId, text, msgid)` 选评论/新帖 |
| 公开 wizard 间气泡 | index.ts:1009 `relayPeer(from, to, body, channel)` | `speakerHead(relayLabel…)`; 1200 字截断 |
| 终句/分片发送 (响应用) | daemon/last-response.ts:200 `sendFrozen(chatid, content, stream?, guard?)` | 打字机/流式 + 空消息闸; index.ts:479 包一层 `responseTracker.sendFrozen`; index.ts:467 `eventDeliveryAllowed` 前置放行 |
| 微信通道 | index.ts:473-476 `wx.sendFinal(chat, md, key)`; `wx.finalStatus(key)` (index.ts:483) | 微信用自己的队列/额度; `sendFrozen` 对 wx chat 由 tracker 分流 |
| 媒体 (send_file) | index.ts:961 `routeSendMedia(wx, weixinSendMedia(wx), aibotSendMedia(ws.client, log))` → `sendMedia(target, spec)`; 实现 daemon/media.ts / weixin-cmd.ts:253 (`planWxMedia`) | spec `{path, kind?, name?, caption?, title?, description?}`; 企微走 aibot 上传, 微信走 CDN 上限 25MB |
| 占位气泡覆盖 | mirror-bridge.ts:3996 `finishPlaceholder(target, msgId, md): Promise<boolean>` | false = 气泡已收/过期/不归这个 target → 调用方退回 notifyChat |
| 气泡转移 | mirror-bridge.ts:3332 `transferReply(event)` | 只把占位刷成 "…", 用于 transfer 后换主 |
| 占位的实际消费方 | index.ts:2238 `deliver()`: 频道 → `postAsTopic`; 群 → `finishPlaceholder` 成功即覆盖, 失败退 `postAs` | 这就是 room 里 "第一条 re 它的 reply 覆盖气泡" 要照搬的三行 |
| 微信 held 逻辑 | daemon/weixin.ts:171 `planFlush(a, now, w)`; 队列 200-230; 失败分类 200 | 一个号一份 outbox + 每窗口额度 + 退避; room 不需要知道, 保持 `wx.sendFinal` 接口即可 |

---

## C. 终句投递链 (要删的)

现状入口: `handleBriefItem` (mirror-bridge.ts:4624) 收到 `item.final === true` → `concludeBriefTurn` (4341)。

**删 (出站语义)**
| 函数 / 调用点 | 行 | 作用 |
|---|---|---|
| `concludeBriefTurn` 的投递分支 | 4370-4400 | `recoverEventFinal` / `queueFinal` / progress 投递 / 收气泡 |
| `recoverEventFinal` | 3920-3955 | 终句 + turn store 记录 + `publishEventFinal` → `queueFinal` |
| `deliverTransferredFinal` | 3957-3964 | transfer 的 error 终句 |
| `queueFinal` | 3902-3918 | 组 FinalDelivery 进 outbox |
| `publishEventFinal` / `eventFinalPublication` / `runEventFinalRecovery` | message-events.ts:280/286/304 | 路由判定后外发 |
| `eventFinalGate` / `setEventFinalGate` | mirror-bridge.ts:3272 / 8259; 判定 router.ts:522; 装入 index.ts:2699 | 终句出站闸 |
| `eventProgressGate` 终句进度分支 | 4382-4391 | 父行未落定时把终句当 progress 发 |
| `turnSilent` / `strictChat` / `strictBase` / `strictOf` | 3891 / 3889 / 3886 / 3885 | 出处门 + strict 出站门 (room 模型里没有这两个概念) |
| `chatOriginOnly` 判定本身 | 3892 (`turnFromChat === false`) | 只用于 turnSilent; 删后 `turnFromChat` 仍可留作 rolepage 元数据 |
| `replyBubbles` / `rememberReplyBubble` / `claimReplyBubble` / `transferReply` | 3285 / 3286 / 3291 / 3332 | 终句认领占位气泡的登记表 —— **改**: 覆盖占位改由 room 的 "第一条 re 它的 reply" 触发 (调用 `finishPlaceholder`) |
| `finishBubble` 里 "正文覆盖" 用法 | 3966-3993 | 保留函数 (ack/收口仍要), 但只由 reply 行调用 |
| `sendStandalone` / `sendRaw` 的终句用法 | 3482 / 3509 | 文本/cot 仍要用 (COt、skill_output), 但终句不再走 |
| index.ts `deliverFinal` + `settleFinal` + `noteStrictUndelivered` | 1570 / 1604 / 1592 | 整段 (路由落定 + strict 当轮提醒) 随 router 删 |
| adapters `final` / `send` / `deliveryEvidence` | index.ts:459 / 461 / 483 | 终句 outbox 整条 |
| `events.result` / `finished` / `delivery` 调用 | mirror 4376, 4681, index 469 等 | 事件库的 result 语义 |

**保留 (记录侧, 删出站后仍必须写)**
| 写点 | 行 | 结论 |
|---|---|---|
| `recordTurnItem(turnId, {t:"text", final:true})` | 4658 (final 标记), 4509, 4642, 4654 | **保留** — rolepage 的唯一正文来源 |
| `recordTurnStart` (人话/同伴/CLI 轮) | 4173, 4233, 4299, 4492 | 保留 |
| `recordTurnClose` / `recordCloseOpenTurns` | 4417, 4363, 4406 | 保留 |
| `recordTool` / `recordTurnUsage` | 4635, 4684 | 保留 |
| `recoverEventFinal` 里的 turn 记录补写 | 3930-3943 | **搬**: 这段是 "reload 落在 result 与收口之间" 的补写, 删函数时要把这三行搬进 tail 的 turn_end/recovery 分支, 否则 reload 会丢一次终句 (rolepage 空白) |

结论: **turn store / rolepage 在删掉出站后仍然完整**, 前提是 (i) 终句文本仍由 `handleBriefItem` 记,
(ii) 把 `recoverEventFinal` 的补写搬到恢复路径, (iii) 不再有 "终句 = 完成信号" 的概念 ——
rolepage 只看 turn store, 本来就与路由无关。

---

## D. 依赖表 (每个 import 点 → 处置)

| 模块 | import 点 | 用途 | 处置 |
|---|---|---|---|
| **router.ts** | index.ts:33 (`openRouter` 238, ops/cancelOps/pickPair/makeOutcome…), message-events.ts:8 (type), pending-items.ts:23 (type Receiver), handoff.ts:29 (type EventId) | 全 daemon 的完成账 | **删**。类型 `Receiver`/`EventId` 被 pending-items/handoff 引用 → 那两处随之下线或换 room 类型 |
| **message-events.ts** | index.ts:34, mirror-bridge.ts:2, inbound.ts:7 (`messageId`) | 事件表 / 泵 / outbox / result | **删** (只留 `messageId` 的等价物? 入站去重键改用 `ext=msgid`+room; 见 H) |
| **strict-gate.ts** | index.ts:55 | `openSayMeter` 2103, `sayVerdict` 2157, `topOnlyVerdict` 1921 | **删** (发言权改 `shared/room.ts` 的 judge, 额度 M=20 在 room.ts:338) |
| **members.ts** | index.ts:56 (open 296); strict-gate.ts:1 (type) | 成员表: 567,2084,2109-2136,2150,2172,2280-2295,2961,3439,3453,3759-3772 | **改成查 room duty/成员**: 成员 = room 的 join 行; `members.modeOf` → `room.members` |
| **chat-records.ts** | index.ts:51 (290); last-response.ts:19 (`chatPrincipalOf`) | 聊天账本: 308,587,2057,2072,2116,2295,2351,2458 | **删**; 历史由 `origin:"migrate"` 行取代 (迁移脚本只读它)。last-response 的 `chatPrincipalOf` 是纯函数 (chat-records.ts:104) → 搬走 |
| **chat-seen.ts** | index.ts:52; channel.ts:22; chat-name.ts:12; strict-switch.ts:13 | 已知聊天 + speech 缺省 | **保 `knownChatsOf`(chat-name 自动命名还要用), 删 `speechDefaultOf`**; index 309/587/2020/3759 随 chat-records/strict 删 |
| **idle-nudge.ts** | index.ts:128 | `startIdleNudge` 2801, `startObligationWatch` 2868, 话术 98-119 | **删**。契约 §5: 当轮注入一次 + 升级一次 system 行, 就是 room 的一条 `system` msg, 不需要轮询器 |
| **strict-switch.ts** | inbound.ts:32, index.ts:53 | `/strict` 预演/执行 | **删** (`/strict` 命令一起下线) |
| **pending-items.ts** | index.ts:118 | `createLedger` 1034, `POST /pending` 4840 (MCP `pending_items` mcp/tools.ts:922) | **改成查 room duty**: `pending_items` → `openDuties/dutiesHeldBy` (shared/room.ts:268-273); 投影表 ledger 可删 |
| **dispatch.ts** | index.ts:126, message-events.ts:7 (type), route.ts:17 (type) | `ReturnOp`/`Tell`/`HeldSeen`/`InFlight` 类型 | **删**: `return`/`detach`/`transfer` 语义在契约里只剩 `room_transfer`; 纯类型文件, 无运行时 |
| **route.ts** | index.ts:132 | `delegate` 的候选与取舍: 4264/4265, 4334/4338; `coldGateOf` 3020; `routeReceiptDutiesOf` 1161 | **保留** (delegate 还在), 但要换喂料: `RouteRow.duties` ← room 的 open duty; `coldGateOf` 不动 (纯函数, 读 sessionInfo) |
| **plan-reminders.ts** | index.ts:138 | 每 30s 扫 plan, 空闲 owner 投一条提醒 (2903-2948) | **保留骨架, 换注入**: 提醒不再进事件表, 改成 "写一条 `kind:"trigger"` 的 room msg + 唤醒" 或直接 `injectText` (见 G) |
| **handoff.ts** | index.ts:131 (1110 createHandoffs), mirror-bridge.ts:1 (type), message-events.ts:2 (type) | 自我交接的 carry 注入 / 切断闸 | **保留** (交接是会话层, 与账本无关); 只把 `deps.inject` 的实现从事件表换成 `injectText` 直投 (见 G)。`ClearAttempt` 类型留在 handoff.ts |

---

## E. 「这一轮被谁唤醒」的现有判据

全部**从 transcript 开头那句的 system-reminder 反读** (shared/reminder.ts `parseEnvelope` 245),
或从 mirror 的内存 AttachState 读。

| 判据 | 定义 | 调用点 |
|---|---|---|
| `openingTurn(jsonl)` | peers.ts:708/714 (`openingOf` 过滤 queued/notice/续跑) | index.ts:1757 (`othersTurn`), 1764 (`openingOfSelf`), 2672 (urgent 守卫) |
| `openingOfSelf(self)` | index.ts:1764 | 1768 (controlSnapshot), 1770 (controlValid), 1798 (askerOf), 1950, 2155, 3039 (actorStillValid), 3500, 5106 |
| `servesOfTurn(self)` | index.ts:1274 | 1310, 1386, 1919, 2296, 3502 |
| `askerOf(self)` | index.ts:1797 → `askerFromEnvelope` reminder.ts:162 | 1803 (bindCardChannel), 1807, 1949, 2301, 2306, 2344, 3030, 3504, 4314, 4500, 5106 |
| `receiptOfTurn(self)` | index.ts:1280 | 3016 (`const hint = receiptOfTurn(self)`) |
| `channelOf(self)` | index.ts:1020 (`m.currentChannel` || baseOfKey) | 1940, 2166, 2181, 2211, 2273, 2328, 2424, 3068, 3074 |
| `m.currentAsker / currentChannel` | mirror-bridge.ts:8243 / 8247 | 上面两个的兜底 |
| mirror 自己的开轮判据 | `openingOf` 4045 (读 lastUserTurn 的 env), `consumeChannel` 4065, `a.activeEventId / a.speaker / a.convFrom / a.replyTo` | 3892 (`eventOwned`), 4269, 4303, 4378, 4684, 7925 |
| 信封字段定义 | reminder.ts:197 `envelopeAttrs`, 245 `parseEnvelope`, 162 `askerFromEnvelope`; 种类表 `REMINDER_KINDS` 35 | — |
| detail 侧同源判据 | `detail.ts` 的 `currentHumanQueryOf`, `openTurnsOf`, `lastChannelOf` | rolepage / handoff |

**换成「本轮唤醒的 room + msg id 集合」**: 契约的 `wake: string[]` + 投递时的 `seen` 游标已经给出事实,
不需要再读信封。落地要点:
1. 泵在贴之前就知道 (room, msgId, holder); 贴成功后 `append({op:"seen", who, seq})` —— 这是唯一的 "读到了" 事实。
2. `askerOf` → `roomsOfWake(self)` 的交集里取 `asker` (msg.author); `channelOf` → 被投递的 room 的绑定 chat (若 `isBoundRoom`)。
3. 删 `parseEnvelope` **读侧** (E 表全部), 但 **写侧要留**: `renderReminder`/`renderTail` (reminder.ts:100/115) 仍是
   往 pane 里塞 "这是哪条 room msg" 的载体 —— 只是不再从它反推事实。也可以直接把 msg id 放第一行 (更简单, 更小的模型负担)。
4. `controlSnapshot/actorStillValid` (1768/3039) 的用途是 "等锁期间调用方是否换了轮" —— 换成 `seen` 游标或本轮
   wake 集合是否仍包含它, 语义更直接。

---

## F. 卡片发到哪个聊天 / steward 手闸

| 项 | 位置 | 判据 |
|---|---|---|
| 卡片聊天注入点 | approval.ts:55 `bindCardChannel(fn)`; 装: index.ts:1803 | `(key) => askerOf(key)?.chat || m.currentChannel(key)` |
| 卡片 chatid 计算 | approval.ts:57 `targetChatId(key)` = `cardChannel(key)` 剥前缀/剥 `#tag` | 所有卡 (审批 / AskUserQuestion / plan / 通用 confirm) 都过它 |
| 通用卡 | approval.ts:856 `requestConfirm({client, principal, who, title, body, timeoutMs})` | 只发一张卡等人点 |
| AskUserQuestion (hook 路) | approval.ts:1646 `handleAskUserQuestion`, `resolveApprover` 1859 | approver = mirror target (1859-1866) → targetChatId → cardChannel = 本轮链头的群 |
| AskUserQuestion (codebuddy 镜像路) | approval.ts:1208 `runMirrorAskqFlow({chatKey})`; chatKey = `a.target` (mirror-bridge.ts:4976) | 同一把尺子: targetChatId(a.target) → cardChannel(a.target) |
| `/card` `/ask` (MCP send_card/ask_user) | daemon/ask.ts:22/63 | **不看**链头, 由调用方给 `chat`; 保留 |
| steward 手闸触发 | approval.ts:2149-2151 | `isStewardTarget(cfg, store, owner) && (chatPolicyOf(cfg, owner).topOnly || .speech === "strict")` |
| 手闸本体 | steward-guard.ts:93 `makeStewardGuard()`; 判级 FREE/HANDS/look 16-96 | 只看 role, 与账本无关 |
| 引导化身无工具面 | approval.ts:2143 (`guideRefusal`) | 保留 |

**结论**: 卡片聊天 = "这一轮链头所在的群", 判据就是 `askerOf`。room 模型里链头 = 本轮被唤醒的 room 的
`asker`; 所以 `bindCardChannel` 只需把实现换成 "本轮 wake 的绑定 room"。steward 手闸的触发条件
(approval.ts:2151) 要改成 **role (`kind`/class = steward|guide)**, 不再读 topOnly/speech (契约 §7)。

---

## G. 三条 "非人话" 的注入, 新模型怎么接

### G-1 定时任务 (tasks.ts / scheduled-delivery.ts)
现状: `startScheduler` (index.ts:5446) → `scheduledTaskInject` (5191) → `deliverScheduled` (scheduled-delivery.ts:29):
等交接 / 等 idle (最多 30min) → `openTaskRow` (5188) 开一条 chat 根行 → `m.injectText(target, text, {from:{kind:"task"}, channel, envelope: renderTaskEnvelope(...)})` (5218 / 5353)。
quiet 任务另有一条 `relayUnlessQuiet` (5235) 从 transcript 取终句转发进群。

**建议**: 定时任务 = `kind:"trigger"` 的 room msg (契约 §2 明说), `wake:[ownerUid]`, 不镜像。
开工时 daemon 直接 append 一行, 然后交给同一个唤醒泵 —— **不要**再用 "旧式的 injectText + 旁路转发":
- `deliverScheduled` 的等 idle 逻辑由泵统一负责 (泵本来就在等 idle);
- `openTaskRow` / `quietRelays` / `relayUnlessQuiet` 全删 (quiet 语义 = 不镜像的 trigger 行 + 它的回复也不镜像);
- 唯一要留的是 `tasks.ts` 的 trigger/gate/render 与 `spawn fresh runner` (runTaskInRunner 5280): 它仍是
  "起一个白板 wizard 跑这一枪", 只是最后一步从 `injectText` 换成 "把 trigger 行开在 runner 的 dm room 里并唤醒"。

### G-2 plan reminders
现状: `startPlanReminders` (plan-reminders.ts:30, index.ts:2903) 每 30s 挑 owner → `events.accept` 一条
`plan-reminder:<plan>:<rev>:<token>` 的 peer 事件 (2919-2946), 走同一台泵。

**建议**: 保留 "扫 plan → 选 owner" 的纯逻辑, 换末端: append 一条 `kind:"trigger"` 的行到 owner 的 home/关联 room
(`ext` 或 `planId` 带上, 去重键 = token), `wake:[owner]`。删除 `payload.planReminder` 及其在 adapters 里的
四处特判 (index.ts:2611/2615, 2656/2666, 2678; 2908)。`planHasOutstandingDebt` (index.ts:2594) 改成
"该 plan 关联的 room duty 是否仍开着"。

### G-3 handoff carry
现状: `handoff.ts` 的 `deps.inject` (index.ts:1138) 也是一条 `events.accept` (id `handoff:…:carry` 1565),
适配器里走 `bridge.injectText(..., {handoff: clear, requireIdle, noRespawn, guard})` (index.ts:403-414)。

**建议**: handoff 是**会话层**动作, 不该过账本。直接把 `deps.inject` 实现成 `bridge.injectText` (跳过事件表):
`{handoff: p.clear, requireIdle: true, noRespawn: true, channel: p.channel, speaker, from}`。
好处: 简报轮不再是 "一件活" (它本来就不是), 也不会在 room 里留下一条永远开着/dead 的行。
要保留的只有 `handoffAllowed` 闸 + `verifyClearContext` (7849) 的连续性校验。

---

## H. inbound 里人话的路由

| 环节 | 位置 | 说明 |
|---|---|---|
| 入口注册 | index.ts:551 `installInboundRouter`; 频道事件 index.ts:590 `installChannelEvents`; 审批卡 index.ts:603; mirror index.ts:743 | 三者都 `client.on(...)` |
| 信封/头 | inbound.ts:1229-1239: `renderHumanEnvelope(userid, chatName, channel)` + `renderStewardHint` + `noticeSuffixFor` | channel = `chatPrincipal(msg)` = `chat:<chatid>` 或 `user:<userid>`, 副机器人带 `~bot` (inbound.ts:43) |
| `.name` 解析 | inbound.ts:56 `parseTag` (只认行首, nameTokenRe); 目标 = `resolve(base, tag)` 1126 → `resolveName` 69 (全局名册) / `stewardReception` 1096 | 名字全局唯一; 本群没有该身份 → `openManifestation` 1075 新开实例 |
| 默认落管家/guide | 无 `.name` → `stewardReception` (inbound.ts:1096) → `resolveSteward` (onboarding.ts/steward.ts) | 群管家绑定在运行时; 频道级见下 |
| 新群引导 | `guideGate` inbound.ts:1168; 状态机 `loadOnboardingStore` 1136; `judgeOnboarding` 1213; `applyOnboarding` 1220; `reapGuide` 1140 | 未绑定群拦在路由之前; 引导化身 `<base>#guide`, 无工具面 |
| 频道 (topic) | 原生帧 `source === "channel"` → `settleChannelPost` inbound.ts:1152 → `channelOfPost/awaitChannelOfPost` (channel-posts.ts:27/30); 同频道帖子复用管家 `reapChannelSiblings` 1160; 频道消息本体 daemon/channel.ts + index.ts:590 | room id = `chat:<topic_id>` = 现在的 base principal, **迁移零换键** |
| 微信 | weixin.ts:565 `inbound(msg)` → weixin-port.ts:215 `wx.onInbound` **重发成 aibot 帧** (`emit("message.text", frameOf(m,…))`) → 同一条 inbound 路由 | 所以微信不需要单独一条链; room 的 `wx` kind 只是 id 前缀/传输差异 |
| 出站分流 | index.ts:961 `routeSendMedia`; index.ts:473 `wx.owns(chat)` | 同一个 chatid 判断微信还是企微 |
| 去重键 | inbound.ts:1244 `messageId(botTag, channel, msg.msgid)` (message-events.ts:207) | room 迁移: 用 `ext = msg.msgid` + (room, ext) 去重; `messageId` 可下线 |
| 非路由 msgtype | inbound.ts:1261 (warn + 回一句人话) | 保留 |
| 命令面 | /id /pwd /cost /use /audit /new /cfgsync /chats /owed /usage /stop /kill /n /reveal /help /sessions /peers | inbound.ts:110-390; **/owed /chats 随 obligation/chat-records 下线**, /strict 下线, 其余保留 |

---

## 附: 我建议的新泵最小面

~~~ts
// P1 贴一段 (成功 / 不确定 / 重试)
bridge.injectText(target, text, { channel?, requireIdle?, guard?, from?, speaker? })
  : Promise<{ ok: boolean; retryable?: boolean; uncertain?: boolean; reason?: string }>
// P2 打断 (不动账本)
bridge.interruptPane(target /*, 不传 teardown */) : Promise<{ ok: boolean; reason?: string }>
// P3 开/收占位 (人话行)
openAckBubble(frame, streamId, msgId) / finishPlaceholder(target, msgId, md): Promise<boolean>
// 其余全是读: idleNow / parkedNow / sessionInfo
~~~
泵的一轮 = 扫 room 的 open duty → `afterSatisfied` + `idleNow` → 取 `seen` 之后的行 → `injectText` →
成功则 `append(seen)`, 不确定则保留游标 (重算即可重投), 三次失败写一条 `system` 行说明。