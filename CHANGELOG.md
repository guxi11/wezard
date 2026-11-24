# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- **【.me】用户全局分身 (人 2026-11-24 拍板「me 只是一个 wizard…把这个对话从发生的地方的room的聊天记录里摘除…me 不进入已有的room, 但可以创建支持 dm 的room」+「me 发回说话的那个地方…审批卡发到私聊」)** — 每个用户一个惰性 me wizard (登记表普通记录, kind "me", target user:<uid>#me, 名字 me-<uid>) + 一个私有 me-room (id me:<uid>)。inbound 的 resolve 认保留别名 "me" (按发话人解析, Resolve 多一个 speaker 参数): 用户在任何聊天里说 .me 都路由到他自己的分身, 行只落 me-room — 发生地 room 零行 (不 ensureRoom、monitor/host 看不见、不耗发生地预算, 群里发 .me 也不再顺带关用户在本群的未关账)。me: 前缀不是 dm:/adhoc: → isBoundRoom=true 是有意的: 人话照常开 duty (host 槽位 = me)、humanCloses、唤醒全套沿用; 出站由 roomMirror 的 me 分支接管 (新模块 daemon/me-room.ts): me 的回复覆盖发生地占位气泡 (带〔.me 独立对话 · 不入本群记录〕标注)、占位过期/主动开口/文件兜底发用户私聊。审批卡零改动: me 会话 target 剥 #tag 后即用户 DM (targetChatId 导出作单测锁定)。me 是普通 wizard — 手面全开、不进已有 room (wiring B 的 auto-join 分流到 me-room)、找 host/其他 wizard 用 chat_ask 自动落 dm/adhoc。测试 tests/me-room.test.ts。
- **新群引导一句话办完三件: 工作区 + 新管家名 + 群名 (人 2026-11-23「给当前群聊命名为 tpmtest，并绑定workspace为 …/dhtpm，然后给新的host命名 tpm」)**: `onboard_bind` 加可选 `roomName` (本群显示名, ≤60 字, 交接时引导还是 host 就先落一条 `name` op) 与新的 `name` 语义 —— **与 `workspace` 同给 = 给新建的管家起名** (类世界写类名, 实例 `<name>-1`; 全机唯一, 撞名 409 / 形状非法 400, 回绝里带原因让人换), 只给 `name` 仍是绑已有管家; 目录上已有管家时另起的名字 400 并点名已有的那个。引导的话术 (宪章 / retry) 写明「一次调用办完, 不要甩给后来的管家」。测试 `tests/onboarding.test.ts`。
- **频道 / 帖子成为两种 room, 每个频道 room 与帖子 room 一个常驻 monitor (人 2026-11-23 拍板; docs/room/channel-monitor.md)** — **BREAKING**: 频道 room id = `chat:<topic_id>` (kind channel), 帖子 room id = 原生帧的 `chat:<opk…>` (kind topic-post); 两者都是普通 room 节点, 不画容器, 帖子的归属用 `channel` 指针 (rolepage 上一条弱连线 + 节点 tooltip 的频道名) 表达。没 @ 机器人的新帖 / 还没配上 opk 的评论落频道 room 的一行人话 (带 `post`), 配上之后落帖子 room; 出站频道 room 一律 `send_post`、帖子 room 一律 `send_reply`。每个 room 自动建一个 `kind:"monitor"` 成员 (不发言 / 不当 host / 不持有 duty, 工具面只有 room_read / read_channel / wizard_roster / room_activate / handoff), 人话只唤醒它, 由它写一条 `sys:"activate"` 判决 (新 MCP 工具 `room_activate({re, to?})`, `to` 为空 = 判定不回应) 决定激活谁; 判决只针对最后一条人话、同一条只能激活一次。monitor 没收到 = 不投递、游标不动、泵重试 (不回落 host、不写 undelivered)。配置 `wrc.channel.monitor {enabled, tier=light}`。测试 `tests/room-monitor.test.ts` / `tests/monitor.test.ts` / `tests/channel-room-view.test.ts`。

### Fixed
- **@ 了机器人的人话还是被 monitor 拿去判 (人 2026-11-24「monitor-11 不应该处理刚才这个带了艾特机器人的消息」)** — 账本行的 `mention:"bot"` 早就有 (`judge` 的 `toMonitor` 看它), 但入站从来没记过: 频道 / 帖子里 @ 机器人的那句以**原生帧** (`compat_info.source=channel`) 进来, 正文里反倒没有 @token (实录: 帧 text 直接就是正文), 于是行上没带 mention → `judge` 交给 monitor, monitor 再判给 host。现在 inbound 的 `atBot` 按两条判据认定 @ 了机器人 ① 频道原生帧 ② 正文里有机器人名 (与 `stripAt` 剥离时同一判据), `dispatch` 带 `mentionBot` → 账本行记 `mention:"bot"` → 直达 host / 被点名者, 只唤醒它; 没 @ 的人话 (`topic_reply_event` 的普通评论) 照旧交给 monitor。频道侧 topic_at_bot 的兜底也统一标 mention (已配对落帖子 room 时此前漏标)。测试 `tests/inbound-at-bot.test.ts` / `tests/channel-native-dedupe.test.ts`。
- **同一个 room 里 host 把 member 说过的话再转述一遍 (人 2026-11-24「host 有时会转述一遍，像是不知道 member 也是在群里发言而用户可以看到」)** — 根因在提示词: 宪章的「不复述」写成「结论要人知道就用你自己的话讲」(反而给了复述许可), host 那一节又要求「向提问者交代: 结论 + 取舍 / 遗留」, 而**绑定 room 的镜像语义只按「你说的话」写** —— host 没有被告知同伴的 `chat_reply` 也已经作为群消息发给了人。现在 ① 宪章按 room 种类写死可见性: 绑定 room 里人看得见每个成员说的每一行 (同伴答过的不再转述, 关账只补 commit / 取舍 / 下一步), dm / adhoc 里人看不见, 结论才要带回主 room; ② 唤醒注入在「本批有同伴真的进了群的 reply / say」且「它还欠着人的话」时多一行: 人已经看过上面那几行, 关账别再复述; ③ `chat_reply` 工具描述补同一条。已生效的会话不会自动读到新宪章 —— 要 handoff 或新开会话才吃到。测试 `tests/charter.test.ts` / `tests/room-hub.test.ts`。
- **频道 / 帖子里的「回复 (评论)」把整篇帖子摘要当成人话的引用贴满 (人 2026-11-23「为什么 user 在 topic 下的发言会带上很长的引用内容? 明明用户自己是没有引用的」)** — 企微在频道/帖子「回复」回调里带的 `quote` **不是被回复的那一条, 而是整篇帖子摘要** (频道名 / 发帖人 / 发帖时间 / 帖子正文 / 回复 1..N, 含 bot 自己的每次回复, 且随跟帖增长: 实录同一帖 1891 → 5274 → 9092 字符), 原帧 `daemon.log` 里人的正文只有 17 字。`composeInbound` 的去重 (`quoteInContext`) 在帖子实例冷启动 (无 mirror → 直接判"不在 context") 与摘要自身的 chrome (频道名 / 序号 + 作者 + 时间戳 / 带 `ww_uniq` 的链接, transcript 里永远没有) 两种情况下必然 miss, 于是摘要被当载荷渲染成 `> [引用]` 前缀写进人话。现在 ① 频道原生帧 (`compat_info.source=channel`) 或摘要形状 (`^频道：…\n发帖人：`) 一律不渲染引用 —— 它本身就是 room 账本的重排; ② 账本人话行改存 `dispatch` 的 `rawText` (人自己打的那部分), 进 prompt 的 `text` 才带引用: 群聊里人真正引用一条气泡的行为不变 (prompt 照旧带 `> [引用]`), 只是不再被 rolepage / `room_read` / 每次唤醒复读。`daemon/channel-posts.ts` 那条「quote 正文里只有频道的显示名」的注释按实测改正。测试 `tests/inbound-quote.test.ts` (素材 = 那一帧的 1803 字符摘要, `tests/fixtures/channel-post-digest.txt`)。
- **独立 svr (bubble.top) 把频道 room 当企微群显示 (人 2026-11-23「wcd 这个是 channel 吧, 现在展示的还是普通群聊 emoji」)** — daemon 按 channel-posts 现算 kind, 但独立 svr 只有账本 + 快照, 快照里频道 room 没有 `channel` 指针 (它本身就是频道), `chFrom` 回落到「wecom-group」, 于是图标 / 类型全按群聊渲染。现在 `shared/chat-http.ts` 的 chFrom 回落认快照里的 `kind: "channel"`; 同时频道 room 的 `open` op 直接写 `kind: "channel"` (此前是 wecom-group), 账本自描述。测试 `tests/room-graph.dom.mjs`。
- **频道 / 帖子的 host 复用别的 room 的实例 (人 2026-11-23「在这个 topic room 里, host 应该是一个新的 instance 吧, monitor 应该也是如此」)** — 两个根因: ① 频道落定 `settleBoundChannel` 把**频道 room 那一个实例** join 进同频道各帖子 room 当 host (老口径「一个频道一个管家, 帖子复用」), `channelPostBorn` 也照抄频道 room 的 host; ② 完成确认对「绑的是类、本 room 新领号开了实例」的绑定也说「绑定为**已有的** .X」, 人看到就以为绑了别处那个。现在**每个 room 的 host 都是它自己的实例**: 频道 room / 每个帖子 room 各按频道绑定的身份在**本 room** 解析化身 (类 = 领号新开, 非类 = 本 room 又一条同身份记录), 互不共用; 帖子 room 的实例不预起 pane (第一次被唤醒时冷启动, 免得每个帖子一个常驻 pane)。boot 自愈 `repairStewardInstances` 也按所属频道把帖子 room 里坐着的频道实例换成本 room 的 (幂等, 老数据一次迁正)。`stewardIdentityOf` / `stewardRoute` 补上类名绑定 (此前只查 wizard 名册, 绑定存类名时解析不到)。完成确认改写为「.wezard-16 (.wezard 类在本群新建的实例)」/「… 已有的实例」。monitor 档位仍固定 light (flash·low, 现场核对绑定与 pane 启动参数); 档位名配错不再静默落回 CLI 默认 (standard), 退回 light 并 warn + 记一行。老频道 / 帖子 room 在 boot 自愈时各领一个新号。
- **新群 / 频道引导期把「没有会话 (已被结束), … 投不进去」的投递诊断发进新建的群 / channel (人 2026-11-23「不应该在新建的群聊或channel中回复这样的消息」)** — 根因是出生窗口被当成「结束」: 未绑定频道的人话先落账、再在后台起 guide pane, 唤醒泵在 `newSession` 还没 attach 的几百毫秒里探到 `no mirror attached`, `injectText` 按「重试也贴不进去」判成 `gone`, `room-hub` 的 `reportGone` 随即给提问者写一条 `sys:"undelivered"` 系统行 —— 绑定 room 会把它镜像进群, 而 guide 随后正常起来并提问 (daemon.log 实录: 落账 → 61ms 后 gone → 25ms 后 warm shell claimed → 2s 后 attach)。现在 `mirror-bridge` 用 `birthInFlight` (target 计数) 覆盖 `newSession` / `cloneSession` 全程, 没有绑定时的判词抽成纯函数 `unattachedVerdict(hasBinding, birthing)`: 出生窗口 retryable、不报 gone; 有持久绑定 (restore 没成) 的老行为不变, 真没会话 (`stop_wizard end` / `/kill`) 照旧上报。频道引导 pane 绑上后 `hub.kick()` 立即投, 不等 30s 重踢。测试 `tests/gone-birth-window.test.ts`。
- **频道 room 里回一条评论也发成新帖 (人报 2026-11-23「在 channel room 里的管家, 为什么不能判断是回复这个帖子还是创建新的帖子」)** — **行为变化**: `roomMirror` 的频道分支原先一律 `send_post`。现在 `chat_reply` 且 `re` 指向的原话行带 `post` (帖子下的人话) → `send_reply` 评论回那个帖子; `chat_say` 主动说 / re 的不是评论 → 仍 `send_post`。选择编码在动作里, 不给工具加参数; 帖子 room 出站不变。判定抽成纯函数 `channelOutboundOf` (daemon/channel.ts)。charter 与 `chat_say` / `chat_reply` 工具描述补上频道 / 帖子 room 语义 (此前只有群语义, 管家自述「回复挂在原消息下面」等全错)。文档 docs/room/channel-monitor.md §2.3, 测试 tests/strict-channel.test.ts / tests/charter.test.ts。

### Changed
- **频道 room 与帖子 room 的图标和群聊分开 (人 2026-11-23「channel room 和 topic room 的 icon/emoji 做一下改变, 和群聊 room 区分开来」)** — rolepage 的 room 图标 (`web/chat.js` `roomIcon`) 新增两种: 频道 `#️⃣`、帖子 `📌`, 群聊仍是 `👥` / 绑定单聊 `💬` / 只有 wizard 的 room `🧙‍♂️`; 图节点、左栏头像、搜索命中 (无 `W.rooms` 时按 kind 回落) 与图例同一套。测试 `tests/room-graph.dom.mjs` 断言频道 / 帖子节点图标与五条图例。
- **monitor 判决完全不进消息记录 (人 2026-11-23「wizard 不需要知道有 monitor 这个环节吧」; 推翻 t8 的系统行渲染)** — **协议变化**: `room_activate` 不再 append `kind:"trigger" sys:"activate"` 消息行, 改落一条非 msg 的 `assign` op (`{duty, to, asker, by}`, 不占 seq、不镜像), 在 `to` 名下直接开 duty (`via:"assign"`, asker = 原话人) 并踢泵; 被激活的 wizard 只看到人的原话 + 「你要交代: <id> (human, 来自 人)」, 注入里没有任何 monitor 痕迹。审计只在 daemon.log 的 `monitor: activate`。唤醒泵 (`pending`) 不再依赖触发行 wake: 人话行在未读里且有 assign 开的未关 duty 即待唤醒; 已读行只在判决晚于它最近一次唤醒批次时补投。轮终 / Stop hook 的欠账扫描把 assign 账的 waker 认作人话行本身 (overdue 的 remind trigger 不变)。monitor 硬闸收严为**不能写任何 msg 行** (含 activate)。存量账本里的 activate trigger 行照旧重放开 duty, t8 的系统形态渲染保留 (只对存量)。`shared/room.ts` 新增 `AssignOp` / `judgeActivate` / `wasActivated`; 测试 `tests/room-assign.test.ts`, `tests/monitor.test.ts` ③ 改写。

### Fixed
- **频道里回一条没 @ 过 bot 的帖子评论, 交代被企微拒后静默丢失 (人 2026-11-23「当 channel 里的消息没有艾特机器人时, 能回复这条帖子吗」)** — 企微限制: bot 只能评论 **@ 过它**的帖子。`sendTopicReply` 现在被 errcode 拒时返回 `"rejected"`, 新增 `sendTopicReplyOrPost` 回退 `send_post` 发新帖, 正文开头带 `> 回 <名字>: <原话前 80 字>` 引用标注 (回退记 log.warn), 不再静默丢失; 帖子 room 的出站不变。未配对预判未做 (按运行期 errcode 回退)。文档 channel-monitor.md §2.3, charter 与 `chat_reply` / `chat_say` 描述写明这条限制, 测试 `tests/strict-channel.test.ts` ⑥。

### Removed
- **`room_transfer` 退役 (交接 = 把接手方拉进 room, 再自己 `room_leave`)** — **BREAKING**: 删 MCP 工具 `room_transfer`、`POST /room/transfer`、charter 工具清单与 `mcp/output.ts` 的渲染分支; 老账本里的 `move` 行仍由 fold 读侧折叠 (逾期计时照算活动), 新群引导的 duty 交接不走它。docs/room/contract.md 与 技术说明.md 同步。
- **频道一次性判官退役** — **BREAKING**: 删 `wrc.channel.judge` 配置、`runJudgeOnce` / `askJudge` / `buildJudgePrompt` / `parseVerdict` / `judgeAndMaybe` 与 `tests/channel-judge.test.ts` —— 频道里是否回应改由 room 的 monitor 判 (上面的 activate 行), 频道事件也不再伪造 `chatid=topic_id` 的群帧进 inbound。


### Fixed
- **新群引导在 CodeBuddy (REPL / PTC) 下没有任何工具可用 —— 每次调用都被拒, 绑定与回复全失败 (.guide-3 实录, 2026-11-23)**: 引导的工具白名单按**外层工具名**判, 而 CodeBuddy 只把 `REPL` 暴露成直接工具, `chat_reply` / `onboard_bind` 都写在它的 `code` 脚本里 (`mcp.wezard.x` / `mcp_wezard.x` / `tools.mcp__wezard__x`), 名字永远对不上 → 一律 deny。现在 `guideRefusal` 接 `toolInput`, 对 `REPL` 由 `guideExecRefusal` (acorn) **下钻脚本**: 每一次调用必须解析成白名单那三件之一 (另加纯计算 `JSON.*` / `String` / `Promise.all` … 与 REPL 自己的 `searchTools` / `describeTools`), 认不出的调用 / `new` / `import` / 解析失败全拒 (fail-closed); 别名 (`const tp = mcp.wezard.chat_reply` / 解构) 按同一身份认。人手开的同名 `.guide` 不受限。管家手闸 (`steward-guard`) 早已下钻 REPL, 其余受限会话无同款问题。契约见 `docs/room/contract.md` §4b。

## [3.0.1] - 2026-11-23

### Added
- **chatdetail 里成员进群 / 退出 / 被移除展示成系统通知 (admin「在chatdetail里，成员被邀请进群、成员退出、被移除都要展示系统通知」)**: 账本里 `join` / `leave` 是不占 seq 的 op, 以前前端根本看不到。现在 `RoomState.memberLog` 把真正的进出折出来 (已在座者再次 join 只改 via / by, 不算), `shared/room-view.ts` `memberNotes` 渲染成居中小号灰字: 「A 邀请了 B 进群」「A 批准了 B 入群」「A 拉起了 B 进群」「B 加入了群」「B 退出了群 (原因)」「B 被 A 移出群」(操作者是 daemon / 拿不到就省略「A」)。同动作 + 同操作者 + 5 分钟内 + 其间没人说话的连续变动折成一条 (「B、C、D 等 N 人」)。不报: 创建者自己 (`founder`)、迁移批量入座、人的隐式入座, 以及 dm 开房那一拍。room 页 `/api/room` 带 `notes`, 前端按时间插进已加载的消息里 (还有更早页时, 早于最早已加载消息的通知翻到那页才出现); wizard 页 (全部聊天记录) 时间轴带 `note` 行 (只含与该 wizard 有关的, 后缀 room 名)。bound 群与 dm / adhoc 都有; **不进企微** (`mirrors()` 没动, 只是 rolepage 展示)。测试 `tests/room-member-notes.test.ts`。
- **chatdetail 底部居中浮一个「scroll to bottom」文字按钮 (admin「在chatdetail底部居中展示一个"scroll to bottom"的带背景的文本按钮」)**: 离底超过 80px 才显示 (scroll 事件 + rAF 合并, 内容变高由 ResizeObserver 补一次), 点击平滑滚到底, 到底 / 内容不足一屏即收起; 按钮挂在 `.thread` 外一层的 `.thread-box` 里、不进滚动内容, 所以不碰 `overflow-anchor:none` / 向上翻页补历史 / 贴底跟随的滚动逻辑; 切到日程时随 `.thread` 一起收。`tests/room-graph.dom.mjs` 加断言 (滚到中间浮出、点击到底收起)。

### Changed
- **rolepage 点击切视角立刻生效, 数据并行取、先显示「加载中…」 (admin「切换应该直接生效, 数据可以并行啦, 允许先展示 loading」)**: 点击的同一帧 `adoptRole` 就把 `D.role` / 选中态 / 页头 / 左上名片 (按名册先画名字占位) / 用量区 (不再拿旧人的名片冒充) / 图与列表高亮切到新视角, 正文换成「加载中…」, 不再留着上一个人的消息到响应回来才换。时间轴 (`/api/wizard`)、名片 (`card=1`, ~20ms) 与名册 (`/api/world`) 在同一次点击里同时发出, 名片先到就先画页头, 正文等自己的回包。**防竞态**: wizard 请求带 `AbortController`, 新的一发取消在路上的旧发 (点击与轮询同理, 轮询在有请求在路上时不再叠发); `loadWorld` 按 role 去重 (原来在路上的那发是替旧视角取的, 换人后会直接复用它、未读数按旧 role 算), 旧 role 的世界回包丢弃; 取失败时给「加载失败」落点。数字 (本机, 同一批切换前后各 2 轮, 机器负载 ~3): 点击→视角生效 (页头 + 名片都已是新人) 中位 ~300ms (最大 810ms; 要等整包回来才换) → 20~52ms (最大 71ms); 点击→数据出齐 (DOM 静止) 中位 330~440ms → 220~480ms (持平略好, 本来就是网络 + 渲染); 最大 long task 130~165ms → 130~190ms (渲染总量没变, 只是不再挡在视角生效之前)。
- **rolepage 切视角不再卡: wizard「全部聊天记录」时间轴改分页 + 轮询只取尾页 (admin「现在切换视角的时候还是很慢, 是因为 role 的 chatdetail 数据太多吗…把长任务变成异步的或者多个短任务」)**: 先量后改 (本机 chromium 1440×900, 真实数据)。根因不是 `msgs` (分页 60 条 / 81KB), 是 `/api/wizard` 的 `stream` —— 服务端把 3 天视野内全部轮次 (wezard-1 548 行, 内联过程框 html) 一次给齐, `limit=60` 管不到它, 前端再一次 `innerHTML` 画 23.6k 个 DOM 节点 (强制布局 ~1.2s 长任务), 4s 轮询还每次重取一遍。现在: ① `/api/wizard` 的 `stream` 只回最近 40 行 + `streamEarlier` 游标 (新增可选参数 `sbefore` / `slimit`, 带 `sbefore` 只回那一页的时间轴; `msgs=0` 不传前端用不到的分页消息; 名片回包不再重复 `rooms` / `names`, ~75KB 原文), 分页逻辑是纯函数 `shared/stream-page.ts` (同 ts 的行不跨页); ② wizard 视图顶部「‹ 更早」按需翻页, 滚动位置按新增高度补偿; 轮询只换尾页, 翻出来的更早页保留、滑出尾页的行并进去不留缺口; ③ 选中 room 里换 role 时左栏列表不再整张重建: 骨架 (标题 / room 顺序) 没变就只替换未读角标变了的条目 (原来 renderList 130~200ms, 现 <15ms)。数字 (wezard-1 全部记录, 切视角): `/api/wizard` 1.76MB → 237KB (gzip 400KB → 50KB), DOM 23.6k → 4.2k 节点, 最大 long task 1202ms → ≤190ms; OliveOwen 0.98MB → 235KB (gzip 226KB → 52KB), DOM 13.1k → 2.9~6.5k, long task ~330ms → ~180ms; 4s 轮询每次传输 400KB → 50KB (gzip); 选中 room 内换 role 的点击同步阻塞 110~240ms → 50~140ms (剩下是 room 本身的布局)。
- **rolepage 关系图选中规则: 点一个与当前视角 role 无关联的 room, 清掉旧的 role 选中 (admin「如果在room/role已选中的状态下，如果接下来选中的role/room和那个role之间没有关联，或者说role并不在room中，则清除之前的选择状态」)**: 关联只认 room 成员表 (图上的边就是照它连的; `roomHasRole`)。新点的 room 含当前 role → 保留 role、加选 room; 不含 → role 选中清掉, 视角换成这个 room 自己的成员 (host → 第一个 wizard → 第一个 human, 同 `pickRoleForRoom`), 只剩这个 room 选中。点 role 的老规则不变 (在选中 room 里则保留 room, 不在则清 room)。节点和边的点击都走这条; 侧栏列表点 room 不变。`tests/graph-layout.test.mjs` 断言关联判定, `tests/room-graph.dom.mjs` 断言四种组合。
- **rolepage 关系图字号: room 胶囊 13px、其余节点 (wizard / 用户) 名字 12px (admin「room node 的 text size 太大了, 13, 然后把其他 node 的 text size 调整成12」)**: 胶囊 12pt (16px) → 13px, 名字 11px → 12px; 同步改名字基线 (`rr+12` → `rr+13`, 字大了基线跟着下移)、`GFS` 11 → 12 (布局排斥盒 `gBox` 人节点字高)、胶囊估宽按 13px 重算 (每字 9.3 → 7.6px, 选中加粗 10.8 → 8.8, 底宽 40 → 36, 最小 70 → 64) 与胶囊文字基线 5.5 → 4.7; `tests/graph-layout.test.mjs` 重叠判定字高 11 → 12。
- **没起名的 room 不再叫「私聊」/「临时 room」, 显示成员名 (admin「graph 里 wezard-1、OliveOwen、MayaKing 之间的 room name 为"私聊"…让 room 必须有名字, 可以让 wizard 来写」)**: 「私聊」来自 `web/chat.js` `shortRoom` 对 `dm:` 的兜底 (图节点 `roomNameOf` 拒收服务端「A ↔ B」拼名后落到它; dm 拉进第三人后就成了三人 room 却仍叫「私聊」, 侧栏 `roomTitle` 已另行处理所以两处不一致) 与 `shared/chat-http.ts` `roomShortOf` 的同名兜底。现在 host 起的名 > 聊天名 > 成员名 (`shared/room-label.ts` `memberLabel`: 两位 `A ↔ B`, 三位 `A·B·C`, 更多 `A·B·C 等N人`) > 短代号 (`room …xxxxxx`); 图节点 / 侧栏 / 顶栏 / 搜索 / 提示行 / 守护进程文本里的 `roomLabel` 同一口径。**让 wizard 起名**: `room_open` 的 `title` 保持可选 (不 BREAKING), 但工具描述、参数说明、charter 三处写明「开 room 要起个名字, 写它在干什么」, 且没给 title 时响应里带 `hint` 提醒用 `room_name` 补; 自动 adhoc / dm 不强制起名。已存在的无名 room 不回填, 靠兜底显示。已在跑的 wizard 须 `handoff` 才读到新 charter。测试 `tests/room-label.test.ts`, `tests/charter.test.ts` 加断言。
- **chat 明细区 (rolepage 右栏) Safari 滚动条样式 + 横向不溢出, 引用块不再撑宽 (admin「优化chatdetail在safari中的滚动条样式，另外，控制x轴overflow hidden，避免内容溢出（quote内容现在会）」)**: ① 滚动条: 原写法 `* { scrollbar-width; scrollbar-color }` 与 `::-webkit-scrollbar-*` 并设, Chrome 121+ / Safari 18.2+ 见到标准属性就让伪元素整套失效 (落回系统默认粗滚动条); 现用 `@supports not selector(::-webkit-scrollbar)` 隔开 —— Chrome / Safari 走细 8px 圆角低对比 thumb (悬停加深), 仅 Firefox 走标准属性; 同一套全局规则, 侧栏 / 列表 / 明细一致。② `.thread` 加 `overflow-x: hidden`。③ 引用块根因: `.rq-it` 是 `display:flex` 的 `<button>`, 其子项 `.rq-tx` 为 `white-space:nowrap` 的长串 (URL / 无空格文本), WebKit 对 button 弹性容器按内容宽度定尺寸、`min-width:0` 压不住, 撑破气泡; 现 `.rq-it` 加 `max-width:100%; box-sizing:border-box; overflow:hidden`, `.rq-tx` / `.rq-who` 加 `min-width:0; max-width:100%` (仍是单行省略)。**Safari 未实测**, Chromium 下该夹具修前也无法复现溢出。
- **唤醒文本里「你要交代」的用法半句按最近 N 次唤醒节流 (admin「"消息回复要用 chat_reply" 不要每次都发, 10 次以内没发才发」)**: 原来每次唤醒、每个 room 段末尾都附 `你要交代: <id> (task, 来自 .x) —— 用 chat_reply({re, text, status}) 交代。` 现在按 wizard 计: 它最近 `rooms.replyHint.window` (默认 10, 热读, 0 = 每次都附) 次成功唤醒批次 (跨 room 同批算一次) 里写过任何 chat_reply 行就只留短形 `你要交代: <id> (task, 来自 .x)` (id 与「这是你的 duty」是事实, 用法是教学; 触发行头本来也带 `[id] .x →`), 批次不足 (新 wizard) 或窗口内没写过则照旧附全句。**账本变化**: 投递成功写的 `seen` 行加 `batch:true` 且同批各 room 共用一个 `at`, fold 进 `Member.batches` (最多 64 个); 老账本没有该标记 = 按新 wizard 处理 (照附, 安全方向)。不影响轮终 / Stop hook 的欠账提醒、overdue、undelivered, rolepage 的 `OWE_RE` 照读短形。逻辑 `shared/room.ts` `replyHintDue`, 测试 `tests/room-hub-reply-hint.test.ts`。
- **删人话信封, 提醒尾巴改在唤醒时挂、不进账本行 (admin 定; FrankDavis 31d5442c.1)** — **协议变化**: ① 人话不再写 `<system-reminder wezard="envelope" kind="human" from=…>` —— 「谁说的」本就是账本行作者, 「哪个群」是 room 唤醒头 `【label】(roomId)`; ② 人话进来时挂的 steward hint / 点名提示 (`peerMentionPart`) / 名册增量不再被 inbound 拼进账本行 text: 账本行只存人的原话 (+ 图片 `@path`), 尾巴在**唤醒渲染**那一刻按「被唤醒的 wizard + 触发它的人话行」现算 (`daemon/wake-tail.ts` `humanWakeTail` → room-hub 新依赖 `tailOf` → `injectText({tail})` 的 `lead` / `via` → `noticeSuffixFor`), 与名册增量同一道边界 (pane 闸放行之后才渲染并记去重; 放行后贴失败 / uncertain 同名册增量, 这次的提示算用掉; 但 busy / gone / requireIdle 失败不消耗, 也不再有「人话到达时就把信箱清空」)。**live 与 reload 同口径**: 人话触发的唤醒贴进 pane 时带 `channel` (绑定 room → 群, dm / adhoc → 私下 `""`) 与 `speaker` (`user:<最后一条人话触发行的作者>`), 不再记成 home / 无发话人; reload 后 `humanOpening` 在有「你要交代」行时只认交代点到的人话行 (同伴 chat_ask 唤醒、未读上下文里有人对别人说的话不再算发话人)。只在触发行里有人话时才挂 steward hint / 点名提示; 同伴 / 回执 / 定时唤醒不挂。典型 admin 人话 (home 群, 38 字): 账本行 119 → 38 字 (管家 312 → 38), 唤醒文本 237 → 156 字 (管家 430 → 349)。**读侧**: `openingOf` 抽成纯函数 `daemon/turn-opening.ts` `turnOpening`, 对无信封的唤醒从头 `【…】(roomId)` 读 channel (绑定 room → 群, dm / adhoc → 私下 `""`)、从触发行作者读 speaker (`user:<id>`, 取最后一条人话行, `shared/inject-view.ts` `humanOpening`); 老转录里的人话信封 (含 `chat` / `chat-key`) 仍照读, rolepage 老数据不丢频道归属。**老行兼容**: 已落账的老人话行 text 末尾还带着尾巴, 读侧 `rowText` (`shared/room.ts`) 对 `origin:"inbound"` 行剥掉**末尾连续的** wezard 提醒块 (保留其后的图片 `@path` 行; 原话中间引用的 `<system-reminder>` 字面量不动), 覆盖 room_read / 唤醒 render 的未读行 / rolepage 气泡 (`toRoomMsg`) / 预览 / 逾期摘要 / 搜索; 老行不改写, id / seq 不变。写侧删 `renderHumanEnvelope` / `envelopeAttrs.human`, `REMINDER_KINDS.envelope` 注释改为「信封只剩定时任务在写, chat / chat-key 老人话属性只读」; charter 「每一轮的注入头带信封…没有信封的就是人说的」改为按注入头 + 行作者讲 (已在跑的 wizard 须 `handoff` 才读到新 charter); CLAUDE.md / contract / dev-guide 同步。新增 `tests/wake-tail.test.ts`, 改 `envelope-human-attrs` / `apprentice` / `pane-delivery` / `wizard-stream`。
- **rolepage 关系图: 节点名字字号 16px → 11px (admin「graph 里 node 的字号用11」)**: 只改 wizard / 用户节点下方的名字 (`.rv-nm`); 图的 viewBox 与屏幕像素 1:1、字号本就是固定像素不随缩放换算, 所以 11 即屏幕上的 11px。名字基线随字号上移 3px 保持与多边形的间距, 布局排斥盒的字高 `GFS` 同步为 11; 多边形、边、room 胶囊文字不动。
- **`chat_ask` 点名多个缺省 room 之外的 wizard 不再 400, 自动落 adhoc (方案 B, docs/evolve/delegate-room-fusion.md §2)** — **协议变化**: 没给 `room`、`to` ≥2 且不全在缺省 room、全是 wizard 时, 落点 = 成员集合恰好是 {你 + to} 的 adhoc (`findSetAdhoc` 复用, 没有就新开, 你是 founder / host); 单个非成员仍落 dm, `chat_say` / delegate 行为不变。守则: 绝不把群外者拉进绑定群; 显式 `room` 照旧交 judge (409); `to` 含人仍 400; 这条自动分支里 `interrupt` 只给每个被点名者的直属 parent (否则 403「自动建的 room 不给 host 打断权」), 新 room 的 host 身份不构成打断绕过。`findPairAdhoc` 改为 `findSetAdhoc` 的特例, `isDirectParent` 提成 shared 纯函数 (hub 与自动落点同一判据)。逻辑在 `daemon/room-auto-adhoc.ts`, 测试 `tests/room-auto-adhoc.test.ts`; chat_ask 描述 / charter / contract §ids 同步 (已在跑的 wizard 须 `handoff` 才读到新 charter)。
- **注入信封瘦身: 删 `chat`, `chat-key` 只在非 home 群时写 (admin 7aeb85fc「reminder 里的 chat、chat-key 是否还有必要保留」, CarolAdams e0ca1c9b.1)**: 人话信封原先写 `chat="<显示名或 chat:wr…>"` 与 `chat-key="chat:wr…"`, 二者在群里值相同、DM 里 `chat="workspace"` 还是个占位词, 而 room 唤醒头 `【群名】(roomId)` 早已带了同一信息。审视结果: `Envelope.chat` 全仓无任何读者, 直接不再写; `chat-key` 唯一读者是 mirror `openingOf` (reload 后恢复这一轮的频道), 其读法 `env.chatKey || home` 在 home 群说话时等于缺省, 写出来是纯重复, 改为仅当人说话的群不是接话 wizard 的 home 群 (学徒跨群) 才写。典型 home 群人话信封由 ~190 字符降到 ~85 字符 (`<system-reminder wezard="envelope" kind="human" from="admin"></system-reminder>`)。**协议属性变化**: 写侧不再出 `chat`; 读侧 (`REMINDER_KINDS.envelope`、`parseEnvelope`) 仍认老转录里的 `chat` / `chat-key`, 历史频道归属不丢。apprentice 宪章「多群」一句改指注入头 `(roomId)`, 已在跑的 wizard 须 `handoff` 才读到新 charter。新增 `tests/envelope-human-attrs.test.ts`。

### Fixed
- **rolepage 成员栏: 没有 human 成员的 room 不再画 human / wizard 之间的分割线 (admin「成员列表的分割线是什么意思，为什么在没有user的会话里，也展示了？」)**: 这条线是 human 组与 wizard 组的分组线 (人在前、wizard 在后, 不写组标题; 判据是成员的 `kind`)。旧判据 `i > 0` 在全是 wizard 时把线画在第 1、2 个 wizard 之间; 现在抽成 `groupBreak`, 只有首位是人且后面有 wizard (两侧都非空) 才画。测试 `tests/member-divider.test.ts`。
- `--resume` 重生死 pane 时不再无条件重挂宪章: 上下文里 (最近一次 `compact_boundary` 之后) 已有宪章块就不挂, 免得每次 idle 回收再唤醒白付 ~5k token; 欠账 / 无 transcript / 被压缩压掉仍照挂 (`charterInContext`)。
- **`tests/graph-layout.test.mjs` 桌面重叠断言 12 对 > 3 (ea07e52 之后回归)**: 不是布局挤压 —— 布局排斥盒 `gBox` 本来就按 `GFS` (11) 算, 是测试里量重叠的 `overlaps` 还按旧名字字高 16px 估包围盒, 把本不重叠的相邻名字量成了重叠。测试改按 11px 量 (桌面 / 手机重叠 12 → 0, 交叉 3, 压边 0), 真实 wezard dev 群关系图 11px 截图肉眼也无挤压; 11px 字号与 room 胶囊 12pt 都不动, 只改测试。
- **空闲回收 ↔ 唤醒重生死循环 (BobZane 每 5 分钟被杀又拉起, 待投的两条 overdue-remind 始终没进去)** — 两个独立缺陷叠在一起: ① `e89db20` 把 `reapIdle` 的活跃口径改成 transcript 最后一条真记录后, resume 重生的 pane 不写新记录、本进程又没见到活动, 下一轮清扫立刻判它「闲了 304 分钟」收掉, 29s 后 hub 再重生它。现 `lastActiveOf` 把 **pane 出生时刻** (pane 内 shell 的 `ps` 年龄, 覆盖 spawn / respawn / clone 各路径) 并进活动时钟取最晚, 仍不信外部 mtime; 另外 `reapVeto` 增加 `wake owed`: room 账本里游标之后还有待投给它的唤醒行 (`hub.pending()`) 的 wizard 不收 (maxPanes 清扫共用此豁免)。② 重生后唤醒贴不进去: 它的 transcript 末尾留着上个进程被杀时没等到结果的 `tool_use`, `idleVerdict` 把「注册表 idle + 悬着工具调用」判成停在审批卡上, `requireIdle` 因此永远 false, hub 对忙 pane 又静默返回 (不打日志, 游标不动)。现 `openToolUses(jsonl, sinceMs)` 只数 CLI 进程启动 (注册表 `startedAt`) 之后发出的调用, 早于它的是上一个进程留下的, 不可能有审批在等 (时间戳认不出仍算悬着)。测试 `tests/idle-reap.test.ts` ⑦⑧。
- **反问过人、人另发新话作答时, 唤醒文本的「你要交代」漏了原 duty (7aeb85fc.376)** — `room-hub` `render` 的 owe 只认被本批触发行碰到的 duty: wizard 对人话 `chat_reply({status:"need"})` 反问 → 人另发一条不带引用的新话 → 只列新那条, 原 duty 仍开着没人提, 60 分钟后被逾期提醒。现追加: 同 room 里它持有、最后一句是 `need`、提问者与本批某条触发行作者是同一个人的 open duty, 排在原条目之后并带「你反问过, 对方的答复可能就在上面」标注; 只是提示, `seen` / `turns` / `defaultFor` 不动 (认进去会让 `for` 从恰好一条变多条而留空)。测试 `tests/room-hub-need-answered.test.ts`。
- **plan 闲时提醒的抑制把「owner 派出、还没交代的 duty」漏了 (FrankDavis 一件活里被提醒 5 次)**: `planHasOutstandingDebt` 只看 owner 持有的带 planId 的 open duty, lead 派完活 (owner 是 asker) 等交代时每次 plan 改 revision 都被提醒。判据抽成纯函数 `shared/room-view.ts` `planHasOpenDuty`: 任一 room 里有带该 planId 的未关 duty (join-req 不算) 且持有者或 asker 是该 wizard。测试 `tests/plan-debt.test.ts`。
- **逾期提醒把「派出子件在推进」当成没动静 (admin 7aeb85fc.399 → wezard-1 派 FrankDavis 干活, 60 分钟后被误提醒、admin 收到「被提醒后仍没有交代」)** — 两处: ① `for` (这件活为哪一笔欠账派的) 工具描述一直写「缺省 = 本轮唤醒你的那一条」却从没实现: `POST /room/ask`、delegate 的 `deliverTask`、spawn_wizard / clone_wizard 带 `task` 的出生即派活都只在显式传 `for` 时才写。现在新增 `hub.defaultFor(uid)` —— 本轮唤醒它 (贴进来的行里有该 duty 的 msg, 或有 `re` 指向它的 trigger 如 overdue-remind / after 补唤醒)、仍由它持有且未关的 duty 恰好一条时返回其 msg id, 零条或多条 (有歧义) 不猜; 这四处 `for` = 显式值 ?? `defaultFor`。② `overdueDue` 加可选 `descendantActivity`, `lastActivity` 并入它: `daemon/room-overdue.ts` 每轮扫描先跨所有 room 建 `for` 血缘索引 (`buildDescendantActivity`: 子行自身 `at`、其 room 里 `re` 含子行 id 的非 daemon 行 (含子件 done 关账)、孙辈递归, visited 防环、深度 ≤ 5; `for` 是名字则忽略), 子件有活动就不算父 duty 空闲, 子件也静止超时才照常 remind。人名下的 duty 不受影响。测试: `room-overdue` (子件活动 / 静止 / 孙辈传递 / 深度上限 / 名字 / daemon 提醒不算) 与 `room-hub` (`defaultFor` 唯一 / 多条 / 无 / trigger re)。CLAUDE.md「Overdue」与 contract 逾期一节同步。
- **空闲回收 (`idleReapMin`, 默认 60 分钟) 此前形同虚设: 闲了十几个小时的 pane 也回收不掉 (admin「超过 1h 没有活跃的 pane 为什么没有回收」)**: 根因是判「活跃」的口径错 —— `reapIdle` 取 `max(本进程见到的活动, transcript 文件 mtime)`, 而闲置会话的 jsonl mtime 会被外部反复碰新 (不是 wezard 写的; 实测 pane `%58` 的 transcript 最后一条真记录在 11:46、mtime 却是 22:42, 一个会话 11 小时没说话看上去只闲了 28 分钟; 20 个 pane 的 mtime 全落在近 1 小时内), 于是每轮 sweep 都判 `recent`、从未收过一个 (daemon.log 里 `idle reap` 零命中, 且 sweep 收不到时本来不留日志, 没法看出它在跑)。现在活动时刻取 transcript 里**最后一条带 `timestamp` 的记录** (新 `peers.lastRecordMs`, 元数据行 `mode` / `permission-mode` / `last-prompt` 本就不带), 没有这样的记录 (刚起、没说过话) 才回落 mtime; pane 上限 (`maxPanes`) 的「最久没动先收」排序同口径。其余豁免不变 (忙 / 停在审批卡上 / 有定时任务 / 人正盯着 / 出生中或注入在途; 只收 pane, 保留绑定与身份)。**每轮 sweep 都留一行 `idle reap sweep` 日志** (`reaped` / `skipped` 原因), 收没收都看得见。`bridge.lastActivity` (roster / delegate 的「最近活动」) 仍读 mtime, 未动。测试 `tests/idle-reap.test.ts` 加 ⑥。
- **delegate / spawn_wizard / clone_wizard 的 `room` 参数此前从没成功过**: 旧顺序先 append task 行、后入座, judge 要求 `to` 是成员 → 新生 / 非成员执行者 409 (delegate 留下没活的孤儿 wizard; spawn / clone 吞掉失败仍报 `dispatched:true`、活静默丢)。现在给了 `room` 就**先验 room 目标** (认得出 + 调用方是成员, 否则 4xx、不生人) → **先入座再 append** (顺序提成 `daemon/room-spawn.ts`, 三条路径共用); spawn / clone 派活失败回 `dispatched:false` + `dispatchError`; delegate 白板分支派不出去时按 stop_wizard end 同一条路径回收刚生的 wizard。charter / `room` 参数描述补「须是该 room 成员」。测试 `tests/room-spawn-join.test.ts`。
- **rolepage 派活行不再把每条 delegate 都标「公开」 (admin「delegate 的『公开』标签是否仍有必要」, DavidBrown 2928c793.1)**: room 模型下 delegate 回包不带 `public`, 提示行回退到 `via==="dispatch" && a.public !== false`, 于是**每条** delegate 都挂「公开」—— 而新生的执行者必落调用方↔它的 dm (admin 截图里的 `e0ca1c9b.1` 就在 `dm:…`)。现在 `Handoff.public` 由回包的落点 `room` 判 (dm: / adhoc: = 不进群; 老回包的 `public` 照旧信), chat_ask 原先的同款特判并进同一处; 标签只标「进群」这一种 (落在绑定群 / 单聊, 人看得见), 「私聊」删掉 (dm 是派活常态, 落在哪个 room 由账本气泡头写着); 落 dm 的 delegate 行随之恢复原文 chevron (与 chat_ask 一致)。「新生 / 选中」(route 决定, 悬停是理由) 保留。只改 `shared/detail-render.ts`, 测试 `tests/tool-hints.test.ts`。融合方案与发现的 `room` 参数入座顺序 bug 见 `docs/evolve/delegate-room-fusion.md`。

## [3.0.0] - 2026-11-22

**3.0 是沟通层的一次重写 (破坏性)。** 一个 room (企微群 / 单聊 / 频道帖 / wizard 之间的 dm / 临时 adhoc) 一份 append-only 账本 (`stateDir/rooms/<id>.jsonl`), 成员、消息与未结 duty 全部由账本 fold 得出 —— 旧的「路由行 + 回执 + 义务」三套账整体退役, `tell_peer` / `wait_peer` / `read_chat` / `send_peer` / `dispatch` 与 jobs / workflow 执行器一并删除, 工具面改为 `chat_say` / `chat_ask` / `chat_reply` / `room_*`, **完成只认 `chat_reply` 的 status**, 终句不再有任何路由语义。严格群 (`chatPolicy.topOnly` / `speech`) 移出 schema; `/name` 下线, 身份切成「类 / 实例」两层 (类 = bot × role × workspace 的人物设定, 实例 = 稳定地址); 旧状态文件 (routes / members / chats / obligations …) 冻结在盘上不再打开, 切换时用 `node dist/cli/migrate-rooms.js` 一次性迁进 room 账本。企微文档 MCP 桥 (`wecom_doc_*` / `daemon/wedoc.ts`) 删除, 改用官方 skill (随包安装、按会话注入)。rolepage 随之重做为 room / role 双维视图, 关系图与时间范围一并换实现。

### Added
- **人也有 duty (admin 要的, OliveOwen 11937e21.1)**: wizard 向人反问后, 人名下开一条要交代的 duty, 人回话关账并**叫醒提问的 wizard** —— 以前 duty 只开给 wizard, 人没点名的回话只唤醒 host, 非 host 的 wizard 反问人之后, 人的答案根本叫不醒它。**开**: wizard 对 asker 是人的 duty 写 `chat_reply status:"need"`, judge 把这些人补进该行 `to`, fold 在人名下开一条新 kind `need` (asker = 该 wizard, msg = 这条 reply 的 id); `chat_ask` 的 `to` 可点名本 room 的人成员 (`human:<userid>`), 开 ask / task (judge 与 MCP 描述同步放开)。**关**: 人在本 room 的下一句话关掉它名下未关的 duty (状态 done, 写进该行 `closes`); 带企微引用时 daemon 把引用正文对回账本里被引用的那行 (`quotedRowIds`, 人话行带 `re`), 命中其中几条就只关那几条, 没引用 / 没命中全关; 提问的 wizard 可对自己开出的人名下 duty 写 `canceled` / `passed`。**唤醒**: 人话关了谁的账, 谁就由 judge 补进这行的 `to` (与点名同义: 唤醒、开 `human` duty、不再把这句当「没点名」落给 host)。**逾期**: 人名下的 duty 不发 remind, 到 `groupMin` 在该 room 写 system 行「⏰ <人> 有一条 .<wizard> 的提问 (<id>) N 分钟没回」(绑定 room 镜像进企微, 非绑定 room 另发提问者 home 群, 提问者已不在 room 则不催); wizard 名下那条若最后一句是 `need` 且它那句 need 在人名下开的账还开着, 不对它计逾期。人不被 pane 投递 (唤醒泵 / Stop hook / 欠账提醒只认 wizard)。charter 的「对人 need 也开账」一条、`docs/room/contract.md`「人也有 duty」一节同步; 前端不动 (`web/chat.js` 的 `DUTY_KIND` 还没有 `need` 的中文名, 暂显示原词)。测试 `tests/room-human-duty.test.ts`。
- **群公告 (room notice): 每个 room 一条, 让 room 里所有 wizard 一直知道一句话 (OliveOwen 13cc3d30.1, admin 同意方案)**: 账本加 `notice` op (与 `name` 同构, 空 = 清除, 上限 500 字, 状态 fold 出来不另存); wizard 用 `room_name` 的新可选参数 `notice` (不新增工具; `name` / `notice` 至少给一个; host 才能改, 非 host 403); 人在企微里 `/notice <文字>` 设 / `/notice` 看 / `/notice clear` 清 (照 `/use` 的授权门, `/help` 有一行), 改的是本群 room。公告变了: 落一条 daemon system 行「📌 群公告: …」/「📌 群公告已清除」(绑定 room 镜像进企微, 不唤醒任何人), 在跑的 wizard 成员下一次注入时随 system-reminder 带到 (经 `notices`, 不额外唤醒); 新 wizard 的 charter 里带一节「本群公告」(没有就不出现); `RoomFact.notice` 进 `/api/room` 与 `/api/world` 的 room 节点 (前端本次不改), `room_read` 单 room 输出头部带一行。契约见 `docs/room/contract.md`, 测试 `tests/room-notice.test.ts`。
- **duty 逾期两级提醒 (admin 7aeb85fc.291)**: 未关的 ask / task / 人话 duty (处理人是 wizard) 距最后一次非 daemon 活动 (原行或 `re` 它的行; daemon 自己的提醒不重置计时, 处理人 `progress` 一句则重新计时) 超过 `rooms.overdue.remindMin` (默认 60) 分钟 → 写 `sys:"overdue-remind"` 的 trigger 行唤醒处理人, 它必须交代; 超过 `groupMin` (默认 120) → 在 duty 所在 room 记一行 `sys:"overdue-group"` system 行, 非绑定 room 再往处理人 (退到提问者) 的 home 群写一行让人看见; 两条 group 行都不唤醒任何人。配置 hot、0 = 关该级, 与看门狗同节拍扫描 (另在启动 20 秒后扫一次), 账本去重 (同一段空闲每级只给一次, 新活动后再空闲会再给), 不自动 canceled、不改账本格式。纯函数 `shared/room-overdue.ts`, 扫描 `daemon/room-overdue.ts`, 测试 `tests/room-overdue.test.ts`。
- **rolepage 关系图: 皇冠 / 礼帽紧贴节点头顶, 不留空隙 (admin 7aeb85fc.270「帽子戴好, 和 node 之间不要留空隙」)**: 此前帽子放在选中环 (r+3.5) 之外, 离圆顶约一个帽高, 节点挤时像是邻居的。现在 `gearY` 按每个节点自己的半径算底边: 帽沿两角落在圆弧上、中段略陷进圆里 (帽画在圆之后, 盖住选中环一小截), 并排时按各自偏移取弧; 固定像素、画在 `.rv-body` 外等既有约束不变。顺带修一处遗留: 皇冠 path 写成 `d=""M…` (双引号), 浏览器读成空路径, **皇冠此前根本没画出来**。
- **rolepage 关系图: host 改戴紫色礼帽, 替掉 room→host 边上的金色箭头 (人 2026-11-22「host 也加一个类似 lead 的帽子吧, 替代现在的箭头」)**: 帽子画在节点圆头顶、固定像素、不压字; 既是 host 又是 lead 时礼帽在左、皇冠在右并排; 图例同步; 成员栏 ⭐ host 与视角 `<O>` 不变。
- **rolepage 关系图: lead 皇冠改小并戴在节点头上 (人 2026-11-22「lead emoji 弄太大了, 能放头上吗」)**: 皇冠不再居中压在圆内, 固定像素 (约 10×8, 不随圆大小), 画在圆上沿 + 选中环之外、水平居中, 并移出 `.rv-body` (不跟呼吸动画缩放); 金线 / 状态色 / 选中环 / `<O>` 视角标记不变。
- **`room_invite` / `room_approve` 加可选 `history` (人 2026-11-22 admin 拍板「history 要带参数」)**: `"none"` | 正整数 N | `"from:<msgId>"` | `"all"` (缺省), 决定被拉者入座时的初始 seen 游标 —— 即第一次被唤醒时能读到的旧话范围 (仍受 ~6000 字未读预算截断, 更早的随时 `room_read`)。游标在同一次 write 里紧跟 join 写一行 `seen`, 不改账本格式; 非直接入座 (转 join-req) 时 invite 的 history 不生效, 回包说明由 host 在 `room_approve` 时选。纯函数 `historyCursor` / `seatSeenOps`, 测试 `tests/room-history.test.ts`。
- **rolepage 图节点显示 lead 与聪明程度 (人 2026-11-21「在graph里展示是否lead、聪明程度」)**: lead = 节点左上角金色 ★ (判据只认 `WizardRecord.lead` —— daemon 在 `lead:true` 派活 / spawn 时写下, 不能自封; 不用「有 children」或「持有 plan」, 管家孩子最多却不是 lead, plan 来去不定); 聪明程度 = 节点半径 1~5 级 (≈6.9…12.5, 不知 = 原来的 9), 由 `shared/smarts.ts` 按**实际在跑的模型** (transcript 的 assistant.model) + effort 折算: haiku 1 · sonnet 2 (high 起 3) · opus / fable / mythos 4 (xhigh / max 5), 与档位表 mini..ultra 一一对上; 认不出家族 (codex / 别家 / 冷会话没 model) 才回落出生档位 `WizardRecord.tier`, 都没有就不画 (set_model 换模型后跟着变, 档位只记出生那一刻)。右上角是视角徽标 (rv-pov), 外圈是选中环, 三者互不占位。节点 tooltip 写全 (`★ lead · 聪明 4/5 · Opus 5.5 · high (依据: 实际模型)`), 左上名片 facts 末尾加「★ lead」「🧠 4/5」, 图例加「★ lead」「大小 = 聪明 1~5」; 图的高度改为按图例实测高度留余量 (手机上图例折两行时第二行不再压到底栏下)。数据侧只读: `WorldFactWizard.tier/lead` → `WorldNode.effort/lead/smarts`, 老 daemon 快照 / svr 名册缺席时字段整个缺席、前端不画。候选对比 (信号格手机上不可读 / 外圈双线与选中环撞) 见交代。
- **wizard 能截网页了: `scripts/shot.mjs` + `scripts/shot-setup.sh` (人 2026-11-21「为什么你没有web截图能力，补全」)**: 本机没有任何浏览器, 前端改动只能 vm 桩 / 看代码验证。`node scripts/shot.mjs --role <名字|target>` 用 headless chromium 给本机 rolepage 截 png (`--mobile` 窄屏、`--full` 整页、`--selector` 元素、`--click` 先点再截、`--wait-for` / `--wait`、`--url` 任意地址、`--out`), 默认落 `~/.wezard/shots/`, 末行打印绝对路径, 截完用 `send_file` 发进群。票据 (`?id=`) 现从守护进程的 `details.jsonl` 取最新一条 turn, 不硬编码、不进仓库, 输出里一律抹成 `<ticket>`。省内存: 单实例锁 (并发只许 1 个)、单进程 + `--disable-dev-shm-usage` / `--no-sandbox`、截完立刻关浏览器 (实测峰值 ~300MB)。`shot-setup.sh` 一次性、不用 sudo 装好: playwright 的 `chromium-headless-shell` (~290MB, `~/.cache/ms-playwright`)、浏览器缺的系统库 (`apt-get download` + `dpkg -x` 到 `~/.cache/wezard-shot-libs`, 脚本自动挂 `LD_LIBRARY_PATH`)、中文 + emoji 字体 (`~/.local/share/fonts/wezard-shot`, 否则全是方块)。`playwright` 只进 devDependencies, 不在 `files` 白名单里, 不进发布包。顺带修 `tests/room-graph.dom.mjs` 的两处断言漂移 (节点 textContent 带悬浮提示; 左栏视图记在 localStorage 后第二次进页面不能再点「图」), 它现在能真起浏览器跑, 仍在「视窗缩放」一段 (约第 332 行) 超时 —— 真页面缩放正常 (svg 537→687), 是 fixture 与现布局不符, 待查。
- **企微文档 skill 随包安装 (人 2026-11-22「可以，做吧」, 7645019 的按会话注入之后)**: 包内新增 `skills/wecom-unified/` (193 文件, 上游 `WecomTeam/wecom-unified` main 的副本, MIT 声明放 `skills/LICENSE.wecom-unified.txt`, 不放进 skill 目录 —— 多一个文件就破坏「内容全同才收编」), 物化到 `<stateDir>/skills/<name>/` 后照旧由 `--plugin-dir` 按会话挂进 pane。物化不是 rsync: `shared/skill-sync.ts` 的 stamp (`<stateDir>/skills/.wezard-skills.json`) 记下每个写过的文件的 sha, 只覆盖「盘上仍是我们上次写的那版」的文件 —— **用户改过的 / 删过的 / 自己建的同名文件一律不动**, 上游删掉的文件不连坐 (从 stamp 摘掉、盘上保留), 整目录被删过就记 `removed` 不再自动复活; 无 stamp 且内容与包内逐文件相同 = 手拷 / 别工具装的 → **收编** (只写 stamp 不动盘), 内容不同 = 用户自己的 → 一个字节不碰。触发两处: `wezard init` 收尾 (默认装、不询问; 不要的人 `wezard skills remove` 之后不再打扰) 与每次 spawn 前的 `prepareSessionSkills` (老装升级 npm 后第一次 spawn 自动合并; version + 内容签名都没变则一次盘都不读)。新命令 `wezard skills [list|install|remove|pin|unpin]` (install 清掉 removed / pinned 并按包内装回但不覆盖本地改动, `--force` 才覆盖; `update` 从 GitHub 拉是二期, 本期跟发版)。skill 自身首次使用会装 `@wecom/cli` 并 `auth init`, 离线只是那一步失败; 已在跑的 pane 要新会话才读到新内容。测试 `tests/skill-sync.test.ts`。

### Fixed
- **rolepage: 点哪个实例就进哪个实例的页 (人 2026-11-22「1 和 15 是一个身份 class 的两个 instance, 应该是完全独立的节点, 也是独立的会话, 所以不应该混杂起来」)**: 删掉 P7 ⑦ 的身份聚合 —— `shared/role-view.ts` 的 canon / 规范 target / 名字 → 锚点 / 跨实例状态合并 / `allMessages` 的 from·to 改写。那一版把同 identity 的实例收敛到「target === identity」的那一个 (本机正好是 wezard-1), 于是点 wezard-15 落到 wezard-1 的页面, 高亮与 URL 也回写成它, 页里还没有 wezard-15 自己的轮次 (sessions / stats 本就按 exact target 算)。现在 `resolve` 对精确 target 与名字都返回它自己, 状态只看自己那条事实, 消息 from/to 不改写; 前端「链接指向 X 与它是同一身份的化身」提示随之删除 (`web/chat.js`)。测试 `tests/role-identity.test.ts` 按新口径重写 (旧断言随实现下线)。
- **`room_leave` / `room_transfer` 认不出「只剩成员行的 wizard」**: 迁移 / 实例结束留下的成员, 名册里已经没有它的 uid, 而 `who` 只走名册解析 (`whoRefOf`), host 永远移不掉 (报「认不出这个地址」)。现在加一层本 room 成员表兜底 (`memberRefOf`): 裸 uid、`uid:<uid>`、成员显示名都认。
- **handoff 简报回贴永远判「不确定」 (OliveOwen 750b7ec9.1)**: 简报其实贴进去了, daemon 却因 `框空了且转录里始终没有这一笔` 放弃。根因: 提交确认认转录 user 行里的 `carriesMsg(text, eventId)`, 而无信封注入的 message-event 标记 (`withMsg`) 在 room 账本重构删旧沟通层时连调用一起丢了, 带 eventId 的无信封注入永远确认不了。现在 `MirrorBridge.injectText` 经纯函数 `envelopeFor` (`shared/reminder.ts`) 补标记: 无信封 + eventId 才补, 已有信封 (room 信封里的 msg) 不改写, 斜杠命令与无 eventId 不加。测试 `tests/inject-event-marker.test.ts`。注: handoff 后「继续 <event>」续答的 `deps.resume` 在 `daemon/index.ts` 里仍是 `async () => ({ ok: true })` 空桩, 不注入任何东西, 本次未动。
- **svr 重启后名册 / 关系图不再空几十秒 (OliveOwen 710fb7d2.1)**: `factsBySource` 只放内存, 重启后要等 daemon 下一次 30s 推送才补齐。现在每次 `POST /w` 后整份原子写 (临时文件 + rename) 到 `<stateDir>/facts.json` (失败只 warn), 启动时读回且只留 `at` 仍在 `FACTS_TTL_MS` (150s) 内的条目 —— 停机久了的自然过期, 不会让陈旧名册冒充现状; 文件缺失 / 损坏当空。读写抽成纯函数 `svr/facts-store.ts`, 测试 `tests/svr-facts-store.test.ts`。推送协议不变。
- **duty 逾期提醒: 独立审查的 6 条修正 (cc80495 之后)**: ① group 级要等同一条 duty 的 remind trigger 被处理人的 `seen` 游标越过才报 (remind 关为 0 时只看自己的阈值), 不再在提醒还没投递时就对群说「没有动静」; ② remind 的 append 不走唤醒预算 (`budget: MAX_SAFE_INTEGER`, 与 `reconcileAfter` 同理), 预算用尽时不再 wake=[] 却被去重当成给过; ③ 每条 duty 单独 try/catch, home 群通知也包 try/catch (失败不补发, 宁可漏一次也不重复刷群), 一个损坏的 room 不饿死后面的; ④ 计时与去重按 holder 算 (`ask to:[B,C]` 的两条 duty 互不影响; 活动 = holder 自己的行 + 提问者的补充; remind 去重要求其 `to` 含当前 holder; group 行 `sys` 改为 `overdue-group@<holderUid>`); ⑤ `room_transfer` 的 move 算活动 (`Duty.movedAt`, 只是 fold 多记一个时间戳, 账本格式不变), host 槽位以当前 host 入座时间为下限, 新 holder 重新计时并能重新收到提醒; ⑥ holder 不是当前成员或名册上查无此人的 duty 直接跳过 (归 watchdog 的 canceled 路径)。

### Changed
- **rolepage 成员栏: 按状态着色的聪明程度多边形直接取代最左边的状态点 (admin 「直接代替成员列表里左边的icon呀」, wezard-1 5233eb86.1)**: 名字右边那个中性灰多边形删掉, 最左一格改画同一个多边形, 填色 / 虚线 / 白底沿用关系图节点 (工作中绿 / 等审批红 / 空闲灰 / 休眠 = 虚线 / 缓存冷白底); 状态文字并进 hover (学历 + 状态); 人仍是 👤; profile 页头原本没有状态点, 聪明程度图标保持中性。 **返修 (admin 「sidebar里绘制聪明度的时候没有虚线呢，需要完全对齐」, wezard-1 64444fbe.1)**: 成员栏图标不再另画一份缩小的多边形, 而是 `smartsIcon` 直接用关系图节点的几何 —— `polyEl(sides, NODE_R, 'sh')`, viewBox 按节点坐标系 (±11.5), 显示 20px ≈ 节点原尺寸 (缩放 0.87), stroke / dasharray / 顶点随比例一致; 样式不再有 `.smi` 专用色值, `.rv-person.wizard.st-* .sh` 与 `.smi.st-* .sh` 共用同一条选择器 (一处改两边同步), 删掉「休眠 = 无填充细实线」那条规则; profile facts 行的图标同源 (中性灰)。
- **rolepage: profile 卡与 room 成员栏的聪明程度改用与关系图同一套多边形 (admin: 「聪明程度都采用 graph 中的方式来表现」)**: 抽出 `polyEl` / `smartsIcon` (`web/chat.js`), 图、图例、wizard 页头、成员栏共用同一形状定义; 学历 emoji + 文字不再占位, 只进 hover title; 中性灰, 无 smarts 画五边形。
- **rolepage 关系图: 去掉选中时的方括号 `[ ]` (admin 「把选中时的中括号去掉吧，文本的特征足够了」, wezard-1 37fff12f.1)**: 选中的 wizard / 用户节点与选中的 room 胶囊都不再画括号 (连同 `brackets()` / `povMark` / `selMark`、`.rv-pov` / `.rv-rsel` / `.lgpov` 样式、图例「视角」一项), 选中态只剩名字蓝色加粗 (`.on`) + 提到最上层; 可见性规则 (dec50c8) 不动; `tests/room-graph.dom.mjs` 改按 `.rv-person.on` 找视角节点。
- **rolepage 关系图: 可见性简化成一条规则「窗口内有消息的 room → 它的成员」, 视角 / 选中标记由 `< >` 换成方括号 `[ ]` (admin 「用中括号代替 chevron 吧。然后, 时间范围筛选有消息的 room, 并展示 room 中成员, 这样逻辑简单一点」, wezard-1 4eb0992c.13)**: ① 范围 = room 最后一条消息 (`room.last.at`, 已在 `/api/world` 的 room 节点里, 没加数据) 落在窗口内 (「全部」= 所有 room), 外加正在看的那个 room (滑出窗口也不从眼前消失, 与列表同口径); 展示这些 room 的成员 (wizard + 人) 与连线, 群 / 多人 room 画 room 节点, 两人 wizard dm 仍收成直连线。② 删掉的分支: `activeWizards` (窗口内活跃 / 正在跑的 wizard 直接上图)、`roomNodes` / anchors (只有非两人 dm 才带来成员)、图里的「未读 / 未决 duty 把窗口外 room 拉回范围」(列表口径不动)、「dm 有未读带出对方」。**后果**: 只在 turn 里干活、没发过窗口内 room 消息的 wizard 现在会被隐藏。③ `chevrons()` → `brackets()` (节点视角标记 `povMark` 与 room 胶囊选中 `selMark` 共用), 图例「视角」同步成 `[ ○ ]`; 蓝色加粗名字、提到最上层不变。`tests/room-graph.dom.mjs` 的 LeoLane / 未读 / 红点用例按新规则改写。只改 `web/chat.js`。
- **rolepage 关系图: 选中的节点 / room 不再有任何描边 / 圆环高亮, 统一只靠「两侧 `<` `>` chevron + 名字蓝色加粗」 (admin 「选中的 node 就只是高亮 border 吧, 现在再加一个圆就不太合适了」→「remove border highlight, just left and right chevron is enough」→「active room node and role node 的文本颜色可以改成蓝色, 加粗」, wezard-1 4eb0992c.4 / .7 / .8)**: 去掉 wizard / 用户节点选中时外套的 `.sel` 圆环, 选中节点本体描边不变 (多边形 / ultra 的圆照状态: 工作中 / 空闲 / 休眠虚线 / 缓存冷白底); 选中的 role (wizard / 用户) 与选中的 room 胶囊, 名字都变 accent 蓝并加粗, 胶囊底色 / 边框不加高亮 (原来的蓝底蓝框也去掉); room 胶囊选中时也带两侧 `<` `>` (`selMark`, 与节点视角标记 `povMark` 共用 `chevrons`, 类名 `rv-rsel`), 加粗后每字更宽, 胶囊宽度相应放宽 (9.3→10.8 px/字), 字不溢出。chevron 失去圆环衬托后略放大加粗 (高 ±5→±6.5、外探 r+9→r+11、线宽 2.2→2.8, 图例同步); 选中节点 (含 chevron) 在 `syncGraphDom` 里提到节点层最上面, 不再被邻近名字的白色描边盖住一截 (只在选中节点后面还有别的节点时才挪)。非选中 / hover 态不受影响, 边的选中高亮不动。只改 `web/chat.js`。
- **rolepage 关系图: 聪明程度改用多边形边数表示, 节点大小统一 (admin 「聪明程度能否通过多边形体现, 小学生是三角形, 每高一级多一个边」, wezard-1 4eb0992c.2)**: wizard 本体按 `smarts.level` 画正 n 边形 —— 1 级三角形 · 2 级四边形 (平顶方块) · 3 级五边形 · 4 级六边形 · 5 级 (ultra) 圆 (边数的极限; 没取七边形, 免得六 / 七边在 20px 上数不出来); 没有 smarts (老快照 / 别家模型又没档位) = 五边形 (中号, 同以前「都没有 = 中号」)。节点半径统一 10 (不再随聪明程度 6.9~12.5), 状态填色 / 休眠虚线 / 缓存冷白底都走同一个 `.sh` 样式、与形状无关; 选中环仍是圆, 命中区域与名字位置按统一半径, 帽子 (host / lead) 偶数边戴在平顶上。图例由「大小 = 聪明程度 (小学生→专家教授)」改为「边数 = 聪明程度」(三角 + 圆两个小图标), 学历对照收进 hover tooltip; 全仓 grep 该句只此一处。只改 `web/chat.js`; `tests/room-graph.dom.mjs` 加边数用例。
- **(已被下面「窗口内有消息的 room → 成员」取代) rolepage 关系图: 去掉渐进展示, 改回按活跃窗口展示 (admin 原话「时间范围内活跃的会话都要展示出来, 时间范围内没有活跃的、同时没有其所属的 room 节点在展示的, 就隐藏起来 (单聊视为没有 room 节点)」, wezard-1 4eb0992c.1)**: 此前 (1277c7f) 参与者只从「锚」room 里取, 一个窗口内明明在干活的 wizard 只要没进多人 room 就不出图。现在 (`web/chat.js` `renderGraph` / `activeWizards`) 窗口内活跃的 wizard (最近动静落在窗口内, 或正在跑; 「全部」= 名册里所有) 一律展示, 不依赖 room; 窗口内不活跃的只随所属 room 节点 (群 / 单聊 / 多人 room, 外加正在看的那间 dm) 的成员一起出现, 只靠两人 dm 连着的隐藏; 两端都在图上的 dm 仍画成直连线。dm 有未读不再单独带出对方。图标 / 缓存冷白底 / LeoLane 规则其余部分不变; `tests/room-graph.dom.mjs` LeoLane 一段按新规则改写并加「活跃但只靠过期 dm」「正在跑」两个用例。
- **rolepage 右侧成员栏重做: 每成员一行 + 顶部群公告 (admin 7aeb85fc.291「现在不好看」, OliveOwen 850bee9d.1 / .2)**: 一行 = 状态点 · 名字 · 👁 视角 / ⭐ host / 👑 lead 图标 · (待交代 N 红标, 点开 duty 明细照旧) · 最近发言时间; 不再写「成员」这种默认值, 学历 / 后端 / 入群方式 / 状态词进 hover tooltip, 只有「等审批」留字。人在前、与 wizard 之间一条细线; wizard 按 host → 忙 / 等审批 → 最近发言排序; 冷 / 窗口外淡灰的判据不变。栏头压成一行「成员 N · 待交代 M」(建于时间进 tooltip, 不再重复写 host 名)。栏顶新增 📌 群公告 (读 `/api/room` 快照 `room.notice`, 空则不显示; 默认两行省略, 点开展开全文); 栏宽 236→252px, 窄屏抽屉行高加大。只动前端 (`web/chat.js`), 不改后端与接口; `tests/room-graph.dom.mjs` 成员栏断言按新结构重写并加公告用例。
- **rolepage 图: 视角 role 不在任何可见 room 时仍画成带 👁 的孤立节点; 列表角标与图上红点都显示未读数 (admin 7aeb85fc.288 C「可以画成孤立节点」/ D「列表和图里都展示未读数」)**: C —— 这种情形真实存在: 点进 / 深链到一个所有 room 都被时间范围筛掉的 role (例: 只出现在 3 天前群里的用户, 或只剩一间过期两人 dm 的 wizard; 上一条收紧 duty 豁免后更常见), 以前图里根本没有它, 👁 无处可挂; 现在 `povLoneNode` 把它补进 people (名册里有的, 或 `human:` / `uid:` 形态), 不重复画已在图里的视角。D —— 列表 room 行右下角标由「未决 duty 数」改成未读数 (`unreadOf`, 与图上红点同一个数, 窄屏同), duty 数挪进该行与图上 room 节点的悬停提示 (成员栏的「待交代」不变)。只改 `web/chat.js`。
- **rolepage 时间范围: 窗口外但有未读的 room 也算在范围内 (admin 7aeb85fc.288 时间范围 B「可以」)**: `roomInScope` 加「视角有未读」(与列表角标 / 图上红点同一个 `unreadOf`)。顺带修一个口径错: 服务端对「视角不是成员」的 room 游标按 0 算, 会把整本账数成未读 (别人的 dm 也一屏红点 / 被 B 拉进范围), 前端 `unreadOf` 现在只认视角自己是成员的 room。只改 `web/chat.js`。
- **rolepage 成员栏: 窗口外没发言的成员淡灰 (admin 7aeb85fc.288 时间范围 A「按推荐」)**: 成员栏里「N 天前发言」超出所选时间范围 (含还没发言) 的成员, 整行文字淡灰 (class `out`, 悬停说明「窗口 (2d) 内没有发言」), 图不动; 切时间范围时成员栏跟着刷新。只改 `web/chat.js`。
- **rolepage 关系图: wizard 只随多人 room 一起展示, 只靠两人 dm 连着的不再出现 (admin 7aeb85fc.288「检查下 Leo 为什么还在图里展示, Leo 没有直接加入一个多人群, 如果没有消息就不应该展示了; 多人群的成员可以随多人群本身一起展示, 但是其他的就没必要了」)**: 原因 —— 图的参与者取自范围内**所有** room 的成员, 两人 wizard dm 在图上虽然收成一条直连线, 却把两端 wizard 一并拖进来: LeoLane 没加入任何群, 只因与 wezard-1 / IrisIrwin / JackJones 的三间 dm 在窗口内 (11h 前) 有消息就出现; 另一位 Leo (workspace 的派活) 的 dm 窗口外, 却因一条一直没人交代的未决 duty 被 `roomInScope` 放行而留下。改后: 参与者只取自「锚」room (不是「只有 wizard 的两人 dm」的一切 room, 外加正在看的 / 视角有未读的两人 dm), 其余两人 dm 不带来任何新节点 —— 两端都已因别的 room 在图上才画直连线, 否则整条不画; 与窗口无关 (选「全部」也一样)。时间范围对 room 的口径不变 (列表照旧列窗口内有动静 / 有 duty 的 dm)。`tests/room-graph.dom.mjs` 加 LeoLane 形态用例 (dm 窗口外 + duty / 窗口内 / 选「全部」都不出现; dm 有未读 / 多人 room 带 duty 或窗口内有动静则出现), 旧用例里 carol 改为随一间三人 room 展示。只改 `web/chat.js`。
- **rolepage 关系图: 缓存冷改成「节点填充变白」, 叠加在空闲 / 休眠之上 (admin 7aeb85fc.288「缓存冷改为 node fill 变白色, 在空闲和休眠 node 内都生效」)**: 改前 `stateOfNode` 把「pane 在、没在跑、缓存冷」单列成第五种状态 `stale` (白底), 休眠永远是休眠灰、看不出冷; 改后状态只剩 working / blocked / idle / asleep 四种, 冷是独立的叠加属性 (`coldOfNode`, class `cold`): 空闲且冷 = 白底实线, 休眠且冷 = 白底虚线, 工作中 / 等审批不受影响。服务端只给 pane 在的 wizard 报 `cacheCold`, 休眠的没有这个事实, 前端按「最近动静超过 5 分钟 (提示缓存最短 TTL) 或没有动静记录」估。图例改成 空闲 / 休眠 / 缓存冷 = 白色填充, 成员栏状态点同步 (`闲 · 冷` / `休眠 · 冷`), tooltip 追加「缓存已冷」。只改 `web/chat.js`。
- **rolepage: room 图标改三种 (admin 7aeb85fc.288「群聊换成👥, 恢复原来的💬那种 room, 我才注意到是人和 wizard 的单聊 room, 这个允许保留特殊性」)**: 多人群聊 (企微群 / topic / 多人 adhoc / 人 + 多个 wizard …) = 👥; 人与 wizard 的单聊 (恰好两位参与者、其中一位是人、且不是企微群 / topic 帖, 即绑定的 wecom-dm) = 💬 (唯一保留 💬 的特例); 只有 wizard 的 room = 🧙‍♂️。图节点 / 列表兜底头像 / 搜索命中 / 图例同步 (搜索命中能在 W.rooms 找到就走同一套三分), 类型文字仍只在 tooltip。只改 `web/chat.js` 展示, 不动 API / 账本; `tests/room-graph.dom.mjs` 加 `__extraRooms` / `__extraNodes` 钩子与单聊 / adhoc fixture。
- **rolepage: chat detail = f(选中的 room, 当前 role), 选中 room 时标题行出「×」取消选择 room (admin 7aeb85fc.276)**: 只选 role = 「<role 名> 的全部聊天记录」; 选中 room = room 名, 同一行右侧挂淡色「👁 <role 名>」(视角的体现) 和一个 32px 触控区的 × (线描, 与返回键 chevron 同套; hover「取消选择 room」), 点它只清 room、保留 role, 回到该 role 的全部记录, URL `room=` 写空串 / 浏览器返回照旧 (走 `toggleRoom`, 窄屏同样压一格历史)。点图 / 列表 / 成员栏 / 消息作者名 = 选 role, 点图 room 节点 / 列表 / 消息里的 room 名 = 选 room, 沿用旧元素, 没造新交互; 不改后端 API 与账本。`tests/room-graph.dom.mjs` 同步: 头的断言改为「视角标在标题行而非 `.rv-sub`」并加点 × 的用例。
- **rolepage: 标题行 × 挪到 room 名与 role 之间 (admin 7aeb85fc.283「现在那个 x 放在 room 和 role 中间, 表示对前者的消除」)**: 由 `room 名 · 👁 role 名 · ×` 改成 `room 名 × 👁 role 名`, × 的语义是「消除前者 (取消选择 room)」; 点击行为、hover 提示、32px 触控区、窄屏标题先让位都不变。「只选 room、不选 role」不做 (× 仍只在有 role 时出现)。`tests/room-graph.dom.mjs` 加标题行顺序断言。
- **rolepage: room 图标精简成两种 (admin 7aeb85fc.283「只需要保留表示有人参与的群聊 emoji 和只有 wizard 参与的 wizard emoji」)**: 此前图节点 / 列表兜底头像 / 搜索结果按 kind 区分 👥 💬 📌 🟢 🧙 ◎ 六种, 现在只剩 💬 (有人参与的群聊) 与 🧙‍♂️ (只有 wizard 的 room, 与 wizard 默认头像同一个), `KIND_IC` 删除; 图例同步加这两项; 类型 (企微群 / 企微单聊 / topic 帖 / 微信 / wizard 两人会话 / 临时多人 room) 只留在图节点 (新增 `<title>`) 与列表项的 tooltip 文字里。判据沿用 `isPeopleRoom` (绑定企微 / topic / 微信或成员里有人), 与列表「群聊 / 会话」分组、搜索 `group` 同一口径, 所以绑定了但还没人发过话的群也是 💬。
- **rolepage: lead 标记改 👑、聪明度改学历梯度 (人 2026-11-22 admin)**: lead 不再用 ★ (易与 host 的 ⭐ 混), 图节点 / 图例 / 成员栏 / 名片 / tooltip 全换皇冠; 聪明度不再显示 `3/5`, 改 🧒小学生 · 🎒初中生 · 🎓大学生 · 🔬研究生 · 👨‍🏫专家教授 (节点半径随档位变大不变, `shared/smarts.ts` 未动)。

### Removed
- **BREAKING: 删除企微文档 MCP 桥 (OliveOwen 906947d2.1, admin 定)**: 删 `wecom_doc_list_tools` / `wecom_doc_call` 两个 MCP 工具、daemon 的 `POST /wedoc/{list,call,invalidate}` 路由与 `daemon/wedoc.ts`, 不留兼容; 企业微信文档 / 智能表格统一改用官方 skill (按会话经 `shared/session-skills.ts` 注入)。配置里没有 `wedoc` 段, 无需迁移。`charterExempt` 里两项待办一并删除, `技术说明.md` / `README.md` 同步。
- **`daemon/peers.ts` 删掉回执时代的死代码 (~260 行)**: 收口解析 `parseClosing` / `topLevelText` / 行首归一化 `unquoteMarkLine`、署名解析 `addressedResults`、关键字判定 `receiptKeyword` / `completionKeyword`、标记剥离 `stripClosingMark` / `stripForChat`、交接判定 `replyClosedBefore` / `openingTurn`、信封 `renderTaskEnvelope` / `renderPeerEnvelope` / `renderReceiptEnvelope` 与未用的 `tailTurns` —— 完成已只认 room 账本上 `chat_reply` 的 status, 这些函数没有生产调用者 (`tsc --noUnusedLocals` 逐轮确认可达性)。`tests/chat-record.test.ts` 去掉只测 `renderReceiptEnvelope` 措辞的一条断言。
- **rolepage 的 `/chat/vendor.js` 不再拼 d3 (~280KB 未压缩)**: 关系图早已换成自写的 stress majorization (`e93cdb7`), `web/chat.js` 不引用 `d3`, 而它仍被拼进每个冷加载的 vendor.js; `web/d3.min.js` 也从未进 `files` 白名单, 发布包里本就缺席。删文件, `chatVendor` 只拼 markdown-it + highlight.js。
- **企微侧 `/model` 改为 daemon 自答 (人 2026-11-21「会卡住」→「/model 的实现, 换成 daemon 去查接待 wizard 的 model」)**: 它从来不是 daemon 的命令, 只是未知 slash 被原样注入 pane, TUI 弹出交互式模型选择器, 等不到结果就卡住 pane。现在 `daemon/inbound.ts` 在授权后拦下 `/model [..]`, 绝不注入 pane, 由 daemon 查接待 wizard (这条消息路由到的会话, 含 slot / `.name`) 的 `bridge.sessionInfo`: 模型取 transcript 最近一轮 assistant 的真实 model (`lastModel`, 绑定里只是启动参数, 兜底), 回 `[wezard] .name 当前模型: <model> · effort <e> · cli <backend>`; 无会话回「当前无活会话, 新会话用 <默认 cli> 默认模型」; 带参数仍不切换, 附「换模型请让 wizard 用 set_model 或改 config」。`/help` 补 `/model`。MCP `set_model`、`POST /wizard/model`、config 的 model / tiers 不动。

### Changed
- **dm 是 room 的特殊形式; 多人后不再落进它 (人 2026-11-22 admin 拍板「多人后要私聊就另开 room」)**: dm 被拉进第三人后, 「单个非成员 to → 自动落 dm」不再落进这个多人 room, 而是找当前成员恰好是 {A, B} 的 adhoc (多个取最近活动), 没有就新开一个 (`openAdhoc` 与 `room_open` 共用)。显示上 `room_name` 起的名字对 dm 也生效, 成员多于两人时列全员 (`roomLabel` / `roomShortOf` / rolepage `roomTitle`), 不再写「A ↔ B」或「私聊」。纯函数 `planDm` / `findPairAdhoc` (shared/room.ts)。
- **rolepage 四件展示活 (人 2026-11-22 admin 7aeb85fc.204)**: ① 名片「🏠」= wizard target key 的 base principal 那个聊天 (主群), **不是 creator**; 原先只写群名像 wizard 名 (如 `wezard-1`) 读起来像创建者, 现在写「🏠 主群 <群名>」(取 room 列表里的显示名, host 起的别名优先; `RoleInfo` 加只读 `chatId`), 有 parent 的另起「👤 创建者 <名字>」; 名片 facts 行高 1.45→1.75, emoji 不被挤。② chat title 的返回键 (`#tb-back` / 跳转返回 `#tb-jb`) 换内联 SVG chevron (线描 1.5 圆头, 与侧栏「列表 / 图」图标同一套), 触控区 36×36。③ 未选中 room 时 detail 标题 =「<role 名> 的全部聊天记录」(替换「所有 room」; 选中 room 仍只写 room 名)。④ room 成员栏改版: 「未决」改名「待交代」(= 本 room 账本里 chat_ask / 派活 / 人话开出、处理人还没 chat_reply done · passed · canceled 的 duty); 每成员 = 名字 · 角色 (⭐ host / ★ lead / 人 / 成员) · 状态 (忙 / 闲 / 冷 / 等审批, 复用图的 `stateOfNode` 与配色) · 聪明度 · 最近发言; 名下有待交代的挂可展开红标 (#seq · 提问者 · kind · 摘要, 点一条定位到消息); 栏头 = 成员数 · host · 建于 · 待交代总数。窄屏 (原先 gside 直接隐藏) detail 头右侧出「👥 N」入口 (有待交代带红点), 把同一份成员栏铺成底部抽屉。`/api/room` 只读加字段: `duties[].holderName` / `summary`、`members[].lastAt`、`createdAt` (不改账本语义)。tests: `room-view` / `room-view-api` / `room-graph.dom` (含窄屏抽屉) 同步。
- **rolepage: 人在群里直接对 host 说的话, 气泡头补上收件人 (人 2026-11-22 验收追加)**: 人没写 `to` 也没 `re` 的话 (如 wezard dev 群里 admin 的直接发言), 气泡头此前只有 `A —room→`、缺收件人 —— 显式 `to` 与服务端按 `re` 补的 `reTo` 对它都是空。收件人在账本行的 `wake` 里 (那一行当时唤醒了谁 = host / 被点名者, 显式事实): `wireMsg` (`shared/role-render.ts`, `/api/room` 与 `/api/wizard` 共用) 对 author 是 human、无 `to`、无 `reTo` 的行补 `wakeTo` (wake 里的 wizard → `{kind:'wizard', id}`); 前端 `recipientsOf = to || reTo || wakeTo`, wake 为空才退回只画 `A —room→`。不按「现在的 host」推 (host 是读时现算, 历史上会变), wizard 自己的行不套 wake (它们的 to / reTo 语义不同)。新增 `tests/wake-to.test.ts` (有 wake 无 to 的人话带 wakeTo / 有 to 的不带 / wizard 行不带 / 人 re 了别人的行不带 / 按行上 wake 而非现任 host / wake 空不带), `room-view-api` 与 `room-graph.dom` 补断言。
- **rolepage detail 头精简, 删「取消选中」与「只看与我相关 / 全部消息」按钮 (人 2026-11-22 验收追加)**: ① 头不再重复视角: 选中 room 时标题 = room 名 (删掉 sub 行「👁 X 的视角」), 未选中时标题改成中性的「所有 room」(名片已经说明是谁); ② 删「✕ 取消选中」按钮, 取消选中只剩: 图里再点选中的 room 节点 / 选中的 edge, 列表里再点选中的 room —— **窄屏也一样**, 点已选中的项 = 取消选中并进入 detail 看 role 的全部记录 (去掉之前「窄屏点选中项只回 detail、保持选中」的特例, 否则手机上没有取消入口); ③ 删「只看与我相关 / 全部消息」按钮及整条 `all` 链路: 前端 `D.all` / URL `all=1` (老链接里的会在第一次同步时抹掉) / 返回栈里的 all, 服务端 `/api/wizard` 的 `all` 参数与回包字段, `wizardMessages` 的 `all` 选项与 `everMember` (除 rolepage 无别的调用者; MCP `room_read` 的 `all` 是另一套, 保留) —— wizard 视图固定「与它相关」(它说的 / 点名它的 / 回它那几条的)。`tests/room-graph.dom.mjs` / `room-view*.test.ts` 同步改断言, 并新增手机列表点选中项取消的断言。
- **rolepage 关系图: lead ★ 居中、视角画成 `<O>` (人 2026-11-22「lead的star可以放在正中间，视角node，可以通过 <O> 来表示」)**: ★ 从节点左上角挪到圆的正中间, 大小随圆 (约占直径 80%), 改成亮金 `#f5b301` 加深棕描边, 在工作中绿 / 等审批红 / 空闲灰 / 缓存冷白各种底色上都看得清 (跟着 `rv-body` 一起呼吸)。视角不再是右上角蓝底眼睛徽章, 改成节点左边一个 `<`、右边一个 `>` (accent 蓝, 画在选中环之外), 照人原话的字面; 类名仍是 `rv-pov` (测试按它找当前视角)。图例同步。(配套 CSS 已随 81dd737 的整行 CSS 一并提交。)
- **rolepage 关系图: 节点与文字固定像素, 不随画布缩放 (人 2026-11-22「node 和 text 的size 要fix，不随画布缩放改变，text size用 12pt即可」)**: 此前图靠 svg viewBox 适配面板, 节点 / 字 / 线宽都跟着缩, 还要 `--lbs` 把标签放大回去 (封顶 1.5 倍)。现在 viewBox 恒等于画布像素 (1 单位 = 1px), 视野的缩放 / 平移只作用在节点中心的坐标上 (`gView` / `drawPos`), 节点半径按聪明度 6.9~12.5px (未知 9, 人 10)、名字与 room 名 `font-size: 12pt` (CSS 1pt = 1/72in, 1px = 1/96in → 12pt = 16px)、线宽 / 箭头 / ★ 都是固定像素; `--lbs` 删除。布局坐标就是像素: 普通边 70px、枢纽一圈每个邻居 44px 弧长, 首排按画布大小把间距整体缩放 (`gFitScale`, 0.8~2 倍, 与碰撞来回三轮), 窗口 / 侧栏变宽变窄时间距跟着重定、节点不变。名字窄屏最多 9 字、宽屏 11 字, 再长省略号; room 胶囊 26px 高。视野缩放夹在 0.95~1: 不靠缩小字放进画布 —— **三十几个节点在手机 (378×540 画布) 上放不下, 图会溢出画布, 拖背景平移看其余部分**; 桌面侧栏 (563×590) 也略溢出。碰撞改为全力 (每步把重叠整段推开, 字大了以后半力在热量小时压不住)。同 fixture: 交叉 1 / 1, 重叠 0 / 0 (按 16px 字、实际视野缩放量), 压边 0, 增量旧节点平均挪 (扣掉整体平移) 11 / 13。
- **rolepage 关系图: 节点不再压在边上 (人 2026-11-22「三个node之间都有edge时, 有一个node可能跑到另外两个node之间的edge上」)**: stress 只管点对点距离, 三角形挤扁时第三个点会躺在对边上, 两条边与那条边完全叠在一起。两处修: ① 目标距离里相连的两点按自己那条边的长度, 不让 Floyd 最短路改短 (否则 A–B 比 A–C–B 绕路还长时目标就是「C 在 A、B 连线上」); ② 新增 `gEdgeClear` 硬约束: 点离一条不以它为端点的边 (投影在线段 3%~97% 内) 不到「半径 + 6」就沿法线推到够远, 只推点不动边的两端 (枢纽是几十条边的端点, 每条都让它退会推着整张图走), 正好共线按序号奇偶定方向保持确定性, 最多三遍; 首排的粗排阶段不做 (早推会把点推过别的边, 交叉从 1 涨到 7)。压边数 (节点圆碰到非相邻边): 真实 fixture 桌面 5 → 0、手机 5 → 0, 构造的三角形 / 四边形 / 3 人 room + dm 用例 7 → 0; 交叉 / 重叠不变差。`tests/graph-layout.test.mjs` 加压边断言与该用例。
- **rolepage 关系图布局换成 stress majorization (人 2026-11-21「这个力导向图还是不够好」)**: 旧的常驻模拟是斥力 + 弹簧 + 向心 + 椭圆软墙 + 边交叉力 + 首屏 12 个随机起点取交叉最少, 几项互相打架: 所有边同一目标长度 (度数 24 的枢纽一圈只有 ~400 单位弧长, 叶子只能叠在一起)、弹簧不按度数归一、墙按 √n 定尺寸把团往里压、交叉力不在能量里只会来回推; 在真实拓扑 (37 room · 34 参与者, 匿名后存为 `tests/fixture-graph-world.json`) 上量到交叉 4~16 / 包围盒 (含名字) 重叠 3~15 对 / 每次加一个 room 旧节点平均挪 21~46 单位、交叉跳到 9~29。现在 (`web/chat.js` `gStep` / `gLayout`): 目标距离 = 带权最短路 (边长按两端最大度数放长到一圈放得下所有邻居, room 胶囊补半宽, host 边略短), 局部 SMACOF (Graphviz neato 的做法, 权 1/d²) 从径向树起点跑到收敛, 主轴转到面板长边, 再按出图后的标签放大倍数做包围盒碰撞收尾; 同一份拓扑每次排出来一样。同一 fixture 上 (桌面 / 手机): 交叉 1 / 3, 重叠 0 / 1 对, 增量旧节点平均挪 12 / 9、交叉 3 / 6; 首排 (JIT 热后) 12~28ms, 旧的 56~75ms。碰撞盒给圆点上方的 lead ★ / 视角徽标留了 9 单位。顺带: 拖节点时其余点拴在拖动开始的位置 (stress 只认相对距离, 不拴会整图跟着平移); 视野没缩放 / 平移过时跟着内容自动收成整张图 (增量长出的节点不再落在框外); 从列表切回图沿用已有坐标不重排; 双击 = 复位视野并整图重排。新增 `tests/graph-layout.test.mjs` (node 直接跑) 守交叉 / 重叠 / 确定性 / 增量位移门槛。另: `vendor.js` 里整份 d3 v7 (~280KB) 目前没有任何代码用到 (布局仍是手写, 没有引入 d3-force), 可另行移除。
- **chatdetail 引用块 (人 2026-11-21「quote 方案做吧」)**: 一条消息答了哪条 (账本 `re`) 现在在气泡顶上画成引用块 —— 发话人 + 首行摘要 (≈80 字), 点击落到原消息并高亮 (不在页上就走搜索跳转同一条路: 开那个 room、必要时往前翻页); 取代头部的「答」小标与裸 id (`↩ 166`), `done` 也不再画小标, 只留有语义的状态 (progress / need / error / canceled / passed) 与其它 kind (问 / 派 / 系统 / 定时); 多个 `re` 只画第一条, 其余收成「+N」点开看全; 服务端查不到的 (较早已裁掉) 降级成「↩ 较早的消息」。服务端 `wireMsg` 加只读 `reQuote` (走全账本 lookup, 窗口外也有); 只在 chat detail, 企微侧不变。注入行 (入一侧) 的 id 小标没动 (那是注入事件 id, 不是引用)。
- **rolepage 视角模型重构: role = 视角, room = 可选选中态 (人 2026-11-21)**: 此前 URL / 状态里 `role` 与 `room` 互斥 (点 room 清空 role、名片被换成 room 摘要, 图 / 列表的「我」随之消失)。现在两者正交: `role` (wizard target / `uid:…` / `human:…`) 永远且只有一个, 决定左上名片与「谁的视角」; `room` 是该 role 之上的可选选中态, `''` = 它在所有 room 的记录 (原 wizard 视图), 选中 = 该 room 的账本、以 role 为「我」(role 说的行靠右 `.me`, 其余靠左)。点 room 只改选中 (列表 / 图 room 节点 / 成员边都是 toggle, 再点 = 取消选中; 搜索 / 消息里的 room 标签是选中), 点人才换 role; 换 role 时新 role 仍是选中 room 的成员 → 选中保留并换「我」, 否则清选中看它的全部记录。右栏头选中 room 时多一个「✕ 取消选中」, sub 行写「👁 <role> 的视角」; 名片永远是 role (走新增的 `api/wizard?card=1`, 只回名片不算消息 / 时间轴; session 下拉只在未选中时显示), 宪章 / 日程 / 用量两种模式都可用。**图**: 当前 role 的人节点右上角一枚 accent 蓝的眼睛徽标 (`.rv-pov`, 图例「视角」); 选中 room 时 role → 该 room 的成员边加粗高亮 (`.sel`, 直连线则是它自己), 成员边也有透明点击线 (`data-link` / `data-edge`), 点边 = toggle 选中; 轮询只改 class / innerHTML, 不重排。**URL**: `role` 必写、`room` 未选中写空串 (缺省 = 用票据落点 `landingRoom` — `/api/wizard` 回包新字段, turn 票据取其 channel、其余取 home 群, 且 role 是其成员才选中; 空 = 明确不选, 刷新不被落点重新选中), `all=1` 仅未选中时写; 老链接兜底: `role` 形如 `dm:` / `adhoc:` 当 room, 只有 `room` 没 `role` 时按 落点 role (是成员) → host → 首个 wizard 成员 → 首个 human 成员 选视角。返回栈 / popstate 改成同时恢复 role + room; 计划 / 日程 / world 未读按当前 role 算而不是首屏 `ROLE` (既有 bug); 成员列点击改用节点 id (此前传的是 uid / userid)。`scripts/shot.mjs` 加 `--room <id>` (`''` = 明确不选)。`tests/room-view-api.test.ts` 补 `landingRoom` / `card=1`, `tests/room-graph.dom.mjs` 补视角模型 a~f 六组断言并断言全程无页面脚本错误 (顺手给 `redrawPlanEdges` 加了无日程栏时的空守卫)。
- **room 视图「过程」按钮分开合 + 过程挪到气泡之前 (人 2026-11-21)**: 展开时按钮高亮底 / 强调色 / 箭头转 90° / `aria-expanded`, 收起恢复常态 (手机同); 过程框的 DOM 与视觉顺序改为 过程框 → 头 → 气泡 (过程发生在这句话之前; 头仍紧贴气泡, 与 routeHead 的箭头 / room 标记逻辑不冲突, 靠右「我」的一侧同样镜像); 因为框在头之上, 展开 / 收起以按钮为锚补偿 scrollTop, 视线不用追。
- **chatdetail 气泡样式对齐 main (人 2026-11-21)**: 气泡去掉彩色描边 (`border:0`)、四角统一 14px 圆角 (不再有左上 / 右上直角小尾巴); markdown 渲染照 main 的观感重排 (14px / 行高 1.65、段落 .6em 间距、标题层级、列表缩进、行内代码与代码块的淡底、引用左线、表格边线 / 表头、链接色); room 视图里每条消息左右各去掉多余的 12px margin (只剩 thread 自身的内边距, 左右对称)。
- **rolepage 名字 / 图标 / 切换速度 (人 2026-11-21)**: ① 图里 wizard 名、room 名偶发显示成 id 的根因: svr 重启后名册 (WorldFacts) 只在内存里, daemon 每 30s 才推一次, 这 ≤30s 里 `/api/world` 回包 `degraded:true`、`names` 为空、节点名就是 target / uid, 前端把它整份覆盖了好数据。现在: 已有好数据时忽略 degraded 回包, 首屏用占位名 (`#slot` 或省略号, 与 `displayName` 同回落, 不露 id) 并 2s 重取, 名册一到立刻补上; room 视角的成员 / 发话人名同样过一遍; ② 侧栏「列表 / 图」切换按钮换成成对的线描 SVG (带点条目 / 三节点网); ③ 点 room 切换提速: 侧栏列表选中态改切 class 不再整表重建 (此前每次点击 25~80ms), 图面板尺寸缓存 (去掉点一次两趟的强制排版 24~116ms), `goRoom` 不再重画两遍图, 命中过的 room 先用上次回包即时渲染再后台刷新, `/api/*` 与前端资源 gzip (room 回包 70KB → 18KB, app.js 146KB → 压缩, 远端 svr 上最显著)。
- **rolepage 没起名的私聊 room 名用顿号连 (人 2026-11-21)**: 侧栏行标题、chat detail 顶部标题、搜索结果里 `A ↔ B` 一律改成 `A、B` (只改展示; 注入给模型的 `【A ↔ B】` 头不动), 过长用省略号。对照 main 分支: main 的会话列表是 role 为中心的「会话」模型 (私聊行标对端、群行标群名、「X 与 A、B 的对话」用顿号连); v3 是 room 账本模型, 行 = 当前 role 参与的 room, 名字取自 room title > 聊天名 > 成员名拼接, 此前成员名用 `↔` 拼。
- **rolepage 返修 (人 2026-11-21)**: ① 私聊 (dm / adhoc) 消息头在任何页面都只画单箭头 `A → B`, 不带 room 名 (此前账本行带 roomLabel 时 wizard 页仍画 `—私聊→`); 只有绑定企微的群才把 room 嵌进箭头线; ② 关系图节点名不再 `slice(0,9)` 硬截成半截词, 改省略号收尾 (全名在悬停里) + 描边底色, 枢纽名字压在线上也可读, 窄屏标签字号略大; ③ 侧栏宽度: 图视角默认 40% (原 50%), 右缘加拖拽条, 「列表」/「图」各记各的宽度到 localStorage (`wz.sbw.list` / `wz.sbw.graph`, 220px ~ 70%), 双击恢复默认, 窄屏不启用, 图随宽度重算; ④ `tests/room-graph.dom.mjs` 夹具对齐真布局并能挂 shot-setup 的系统库起浏览器, 视窗缩放 / 窄屏 / 拖拽调宽全绿。
- **rolepage chat detail 消息头重排 (人 2026-11-21)**: ① 头改成一条「去向」, 整条只有一个箭头: 私聊 `发送人 → 收件人`; 群聊 `发送人 —room→ 收件人`, room 名朴素地嵌在箭头线上 (无 border / 圆角底, 仍可点跳 room), 房间视图里不重复写 room。② 发送人 / 去向信息直接挂在每颗气泡上方 (过程框里发消息的调用不再有这一行, 过程框也不再挂头; 一轮什么都没说出去时才在框上留一行头)。成功的 chat_reply / chat_say 在过程里连摘要行都不留; 失败 / 状态不明 / 不答 / 待送达 / 频道评论仍留可见的摘要。③ 靠右的气泡 (我) 整条头 `row-reverse`、箭头翻成 ← (群聊 `←room—`)、发送人贴着气泡那一侧, 左侧的 (他人) 保持原序; DOM 始终是阅读顺序, 镜像全在 CSS, 窄屏折行。点头像/名字切 role、点群名跳 room、点空白切 viewpoint 的交互不变。只改前端展示与过程框的渲染 (`web/chat.js`、`shared/detail-render.ts`), 不动数据模型 / 路由。
- **rolepage 四项 (人 2026-11-21)**: ① 关系图里的用户节点不再是方块, 画 👤 emoji、名字写在下面 (多位用户靠名字分辨), 图例同步; ② 角色名片的职责(description)重排: 浅灰底文字块 (与名字/facts 拉开 8px、无左侧色条), 字色比名字灰一档、比 facts 深一档, 最多三行, 溢出的点一下展开/收起; ③ 详情「过程」里 chat_reply / chat_say 与公开的 tell_peer / chat_ask 只留一行摘要 (工具 + 去处/状态), 不再重复下面气泡里的正文 (私聊的移交仍可展开原文); ④ 在 detail 里点进别的 role / room 时顶栏出 ← 返回, 并压一条浏览器历史, 手机系统返回手势 / 浏览器后退走同一条路并恢复滚动位置; 窄屏从列表/图进 detail 后的系统返回 = 回列表。
- **wezard 起的 claude 会话关掉 claude.ai 远程 MCP 连接器 (人 2026-11-21「都关掉吧」)**: `launchEnv` (`daemon/spawn-tmux.ts`) 给启动行加 `ENABLE_CLAUDEAI_MCP_SERVERS=false` (Gmail / Docs / Sheets / Slides / Drive / Claude Docs 全不连), 每进程省约 10~12MB 并免去启动时的连接请求与提示里的工具名。claude 2.1.329 实测: 无该变量时 init 的 mcp_servers 列出 6 个 claude.ai 连接器, 加上后为空。只影响 wezard 新起 / 重起的 pane, 人自己开的 claude 不受影响; codebuddy / codex 不认该变量会直接忽略 (claude-internal 未实测)。`wrc.extraArgs` 默认值里已冗余的 `mcp__claude_ai_Claude_Docs__*` / `mcp__claude_ai_Google_Drive__*` 屏蔽项一并删去 (`shared/config.ts`、`config.example.jsonc`); 显式写过 `extraArgs` 的机器照旧。
- **rolepage 关系图返修 (人 2026-11-21 七条)**: ① 「工作中」不准: `peerInfoOf.busy = isBusy`, 而 isBusy 把「registry idle 却悬着 tool_use」(停在本地审批框等人点) 也算忙, 图上就亮成工作中; 前端又用转录推算的 `runningUntil` 兜底, 静默久了误熄、悬着的轮误亮。现在服务端补 `parked` (同 `parkedNow`), 前端有注册表事实的节点只认服务端 busy, 停在审批框的单独画「等审批」。样式: 工作中 = 绿色 + 整个节点呼吸动画, 去掉外圈 pulse。② room 右上角由「常亮的未决 duty 红点」改成按当前查看 role 的未读数量 (`/api/world` 每个 room 带 `unread` = room 账本里该 wizard 游标之后别人说的行数, `unreadCount`), 点开该 room 后本机清零 (记下当时的 seq), 之后只数新来的。③ 空闲 = 不透明浅灰填充 + 深一点的灰边。④ 缓存冷 = 白色填充 + 灰边。⑤ 「无会话」改名「休眠」并说清定位: pane 不在、下一句话 daemon 会重新拉起 —— 与缓存冷 (pane 在、只是提示缓存过 TTL) 不是一回事, 保留不合并; 图例与 tooltip 写明。⑥ host → room 边带箭头 (方向 人 → room, 停在 room 胶囊边上), 用 ⭐ 的黄色 `#f5b301`。⑥′ (补充) host 箭头方向画反了 → 改成线从 room 出发、箭头落在 host 的圆点边上, 箭头换成线形 (空心) 的, 线宽与普通成员边一致, 仍用 ⭐ 黄; 所有节点填充一律不透明 (去掉呼吸 / 休眠 / ghost 上的 opacity, 休眠与 ghost 改用实色浅灰 + 虚线边); 「等审批」(parked) 用玫红 `#e8336d`, 图例补上。⑦ 减少边交叉 (人 2026-11-21 截图仍交叉, 要求加大拉力 / 斥力): 节点斥力 0.10 → 0.22, 边弹簧刚度 0.09 → 0.2、静止长度缩短 (host 0.7→0.55 / 普通 0.95→0.75 / 直连 1.05→0.9), 加「边交叉力」(不共端点的两条边相交时把中点沿连线推开, 强度 0.3)。**真正压住交叉的是两处结构性修正**: 椭圆软墙的力度原先与热量无关, 热量衰减后斥力 / 弹簧都弱了墙还在每帧往里挤, 把排开的边重新压成一团 —— 现改成随 alpha 衰减; 首次出图加「多起点」(暖机后大幅抖动 → 跑到底 → 恒定强交叉力拆一段, 重复 12 次 (节点 >30 个 6 次, >50 个 3 次) 取交叉最少的一份; 增量更新不再打乱已有位置)。在接近截图拓扑的合成图 (19 节点 / 30 边, hub 两个、人 2 个) 上量, 终态交叉数 46 → 平均 16.4 (30 个起点种子, 最少 9, 最多 33), 节点无重叠。
- **文档按 room 模型改写 (人 2026-11-21)**: CLAUDE.md / README / 技术说明里仍把 `daemon/router.ts` 路由账、`tell_peer` / `wait_peer` / `read_chat`、回执、顶层模式 (`topOnly`)、聊天命名 (`/name` / `/chats`)、「终句推回群」写成现行的段落, 按代码重写: room 账本 (行 / duty / 唤醒泵 / 镜像规则 / 看门狗 / 迁移)、`delegate` → `chat_ask`、`mcp/tools.ts` 的实际工具面与 `WEZARD_MCP_EXTRA`、新群引导、rolepage 的真实路由 (`/api/world` 等)、plan 提醒读 room 的 open duty、交接不再提回执; CLAUDE.md 里「hook 连不上 daemon 就 allow」的陈述改成与 Hook + sync 一节一致 (什么都不答, 绝不 allow)。docs/evolve 下的历史设计文档未动, README / 技术说明不再链到它。
- **修基线里过期的测试 (只改测试)**: `backend-tiers` (pickTier 搬到 shared/model-tiers 且去掉 actual 参数; 删已退役的 `models.tiers` / `tiers.*.cli` 断言)、`inbound-default-backend` (`/new` 不再有后端槽位)、`slash-replies` (`/name` `/chats` 已下线)、`steward-guard` (拒绝理由指向 delegate)、`pane-delivery` / `maintenance-scheduler` / `pane-task-owners` (抽取式测试补注入被测闭包新增的自由变量 / 切片锚点)、`json-map-store` (偶发红是 mtime 粒度, 改为先把 mtime 拨回 1970 再比)、`workflow-transport.test.mjs` (被抽取的 `injectViaTmuxText` / `newSession` / `restoreFromStore` 闭包新增了自由变量、`newSession` 少了 cli 位置参数、切片终点锚点已不存在)。删 `tests/answer-transfer-format.test.mjs` / `answer-transfer-mirror.test.mjs`: 它们测的 `answerBubbles` / `deliverAnswer` (终句移交给 receiver task 的气泡接管) 在 room 重构后整个不存在了。

### Removed
- **清理废弃代码 (人 2026-11-21「清理废弃code」)**: 只删经全仓 grep (含 web / tests / scripts / 模板) 证明零引用的东西, 不改行为。① 死 import / 死局部声明 (`tsc --noUnusedLocals` 出清单, 逐项核实): `daemon/index.ts` 的 `waitForQuorum` / `handoffEnvelopeAttrs` / `relayPeer` / `cardRoomOf` / `chatCwd` / `pendingMarks` 等、`daemon/inbound.ts` 的 `renderChats`、`shared/chat-http.ts` 的 `FACTS_MS` / `View`, 及相应的 ~50 个无人用的 import 名。② 零引用的导出: `installChannelBridge`、`recordPost`、`extractResult`、`wakeNoteOf`、`sessionPanes`、`WIZARD_KINDS` / `wizardName`、`TASK_POSTPONE_MS` / `TASK_QUIET_WAIT_MS`、`renderChatRecords` / `RecordView`、`chatSummary` / `ChatSummary` / `threadOf` / `ThreadEntry`、`wxMark` / `WxMark`、`roomTouches`、`splitDutyKey` / `dutiesAskedBy`、`tagFromCwd`、`isQuiet`、`turnState` / `renderInFlight` / `renderTurnState` / `TurnSlot` / `RouteStatus`、`primaryBackend`, 整个 `daemon/tips.ts`。③ `web/chat.css` 与 `web/chat.js` 里内嵌的 rolepage 样式: 重排后再没有元素带的 ~90 个类 (旧消息行 `.mrow` / `.mwho` / `.mcol` / `.mchip` / `.flip`、旧侧栏子项 `.si` / `.subs`、旧关系树 `.tci` / `.tlab` / `.ek`、`.csec` 宪章按节、`.toast`、`.wst` / `.wxm`、`.govbar` 严格群治理条等) 及随之孤立的注释、`@keyframes flip` / `swbar`; `shared/chat-render.ts` 里永远 hidden、没人填的 `#govbar` 挂载点。④ 配置项 `wrc.mirror.pendingFile` / `wrc.mirror.idleNudge` (pending_items 与 idle-nudge 退役后无人读取; 盘上旧值被 zod 当未知键忽略, 不拒启动)。⑤ 过期测试 / 脚本: `tests/receipt-inbox.test.ts` / `receipt-timing.test.ts` (import 已删的 `daemon/receipts`)、`tests/model-tier-migration.test.ts` (import 已删的 `shared/model-tier-migration`)、`scripts/receipt-regress/run.mjs` (驱动已退役的路由表 / `/routes`)、`scripts/s3-evidence.ts` (import 已删的 strict-switch / chat-seen)。
- **清理废弃代码 · 第二轮 (人 2026-11-21「拿不准的继续删, 别影响 handoff 等重要功能」)**: 仍只删证明无人触达的, 不改行为, 交接引擎本体 (`createHandoffs` 的阶段 / 闸 / 落盘 / 恢复) 一行未动。① spawn 启动确认框广播链: `bindStartupNotice` / `_startupNotice` (room 重构后从未接线, 恒为 undefined)、`notifyUnknownFrame`、`shared/startup-notice.ts`、只喂它的 `SpawnArgs.chatKey` (3 处 spawn 调用点同步去掉); 认不出的确认框仍是「不按键、不放行、留给本地人工」。② 只剩测试引用的死导出: `daemon/handoff.ts` 的 `settlesCut` / `handoffRound` / `roundPending` / `RoundEvent` / `resumeText` (属已退役的路由事件账, `index.ts` 里对应钩子早已是空桩)、`daemon/onboarding.ts` 的 `isOnboardingActive` 与只喂它的 `activeBases` (出站 strict 豁免随出站门废除)、`daemon/wizard-names.ts` 的 `autoOrdinalOf` / `lapPosOf`、`daemon/peers.ts` 的 `contextFiles` / `toolPaths` (route 的 `files` 现取自 `contextMaterials` 的 confirmed read)、`shared/allow-rules.ts` 的 `ruleAllows` 薄包装 (审批只用 `evaluateAllow`, 测试改用 `tests/allow-rules-helper.ts` 的同形投影, 覆盖不减); 连带删 `tests/handoff-round.test.ts`、`tests/startup-notice.test.ts`。**保留**: `charterFacts` (charter 重装判据 `scanLines` 的纯字符串入口, 测试靠它锁行分类)。③ 配置项 `wrc.mirror.chatOriginOnly` / `wrc.mirror.slashAckFirstLine` (代码不再读取; 已核实盘上旧值被 zod 当未知键丢弃、不拒启动), 从 schema / `config.example.jsonc` / CLAUDE.md 一并删净。④ `shared/detail-render.ts` 内联 CSS 里从未被产出的 `.diff-meta` 与 `.plan-go` (对 SHARED_CSS / TURN_CSS 全部类做了全仓零引用扫描, 含动态拼名 `st-${key}` / `cut-${cut}`; 这两族仍有产出者, 保留)。

### Fixed
- **rolepage: 选中的 room 滑出时间范围, 图里不再把它的节点画没 (admin 7aeb85fc.283 梳理时间范围选择器)**: 列表的取舍保留「正在看的那个」, 图却没有 —— 默认 2d 下点开一个 3 天前的 room (或停在页面上等它滑出窗口), 列表里它高亮着、图里节点 / 成员边 / 视角标记全消失。现在列表与图共用一个 `roomInScope` (窗口内有动静 ∪ 有未决 duty ∪ 选中的那个); 成员仍跟着 room 走、不单独过窗口。同时订正已过时的注释与下拉 tooltip (旧文案写「人动过也按这一刀」, 实际早已不筛成员)。`tests/room-graph.dom.mjs` 加「选中老 room」图 / 列表一致断言。
- **chat_ask 给一个已被 stop_wizard 结束的 wizard 不再静默丢失** (现场 2026-11-22: `.wezard-1` 两次派活给 `.IrisIrwin`, 它的绑定已被 `/kill` 丢掉, 账本里 duty 开着、行已镜像进群, 却从没投进任何 pane, 守护进程日志一行都没有, 30 分钟后才靠人工巡检发现并改派)。`injectText` 对没有绑定的目标早就回 `gone`, 但 room hub 把它和所有失败一起折成 `failed` 后丢弃, 只靠 30s 重踢静默重试。现在 hub 认 `gone`: 被这批行唤醒、它名下的 duty 各给提问者写一条 `undelivered` 系统行 (唤醒提问方, 指明用 `spawn_wizard` 同名重生或改派), 账本里有即不重复, 游标不动 (重生后照样读得到); 其余投递失败按状态变化打一条 warn, 不再无声。新增 `tests/room-gone.test.ts`。
- **dm 在一方离开后不再卡死 (人 2026-11-22 admin 拍板「dm 统一为 room 的特殊形式」)**: `ensureDmRoom` 之前只认「dm 存在就用」, B 离开后 A 再 `chat_ask` B 会被 judge 拒 409。现在 dm 成员只剩 A/B 时把缺的人用 join 补回再用。
- **handoff 排上后被打断、上下文还在 (人 2026-11-22「两次 handoff 都没真正执行」)**: 根因是 busy / idle 极性接反两处 —— daemon 的 `idleNow` 是 true=闲, 而 `waitForIdle` 的探针是 isBusy 极性 (true=忙)。① Esc 之后的静置等待 (`handoff.ts` 的 `paneIdle`, dbe6762 起) 直接把 `idleNow` 塞进去: 打断成功、pane 闲了反被当成「一直在忙」, 10s 后必打 `打断后仍未静下来, 退回排队等待`; ② 排队 / briefing 的 idle 等待 (`index.ts` 的 `isBusy: (t) => m.idleNow(t)`, room 接线 C 把原来的 `!idleNow` 拍平时丢了取反): 忙着的 pane 反被当成已闲 → 在飞的一轮上硬 /clear, `command()` 一看 pane 不闲就拒绝 → `/clear failed: native /clear submission unconfirmed; no retry` → `放弃`; 而真闲了的 pane 又永远等不到收口 (日志里的 `仍在队列 waitedMs=600000`)。新增 `busyOf` 把「闲没闲」翻成「忙没忙」, 两处接线都过它; `tests/handoff-polarity.test.ts` (Esc 后闲 → 立刻重开 / Esc 后仍忙 → 只排队、一次 /clear 都不按, 闲下来才重开)。落盘格式 (`PendingHandoff`) 与阶段机不动。
- **人话点名 wizard 时注入的 mention 提醒让模型去调已退役的 `wait_peer`**: `peerMentionPart` 的规则行改为 `chat_ask (它用 chat_reply 交代) · peek_peer`。charter 里仍列着 `wait_peer` 的两处 (`daemon/wizard.ts`) 改动会触发全体 handoff 提醒, 待拍板, 见 `docs/evolve/platform-progress.md`。
- **chatdetail 每 4s 滚动位置被重置**: 定时刷新 (`tick`) 在**发请求前**记下 scrollTop、回包后 `restore` —— 请求在路上的那段时间 (远端 svr 上几百 ms) 用户滚过的距离被拽回发请求前的位置; room 视角还会每次无条件 `scrollBottom` 再 restore, 且回包没变化也整段替换 detail。修: 滚动位置在替换 DOM 的那一刻现取现还 (room / wizard 两路都改, 只有贴底才跟随); room 回包与上一份无差别 (去掉 `at`) 就一字不碰 DOM; 用户 1.2s 内还在滚就让这一轮刷新过去。`tests/room-graph.dom.mjs` 新增两条真浏览器用例 (回包每 4s 都变、滚到中间等 >10s 不动; 请求在途时再滚 400px 回包后不被拽回, 旧代码下该用例失败)。
- **关系图里同一个 wizard 画成两个节点、状态各说各话**: daemon 的 world 快照里休眠 / 被收掉 (注册表有、没有 pane) 的 wizard 缺 `uid`, 账本成员按 uid 引用, 图认不出就另画一个 `uid:…` 幽灵节点 (永远休眠), 真身也失去 uid 关联。cold 分支补上 `uid`。
- **handoff 不响应 (wezard-1)**: ① self 交接在 Esc 后排队几分钟, 期间 pane 注册表报的原生 sid 会抖 (892a→2e67→892a→29ff, 后两个没有 transcript), `/clear` 前「sid 与发起时一致」的校验一抖就永久放弃 (`native session changed before the clear attempt`)。现在发起时记下 pane 里 CLI 进程身份 (`pane:panePid:pid`), 重开前若还没提交过 /clear 且进程身份未变, 以当前 sid 刷新后继续; 进程变了/认不出仍严格拒绝。② 点名交接别人 (mode=other) 的 `summary` 接线自 fd4715b 起是 `() => undefined`, 必然 `target produced no summary text`; 现在读目标会话在「请它写简报」那句 (`summaryAt`) 之后最新的 assistant 正文 (全文)。测试: tests/handoff-sid-drift.test.ts。未解: sid 抖动根因、Esc 后 10s 判不静 (只记录, 未改)。
- **Linux 安装开启 linger, 登出不再停掉 daemon / svr**: 没有 linger 时 systemd --user 的 user manager 跟着最后一个登录会话走 —— 2026-11-21 02:18 ssh 断开, logind 停掉 user manager, wezard.service 与 wezard-svr 一起被停 (Restart=always 不管 systemd 自己发起的 stop), 直到 08:41 再次 ssh 登录才回来: 期间机器人离线, 定时任务 hourly-push 02:51~07:51 的 6 枪全部漏掉, 08:41 那一枪是开机后 `every` 时钟的补放 (`t - since >= 间隔` 只补一枪)。`scripts/install.sh` 在 Linux 分支检查 `Linger`, 未开则 `loginctl enable-linger` (失败再试 `sudo -n`), 都不行就 warn 并给出命令。
- **rolepage chat detail 点「过程」展开多一层虚线框 (人 2026-11-21)**: room 视图里挂载点 `.rv-box` 自带虚线边, 里面的 `.steps` 过程框又是虚线 —— 框套框。`.rv-msg > .rv-box` 去掉边/内边距/底色, 只留过程框本身的那一层 (`web/chat.css`)。

### Changed
- **群气泡标明对谁说话 (人 2026-11-21)**: wizard 在绑定 room 里点名 wizard 的行 (`chat_ask` / `chat_say` 的 `to`, 对某 wizard 消息的 `chat_reply` `re`) 镜像进企微时, 正文头写 `→ .name`, 如 `🧙‍♂️ wezard-1：→ .Grace …`。写在正文而非作者头 —— 尾部改写 `withMessageFooter` 会把作者头剥掉重写。`daemon/message-format.ts` 新增 `addressed`, `roomMirror` 调用; 测试在 tests/message-format.test.ts。
- **rolepage 移动端 + 图随窗口缩放 (人 2026-11-21)**: ① 窄屏 (≤760px) 点进聊天看不到 chat detail —— CSS 默认 `.main{display:none}`, 只有 `.app.reading` 才换成 detail, 而这个 class 在 room 读侧重写时丢了, 没有任何代码再加它 (`#tb-back` 的返回也没绑)。现在人主动点开 (列表 / 图 / 搜索 / 成员 / 深链) 走 `goRoom` / `goWizard` 进入 detail, ‹ 返回列表; 定时刷新不翻页。② 图所在面板尺寸变了 (窗口缩放 / 旋转屏 / 左栏宽度变, 另用 ResizeObserver 盯面板) 时 svg 撑满新尺寸, 视野按「每像素世界单位不变、中心不动」调整, 力模拟的墙随新尺寸重算并补一点热量; 节点元素与坐标原样保留, 不整图重排。
- **rolepage 关系图改成真正的力导向 + 增量更新 (人 2026-11-21)**: 布局由常驻的力模拟逐帧算出 (斥力 / 弹簧 / 向心 / 碰撞 / 椭圆软墙, 初次出图暖机后继续松弛), 节点可拖拽, 拖动时升温、邻居跟着走, 松手放开钉子自然落定; 以前是同步算 240 步后 `stop()`, 之后只有拖拽才动, 数据一变就整图重建重排。数据刷新现在只做增量 —— 节点对象 (坐标 / 速度) 常驻, 新节点落在已有邻居旁, 消失的删掉, 其余只改样式, 节点 / 边真的增减才补一点热量。节点样式区分: 人 = 方块、wizard = 圆点; wizard 状态 working (busy, 外圈脉冲) / idle (pane 在、缓存热) / warm (pane 在、缓存已超 TTL) / cold (pane 已停), 图下带图例。host → room 画成橙色加粗的特殊边, 与成员细灰边区分。服务端 `WorldFactWizard` / `WorldNode` 新增 `cacheCold` (与 wizard_roster / tell_peer 冷门控同一口径 `wakeCostOf`; 老 daemon 没给时按 idle)。
- **rolepage 左栏时间范围 (人 2026-11-20 需求)**: 「近 2 天 / 全部」两档换成一档时间范围下拉 (⏱ 1h / 2h / 6h / 12h / 1d / 2d / 全部, 默认 2d, 记在 localStorage 的 wezard.role.winMin), 列表与关系图共用同一个值; room 的判定 (有未决 duty 的照旧总在) 与人动过的判定 (活着 / 在跑 / 是 host 的照旧总在) 都按这一刀, 原先写死的人 12h 窗口取消。右栏顶上的「W-1 与我相关 / W-2 全部」改成一目了然的名字「只看与我相关 / 全部消息」(W-1 过滤的是这个 wizard 的 IM: 它说的 / 点名它的 / 回它那几条的; W-2 是它所在全部 room 的全部消息, 与关系图无关, 所以留在右栏)。tests/room-graph.dom.mjs 加时间档断言 (默认 2d / 七档 / 记 localStorage / 3 天前 room 只在全部下出现), 并修掉两条历史断言漂移 (#rv-session → #rb-sp、搜索空查询 3 间)。
- **类 / 实例 (人 2026-11-18 拍板)**: 一个 bot 内的身份拆成两层 —— **类** = (bot, role, workspace) 唯一的人物设定 (名字 / 职责 / 专长 / 记忆 / 工作区, 存 stateDir/classes.json 独立表), **实例** = 类的稳定地址 (一条 wizard 记录, target 不变; /new、交接、/clear 只换会话)。实例名 = 类名-N, N 每类从 1 单调递增、**永不复用** (实例 drop 掉的号不还); 类名 bot 内唯一、不以 -数字 结尾、≤28 字符 (实例名要落进 WIZARD_NAME_RE ≤32)。**boot 迁移** (migrateClasses, 幂等, 先备份 wizards.json.pre-classes.bak): steward / global-steward 身份的各组化身按出生先后编号 x-1..x-n (target 与 identity 一个都不改, 旧账 owner 字符串零改写), 冲突 (锚点无名 / 名字以 -数字 结尾 / 超长 / 撞名 / 同 workspace 已有别的类) 整组跳过并逐条 warn + 覆盖写 stateDir/analysis/classes-migration.txt。**合并清单** stateDir/class-merges.json ({merges:[{into,name,first,members}], exclude:[...]}) 把人拍的「同目录上几个旧身份 = 一个人」并成一个类 (first 的 target 为 -1, 其余按出生先后), exclude 的组保持旧形态不报冲突; 迁移后**管家绑定一律存类名** (chatPolicy.<chat>.steward / wrc.channel.steward 里指向旧名的值当场改写)。**路由**: 点实例名 = 精确地址 (跨群也直接投那一条, 回复回提问的群); 点类名 = 本群该类的实例, 没有就在本群新建一个 (与管家接待同一路径, allocOrdinal 领号, 名字 类名-N); 无类的旧身份 (worker / 学徒) 一切照旧 —— 混合世界。stewardsAt 先查类表 (bot, steward, workspace), 再回落旧层; set_workspace 对类实例改类行工作区 (撞别的类 409); 新群引导新建管家 = 建类 + 第 1 个实例, 绑定写类名; 宪章写明「名字 X-N, 类 X 的实例 (role, workspace)」; 克隆 / 新生的记录一律是自由 wizard (不继承 ordinal / identity)。**自由名让位** (人 2026-11-18): 存量自由 wizard 的名字落进类名字空间 (等于类名, 或 `类名-数字`) 时一律自动改成 `类名-wN` (如 `wezard-2` → `wezard-w2`), 计入 renames 并写进报告 —— 否则类实例拿不到那个地址, 旧 worker 还会被影子化; 运行时类改名也照同一条规则让位。**迁移闸门** (人 2026-11-18): boot 只在 stateDir/classes.apply 存在时才真迁 (类 + 成员表改键 + 绑定改写), 没有它只跑计划、照写 analysis/classes-migration.txt 并留一行 class migration gated —— 带迁移代码的 dist 被别人 reload 也不会动真数据。**成员表改键** (chat, identity) → (chat, target) (boot 幂等迁移, 备份 .pre-targets.bak): 在场的是实例, 同一个人的另一个群的化身还是成员, 退役一条实例只摘那一条。
- **wizard_identity 加 to**: 改别人 (实例名, 带不带点都认)。权限 = 同 bot 且 (调用方是它的直属 parent, 或调用方本身就是管家类实例); 学徒不可被别人改; 越权 403。目标是类实例时 name 是**新类名** —— store.rename 同步全部实例 (新类名-原序号, 序号不变), 形如 X-3 的名字直接 400 (会造出两层实例名); 改名的善后收成一处: 改写指向旧名的管家绑定、guardCharter、retitlePane、每个实例在自己的群各发一次 renamed、受影响实例重新挂宪章。返回落定名; 类改名附 class: {was, name, instances} 与一行「类 X → Y, N 个实例: …」。

### BREAKING
- **/name 下线 (人 2026-11-18 拍板)**: 群里发 /name 不再特判 (当普通消息转给会话), 二次确认窗口 / /name - / 帮助文案一并删除。改名只剩 wizard_identity (自己改自己, 或 {to} 改直属分身 / 由管家改本群的人); 新群引导的完成语也不再提 /name。
- **room 账本成为唯一沟通事实, 旧沟通层整体退役 (设计 docs/room/contract.md)**: 沟通不再有「路由行 + 回执 + 义务」三套账 —— 一个 room (企微群 / 单聊 / 频道帖 / wizard 对 wizard 的 dm / 临时 adhoc) 一份 append-only `~/.wezard/state/rooms/<id>.jsonl` (目录从配置 stateDir 派生), 成员、消息、未结 duty 全部由 fold 得出, **完成只认 `chat_reply` 的 `status`** (done / passed / canceled; need / progress 不关)。工具面: `tell_peer` / `read_chat` / `chat_members` 退役, 改 `chat_say` / `chat_ask` / `chat_reply` + `room_read` / `room_members`, 新增管理面 `room_open` / `room_invite` / `room_join` / `room_approve` / `room_leave` / `room_transfer` / `room_watch`; wizard 之间默认落一个复用不新建的 `dm:<uid>|<uid>` room, 三人以上临时 room 要走 `room_open`。`priority` (normal / urgent / now) 与 `public` / `fyi` / `return` 参数取消, 打断改 `interrupt: true` (限直属 parent / room host / 人, 计入每 room 回合预算)。**终句零语义**: 行首 `RESULT:` / `NEED:` / `PROGRESS:` / `.name RESULT:` 的回执认领整段退役 —— 终句不投递、不关账, 只留在 rolepage; 一轮结束时唤醒它的 duty 未关且本轮没调 `chat_reply` → 当轮提醒一次, 再闲下来写一条 room system 行 (绑定 room 镜像进群)。**活会话必须 /new**: 宪章与 MCP schema 都变了, 老会话缓存的工具表里没有 `room_*`, 照旧点 `tell_peer` 只会失败。
- **严格群概念整体删除 (chatPolicy.topOnly / chatPolicy.speech 移出 schema)**: `/strict`、`/owed`、`chatPolicy.<chat>.topOnly` 与 `chatPolicy.<chat>.speech: strict|implicit`、以及围着它们建的出站门 (严格群终句不进出站门、只放行 `[wezard]`/`[mirror]` 系统行、topOnly 的同伴轮封口) 全部退役 —— room 模型下每个成员都有发言权, 出站只看成员资格、每轮 3 条 / 每群每分钟 10 条额度与 room 绑定; 被拒时的说明变成 room 里的 daemon system 行, 照样镜像进群。`chatPolicy` 只剩 `steward` / `stewardBudget` 两项, 旧键不再由 schema 定义 (启动不报错、不拒启动); 切换前用 `scripts/room-cutover/config-strip.mjs` 删掉 (dry-run 给出 7 个键的 diff, 落盘前写 `.pre-room-<ts>.bak`)。**TODO (切换前核对)**: 契约 §7 承诺「旧键忽略并 warn」, 代码里未见启动 warn; 且 `daemon/inbound.ts` 的 isStrictChat 与 `daemon/channel.ts` 的 strictTopicOf 仍读 `chatPolicyOf(...).speech`, 而 ChatPolicy 是 `.passthrough()` —— 旧键留在盘上时, 已退役的严格行为 ( `/new` 的系统行加 `[wezard]` 前缀、频道消息走 send_post) 仍然生效。先跑 config-strip 再切代码即可避开。
- **旧状态文件冻结, 一次性迁进 room 账本**: daemon 不再打开 `routes.jsonl` / `state/members.json` / `state/chats/*.jsonl` / `state/message-events.json` / `state/obligations.json` / `state/idle-nudges.json` / `state/strict-delivery-notices.json` —— 旧模型的路由、成员表、聊天记录、事件、义务、追问与补发计数一并失效 (它们的历史照原样留在盘上, 不删、不改写)。切换时跑 `node dist/cli/migrate-rooms.js` (`--dry-run` 只出报表): 每个绑定 base 建一个 room (绑定的管家 founder, 其后按 members 的 since 与近 7 天在该群有轮次的 wizard), chat-records 每行转成 `origin:"migrate"` 的历史 msg, 未结的 route 转成「人话 msg」或 dm 里的 task msg, message-events 的 queued 转 msg、uncertain 原样归档到 `rooms/_archive/` 不迁; 迁入行的 id 由源键确定, 重跑写 0 行。稳定 7 天之后旧源再整体 mv 进 `state/archive/`。
- **轮终改事件驱动 + 全局看门狗; pane 消失按实例结束**: 正常路径由 mirror tail 的 turn_end 驱动 (`hub.onIdle`), 没有轮询; 新增全局看门狗 (`rooms.watchdog.intervalSec` 缺省 60 / `staleMin` 缺省 5) 只兜「有未结 duty 且 staleMin 内零事件」的 wizard。**pane 不存在 → 按实例结束处理**: daemon 写一行 canceled reply 唤醒提问者, 并在它所在每个 room 落一行 `instance-ended` 系统消息 (成员都看得见, 绑定 room 镜像进群), **不自动重生**;**pane 忙只 warn 不纠偏** (卡死与长活在外部不可分, 交给人的 `stop_wizard`)。wizard 离开 room 时手上该 room 的未结 duty 同样由 daemon 写 canceled。
### Added
- **会话 pane 按空闲时间回收 (人 2026-11-21: 「按空闲时间收吧，1h」)**: 新配置 `wrc.mirror.idleReapMin` (默认 60, 0 = 关闭, 热生效 —— daemon 每 5 分钟现读一次, 实际收起落在 N ~ N+5 分钟)。与 `maxPanes` 互补: 数量没超但几个 pane 长时间闲着时, 每个仍常驻 250~340MB。「空闲」= 本进程见到的最后一次注入落 pane / tail 读到的任何转录条目 (含轮结束) 与 transcript mtime 取晚者; reload 后内存时钟为空, 回落 mtime, 长工具调用由截屏判忙兜住。只收 pane 进程, 绑定与身份不动, 下一条消息走 dead-pane `--resume` 复活。豁免与 maxPanes 同一套: 名下有启用的定时任务、挂着审批长轮询、pane 正忙 (spinner 脚注)、window 正被人 attach 盯着, 外加正在出生 / 有注入排队中的; spare 池 pane 没有绑定, 不在候选内; 管家 (聊天默认会话) 不额外豁免。收起只打日志 (`mirror idle reap`), 不往群里发。两种清扫串行执行。`daemon/idle-reap.ts` 判据为纯函数, 测试 tests/idle-reap.test.ts。
- **Stop hook 轮内催交代 (人 2026-11-21: 「用 hook 提醒 wizard 用 chat_reply, 而不是 daemon 事后发现」)**: claude 后端的会话级 hook (`--settings <stateDir>/session-hooks-stop.json`) 多注一个 `Stop` → `hooks/stop.sh` → `POST /room/stop-check`。CLI 要结束这一轮时, 唤醒它且已投进输入框、最近一次唤醒后还没 chat_reply 过的 duty → `decision:"block"` + reason, 模型同一轮接着交代 (算「提醒一次」); 每条 duty 至多拦一次, 再停仍欠 → 放行并当场写系统行。hook 来问过的那一轮, 轮终 `onIdle` 在 3s grace 后不再插手; hook 没来 (老 pane / claude-internal / codebuddy / codex / daemon 连不上) 仍走原来的「下一轮贴提醒 → 再下一轮系统行」兜底。stop.sh 任何失败都零输出放行, 不会把 pane 卡在结束不了。
- **room 起名 (host 专属)**: 新增 `room_name` (daemon `POST /room/name`) —— 账本多一种 `name` op (fold 覆盖 title), 只有当前 host 能改 (普通成员 / 人 / 非成员都 403); 名字只是显示别名, **不参与寻址** (room 参数、账本文件名、消息 id 一律仍只认 id), 同名不冲突; rolepage、唤醒注入头、room_read / room_members 的标签优先用它, 没有才回落到聊天名 / 成员名。`room_open` 的 `title` 仍是开房时的一次性起名。tests/room-name.test.ts。
- **rolepage 群成员 (实例) 列表 (人 2026-11-18)**: 打开一个**群聊**会话时, 会话头下多一条细带「群成员 N」, 列这个群里有哪些 wizard 实例 (单聊 / 私聊不显示)。口径两条按 target 去重合并: ① 名册里 `baseOfKey(target) === 该群 base` 的记录 (本群实例, 含管家实例与它生出的 worker); ② 严格群成员表 (`daemon/members.ts`) 里该群的行 (含从别的群「加入」进来的实例)。每行 = 名字 (**类实例显示 `类名-N` 并标出所属类名**, 自由 worker 只显示名字)、本群管家标记 (`isStewardTarget`)、严格群在场方式 (owner/speaker/mention; implicit 群不显示)、跨群加入标记、活体状态 (沿用 rolepage 的 busy/alive/runningUntil 口径, 灯挂在名字旁), 点名字切到那个实例的 role 页 (与侧栏 / 消息行同一跳转)。整条可收起 (记在本地), 成员多时折行而不把消息挤下去。数据面: `WorldFacts` 加 `memberRows` / `classes` 与 `WorldFactWizard.ordinal/steward` (daemon 侧 `collectWorldFacts` 取 members.json / classes.json / `isStewardTarget` 判定, svr `mergeFacts` 一并合并); 组装是 `shared/group-members.ts` 的纯函数, `/api/role` 的摘要按聊天下发 `chatMembers`, 前端 `#membar` 只画当前群那一份。tests/group-members.test.ts。
- **新群引导 (人 2026-11-16 需求 + 2026-11-17 两次改口径: 「要一个真实的引导会话」→「工作区设置以后就等同于绑定了管家, 就应该退出引导, guide 会话也不应该 handoff self」)**: 新增 `daemon/onboarding.ts` + inbound 的 `guideGate` —— 群聊且无管家绑定、无默认会话记录、机器已认领时, 裸消息与 @bot 消息由 daemon 接管, 起一个**引导化身** (`base#guide`, 不占 untagged —— 那是管家锚点的保留位; slot 被人手开的 `.guide` 占着就退到 `guide-2`, 认它只认「`新群引导` 职责标记 + guide 系 slot」双证) 在群里**对话式引导**: daemon 是状态机主人 (判定/校验/落盘/强制全在机制层), 每轮把「daemon 指令 + 人的原话」注入引导化身, 由它转成人话回群。**一步完成**: 人回一个合法目录 (绝对路径, 存在且是目录; 人话里粘着中文也认, 如「设置工作区为/Users/x/org」; 行首 `/Users/…` 不再被当成斜杠命令) → 在本群 untagged 锚点落 `kind:steward` + 身份级 `workspace` + 自动中性名, 写 `chatPolicy.<chat>.steward`, 状态机终结; 想让本群共用一个**已有管家**就回它的名字 (拍板 A: workspace 跟身份走, 给同一个目录会新建另一个身份, 所以按名字绑是唯一入口; 两条入口按形状区分 —— 目录以 `/` 或 `~` 起头, 名字不含 `/`)。原「② 请指定管家名字」一步取消, 名字后置给 `/name`。**绑定即收**: 完成确认是 daemon 系统行 (`[wezard] ✅ 引导完成 …`, 严格群出站门放行), 引导化身当场 kill + drop —— 不再有 60s 告别窗口与定时器 (reload 丢定时器 = 群里残留一个「等指令」的会话); 兜底: 绑定已在而引导化身还挂着, 下一条群消息进门时收尸。**引导化身没有工具面** (机制收窄, 2026-11-17 teststrict 实录: 它把「设置工作区为 …」当成自己的 set_workspace + handoff self, 交接后留在群里「等指令」): ① 不发宪章 (charter provider 对引导化身返回空); ② 审批层对它的每个工具调用 (内置与 wezard MCP) 一律 deny, 排在手闸与一切放行之前; ③ 审批关掉 / `wezard use cli` 时的兜底 —— `set_workspace` / `handoff` / `spawn_wizard` / `clone_wizard` / `delegate` / `tell_peer` / `set_model` 路由对引导化身调用方 403 并按引导异常收尸 (杀 pane + drop + 群里一行系统提示, 状态机不动, 下一句人话重起干净的引导化身); 别人替它 handoff / 设工作区只拒不收。引导**强制**: 无 /skip、无超时; 点名 `.x` 与免授权的 /id /help 照常, 其余斜杠命令回「先走完引导」。**strict 出站门的机制豁免**: `chatPolicyOf` 对在途群一律判 implicit (出站 tracker 会把新群登记首见 strict, 不豁免引导第二轮起只剩占位), 绑定即关窗。引导化身自身的工作区 = `wrc.cwd`。状态文件 `stateDir/onboarding.json` 只存在途断点。workspace 是**身份级** (拍板 A): `WizardRecord.workspace` (锚点记录携带), `identityWorkspaceOf` 供 spawn 侧读取, `stewardRoute` 的 fresh 化身优先用它。
- v3 身份系统地基 (切片一): `WizardRecord` 新增 `identity` / `role` / `kind` 字段 (`kind`: global-steward / steward / apprentice / worker, 缺省按 target 推 —— untagged 默认会话 = steward, 分身 = worker)。boot 幂等迁移 (`migrateIdentities`, 先于 backfillBorn/settleAll 执行): 存量每条记录 1:1 生成身份 (`identity = 自己的 target`, 稳定不变, 旧账 owner 字符串零改写), 第一次写盘前备份原文件到 `wizards.json.pre-v3-identities.bak` (已存在不覆盖, 永远是最原始的 v2 名册); 备份写不出来或表里有畸形记录 → 一条不写、原文件原样、下次开机再试。名字唯一性从 wizard 级升到**身份级**: 同身份的化身共用名字 (`claim` 直接领身份的名字、`rename` 一处改全身份同步), `byName` 回到身份锚点 (target === identity 那条, 恒定可复现), 撞**别的身份**才挂 `-N`; `evictStaleName` 的新鲜度按身份全部化身取最热的一个。target 字符串形状与 envelope 协议零改动。
- v3 身份系统 (切片二) — 化身解析与 set_workspace 问句退役: 名字寻址统一走 manifestationOf (daemon/wizard.ts) —— 名字 → 身份 → 当前聊天的化身 (A 群点名只落 A 群的化身, 跨群会话不串), 身份在本聊天没有化身时回落锚点化身 (= 旧世界的跨群点名行为, 不自动新建), 1:1 世界恒等于 byName().target 行为零变化。接入两条寻址路径: inbound.resolveName (行首点名 / quote 路由) 与 mirror-bridge.resolvePeerTag (tell_peer / delegate 等点名的 base 聊天上下文)。charter 的「⚠️ 工作区是没人选过的默认兜底目录, 开工前先问一句」问句与 set_workspace({keep:true}) 那一支整体退役 (cwdUnconfirmed/confirmCwd/cwdConfirmed 一并删除); set_workspace({cwd}) 语义变为「改这个身份的工作区, 此后新开的会话/化身在该目录启动 (pendingCwd, /new 或 respawn 生效)」—— 活会话不迁移、不再指示 handoff, handoff 保留为纯上下文管理 (顺带应用已排的 pendingCwd)。
- v3 管家指定 (§3): `chatPolicy.<chat>.steward` (新配置字段, 热生效) 把一个聊天的管家从「默认会话 (untagged)」升为**可绑定的身份** —— 绑定后该群裸消息路由到这个身份在本群的化身 (没有化身就自动开一个: 记录挂在身份上、名字用身份名、pane 起在身份锚点的工作区, 新群不再 auto-spawn 兜底目录的默认会话); 管家手闸 (steward-guard) 的判定从 `!tagOfKey(owner)` 升为「owner 是该聊天绑定的管家化身」—— 指定的化身即使带 slot 也 arm, 换绑后旧默认会话自动卸闸; 宪章管家章跟着同一个判定走。全新聊天 (还没有任何会话) 由**全局管家**接待: boot 把 home (defaultChat) 现存的默认会话标记为 `kind:global-steward` (幂等; 未认领的新装机不造幽灵记录), 其身份在任意新聊天的化身即该聊天的接待者。判定与解析集中在 `daemon/steward.ts` (纯函数, 不写盘); 存量聊天的 untagged 记录本身就是绑定事实, 裸消息行为一比一不变 (回归钉死: 存量聊天裸消息仍落 base、零 spawn)。
- v3 P7 约束刀: pane≠身份全链审计 + 断言钉死 —— P2-P6 后无「pane 名/pane id 推导身份」反推残留: 身份→pane 名 (windowLabel/safeWindowName) 纯显示、寻址永远按 pane id; pane id 消费面 (selfRef/targetForPane/stop_wizard/interruptPane/idle 探针/@wezard_managed/reapUnborn) 全是经绑定守卫的定位器; roster census/L0 按 identity 聚合、read_chat 按 target key 归档。断言 (tests/pane-identity.test.ts): 同一身份两群各一个 pane (窗口同名) 时 roster/read_chat 按身份聚合、drop 一个 target 不伤另一群身份/名字/解析。
- v3 P7-B 回执署名改口径 (人 2026-11-13): 判定「是不是回执」**关键字优先** (带 `RESULT:` / `NEED:` / `PROGRESS:` / `ARTIFACT:` 即回执, 不再以 @ 为前提) —— 裸 RESULT 按原归属落它服务的那一行 (settleUnaddressedResult 不再拒, 不可结算的行照旧纠正), 未归属轮的收口按关键字放行 (receiptKeyword, 句中关键字弱信号只放行不抽取)。指定收件人新写法 = 行首 `.name RESULT:` (锚行首防小数误认), `@name` / `@.name` / `@魔记号 name` 存量三态照认, 一段内多段各投; 渲染与文案 (renderPeerEnvelope / renderLeadRules / renderTopOnly / 纠正反馈 / 409) 全改教新写法。
- v3 P7-S1 群聊记录与账本地基 (implicit 模式零行为变化): 新增 `shared/chat-record.ts` (ChatLine 纯函数: sliceBatch 触发消息全文/其余倒序截断/每行 ≤300 字/溢出一行指针/剔 self 与卡片系统行, renderBatch)、`daemon/chat-records.ts` (每聊天一份 append-only jsonl 于 `stateDir/chats/`, 内存单调 seq, 保留条数/天数上限, 写失败只记日志、入站不 await 写盘)、`daemon/members.ts` (`members.json`, 键 `chat|identity` **零 pane 维度**, join/leave/isMember/modeOf/advance 游标只进不退)。记录接入只观察不动行为: 人话在 inbound dispatch 前落一行, 出站在 last-response 的同一 SDK 包装层记一行 (作者 parseTagHeader 反解, `[wezard]`/`[mirror]` 前缀与卡片/媒体记 system)。词汇面: reminder 新种类 `chatlog:{chat,from,to,owes}` (登记/TAIL_ORDER/label, S1 无渲染方)、`ReceiptStatus` 加 `passed` (终态「无需答复」了结, S1 无写入方)、`ChatPolicy.speech: implicit|strict` (缺省 implicit, chatPolicyOf 透出)。`chat_members` / `chat_say` / `chat_reply` / `chat_ask` 四工具 registerRare 隐藏注册 (需 WEZARD_MCP_EXTRA), 非 strict 群 handler 一律 409。零变化判据 7 条全数落地 (含出站 payload 改前改后逐字节 diff 为空)。
- v3 P7-S2 按群开严格模式 · 第二刀 (义务与批量 + 四工具实装): **义务与批量** (inbound dispatch 前置) —— 严格群里每条人话的根路由行即义务: 被点名者非成员 = 直接入群 (默认 mention) + 一行成员变动系统行; 注入正文尾部拼一批聊天记录 (chatlog 信封 {chat,from,to,owes}, 触发消息 100% 全文, 预算 3600 字 ≈ 整批 ≤6KB), 成员游标**只在注入 committed 后**推进 (advanceChatlog 从注入文本读回信封核对; uncertain 不推进, committed 的证据链已核对 transcript); `chat_ask` 在严格群向成员开子行义务 (问话记 wizard 行 + 子行 + 同机制注入)。**四工具实装**: `chat_reply` (校验义务未结且 owner=调用方; 带 text 先 finishPlaceholder 覆盖占位、窗口过了退回 notifyChat, 不带 text 记 passed; 幂等键 chat_reply:<re>:<contentRev>, 同 re 二次 409 不重复发送; 关账 = answer+hand, 不走 deliverRoute 自动投递)、`chat_say` (每轮 ≤3、每群每分钟 ≤10; 非成员 403; mention 必须带指向自己的有效 re 否则 409)、`chat_members` (带 mode 语义说明)、`chat_ask` (双方都必须是成员); notify / send_file 在严格群共用同一道门。判定核抽出 `daemon/strict-gate.ts` (sayVerdict 纯函数 + openSayMeter 记账, 判据②的测试面)。四工具从 registerRare 升常规注册 (改既有断言: chat-record.test §7 由「无 env 不在工具面」反转为「在工具面」)。补 S1 漏项: router 的 OUTCOME_STATUSES 收 `passed` (S1 加了词汇没有写入方, 落盘重放会拒启动)。tests/strict-chat.test.ts: 判定矩阵 10/10、义务每话一条 + passed/二次拒绝、20 条消息 3 次激活每个 seq 恰好 1 个 chatlog、批 ≤6KB + 触发全文、uncertain 游标不动。
- v3 P7-S2 按群开严格模式 · 第三刀 (成员与宪章): **宪章** —— `CharterArgs` 加 `speech`, strict 群的宪章用新 `renderStrictChat` 节替换顶层模式那一节 (教 chat_reply/chat_say/chat_ask、chatlog 块怎么读、义务不随终句关账、/owed); 管家章 arm 条件与审批手闸 (approval.ts) 同步改为 `topOnly || speech==="strict"`。**成员**: `chatPolicy.<chat>.steward` 换绑时成员表原子交换 (旧管家卸任 —— owner 行才离群, speaker/mention 保留; 新管家 join owner) 且两件事合并成一行系统行; `spawn_wizard/clone_wizard/delegate` 加 `join:{chat,mode}` 参数 (缺省不传; 只在 strict 群生效, 入群记一行成员变动系统行); 身份退役 (forgetWizard / memory-steward 清理) 自动 `members.leaveEverywhere` 全群摘除 (members.ts 新原语)。**人侧**: inbound 新命令 `/owed` —— 本群义务账 (谁欠哪条、re、多久; 未开严格模式的群回指路)。tests: charter.test 补 strict 节断言、strict-members (join 升级式/游标只进/全群摘除)。
- v3 P7-S2 按群开严格模式 · 第五刀 (rolepage 身份页, 补 A 审计发现的缺口): `WorldFactWizard` 加 `identity` (daemon 的 collectWorldFacts 对 live/cold 各写), `makeDirectory` 为每个身份选规范 target (锚点 target === identity 优先, 否则字典序最小 —— 恒定可复现) 并暴露 `dir.canon`; 名字解析 (byName) 不再同身份 last-wins; `resolve` 把老链接里的化身 target 落到身份页; `status` 跨化身合并 (任一活着即活着, waiting 并集, runningUntil 取最大); `allMessages` 接 canon (chat-http 四个视图全接) —— 消息双方收敛到身份, 两群两个化身的往来 (含私聊窗口) 聚成一页。无 identity 的老 daemon 快照恒等, 与旧行为一比一。tests/role-identity.test.ts。
- v3 P7-S2 按群开严格模式 · 验收夹具 (9 条数字全数落地, 宅内既定的闭包抽取/直接实例化模式): `strict-outbound` (判据①⑨: 50 轮混合夹具 strict 群终句/流式/CoT/standalone 出站 = 0, 同一夹具 implicit 对照组各路径出站 > 0 证明夹具有效; 占位 ack 代码路径 p95 `0ms` ≤ 1.5s)、`strict-cards` (判据⑦: 非成员审批卡 10/10 + 提问卡 10/10 直进 strict 群 —— 真实 makeApproveHandler/makeAskHandler + 假 client, 隔离 stateDir)、判据②③④⑤⑥ 分别由 strict-chat / strict-final / strict-obligation 覆盖 (判定矩阵 10/10、义务每话一条 + passed·二次拒绝、seq 无重复 + uncertain 不推进 + 批 ≤6KB + 触发全文、提醒/上报各恰好 1 次 + 假时钟 24h 零迁移、implicit 拨回关账 + routes 重放)。
- v3 P7-S2 按群开严格模式 · 第一刀 (出站门与关账, `chatPolicy.<chat>.speech:"strict"` 起效): **出站门** (mirror-bridge) —— 严格群里模型的一切「发言」不再自动进群: turnSilent 加 strict 判断 (终句不出站)、sendStandalone 只放行 `[wezard]`/`[mirror]` 系统提示、CoT 进度行 (flushCot / updateBriefProgress / updateBriefToolProgress) 直接 return、pushProjectInfo (会话边界回执) 不发、非 brief 流式帧 (flushStream / finalizeStream / exitDeferredAsFinalStream) 全部拦下、hardTimer 收口不添字 (占位长什么样就怎么收); 人只见占位 (ack 的「链接 …」) 与详情页。新增 `finishPlaceholder(target, msgId, md)` (chat_reply 的交付口子): 在流窗口内把占位气泡覆盖成正式答复并收口, 气泡已收/过期返回 false 由调用方退回 notifyChat。**关账** (router): `onFinal` / `finalReleased` 加 `strict` 参数 —— 严格群 chat 接收行 (人话根义务) 的终句**零 op** (不落定、不中途态、不追述), deliverFinal/settleFinal/eventFinalGate 全链传参; 私聊与 wizard 接收行照旧 (行首 `.name RESULT:` 语义不变)。拨回 implicit 后 strict=false, 未结义务照旧由下一句终句关账 (tests/strict-final.test.ts)。改既有断言 1 处: slash-replies 的 pushProjectInfo 闭包抽取补注入 baseOfKey/strictBase (出站门引入的新引用, 语义不变)。
- v3 roster 金字塔 (§4): `wizard_roster` 从平铺一页改为三层渐进披露, 预算全部数值化 (依据 2026-11-13 现场实测: 1154 记录, 行均宽 55-59 字符, 全机平铺 97,211 字符 ≈ 53k token)。**L0 在场** (默认, ≤12 行): 自己 + 本群管家 + 学徒 (钉住, 截断不丢) + 本聊天 48h (`ROSTER_L0_ACTIVE_MS`) 内动过的化身, 各一行, 尾行全机普查 (`N 身份 · M 群 · 忙 x 闲 y 冷 z`, 身份按 `identity` 去重), 字符预算 800; **L1 本群** (`chat` 参数, ≤40 行含职责/最近子行, 字符预算 2,600): 该聊天全部化身含冷; **L2 组团** (`scope:"all"`, ≤60 群行, 每群一行名字串 (5 名 + `+n`), 无 summary/职责, 字符预算 4,200); 单体详情仍是 `peek_peer`。**自动降级**: 调用方 ctx ≥ `handoffAt(model)` (现有函数: 1M 窗口 200k / glm 89.6k) → 无论要哪层只回 L0 并注明 `ctx Nk 已到交接线`。**升级提示**: 按名字 query 而 L0 没命中本群时, 尾行提示 `全机命中 N 个: {query}/{scope:"all"}`; 溢出截断行报总数与收窄建议。响应带 `layer` 字段; `limit` 参数退役 (层内上限即预算)。charter 出生名册 `ROSTER_MAX` 15 → 8 (L0 快照化)。
- v3 P7-S3 新群默认 strict (known-chats 册): 新增 daemon/chat-seen.ts — stateDir/known-chats.json 册 (boot 快照存量 legacy + 运行时首见登记 + boot 增量: 新冒头的盘上痕迹按存量并入, 首见登记跨 boot 不翻案)。判定链: 显式 chatPolicy.speech > 首见 (在册非 legacy) strict > 存量/未在册 implicit; chatPolicyOf 的 speech 缺省与 mirror-bridge 的 strictBase (原内联 cfg 直读) 接同一判定。首见登记点: 人话 noteHuman (先于 dispatch → 新群首条即 strict)、出站 tracker、频道 onTopic (chat:<topic_id> 同权)。只有群聊首见默认 strict, 单聊永远 implicit 缺省 (私聊口径照旧, 显式 chatPolicy 仍可单独给单聊开)。
- v3 P7-S3 存量群切换命令 /strict (只做不执行): daemon/strict-switch.ts 纯函数 + inbound /strict 命令。默认 dry-run 什么都不写; apply 在最前才写 chatPolicy.<base>.speech=strict 并过宪章守卫 (受影响 wizard 自动挂交接提醒) + 每群一行系统行; 支持聊天列表 / --all (候选 = 册里的存量 implicit 群) / 不带参数 = 本聊天。没有任何无显式 apply 的写路径。
- v3 P7-S3 频道 strict: strict 频道自动出站 (流式终帧 + sendMessage 退路/notify) 一律 send_post — 终句不再包装成评论; implicit 频道行为不变。工具面 sendTopicContent (导出): chat_say / chat_reply 遇 chat:<topic> 按 replyOk 选 send_reply/send_post, msgid (义务信封的 msg) 锚定具体帖子。判官保留, strict 频道多一职: respond=开义务 (respond=false 不开), rewrite 句首 .name 点名=落给谁 (走现行路由+成员机制, 判官 JSON 契约未变)。
- v3 P7-S3 读侧: 严格群 read_chat 改读 chat-records 账本 (实际发出内容, 行号=seq, 与成员游标同一份账; renderChatRecords 支持作者过滤/时间窗/limit/per/翻页), 私聊与 implicit 群照旧 transcript。roster L0 严格群在场 = 本群成员+欠账数 (owner→speaker→mention), 总行数 ≤12。rolepage 治理面板: WorldFacts.governance (成员表 × 路由行 × 义务观测) → 群窗口顶部 govbar (成员/游标/欠/passed/overdue)。
- v3 P7-S3 退役候选清单 (只登记不删): docs/evolve/v3-p7-retirement-candidates.md — deferred 出站 / standalone 兜底 / CoT 进度行 / eventFinalGate·finalReleased 推断四条的位置锚点、被 strict 什么取代、退役前置条件与风险注记。
- v3 P7-S3b rolepage 群窗改账本口径: strict 群的 turn 出气泡被压掉 (模型终句从未进群, 不该在群里回放) —— 实发内容由出站 tracker 的 hook 落 post 记录 (body 与账本行同一文本, 流 id 去重: 占位→交付同一流只留最终那句), chat_reply 的 passed 落一条「（passed — 无需答复，未发言）」标记 post (沉默与「没这轮」可分辨); WorldFacts 加 strictChats (daemon 推送, svr mergeFacts 合并 —— 顺带修了 mergeFacts 重拼时丢掉 governance/humanNames/weixin 的旧洞, 公网 svr 的治理面板因此才真正可见); implicit 群与私聊零变化, 老数据 (无 post 的历史轮) 仍显示入消息。
- v3 P7-S3c 账本命名空间与入消息口径: ① wizard 出站行的账本 id 改用 `<id>#w` 独立命名空间 —— replyStream 的流 id 就是入站 msgid, 撞车时重投的人话会把交付行整行洗掉 (record 按 id 覆盖); 后缀隔开两个命名空间, 同 id wizard 行的 upsert 语义保留, 历史行不回填改写。② strict 群的人话入消息正文改用账本原文: dispatch 链路带 rawText (信封/提醒尾部之前, 与账本 human 行同一文本), 落成 turn 记录的 rawQuery 字段 (queued 印章激活 / final 建轮 / 排队印章三条建轮路径都带), rolepage 入消息按它渲染 —— 与出气泡同源 (账本); implicit 群与私聊照旧 userQuery+splitReminders, 老记录 (无 rawQuery) 回落不变。
- rolepage 工具框里的出站调用 (chat_reply / chat_say / notify / send_file, 含 REPL / DeferExecuteTool 外壳) 像 delegate / tell_peer 一样挂一行「发到哪、发了什么」: `↩ 回复 / 💬 发言 / 📣 通知 / 📎 发文件 → 群名` + 正文首行 (全文收在 chevron 下), 没起名的群写「本群」/「未命名群」而不是 base; 交付细节 (替换占位气泡 / 新消息 / 答的哪条 msg) 只进悬停说明, 只露 `未发言` / `频道评论` / `待送达` 这类人要知道的标签。外壳里认出了 wezard 调用时, 工具标题改成「说明 · 调了哪些工具」(如 `REPL(回复 hi · chat_reply)`), 不再把 JS 源码塞进标题 (delegate 等同样受益); 提示行都调成了就不再摆那行转义了几层的回包 JSON 预览 (原文仍在展开后的 output 里)。

### Fixed
- **chat_ask 的 after 前置完成后补唤醒被点名者; after:["undefined"] 旧受害行可补投**: judge 在前置未满足时把 wake 落成 [] 存在行上, 之后前置以 done 关闭没人重算, 被点名者永不唤醒 (它的 seen 游标可能早已越过那一行, pending() 现算也救不回来)。现在一条以 done 关账的 reply 落盘后, daemon 重算 after 含被关消息的 duty (跨 room 也算): 前置全部 done、duty 仍开、处理人是 wizard 成员、账本里没有任何一行唤醒过它、它也没 re 过 → 在那个 room 追加一行 `kind:"trigger"` (to = 处理人, re = 原 ask, `sys:"after-wake"`, 正文带原 ask 全文), 不开新 duty, 「你要交代」经 re 指回原 ask, 不占回合预算; 幂等以账本里已有的 trigger 行为准, 重复关账 / 重启不重复。boot 时全扫一次 (只收真前置)。`afterSatisfied` 把 80adecb 之前落下的假 id `"undefined"` 视为「没有前置」; 这类旧受害行 boot 不自动补, 经 `POST /room/after-reconcile` (要 daemon 口令; 缺省 dryRun 只列清单, `{fake:true, dryRun:false}` 才补, `only:[msgId…]` 只补这几条) 补投, 补投判定与只读清单脚本 `scripts/after-fake-audit.ts` 同一函数。tests/room-after-wake.test.ts。
- **新群引导: 引导先关账再绑定, 原话仍交给管家 (v3 遗留项 6)**: 以前只 move 仍开的 duty, 引导若先 chat_reply 关掉人那句再 onboard_bind, 原话就到不了管家 (只靠指令约束)。现在 `guideHandoffOps` 找出引导关掉的人话行 (`guideClosedHumanLines`), 在完成行后追加一条 daemon task 行 (`sys:"onboard-forward"`, re 那些人话、正文引用原话) 给管家开新 duty 并唤醒一次; 完成行此时不再重复唤醒。
- **rolepage 图: 两人 room 直连线 (v3 遗留项 3, 人 2026-11-21 改规则)**: 只有恰好两个 wizard、没有人 (human) 成员的 room 不画 room 节点, 改为两人间可点的直连线 (点 = 打开该 room; 有未决 duty 时浅红); room 里只要有人始终画 room 节点。修「Grace ↔ Jack 有 room 节点却没有 Jack」: `participants()` 对 room 成员按活跃度 / 时间窗二次筛选, 不活跃成员被筛掉后 room 的成员边画不出 —— 改成 room 上图则成员全上图。
- **room 轮终「被提醒后仍没有交代」误报 (人 2026-11-21)**: 唤醒判定只认「这一轮 chat_reply 过」, 用 progress / need 交代、把活转给同伴的 holder 下一轮闲下来仍被提醒, 再下一轮往群里写系统行。现按账本算 (`dutyAnswered`, shared/room.ts): holder 在最近一次被该 duty 唤醒之后写过任何 status 的 reply 即算交代 —— duty 照常开着等 done, 只是不提醒、不告状; need 被补答再唤醒后没交代仍照常提醒一次 → 系统行。同时修掉群里「[wezard] [wezard] …」: `roomBubble` 对正文已带 `[wezard]` 的 daemon 行不再叠前缀。
- **rolepage 注入气泡 (v3 遗留项 1/2)**: 注入行回账本取全文后也过 `splitInline` —— `<system-reminder>` 信封不再原文外露 (折成标签进 rems); 「注入原文」从气泡里的折叠块改成头部 avatar 行末的 `⟨/⟩` icon, 点击整行 + 气泡一起切到原文; 时间与「过程」按钮紧跟收发人, 不再顶到最右。
- **rolepage 群名 / 会话下拉 / world (v3 遗留项 7/8)**: daemon 的 chatNames 只有 config.chats 的存量标签, 新群在 rolepage 上只剩「群 …xxxx」—— `withChatNameFallback` 按默认 wizard 名 → 同群 wizard 的工作区 basename 兜底 (已有名字不动, 不回写 daemon); sessionId 为空的会话段在下拉里用 `spanKey` (`start:<起始时刻>`) 做取值, 选中不再回落「全部」; `/api/world` 删掉无人读的 `edges`。
- **闲着的 wizard 被判忙, 回执一直压在 room 账本里 (Claude Code 2.1.3xx `api-request-blob` 行)**: 新版 CC 往转录里写带 `message.content` 的 `api-request-blob` 行 (按 hash 去重的请求消息快照, 无 uuid / 时间戳 / 顺序)。`openToolUses` 把它当对话轮读, 一个没有配对 tool_result blob 的 tool_use 就成了永远「悬着」的调用 → `idleVerdict` 判「停在审批框」→ `isBusy` / `idleNow` 恒为忙, room 唤醒泵把给它的回执与 interrupt 一律压着 (看门狗 busyList 里 busyForMs 一直涨; 重启也不自愈, 事实在转录里)。Claude 后端的 `normalizeTranscriptLine` 改为丢弃这类非对话行, 所有转录读侧一并受益。tests/claude-blob-rows.test.ts。
- **spawn_wizard 「MCP task … failed: The operation timed out」 (2026-11-20 23:10)**: 根因不是 spawn 路由, 是主机内存耗尽 —— 3.7GB、无 swap、无 oomd 的机器上一个 lead 半分钟内连生 4 个分身 (每个 CLI 常驻 ~250–400MB), 每次领用又补一条空白备用, 内核赶不走匿名页只能抖动: 守护进程事件循环停了 6 分钟 (看门狗 23:10–23:15 全空, 企微心跳断 1006), 那次 spawn 在 MCP 侧 ~350s 超时 (分身其实 23:16 照样生了出来), 23:48 整机被重启。新增 `wrc.memoryGuard` (仅 Linux, 读 /proc/meminfo 的 MemAvailable, hot): `spawnMinMb` (默认 600) —— spawn_wizard / clone_wizard / delegate 新建在占名字之前先查, 不足立即 503 并说明; `spareMinMb` (默认 1500) —— 不足就不补空白备用。shared/mem-guard.ts + tests/mem-guard.test.ts。
- **tmux session `wezard` 反复消失 (2026-11-21)**: 三处叠加。① systemd unit 缺省 `KillMode=control-group` —— 开机后第一条 `tmux new-session` 往往由 daemon 发起, tmux server 落进 `wezard.service` 的 cgroup, 每次 reload / 重启 / 崩溃都把整个 server (全部 wizard pane 与同 socket 上人自己的 session) 一起杀掉; 模板改 `KillMode=process`, 只停 node (已装机需重跑 `scripts/install.sh daemon` 重写 unit)。② `has-session → new-session` 非原子: 多个冷目标同时重生 (boot、room 泵 30s 重踢) 时只有一个建出 session, 其余报 `duplicate session` 失败; 现在撞上就改走 `new-window` (反向的 session 已没了再改回 `new-session`)。③ 转录已不存在的绑定 (f113e25 起保留不改绑) 被泵每 30s `--resume` 一次, CLI 报 `No conversation found` 退出, 又不带 `--model` 再起一次 —— 它是 session 里唯一的窗口时整个 session 跟着塌; 现在 `injectText` / dispatch 重生前先查转录, 缺失即不可重试地失败 (提示发 `/new`), spawn 遇到 `No conversation found` 也不再做无意义的去 `--model` 重起。
- **rolepage 左栏列表照 main 重做, 细滚动条, 长串换行 (人 2026-11-20)**: 列表视图的样式照 main 的会话列表 —— 分组标题「群聊 N」「会话 N」(空组不画), 「近 2 天 / 全部」与「图」开关是 main 的 `.vt` 小开关、挂在第一个标题右端; 群头像是前 4 位成员头像的拼块, 名字用 `.nm.chat`, 未决 duty 用红点计数。列表视图下左栏宽度沿用 main 的 `max(332px, 25vw)`, 图视图仍是半屏, 切换时跟着变。名片上的「🔌 已绑定企微」chip 删除 (群聊分组与头像已经说明有人参与), 绑定与否放进名片头像的 tooltip。整页统一细滚动条 (main 没有自定义滚动条, 依赖系统; 这里用 `scrollbar-width: thin` + 现有 `--line` 色)。附件名 / 长 id / 长路径等无空格长串在气泡、消息头、附件 chip、成员栏里 `overflow-wrap: anywhere` 换行, 不再撑破布局。
- **rolepage 左栏恢复聊天列表 + 搜索 (人 2026-11-20)**: 左栏可在「列表 / 图」两种视图间切换 (记在 localStorage, 默认列表)。列表把 room 分两组: **群聊** = 有人参与 (绑定企微的群 / 单聊 / topic / 微信, 或账本里有人发过话), **会话** = 只有 wizard 的 dm / adhoc; 不再有「单聊」一类。显示名 = room_name 别名 > 聊天名 > 短代号 (没起名的 dm 写「a ↔ b」, adhoc 写「临时 · 前几位成员」)。列表视图左栏收窄到 360px, 把宽度还给 chat detail。名片下恢复 main 的搜索入口与 ⌘K 面板, 照 main 的行为搜 room 名 / 成员 / 消息正文 (新增 `GET /api/search`, 服务端在 `shared/room-search.ts`; 空格分词、全等 > 前缀 > 最近; 点消息打开它的 room 并定位到那一行, 不在已取的一页里就往前翻)。顺带: 定时刷新不再丢掉已翻出的更早几页, 晚到的旧请求不会把视图拽回旧 room。
- **rolepage 成员列挪到整页最右 (人 2026-11-20)**: 点开 room 后的成员列 (#gside) 从左栏图的右沿挪到 chat detail 右边, 作为整页最后一列; host 标记 ⭐ 从名字左边挪到右边 (单独一格, 名字截断时也不被吃掉)。窄屏 (≤760px) 不显示成员列。
- **rolepage chat detail 对照 main 补齐 (人 2026-11-20: 「chatdetail 迁移得太失败了」)**: 气泡只放写进账本的那几行 (chat_reply / chat_say / notify / send_file 全文), CLI 终句零语义, 收进过程框标 aside; 唤醒 wizard 的账本行按账本画在那一轮之前, 注入原文不再画一遍; 消息里的 `<system-reminder>` (envelope / hint / roster …, 含被压进一行的) 剥成按种类命名的折叠标签, 点开看原文, `<pasted_content>` 包装剥掉; 过程框可点开收起 (轮询重画保持展开态), 工具调用展开懒加载正文; 顶栏只留标题与 W-1/W-2, 模型 / 在线 / 职责回到左上名片与底部用量条 (#pg-usage, main 同款); 提示行的名字可点、箭头颜色 = duty 的交代, 收起时不再重复露出发言行; 账本行按回包里的行 id 对到产出它的那一轮 (按时刻猜会被紧接着的下一轮抢走); REPL 里的 chat_ask 恢复提示行。
- **新群引导按 room 设计重做** (2026-11-20 实录: 首句「在 ~/develop/Tencent 下创建一个 dhtpm 的目录, 并在里面初始化 codebuddy.md, 然后绑定它为 workspace」被从长句里抽第一个路径片段 (~/develop/Tencent) 一步绑成父目录, 0.5s 内管家就位, 人真正要的三件事全丢, 触发绑定的那句还被吞掉): **快路径只收整句答案** —— strip @ / 引号 / 尾标点后整句就是一个路径、或整句就是一个名册命中的管家名, 其余 (含路径但还有别的话 / 相对路径 / 认不出) 一律交引导化身, 斜杠命令与点名行为不变; **引导化身进 room 当 founder (ord=1)**, 人这句落账本并唤醒它, 引导用 chat_reply / chat_say 在**本群 room** 里说话 (工具面白名单三项, 其余照旧拒), 并发起一次受控绑定 **onboard_bind({workspace?, create?, name?})** (只有引导能调, 其余 403; create:true 只 mkdir 最后一级 —— 父目录必须已存在、目标必须在 $HOME 下; 校验失败 4xx 带原因, 引导自己追问); 成功 = 绑定 + 管家 join (via invite, by guide) + 引导名下 duty 全部 move 给管家 (人的原话跟着走并唤醒它) + 引导 leave (此时已无 duty, 不产生 canceled 行) + `[wezard] ✅ 引导完成` 系统行进 room (镜像进企微), 引导在这一轮结束后 (或 60s 上限) 才 kill + drop。绑定之外的任何要求 (如「初始化 codebuddy.md」) 引导不做也不答, 随原话交给管家。旧的「daemon 指令 + 人的原话」直注、以及「引导没有工具面 / 不发宪章」一并取消 (引导的宪章就是那三件工具的话术)。tests/onboarding.test.ts。
- **room 行覆盖人的占位气泡时丢了身份头与尾部 rolepage link** (人 2026-11-20: 「直接点名的 wizard 在群里下发消息, 没有在头部追加自己的身份, 也没有在尾部追加 link」): 第一条 re 着人话且带正文的 `chat_reply` 走 `coverBubble` 收口那条人话的占位气泡, 交给传输的却是**裸正文** —— `withMessageFooter` 只从正文头反解作者, 无头正文原样放过, 那条气泡因此既无名也无 ✦。镜像正文统一由 `roomBubble` 写 (作者头 `🧙 name：`), 覆盖与发新气泡走同一个头; 群里被点名的 wizard 与管家对人话的答复都回到「头 + 尾 link」。tests/message-format.test.ts 钉死覆盖路径的成串结果 (裸正文仍原样放过 —— 那是防误署名的既有语义)。
- **room 切换的「先 /new」不再把 pane 晾成只有 /new 的空会话** (2026-11-20 切换后 18 个 pane 停在空会话里): 契约 §7 的 /new 原来是往 pane 里敲 CLI 自己的 `/new` —— codebuddy 当场换 sid, 新转录首条只有 `<command-name>/new`, mirror 只认 /clear 的轮换, 绑定钉在旧转录上、宪章不重挂, 名下迁移来的 duty 也没人再唤醒。现改走 daemon 的 newSession (杀 pane + 新 sid 重生 + 宪章随首条注入), 逐个串行 (避免并发冷启动 ENOMEM), 同一 target 不并发; 标记文件 `state/rooms-cutover-new.flag` 有内容时按行读 target key, 只重开列出的那几个。mirror 侧把注入的 `/new` 与 `/clear` 同样认作清空轮换 (迁移观察 + 宪章重挂), 别的路径敲进 CLI 的 /new 也不再孤立绑定。
- **chat 义务的 topOnly 豁免 + 终句静默失败当轮可见** (aiconfig 群实录补充链): ① chat_reply 的 topOnly 门新增例外 —— 这条 re 正对着**自己名下未结的 chat 义务** (目的地即那一行收件的群) 时放行: 那一行本身是对人的出口 (人点名 / 管家 transfer 交来的), 销账又只走这一条路, 拦了它, belowTop 轮 + chat 义务就是一笔永远销不掉的死账; chat_say (无 re) 与别人名下的义务不豁免。② strict 群 chat 义务上的 prose 终句 (无收口形态、无出站, resultRoutes 空、看似 complete) **当轮立即**注入一次交付指引给该 wizard (`strictUndeliveredNotice`, 每行一次, 落盘 `stateDir/strict-delivery-notices.json`, 行落定即清) —— 不再等闲置阈值, 更不再静默; idle-nudge 的补发追问仍是之后的兜底。tests/strict-delivery-nudge.test.ts 补话术断言, strict-chat.test.ts 钉死豁免接线。
- **非成员不背义务 + 成员口径统一 (aiconfig 群实录: 义务 move 给非成员 .GraceVance, chat_reply 永远 403, 名册 6 个而 chat_members 只有管家 1 个)**: ① **transfer 拒收** —— strict 群的 chat 义务交给非成员直接 409 (接手方必须在本群成员表里); ② **点名入群不挑类** —— 人在 strict 群点名, 注册表里的 wizard 即入群 (不再要求 identity; 无类的存量 wizard 一样进), 出站门 (strictSayGate) 与 chat_ask 的成员判定只按成员表 —— 「义务在、发言权无」的口径分裂消灭, identityOfTarget 从成员判定整体退役; ③ **成员表补齐 (boot, 幂等)** —— home 是 strict 群的注册 wizard 全部补进成员表 (mention, by `system:repair`, 每群一行汇总系统行), spawn/clone 落地 strict 群 home 即 join mention —— 「home 群在、成员表无」不能再出现, 名册的 home 面 ⊆ 成员表, chat_members 与名册口径一致 (补录成员游标 -1, 首批聊天记录全量重放, 有界)。tests/strict-chat.test.ts 增补接线断言 (transfer 拒收 / 成员表唯一判据 / boot 补齐留痕 / spawn 两处落账)。
- **严格群「已答未交付」的上报改道: 运维动作直投 wizard, 人只看人话** (人 2026-11-18 aiconfig 群实录打回: 「daemon 如果发现问题, 可以直接给哪个 wizard 说, 让它调用 chat reply」): 追问用满仍无交付时不再往群里发「可以让它用 chat_reply 补发, 或用 stop_wizard 收掉」这类把运维摊给人的系统行 —— 补发/转述/收掉的跟进指令 (`strictDeliveryStewardNote`, 带行号/re/最后一句摘要) 改为直投**本群管家**的输入框; 群系统行 (`strictDeliveryHumanLine`) 只在**没有管家可托付** (或管家自己就是欠账方) 时出现, 且只说是什么坏了、人要不要管 (不出现工具名与运维步骤)。obligation-watch 管家逾期行同步改写成人话 (其「已答未交付」分支是 rows 过滤后的死代码, 一并摘除)。tests/strict-delivery-nudge.test.ts: 管家段带行号/re/出路/截 300、人话行零 wizard 词汇。
- **严格群「答了没出站」: 出站门判完之后 daemon 真的追问一次补发** (人 2026-11-17 决定 B; 现场 e4622be.1 / e690042 / e172afa 三次:「生成了答复、只写成 prose 终句」, 群里彻底静默, 分不清卡死还是答了没发): 出站门记 `brief: strict conclusion (no outbound, obligation open)` 之后, idle-nudge 不再只写一行「不再追问, 交 obligation-watch」就放过 —— 这一件挂专用追问口径 (`{max:1, cycles:1}`), 闲满 `idleNudge.afterMin` 时经 `injectResume` 的 `textOverride` 下发**补发指引**: 「你这一轮已经写出了结论, 但它没有进群 —— 严格群终句不进出站门, 只有 chat_reply 算交付; 用 chat_reply({re, text}) 把它发出去」(通用话术「进展如何 / 还没交回结论」对它是错题: 它以为自己答完了)。问满仍无出站 → 一条带 event id 与最后一句摘要 (300 字) 的 warn + 一条群系统行 (`strictDeliveryReport`), 然后闭嘴, 行留在义务账。`Policy` 新增 `cycles` (冷却轮次上限, 缺省 `MAX_CYCLES`; 1 = 问满这一组不重开) —— 这是唯一的新边界, 次数/冷却/上报全沿用 idle-nudge 既有的落盘计数与 `escalate`。**与 obligation-watch 划清职责**: 它的「义务还没回 — 用 chat_reply 交付」只发给从没答过的行 (已答未出站的行从 `rows()` 排除), 同一件事不提醒两遍。出站门那行日志从 info 升 warn 并带结论摘录。tests/strict-delivery-nudge.test.ts: 话术 / 16 天只问 1 次只报 1 次 / 追问真的下发 / chat_reply 关账后不再追问且记录清掉 / 重复巡检不刷屏 / 无专用口径的件照旧走通用话术。
- 严格群宪章写明「终句不是交付」: `renderStrictChat` 的礼仪第一条 —— 只把结论写在回复里 = 群里一个字也没有, 终句不进出站门, 只有 `chat_reply` 算交付; 收口这一轮必须真的调它 (带文件同轮 `send_file`), 没调 = 没发。现场: 2026-11-16 sanitizer 群 e4622be.1 / e690042 / e172afa 三次, 模型生成了答复却只写成 prose 终句, daemon 记 `brief: strict conclusion (no outbound, obligation open)` 后出站门吞掉, 人看到彻底静默。
- rolepage strict 群里管家的回复又落回 CLI 终句 (「已回复。」) 当气泡、真正发进群的那句却不在这一轮里: 实发 (post) 记在管家**身份锚点**的 target 上, 轮次记在本群**化身**的 target 上, `strictPostsOf` 按 target 字面比对认不出是同一个人。改按身份规范 target (`dir.canon`) 归轮; 气泡正文剥掉群里那条消息头上的「🧙‍♂️ name：」署名 (消息行已写着是谁); 「说给谁」挂到实发气泡上, 不再挂进过程框里那句没进群的 CLI 原话。
- 频道管家按**频道**绑定 (人 2026-11-17 拍板: 「整个 channel 需要一个管家, 绑定时候也绑定的是 channel 的统一管家, 每个 topic 都复用此管家配置」): 原生帧里没有频道标识, 帖子 (chat:opk…) → 频道 (topic_id) 的映射靠同句 topic_at_bot 配对学到并落 `stateDir/channel-posts.json` (新 `daemon/channel-posts.ts`)。`appointedChannelSteward` 按映射查频道表, 引导/绑定 (`bindSteward`) 在频道帖子里改写 `wrc.channel.steward.<topic_id>`; 同频道其余帖子不再引导, 在途引导化身与状态在绑定落定时一并收掉; 散落的帖子级 `chatPolicy.<帖子>.steward` 在下一条频道消息时收口成频道一条 (频道已绑则频道赢, 否则最早出生的升格)。帖子仍是各自的消息通道 (同一管家身份在每个帖子一条化身, 出站回本帖)。`/name` 改名同步改写频道表。已绑管家的群不再残留在途引导状态 (出站豁免随之关)。
- 频道 @ 双路入站致两个 wizard 各答一遍 (2026-11-17 test1 频道实测): 企微现在把频道里 @ 机器人的话同时推原生帧 (`compat_info.source=channel`, chatid = 帖子自己的 `opk…` 群) 与 `topic_at_bot` 事件 (topic_id = 频道), 两路都投 → 帖子绑定的管家与 `chat:<topic_id>` 的默认会话同时回复, 后者还经 lastPost 答进别的帖子。inbound 最外层认出原生频道帧并记账 (`rx frame` 行带 `source`), `topic_at_bot` 等 ≤3s 按发话人认领 (一帧抵一个事件) 后只存缓存不再伪装投递 (`channel at_bot: carried by native frame, bridge skip`); 原生帧缺席时桥照旧兜底。
- **新群引导绑定后管家首个会话不在指定目录 / 带目录的消息「零痕迹」不可判定 (人 2026-11-17 实测)**: ① `newSession` 的 cwd 链在本 target 的 running / 绑定记录之后、聊天兜底与 `wrc.cwd` 之前插入身份工作区 (`MirrorDeps.identityWorkspace` ← `identityWorkspaceOf`) —— 事件泵 (人话首条)、gate、clone 回落、weixin 绑定等所有首次起会话入口一并覆盖, 不再只靠 gate 的三种前置条件; 已在跑 (含 set_workspace 换过目录) 的会话重开仍跟自己的 cwd。② 入站最外层 `client.on("message")` 对每条消息回调落 `rx frame` (msgid / msgtype / chat / quote), 「帧有没有到 daemon」从此可判定; SDK 不认的 msgtype (原本只 debug 一句就丢) 落 warn 带原帧并回一句「暂不支持的消息类型」。
- `/name` 参数不再被 @mention 污染: WeCom 把群聊里的 @ 渲染成与前一个 token 粘连的 `teststrict@wezard` (mention 前无空白, 入站的 mention 剥离认不出), `/name teststrict @wezard` 因此报 `invalid name 'teststrict@wezard'`。现在 `/name` 的参数一律截到 `@` 为止、独立的 @token 整个丢弃 (管家名字字符集不含 @, 不存在误伤), 两种 mention 形态都吃掉。
- strict + topOnly 群的通道穿透堵上: `chat_say` 此前不走顶层模式门 (notify / send_file 走), 被同伴私聊驱动干活的下层 wizard 可用它在 topOnly 群对人发言。判定核抽成 `daemon/strict-gate.ts` 的 `topOnlyVerdict` 纯函数 (belowTop × topOnly × 管家豁免), `topOnlyMuted` 闭包与 `/chat/say` / `/notify` / `/send_file` 接同一道核; chat_say 被拦时回与 notify 同形态的 409 (指路: 结论走行首 RESULT: 回执, 由派活的顶层代为向人交代)。chat_reply (义务交付) 与 send_file 的 delivery 豁免 (48457a0) 语义不动; implicit 群照旧先撞 implicit 409 指路, 行为不变。tests/strict-chat.test.ts 补 topOnly 断言 (下层被拦 / 管家豁免 / 人直说通过 / 非 topOnly 不受影响 / chat_say 门位于 implicit 指路之后 / notify 同核 / reply 无此门)。
- strict 群的宪章礼仪补三条 (只进 `renderStrictChat` 那一节, implicit 群不受影响): ① **发东西一次到位** —— 要说的正文用 chat_reply 一条讲完, 带文件就在同一轮 send_file, 正文不再用 chat_reply 重复同一句 (文件加文字算一次交付); ② **不许轮换试探通道** —— 不许连续换 notify / chat_say / chat_reply 试哪条能过, 判一次该走哪条, 失败如实说明原因, 别拿同一段文案反复重试; ③ **话讲最少** —— 一条能说清就不拆多条, 不补发「已发送」「已完成」这类空确认。现场: 2026-11-16 17:44 .sanitizer 在 40 秒里 notify → chat_reply → chat_say ×3 → notify → read_chat → chat_reply, 17:46 send_file 后又补一条 chat_reply 把同一句话再说一遍, 群里两颗近乎一样的气泡。
- 收口标记的 markdown 装饰不再让回执卡死: ① **教导文本不再教坏** —— peer 信封 / 宪章 / idle-nudge 追问 / 结果纠正 / topOnly 拒绝理由 / MCP 工具说明原来都把标记包成 inline code (行首 `.name RESULT: …`), 模型照抄时把首尾反引号一起抄进正文 (2026-11-16 sanitizer 群 e23ee2f.1: 每条同伴私聊信封都写着行首 `.name RESULT: …`, .SamJones 交上来的是 ``.sanitizer RESULT: …`), 现在统一改成「行首直接写收件人 + RESULT: 结论, 不加反引号/引号/加粗」。② **解析照样容忍装饰** —— 行首成对或单个反引号、引号 (单/双/「」)、加粗加斜、列表符 (- * +)、引用符 (>) 与全角冒号先剥掉再判; 围栏内与行中出现的同名标记照旧不算收口。③ **账本不许无声 stall** —— 完成类弱信号 (带 RESULT/ARTIFACT 关键字) 说这是回执、收口形态却认不出、而它服务的行还挂着 open/need/error 时, 按终态落定该行 (answer op); 只有 NEED/PROGRESS 关键字的仍是中途态, 不拿来收终态; 账本了结与正文去向解耦, 进不进群仍由 finalReleased / eventFinalGate / strict 出站门判, strict 群照旧一个字不发。④ **追问用满必上报** —— idle-nudge 每一轮追问用满仍未收口就发一条群系统行给人看 (每轮一次、按 MAX_CYCLES 封顶, 与 obligation-watch 逾期上报同一口径), 不再无限静默重投。
- rolepage strict 群的轮次不再整段消失: P7-S3b 为了「群窗只画实发」把 strict 群一轮的出消息整条压掉 (`messagesOfTurn` 的 suppressed), 连带那一轮的工具调用与 CLI 终句一起看不到, 只剩一条独立的 post 气泡。改为实发 (post) 并进发话 wizard 当时正在该群答话的那一轮 (`strictPostsOf` / `deliveredTurn`): 一个过程框聚合这一轮全部工具调用与没进群的 CLI 原话 (aside), 其下是实发进群的气泡、作为这一轮的最后一条 (与实发同文的并成一句; 进行中的轮实发一落账即成气泡); 没有实发的轮退回 CLI 终句, 与非 strict 同口径; 归不进任何轮的 post 仍独立成条。
- 回执「答了却认不出」不再静默退化成进展: 收口判定锚行首 (`RESULT:` / `NEED:` / `PROGRESS:` / `.name RESULT:`), 而契约里这一行写的是 inline code, 模型照抄时把首尾反引号一起带下来 —— 整句认不出收口, 对 wizard 收件人一律退化成 progress (行不落定、回执不投), 只有 idle-nudge 每 5 分钟重新追问一次同一笔 (现场 2026-11-16 e23ee2f.1: `.SamJones` 的 `.sanitizer RESULT: 无 WIP 可提交…` 带一个行首反引号, 16 分钟问 3 次、路由行始终 open)。现在 parseClosing / addressedResults 先做同一份行首归一化 (开引号与同行配对收尾换成空格, 长度不变, 切片同源), 单反引号不再是收口形态的一部分, ```/~~~ 围栏与行内代码照旧不算收口; 另在终句落定的出口补一条 warn —— 带收口关键字却认不出形态时留证据, 不再无声地把这一轮当进展。
- 严格群里管家「答了但没进群」不再变成无声的永久追问: 严格群的 chat 义务只认 chat_reply 关账 (终句零 op、不出站), 而 2026-11-13 strict 上线前启动的会话, MCP 工具表是**进程启动那一刻**的 (daemon 的 `/mcp` 是无状态逐请求重建, 老进程不会重新 list), 里面根本没有 `chat_reply` —— 它每轮照常产出终句, 群侧一律不投、账本一律不落定, 于是 idle-nudge 每 5 分钟给它续问一次「还没有交回结论」, 数小时几十轮全是谁也看不到的终句 (现场: sanitizer 群 e172afa, 12:15→16:52)。现在 idle-nudge 对「owner 已为这条严格群义务交过终句 (事件库里有 result)」的行不再追问 —— 关账与上报归 obligation-watch, 摘除时留一条 `idle-nudge: 严格群义务已答但没交付` 的 warn; obligation-watch 的管家逾期上报同时分清「没回」与「答了没交付」, 后者附上它最后说的那句与出路 (本群只走 chat_reply; 该会话若是 strict 上线前启动的, 在群里发 /new 或让它 handoff 重开会话)。账本仍保持 open (不伪造终态), 但不再有无人可用的重投。
- 严格群里 `send_file` 发不出文件: `strictSayGate` 对 mention 成员一律要求挂着指向自己的义务, 而 send_file 没有 `re` 参数 —— 人点名的成员 (默认就是 mention) 交付文件 100% 被 409 (`mention 成员只能答指向自己的义务`), 2026-11-16 在 sanitizer 群实际卡住两次。现在 `sayVerdict` 加 `delivery` 豁免: 文件是交付物不是闲聊, mention 成员不挂义务也发货, **成员资格 (非成员仍 403) 与每轮 3 条 / 每分钟 10 条额度照判**; chat_say / notify 行为不变。同时 strict 群的媒体气泡 (本来没有正文, 出站 hook 只记 `[媒体] file` 系统行) 补记一行交付物账本 (`📎 name (kind) · path`, 账本 id 与 post id 同键, 走 `<id>#w` 命名空间), rolepage 群窗与 read_chat 因此看得到文件交付。
- 严格群里 `/new` / `/clear` 不再一言不发: 会话边界确认 (mirror 的 `pushProjectInfo` / 那句 `cleared`) 走的是模型发言的 standalone 路, 被严格群出站门一起拦下, 人以为命令坏了。现在 `/new` 由 inbound 分支补一条 `[wezard] 🧙 <name> created` (直发 `replyStream`, 不经 standalone 门; `[wezard]` 前缀同时是「系统提示」的判据), `/clear` 在严格群发 `[wezard] cleared`; implicit 群的确认改由 mirror 发 `🧙 <name> created` ( `cleared` 文案不变), 两边都是该会话的 wizard 身份名 (`displayName`) 且记号复用气泡头的渲染原子 (`tagHead` / `WIZARD_MARK`; 不是 pane 名 / chat 名), 不双发。
- rolepage 的 session 分段按 sid 归并: 一条 `sessionId` 为空的轮夹在中间时, 同一个会话会被劈成两行 (下拉里重复出现), 而 `spanOf` 只取第一段 —— 选它只看到被隔开前的那一小段 (2026-11-13 现场: 19 秒), 后面的历史像丢了。现在同一 sid 一行、时间窗可以有多段 (`SessionSpan.runs`, 只服务端用), "选这个 session" 看到的是它的全部区间。
- 交接之后的对话不再从 rolepage 上消失: self 交接的交接简报那一轮只带了频道、没带出处 (`from` / `speaker`), 新会话第一轮因此被归到「系统 wezard」那一栏, 交接前的那场对话从交接点断更 (现场 2026-11-13 实测: 交接后 70 分钟的续写全在 `p:system:`, 人读的那栏停在交接前)。现在交接发起时把被切断那一轮的频道与出处一起落盘 (`handoff.Seal` ← `detail.lastChannelOf`), 注入时透传给新会话第一轮, 简报的信封也按真实发话人与频道写 —— reload 恢复时不会再把这一轮认成自说自话、或把群里的交接复述成私聊。
- 新起尚未开口的会话跨 daemon reload / 绑定重建后, 首条消息不再丢宪章: 宪章只在内存里 (下一个 pane 的首条注入带进去的那份 pending), 会话新起后闲着遇到 reload, 恢复出来的绑定就没有它了, wizard 从此无身份开工 —— 生产实测 117 次备用领用里 2 例如此 (中间各有 1 / 5 次 reload), 另 1 例是 /kill 后绑定被别的路径重建。现在挂宪章时同时落盘标记 (`MirrorRecord.charterOwed`), 注入确认后清掉; 绑定建立 (`attach`, 覆盖 newSession / restore / pinned / clone / 外部认领) 时按「落盘标记 + transcript 里有没有带宪章块的 user 行」重新武装 —— 已送达的按转录硬证据不再补发, 2.9.0 之前在 system prompt 里的老会话不受影响, codex 仍走 developer_instructions。

### Changed
- **strict 群出站门放宽: 入群即发言权 (人 2026-11-18 拍板, 行为变更)**: 成员 (owner/speaker/mention 任一在场方式, mode 只记录入群方式) 在 strict 群里用 chat_say / chat_reply / notify / send_file 发言**不再需要挂某条义务的回包**, 同一条人话下也不限一条出站 —— 派活 ack、进展、结论都合法; 起因是 daily 群管家用 chat_reply 消耗了义务去发派活 ack, 两个 wizard 的结论回来后三次出站 (chat_say / notify / chat_reply 挂旧 msg) 全被旧门拒掉, 两笔 done 的结论至今没进群。**义务仍在, 但只用于提醒与销账**: 出站不再销账 (chat_say / notify / send_file 的 handler 不碰路由账), 销账只走 chat_reply 的显式答复 (带 text = done, 不带 = passed; 已结或欠在别人手上的义务照样能回, 只发言不销账) —— 「这件事真的有了交代」= chat_reply 交付, 发一条 ack 不算完; obligation-watch (未答提醒) 与「答了未交付」补发追问 (26be339) 口径对齐 (追问说的是「未用 chat_reply 交付」, 不再误指「没发言」)。**保留的边界**: 非成员 403、每轮 ≤3 / 每群每分钟 ≤10 额度、topOnly 仍拦同伴轮 (chat_reply 放宽后补上同一道 topOnly 门, 否则下层轮能借它绕过顶层模式)。chat_say 的 re 参数与 send_file 的 delivery 豁免随义务前置一起退役; 宪章 strict 节、chatPolicy.speech 注释、chat_* 工具描述、chatlog 提醒话术同步。tests/strict-chat.test.ts 判定矩阵与 handler 切片断言改写 (新增: 三种 mode 不挂义务放行、同义务连发 ack+结论+进展、出站不碰账/只有 chat_reply 销账、chat_reply 走 topOnly 门)。
- **管家身份按 `<role, workspace>` 唯一确定 (人 2026-11-17 拍板, 取代 11-16「拍板 A: 跨群共用管家只能按名字绑」)**: 新群引导回复目录时先反查本 bot 已有的管家身份 (`stewardsAt`: 锚点显式 workspace > 没写 workspace 的、活会话 cwd 落在该目录的全局管家 > 其余同类管家), 唯一命中就绑它 (该群一条隔离化身, 不再造新名字), 多个命中反问列名字, 没有命中才新建; `set_workspace` 对管家身份查重 (目录已有别的管家回 409) 并把身份 workspace 写到锚点, 该身份此后在任何群的新化身都从这里起; 已绑定的群里点名本群管家落本群化身 (没有就新开), 不再回落到锚点会话、与别的群共享上下文; 职责 / 专长 / self 记忆 / 角色升为身份级字段 —— `wizard_identity` / `wizard_remember` 写一处同步全部化身, 新化身从锚点继承, 开机 `reconcileKin` 幂等收敛存量化身 (只补空职责, 记忆取并集, 超过上限的组跳过不截断)。存量同一目录上的多个管家不自动合并 (待人点头)
- **身份记忆只与 workspace 绑定、按群隔离会话只属于管家 (人 2026-11-17)**: 宪章注入的工作区记忆、`wizard_remember({scope:"workspace"})` 的落盘键、记忆整理者的参考源与「记忆已更新」提示, 一律按**身份的工作区** (锚点 `workspace`) 取键, 没写才退回会话所在目录 —— 同一身份在哪个群、哪个 pane 起, 读写的都是同一份 (此前按会话 running cwd, 管家化身起在别处会读到另一份)。worker 跨群点名沿用它唯一那条会话 (不每群新开 pane), 只有管家接待会给身份在新群开隔离化身; 边界写进 `manifestationOf` / `resolveName` / inbound `resolve` 注释并由 `tests/steward-reception.test.ts` 钉住。
- **聊天命名整体下线 (人 2026-11-16 拍板: 「聊天不需要名字, 用 id 就行」)**: `/name` 不再给聊天起名, `name_chat` MCP 工具与 daemon 的 `/chats/name` 路由删除, 按工作区自动补名 (`planChatNames` / `applyChatNames`) 与聊天名墓碑机制整体退役, 微信 `/wx bind` 也不再起群名 (绑定卡显示 chat id)。**存量已命名聊天保留为纯显示标签**: `chats{}` 表冻结只读 (rolepage / 名册 / 信封照读, 让旧往来仍可辨认), `chatBaseOf` 仍能把存量名解析回 principal (兼容旧参数), 但不再增长、不再改写; 新聊天一律用 principal 标识。「聊天名 = 默认 wizard 名」的耦合退役: `/new` 不再把默认会话改回聊天名 (`reclaimChatName` 删除), 未命名的默认会话留给 `/name` 与新群引导去起。**BREAKING**: `/name` 语义见下条; `chats{}` 里的键留在 config.jsonc 不动, 手动清理不受影响。
- **`/name` 只给管家命名 (身份级)**: `/name <名字>` 给本群**绑定的管家** (`chatPolicy.<chat>.steward` 解析到的身份) 起名/改名, `store.rename` 一处改、同身份全部化身同步 —— 同一管家进多个群共用一个名字 (拍板: 名字是 workspace 级、会话按群隔离)。未绑定管家 → 明确提示先走引导; 管家已有名字 → 不直接覆盖, 回「已有 X, 确认改 Y?」并由 `/name <新名字> ok` (5 分钟内) 二次确认才落; `/name` 裸读显示管家与工作区; `/name -` 下线 (回聊天命名已下线的说明)。改名过宪章守卫, 受影响 wizard 自动挂交接提醒。 新群引导自动领的中性名视同未命名 (只认本群自己的锚点身份), 第一次 `/name` 直接生效; 改名同时改写所有指向旧名的 `chatPolicy.<chat>.steward` 绑定 (存的是名字, 不改就悬空, 旧名日后被别的身份领走会劫走裸消息)。
- 非 default wizard 的气泡署名不再包反引号 (2026-11-16 人口径): `chatHead` / `withMessageFooter` 原来只给群默认 wizard 裸名, 其余名字包一层反引号 (企微把它渲染成代码样式, 与名字链接打架)。现在署名一律裸 `🧙‍♂️ name：` / `[🧙‍♂️ name](url)：`, default / 非 default 同形; 反引号形态在**读入侧**照认 (存量气泡 / 引用)。只服务这条区分的东西一并删除: `isHost`, `chatHead` / `ownHead` / `withLinkedTagHeader` / `withTagHeader` / `briefLine` / `formatFinal` 的 `dest`·`channel` 参数, footer policy 的 `defaultTarget`。
- handoff(self) 默认不再等收尾窗口 (2026-11-13 人拍板: 「set_workspace 之后 handoff 预期就是立刻完成」): `selfWait.graceMs` 默认 45s → 0, 调用即受理、立即 Esc 打断在飞这一轮直接交接 (要短窗自然收口的部署仍可配 `graceMs > 0`); Esc 后只等 pane 真正静置 —— `selfWait.settleMs` 默认 60s → 10s (探测 2.5s × 连续 2 次的最小证明量), 量不出来不硬切、维持既有排队兜底。欠账 / 终句 / 闸内注入跨交接有效的机制不变 (欠账路由表兜着、终句 cut/uncut 扣着)。set_workspace 排队交接的受理文案同步改为「立即打断当前轮」。
- **wezard MCP 默认改走 daemon 内置的 `POST /mcp` (http 传输)**: `daemon.mcpTransport` 缺省从 `stdio` 改为 `http`, 新 spawn 的 pane 不再各起一个 `node dist/mcp/server.js` 子进程 —— 本机实测 42 个 pane 的 42 个 MCP 子进程合计约 1.0GB RSS, 改后为 0 个; 单次工具调用延迟与 stdio 持平 (实测 8ms)。按后端回落: 只有认 `--mcp-config` 里 `type:"http"` 的 claude / claude-internal / codebuddy 走 http (本机 2.1.84 / 2.1.154 / 2.181 实测均连得上, 且都把 headers 里的 `${TMUX_PANE}` 按进程环境展开, 身份照旧由 `x-wezard-pane` 认); codex (走 `-c` 覆盖) 与任何名单外后端自动回落 stdio, 显式 `mcpTransport:"stdio"` 一律回落 stdio。另两条回落: 读不到 `~/.wezard/daemon-token` 或写不出 `session-mcp-http.json` 时本次 spawn 用 stdio 并告警; 该文件里有口令原文, 现在写完固定 `chmod 600`。**已在跑的 pane 不受影响** (启动行改不了, 仍是 stdio 子进程), `/new` 或 respawn 之后才切换。

### Fixed
- **room 账本目录统一为配置 stateDir 派生 + cutover 第 8 步加 O2 账实闸 (2026-11-19 真实切换在 O2 上失败并整体回退后的三处修复)**: ① 账本目录只有一个推导 —— shared/room.ts 的 `roomsDirOf(stateDir)` (<stateDir>/rooms), daemon 读取、迁移写入、observe.mjs 重放全部从它取; 迁移脚本不再自己拼 `<home>/rooms` (事故根因: 迁移写 `~/.wezard/rooms` 而 daemon 读 `~/.wezard/state/rooms`, 新 daemon 起来账本为空 —— 内存未结 duty 1 / 账本重放 17), `MigrateOutcome.roomsDir` 报出实际写入目录, tests/room-ledger-dir.test.ts 钉住「迁移写入目录 == daemon 读取目录」与三个入口不再硬编码; observe.mjs 的 duties 缺省目录同样从配置推导 (--rooms 显式指定时不碰配置)。② run-cutover.sh 第 8 步加 O2 闸 (scripts/room-cutover/o2-gate.sh): daemon 起来后立刻比较 /status.openDuties (内存) 与迁移写入目录的账本重放数, 不等 → 自动逆序回退并报出两个数 (两次取数间恰有新 duty 落账的假红隔 3s 重取一遍消掉)。③ 演练改用真 daemon (scripts/room-cutover/rehearse-o2.sh): 临时 HOME + 临时端口 + 假 bot 凭据 + 隔离 tmux, 真跑第 6-8 步 (迁移 → 起 daemon → 读账本), 验证「目录对」O2 闸绿 (内存 duty 2 == 重放 2)、「目录错」(账本被挪到 daemon 不读的目录) O2 闸红 (内存 0 != 重放 2) 且闸红后按 rollback() 逆序动作回退链 8/6/2 全执行, 全程不碰真实 ~/.wezard; 实测日志 docs/room/rehearse-o2-20261119.txt。
## [2.9.0] - 2026-11-13

### Added
- 频道历史: daemon 为每个频道存一份本地缓存 (`stateDir/channels/<topic>.jsonl`, 按 post/reply id 覆盖去重, `keepDays` / `maxMessages` 有界), 第一次见到频道时用 `aibot_topic_get_post_list` 回填最近若干条 (`backfillOnBoot`), 补 reload / 断线空窗期丢的事件 (2026-11-09 实测重启到重新认证 15s 内的频道消息服务端不补发)。判官的「最近消息」与主 wizard 的上下文都先读本地, 本地不够才打接口。主 wizard 现在拿到的是预算版上下文: **当前线程 > 最近 N 条 > (消息里有指代 / 错误码 / 路径时才) 搜索命中**, 默认 6k 字符 (`wrc.channel.history`), 不再只有触发的那一条文本。新增 MCP `read_channel` + `POST /channel/read`: 按频道翻历史或搜关键词 —— 先本地 grep, 不够再走官方 `aibot_topic_search` 两步搜索并按 post_id 取回正文。频道注入的每条消息头部带 `topic=<id>`, wizard 可据此自己再查。

### Changed
- 审批 hook 与 wezard MCP 全部改为**按会话注入**, 机器上不再有任何全机注册: spawn 的启动行带 `--settings …/state/session-hooks.json` (claude / codebuddy) 或 `--plugin-dir …/state/session-hook-plugin` (claude-internal 1.x), 以及 `--mcp-config …/state/session-mcp.json` (三个后端都认, 配了 `daemon.mcpTransport:"http"` 时 codebuddy 改用 `session-mcp-http.json`)。企微文档 skill 同样按会话注入: `<stateDir>/skills/*` 经插件壳 `--plugin-dir <stateDir>/session-skill-plugin` 挂进 pane, 全机 skills 目录一个字节不写 (codex 无此参数, 不注入)。`.claude-plugin/plugin.json` 不再声明 `mcpServers`, 仓库里的 `hooks/hooks.json` 删除。人自己开的 CLI 会话因此 `/mcp` 里看不到 wezard, 也不再多起一个 `node dist/mcp/server.js` (本机实测 node 启动 + initialize + tools/list ≈ 89ms)。`wezard sync` 从「写 hook / MCP / env」变成「只清老版本写下的全机注册」(幂等; `--remove` 之后机器上不留 wezard 的 mcpServers 条目或空的 `env` / `mcpServers` 壳)。**升级后已在跑的 pane 要 respawn** 才会带上这几项参数 —— 老 pane 的启动行改不了。
- 危险名单再移出两类 (人 2026-11-03「命中 git 丢弃/rm 不再判定 danger」): `rm` (含包装器 `timeout` / `nice` / `env` / `command` / `\rm`、ssh 远程、`xargs` 传参形态) 与 git 丢弃 (`reset --hard` / `clean` / `checkout --` / `restore`, 整树与路径级同一口径) 都不再立 danger, 走普通审批卡 (danger 档下即自动放行)。原先按临时区 / 路径词法给 rm 分档的整套结构 (`tokenize` / `normPath` / 临时区清单 / `rmOutsideTargets` / `GIT_WILDTREE`) 随判据一并删除, 不留半死代码; `批量删除 find -delete` 是独立的 find 扫树删除规则, 不属这两类, 保持原样。提权 (`sudo rm`) 仍按「提权 sudo」命中。
- 频道判官改为 `-p` 无交互一次性调用, 不再是住下来的 judge 会话: 一个进程进、stdout 出一行 JSON (`--tools ""` + `--no-session-persistence`, 不落 projects/ 不被当成可镜像会话, 也不出审批卡), 进程崩了 / 超时 / 输出解析不了都按「不回应」处理并留一行可查日志。判词从 `{respond, reason}` 扩到 `{respond, reason, intent, rewrite}`: 放行时顺带给一句话意图与给主 agent 的改写指令 (改写缺失 / 为空 / 与原文相同 → 退回原帖, 原文永远可回溯); 判官 prompt 与主 agent 上下文首行都带 topic / post / reply / msgid 定位, 回复可指回原始消息。`channel.judge.tier` 默认从 `light` 改为 `mini` (一次性 JSON 判定, 最简档足够)。
- handoff self 改为「调用即受理」(人 2026-10-28: 「像正常调一个 MCP tool 就完了，daemon 自己去控制那个 pane 完成移交」): 简报合理就立刻返回 scheduled —— 不因 pane 忙、存在未落定事件或有旧失败记录而 409。daemon 自己排期: pane 忙就排队等这一轮收口 (无「超时即失败」, 6h 上限只把日志升到 warn、记录仍是「仍在队列」), 已有一场正在执行 (restarting/清空阶段) 就把新请求排队到它之后再自动执行一次 (返回 `queuedBehind: true`), 等待中的 self 被再次调用时新简报就地接替。残余失败记录不再参与 self 准入 (30 分钟窗口与「值守会话仍是当前绑定就拒」只保留给交接别人 —— 那是同步调用, 记录挡的是对半清会话的二次清空与对已坏路径的即刻重试)。不变量保留: 不在轮中间清空 (daemon 内部等, 不让调用方等)、失败保留旧 pane/旧会话现场 (preservePrevious)、简报首句 / charter / 欠账续答照旧、无端点核验的旧版 CLI 入口仍明确拒绝。可观测性: `GET /handoff/status` 列出每场交接的阶段 / 排队深度 / 在等什么 (排队 ≠ 欠账), 日志同口径 (`仍在队列` / `排队请求开工` / `就地接替`)。

### Fixed
- daemon 重启不再重放已判「等满仍没收口」的 quiet relay: `quiet-relays.json` 里带 `reason` 的、或窗口 (`TASK_QUIET_WAIT_MS`) 早已过去的记录只留作对账、不再重放 —— 2026-10-13 一次 live receipt-regress 在 sink 聊天里留下的 350 条死记录, 让每次 boot 都重烧 350 轮等待、重刷 350 行同一条 warn。
- handoff self 不再排队等在飞这一轮 (人 2026-11-12: 「减少等待时间…没有必要就不要等待，直接 handoff」): 先给这一轮一个短收尾窗口 (默认 45s, `selfWait.graceMs`), 到点仍忙就 Esc 打断直接交接; Esc 后只等 pane 静置 (默认 60s, `selfWait.settleMs`), Esc 打不断才退回旧的排队语义。打断不丢账 —— 欠着的每笔回执由路由表兜着在新会话逐笔续答 (resumeOwed), 切断那一轮的终句由 cut/uncut 扣着, 交接闸内的注入照常投递: 机制上回执本就跨交接有效。等待中新简报仍就地接替, 排队 (queuedBehind) 语义不变; 收口窗口的 idle 探测去掉 20s ramp, 本来就闲的 pane 不再白等。
- tmux server 卡住 (10s 超时) 不再直接打死 `/new` 与注入: spawn 启动行的 send-keys 超时改为换一个全新 pane 重试 (至多 2 次, 退避 0.5s/1s; 原 pane 可能迟到收到启动行, 弃给孤儿清扫, 绝不向它重发) —— 2026-11-12 实测 `wezard /new failed: tmux send-keys failed: tmux timeout after 10000ms: send-keys -t %1785` 一次 wedged server 同时打死 /new 和一批注入。注入的 Enter 超时同样不再立刻判「暂时无法确认…不会自动重发」: 先等迟到提交证据 (15s), 没证据则按「框里仍是同一段文本」的既有防重复约束补回车, 与未证实提交同路; 其他 send-keys 失败 (pane 没了) 维持立即返回。
- danger 档下 picker 哨兵不再发「无法完整识别」普通卡: 屏面解不出结构 (`complete=false`: 裸 `Bash command` 正文 / 被 pane 宽度截断的 params) 的原生权限框, 此前危险名单未命中时一律转普通单次卡 (审核行「无法完整识别此次操作，请逐次确认」) —— 该分支从未调 `dangerEarlyExit`, 绕过了 danger 档「非 danger 自动放行」的早退 (真机 2026-10-28: `.WendyVance` pane 的 `rm -rf /tmp/evaltest2 && mkdir …` 目标全在临时区, 名单不立 danger, 却发了普通卡)。现在与 hook 路径同口径: 名单在**可见正文**上未命中 → danger 档放行代按 （回执默认只留日志, 见下条; 该调用随后若仍触发 hook, hook 侧 `danger_mode_skip` 自带 ⏱ 窗口记账); 可见正文判出危险照发红卡; `all` 档行为不变照发卡。已知代价 (与「认不出不判 danger」同源, 人拍板接受): 被 pane 截断的不可见尾部判不到。
- PTC (REPL) 模式下的提问也发投票卡: codebuddy 把 `AskUserQuestion` 包在 REPL 脚本里时顶层工具名是 `REPL`, mirror 只认顶层就整张卡漏掉, 本地面板成了唯一出口 (人被迫回终端作答)。现在从脚本里读出 `AskUserQuestion({questions:…})` 的字面量入参 (不求值; questions 是变量 / 模板插值 / spread / 简写属性 → 读不出, 按原样不发卡) 驱动同一套投票卡 + 按键提交面板。提问那次调用的 result 落盘 (本地先答) 会作废挂着的卡, 按 callId 只认提问那一次 —— 脚本里排在提问之前的工具结果不会误杀。
- 原生权限框代按成功的 🔓 回执不再默认下发到聊天 (人 2026-10-28「只有人需要知道的时候才下发消息」): danger 档 (`danger_mode_skip` = 危险名单没命中) / `skip_all` / ⏱自动窗口 / `allow_rule` 代按一个**本来就判为非危险**的确认, 是这套设置的默认姿态 —— 逐条贴出来只是刷屏, 且这条消息按定义永远不会报告危险 (真命中危险名单走 manual 发红卡, 到不了代按)。现在只留 daemon 日志 (`picker sentinel: native permission picker auto-allowed` 现带 `toolName` 与未看全时的命令首行, 事后可 grep); 那次工具调用本身仍在 transcript 里, rolepage 详情照旧能翻到, 丢掉的只是「按键这一下」的副本。`complete=false` (屏面解不出完整入参) 的代按同理只留日志 —— 这条「留给人的残余风险」在实践中等于每次: CodeBuddy 原生权限框正文只有一段命令, 解不出 `toolName`/`params`, `complete` 恒 false, 于是「只在没看全时下发」退化成「每按一次贴一条」(真机 2026-10-28 仍在刷 `.OliveMiller` 的 `danger_mode_skip` 回执)。现在下发只能由人显式开 `approval.pressNotices`: `"off"` (默认) = 只留日志; `"unseen"` = 只报没看全入参的 (原行为, 措辞「入参未看全，只按可见正文判档」, `skip_all` 盲按不算漏看); `"all"` = 每次成功代按都报。拒绝 (🚫)、代按失败、认不出调用 (🔒) 三条不受开关影响, 照发 —— 它们要人动手。
- 审批卡「📄 展开完整命令」回到**卡片所在的聊天**, 不再一律落 defaultChat (默认单聊)。回送目标改为卡片自己的会话身份逐级回收: 待决 → pending 的 chatKey; 已决 (✅/❌ 点过, pending 已删) → `resolvePending` 现在统一留 5min resolved 快照 (此前只有 sweep / askq 路径 stash, 正常点完 ✅ 再展开就断了目标); 更晚 (含 daemon 重启后) → detail 记录随卡落 24h 的 `chatKey` (`ApprovalDetailRecord` 新字段, `recordApproval` 落卡时写入)。`#slot` 子会话展开回落该 key 的 base chat, 跨群接管的卡按 `cardChannel` 频道换算; 全 miss 的真鬼卡才兑该机器人的默认聊天。过期提示那条消息同链路同修。
- rolepage 里 REPL 调用的摘要行先读 `description` 再截 `code` (两段分摊预算), 不再只剩一截代码; inbound 落到没有任何会话的聊天、`/reveal` 找不到绑定 pane 时各留一行原始帧 / 绑定状态日志, 「认不出」可查。

### Changed
- 危险名单移出「递归改权限」(人 2026-10-28: 「不再判定danger：'危险 命中「递归改权限」'」): `chmod -R` / `chown -R` 只动权限位, 文件内容一个字节没变, 重新 chmod 回去即复原, 按「丢了能不能恢复」这条口径不够 danger —— 走普通档 (danger 模式下即自动放行)。原规则把 777 写在同一分支 (`(-R|\b777\b)`), 随之一并拆出独立一条 **「全局可写 chmod 777」**: `chmod`/`chown` 后跟 777 仍必发红卡 (含 `chmod -R 777`) —— 全局可写是「别人能改我的文件」的洞, 被改过的内容不留底, 与递归改权限不是一件事。
- **BREAKING** `approval.danger.enabled` / `danger.skip` / `danger.skipAll` 三个布尔删除, 审批粒度收敛为单一 `approval.mode` 枚举: `all` (每个命中 matcher 的调用都发卡) / `danger` (默认, 只危险名单命中发卡, 其余自动放行按 ⏱ 窗口记账) / `skip_all` (一律放行不发权限卡; `denyRules` 仍拒, AskUserQuestion/ExitPlanMode 交互卡与原生权限代按照常, 承自旧 skipAll)。**旧配置迁移** (仅当未显式写 `mode` 时; 老 key 留在盘上不报错、不写回, zod 忽略未知键): `danger.skip`/`danger.skipAll` =true 或 `danger.enabled`=false → `mode:"skip_all"`, 迁移说明打在 daemon 日志 (stderr) **并挂在 config_get 的根 / `approval` / `approval.mode` 层** (「迁移: …已映射为 mode:"skip_all"」一行, 老 key 从盘上清掉后自灭); 其余落默认 `danger`。显式 `mode` 优先于一切老 key。原「`enabled=false` 回退 all」的隐含规则随 key 一起删除 (该规则本就只存在于注释, 代码从未实现)。顶层 `approval.enabled` (总开关) 语义不同而保留: 它是整个审批子系统下线 (hook 一律回 `ask` 交回本地 CLI 权限流、picker 哨兵停、sync 不写 hook), 而 `skip_all` 是主动放行 (`allow`)。
- rm 一次性目录判据二次放宽 (人 2026-10-28「tmp 判断放更开」): 路径里**任一段**以 `tmp` 开头 (不限末段、不要求 `tmp-`/`tmp_` 分隔符) 即整条按临时区放行 —— `~/tmp-x/build` 嵌套、`~/develop/tmpdata`、`/var/tmp/x` 都放 (宁可误放叫 tmpxxx 的真实目录, 不拦自己建的一次性目录)。仍判: 无 tmp 段的真工作区 (`~/develop`、`/Users/zyy/develop`)、混合目标、词法 `..` 逃逸出 tmp 段 (`~/tmp/../develop`, 归一后 tmp 段已消解); 相对路径/变量/裸 glob 照旧解析不出不判。
- **普通卡不再发: `approval.mode` 默认改为 `danger` (人 2026-10-28 拍板「用户只需要管理 danger」)。** 非 danger 的调用一律自动放行 —— hook 路径的自动放行按 ⏱ 窗口记账/续期 (`windowMinutes`, 默认 600 分钟 = 10h): 每次放行对会话所在 chat 续开一次窗口并回 `auto_window:<remain>s (danger-only)`, 窗口只做记账不参与门控; picker 哨兵对非 danger 原生框直接代按。不变: danger 仍是唯一发卡来源; `denyRules`/`askRules` 仍优先 (显式「必卡」的照卡); wezard 自家 MCP 工具免卡; 白名单命中仍免审。要逐条审显式设回 `all`。注意: `danger.enabled=false` 时 mode 仍自动退回 `all` (防隐蔽全放行) —— 关掉名单再 reload 会变全量发卡。
- rm 临时区放宽「末段一次性目录名」: 目标路径**末段**叫 `tmp`、或以 `tmp-` / `tmp_` 开头 → 按临时区放行 (`~/tmp-modeck-test`、`/Users/zyy/tmp_build` 这类自建 scratch, 人 2026-10-28 原话样例 `rm -rf /Users/zyy/tmp-modeck-test && echo cleaned` 不再判 danger)。分隔符必需: `tmpdata`、`tmptest` 这类普通词不算, `~/develop`、`~/develop/tmpdata` 仍判。混合目标 (tmp-* + 真工作区) 仍判; `..` 逃逸、变量、裸 glob 照旧不判 (已改口径)。
- wezard 自家 MCP server 默认免审批: `approval.allowRules` 默认值加入 `mcp__wezard` (server 级), 且判定层 (`shared/allow-rules.ts`) 对 wezard server 的调用**内置短路** —— Claude 式 `mcp__wezard__*` 与 CodeBuddy 式 `mcp_wezard.*` 直连、以及 REPL `code` 里的内层 `mcp_wezard.x` 调用一律放行, 不依赖规则存在 (用户重写 `allowRules` 整份覆盖默认后依然生效); 「总是」不再为 wezard 内层生成规则; 空规则配置下纯 wezard REPL 也放行。只豁免 wezard 这一个 server (`mcp__wezard2__x` / `mcp_wezard_extra.y` 等撞名前缀不沾光, 其它 `mcp__x__*` 照走规则); deny / ask / 危险名单 / 自改配置守卫仍压过该豁免。
- **danger 判据原则修订 (人 2026-10-28 拍板): 无法完整识别的操作不判 danger, danger 必须有看得见的理由。** 认不出 / 解析不完整 / 动态拼接 / eval / 未知工具参数 / 引号未闭合一律降回普通卡 (REPL 白名单侧的 `repl_opaque` 审核原因不变, 本来就是普通卡); 能明确解析出的危险 (整树丢弃、非临时区 rm、强推、数据卷删除…) 照拦, 判据只来自「看懂了的操作」:
  - rm 三档改判: 全临时区 → 放行 (不变); 有解析得出的非临时区目标 → danger, **理由带上目标路径** (卡片「危险」行显示 `命中「删除文件 rm → ~/y」`); 解析不出 (相对路径 / 变量 / 裸通配 / `..` 后不可知 / 引号未闭合) → **不判** (此前 fail-closed 判危险)。`..` 逃逸出临时区 (词法可得, 如 `/tmp/../etc`) 仍判。
  - REPL 兜底收窄到命令键: `code` 里只有紧前属性键为 `command`/`cmd`/`script`/`shell` 的字面量值才当命令 (键本身说明会被 shell 执行); 裸字面量 (变量赋值/拼接)、陌生键的值不再当命令 —— 认不准不立 danger (`DATA_KEYS` 数据键清单随之移除, 不再需要)。

## [2.8.8] - 2026-10-28

### Changed
- 危险名单 builtin 按「丢了能不能从 git 或别处恢复」逐条重审 (2026-10-28): 移出 —— rmdir (只能删空目录, 无数据可丢)、本地 `git branch -D` (提交仍在 reflog, 默认 90 天拿得回)、`docker rm`/`docker rmi` 与不带 -v 的 `docker compose down` (容器镜像是牲口, 重建即恢复)、`history -c` (只丢 shell 历史); 保留并收窄 —— `git push --delete` (动共享远端, 别人未必有副本)、`docker volume rm|prune`/`system prune`/`compose down -v|--volumes` (数据卷里的数据不在 git 也不在别处, 并补上原漏掉的 volume prune)、`defaults delete` (macOS 系统偏好, 删了拿不回)。`git rm`/`git mv`/`git stash drop` 本就不在名单 (索引/对象库里可恢复)。
- rm 临时区豁免: rm 的**所有**目标都落在一次性目录 → 不判危险, 走普通卡/白名单 —— `/tmp`、`/private/tmp` 严格以下, `$TMPDIR`/`${TMPDIR}` 字面前缀及其展开形态 `/var/folders/<a>/<b>/T` (每用户一份, 根本身也豁免)。混合目标 (临时区 + 工作区/家目录)、解析不出 (相对路径 / 变量 / 裸通配 / `..` 逃逸 / 引号未闭合) 一律 fail-closed 仍判危险; 删共享区根本身 (`rm -rf /tmp`) 仍判 (清掉的是全机用户的临时文件); `/var/tmp` (跨重启保留)、`~/.cache` (非 scratch 契约)、`/dev/shm` (全机共享) 不算临时区。判据是路径词法解析 (引号感知 token 化 + 归一), 不是子串: `/tmp-foo`、`~/develop/tmpdata` 不豁免。
- REPL (PTC) 危险判定分层, 不再「整段脚本当 shell 文本」: 注释 (行/块) 整段跳过, 注释里的引号不再吞掉后面的真代码; 字符串/模板字面量按紧前属性键分类 —— 命令键 (`command`/`cmd`/`script`/`shell`) 的值、裸字面量 (变量赋值/拼接/裸参数)、陌生键的值仍按命令兜底 (fail-closed: 动态拼接、`eval`、未知工具的参数解析不出确定性), 已知数据键 (`file_path`/`content`/`new_string`/`prompt` 等路径/文件正文/检索词/散文, 见 `shared/repl-script.ts` 的 `DATA_KEYS`) 的值不再判 —— Edit 写含 `rm -rf` 的文本、Read 文件名带 rm、Grep 检索词含 rm 不再误报; 直连 (非 REPL) 的 Edit/Write/Read 本就不进命令判定。屏面兜底 (`dangerOfScript`) 收到的是裸 shell 文本, 改为整段按 Bash 命令判 (引号位正则本就认得文本里的命令)。
- 危险名单的「git 丢弃改动」按危害面拆分: 路径级 discard (`git restore <path>` / `git checkout -- <path>`, 含 `--staged`) 降为普通审批卡 —— 它只动所列路径的未提交改动, 是共享工作树里日常的「撤销自己刚改的文件」, ⏱窗口 / ✅总是 / 会话缓存 / 批量合流恢复可用; 整树形态 (`git reset --hard` / `git clean` / 匿名整树 pathspec `.` `..` `:/` `*` 的 checkout -- / restore, 含 `-s <rev> .` 带参形态) 仍必发红卡单审 —— 一次抹掉全组人的未提交 WIP。裸 `git checkout --` / `git restore` (无 pathspec) 是 no-op/报错, 不算整树。
- REPL (CodeBuddy PTC) 的白名单下钻: `allowRules` / `denyRules` / `askRules` 现在按 REPL `code` 里的内层调用判定 —— 内层 Bash 命令逐段对 `Bash(...)` 规则、内层工具名对裸名规则 (REPL 的 `mcp_<server>.<tool>` 与规则侧 `mcp__<server>__<tool>` 互通)。内层全被覆盖的 REPL 调用不再整条发「REPL 未在白名单」卡; 未覆盖的按内层那条报原因 (未列的工具名 / 命令段与建议规则), 变量拼的命令与纯计算 → 新增 deny 原因 `repl_opaque` 仍发卡。裸 `"REPL"` 规则仍是显式整工具放行 (旧「总是」语义); 「总是」在 REPL 卡上改为按内层生成规则, 不再生成整工具放行的 `"REPL"`。`daemon/repl-script.ts` 移至 `shared/` (白名单侧与 danger 侧共用内层命令抽取)。
- 详情 (工具正文) 的入参与结果各分两份, 人读的在前、原文在后: 新增递归视图 `input` —— object 一层一行、数组下标当键、嵌套缩进, 字符串里的换行照换, 形如 JSON 的字符串先拆开再渲染 (REPL 壳的 `result` 字段因此能直接读), 解析失败按原文; 原先那份 JSON 退为 `input raw`。结果同口径: `output` / `output raw`, Read 的文件内容与 diff 仍只摊开一次。
- wizard 自动名改为三段、永不复用: ① 裸 first 名 `Alice`…`Yara` (25 个, 首字母 A→Y); ② 全名甲子式对角, first 与 last (26 个, 首字母 A→Z) 两个下标一起前进 —— `AliceAdams`、`BobBrown`、`CarolClark` …, 25 与 26 互质, 一轮 650 个走遍全部组合后回到起点; ③ 全名后缀轮次 index, 只在上一轮走完后 +1, 按 36 进制写 (`AliceAdams0` … `YaraZaneZ`, 第 37 轮起 `AliceAdams10`), 无限进位, 不再有「名字池耗尽」(`AutoNameExhausted` 移除)。反解: 轮内位置 k = i + 25·((i − j) mod 26) (i / j 为 first / last 首字母序)。游标只进不退: forget 掉的名字不回收, 新 wizard 的 `base#name` 槽位因此也不会落回旧 target; 采用前仍做冲突检测: 名字已在名册里 (大小写不敏感), 或它在本群落成的 `base#name` target 仍被路由表 (owner / receiver)、消息事件 (含墓碑期内)、定时任务 (target / createdBy / owner)、plan owner、名册记录或镜像绑定引用, 都跳过 (跳过即消耗) —— forget 只删名册与绑定, 旧 target 上的这些引用仍在, 只查名册等于没查。检查用出生时的一次内存快照, 不读盘。已存在的 wizard 不改名; `wizards.json.names.json` 升到 version 4, 旧 version 2/3 的游标作废、从头计数。
- 代按成功不再往群里补发消息: 原生权限 picker / 原生确认框 / 计划卡的结论已落在卡片终态按钮上 (「✅ 已通过」「本会话通过」「N 分钟会话内全过 · 点击取消」「❌ 已拒绝」), 跟帖的「🔓 已代按 …」只是噪音。代按失败、超时、需人回 CLI 接手的提示照发。

### Fixed
- 只 `console.log(回包)` 而不 `return` 的 REPL 调用 (壳里只有 `stdout`、没有 `result`) 现在也认得出回包, `delegate` / `tell_peer` 的提示行不再丢; 只认「整行就是一个 JSON」, Bash 自己带 `exitCode` 的返回不拆。

## [2.8.7] - 2026-10-27

### Added
- 回执新增 `PROGRESS:` 中间进展: 长任务的终句以 `PROGRESS:` 开头时按 `progress` 状态投给派活方, 任务行不落定、继续在飞; roster / peek / charter 同步认这个状态。
- daemon 内置 `POST /mcp` (StreamableHTTP, 无状态、需 `x-wezard-token`), 按请求头 `x-wezard-pane` / `x-wezard-session` 认调用方; 新配置 `daemon.mcpTransport` (`stdio` | `http`, 默认 `stdio`): 设为 `http` 后 `wezard sync` 让 CodeBuddy 直连 daemon 的 `/mcp`, 不再每个 pane 起一个 MCP 子进程 (写入口令的 mcp.json 权限收紧为 0600; 口令文件缺失时保留 stdio 并告警)。Claude / Codex 仍走 stdio, 产物不变。
- 新增 `/use cli|wecom`(聊天) 与 `wezard use cli|wecom`(shell): 把一次工具调用的裁决权在「企微审批卡」与「本地 CLI 原生权限框」之间切换。写 `~/.wezard/state/approval-mode` 一个文件, 不改 hook 注册, 对已在跑的会话立即生效; 无参显示当前状态。cli 模式下 hook 仍照常更新权限模式档案 (Shift+Tab / acceptEdits / plan / bypass 的原生切换不受影响), 切回 wecom 时子代理对齐父会话读的就是它。

### Changed
- hook 在 `use cli`、daemon 不可达或回包异常时改为不答复 (exit 0), 由本地 CLI 自己的权限流程接管 —— 原先 daemon 不可达会 auto-allow, 等于 pane 静默拿到任何权限而人以为审批还在。`wezard stop` / uninstall 摘掉服务后立即交还, 不再白等 60s 的重启续接预算。cli 模式下企微审批卡、AskUserQuestion 投票卡与原生 picker 代按一并停用。
- 审批卡身份位改为 `🧙 .name` (名册全局名), askq / plan / 确认框卡同口径; 去掉「上文」行。「危险」行只写危险名单真命中 (rm / DROP / 强推…), 「无法完整识别」与 askRules 命中改走「审核」行。
- rolepage 计划 DAG 改为自上而下分层布局, 卡片更紧凑, 显示任务执行者, 点击任务弹出详情浮层。

### Fixed
- 审批卡危险识别覆盖 REPL / PTC 包裹的调用: 下钻 `code` 参数里的 Bash 命令字面量 (变量拼接时按整段脚本兜底); 屏面解不出结构时把确认区原文当脚本再判一遍, 真危险命令不再只显示「无法完整识别」。
- rolepage 认出 codebuddy REPL 形态的 `tell_peer` / `delegate` 调用, 派活 hints 重新展示。
- 模型档位不再把 Claude 别名灌给 codebuddy: 它不认 `haiku` / `sonnet` / `opus`, `--model sonnet` 只会被原样回显 (首轮 400), 于是每次新建会话都白起一次进程再走 `/model` 选择器 —— 开列表、读整份目录、逐格移光标, 十几秒起步, 同键的空白备用也建成即废。`models.backends.codebuddy.tiers` 现在有自己的一套默认 (模型留空 = 用 CLI 自己的默认), 要点名就按本环境的真实 id 配; 空白备用只在 `--model` 当场被认下时才补 (走到选择器才落定的 spawn 不再补, 那条备用按原串建必然被开机自检丢掉)。
- 原生确认框的代按指纹回到「确认区」而不是整屏原文: 2.8.6 把指纹绑到整屏后, 框外的进度行 / spinner 每一拍都在变, 人点卡永远只收到「已记录同意，但代按失败（操作或参数已变更）」, 哨兵还会把同一只框反复发卡。现在解析完整时比工具名 + 参数, 否则比确认区原文 (逐字: 缩进、数字、空行、heredoc 正文差一个字节即算换了调用) + 选项文案; 分隔线、框外进度行、状态栏不参与。「换框绝不盲按」不变; 认不出调用内容的框不再发注定失败的卡, 只告知一次, 失败原因也区分「认不出这只框」与「框里的调用已变」。

## [2.8.6] - 2026-10-27

### Added
- 新增 owner 管理的 Teams DAG 计划及 rolepage 计划视图; 计划持久化、关联与空闲提醒由统一接口维护, 派活和任务推进由 owner 显式执行。

### Changed
- **BREAKING** 移除旧 jobs / workflow / graph 执行器、迁移入口及兼容配置; MCP 派活入口改为 `delegate`, 不再接受旧 `dispatch` / `send_peer` / `tag` 别名及旧编排字段。CLI 从 PATH 解析, 模型档位使用按后端配置, 不再读取旧全局 tier / bin 字段。
- MCP 回包与回执提示精简, 保留真实错误、候选与恢复信息; idle-nudge 区分执行中与等待答复的任务, 支持冷却后重新提醒。

### Fixed
- 统一 receiver 任务路由与持久化恢复; 同一接收者的未完任务合并时保留输入与权威信封, 已完成回执不再等待批次内其他任务。
- 收口按实际消费的输入与执行来源判定; 拒绝过早 RESULT 时投递纠正提示, 修复带前缀的定向 RESULT 及面向人的任务报告收口。
- 物理 paste 前再次检查 pane 忙闲, 避免排队后状态变化导致插入正在运行的输入框; 修复定时投递适配与相关回归。
- tmux session 精确寻址; Codex 启动抑制更新提示, 输入框识别兼容底部警告; `pwd` 只返回当前路径。
- 信封只使用当前 `envelope.msg` / `message-event` 身份, 已退役 `receipt-delivery` 不再补入 eventId 或获得 machine 标签。

### Security
- 原生审批指纹仅接受可识别的确认框和完整调用上下文, 并绑定原始 pane 文本; 数字、空白或 heredoc 正文变化不再产生相同指纹。未知框拒绝自动代按; 包括噪声在内的屏幕变化也会拒绝复用旧批准。

## [2.8.5] - 2026-10-22

### Fixed
- 原生 picker 代按原先按整屏文本逐字节比对: 框外实时进度行 (`running 3m ago`) 一变就判「操作已变更」而不代按, 人点通过只会静默失败并反复重推卡。现改为按调用本体比对 —— 解析完整时比工具名 + 参数, 不完整时比框内确认区正文; 计时行 / spinner / agent 输出 / 状态栏不参与指纹。认不出照旧不代按。

## [2.8.4] - 2026-10-22

### Fixed
- CodeBuddy PTC 后端把工具调用包进 REPL 程序时, 顶层群管家的配额判级认不出内层调用 —— 只见 REPL 包装行, 读代码与 `dispatch` 等编排调用也被计进 look 配额并在耗尽后被拒, 管家死锁。现在下钻 REPL 内层调用名判级: 读类命令与 `mcp_wezard` 编排调用免配额, 写文件与开子代理照旧拦。

## [2.8.3] - 2026-10-22

### Added
- `GET /status` 新增 `capabilities: string[]` (本版含 `dispatch.taskFile`) 与 `version` (正在跑的 daemon 的版本)。外部调用方以 `capabilities` 含 `dispatch.taskFile` 作为切换 taskFile 派活的判据 —— `~/.wezard/templates/` 目录存在与否不再有任何意义 (2.8.3 起新代码不读它, 存量目录会是假阳性)。

### Changed
- `taskFile` 的路径语义重定 (推翻 2.8.2 的模板根设计): 模板不再要求位于 `~/.wezard/templates/`, 也不再有 daemon 启动时的 mkdir 能力握手 —— `taskFile` 是**相对调用方工作区**的相对路径, 绝对路径与 `~` 开头一律 400 (不展开、不接受); 解析基点取调用方 session 的 cwd (拿不到时退 daemon 进程 cwd), realpath 之后必须仍在该工作区子树内 (`../` 与软链逃到工作区外被拒)。其余校验 (64KB / 普通文件 / UTF-8 / 参数严格相等 / 行首 `<` 转义 / 首字符 `/` / TOCTOU 同一 400) 不变; `templateRef.path` 相应变为相对调用方工作区的路径。

### Fixed
- `dispatch` 白板 spawn 分支 (以及点名/自动选中已有 wizard 的投递分支) 失败时不再用选人理由覆盖真实错误: 此前 `bearAs` 起 wizard 失败或 `tell` 投递失败, 回包的 `reason` 一律被改写成选人理由 (如「你要了新的」), 真实原因全丢。现在失败时 `reason` 是真实错误, 选人理由挪到 `why`; 成功时 `reason` 仍是选人理由, 不变。

## [2.8.2] - 2026-10-22

### Added
- `dispatch` / `tell_peer` 支持「模板文件 + 参数」派活: 新增 `taskFile` (`~/.wezard/templates/` 下, 支持子目录) 与 `params`, daemon 在入口展开成投递全文 —— 调用方的工具 input/output 不再逐字抄长协议正文。校验全在开行/起 wizard 之前: 根外路径 (含软链/`..` 越界)、非普通文件、>64KB、坏 UTF-8、缺/多参数、参数行首 `<` 转义 (防信封劫持)、展开后空或以 `/` 开头, 一律 400 并带人话 reason, 调用方可回退内联重发。`taskFile` 可单独成立 (`task` 不必陪跑); 给了 `taskFile` 时选人/选档/description 用 `clipLine(params.header ?? 展开全文, 120)` 派生。`payload.text` 存展开全文 (userQuery / read_chat / transcript 三方一致), `payload.peer` 带可选 `templateRef{path,sha}` 供审计。daemon 启动时 `mkdir -p ~/.wezard/templates` (0700) 作为能力握手 (失败静默 = 能力关闭)。`spawn_wizard` / `clone_wizard` 第一期不接 `taskFile`, 传了显式 400。
- 空白备用池: 每次全新冷 spawn 成功后在 `<prefix>-warm` 里后台冷启动一个同 (工作区, 后端, 模型, effort) 的空白 CLI 备用, 下次同键 spawn 直接领用 (校验 pane / CLI 进程 / 输入框 / 无模态后整窗搬进主 session), 领走即补。每键 ≤2、全局 ≤`wrc.sparePool.maxTotal` (默认 2, 跨键 LRU)、闲置 1h 回收、启动失败不重试; 未命中或校验失败照旧冷启动。每个备用常驻约 1.2GB (含 MCP 子进程)。`wrc.sparePool.enabled=false` 或 `WEZARD_SPARE_POOL=0` 关闭。

### Changed
- 宪章不再经 `--append-system-prompt` 进系统提示 (claude/codebuddy 冷启动省 ~1.4s), 改为 `<system-reminder wezard="charter">` 顶在该 pane 首条非斜杠注入的最前; `/new`、备用领用、死 pane 重生、`/clear` 与压缩后都会重挂, 分身开场白带子宪章取代继承的身份。read_chat / peek_peer / rolepage 剥离或折叠, 不进群聊气泡、不进问话行。codex 仍走 `developer_instructions`。
- 白板 spawn 提速: 在独立 tmux session `<prefix>-warm` 里按 cwd 预养空 shell (每 cwd 1 条、总量 ≤3、20 分钟换新), spawn 时整窗搬进主 session 再打启动行, 省掉新 pane 登录 shell 源 rc 的那一段 (实测 ~1s, 高负载下 ~2s); 认领前核 pane 活着、前台是 shell、目录一致, 否则退回原冷路径。`WEZARD_WARM_SHELL=0` 关闭。TUI 就绪读屏节奏 400ms → 150ms, 信任框应答复用本拍已读的屏。

### Fixed
- 回执信封不再把「这份结论要交代给谁」当成「这句话是在哪个群说的」：有去向（回给上游 wizard / 落回某个群）的回执不再发放 `QUIET` 许可，只允许用 `RESULT:` / `WAIT:` / `NEED:` 收口；没人等着听的回执（纯同伴链）保持原样。此前一份已经到了的答案可以被 `QUIET` 吞掉，而账本记的是「已送达」—— 发起方那边看不出任何回复（2026-10-22 .teammate 收到 .wezard 的结论后即如此）。
- 同一份结论不再被两个轮次各投一次：追述判重此前拿正文指纹去比一份「执行版本」号，恒不相等，于是 `re` 腿 / 被切断那轮补交的同文定论会再进一次收方收件箱（2026-10-22 edf7056.1：两份相同回执相隔 18s，第二份落进对方已经跑起来的输入框并把它的输入取消掉）。改按正文判重。
- CodeBuddy 后台完成通知 (`<task-notification>` 块后跟 `Use the TaskOutput` / `[SYSTEM NOTIFICATION]` 机器附言) 不再被误判为普通 user 开轮行：此前剥完元信息仍剩附言正文，无信封机器行被当成开轮，回执链断开 —— 人在群里那轮派出的活开成 detach 根行，回执轮终句进不了群。改为按形状认 (行首起即通知块)。

## [2.8.1] - 2026-10-21

### Added
- spawn 撞上认不出的启动确认框 (预写信任与目录信任代按都覆盖不到的启动期弹框) 时, 向该 spawn 的企微频道发一条通知: 哪个 wizard、哪个 tmux pane (含 `tmux attach` 指引)、工作目录与屏上原文摘要, 只告知不等点击; 同一 pane 同一形状只发一次, 发送失败只记日志, 不按任何键、不阻塞 ready 判定。

### Changed
- 管家手闸不再拦读代码：`Read` / `Grep` / `Glob` 及 `cat` / `grep` / `git show` 等只读命令对管家放行、不计次数预算；改文件与开子代理的拦截、每轮 look 命令预算保持不变。宪章、管家提示与配置描述同步改写。
- spawn 撞上 CodeBuddy 四选项目录信任选择器时不再只发通知等人：形状完整命中 (标题 + 唯一绝对路径 = 本次 spawn 的 cwd + 四个逐字对得上的选项行 + Enter 尾行) 就自动选第 1 项 `Trust folder only` 并确认 —— 与预写信任同一授权范围，只限本目录。高亮默认在第 1 项时单发 Enter，否则单发数字 `1` (实测两者皆一键即确认)，永远只发一个键；发送后必须看到框已消失且 CLI 未退，框还在即停手退回「只通知」路径 (附当前屏)，绝不补发。形状任一不符 —— 目录不是本次 cwd、选项文本对不上、屏上有其它数字选项或「另需授权」语义 —— 一律不碰键盘，照旧只通知。

### Fixed
- `approval.danger.skipAll` 真正压住 CLI 原生权限选择框：CodeBuddy 对一部分调用先弹自家权限 picker、hook 事后才触发或根本不触发，这条链路只有 mirror 的 picker 哨兵能代答 —— 但真实 CodeBuddy picker 的屏面 (标题 `Hook PreToolUse: … requires confirmation:` / 裸 `Bash command` 正文) 解不出 `Confirm` 头与 `toolName`/`params`，哨兵按「上下文不完整」一律转审批卡，skipAll 在哨兵上永远轮空，调用卡死在原生选择框 (devcloud 实测症状)。现在 skipAll 在不完整上下文分支直接放行 (与 hook 路径「盲放」同语义，不依赖入参匹配；仍只代按一次性裸 Yes，交互工具与原生沙箱请求照旧不碰)；「不完整且无 skipAll」「判成 modal 但无可信选项」两条路径补屏面 tail 诊断日志，远端布局变体排查不再需要守屏抓 capture。
- 信封渲染对 number 型属性值不再崩溃：`openTag` 渲染前统一 `String(v)`，此前 `renderPeerEnvelope` 塞进 `legs` / `deadline` 等 number 会让 `escAttr` 在 `.split` 上抛 TypeError，`reminder-shape` 回归组整组红。
- 自我交接不再把已答完的那一轮当欠账重问: 被交接切断那一轮的终句, 结论回群里的、或显式 `RESULT:` / `NEED:` 的照常落定投出 (回 wizard 的未标记收尾仍扣下, 防抢答误折); 仍需续答的「继续 <event>」带上问话人、原话与被扣下的收尾, 接手方不必再去 read_chat 猜。
- 聊天自动名不再复用: 凡在 `chats` 里出现过的名字都记墓碑 (`state/chat-names-retired.json`), 自动命名只取该前缀最大序号 +1 (`cc-wecom-10`、`-11` …), 人 rename 释放的旧名不回流给新聊天; 手动 `/name` 不受限。
- `read_chat` 与无参视图按信封 chat-key 匹配聊天身份, 仅对无 key 的旧信封按名回落, 名字只做显示; 复用的聊天自动名不再把一个聊天的历史串给另一个。
- `set_workspace` 交接真正落地并可恢复: 工作区切换在 handoff 时生效并核验交接进程身份, 未决交接的结果表述清晰, 切换中断后可恢复续接。

## [2.8.0] - 2026-10-19

### Added
- Codex hooks 清单审查支持逐项精确授信，并以投票卡呈现。
- 默认 coding 编排按任务范围选择 light 档，保持轻量 wizard 的模型预算。

### Changed
- 回执回归按正交方向拆分，便于离线定向验证。

### Fixed
- daemon 不可用时拒绝 Codex 原生权限请求，避免审批失效时放行。
- 回执投递失败后可恢复，并确保结果只领取一次。
- 恢复 wizard 时保留原 backend；重试投递设有上限。
- 复用空闲 wizard 前确认其材料与任务匹配。
- pane 恢复后补认延迟到达的输入确认。
- Codex hooks 信任审查消息保留完整清单与精确 hash 授权信息。
- rolepage 消息 footer 链接在闭合 Markdown code fence 后保持为独立链接。

## [2.7.7] - 2026-10-16

### Fixed
- `wait_peer` 区分回执投递与实际消费状态，不再把 dispatching 等未消费状态误报为 delivered；已领取回执不重复返回正文。

## [2.7.6] - 2026-10-16

### Fixed
- 恢复仅有闭合标记、无 final 正文的已消费回执时释放 pane 占用，避免后续回执长时间积压；未知结果保留待定，不伪造任务结论。

## [2.7.5] - 2026-10-16

### Fixed
- 回执按业务事实去重，重复终句与迟到回执不再重复公开刷屏；恢复投递保留稳定身份，并在公开输出前核验当前路由与收口权限。

## [2.7.4] - 2026-10-16

### Changed
- wizard 自动命名使用 31 个 Firstname 与 37 个 Lastname；首次单名用完后轮转 1147 个组合，走完一圈回收已释放名字，不再递增数字后缀。仍占用的名字跳过，名字池耗尽时明确失败；旧游标自动迁移。
- handoff 等原 CLI 空闲后在原 pane 执行原生 `/clear`，确认新 session/thread 身份后接回完整简报，保留 CLI 进程与 cwd；无法确认时保留现场并明确失败。

### Fixed
- handoff 清空前和简报提交前重新核验控制权限与 CLI 身份；交接状态、旧终句抑制及失败补偿持久化，跨 reload 继续处理欠账。
- 回收名字时校验退役结果和出生身份，避免旧停止请求清理复用后的新身份。
- 定时任务跨 daemon reload 恢复调度和执行状态。
- transfer 将原回复气泡及收口权随任务移交，持久化所有权并恢复中断后的投递。

## [2.7.3] - 2026-10-15

### Fixed
- transfer 人问的那一笔后气泡不随行移交 (T10 删掉旧 answerBubbles 交接后的回归): 交出方这一轮的终句 (「已移交 .x」) 照旧占住那句人话的流式气泡 —— `finalReleased` 对在飞的行不核 owner —— 接手方的终句只能另起一条 standalone。现在 `finalReleased` 在飞的行也只放 owner 的终句, 交出方这一轮的终句只留 rolepage (`setEventHandedAway`, 不走链式收口的「气泡先展示」); 气泡在 transfer 落地时从交出方摘下、按接手方注入事件寄存 (`handBubble`), 接手方开轮时接过去续写 CoT 与终句 (到期点仍从人那句话起算; 寄存只在内存, reload 或过期退回 standalone)。
- 注入事件表 (`state/message-events.json`) 从不 GC: 了结 (canceled / complete 且 finalized) 满 24h 的行在落盘时裁成墓碑 `{id, fingerprint, execution, endedAt}`, 墓碑满 7 天删除。墓碑只给 `accept` 判重 —— WS 重放 / 收件箱重入撞上它返回已了结, 不复活、不再注入; 自配 id 的调用方 (续问序号 `legsOf`、交接续答 `injectResume`、`wait_peer` 判投过没有) 改问含墓碑的 `ids` / `known` / `executionOf`, 不会撞号。
- 回执投给已不存在的收方 (被 stop 的分身) 空转到 12h 期限: `injectText` 恢复绑定失败且 store 里已无绑定时报 `gone`, 事件收成 canceled, 回执沿 receiver 边重走升级 (能收的上层 wizard / 群根 Dead Letter); 无处可升时 canceled 定论不再投 (收掉它的一方自己知道), 其余退到收方家群 (Dead Letter)。派活 / 续问不另做, 由 sweeper 的 dead 判定上浮。还有绑定只是 attach 失败的照旧退避重试。
- 自我交接失败时切断那一轮的终句丢失 (938122b 遗留): 被扣下的终句记在这场交接上 (`handoffs.json` 的 `cut`, reload 可续), 交接没做成 (重开 / 贴回简报失败) 时按原行补投 (`settleFinal`, 与轮终同一条 onFinal); 交接做成则由新会话「继续 <event>」续答, 不补投。

## [2.7.2] - 2026-10-15

### Added
- `GET /message-events/event?id=<event>`: 单条注入事件的 status 视图 (形状同 `/message-events/status` 的一行, 不认识 = 404)。receipt-regress 轮询单条事件改走它, 不再每 2s 拉一次全表。

### Changed
- **BREAKING** 顶层模式改为**默认开**: `chatPolicy.<chat>.topOnly` 不写即开, 只有显式 `false` 才关 (`daemon/chat-name.ts` 的 `chatPolicyOf`)。此前默认只覆盖 wezard 与微信 ClawBot 群聊, 其余群要人一个个点头才开 —— 漏掉的那个群里 wizard 之间照样当着人派活、干活那一方的回复也进群, 人看到的是「管家和干活的人各回一遍」(实测 pagesite 群: 管家的派活气泡 + 分身的完整 RESULT + 管家自己的结论, 三条)。连带两件事, 都在明面上: ① 顶层模式的开关同时管着**管家手闸** —— 聊天默认会话从此不能改文件 / 开子代理 / 读代码、自己跑命令每轮限 `stewardBudget` 次, 想某个群照旧自己动手就把它显式设 `false`; ② 已在跑的 wizard 宪章里还是旧话 (本群没开), 守进程侧的强制立刻生效、宪章文本要重开或交接后才换。

### Removed
- `wrc.mirror.topOnlyNudge` 配置与 `daemon/top-only-nudge.ts`: 顶层模式默认开之后「该开而没开的群」不存在了 —— 还会公开往来的群只剩人**显式**关掉的那些, 那是人自己的决定, 不该再被劝。「公开往来一多就提醒群管家问人要不要开」的发现器连同它的落盘账 (`~/.wezard/top-only-nudge.json`, 残留不再读) 一并删掉。

### Fixed
- daemon 主线程被 message-events 调度器同步卡住 (单线程 ~99% CPU, `/status` 偶发停顿 6-17s, 日志里成百的 `tmux command timed out` / `pane probe exceeded 5s` 多是停顿造成的假超时): 事件表上千行时 `pinOf` / `queue` 对每一行先问 `resourceOf` (三个适配器各读一次注册表目录、`sessionInfo` 还顺手读 transcript 尾巴算 contextTokens), 再判执行态 —— 九成多的终态行也付 I/O, 每条排队行又扫全表, 成了 O(R²)×I/O; `/message-events/status` 每条排队行还重复扫 3-4 遍。修法 (语义不变): 先判执行态再问资源 (A1); 一次 pump / status 内适配器按 target 只问一次 (A2); `sessionInfo.contextTokens` 改惰性、`inputSessionInfo` 读注册表走目录快照 (fs.watch 作废 + 1s TTL 兜底; 注入闸门的忙闲判断仍现读) (A3); status 每行只扫一次队、终句投递按 event 预分组 (A4)。
- 工单验收打回被同一轮的终句重放绕过: message-events 对每个终句递两次 `final` (`result()` 当场一次, 泵见 `complete` 未 `finalized` 再补判一次 —— 打回的续问 `events.accept` 里 `void pump()` 同步就触发), 第一次判不合规格打回、记进 `bounced`, 第二次因「已打回过一次」直接照收, 把被打回的原文 (如「好的」) 落成 done 并投出回执, 早于打回日志 ~0.4s。`bounced` 改记被打回那一轮的注入事件 id, 同一事件的重放直接丢掉, 只收续问那一轮的补交。
- `close_job` 吞掉已派出、还没注入的活 (常见于冷 pane 上排着的出生事件): 收工时 `events.cancel` 按「owner + job」把这张单名下排着的事件一并撤掉, 即便行仍 `open`; 漏网的也被 `valid` (要求单还开着) 与注入前重投影的 `jobs.account` (`accounting requires open job`) 永久扣住 —— 行一直挂到 deadline, 发起者收不到迟到回执。现在 accept 收工只撤行已落定 (cancel 级联 / held 撤销) 或没开行的事件; 单已收但行还 open 的照投 (`valid` 放行), `jobs.account` 先认已记过的 key 再查单开没开 —— 活照常答完, 回执标「已经收工」。
- receipt-regress `task-quiet` 判据过期 (脚本侧, daemon 行为正常): 9ef3d55 把定时任务投递收进 `scheduled-delivery` 后不再打「scheduled task: 目标正忙, 顺延」日志, quiet 转发也从 `notifyChat` 改走终句 outbox (不再有 `chat notify failed`), 脚本却还在等这两行。改读事实: 顺延 = rr-t transcript 里到点 (+60s) 时 busy-done 还没说完、任务那句排在其后且投进的就是 rr-t; 转发 = `/message-events/status` 的 outbox 里有一份 `quiet:<rr-t2>:*` 投向伪群, 且安静那轮没有。
- 自我交接时被切断那一轮的收尾终句被当成欠账的定论 (**未经 live 验证**): T10 后 `onFinal` 不再有旧 `replyClosedBefore` 的「交接那一轮不算收口」语义, 交接发起后、旧会话重开前那一轮的终句 (「已交接」或模型抢答) 直接把最后打开的那一笔落成 done, `resumeOwed` 查 open 行时已少一笔, 新会话只续答剩下的 (live 实测 rr-h-33e5: ed0b434 在重开前 6s 被收尾句落定, 「欠账续答」只出 1 行)。新增 `cuttingTurn` (自我交接从发起到 restarting 之间), 期间 `deliverFinal` 丢掉该 target 的终句, 行留 open 交给新会话的「继续 <event>」。receipt-regress `handoff-owe` 同步修前提: codebuddy 运行中吃进的话要等手上工具返回才落盘, 「已读入 / 未收口」改认注入事件 exposure=submitted, 两句串行注入的等待窗 60s→180s、前台闸寿命 240s→600s。

## [2.7.1] - 2026-10-15

### Fixed
- 2.7.0 发布存疑的重发: 2.7.0 的 PUT 被 npm 延迟数分钟才生效 (期间 `npm view` 一路 404, 曾误判为坏包), 落定后核实 tarball 完好、dist 齐全 (284 files)。2.7.1 与 2.7.0 内容相同, 仅版本号不同, 让 `latest` 指向发布即确认可见的版本。

## [2.7.0] - 2026-10-15

### Added
- 回执的金字塔路由 (receiver stack, `docs/evolve/receiver-stack.md` ①-③): `tell_peer` / `dispatch` / `spawn_wizard` / `clone_wizard` 新增 `return: self|transfer|detach|none` 与 `for: <件号>`。栈由 daemon 在派活那一刻物化并随件落盘 (`Slot` / `Hold` / `MessageEvent` / 挂起账 增 `stack`、`mode`, `k` 留作 `stack[0]` 的冗余; 老盘无 stack 的行按 `[k]` + 现拼兜底), 所有写入点收进 `resolveReturn`; 方向闸的 chain 改读冻结的栈, 槽被顶掉 / 过期不再截断 —— **有意的行为变化**: 同一对的新一句顶掉旧槽后, 链比改前长 (改前在查不到的那一格截断、宁可少拦), 防环与 ≥3 层链深会比改前多拦; 带 `for` 时防环取本轮推断帧与 `for` 帧两条链的并集, 链深只看实际挂的那一帧。已知余项: 被 adopt 那一帧的叶子槽本身被顶掉 / 过期后, 交出方会重新出现在接手方的链上 (多拦一层, 不漏拦)。`for` 可把子活挂到自己欠着的任一笔 (查不到 → 400 并列出欠着的几笔)。旧写法永久接受: `chain:false`→`detach`、`receipt:false`→`none`、`answer:"transfer"`→`transfer`, 新旧矛盾 → 400; `dispatch` 由此获得 `detach`。
- peer 帧尾调用 (`return:"transfer"` 用在 wizard 派来的那一帧): 上游那一份改由叶子作答 (`Slot.delegate`), 守它的不再读交出方的 transcript / pane; 叶子落定 (含 NEED / error / 失败) 直接作为上游那件的回执投出, 信封带 `via=.叶子`, 交出方不收不转; 连续 transfer 一跳直达; 期限继承上游较早者; 收掉交出方不殃及已交出的那一份, 收掉叶子才落它; 上游 `re` 那一件按 delegate 同件号转给叶子。transfer 与 job / re / node / after / fyi 及同帧下未落定的子活互斥, 一帧只能交一次; 交出方对那一帧再派活 / notify → 409; 上游 `re` 已交出的那件带 `kind:"fyi"` / `return:"none"` 只知会叶子不登记, 带 transfer / detach / for → 400, 照记上游工单预算; 上游 `wait_peer` 不取走已交出的那件; 上游收自己那件 (close_job cancel / 带件号 stop / 节点 stopped / plan 取消) 或收此刻的叶子都落到叶子上。旧写法 `answer:"transfer"` 同带 `receipt:false` / `kind:"fyi"` / `chain:false` 照旧拒 (400)。宪章与工具描述加「想自己接 NEED 就别 transfer」。

### Changed
- 工单成员落定 (`jobs.settle`) 改以 `member.turn === row.event` 为锚 (派活时 `tell.event` 写入的正是那一路由行的 event, 落定从 `deliverRoute` 进来带的也是它), `dispatchKey` 仅在调用方显式给出时才校验 —— 此前 account 给成员挂的 key (最新一腿的注入事件 id, re/续问会换) 被当主判据, 而 settle 侧从不带它, 先校必然拦下: 经 `tell_peer` 带工单派出去的成员 outcome 从此不落、done/total 计数错 (live 回归 Jc9a3e6 显示 4/5, 实际 5 腿全交付)。显式给 dispatchKey 的调用方照旧校。
- 派活默认档收敛为 **standard**: `tierFor` 不再按措辞里的「设计 / 排障 / 审查」自动升 hard (`COMPLEX_RE` 只留作小活判定的否决项), hard / ultra 只由调用方显式 `tier` 给, lead 仍天然是 hard —— 此前这类措辞在真活里太常见, 几乎每个派出去的活都落 opus。`dispatch` 工具描述与宪章管家守则同步改写「不写 tier 就是 standard, 确实要判断才显式 hard」。
- **daemon 出问题时 hook 自动放行**: `pre-tool-use.sh` 连不上 daemon / 重启后没回来 / 回包坏了时一律 `allow` (原先按 `WEZARD_HOOK_FALLBACK` 默认 `ask`, 弹出远端看不见的本地 picker 把无人值守的 wizard 卡死); hook 预算耗尽 (daemon 活着、卡没人点) 仍 `ask`。Codex hook 同步: PreToolUse 放行, PermissionRequest (沙箱提权) 仍退回原生确认框。`WEZARD_HOOK_FALLBACK` 退役, `wezard sync` 不再写入并清掉残留。daemon 活着但机器人连不上 (企微 WS 断开, 或卡因断线没发出去) 同样放行 (`ws_disconnected:auto_allow`), 不再按 `fallbackOnError` 回 `ask`, 危险名单 / askRules 也不例外; `.claude/**` 守卫仍 `ask` (放行了 CLI 照样弹原生框)。
- `set_workspace` 换工作区从「杀 pane 全新重开 (上下文丢弃)」改为**自动交接**: daemon 落 `setPendingCwd` 后走 handoff 机械 (请它写简报 → 原地重开落进新目录 → 简报贴回), 上下文带过去、新目录的宪章随之生效, 「📂 当前项目」气泡照发 (新增交接的 `announce` 标记); 路由一律立即回 `scheduled:true` (调用方常是被换的那个, 要先说完这一轮), 冷会话 (pane 不在) 仍按老路直接新开; 交接失败退回提醒 + pendingCwd 排队, 人手 /new 照样完成切换。
- 宪章守卫 (`guardCharter`) 对**热生效**的宪章改动 (如 `chatPolicy.<chat>.topOnly`、聊天名) 不再只给受影响且 pane 活着的 wizard 挂 handoff 提醒, 而是自动替它们交接 (`handoffs.other`, 各写简报后原地重开); 交接不成 (一直忙 / 已在交接中 / 重开失败) 才退回挂提醒。reload 项此刻重开渲染的还是旧宪章, 维持提醒不变。比对剔除「出生时同群的 wizard」一节: 它是出生快照且渲染途中的懒定居会让前后两次渲染无辜不同 —— 此前一次无关的 `chats` 写入会把同群活着的 wizard 全部误判为受影响。
- 交接简报贴回新会话后要看见它真的动起来 (转忙或新 transcript 有话) 才算数: 冷 pane 的首条注入可能被还没起好的 TUI 吞掉 (inject 只能信任提交, 日志 ok 而 pane 空白), 吞了 wizard 就空着醒来。看不见就重贴一次, 仍不行才算失败。
- 名册变动提醒 (reminder 名册) 不再带上超过 2 天没活动的冷绑定 (`activeRows` / `ROSTER_ACTIVE_MS`, full / delta 同一口径; 在忙或挂在审批上的、刚 spawn 还没写过的照留): 机器上冷绑定越攒越多, 名册一变就往每个 wizard 塞一张大半是死人的表。`wizard_roster` 的全表语义不变 —— 只滤这份推送。
- reminder 信封瘦身 (`shared/reminder.ts`): 派活 / 续问信封不再写 `event` / `quiet` / `act` / `deadline` 属性, 回执信封不再写 `serves` / `via` / `late` 与重复的 `receipt-delivery` reminder —— 机器不读回的语义 (沿链升级跳过了谁、结论迟到) 改写进信封正文, 「这一轮服务哪一笔」由注入事件反查 (`events.get(id).serves`)。属性出现之前落盘的老信封照认 (LEGACY 解析保留)。
- reminder 结构收敛 (`shared/reminder.ts`): 新增种类注册表 `REMINDER_KINDS` —— 每种块能写哪些属性按种类做类型约束, 每个属性标明是机器读回还是模型要抄进 `re` / `for` / `drop` 的 id, 未登记的属性渲染时丢掉; `renderTail` 把一次注入的尾巴按「信封 → hint → lead → after → mention → roster → pending」固定排序 (人话与同伴 / 定时两条注入路径统一走它)。注入事件 id 不再单挂一块 `message-event`, 投递时作为 `msg` 写进信封开标签 (`withMsg`; 没有信封的注入仍兜底挂老块), `event` 只指路由行 id; `parseEnvelope` / `submittedEventSince` (`carriesMsg`) / mirror 的认领新旧两形都认, LEGACY 表不动。名册 / 挂起事项的 `mode`、mention 的 `names`、hint 的 `role` 退役 (没有读者)。rolepage 的 reminder 标签按种类命名 (`<envelope · .x>` / `<回执 · .x · need>` / `<roster>` …, 老形状的 message-event 画淡)。receipt-regress 改用同一份 `parseReminders` / `parseEnvelope`, 新增 `reminder-shape` unit 用例与 `unit` 参数 (只跑纯 unit), fanout 的「子行挂在 p 下」改读路由表 (原判据读从未写过的 `serves` / `up`, 恒为 0)。
- 回执路由的「迟到补投」升级为**多次追述** (§4.3): 已落定 (`answered` / `handed`) 的行再收 owner 终句时走 `retellOps` —— 起初是 daemon 合成失败 (`settledAs` ∈ timeout / silent / dead) 的未标记定论也收、可收多次, 起初是 done 的只收显式 `RESULT:` (未标记的随口一句只进 rolepage); `canceled` 与同内容重放一律不收。追述沿 receiver 边一环一环原路再投 (新 rev), 行新增 `settledAt` (最近一次落定时刻) 与 `settledAs` (首次落定的结局, 只写一次)。群那一跳的放行闸与 onFinal 同源 (`router.finalReleased`): 已落定的那一轮只放追述 (或就是表上那份 outcome) 进群, 与谁先跑无关。工单账只在首次落定时记 (`deliverRoute` 跳过 `row.late`, 追述也不计 `maxTurns`); 迟到信封写明追述去向 (`retellTo`: 「带 `RESULT:` 才作为追述投给 X / 进群」), 追述回执自注「以这一份为准」。
- 路由表墓碑 (`handed` 行) 满 24h 回收 (`router.collect`, §4.6): 挂在 journal 压实上 (本来就整份重写, 不新增 IO), 判据 = 满 `TOMBSTONE_TTL_MS` (无 `settledAt` 的老行按 `deadlineAt` 起算) + 没有 held 行的 `after` 引用它 + 整棵子树都可回收 (子树闭合, 留下的行往上走 chain 永远走得通)。回收后迟到的结论退回旧行为: 照投原收方, 信封说「终句只进 rolepage」。
- 工具 id 参数简化 —— 模型不再抄 event id, 「哪一笔」由路由表推断 (`router.pickPair`: 本轮在读的那份回执 → 这一对唯一在飞的 → 最近一笔): `tell_peer.re` 改布尔 (`re: true`; 本轮是对方的 NEED 回执又对它说话时缺省即续, `re:false` 推翻); `for` / `after` / `pending_items.drop` 写名字 (派活方 / 对方 wizard); `stop_wizard` 的 interrupt 不必再给 `turn` (缺省 = 撤回你派给它、还在飞的那一笔, 只按 Esc 不 teardown)。一对之间并发两笔才需 event id, 400 会列出候选。id 入参统一规整 (`eventRef`: 剥 `route:` / `rcpt:` 前缀与 `:rN` / `:resume` / `:<rev>` 后缀); 续不上时回包带 `reUnknown` 明说按新活发出, 不再静默; 返工已落定的那一笔沿用它还开着的工单。回执 / 需求根单 / 挂起事项 / 宪章里的示例同步改写, after 放行附注不再列 event。老 MCP 进程照传 event id 仍认 (非 BREAKING)。

### Removed
- **BREAKING** 回执的核心机制整组退役 (T10): `daemon/receipts.ts` 与 `daemon/receiver-stack.ts` 删除, 改由**回执路由表** (`daemon/router.ts`, journal `~/.wezard/routes.jsonl`) 承载 —— 一件活 = 一行 `<event, owner, receiver>`, 「在等 / 欠着 / 挂了子活 / 链多深」全部是派生查询 (`waiting` / `chain` / `owedBy` / `awaitedBy`), 不再有第二份数据。上面 `Added` 一节的两条 (金字塔路由 / peer 帧 transfer) 描述的是被本节取代的机制, 保留作历史。
- **BREAKING** 主键从「件号 `t…`」换成「路由 event」(根 `e`+6hex / 子行 `<parent>.<n>`): 注入事件 id 由 `p:<self>:<target>:<turn>:<legs>` 改成 `route:<event>` (续问 `route:<event>:r<legs>`); `tell_peer` / `dispatch` / `spawn_wizard` / `clone_wizard` 的 `re` / `for` / `after` 与 `stop_wizard` 的 `turn` 现在收 event id (`re` 按表定位 owner, 不再按旧件号找人); 回执落定后 `re` 只能点当前 owner, 点错 → 409。
- **BREAKING** `return:` 只认 `self` / `transfer` / `detach` / `none`; 旧写法 `chain:false`、`receipt:false`、`answer:"transfer"` 一并下线 (不再映射) —— 老 MCP 进程带旧写法的请求会拿到 400。`answer:"transfer"` 的「回答移交」协议与 `transfer` 的「叶子作答 / delegate」整条退役: transfer 现在只等于把那一行的 owner 改成收方 (路由表 `move`), 结论按新 owner 回收。
- **BREAKING** remind 信封属性: `turn` / `re` / `reply-to` / `k` 退役, 改 `event` / `serves` (`LEGACY` 的正文措辞仍认; 但属性出现之前落盘的 transcript 里那几个属性不再被读 —— 老轮次的 `serves` 认不出, 与「不知道」等价)。`message-events` 的 continuation 代数 (`awaitingContinuation` / `continuationGeneration` / `currentContinuation` / `parentGeneration` / `defer` / `continueResult`)、`shared/turn-state` 的 `LegacyTurnSlot` 适配层、`direction` 的帧参数同时删除。
- **BREAKING** 状态文件 `~/.wezard/receipts.json` / `holds.json` / `answer-transfers.json` 不再读写: boot 时**条件**改名 `<file>.t10.bak` 归档 (窗口 = 路由表上没有 `open|need|error|held` 的行; 不满足则这次不动、下次 boot 再试), 不迁移。超时 / 静默 / pane 没了 / 被收掉这些失败改由 `router.sweep` 每 15s 合成一份定论, 与 `done` 走同一条投递通路。配置键 `wrc.mirror.receiptsFile` / `holdsFile` 保留, 但 `receiptsFile` 现在只当工作流存档 (`.nodes.json` / `.plans.json`) 的路径前缀。
- **BREAKING** 工作流计划的 `PlanOrigin` 不再写 / 读 `k` / `stack` / `chain` (只写 `event` 与 `asker`; 老 run 的这几个键照收不抛, 只是不再参与判定)。工单验收打回的语义随之明确: 不合验收的交付**不落定论** (行留在 `open`), 以工单 owner 的名义在同一笔上按 `route:<event>:r<legs>` 打回一次; 「打回过」记在内存, 所以 reload 后同一笔最多多打回一次。
- `settleHeld()` 放行 held 行后不再自动把它的活投出去 (旧注入挂在回执槽的 `release` 上): 预留 `releaseHeld(row)` 接入位, 载荷设计待定。
- **BREAKING** prompt-cache 保温 (keepalive) 整组删除: `shared/keepalive.ts`、配置节 `wrc.mirror.keepalive`、`spawn_wizard` / `clone_wizard` / `new_claude_session` 的 `keepalive` 参数、`/stop` 与 `/clear` 的保温暂停、rolepage 的 🏓 ping 折叠一并下线; 老配置里残留的 keepalive 键被 schema 静默忽略。缓存冷热判定 (route_candidates / dispatch 冷门控) 保留, transcript 读不到分层写入记录时按 300s 兜底 (原读 `keepalive.ttlSec`)。

### Fixed
- 群里偶尔冒出一条 `[mirror] ✗ composer cleared without this event's transcript marker; ...`: 回车后的证据窗口只有 `CLEARED_TIMEOUT_MS` (1.5s / 冷启 4s), 而 CodeBuddy 的 user 行按「接受输入的时刻」打时间戳、却要等 TUI 把这一轮消化完才落盘 —— 忙时落盘迟于窗口, 于是「框空了 + 这一笔的标记还没读到」被合判成硬失败, 消息其实已经到了 (2026-10-14 实测 `h687c3a5`: 标记 23:06:50.834 写进转录、还并进了同一秒另一条注入的提交, 1.5s 窗却读不到, 23:06:56 群里就多了一条 ✗)。提交现在与粘贴同一套宽限: 判 uncertain 前先按 `LATE_LAND_MS` 再盯一阵, 拿到证据就算已提交; 真到点仍没有才判不确定, 并留一行日志 (此前这条路径只有群里的那句 ✗ 可查)。
- rolepage 的移交行把**私聊**派活标成「公开」并把原文摊开 (chevron 朝下): 真实落地与否由守护进程算 (`wantPublic` 会被顶层模式 / 工单 / `fyi` / `transfer` 逐条降级), 而 `tell_peer` / `dispatch` 的回包从不带它 —— 渲染端只能按「dispatch 默认公开」推, 于是开着顶层模式的群里(实测 `chatPolicy.user:T03880027A.topOnly`)每一次派活都被盖上公开章。回包现在带 `public` 的落地值, 提示行另从**对方接手的那一轮的频道**读回事实 (回包没带的老记录照纠, 整行跳转的频道随之对齐); `return:"transfer"` 也在行上标出「整件交出」(结论直接回上游, 不回派活方)。
- 把人问的那一笔 `tell_peer({return:"transfer"})` 交给另一个 wizard 后, 接手方的终句从不进群: 路由表照常 `move` → `answer` → `hand chat:…`, 但 transfer 被当私聊派活, 注入事件 `channel:""` —— chat 行的气泡只由 final 通道按事件频道放行, 频道为空就被当私聊轮扣下 (轮内频道印章也因「非公开非回执的 peer 轮必私聊」被清空)。现在交出的是 chat 行时, 注入事件带上那句人话的群, 出处标 `transferred` 免于私聊兜底 (reload 后从信封读回也不再误标成公开派活、把回复头标给交出方)。交出的是同伴派的那一笔时不变。
- 冷目标拉起期的人话排队气泡只显 `…` (loading): 原先那句「正在拉起 X 的会话」带着 `.x:` 头, 而此刻冷目标还没进名册的 known —— 头里的半截链接改写落空, `[`.x`](url):` 进群被企微渲染成空链接, 还抢先 mirror 的 ack 进气泡、紧接着被顶掉白闪一下。loading 是纯文案不带头。同 pane 队空且无否决项时也不再多说一句「排队中（前面 0 件）」去顶掉气泡; 队列离开 queued/dispatching 后 watchQueue 即收工, 气泡从此归 mirror。
- 内建整理者执行体 (`wezard:internal#steward`) 吃不上管家档: `stewardTierOf` 把「带 slot 名」一概排除, 而它正带着 `#steward` —— 不给档就落 CLI 自己的默认模型 (本机实测 opus/high), 比 router 那档重得多。现在内部 key 与群默认会话同样固定吃 `models.router`, 显式 model / 记录值都不再覆盖它; 真 slot 分身照旧不套档。
- `tell_peer` 带 `re` 续问一律被 409「这一轮服务的那一笔你已经 transfer 出去了」挡下 (T10 起): `planReturn` 把续问沿用的原件 (本来就欠在对方手上) 当成了本轮服务的那笔; 该判据只对本轮服务的那笔生效。receipt-regress `need` 用例的续问同步去掉与 re 冲突的 `detach`。
- 指名 (`.name`) 开一个新 wizard 时 tmux 窗口名不是那个名字, 而是它所在聊天的主 id (`user:T03880027A` → `u-T03880`), 同一个群里几个新 wizard 的窗口名一模一样: 隐含建会话那条路 (`events.inject`) 在名册里还没有名字时把**会话 key** 当窗口名传下去, `safeWindowName` 又把 `user:…` 开头的 key 按 principal 截成 8 字符。窗口名现在统一由 `windowLabel` (`shared/session-label.ts`) 定: 调用方给的名字照用, 给的是会话 key 或没给就用名册 / 聊天名推并落定, 收口在 `newSession` / `cloneSession` / `spawnTmuxClaude` 三处; 名字的 `.fix` 与 `fix` 两种拼法在 `safeWindowName` 里也归成一个窗口名 (2026-10-15 实测: `#naming` / `#naming-pane` / `#unhookwhendaemon` 的窗口都印成 `u-T03880`)。
- 注入正文里行中提及 `<system-reminder>` 字面量 (讨论这个 tag 本身的派活最常见) 时, `REMINDER_RE` 的懒惰匹配从该字面量一路吞掉后面真正的信封块 —— 整句的信封与注入事件 id 全丢, 那一轮三条绑定路径 (注入印章 / transcript 认领 / evidence 对账) 统统绑不回路由行, `RESULT:` 终句永不落定、行挂到 sweeper 代发闲置追问 (2026-10-15 `e3c34b4.1` 实测)。开标签锚定行首 (渲染方永远 `\n` 起头), receipt-regress 补对应断言。
- 人话注入不再占全局 4 路并发名额、也不等 pane 上的 awaiting-result 探测位 (此前同 pane 一条在跑的事件每秒一次的 evidence 探测几乎一直占着 probeTargets, 人话被反复跳过或误判失败退避): 人话只认同 pane 物理互斥, ready 检查不碰 pane。`/message-events` 的 `queue` 动作回报一条排队事件的全貌: 同 pane 排在它前面的未了结行、每一项否决落在哪 (调度器停 / 重试倒计时 / 同 pane 在贴 / 并发满 / 被挡), daemon 日志同步一行排队实况。
- 注入 CodeBuddy 时反复报 `composer is empty but this event is absent from the transcript`, 且那条消息随后与下一条注入并成同一行提交 (2026-10-14 两起: 人话 + 回执并成一行, 前一条的终句还被记到了别的事件上): 轮次交接 (提交 / 收尾的 hook、会话摘要) 时 CodeBuddy 会把粘贴的渲染拖过 2.5s 的落地窗, 事件注入判「框是空的」后既不重贴也不回车就撤 —— 而那份粘贴其实只是迟到, 撤下后在框里躺着, 被下一次注入接在后面一起交出。现在先多盯 15s 等它露面 (露面就照常回车), 框认不出 ≠ 框是空的 (照样回车交给证人), 只有到点框确认原样才判 uncertain。另认 CodeBuddy 忙时的待发队列 (`↳ <文本>`): 那句回车后挂进队列、出队才落盘, 此前一律报 `composer cleared without this event's transcript marker`, 现在算已提交。
- 探活把「tmux 问不出来」当「pane 死了」, 于是同一条消息链反复重生 pane (2026-10-14 实测: 同一个 wizard 7 分钟内被重生 3 次 —— 22:44 `%656` / 22:49 `%660` / 22:50 `%661`, 每次都 `--resume` 起新 pane、作废会话当前的输入队列; 同一刻 6 个 pane 的 `display-message` 一起超时被 kill, 是 tmux server 卡住而不是 pane 没了): `tmuxPaneAlive` 是布尔 —— 只要不是「成功且回显同一个 pane id」就算死, 而 server 卡住时它最常见的失败正是超时。改三态 `paneLiveness` (`alive` / `gone` / `unknown`, 超时与 `code:null` 归 `unknown`, 只有 tmux 明说 `can't find pane` / `no server running` 才 `gone`; `runTmux` 的超时路径与起不来路径标 `timedOut`), 注入前的判定收成 `probePane` (`gone` / `shell` 才走 respawn, `unknown` 一律按「稍后重发」交回, 既不贴也不重生) —— `injectText` 与 dispatch 的 inject job 两条路都按它分支。
- 人在 pane 里直接敲 `/clear` (或 CLI 自己换了会话) 之后镜像永远停在旧转录: 新转录与旧的在同一个项目目录, 3 秒一次的 pane 漂移跟随按「目录变没变」判据, 同目录直接跳过 —— 绑定的 jsonl 从此没人写, 每次 reload 的 boot 恢复还把这份死绑定再恢复一遍。跟随器加同目录分支, 判据只认**注册表按 pane 报的会话** (写 `tmux` 字段的后端有这条路); codebuddy 认不出就不动 (它的注册行里 sessionId 是续接链的根, 换过 sid 之后不更新 —— 实测 pid 84679 报 `3d51b76b` 而该进程实际在写 `01a13ae5`, 沿进程树只能认出「有活的 CLI」而不是「哪份转录」; 按「目录里最新的是谁」猜在共用 cwd 下会把别人的转录认到自己身上)。迁移取 EOF 起读, 不把轮换之后已经长出来的那一段倒回聊天窗口。
- rolepage 同一句话画两颗气泡: tail 软收口已按 `final:false` 记过终句, 收口时 `recoverEventFinal` 不再追加同文第二条而是就地升级 (`markTurnTextFinal`); 续答链把子事件终句误写进父事件 `result` 的 (continueResult) 也不再补进父轮记录。已双写的历史记录渲染时相邻同文只留终稿; 忙时插队被记两遍 (插话 + 真开一轮) 与 reload 切段后开头重印的入消息按重影剔除 (`injectEchoesOf`: 同文含互相包含认插话, 同 `eventId` 切段只留最早一段)。`DeferExecuteTool` 外壳下的调用剥壳按内层工具认提示行 —— 这层壳下的 `tell_peer` / `dispatch` 此前永远没有提示行。
- 流式气泡定格在最后一行 CoT 进度、不更新到终句: 事件泵 evidence 探针 (observe → io.recovered) 与 brief 软收口同为 ~1s 周期赛跑, 探针常先跑到而它调 `recoverEventFinal` 不带气泡 —— 终句全走 standalone, 气泡定格; 现在没传气泡时按 target/turn 找回活着的 `briefBubble`。链式收口 (`eventFinalGate` 子活未落定) 只延后 closing 释放、不再扣住气泡: 气泡还在 stream 窗口内就把终句刷进气泡 (`finishBriefBubble`, 与正常收口同形), 已收 / 过期 / 终句超单条上限才 standalone。
- `dispatch` 自动选人先按「活着且是 slot」收窄候选池再读 transcript: 此前对全机几百个绑定 (多数 pane 早没了) 逐个扫尾巴算文件集 / 问话 / 缓存时刻, 读完才丢掉, 路由一步就要 ~2.8s; 收窄后 ~0.4s, 候选池与公共文件统计口径不变。自动派给已有 wizard 端到端从 ~3.5s 降到 ~1s, 自动转 spawn 从 ~9s 降到 ~6.5s (余下是 CLI 冷启动)。
- 孤儿 pane 清扫把正在出生的 pane 生出就杀 (新 wizard 秒死 / TUI ready timeout, 日志里 `orphan pane killed` 的 `cliAgeHours` 恒为 0): 进程年龄快照用的 `ps -o etimes` 在 macOS 的 BSD ps 上不存在 (`keyword not found`), 年龄表恒空又按 `Infinity` 兜底, 10 分钟宽限形同虚设。改用 BSD/GNU 都认的 `etime` ([[dd-]hh:]mm:ss) 解析成秒, 拿不到年龄按刚生跳过; 分身在开场白 + 等分叉期间的 pane 挂进 `spawningPanes` 排除出孤儿判定, 绑定改为逐 pane 现查 (清扫途中别人刚 attach 上的不再按开头的快照误收)。开机收「生到一半」窗口的 `reapUnborn` 同样不再误收本进程自己生的 pane (只收 shell 比 daemon 进程老的、逐 pane 现查绑定并跳过 `spawningPanes`) —— sweepUnborn 腾出的名字被同名重生、或 spawn 等 TUI 就绪还没回 pane id 时, 此前会按窗口名直接杀掉。
- 非 default wizard 的 `` `name` `` 反引号署名不生效 (5655850 只在 chatHead 写了署名): 出站气泡的最后一道头改写 `withMessageFooter` 按旧式链接头重写, 把上游已写好的署名又抹掉。署名定式收进 footer: 非 default 一律 `` `.name`: `` 起头 (名字不挂链接, rolepage 入口归尾部 ✦), 幂等。
- rolepage 窄屏 (移动端) 退回会话列表再点进同一会话后停在顶部: 列表态 `.main` 整棵 `display:none`, 浏览器把滚动位置清零、隐藏期间的 `toBottom` 全部落空。重进时按离开时的吸附状态恢复: 本在底部 (`pinned`) 的吸底 (之后新消息照跟), 在翻历史的回到离开时的 `scrollTop`。
- 流式 (brief) 气泡头的详情页链接与终句 (standalone) 气泡对齐: `briefLine` 拼 URL 时漏传 role (target), 两种气泡的链接落到不同角色视图; 改走与 standalone 同一条 `chatTurnUrl`。
- 回执晚到 (2026-10-15 实测 441s / 623s / 932s), 且派活方的挂起账被提前清、同一行出现两个 rev (前假后真), 双根因: **A** codebuddy 干到一半的叙述被当成定论 —— 它的 assistant message 不写 `stop_reason`、function_call 又是独立一行 (`parseTurns` 丢掉), 「先跑 typecheck 确认绿。」这种后面紧跟工具调用的中途句一写完, evidence 的 `ended` 就成立, 假 done 先落 `answer`、`deliverRoute` 清掉挂起账, 真结论在轮收口时再落第二个 rev。现在 `parseTurns` 把后面跟着工具调用的 assistant 句标 `mid`、软后端 (codebuddy 归一化标 `awaitTurnEnd`) 的句子标 `soft`, `soft` 句必须见到轮终证据才算终句: **紧跟**它落盘的 `turn-metrics` (归一化成 `system/turn_metrics`; 长工具调用中途写的那种前面是 function_call / result, 不算; 也不映射成 `turn_duration`, 免得 mirror 中途关轮)、下一句 user 行、或 CLI 确认已闲。**B** 回执入箱后 owner 闲着却一直不注入: normal 优先级要等 `idleNow`, codebuddy 注册表没有 status, 只能读屏 (输入框 / 模态判据), 闲了 331s 仍判不闲、没有一行日志。现在 `idleNow` 在注册表说不出时先看转录 —— 一轮紧跟正文落了 `turn-metrics` 即确定闲 (pane 前台是 shell 不算, spinner / 模态照旧否决), 轮收口 (`closeBriefTurn`) 时主动泵一次收件箱。另补可观测: 回执 / 派活因 ready=false / injectable=false / 退避 / 探测位被占被扣超 30s 打一行 `message event held in queue` (带原因, 原因变了或满 5 分钟再报), `GET /message-events/status` 对排队中的回执 / 派活输出 `holds`。
- 投递正文剥掉行首 `RESULT:` / `NEED:` 收口标记 (`peers.stripClosingMark` / `stripForChat`, 群气泡再剥 `ARTIFACT:` 交付行 —— 本机路径对群里读者没有用途): 三条群气泡出口 (`queueFinal` / brief 收口 / quiet 转发) 与回执的 wizard 收件箱统一剥除, 群里只看结论、收方不再被正文里的 `NEED:` 前缀误导。剥只发生在投递出口 —— 判定 (`parseClosing` / `finalKind` / `finalReleased`) 与账本 (路由行 outcome、收件箱幂等 rev 上游) 仍读原文。

## [2.6.4] - 2026-10-13

### Fixed
- daemon 统一持久化用户与 wizard 消息调度及终句投递；续接绑定原始事件与目标会话，恢复时补齐终句确认，避免并发串轮、重复投递及回执丢失。
- CLI 图片附件确认最多重试三次，确认成功后才提交输入，失败保留输入并明确报错。

## [2.6.3] - 2026-10-13

### Added
- workflow 节点尝试与验收状态独立记账；受限计划在验收通过后推进依赖节点，并约束执行者占用与异步撤销。

### Fixed
- 回答权移交绑定原始轮次，隔离并发、撤销与终态竞争；清空旧气泡后仅接入接手者的有效进度及终句，回执先持久化再异步投递。
- topOnly 回复统一使用详情链接尾注，保留正文链接、引用路由和实际目标群的默认身份；slash 回复移除多余 tips。
- 管家创建采用配置的 router 档位；Codex 输入识别兼容底部警告，图片附件核验完成后才提交提示。
- 同一 tmux pane 的完整输入事务串行，锁内复核空闲状态，区分未发送与不确定投递，避免并发输入串轮或重复提交。
- keepalive 与确认框巡检按 pane 调度，定时任务按目标排队并去重；慢任务不阻塞其他目标，取消和权限撤销在实际输入前复核，保留日程主人身份。

### Changed
- `approval.allowRules` 默认值从 `[]` 改为 `["ToolSearch"]` (`shared/config.ts` 与 `config.example.jsonc`): ToolSearch 只是 deferred 工具的 schema 查询, 无执行能力 (真正的执行走 DeferExecuteTool, hook 侧已下钻成内层工具再判定), 每次查 schema 都发卡是纯噪声。config 里显式写过 `allowRules` 的整份覆盖不合并 —— 要保留该豁免需在自己的规则里补上 `"ToolSearch"`。

## [2.6.2] - 2026-10-12

### Fixed
- tmux 命名 buffer 的 load 明确返回 `buffer invalid` 时，即使版本探测偏高也安全退回无名 buffer；先等待已开始的命名投递及清理结束，再串行执行 load→paste，始终保持原目标 pane。现代正常路径继续并发；paste 失败、超时和其他错误不自动重贴。
- 旧 tmux 在读取大消息 stdin 前拒绝参数时，处理管道 `EPIPE`，避免 daemon 崩溃，并保留原始 tmux 退出码和错误以完成兼容降级。

## [2.6.1] - 2026-10-12

### Fixed
- tmux 消息投递按版本分流: tmux < 3.0 (含 1.8) 使用默认 buffer 并串行执行 load→paste; tmux >= 3.0 使用独立具名 buffer, 保留跨 pane 并发与用户剪贴板。始终投递到指定 pane, 缺失目标不回退到当前 pane; 失败时清理具名 buffer, 版本探测失败允许下次重试。

## [2.6.0] - 2026-10-12

### Added
- 新增 Codex 后端: 使用原生 app-server 创建、恢复与 fork 会话, 按 rollout 元数据发现会话, 支持 tmux 注入、审批卡与 rolepage 用量展示; hook / MCP 同步保留第三方配置与 trust。
- 新增按后端独立配置的模型档位 (`models.backends.<backend>.tiers`), 提供 Codex 默认档位及显式迁移; 新增 `models.router` 档位配置, 模型与 effort 在创建时按实际后端解析 (当前规则 dispatch 不消费此项)。
- 新增 Codex 原生 sandbox 配置, 与 wezard 工具审批分别控制。
- 多企微机器人, 按机器人隔离: 新增配置 `bots: [{id, botId, secret, websocketUrl?, allowFrom?, defaultChat?, approvers?}]`, 一个守护进程同时持有多条长连接 (`daemon/bot-mux.ts`); `bot` 节仍是主机器人 (id `main`), 只配它时什么都不包装, 行为与数据不变。机器人维度落在会话 key 上: 副机器人收到的聊天 principal 带后缀 (`user:X~b2` / `chat:wr…~b2#slot`, 主机器人不带), 同一人私聊两个机器人、同群拉两个机器人就是两个会话、两套 wizard; wizard 名字不加后缀, 仍全机唯一。wizard 的归属机器人由 key 推导 (`botOfKey`), 出站一律走归属连接: 被动回复与改卡按入站帧找回收到它的那条 (改卡必须用推卡的机器人), 主动推送与媒体按 key 后缀改道。可见性按机器人隔离 (群管家也不例外): 名册 / peek / read_chat / 派活 / spawn / clone / notify / send_file / 定时任务只作用于同一机器人的 wizard, 跨机器人寻址按「没有这个 wizard」拒; rolepage 同样按机器人隔离。入站授权 = `wrc.allowFrom` ∪ 该机器人自己的 `allowFrom`; 魔法短语认领只认主机器人, 主机器人的自动认领仍只看全局 `wrc.allowFrom` (行为不变); 每个副机器人各有一份自动认领: 它自己的 `allowFrom` 空着时, 第一个单聊它的人被写进 `bots[id].allowFrom` 并设为 `bots[id].defaultChat` (写回 `bots` 所在的那份文件, 通常是 secrets.json), 不碰全局 defaultChat / allowFrom, 群聊不触发; 无镜像会话的审批人在全局 approvers / defaultChat 都空时借副机器人的 (挂后缀, 卡由该机器人推)。任一机器人认证失败 / 被踢只降级 (`/status` 的 `bots` 里标 `failed` / `kicked`), 全部失败才 fatal; 切网重连跳过被踢的那条。同一 `botId` 配两次、`id` 重复或叫 `main` 配置期即拒 (两条连接会互踢下线)。

### Fixed
- 回执回归按实际后端选择模型并读取 transcript; WS 状态测试对齐单机器人与 BotMux 接口, 异步汇总与静默任务用例明确各自的交互协议。
- 加固 Codex 审批、会话发现与输入框识别; wezard 自调用免工具审批, 原生 sandbox 请求独立审批; daemon 暂时不可用后审批 hook 可恢复。
- router 复用须有同一任务的连续证据, 忙碌或承担其他未完成任务的 wizard 不接无关事项; 冷缓存与上下文成本参与判断。
- 管家、新建与恢复会话共用模型档位解析, 兼容 Claude 系模型回退及后端切换; usage bar 首轮即显示创建时选定的模型 / effort。
- rolepage 保留会话与插话参与者身份, 计入 Codex 响应用量, 识别 exec 包裹的 wezard 工具提示。
- 回执不再强制 RESULT 格式, 尊重终句 NEED; 修复 caller 路由、启动 trust 与后端兼容性。
- tmux 消息注入使用默认 buffer 并在进程内串行, 兼容 tmux < 2.0。
- 所有新建 pane 统一使用配置的 `wrc.defaultCli` 后端, 不再被聊天绑定、调用参数或 tier.cli 覆盖; 旧会话跨后端恢复 / 克隆返回明确错误, 保留原上下文。
- pane 上限的孤儿回收对 codebuddy 后端全盲: 孤儿判据要求 pane 出现在后端注册表 `sessions/<pid>.json` 的 `tmux` 字段里, 而 codebuddy 的注册表没有该字段, 失绑老 pane (restore 丢绑定后下一条消息另起新 pane、旧 pane 不杀) 永久逃回收、也不占 `maxPanes` 名额。改为直接看 pane 的进程树: 树里有任一后端注册表登记且还活着的 CLI pid (新增 `wezard-session.liveSessionPids` + 一次 `ps` 快照向下找, pane_pid 是 shell, CLI 是子孙) 才算 wezard 的历史会话 pane; 人的 shell / ssh / 编辑器依旧「认不出就不动」。
- pane 上限清扫此前只在新建 wizard 时触发, 无 spawn 不收。新增 `wrc.mirror.paneSweepSec` (默认 600, 0 = 只在 spawn 时扫) 定时清扫, daemon 启动 15s 后先扫一次。

## [2.5.1] - 2026-10-09

### Fixed
- 守护进程带着 `$TMUX` / `$TMUX_PANE` 启动时 (在 tmux 里 `reload` 走 nohup 兜底路径会继承调用方环境) tmux 行为错乱: 客户端把每条命令路由到 `$TMUX` 指的那台 server 而非 launchd/systemd 启动时看到的默认 socket, 老版本 tmux 还会以 "sessions should be nested with care" 拒绝 `new-session` 即使带 `-d`。新增 `shared/exec-path.ts` 的 `tmuxClientEnv` (拓宽 PATH + 剥掉 tmux 座位变量), `spawn-tmux.ts` / `session-scan.ts` 里一切可能跑 `tmux` 的子进程改走它; `cli/wezard.sh` 的 nohup 启动同样 `env -u TMUX -u TMUX_PANE`。
- 无客户端 attach 的后台 pane 窗口落到 tmux 默认 80x24: codebuddy `/model` 选择器 (30 多行无编号行、80 列截断) 的标题与 scope 切换条被顶出屏外, 读屏判据误判选择器没打开, spawn 卡在「模型没选上」。`new-session -d` 显式带 `-x 200 -y 60`, 已有会话补 `set-option default-size 200x60`; 只影响没人看的 pane, attach 的人的终端照旧说了算, tmux < 2.9 没有 default-size 时保持 80x24。

## [2.5.0] - 2026-10-08

### Changed
- rolepage 切换会话不再白屏: 新内容就绪后一次替换 (0c49684)。
- wizard 发进群 (企微 / 微信) 的消息头统一为 `[.fix](rolepage): …`: 不再带 emoji (emoji 只是 rolepage 的头像), 名字后带冒号; 公开的 wizard 间对话由 `🦊 .a → 🐨 .b` 改为 `.a: .b` (无箭头、无 @, 名字前的 `.` 就是 wizard 的记号)。审批 / 提问卡、工具卡标题、notify、send_file 说明、定时任务、镜像气泡同一份实现。群的默认 wizard 在自己群里不再自报身份: 企微群里只留名字链接 `[.name](rolepage):` (进 rolepage 的入口, 没有链接时整个头不写), 微信群里整个头不写 (定时任务执行体替日程主人说话, 主人是群默认 wizard 时同样不写; 微信 outbox 里上个进程压着的老格式消息补发前按现行规矩重写头); slot 分身、被人从别的群点名来的照旧带头。引用旧格式 (带 emoji / @ / 箭头) 气泡照样认得出发话人, 引用不带头的默认 wizard 气泡落回本群默认 wizard。
- 微信 ClawBot 群聊 (`chat:wx_…`) 默认开顶层模式: `chatPolicy.<chat>.topOnly` 没写时按通道取默认 (微信开, 其余关), 不落盘, 已绑定的微信群聊直接生效; `config_set` 写 `false` 照样关。
- 发往微信的文本里 markdown 链接 `[字](url)` 降成「字」(代码里的原样留着), 其余 markdown 子集 (粗体 / 代码 / 表格 / H1-H4 / 引用) 照旧。
- rolepage 与 `read_chat` 的发言头跟群里同一写法 (`.a:` / `.a: .b`, 去箭头、去 @; rolepage 名字前贴头像, `read_chat` 与群里一样不带 emoji): 三处共用 `shared/session-label.ts` 的 `nameHead` / `said` / `speakerHead`, 浏览器那份由 `/chat/app.js` 开头的 `WZ` 原样送达, 不另抄。rolepage 的消息头、「发给谁」、移交行里的对方、搜索结果、工单成员按钮一并改。
- `wrc.extraArgs` 默认值从 `[]` 改为 `["--disallowedTools=Artifact,Workflow,SendFeedback,ScheduleWakeup,mcp__claude_ai_Claude_Docs__*,mcp__claude_ai_Google_Drive__*"]` (`shared/config.ts` 与 `config.example.jsonc`): 新装 / 没写过 `extraArgs` 的机器默认把这些 wizard 用不上的工具从上下文里摘掉, 交互式首轮实测每个会话省约 18k token (Artifact 11.3k、Workflow / SendFeedback / ScheduleWakeup 5.6k、claude.ai Docs / Drive 1.0k)。**只影响新起的 wizard** (`--resume` 续上的会话可能沿用录下的工具表); config 里显式写了 `extraArgs` 的照旧整份覆盖, 不合并。说明与恢复办法见技术说明「配置」一节; codebuddy / claude-internal 是否认该参数未验证。
- **BREAKING** 管家模型改按档位配: `models.router` (`{model, effort}`) 换成 `models.steward` (tier 名, 取值同 `models.tiers`, 默认 `light`), 按群覆盖写 `chatPolicy.<chat>.steward`; 老的 `models.router` 不再读。管家 (群的默认会话) 新起的会话 —— 首条消息、`/new`、`set_workspace` 换目录、交接重开 (`handoff` 不再沿用旧模型) —— 都按此档起, 档压过绑定里记下的 effort; 死 pane 重生 (`--resume`) 仍沿用绑定记下的模型 (`set_model` 换上的也在那), 没记的才补管家档。已在跑的管家不动, 要换上就 `handoff` 或 `set_model`。`config_get({path:"models"})` 的依据在管家档那一行标「管家档」。
- tier `light` 的默认从 haiku·low 改成 sonnet·medium (`shared/config.ts` 与 `config.example.jsonc`): 它也是管家的默认档, haiku 当管家判不稳。**影响所有 `light` 档 spawn** (`spawn_wizard` / `clone_wizard` / `dispatch` 的 `tier:"light"`) —— 没在 config 里写过 `models.tiers.light` 的机器, 跑腿分身从 haiku 变成 sonnet, 成本随之上去; 要原样就在 config 里写回 `{model:"haiku", effort:"low"}`。
- 管家宪章「我是这个群的管家」一节重写给 sonnet 档读: 判断「自己答还是派出去」写成从上往下、命中即停的三条检查单 (凭已知能答 → 自己答; 看一眼代码 / 跑一条命令能答 → 每轮至多 `stewardBudget` 次, 还答不了走下一条; 要读多处代码 / 改文件 / 跑很久 / 分好几步 → 派), 其余分「怎么派」(续篇先判、小活 `dispatch`、复杂活 `lead:true` + `criteria`、推翻 dispatch 的条件) 与「回执回来」(交代带取舍 / 遗留、对人别提单号、验收与返工) 两组; 顶层模式、私聊、手闸等硬约束不变。已在跑的管家要 `handoff` 才换上。
- 群况快照 (`<system-reminder wezard="roster" mode="full">`) 从 `name,state,job` 扩成 `name,state,ctx,cache,job`: `ctx` 是上下文用量 (`84k`), `cache` 是 prompt cache 冷热 (`warm` / `cold`, 与 `route_candidates` / `tell_peer` 冷门控同一口径), 读不到会话的留空; `state` 多一个 `parked` (闲着却悬着工具调用 = 停在审批卡上, 此前算作 `busy`)。表头上方加一行列义 (`busy` / `parked` / `idle` / `-` 各指什么、冷了唤醒要整段重写 ctx、只在点名 `to` 时要掂量 —— `dispatch` 自己算), 只随整表出现 (每个会话窗口一次), 变动行不重复。tier / 模型不进表: 只在 spawn 时由 `tier` 决定, 点名现成的 wizard 时看 `wizard_roster`。
- 群况快照之后不再只挂生收改名: 每次注入现算一遍表, 与「上次告诉这个收件人的那一行」不同的行 (state 变了、cache 冷热翻了、ctx 跨了 50k 一档、职责改了) 以 `<system-reminder wezard="roster" mode="delta">` 挂上, 同列格式 —— 此前整表之后 state / ctx / cache 不再更新, 管家手里的值能旧到窗口 (近 10 次注入) 那头。比对按窗口里最新的 `v:<name>=…` 键 (A→B→A 也会再报), 没变就一行不挂; 窗口与整表的重发时机不变。

- 管家手闸改成「读代码一律拒」: `Read` / `Grep` / `Glob` / `NotebookRead` / `LSP`, 以及命令位上读文件的 Bash (`cat` / `head` / `tail` / `sed` / `awk` / `grep` / `rg` / `git show|diff|blame|grep` 等; 管道后的 `grep` / `head` 读的是上游输出, 不算) 与改文件、开子代理同级, 一次都不放; `stewardBudget` 只剩给其余命令 (`git log` / `ls` / 外部工具) 计次。此前按调用次数计, 管家 grep 一下、分段 Read 两刀就在 4 次内读完一个模块, 照宪章「看一眼代码能答 → 自己答」答了机制题。宪章检查单第 2 条收成「跑一条状态命令就能答」, 第 3 条点名「机制 / 原理 / 现在还会不会… / 方案 / 排查 / 改动, 哪怕看一眼就像能答 → 派出去」; 人话尾巴的 `hint` 同步改。`stewardBudget: -1` 仍整个关掉手闸。已在跑的管家要 `handoff` 才换上新宪章, 拦截随 reload 即生效。
- 「活干完就 `stop_wizard` 收掉分身」改成「干完别急着收」(宪章工具行与编排段、`stop_wizard` 描述): 保温默认关, 闲着的分身不耗 token; pane 超 `maxPanes` 时守护进程从最久没动的收起、绑定留着, 追问时 `--resume` 原样续上 —— 而 `end` 连绑定一起丢, 同一话题的续篇只能白板新起重读。`end` 只留给话题确已了结、跑偏、或撞上 `cloneMax` (先收最早了结的) 时。已在跑的 wizard 要 `handoff` 才换上宪章。
- **行为变化** `close_job` 回收为工单生出来的分身时只关 pane、**保留会话绑定** (新的 `MirrorBridge.sleepPane`, 与 pane 超 `maxPanes` 时的自动收起同一语义), 收工后再 `tell_peer` 它会 `--resume` 带全上下文复活 —— 此前走 `killPane` (同 `stop_wizard` end / `/kill`) 连绑定一起删, 收工后的追问 / 返工只能白板新起重读。先 cancel 回执再关 pane 的顺序、只回收「为这张单 spawn 的」规则不变; 被收的分身不再占 `cloneMax` 名额 (只数活着的 pane)。`stop_wizard` end 照旧丢绑定。宪章、`close_job` / `open_job` / `stop_wizard` 描述同步改。
- **行为变化** 分身收尾不再归 LLM: `close_job` 只结账、留档, 不再回收成员的 pane (`stop` 参数删掉, 老 MCP 进程带来的照收不用; 回包不再有 `recycled` / `kept`); `as:"cancel"` 把所有未落定成员手上这张单派的活记成 canceled。分身上限 `cloneMax` 撞到时守护进程自己腾位: 把调用方名下最久没动、不忙、不停在审批上、手上没有未落定活的分身只关 pane、留绑定 (`sleepPane`), 腾不出才 429 (不再叫它去 `stop_wizard` / `close_job`)。宪章、lead 打法、回执信封、挂起事项提示与 `close_job` / `open_job` / `spawn_wizard` / `clone_wizard` / `dispatch` / `stop_wizard` 描述里关于收尾分身、回收 pane、何时 stop 的话删掉, `stop_wizard` 只留「打断或强制结束」。
- 信封 reminder 正文不再复述开标签属性已有的事实: 人话 / 同伴 / 定时 / 回执各信封删掉「这一轮是 `x` 在群 **y** 里说的」「wizard `x` 对你某一次 send_peer 的」、件号、工单 `j` 的 `done/total` 等句段, 正文只留属性推不出的回复去向、怎么接与规矩 (人话信封只剩「你的回复发回 `chat` 那个群」); 回执去向改指 `reply-to` / `audience` 属性, 追问用的 `tell_peer({name, re})` 字面量与「还差 N 份 / 全部到齐」保留。`parseEnvelope` 只读属性, 老措辞仍由 LEGACY 表认; rolepage 折叠不看正文。
- spawn 不再判断模型名「是不是 id / 见没见过」: 给了 `model` 就原样带 `--model` 启动 (删掉 `looksLikeModelId` / `exactModelId` / `labelFitsId` 与 transcript sighting 扫描 `modelSightings`)。起不来再兜底: 实测 codebuddy 2.143 对不认识的值**不会**在启动时退出, 而是照常起来、欢迎框原样回显该字符串 (认识的会显示成展示名, 如 `Deepseek-V4.1-Flash · high`), 首轮才 `400 model [...] service info not found` —— 所以启动后读欢迎框, 原样回显即判 launch failure; 另在启动命令尾巴挂一个退出标记, CLI 直接退回 shell 也能当场认出。命中则收掉这个 pane、不带 `--model` 重起, 再按原值走 `/model` 选择器; `modelWarning` 带上失败原因。写错 id 只多花一次启动, 不再损失一个 wizard。

### Added
- `tell_peer` 的 `after` (件号数组): 前置全部 done 才由守护进程以发话方名义投出 (信封附各前置的 RESULT / ARTIFACT), 有前置失败则按 canceled 回执; 停放期间状态 `queued(等前置)`, 落盘 `wrc.mirror.holdsFile`, `close_job` 一并取消。
- 派活方向闸 (`daemon/direction.ts`): 带 `job` 的 task 只许开单者发、同单成员之间只许 `ask` / `fyi`、上级单不越级派活、对方在自己的派活链上时不再派 task / ask、链深 ≥3 不再往下派; 被拦返回 409 并写明改道做法, `spawn_wizard` / `clone_wizard` 带 task 同样过闸。
- wizard 专长 `wizard_identity({expertise})`: 名册与 `dispatch` / `route_candidates` 候选行显示, 与任务重叠的加权, 平手时缓存热的优先; 借来的专家 (`role:"expert"`) 在名册任职行写「借给 J…(.lead)」。
- 微信 ClawBot 通道 (`weixin.*`, 默认关, `enabled` 是放权项): 审批人在企微单聊发 `/wx bind [群名]` (或终端 `wezard wx bind`) 出二维码, 用要绑定的微信扫码确认后, 这个微信用户成为一个**群聊** `chat:wx_…` —— 与企微群聊同构: 自动起群名 (协议不给昵称: 取 bind 时给的名字, 否则 `wx-<id 前 6 位>`)、进 `wrc.allowFrom`、生默认 wizard; `.name` 点名、spawn、slot 照用。支持多账号 (`maxAccounts`, 默认 8), 每号一路 iLink 长轮询 (退避封顶 30s、切网重连、`-14` 掉线报企微), 同一人重扫接管原群聊。出站一律进账本: markdown 降纯文本、流式中间帧只亮「正在输入」、超 `sendCap` / 节流 `minGapSec` 的合并或压着, 人再说话时先取回; 频控暂停 `ratePauseMin`; 人久不说话 (`ctxTtlHours`) 压着并往企微报一次。审批 / 提问 / 计划卡片跟着 turn 的群聊走: 发到微信群聊时降成编号菜单 (`【1】允许 … 短码 k7q`), 回 `1` / `k7q 1` / `k7q 1 3` 合成同一个卡片点击。图片 / 文件 / 视频收发走 iLink CDN (AES-128-ECB), `send_file` 发往微信群聊时按微信的上限 (单文件 25MB, 语音当文件) 校验。`/wx` 列状态 (终端 `wezard wx [list|bind|unbind]`, 二维码直接画在终端), `/wx unbind <序号|群名>` 解绑并撤销授权 (群聊与记录保留)。账号凭据只在 `weixin.stateFile` (0600)。新依赖 `qrcode`。
- rolepage 认得微信通道: 微信用户的发话人显示成它那个群的群名 (`WorldFacts.humanNames`, 通用的 human id → 显示名表), 微信群聊的群行与群详情头部在名字旁挂一个状态标记 (`🟢 微信` / `⏸️ 微信频控` / `🔴 微信掉线`, 压着出站时 `· 📬 压着 N`, 悬停看最近开口、剩余额度、暂停余时) —— 判定只在 `role-view.ts` 的 `wxMark`, 页面照画; 名字 / 头像与企微群聊同一份实现。老 daemon 推来的快照没有这两个字段, 照旧显示。
- 企微 aibot 文件 / 图片收发: MCP 新工具 `send_file({path, kind?, to?, caption?, title?, description?})` (路由 `POST /send_file`) 把本机文件以图片 / 文件 / 语音 / 视频消息发进聊天 —— 去向、聊天名、顶层模式闸与 `notify` 同一套 (闸抽成 `topOnlyMuted` 共用); 走 `uploadMedia` + 主动推送 `sendMediaMessage` (实测可用, 不依赖入站帧)。`kind` 缺省按扩展名推 (png/jpg/jpeg/gif → image、mp4 → video、amr → voice、其余 file), 超限 (图片 / 视频 10MB、语音 amr 2MB、文件 20MB) 直接报错并给改法。上传期间把 SDK 写死 5s 的回执超时放宽到 30s (aibot-node-sdk #27), 6MB 实测一次过。出站媒体抽成通道无关的 `SendMedia` (`daemon/media.ts`), aibot 实现在 `daemon/aibot-media.ts`。宪章工具行加一句「给人看的截图 / 文件 → `send_file`」, 已在跑的 wizard 要 `handoff` 才看得到。
- 入站补齐 `message.file` / `message.video` / `message.voice` (企微只在单聊推): 文件 / 视频解密落进 `wrc.mirror.inboxDir`, 落盘名 `<msgid>_<序号>_<清洗过的原名>` (0600), 以一行 `[文件: <路径> (<大小>)]` 注入会话; 语音只有企微给的转写, 以 `[语音转写] …` 当文字走。inbox (含图片) 超 7 天的文件在之后的落盘时顺手清掉 (每小时至多扫一次)。
- rolepage 用量条的 💰 费用悬停改成账单: 按模型 (同显示名同单价并一行, 子 agent 的轮次按它自己的模型并入) 列出单价表 (USD / 百万 token: in / out / cw / cr) 与「token × 单价 = 金额」逐项、小计、多模型时的合计; 认不出价格的模型单列「未计入」。账单由服务端随 usage 下发 (`AggUsage.bill`), 单价取自计价用的同一份 `priceOf` (`shared/model-prices.ts` LiteLLM 快照), 小计是逐轮 `costOf` 的和, 与总价同源。
- 人对管家说的话注入时尾巴挂一行 `<system-reminder wezard="hint" role="steward">`: 一两句能答、不用读代码 → 自己答; 要读多处代码 / 改文件 / 跑很久 / 分好几步 → `dispatch`, 复杂的带 `lead:true` 开需求单。只挂人的话 (斜杠命令除外), 回执 / 同伴 / 定时那几轮不挂; 不进 `parseEnvelope`。

### Fixed
- `/wx bind` 的发起门槛: 审批人名单空时, 认 `defaultChat` (是个人时) **并上** `wrc.allowFrom` 里的 `user:` —— 此前只认 `defaultChat`, `defaultChat` 指着别人、自己在 allowFrom 的使用者被回「只有审批人能用」。判据只有发话人是不是审批人, 不再区分单聊 / 群聊 (此前群里发起一律拒): 在哪个聊天发起, 二维码与进度就回到那个聊天。
- **BREAKING** `weixin.ctxTtlHours` (默认 10h) 换成 `weixin.ctxTtlSec` (默认 120s): 真机上人说话 ~10 分钟后的定时提醒, sendmessage 照样 ret=0 带 message_id, 微信里却收不到 (人刚开口十几秒内发的都到); 社区 #286 实测 73s 能发、135s 不行。超过它的出站不再发出去石沉大海, 而是压着、往企微报一声、对方下次开口时补发; `notify` 对这类微信群聊回 `held` 与说明, 不再回「已发送」。
- 微信扫码绑定扛 reload: 在途的绑定 (二维码、轮询地址、发起的聊天) 落盘到 `<weixin.stateFile>-logins.json`, 开机按它续轮询扫码状态, 进度照旧推回发起的聊天 —— 此前绑定只在内存, 人扫码那一两分钟里 daemon 一 reload, 手机上显示已连接、本机却没拿到 bot_token, 账号表为空, 微信里说话无人应答。配对码不落盘 (续上后若要码, 重交 `/wx code`)。
- 微信 ClawBot 通道 (上面那条) 的评审缺陷: 分流层改装在 last-response tracker 里面, 空消息 gate 与引用去重覆盖微信, tracker 只对微信 chat 不等企微长连接; mirror 对微信帧不挂 hardTimer (不再多发「仍在处理中」/ 光链接, 白占出站额度)。审批 / 提问 / 计划 / `/message` / `/card` / `/ask` 的「送得到吗」改问 `reach.ts` 按聊天判 (微信 chat 看自己的号), 企微 WS 断着时微信里的审批卡照出。收发等入站监听全装好再开 (`wx.start`), reload 期间的消息不再在游标前移后丢掉。`message_id` 等 uint64 无损解析, 去重不再误判。outbox 发出一段才摘一段 (reload / 掉线打断不丢), 超时重发沿用同一个 `client_id`; 被拒收的一段第一次当 token 过期压着、换了新 token 仍拒就丢弃并报企微, 不再永久卡住队头; 别的 4xx 不再当网络错 30 秒一重试; outbox 封顶 50 条 (先丢老正文, 卡片留着)。用掉最后一格额度的那条挂「额度用完, 回一句取回」, 额度用完时压着卡片会报企微。`-14` 不再停轮询: 整号歇一小时再试, 收得到即复活; 重扫回 `binded_redirect` 时叫醒掉线的号。卡片在别处了结 (超时、CLI 先答、⏱ 窗口、`/ask`) 后不再吞人回的数字, 拿不准答哪张 (多张待答没带短码、短码对不上) 照常交给 wizard; 同一 task_id 重发不留重复条目。二维码状态轮询每轮歇 1s; 配对码被接受 / 二维码刷新后清掉, 在途时新交的码不被误清。`send_file` 的 caption 先发完再发文件, 文件也守 `minGapSec`。「正在输入」开关串行化, 压着时也关。同号重绑 / 掉线 / 解绑清掉旧定时器, 定时器取较早的那一刻。`/wx/list` 也要口令; 终端 / 持口令进程的 `POST /wx/bind` 先推确认卡给审批人, 点了才出二维码。能发起绑定的人: `approval.approvers`, 空则 `defaultChat` (是个人时), 再不然 `allowFrom` 里的 `user:`。
- spawn 拼启动命令时 `shQuote` 只给含空白 / 引号 / `$` / 反斜杠的参数加引号, 通配符原样外露: `wrc.extraArgs` 新默认值里的 `mcp__claude_ai_Claude_Docs__*` 在 zsh 下 "no matches found", 整条启动行失败, 新起 / 重生 / 克隆的 wizard 的 pane 立刻落回 shell。改成白名单 (只有 `[\w@%+=:,./-]` 组成的参数不加引号, 其余一律单引号包裹)。
- rolepage 不再有「未知」role: 认不出是谁的发话方 / 听话方 (群里没记下 speaker 的人话、没署名的同伴行、认不出的回执听话方) 一律归系统 role `wezard` (`system:`), 不再另立 `human:` 这个「未知」—— `senderOf` / `audienceOf` 的兜底改成 `SYSTEM`, 名册 `nameOf` 去掉「未知」, 老链接里的 `role=human:` 解析成 `system:`; 守护进程写进回执信封的听话方照旧是「认不出 = 空」。`wezard` 的头像改成 🧙‍♂️, 名字用紫金渐变 (`--wezard` #6b3fa0 → `--wezard-gold` #9a6a00, 文字裁剪渐变, 不支持时退紫色)。侧栏、关系图、消息行与搜索同一份 `kindOf` / `nameOf`, 「说给谁」不标的那一方从 `human:` 换成 `system:`。
- rolepage 未读归属: 一句未读只要在某一项点开后的详情里看得见, 就只记在这一项的红点, 不再挂到名字旁 —— 此前名字旁 (`peerUnread`) 只减去红点在数的那几句 (页面视角的未读), 这一项主人自己的未读即使就在这一项的详情里也被算成「切过去才看得到的」, 点开这一项一上屏就从名字旁消失。现在服务端给每一项一份账 (`ledgerOf`), 按点开它看到的消息 (`windowOf`, 与详情区取消息同一个函数) 切成不相交的两份: 红点 = 这里看得见的未读 (页面视角的 + 这一项主人的), 名字旁 = 主人在这里看不见的; 群这一行并上它各子项的, 子项不会大过群。侧栏会话项 / 子项 (含与我无往来的) 与关系图卡片 (`/api/glance`) 同一个实现, 未读判定收成一份 `unreadIndex` (去掉 `pendingOf` / `unreadByRole` / 摘要的 `peerUnread`); 基线前的与已落盘的已读由服务端先筛掉, 不再下发 `seen`。关系图卡片的账随看的 role 缓存, 换视角后不再借用上一个视角的。
- 写错模型的分身此后每次 respawn 都要多起一次: 兜底后记进 mirror store 的还是 CLI 不认的原始串, respawn 照它带 `--model` 再败一次。现在 spawn 返回、`newSession` / 两条 respawn 路径写回的都是**真落地的模型** —— `--model` 认了就是原值, 走选择器选中就是那一行的 id (`最新的 opus` → `claude-opus-5.5`, 不再是标签), 没选上就是选择器里打 ✔ 的那一行 (`hy4-preview-ioa`), 都读不到才记空 (CLI 默认)。`set_model` 同样记 id。
- `/model` 选择器失败的报错不再一律伪装成「读取失败」: 原先 【id】 渲染下按光标逐行找首个沾边的行, 没有绕回检测, 对不上时必烧满 60 步 (~21s) 再把读到的目录整个丢掉 (`catalog:[]`)。现在整张目录先从首屏读 (32 项一屏放得下), 对不上才绕一圈 (回到起点即停) 防窗口化; 在**整张目录**上挑最接近的一行 (不再是光标先碰到的那一行), 再按 id 走光标过去。失败原因分开报: 选择器没出现 = 目录没读到; 开了但一行没认出 = 渲染变了; 读到 N 项没有匹配 = 列出要找的、拿来比的词和整张目录; 匹配到了但光标没停上去。另认得 2.143 新起 pane 后的第三种回执 `Switched this session to X.` —— 原先切换已生效却被判成「没等到回执」。
- 管家手闸堵上 Bash 写文件缺口: `Edit` / `Write` 被拦后模型绕到 `sed -i` / 输出重定向 / `tee` 改文件, 原先只按 look 计每轮预算; 现在这类 Bash 一律判 hands 直接拒, deny reason 说明「sed -i / 重定向 / tee 也算」。`>&2` / `2>&1` / 重定向到 `/dev/*` 不写工作区, 放行; 引号内出现 `> ` 或 ` -i` 可能误伤, 管家场景宁严勿宽。宪章管家段同步一句。
- 修 codebuddy 下 `/new` 必烧满 16.5s 才报就绪: `hasRegistry` 误把 codebuddy 的 `sessions/` 目录当可用注册表 (2.143+ 也写 `<pid>.json` 但无 `tmux`/`status` 字段) —— 改为至少一行解析成功且带 `tmux` 字段才算数; `waitForTuiReady` 同步加退路, 注册表认不到这个 pane 时回到读屏判据, `awaitSession` 顺带不再白等 15s 兜底。其中 `spawn-tmux.ts` 一侧的退路已随 4027448 提交, 本次只补 `cc-session.ts` 一侧。
- 修新 spawn / clone 出来的分身永远接不到活: 配置里写明的确切 id 原先要等 transcript 里见过才肯带 `--model` 启动 (`exactModelId`), 全新会话一条 sighting 都没有, 于是掉进 `/model` 选择器; 而当前 codebuddy 的选择器换了渲染 —— 标题带 Global / Session 两个 tab (`Select Model   Global   Session  (Tab/←→ to switch)`), 每行是 `标签 【id】 (xN credits)` 且不再编号, 页脚 `Enter to apply model · Tab to switch scope · Esc to exit`, `parseFrame` 的 `Select model` 表头与 `Esc to cancel` 页脚都对不上, 报 "picker never opened" 之后又没按 Esc 收场, pane 停在那个 modal 上, 首条任务 paste 落不进输入框 (日志 `输入框确认为空` / `submitted without paste verification`), 分身就此沉默。现在: 写成 id 形态的 (一个 slug、带版本号, 如 `claude-opus-5.5` / `deepseek-v4.1-flash` / `kimi-k3-ioa`) 直接 `--model` 启动, 不必先被见过; `parseFrame` 认得新渲染 (按 【id】 读行, 由标题下那句话判现在停在哪一档), 选模型先按 id 精确匹配再走光标 (列表会绕回), 按 Enter 前先把 tab 切到要的那一档 —— 切不到就 Esc 退出并说明, 绝不把「仅本会话」写成全机默认; 放弃时一律 `dismissPicker` 按 Esc 把 pane 放回可输入状态, 失败只是「停在默认模型」而不是「损失一个 wizard」。顺带不再把 `haiku` / `sonnet` / `opus` 这些别名原样传给 `--model`: 本机 API 不认, `--model sonnet` 直接 `400 model [sonnet] service info not found`, pane 起不来。


## [2.4.1] - 2026-10-04

### Added
- rolepage 名字旁显示他人未读: 数字 = 点名字切到那个 role 视角后看得到的全部未读 —— 服务端 `unreadByRole` 按页面未读基线给每个 role 一份与侧栏会话项同口径的账 (会话窗口抽成 `convWindowOf` 共用, 按消息 id 去重), 随摘要下发 `peerUnread`; 侧栏会话项 / 子项 / 远端子项与关系图卡片共用 `theirsOf` 一处点数。
- 群况快照 (notices roster `mode=full`): 长住 wizard (没有 parent 的) 的注入尾巴在近 10 次注入窗口里没给过时挂一份 CSV 群况表 (`name,state,job`), 列管家、长住有职责的、管家生的与收件人自己生的; 忙闲取注册表, 不抓 pane。交接 / `/clear` 后的头一条必带 —— 此前名册 reminder 只报变动且分身生收已收窄, 管家与长住 wizard 几乎收不到。
- 顶层模式门控 (`daemon/top-only-nudge.ts`, 配置 `wrc.mirror.topOnlyNudge` = `{windowMin: 30, threshold: 6, cooldownH: 24}`, 窗口或阈值为 0 = 关, 热生效): 没开顶层模式的群里, 每条 wizard 间公开气泡 (公开的 `tell_peer` / `dispatch`, 一次 = 派活气泡 + 它的回复进群) 计一次, 窗口内达到阈值就往该群管家 (群默认会话) 的信箱挂一行 —— 最近 N 分钟有 M 次 wizard 间公开往来, 人下次说话时顺带问要不要开, 附 `config_set` 的写法。随下一次注入到, 不另起一轮、不发气泡。同群提醒过后 `cooldownH` 小时内不再提, 计数与冷却落盘 (`~/.wezard/top-only-nudge.json`) 扛 reload; 已开的群不计。

### Changed
- 宪章守卫抽成共用实现 (`guardCharter`): `config_set` 写前写后渲染宪章比对、变了的挂 handoff 提醒, 人 `/name`、`name_chat`、自动补名这些聊天名写入点也走它; 人发起的改动提示「交接之前仍按旧规矩汇报」。
- rolepage 侧栏「列表」选项改名为「聊天」。
- 管家宪章不论本群开没开顶层模式都带一行「顶层模式」: 关着时一句话讲它是什么、本群关、开法 `config_set({path:"chatPolicy.<聊天名>.topOnly", value:true})`; 开着时只给关法 (规矩仍在「本群开着顶层模式」一节)。此前没开的群的管家不知道这个概念。
- `config_get` 读 `chatPolicy.<聊天名>…` 时先换成它指向的 principal (同 `config_set`), 不再一律显示 `—`; 记录里没写的项显示 `— (没写, 按默认 X)`, 默认值取记录值类型的默认 (原先显示 `—` 且误标 `*`); `chatPolicy` 下附依据: 查整张表列写过策略的聊天 (名字 = principal · 顶层模式开/关) 与没写的个数, 查某个聊天只列它。

### Fixed
- 终句里引用 `<system-reminder>` 原文不再被掐掉中段: `parseTurns` 剥 meta 只对 user 行做 (assistant 在行内代码写开头标签、代码块里写结尾标签时会从头吃到尾); `parseClosing` / `lastAssistantText` / 回执的「它最后说的」改用 `clipMiddle` 超长掐中间, 切口落在代码块里时补齐 fence。
- rolepage 未读口径与跨视图已读同步: 红点只数点开这一项看得到的 (服务端 `pendingOf` 按窗口、看的 role 与开口水位算出带消息 id 的可能未读); 已读全局只一份 `SEEN` (消息 id → 上屏时刻), 片段在可见详情区上屏才记, 与页面视角 / 详情视角 / 侧栏 / 关系图无关, 记下即重画两边; 去掉按视角分账的 `READ`。
- AskUserQuestion 在企业微信作答后, CLI 不再显示红色 `PreToolUse:AskUserQuestion hook error: wezard: User answered "…" via WeCom`: hook 改回 `permissionDecision: "allow"` + `updatedInput` (原入参加上 `answers`, 键为题目原文, 多选按 Claude Code 的编码以 `, ` 连接、含 `, ` 或 `"` 的 label 用 JSON 字符串包起来), Claude Code 认它为已作答, 不弹本地面板, 工具照常落地, 模型拿到正常的 tool_result。daemon 回包新增 `updated_input`, hook 用 jq 拼进 `hookSpecificOutput`。「先聊聊」仍是 deny, 「去 CLI 处理」/ 空选 / 超时 / 断线仍是 ask; codebuddy 的镜像流 (`runMirrorAskqFlow`, 驱动失败后迟到的 hook) 还是 deny + reason, 因为没核实它认不认 `updatedInput`。

## [2.4.0] - 2026-10-03

### Added
- 群管家手闸 (`daemon/steward-guard.ts`, 群聊级配置 `chatPolicy.<chat>.stewardBudget`, 默认 4, -1 = 关, 热生效): 管家 (群的默认会话, 跑 `models.router` 那档轻模型) 宪章说分派、实际常自己埋头干。守护进程在审批链最前面拦它 —— `Edit` / `Write` / `MultiEdit` / `NotebookEdit` / `Agent` / `Task` 一律拒; 读 / 搜 / 跑命令等每轮 (按 turn store 的当前轮) 最多 budget 次, 超了拒; wezard MCP 与 ToolSearch 等元工具不计。deny reason 直接写改道说明 (`dispatch`), 放行窗口 / allowRules / skipAll 都压不过它; 宪章管家段同步一行。
- 闲置追问 (`daemon/idle-nudge.ts`): 派出去的活 (有回执在等的 `tell_peer` / `dispatch`), 对方持续闲着 (没在忙、没停在审批卡上、没在交接) 又没交回结论, 满 `wrc.mirror.idleNudge.afterMin` 分钟 (默认 5, 0 = 关, 热生效) 守护进程就代发话方同件号追问一句「进展如何 / 卡在哪」, 答复照常作为那件活的回执回去。只追问 `working` 的件 —— 反问中 / 挂起等子活 / 报过错 / 停在审批上的不问; 件落定、工单收了即停。一忙或锚变了 (续问 / 新一句) 就从头计, 问后再满一整段才可再问, 同一件至多 `idleNudge.max` 次 (默认 3)。追问由 `receipts.reask` 重新登记, 工单 / 频道 / 父 k / 链头 / 期限沿用原件 (不续期)。已问次数落盘 (`<stateDir>/idle-nudges.json`) 扛 reload, 闲置时长只在内存、reload 后从头计。
- 按任务难度分档的模型: 配置新增 `models.tiers` (`light` = haiku·low / `standard` = sonnet·medium / `hard` = opus·high, 每档 `{cli?, model, effort?}`) 与 `models.router` (各群管家 = 群的默认会话新起时用的模型, 默认 sonnet·low)。`spawn_wizard` / `clone_wizard` 新增 `tier`, 显式给的 model / effort / cli 压过档位; 克隆换不了 CLI, 档里的 `cli` 被忽略并在返回里注明; 返回带 `tier` 与每项来源 `via` (explicit / tier / inherit), 档位记进 wizards.json。router 只在守护进程新起一个群的默认会话时生效 (首条消息、`/new`), 死 pane 重生沿用绑定里的模型, 已在跑的管家不动。宪章里「要判断的给 opus、跑腿的给 haiku」改成按档选, 并列出当前各档。
- `config_get({path?})`: 由 `ConfigSchema` 驱动的渐进式披露 —— 不给 path 列各节一行说明, 给了就列这一层子项的类型、当前值、默认值、说明, 标出 ✋ (改动要人确认)、↻ (需 reload) 与 * (不同于默认)。说明取自字段的 `.describe()`, gate / apply 由 `shared/config-meta.ts` 的 `knob` 标在 schema 上并沿树继承, 热生效逐项核实过。`models` 下附各档模型的本周 / 今日用量 (按模型统计) 与名册里记作该档的 wizard 数。
- 挂起事项表 (`daemon/pending-items.ts`, `~/.wezard/pending.json`, 配置 `wrc.mirror.pendingFile`): 每次 `tell_peer` / 带 task 的 spawn 由守护进程记一行 —— 件号、对象、一句话题、为谁派的 (父 k: 群里哪句人话 / 上游哪件)、链头; 状态不靠模型报, 在飞的从回执登记现算 (working / blocked / deferred), 落定由回执的 `onOutcome` 写一次。NEED 回执挂「等人拍板」(为上游 wizard 派的挂「它在反问」), 人在那件活的群里再开口记「人已回话」; `re` 续问或同一对改派消掉, done / 工单收工 / 自己收掉的关掉, 没结论的 (timeout / silent / dead / 别人收掉) 留着直到改派或显式 `drop`。提醒只给管家 (群的默认会话), 搭 notices 的注入边界、另起 `wezard="pending"` 的 reminder: 平时只挂必要的一行 —— 某件刚变成等人、人开口时「这句可能在答哪件」、某件派出 / 续问后 30 分钟还没回执; 「快忘了」才给一次全表 —— 会话换过 (交接)、`/clear` 或压缩 (`onContextCut`)、离上次全表 15 次注入或 ctx 涨了 80k、某件 2 小时没动静。新工具 `pending_items({drop?, why?, name?})` 读全表 / 显式消项, 读一次算刚给过全表。
- `dispatch({task, name, description, tier?, to?, spawn?, force?, lead?, public?, deadline?, dryRun?})`: 管家派活一步到位 —— 查候选 (同 `route_candidates`) → `route.decide` 给默认决定 (证据够强、不忙、划算、过得了冷门控的头一个候选转给它, 否则白板 spawn; 档位默认 lead→hard、一句话小活→light、其余 standard) → 以调用方名义 `tell_peer` 投出去 (默认公开), 回 `decision` / `reason` / 件号与落到的模型。推翻默认要显式: `to` 点名、`spawn:true` 硬要新的、`force` 越过冷门控、`tier` 换档。`tell_peer` 与 `/wizard/clone` 的处理抽成 `tellPeerAs` / `bearAs` 供它复用, 行为不变。
- lead 组队: `spawn_wizard({lead:true})` / `dispatch({lead:true})` 生出的 wizard 记 `lead`, 宪章多一节「我是这件活的 lead」—— 开工单、coder 按需 clone / spawn standard、reviewer 必须 `spawn_wizard({tier:"hard"})` 白板起步不带作者上下文、打回与收队的时机、只在关键决策与交付时对人说话; `dispatch({to, lead:true})` 让已有 wizard 当 lead 时, 这一节随派活文本带过去。
- 顶层模式 (群聊级配置 `chatPolicy.<base principal>.topOnly`, 热生效; 键只认确定的聊天 id —— `config_set` 写聊天名会换成它此刻指向的 principal 落盘, 认不出的拒写): 人在这个群里只和顶层 wizard (群管家 / 人 `.name` 点名的) 对话, wizard 之间的往来一律私聊。守护进程强制 —— `tell_peer` / `dispatch` 的 `public` (含 `re` 沿用的公开频道) 降为私聊, 回包带 `topOnly` 一句; 这一轮在为同伴干活 (同伴私聊派来的活, 或为上游同伴派出的子活的回执轮) 的 wizard `notify` 进该群被 409 退回 (管家在自己的群豁免; 人说的、定时任务、`chain:false` 旁支的回执轮不拦)。宪章随之换口径: 新增「本群开着顶层模式」一节, 管家的 dispatch / lead / 收口条目与 lead 的「对人说话」改为由顶层代为解释、子 wizard 以 `RESULT:` / `NEED:` 交回上游。
- `config_set` 落盘时判断改动是否动到宪章: 改前、改后 (reload 项把新值同步换进活的 cfg 渲染一瞬) 各渲染一遍有会话的 wizard 的宪章, 按 `## ` 段比对 —— 不靠字段清单, 任何进宪章的配置都覆盖。宪章里自认是出生快照的档位行不参与比对 (改 `models.tiers` 不叫全员 handoff); 只比 pane 活着的。受影响的在回包里点名 (含变了的段); 调用方自己受影响就直说这一轮收尾后 `handoff`, 其余各挂一条提醒随下一条消息到。
- `models.tiers` 加两档, 由轻到重 `mini` / `light` / `standard` / `hard` / `ultra`: `mini` = 机械一步 (默认 haiku·low), `ultra` = 最难的架构取舍 / 疑难排障 / 关键评审 (默认 opus·max)。`spawn_wizard` / `clone_wizard` / `dispatch` 的 `tier` 枚举直接取 `TIERS`; `dispatch` 的默认档不变 (lead→hard、小活→light、其余 standard), 两头只能显式给。宪章档位行改为按轻→重逐档列出当前落点, 常用三档各挂一词用途, 篇幅不增。
- 金字塔第 7 步 (闸口 / 搁置 / 取消 / 重试冒泡): 需求根单 (`dispatch({lead:true})` 开的) 落盘 `gate` (g1 带验收标准派下去 · g2 owner 答了 lead 的 NEED · g3 归档)、`hold`、`nudge`、`end`; `close_job` 加 `as: accept|cancel|shelve|resume` —— `cancel` 关单并回收整棵子树 (留档标「取消」), `shelve` 不关单只停提醒 (阶段 `shelved` / rolepage「搁置」, 挂起表有「搁置的」段), 给 lead 派新活 (`task`) 自动恢复; 交付后没人验收, 守护进程以群默认管家的名义往原群发提醒 (4h → 1 天 → 2 天, 之后每 2 天, 只在 09–21 点, 人 30 分钟内刚说过话的群顺延, 同群合成一条、不带单号), 同时往管家信箱挂一行带单号的; 人在该群开口时管家增量里挂 `heard? accept` 提示。

### Changed
- **keepalive 默认关闭** (`wrc.mirror.keepalive.enabled` 默认 `true` → `false`, 热生效): 保温是为 API 默认的 5 分钟 TTL 设计的, 而 Claude Code 订阅的主线程写的是 1h 缓存 —— 本机实测 1490/1491 个主会话只写 `ephemeral_1h` (opus / sonnet / haiku / fable 都一样, 只有 Task 子代理写 5m), 相邻请求隔 6–60 分钟的 230 次里 229 次整段命中, 超过 65 分钟 0 次。一小时内的空闲本就不冷, ping 只是多塞模型轮次。transcript 写 `ephemeral_5m` 的环境再打开。
- keepalive 按缓存真实被碰的时刻计时 (`cacheAt` = `peers.cacheTouchMs`, 与路由同一口径; 原先用最后一轮写完的时刻), 且缓存闲置超过 10 分钟 (`KEEPALIVE_MAX_IDLE_MS`) 就不保温 —— 1h 缓存的 ping 要到闲置约 59 分钟才打, 那段空闲 TTL 本身已盖住, 于是实际只有 5 分钟缓存会被保温。
- 缓存冷热按真实计时起点判断: 路由 (`route_candidates` / `dispatch`) 与 `tell_peer` 冷门控 / 唤醒提示不再拿 transcript mtime 当缓存最后被碰的时刻, 改用 `peers.cacheTouchMs` —— 最近一次已应答请求的**开始** (它前面那行 user / tool_result; TTL 从请求开始起算), 读不到才退回 mtime。mtime 是响应写完的时刻, 实测比请求开始晚 p99 59 秒、最长 396 秒, 还会被不碰缓存的元数据行推动, TTL 边界附近会把已冷的判成热。`RouteRow` 加 `cacheAt`。
- 宪章按金字塔层级改写: 管家段 (L1) 改成「需求 / 交付与验收」两条 (判新单还是续篇、复杂活 `dispatch({lead:true, criteria})` 开根单、对人不带单号、人说好 `close_job` 归档 / 说不对 `re` 给 lead 返工), lead 段只留层级规矩 (对上 RESULT 单列「取舍 / 遗留」、对下带 `job` 的 task 只发自己单的成员且成员间只 `ask` / `fyi`、直接成员 ≤5 与深度 ≤3); 组队打法拆成 `renderLeadPlaybook`, 随派活信封带 (新生 / 克隆 lead 的第一句、已有 wizard 当 lead 的那句), 不再进出生宪章。管家 / lead 宪章各少约 200 / 470 字符。
- 注入尾巴上的 `<system-reminder>` (mention 点名 / roster 名册变动 / pending 挂起事项) 去重并压缩, 开标签属性一律不变: ① 每个 pane 记「近 10 次注入挂过哪些提示」(`notices.SeenRing`, 落盘 `~/.wezard/notice-seen.json`, 配置 `wrc.mirror.noticeSeenFile`, 扛 reload; 换 sid、/clear、压缩、新宪章即清零) —— 窗口里介绍过的 wizard 只列名字, 同一行变动不再重复, 各段的规矩只在窗口里没给过时挂一行英文。② 名册变动改为结构化事件 (`Notice`), 渲染成一行 logfmt (`born .x by=.p clone job=… cwd=…` / `ended` / `renamed` / `job` / `chat` / `note`), 不再带模型、effort、keepalive, 工作区与收件人相同就不提; 两次注入之间生了又收掉的净值为零不报; 非 detached 的子 wizard 的生 / 收只告诉生它那位与往上的家谱, 回归测试的临时分身不再刷别人。③ mention 每行改为 `.x job=… [chat=…] [cwd=…]`, 去掉 target key 与地址; pending 增量行改为 `need` / `heard?` / `slow` 短行, 怎么接写进一次性的规矩行。估算: 一条点名 + 12 行 rr 生收的消息尾巴约 810 → 125 tok, 窗口内再点名同一个 256 → 30 tok, 名册单行收工 121 → 23 tok。
- 宪章「我是这个群的管家」改为以 `dispatch` 为主路径: 默认决定照办, 推翻要显式 (`to` / `spawn` / `force` / `tier`); 复杂活 (要 coder + reviewer、来回几轮) 交给一个 hard 档 lead, 管家与人都只面对它; 直接拆给多个 wizard 只限彼此独立、不同领域的子活; 挂起的事由守护进程记。工具表加 `dispatch` 与 `pending_items`。
- `config_set` 改为 `{path, value, op: set|add|remove|unset, dryRun}`, 不再是 11 个 key 的枚举: 整份配置 (叠 secrets) 过 zod 才写, 经 `config-writer` 落盘保留注释, `dryRun` 回改前改后与 jsonc 行级 diff; 热生效项写完即装进活的 cfg。分级: `bot.*`、口令、secrets.json 里出现的路径不可读写; 放权项 (`wrc.allowFrom`、`approval.*`、`claudeBin` / `cliBackends` / `extraArgs`、`sync`、监听与外送地址、`defaultChat`) 由**守护进程自己**推确认卡, 人点了才落盘 —— 不经 hook, `danger.skipAll` 也压不过; 卡在请求里等 4 分钟, 之后回 pending, 迟到的确认照常落盘并捎给调用方。hook 与 `selfConfigWriteOf` 不再拦 `config_set` (否则一次改动两张卡)。老 MCP 进程的 `{key, value, action}` 映射到对应 path, 走同一条路。
- `tell_peer` 冷门控: 派新活 (`kind:"task"`、不带 `re`、`priority` 不是 `now`) 给缓存已冷 (超过 TTL 没动) 且 ctx ≥100k 的 wizard 时先不投递, 409 退回一行「.x 冷 · ctx Nk · 唤醒约等于白板 spawn 的 M 倍; 真依赖它的上下文就带 `force:true` 重发, 否则白板 spawn」(`gated:"cold"`)。冷热与倍数与 `route_candidates` 同一口径 (`wakeCostOf`)。MCP 新增 `force` 且一律显式带上; 请求里没有这个键的老 MCP 进程, 同一对 10 分钟内原样再发一次即视为 force。宪章里「点名 / 职责对口就直接判断」的捷径改为: 那只说明相关, 成本仍看 ctx 与冷热。
- handoff 时机提前: 交接不是压缩, 判断线从窗口七成改为 `min(200k, 七成)` (`handoffAt`, `wizard_whoami` 的 `handoffSuggested` 随之), 宪章「自我管理」改写为过 200k 就判断 —— 手上这摊告一段落、或往后的活不再依赖前面的材料, 就交接。越线后下一条注入的消息捎一次提醒 (复用 notices 的 probe, 每段会话一次)。
- 宪章精简 (约省三成, 管家宪章 6.4k → 4.4k 字符): 删掉守护进程已强制 / 自动处理、或信封每轮都会说的话 —— 管家节「没点名的话落到你这儿」与 dispatch 的内部机制、「怎么说话」里按 ask / 回执 / fyi 逐条讲的终句路由 (压成一句)、「看信封」「私聊轮一停下自动送回」「收到回执不必回话」、编排里的撞名 409 与「别拼 key」(回包与工具描述已说)、记忆节的提交说明; 开头导语与「我是谁」不再复述工具清单, 职责 / 换目录 / 记规矩各只留一处。每个工具仍有一行「何时用」, 顶层模式的规矩不动

### Removed
- keepalive 的卡死续跑 (`wrc.mirror.keepalive.resumeOnStall` / `resumePing`, `peers.transcriptStalled`): 上一轮死在 API 报错 / 工具结果没人接时, 保温 tick 改发 `continue` 把它续上。整块删除; 配置里残留的这两个键被 schema 忽略。

### Fixed
- 名册变动 reminder 仍把一批临时分身刷到不相干的 wizard: 子 wizard 的生 / 收原先告诉「生它那位与往上的整条家谱」, receipt-regress 的 rr-root 是跑测试那位的 clone, 于是每个 rr-* 的生收都上溯到它、它的父辈直到群管家, 而 born / ended 分在不同次注入里, 净值抵消也够不着。改为纯函数 `notices.hears(subject)` 按注册表判断收件人: 没有 parent 且写了职责的长住 wizard 告诉同群全体; 有 parent 的只告诉 parent 与它所在的开着的工单的发起人 (不上溯家谱); 既无 parent 也没职责的 (还没自我介绍的会话、forget 后残留的冷记录) 谁也不告诉, 写下职责的 `job` 事件才算登场。同一模板的几行 (同一位收掉的一批分身) 并成一行 `ended .a .b .c …(+N) by=.p forgotten`; 去重仍按单条记进已见窗口。
- 私聊轮的终句漏进人的群 (终句归属按「这一轮在为哪件 ask 服务」由守护进程推定): ① fork 分身 (`clone_wizard` 继承上下文) 的第一轮只有出处、没有频道印章, 退回 home 群 —— 带 task 的私聊派活与不带 task 的自报家门都进了群 (实测 .irisfit-coder 10-03、.eff-d 10-02); 开场白一律私聊, 且出处是私聊派活 (非公开、非回执) 的一轮不论印章如何频道都是 `""`。② 回执轮的频道只由去向定: 只有父 k 是人在群里开的那一轮、兄弟都落定时才进群, 其余 (没有父 k 的 `chain:false`、中途的 NEED / error、上游那份已被取走) 一律私聊, 不再沿用子活当初 `public:true` 的频道。③ 同一对 wizard 的第二件活不再顶掉第一件挂起 (等子活) 的那份: 它按件号停放, 子活回来时那一轮的终句仍作为第一件的回执回到上游 —— 不是「这一对最后一件」。④ CLI 把几句排队的话并成一行时, 其中有人从聊天说的那句就归它, 它的轮次与气泡才会收口。交接重开时欠着的公开派活在出处上标 `public`。宪章「怎么说话」改为 ask / 回执 / fyi 三类与归属规则。receipt-regress 新增 `route-fallback`、`same-pair` (纯单元, 直接驱动 `createReceipts`, 不生分身) 与 `clone-private`, 修前皆复现失败。
- 终句归属的余下几处 (白板审查补出): 私聊轮 (频道 `""`) 里派出的活不再得到 chat 父 k —— `parentOf` 原先拿 `channelOf` (把 `""` 回落成 home) 求值, 没挂信封的私聊轮派的活回执会续回 home 群; 同一对的新一件来时, 上一件虽还没被认出「已派」、但已为它派了子活的也按件号停放; 新一件不再继承挂起那份的工单 (否则它先落定就把成员记成完成, 停放件的真结论不计数); 打回注入失败时按件号找回那份; 停放行收尾后照常留到保留期, 过期行开机时从 receipts.json 抹掉。交接时守护进程请它写简报那一句、以及自我交接重开后「接着干」那一轮不再不带频道 (= home 群): 前者私聊, 后者沿用交接那一刻这一轮的频道。CLI 把排队的几句并成一行时, 里面有私聊那句整轮就按私聊 (答复不跟着人的话进群), 人那句预建的气泡收口成一个详情链接, 不再挂到超时。receipt-regress 新增 `same-pair-early`, `route-fallback` 加验私聊轮的父 k; 两处修前在 HEAD 版 receipts 上复现失败 (`RR_RECEIPTS` 可指向任一版 receipts 模块跑单元用例)。
- 最后两处不带频道的注入: `run_agent_graph` 的每一步与进度播报跟随发起这次 run 那一轮的频道 (人在群里叫它发起的才进群, 私聊轮里发起的整场只进 rolepage), 原先步骤落进节点的 home 群、播报进发起者的 home 群; `.claude/**` 原生确认框代按失败后告知会话的那一句跟随被取消那一轮的频道。交接时欠着多份回执不再并成一句 (只按第一份定出处与频道、各上游拿到同一段): 简报那一轮只挂第一份的信封, 其余每份等上一轮答完再各开一轮、带各自的信封与频道, 各自按件号续回自己的上游。receipt-regress 新增 `graph-private` 与 `handoff-owe` (实测), 修前皆复现失败。
- 回执在长轮上误判 `silent`: 答话方那一轮的工具输出 (读大文件、跑命令) 让 transcript 涨过 2MB 时, 问话被推出尾巴的读窗 (`TAIL_BYTES_MAX`), `replyToPeer` 一直定位不到它 —— 对方停下之后连着三个 20s 的 ramp 都「静着、问话不在」, 扑空三次就报 `silent`, 真结论没送回去 (.routerx 答 .wezard 的 t289268, 问话离尾巴 2.2MB)。找问话改为按发话时刻往回读 (`turnsSince`: 读到越过发话时刻的那一行为止, 不设上限), 交接时的 `replyClosedBefore` 同理; 「这一轮是谁开的」(`openingTurn`: 父 k、链头、打断是否误伤) 也改为往回读到开轮那句为止, 不再只看最近 80 条。回归脚本加 `long-turn` 用例 (对方睡着时往它的 jsonl 追加 2.5MB 填充行), 修前 FAIL (silent)、修后 PASS。

## [2.3.0] - 2026-10-03

### Added
- `scripts/commit-own.mjs`: 多个 wizard 共用工作树和 git index 时只提交自己的改动 —— `<path>…` (这些文件的工作树全文) 或 `--patch <file|->` (只含自己 hunk、对 HEAD 带上下文的补丁); 在私有 index 上从 HEAD 拼树, 提交出的树先过 tsc, `update-ref` 对 HEAD 做 CAS (别人中途提交就重放), 落地后只同步共享 index 里仍停在旧 HEAD 的项, 工作树不动; 提交里有而工作树缺的内容会点名。工作区记忆里五条手工拼提交的步骤收成这一个命令。
- rolepage 用量条在模型名旁显示 effort 档位: 取 CLI 写在 transcript assistant 行上的 `effort` (随 turn 记录, 主会话最近一轮为准), 没有才用绑定里记下的档位 (`WorldFactWizard.effort`), 都没有就不显示, 不猜默认。
- wizard 启动带上 model 与 effort: `spawn_wizard` / `clone_wizard` 新增 `effort` (low / medium / high / xhigh / max, daemon 校验), 启动即 `--effort`; 档位记进绑定 (`mirror-attachments.json` 的 `effort`), 死 pane 重生、`/new`、交接重开都沿用, 分身默认跟被克隆者同模型同档。模型名能确切对上时 (本机 transcript 里 API 真答过的 id, 或与之同家族同版本的列表标签如 `Opus 5.5`) 直接 `--model <id>` 启动, 省掉 `/model` 选择器那一来回; 口语写法 (「opus 最新」) 或没见过的 id 仍走选择器。`set_model` 新增 `effort` (model 可省): 走 `/effort` 档位条的「只本会话」键 —— `/effort <档>` 会顺手改掉全机默认, 不用它; 档位条没有这一键就不切。codebuddy 不传这两个参数。`wizard_whoami` 带 `effort`。
- `tell_peer({kind: task|ask|fyi})` (B4 ④): 对方该怎么接这句话 —— 与 `priority` (何时投)、`receipt` (要不要回执) 正交。`ask` 信封加「只答这一问, 别为它开新活」; `fyi` = 知会: 强制不要回执、不进工单 (带 `job` 回 `jobIgnored`)、不进群, 信封改口「不收回执 / 不用回复」。
- 按件号撤回, 打断不误伤别人的活 (B4 ⑧): `stop_wizard({mode:"interrupt", turn})` 只撤回调用方自己派的那一件 —— 它此刻正做的就是这件才按 Esc (不清它的注入队列), 还排着 / 在做别人的活就只把这件记成 canceled, 并经名册增量捎它一句「不用做了」。不带 `turn` 的打断, 若它这一轮是别的 wizard / 人 / 定时任务的 (回执轮算它自己的), 默认 409, 要 `force:true`; `tell_peer` 的 `urgent` 同样情形降成 `normal` (回包 `urgentDowngraded`)。回归脚本加 `cancel-turn` 用例。
- 工单验收, 不合格自动打回一次 (B4 ⑦): `open_job({accept})` —— `result` (默认) 要有非空 `RESULT:`, `artifact` 还要列出 `ARTIFACT:`, `none` 不验。成员的 done 答复不合格时守护进程以发话方名义同件号续问打回一次 (私聊, 不占 `maxTurns`), 那一份不投、不计数; 再交上来的照收 (原样再交、或打回那句因 reload 没注入, 都按原文收下, 不报 silent)。**默认对所有工单生效**: 没写 RESULT 的成员会多跑一轮。回归脚本加 `accept` 用例; 脚本每次运行给分身名字加随机后缀 (几个 wizard 并发跑不再互撞), 只在连接被拒时重试 (spawn / tell 不幂等), 分身没照做时单独报出。
- `/name <名字>` 给聊天起名时, 该聊天的默认 wizard 一并改成这个名字 (全局唯一, 撞名照 `pickName` 挂 `-N`, 回复里注明), 它所在的 tmux 窗口名同步换成新名字; `name_chat` 跟着改默认 wizard 名时也同步窗口名。
- 定时任务「有事才说」与忙则顺延 (B4 ⑤): 任务文件 / `schedule_task` 新增 `quiet` —— 到点不在群里预告、不出「已起白板」气泡, 那一轮私下跑 (channel ""), 信封让它没事就只回一行 `QUIET`; 守护进程按这一枪的件号 (task 信封新带 `turn`) 定位终句, 不是 `QUIET` 才转进群, 待转发的那一轮落盘 (`quiet-relays.json`), reload 后续守。点名 (`fresh:false`) 的目标到点正忙时不再立刻起白板, 而是后台等它这一轮结束再投 (最多 30 分钟, 仍忙才退回白板; 同一条任务只留一枪在等)。回归脚本加 `task-quiet` 用例。
- rolepage 工单入口改为点了就进 (B3b ②③): 侧栏会话项上的 📋 与关系图连线上的 📋 可点 —— 一张直接进那张工单页, 多张进只列这几张的工单列表 (顶栏「全部工单」放开); 对话里属于工单的派活、交回与回执挂「📋 标题 + 进度」badge, 点了进工单页。会话顶栏的工单按钮撤掉, 工单页顶栏的「‹ 回到 …」「全部工单」保留; `/api/msgs` 不再带整窗工单号。
- rolepage 工单页 (B3b ②③, 按人定的方向): 工单的一切都在对话区 —— 普通会话的顶栏列出这段往来里出现过的工单 (一张一枚, 标题 + 进度, 超过 3 张进「全部工单」); 工单页 (`j:<id>`) 按时间排开工框 (成员与各自状态)、归在工单名下的派活 / 答话 / 回执、收工框 (定论、交付物、结论), 顶栏可「‹ 回到」进工单前那段会话或进「全部工单」; 工单列表在主区, 进行中在前、已收工淡一档在后。侧栏只挂 📋 标记: 出现过工单的会话行、群下成对子项、关系图上经手工单的那条关系。看着一张工单时切到关系图, 只亮它的当事人与两端都是当事人的线。进度 (已落定 / 一共) 由 `world.jobProgress` 一处算; `/api/world` 的工单成员带定论与交付物, `/api/msgs` 带整窗出现过的工单号。
- `tell_peer({chain:false})` / spawn·clone 带 task 时的 `chain:false` (B3b ③b): 在答上游派的活时顺手派出的旁支活 (测试、与上游无关的事) 不挂父 k —— 不 defer 给上游的那一份、它的回执也不带 reply-to 续回上游, 回执照常回发话方。默认仍链式; `tell_peer` 回包在挂上上游时多一项 `chained` 说明终句被挂住了。是不是为上游派的只有发话方知道, 所以是显式参数而不是按工单 / 文本推断。
- 回执回归脚本 `scripts/receipt-regress/run.mjs` (B3b ①): 在 wizard 会话里跑, 生一个 haiku 根与各用例的 haiku 临时分身, 直接 POST daemon 驱动, 只按 `receipts.json` / `jobs.json` 的账和根 transcript 里的回执信封判定, 逐条打印 PASS/FAIL, 跑完收掉全部分身。覆盖: 三级链式冒泡、并发两子 reply-to、wait_peer 取走不重投、deadline 超时、pane 被杀 (dead)、NEED→re→done、工单 expect 计数、收工后迟到的回执、`chain:false` 旁支。改 receipts / jobs / peers 后必跑; 用例名作参数只跑那几条。
- rolepage 待办托盘 (B3b ④): 名片下一小块「在飞 N」, 列出视角派出去还没落定的 (在等 → .x) 与派给它还没交的 (欠着 ← .x): 状态 (在干 / 卡在审批 · 停在哪个工具 / 反问待答 / 报错停了 / 挂起等子活)、工单号、派出多久; 卡住的排前并着色。只读; 数据与名册 / peek 的「在等 / 欠着」同一份 (`receipts.states()` → `WorldFacts.inflight`, svr 合并时按件去重)。
- rolepage 回执 chip (B3b ①): 回执那一轮的消息名字行上挂「↩ 回执 · 已交 / 反问 / 超时 … · J… 第 i/n 份」, 按定论着色; 点它跳回派活那句 (同一个活号, 窗口里没有就整窗重取再找)。turn 记录的 `from` 补上活号 `turn`、回执的 `status` 与工单 `done` / `total`; 继承上下文的 `clone_wizard({task})` 第一件活也记上出处 (此前没有 `from`, 工单与回执都找不回它)。
- rolepage 用量条显示估算费用 (💰): 每轮按它的模型单价计 input / output / 缓存写 / 缓存读再加总; 单价是 LiteLLM `model_prices_and_context_window.json` 的快照 (`shared/model-prices.ts`, `node scripts/update-prices.mjs` 重新生成), 认得 bedrock / 网关的各种写法 (`[1m]`、`us.anthropic.`、`claude-4.7-opus`、带日期)。表里认不出的模型不猜价, 费用前加「≥」并在悬停里写明有几次请求未计入。
- 工单派活预算 (B2a ⑦): `open_job({maxTurns})` —— 带这张工单的每次 `tell_peer` (含 `re` 续问、顶掉未落定工单活而继承工单的那句) 与带 task 的 spawn/clone 各记一次, 用完再派 409 (答一份停在 NEED 上的反问、不带 task 的 spawn 不受限); `tell_peer` 回包带 `budget: used/max`, 最后一次提示收口; `list_jobs` 带 `budget`。NEED 乒乓、续问兜圈的全局刹车, 也是 graph `rounds` 并入工单的落点。
- 在飞活的状态观察面与取消 (B2a ⑥): 新 `shared/turn-state.ts` 把每件未落定的活归成 `working / blocked (停在审批卡) / needs-input (NEED 反问) / errored / deferred (等它派出去的子活)`; `wizard_roster` 每个 wizard 加「在等 / 欠着」一行, `peek_peer` 头部同样一行, `list_jobs` 成员带 `state`。`stop_wizard` 与 `close_job` 回收前先把发往它的未落定活记成 `canceled` (回执新状态, 记入工单账本): 发起 stop 的一方不再收到 dead 回执, 其他发话方收到一份 canceled 回执; `interrupt` 只取消它手上这一轮那件。
- 工单账本按成员记定论 (B2a ⑤): 回执落终态 (含 wait_peer 取走) 时写进 `JobMember.outcome` / `artifacts`, 回执里的「第几份 / 一共几份」以账本为准; 同一对后一句顶掉一份未落定的工单活时继承那张工单 (此前被顶掉的成员永远不计 done, 工单齐不了); 再派 / 续问清掉该成员旧定论。`open_job({expect})` 定份数下限; `list_jobs` 带 done/total 与成员定论; 收工气泡列出非 done 的状态 / 未回与 `↳ 交付物`。
- `tell_peer({priority})` 投递策略, 只在对方正忙时分岔 (闲着一律立刻投): `normal` (默认) 等它这一轮结束再投 (即原 `when:"idle"`, 最多 `waitSec`); `urgent` 先按 Esc 打断它这一轮 (同 `stop_wizard` interrupt, 但不清它的注入队列、不停 keepalive) 再投, 回包带 `interrupted`; `now` 不等不打断, 并进它当前这一轮 (插话 / 答问 / 补一句)。**BREAKING**: 没给策略时默认从立刻投改为 `normal`; 带 `re` 续问仍默认 `now` (对方可能正挂在 wait_peer 上等你, 等它闲下来会互相干等到超时)。`when` 留作老 MCP 进程的别名 (`idle` ≡ `normal`, `now` ≡ `now`)。charter 的管家段与工具行改写为三档用法。
- 回执的收口三态 (B2a ④): 答话方可以收口成 `NEED: <问题>` 反问发话方 —— 回执 `status=need` 照投、**不计入工单**, 发话方用 `tell_peer({re})` 答它后接着守同一件活; `ARTIFACT: <路径> — 一句话` 列交付物。`parseClosing` 解析 (有 RESULT 即交差, NEED 只认全大写、`NEED: 无` 不算), `wait_peer` 回包多 `need` / `artifacts`, peer 私聊信封写明这两条约定。
- rolepage 会话列表的群下子项加范围开关 (第一行标题右端「往来 / 全部」, 记在本地): 「往来」照旧只列与视角有往来的成对子项; 「全部」再列出群里与视角无往来的 role, 整行淡色、名字不加粗以示区分, 点开是它在这个群里的全部记录 (窗口 key `a:<role>||<群>`, 对端不限), 顶栏写法同成对子项、「在 <群>」点回整个群。这类子项的时刻 / 预览与关系图卡片同走 `glanceOfTalk`, 没有成对往来也就不计未读。
- `tell_peer` 唤醒的是缓存已冷 (距上次活动超过 `keepalive.ttlSec`) 且 ctx ≥60k 的 wizard 时, 回包多一项 `wakeCost`: 这次要整段重写多少缓存、是白板 spawn 的几倍 —— 让派活的 (多半是管家) 下次分派前就记着这笔账。
- rolepage 忙闲第四态「等人点」(紫色): wizard 停在 daemon 发出的审批卡 / 提问卡上时, 名片、关系树、工单成员显示 `等人点 · <工具名>`, 侧栏也亮灯 —— 此前它在审批长轮询期间显示「执行中」, 和真在干活分不出来。数据取 daemon 的 pending, 按 approval 认卡的同一口径归到 wizard 上。
- rolepage「载入更早」改为按游标一页一页往前翻 (`/api/msgs?before=<msgid>`), 不再一次取全量 (大群窗口一次近 1MB); 视口锚定不变。
- 共享记忆合并后告诉在场的 wizard: 整理者真改动了哪份群 / 工作区记忆, pane 活着且读这份 md 的 wizard 下一条消息尾巴上捎一行「记忆已更新, 全文见 …」(宪章是出生快照, 此前要等重生才看得到)。整理者合并时把该工作区的 `CLAUDE.md` / `CODEBUDDY.md` / `AGENTS.md` / `.claude/CLAUDE.md` 与各 backend 的 auto-memory `MEMORY.md` 当只读参考, 已写在那里的不再收; workspace 提议记下 `cwd`, 提议者收工后仍找得到参考源。名册增量的 reminder 表头改成通用的「宪章是快照」; 宪章重渲染时清空该 wizard 待投递的增量 (新宪章里都有了)。
- self 记忆跨 `/clear`: `/clear` 之后第一条注入捎上出生后新记的条目 (最新 10 条) 与已 forget 的条数; reload 后没有快照则只指路。`clone_wizard` (fork 上下文) 继承被克隆者的 self 记忆并标「(继承自 .x)」。`wizard_remember` self 满 60 条挤掉最旧的时返回里列出 `dropped`, 超 600 字返回 `truncated`; 去重改按截断后的文本比, 长记忆重记不再叠出重复。
- 交接简报留档: `wizard_handoff_self` / `/handoff` 的简报贴回新会话成功后追加到 `~/.wezard/memory/episodes/<name>.jsonl` (交接前后的 sessionId 与简报全文), 空简报不记 —— 此前简报只活在新会话的第一条消息里。
- 上下文到 120k 时, 下一条注入捎一行「先 `wizard_remember` 记下值得跨会话的, 再考虑 `wizard_handoff_self`」, 每段会话 (sessionId) 只提一次。

- `tell_peer` 加 `re` (续问) 与 `deadline` (秒, 60–43200, 默认 3600): 每次派活在注入前领一个件号 (`turn`, 写进信封与回包), 回执按件号定位答句; `re: <件号>` 接着那件活说, 沿用它的频道与 (还开着的) 工单, 来回超过 3 次信封提示直接收口, 件号对不上按新活发出并回 `reUnknown`; 到期没答完收到 timeout 回执。交接转移的义务顺延期限至少 10 分钟。
- 回执轮的终句有了去向 (父 continuation): `tell_peer` / 带 task 的 spawn·clone 登记时记下发话方这一轮的父 k —— 人 / 定时任务 / 公开轮发起的 → 那个群; 上游私聊派来的 → 回给上游。答话方那一轮又派了活时, 上游那份回执先挂起不投、不计数 (不再把「已派给 B」当结论提前送走); 最后一份子回执进去时, 信封写明 `reply-to` (群名或 `.上游`), 那一轮的终句进群或作为上游的回执送回, 多级链逐级冒泡; 还有兄弟没回时只进 rolepage。子活失败 / 被 wait_peer 取走 / 发话方不在了同样叫醒挂起的上游。
- 工单收工结论留档: `close_job` 把 summary、聊天、开单者与每个成员的名字 / sessionId (回收前取) / 是否临时生的 / 那段活 / 定论 / 交付物写进开单者的 `~/.wezard/memory/episodes/<name>.jsonl`, 与交接简报同一份, 用 `kind` (`handoff` / `job`) 区分; 空工单不记。留档失败打 warn。
- 「先 `wizard_remember`」提醒线与 `wizard_whoami` 的 `handoffSuggested` 交接线不再写死 12 万 / 14 万, 改按 wizard 实际跑的模型 (transcript 里的 id) 的上下文窗口算: 窗口的六成提醒、七成建议交接, 次序固定先记后交。窗口取自一张最小表 (`[1m]` 与 Claude 5 家族 / opus-4-6~9 = 1M, haiku = 200k, deepseek / gpt-4o / kimi / glm = 128k, 认不出 = 200k)。

### Security
- 模型不再能免审改审批配置: PreToolUse hook 对 wezard 自家 MCP 工具的一律放行排除了两种「写」—— `config_set` 带 `value` (可写 `danger_skip_all` / `approval_mode` / `allow_from`) 与 `set_model` `scope:"default"` (改 CLI 全局设置), 它们落回审批, 且 daemon 把它们当必发卡 (不吃 matcher / danger 开关 / ⏱窗口 / 会话缓存, 只有人开的 skipAll 与 bypass 模式压得过); `config_set` 的读与 `set_model` 的会话级照旧免审。
- hook 的 wezard CLI 免审只认整条命令就是一次 `wezard[.sh] <status|logs|pending|audit|update|reload|config-path|mirror-status|version|help>` 且不含 shell 元字符; 此前命令里任意位置出现 `wezard` 一词就放行 (`curl …/config/set; true wezard` 可免审直改配置)。注意 daemon 的 `/config/set` 路由本身仍不鉴权, 本机进程可直接写 —— 这里只关掉了模型免审走到它的两条路。
- 写敏感状态的 daemon 路由要出示口令 (B4 ⑪): `/config/set`、`/claim/start`、`/claim/reset`、`/tasks/schedule` 只认带 `x-wezard-token` 头、值等于 `~/.wezard/daemon-token` (0600, daemon 开机生成) 的请求 —— wezard 自己的 MCP server 与 CLI 每次现读它; 本机别的进程直接 curl 一律 403 (此前写配置、布认领口令、落一份 daemon 会执行其 gate 的任务文件都不鉴权)。**注意**: 已在跑的 wizard 的 MCP 进程是旧代码、不带口令, 它们的 `config_set` 写 / `schedule_task` 会被拒, 重开会话 (新 pane) 后恢复。

### Changed
- `spawn_wizard({detached:true})` 吸收 `new_claude_session` (B4 ②): 白板生一个独立长住的 wizard —— 不挂家谱、不占调用方的分身名额、不随工单回收 (与 `inherit` / `job` 互斥), 等价于人在群里 `/new .name`; `new_claude_session` 留作一行别名, 路由不变。
- 两个交接工具合成一个 `handoff({name?})` (B4 ①): 不传 `name` = 交接你自己 (带 `brief`), 传 `name` = 替那个 wizard 交接 (`focus`); 点名点到自己也按交接自己办, 不再拒绝。`wizard_handoff_self` 留作一行别名, 两条路由不变。`/handoff` 不点名不再落到「本聊天的默认 wizard」(一个漏传的参数就能把群管家交接掉), 直接 400。
- 默认工具面去掉人侧 / 罕用的 6 个 MCP 工具 (B4 ③): `run_agent_graph` / `graph_status` / `stop_graph` / `list_claude_sessions` / `switch_claude_session` / `list_chats` 不再注册 (30 天零调用; 人有 `/sessions` `/chats`), 路由照旧, 设 `WEZARD_MCP_EXTRA=1` 挂回来; charter 去掉 `run_agent_graph` 一行, 各描述里「list_chats 里的聊天名」改指 `wizard_roster` 的 home 聊天名。
- rolepage 消息的这一轮耗时不再随「两人对话藏指标」一起藏, 所有对话都显示; 进行中的那一轮按开始时刻每秒走表 (服务端只给开始时刻, 不扰增量推送的去重)。
- 工单整个不进群 (人看不懂过程): `open_job` / `close_job` 不再发开工 / 收工气泡; 带 `job` 的 `tell_peer` 一律私聊 (`public:true` 被忽略), 往来与回执都不进群, 照旧写进 turn store 给 rolepage 工单页读。群里只留发起者自己那一轮的最终回复 —— 沿它被问的那条链回去 (人在群里问的就回群); 最后一份回执的信封改说 `close_job` 只留档、结论用自己的话写在这一轮的回复里。`close_job` 的 summary 照旧进情景记忆; `open_job` 的 `plan` 改记进工单账本。charter、MCP 描述、CLAUDE.md 同步。
- rolepage 消息头像行的本轮指标 (模型 / 上下文 / 耗时) 只在多方会话 (群、整个 chat) 里显示, 两个 role 之间的对话 (单聊、成对子项) 不再显示, 终句气泡的时间行同一规则; 各处去掉 out; 模型名改显示简名 (`claude-opus-5-5[1m]` → `Opus 5.5`, 全名在悬停里), 与计价共用 `shared/pricing.ts` 的名字归一; 页脚用量条的模型名同样走这一份。
- `/usage` 与 audit 的费用改用同一张价格表 (此前三档写死, Opus 一律按 $5/$25 计, Opus 5.5 实为 $4/$20)。
- 回执终态只留一份定义 (B3b ②): `shared/turn-state.ts` 的 `Terminal` / `isTerminal`, 工单账本 (`JobMember.outcome`, 原 `MemberOutcome`)、回执 watcher、失败回执措辞表都用它。NEED 往返不设硬上限 —— `legs > 3` 只在信封里提示直接收口, 硬刹车是工单 `maxTurns` (b2-continuation.md 对齐)。
- charter 编排段按回执 `status` 写处理法 (B2a ⑧): `need` 用 `re` 答、`error` 等续跑、`timeout / silent / dead / canceled` 换人或如实写缺; 「迟迟不来才 peek」改为看名册 / peek 的「在等 / 欠着」行; 写明 `deadline` / `maxTurns` / `expect` 何时用, 收口约定加 `NEED:` / `ARTIFACT:`。
- rolepage 用量条的指标图标: API 请求次数 📡 → 🔁 (一次来回), 上下文峰值 🧠 → 📄 (送进去的那份文档)。仍用 emoji 而不是单色 svg, 与同排 💬 🛠️ ⏱️ 保持一套, 也能原样进被 fitUsage 收起时的 title。
- rolepage 用量条 I/O 分布色带里缓存读 (cr) 一段改用边线色 `--line` (图例色点同步), 贴顶时与普通上边线连成一体, 注意力只留给 in / cw / out。
- rolepage 用量条的 I/O 分布色带从贴底挪到贴顶, 兼作上边线 (原 `border-top` 去掉; 没有分布时留 1px 线), 厚度 3px → 1px, 悬停加粗到 3px。
- rolepage 关系图标题行的「看全部 / 只看相关」文字按钮换成与侧栏「往来 / 全部」同款的两段式开关「相关 | 全部」, 切换语义不变。
- 管家分派默认偏省钱: `route_candidates` 每个候选多一行「代价」—— 缓存冷热 (距上次活动是否超过 `keepalive.ttlSec`)、唤醒要重写多少缓存 (对比白板 spawn 起步 ~25k 的倍数)、往后每轮背着的 ctx, 以及「这件活点到它读过的几个文件」; 证据弱 (没点到它读过的文件, 小活则少于 3 个) 又贵 (缓存冷且 ctx ≥60k, 或热但 ≥150k) 的标 ⚠「不划算, 建议白板 spawn」; 小活 (改样式 / 单点修改 / 简单查询) 表头点明。charter 管家段写明: 小活默认白板 spawn 或交给 ctx 小的, ctx ≥60k 且缓存冷的只接真正依赖它上下文的活, 标 ⚠ 的默认不转。
- rolepage 关系 / 日程栏的世界快照 (`/api/world`) 瘦身: 工单成员任务只留首行 (实测 119KB → 55KB), 并带 ETag —— 名册没变时 6s 轮询回 304、不重画; 换视角后迟到的回包丢弃。
- 共享记忆整理从定时任务改成 daemon 内建定时器: 不再生成 `~/.wezard/tasks/memory-steward.task.mjs` (开机把旧的改名为 `.retired` 停用, 免得两路并跑), 不进 `list_tasks` / rolepage 日程。每 30 分钟 (开机后 1 分钟先跑一轮) 认领收件箱里的提议 (认领 / 一小时孤儿回收语义不变), 有活才在不属于任何群的内部 key 上起一个白板 wizard 合并, 收工即收; 收件箱改由守护进程归档进 `memory/log/`。全程零气泡、不 notify, 结果只留在 rolepage 与审计日志。
- wizard 的上下文瘦身: charter 的出生名册只列写了职责的同群 wizard (至多 15 个, 其余报个数、指向 `wizard_roster`), 「我能做什么」改为每个工具一行「何时用」, 「编排」「说话」两节不再复述工具描述 —— charter ~5.1k → ~2.5k tok (管家 ~6.0k → ~3.4k)。工具描述不再教 `send_peer` / `wait_peer` (一律 `tell_peer` + 回执); `send_peer` 描述压成一行; `tell_peer` 只讲机制; `schedule_task` 只留何时用 / `when` 人话 / 默认新建 / 回念 `next`, gate 写法挪进任务文件头注释; 生 wizard 的 `model` 参数共用一句; graph 三件套、`list_claude_sessions`、`switch_claude_session`、`list_chats` 标为人侧/罕用。工具定义合计 ~20.4k → ~17.8k tok。CLAUDE.md 的 MCP 段与 `/help` 的过期措辞一并更正。

### Removed
- rolepage 名片下的「在飞」待办托盘 (d4cd983) 与日程页的工单列表: 工单与在飞的活改由对话区的工单页 / 工单列表承担, 侧栏只留 📋 标记; 名片「📅 日程」的数字只算定时任务。
- rolepage 用量条的累计耗时 (⏱️) 指标。

### Fixed
- daemon reload 不再把正在跑的那一轮切成几段: reload 后第一笔产出先找这个会话仍开着、问话与 transcript 最后那句相同的轮次接回去 (频道与出处取它自己记下的), 不再另开一轮、每段都带着同一句开头。懒建的轮次 (同伴 / 定时 / graph 注入、CLI 里敲的、排队后才接上的人话) 起点改为那句话在 transcript 里落盘的时刻 —— CLI 真正开始处理它的那一刻; 之前是 daemon 看到第一笔产出的时刻, 漏掉了思考时间, 排队的回执轮只剩几十毫秒。rolepage 插话那句也随发话方那一轮重推。
- rolepage 每条 wizard 消息的描述行都带这一轮的耗时 (进行中按开始时刻走表): 两方对话里只藏模型 / ctx, 耗时不再藏 (撤回 bb254b7 那一半); notify 贴进群的那句不再显示零时长, 改记发话 wizard 贴它时那一轮的账; 移交行带上对方接手那一轮的账; 入消息 / 移交行 / 回执 chip 读的是别的轮次, 那一轮变了 (收口、回执到达) 现在会跟着重推, 不再停在旧的走表或旧状态上。
- `wizard_remember` 不再把整份记忆回给调用方: 共享作用域每提一条就回整份 md (weclaude 那份约 1.5k token), 改回行数与 `file` 路径, `forget` 另回此刻命中几行 (`forgetHits`, 0 = 子串写错了); self 作用域只回条数。
- 回执回归脚本收尾删掉根留下的工单收工情景记忆, 测试不再往 `memory/episodes/` 里留 `rr-root-*`。
- `stop_wizard({turn})` 按件号撤回: 按 Esc 之前再认一次它手上这一轮 (等待期间它可能已做完这件、接了别人的下一件, 此时不再按 Esc 误伤); Esc 没按成不再回 502 —— 这件已经撤回, 回包如实写 `interrupted:false` 与原因。
- `tell_peer({receipt:false})` 不再登记回执槽: 一份不守的槽以同一对的 key 顶掉发话方还在等对方答的那件活, 那件的回执再也来不了; 对方的信封也不再叫它「终句就是回执、收口 RESULT」, 改说「不收回执」。`send_peer` 别名的参数不再背一份说明 (~1.1k → ~0.2k tok)。
- rolepage 两个 role 之间的对话里, 名字行与终句气泡头上的耗时也一并藏掉 (此前只藏模型与 ctx), 只留时刻; 消息上的工单 badge 比工单的账先到时只写工单号, 现在账到了就按标题与进度重填。
- rolepage 多方视图 (工单页、群) 里同伴派来的那句只有时刻, 答话却带模型 / ctx / 耗时, 同一视图里看着不一致: 入消息原本没有自己的账。现在 wizard 派来的那句带上发话方发出它的那一轮的账 (与它出消息名字行上同一份 chips), 显隐照旧走两方会话那一份判定 (`.two`: 两个 role 之间的对话藏模型与 ctx)。人说的、定时任务放的仍只有时刻。
- rolepage 工单页: 收工结论原先根本没渲染 (markdown 只处理气泡, 开工 / 收工两行不是气泡), 现在开工那行的计划 (`open_job` 的 plan, 随 `/api/world` 下发) 与收工结论都按 markdown 分行显示, 成员那段活原样分行 (超 4 行收起, 悬停看全文)。撤掉「全部工单」入口 (工单列表只从 📋 进); 关系图上有 📋 的关系不再另挂「工单 ×N」种类签。
- rolepage 从 📋 进工单列表时列表为空 (标题却写「这 N 张」): 标记数的是「这处往来里出现过的工单」, 列表却按视角开过 / 参与过重新筛, 还要靠没载入的世界快照补。改为按入口带的工单号列, 摘要随 role 一并下发全部工单的账 (`jobIndex`), 标题数字、列表行、消息 badge 都从这一份取; 账里已清掉的明说。
- 主动推送不再在 reload 窗口里丢消息: 新进程恢复 mirror 后立刻要推的终句 / notify, 撞上 WS 尚未连上就被 SDK 以 `WebSocket not connected` 拒掉、永久丢失 (近 48h 约 18 条); `sendMessage` 现在先等连上 (最多 30s) 再发。推送成功落一条 `standalone pushed` / `raw pushed` 日志 (chatId、turnId、WeCom 回执), 失败日志带上 WeCom 的 errcode/errmsg (SDK 拒收时 reject 的是回执帧而非 Error, 原先记成 undefined) —— 此前成功推送不落日志, 「rolepage 有、群里没有」无从对账。
- 并发注入到不同 pane 时文本会串台: tmux 注入共用默认粘贴 buffer, 一方 load 之后、paste 之前被另一方覆盖, 两段文本互换 pane (实测同一毫秒投出的两份回执, 给 .evolve 的那份进了 .ev-proto, .evolve 没收到)。每次注入改用自己的具名 buffer。
- 工单收工之后才到的回执, 信封不再说「全部到齐, 去 close_job」: 投递时读工单状态, 已收工就写明这一份是收工后到的、不计入那次汇总、不必再 close_job (定论是 done 且这一轮不外发时, 提示有用就自己交代)。
- 回执投递与 `wait_peer` 取走撞在一起时会双投: 发话方闲着、回执正在投, 这时 `wait_peer` 取走同一份, 取走方拿到 `delivered:false` 而回执照样进了会话。投递前同步再查一次是否已被取走, 并先记成已投 (投失败再撤回), 取走方据此如实得到 `delivered:true`。回归脚本 `wait` 用例抓到。
- 死 pane 重生 (`claude --resume`) 后的 fork 跟随不再错绑兄弟会话: 迁移 watcher 原先认同目录里任何「有 user 行」的新 jsonl, 恰逢另一个 wizard 同时 spawn (它的 sid 还没 attach、不在 claimed 里) 就被抢走 —— `.evolve` 因此绑到一个 haiku 分身的空 transcript 上, `peek_peer` 一直「还没有对话」, 派给它的活全收到 `silent` 回执 (它其实收到并转派了)。现在只认首条 user 行 uuid 与原会话相同的 fork (`forkOf`); `clone_wizard` 等 fork 落地的 `awaitFork` 同理只认父亲的种子。
- 保温 ping 按会话缓存实际的 TTL 定时: 从 transcript usage 的 `cache_creation.ephemeral_1h/5m` 分档读出 (Claude Code 订阅下全是 1h), 不再按 `keepalive.ttlSec=300` 每 4–5 分钟 ping 一次 —— 1h 的缓存里这些 ping 一个都不需要, 实测 3 天 1318 次、读了 2.07 亿 token 缓存 (约占总花费 7%)。`ttlSec` 退为无分档记录时的兜底, 仍是 stall 续跑的静默窗 (API 报错停住的轮照旧几分钟后续跑)。`tell_peer` 的 `wakeCost` 与 `route_candidates` 的冷热判断同样改按实测 TTL, 不再把 5 分钟前活跃过的 wizard 报成「缓存已冷」劝人白板 spawn。
- rolepage 关系图 / 会话列表不再翻出没有消息数据的 wizard: `withData` (shared/world.ts) 在 svr 取注册表的源头 (`getFacts`) 裁掉没有 transcript (daemon 给的 `lastActivity` = 0)、轮次记录里也没有它的 wizard —— 不只看轮次: 轮次库有 24h / 1000 条的保留上限, 挤掉了的活跃 wizard (如 .clickinchat) 会被误判, 关系边、+N、侧栏与搜索都只见得到裁后的那份; 活着的照留 (刚 spawn 还没开口的分身)。挂在被裁者名下的后代改认最近一个留下的祖先 (clone 的上下文来源同理), 家谱不断。
- rolepage 用量条的上下文 (📄) 取「最近一轮主会话最后一次调用送入的 input + 缓存」, 不再是全部轮次 (含子 agent) 的峰值 —— compact / clear 之后峰值早已过时。顺带修 `ctxFirst` 在一轮第二次调用后被丢掉 (宪章占开局几成因此只在单调用的首轮里算得出)。
- rolepage 关系图卡片的 +N 改为「这一档图上看不到的关系对端」: 对端卡片已画在图上就不算 (不论有没有连线), 「相关 | 全部」各按自己画出来的卡片算。「相关」改为画出视角的全部直接关系 (任一种类、任一方向; 此前只画对过话的, spawn 的子 wizard 等被藏掉, 视角自己的卡片也挂着 +N), 去掉兄弟卡片的折叠计数 `tfold`; `/api/world` 每个聊天的成员上限不再截掉视角的直接关系 (此前 ev-route 等没下发, 只能计进 +N)。
- 7a76bb6 里 `wait_peer` 回包的 `need` / `artifacts` 两行被插到了 `restartFresh` 中间 (daemon/index.ts 语法错误), 挪回 wait_peer 回包。
- 回执把上一件事的结论当成这一次的: 对方正忙时我们那一句还排在输入框里, 回执守护在它读进之前读 transcript, 定位不到问话就退回按时刻取。现在定位不到一律视为还没读进、接着等 (不计扑空), 只有对方整段 20s 都闲着而问话仍不在才算一次; 判闲改走注册表 (`untilIdle`), 停在本地对话框上的 wizard 不再被当成答完; 对方 pane 没了直接结束不空转; 交接顺延 deadline 后不再被一次定死的超时提前放弃。
- 回执静默丢失: 对方超时 / 停下几次都没答 / pane 没了, 以前回执直接扔掉, 发话方只能永远等; 发话方忙满 30 分钟也会扔。现在每份回执都有定论 (信封 `status=done|error|timeout|silent|dead`), 失败的投一份合成说明 + 对方最后一句, 工单按已落定计; 发话方 pane 活着就一直等到能投; 结果先落盘再投, reload 重投同一份, 迟到的答案不改写已投的定论。对方那一轮以 CLI 的 `API Error: …` 收尾时不再当成结论 (以前会被当成回执并计入工单份数): 投一份 `status=error` 不计份数, 接着守它续跑 (`continue`) 出来的答案。
- 工单回执提前报「全部到齐」: 份数只数回执登记, 而登记按一对 wizard 一份 —— 发起者后来又对同一个成员说了句不带工单的话, 那份就被顶掉, total 少一 (J5a009e 3 个成员报成 done=2 total=2)。现在 total 至少是工单账本的成员数。回执定位还修了两处: 对方一轮中途吃进的排队消息 (`queued_command`) 现在认作问话, 由这一轮的终句作答 (以前永远定位不到, 守满三次判没答); 对方 transcript 里我方先前送去的回执行不再被误认成问话。
- 回执投成「（后台任务已完成）」: 对方答完后, 它先前放到后台的命令跑完会以 `<task-notification>` 起新一轮, 回执定位没把这一行当轮界, 取到的是那一轮的终句。现在 CLI 自插的通知行也截断一轮。
- spawn 中途失败留下僵尸身份: spawn 途中 daemon 被 reload (调用方看到 `fetch failed`) 时, 身份记录已落盘却没有会话, 名字被永久占住, tell_peer / stop_wizard 都报「exists but its session is not running」。现在身份记录带 `spawning` 标记, 生成功才清; spawn 抛异常也回滚; 开机收掉上一个进程没生完的记录。`stop_wizard` 对有身份没会话的 wizard 也能成功: `end` 视为早已结束, `forget` 删记录腾出名字。
- rolepage 链接在独立 svr 上报「未找到该会话」: 聊天票据只在创建那一刻推一次到远端, 远端换过地址 (lisct → 本机 17891) 或那一下 svr 不在时就永久缺席。现在 daemon 每次 (重新) 连上远端都把全部聊天票据补推一遍。
- reload 落在 spawn 中途留下的孤儿 tmux 窗口现在会被收掉 (B4 ⑫), 不再只打一行 warn: 开机清掉没生完的身份后, 等绑定恢复完, 把 daemon 自己的 tmux session 里以这些名字命名、且没有任何绑定指着的 pane 杀掉; 名字期间已被新 spawn 认领的不碰。
- `stop_wizard({forget:true})` 抹掉一个 wizard 时, 它在还开着的工单里没落定的那一份记成 `canceled` (B4 ⑬, 冷记录与活会话两条路径都算; 回包带 `canceledIn`) —— 此前那一份永远不会落定, 工单「齐了吗」一直差一份。已落定的 (连同交付物) 原样保留。
- `/compact` 与自动压缩之后也补回 self 记忆 (B4 ⑭): mirror tail 读到 `compact_boundary` 即同 `/clear` 一样, 下一条注入捎上出生后新记的条目 (reload 后无快照则只指路) —— 压缩换掉了对话, 宪章 (系统提示) 却还是出生时那份。
- 同一 cwd 并发出生的 wizard 不再被认错会话 (B4 ⑯): 新会话的 sid 由 daemon 先定 (`--session-id` 传入), 出生到 attach 之间挂进「在途」集合, 同目录别的 target 的迁移 / 自愈 / 分叉跟随 / 指纹重绑扫目录时都绕开它 —— 此前新 spawn 预建的 jsonl 会先被别人认走, 正主 attach 时撞 `already bound`。并发克隆的分叉文件改为首选 CLI 会话注册表按 pane 报的 sid 来认, 注册表报不出 (或 15 秒后还报着父亲的 sid) 才按「新出现、首行同父」去猜, 认下即预留。

## [2.2.2] - 2026-10-02

### Changed
- README 多 wizard 协同一节改用关系图截图 (`images/wizards.png`), 不再与顶部 demo 图共用。

### Removed
- 仓库里零引用的图片: `images/multi-session.png` (1.1.5 时代的旧截图)、`images/icon.svg`。

### Fixed
- rolepage 名片的 session 选择器只要有 session 就显示 —— 此前只有一段时整个选择器消失, 看不出当前看的是哪一段; 只有一段时下拉里是「全部 · 1 段」加那一段。箭头改 16px。

## [2.2.1] - 2026-10-02

### Changed
- rolepage 名片收敛: 头像加不透明底, 去掉身份行; 名字下一行灰色描述只留 📁 工作区 · 🏠 home · 🐣 出生 (不再报轮数); session 选择器箭头改 18px。
- README 改版: 简介与功能列表按重要程度重写 (远程控制 → 审批 → 多 wizard → 管家分派 → 回执 → 记忆 → rolepage …), demo 图换成 rolepage 群聊视图, 新增 tmux ⇄ 企业微信双向镜像的配图与小节、「管家」一节; 技术说明补上记忆 / 分派 / 回执 / 交接的机制说明与配图。

### Fixed
- **危险名单加「命令词位置」约束** (#19): rm / shutdown / sudo 这类又短又常见的词只在命令位置 (行首、`;` `&&` `|` `(` 之后、引号紧邻、包装器之后、`-- ` 之后) 才命中 —— 分支名 `feature/graceful-shutdown`、`docker run --rm`、检索词里的 rm/sudo 不再把 `git checkout` / `git push` 堵在审批卡上; ssh / kubectl·docker exec 的远程形态保持宽匹配。
- #19 的包装器漏报: 包装器初版是白名单, `\rm`、`command rm`、`timeout 5 rm`、`nice rm`、`env FOO=1 rm`、`watch reboot` 全被放行。补全包装器集合 (command/builtin/timeout/nice/stdbuf/watch/caffeinate/doas/setsid/ionice 与 `\` 转义), 包装器与命令之间允许选项/时长/`K=V` 赋值 token —— 普通单词打断链条, 检索词钓不出命中。

## [2.2.0] - 2026-10-01

### Added
- **回执自动回注: peer 之间的一轮对话从「问完要守着」变成「问完就放手」**(`daemon/receipts.ts`)。一次 `tell_peer` 之后, 对方干完那一轮, 守护进程把它的结论作为**新的一轮**paste 回发话方的输入框 —— 发话方全程不被阻塞, 对方也不需要调任何工具去回复。此前只有两条路: 挂在 `wait_peer` 上阻塞等 (把一个能干活的 pane 锁死在轮询里, 而且一次只能等一批、等完才醒), 或者自己记得回头 `peek_peer` —— 后者实际上没人做。
  - **不是第二个编排器, 是一条投递通路**。四步全部复用现成判定: 等对方停下 (`graph.waitForIdle`, 与 `wait_peer` 同一套) → 取它答**这一句**的那段话 → 等发话方停下 → paste。控制流仍在发话方自己的上下文里。回执登记落盘 (`~/.wezard/receipts.json`), daemon reload 后接着守。
  - **信封是比发话时刻更硬的锚**(`peers.replyToPeer`)。对方正忙时我们那一句是排队的, 它先吐出来的是**上一件事**的结论, 而那条回复同样晚于我们 paste 的时刻 —— 按时刻取就会拿旧结论当新回执。改为在它的 transcript 里定位「挂着 `kind=peer from=.我` 的那句问话」, 从那一句往后数。三态分明: 找不到问话 (老 wizard 不挂信封) → 退回按时刻取; 找到了但还没答 → **接着等**, 绝不将就。
  - **发话方忙时排队**: 同一个 pane 的回执串行投递 (per-sender promise chain) 并等它 idle 再投 —— 两份回执同时等到 idle 时两次 paste 会挤进同一个输入框被当成一轮读掉, 正是异步化最容易带进来的那个故障。
  - **回环在结构上不成立**: 只有 `tell_peer` / `clone_wizard({task})` 这两条「我主动说了一句」的路径登记 watcher; 回执本身是直接注入, 不登记, 所以回执轮的回复不会再弹回去。人说的话、定时任务、graph 步骤同样不登记。回执轮在 turn 记录里标 `from.receipt=true`。
  - **fan-out 的「齐了吗」由守护进程数**: 带 `job` 的回执在信封属性里写 `job` / `done` / `total` / `complete`, 正文明说「这是第 3/5 份, 还差 2 份, 不要现在汇总」, 最后一份明说「全部到齐, 可以 close_job 了」。异步化之后 N 个回执是 N 个独立轮次陆续进来的, 让模型自己在上下文里数到五是最容易错的那种事。
  - 投递前确认发话方还有活着的 pane (`MirrorBridge.paneLive`): 已经收工的 wizard 不该为了接一份结论被重新拉起来。目标连着三次停下都没答这一句就放弃 (它多半卡在一张审批卡上), 不守到天亮。
- `tell_peer`: `send_peer` 的新名字, 语义写进名字里 ——「说一句」而不是「发送并等待」。新增 `receipt:false` (放出去就不管) 。
- **MCP `route_candidates`: 管家分派前的候选表**。派给已有 wizard 还是新起一个, 拆成两半: 能算的交给 daemon —— 职责 / 最近的话与这件活的词面交集、它上下文里 (上次压缩之后) 读过的文件被点名了哪些、同不同工作区、忙闲、ctx; 要判断的留给管家 —— 是不是同一件事、接着用那段上下文值不值得背着它的 ctx。不出分数、没有硬阈值, 末尾永远附「新 spawn」。上下文已够判断时管家直接分派, 只在拿不准时查。
- **rolepage `⌘K` 全局搜索**: 按 role 名字 / 会话名 / 消息正文搜, 结果分三层 (谁 → 对谁 · 何时 / 命中片段 / 所在会话), 命中词高亮; 键盘选中回车跳到那个会话的那一句 (不在当前段或最近一截就放宽 / 整窗重取再定位)。空查询时是最近会话的快速切换器。新路由 `GET /api/search`。
- **rolepage 关系图**: 侧栏的一种模式, 一棵关系树把家谱 (分身) 与对话 (谁和谁说过话、`对话 ×N`) 画在一起, 线 + 箭头 + label 按种类着色, 只画和视角对过话的关系 (必经的祖先淡显作连接), 人也是节点。卡片复用侧栏会话项 (最近一句 / 时刻 / 未读同一口径, 兄弟随新消息上浮); 点卡片打开它与图上相连者之间的往来 (`talkOf` 统一「某 role 与某些对端的往来」, 会话项、子项、窗口、关系图同一个口径), 打开即清未读; 点头像换视角, 树随新视角重算。
- rolepage 用 `notify` 贴进群的话落成记录, 画成发话 wizard 在那个群里的出消息。
- rolepage `/clear` `/new` 的断点条署名是哪个 role 的, 名字可点换视角; 名片上点名字复制 `.name`。

### Changed
- rolepage 消息的「发给谁」从头像/名字那一行挪到气泡对面的空白处, 带收件人头像, 箭头顺着发话人 → 收件人 (自己的消息在左写 `🦉 .x ←`, 别人的在右写 `→ 🦉 .x`), 贴着气泡首行、低调字号, 可折行 (最多三行), 不吃点击 —— 那片空白照旧是换视角的入口; 窄屏 (≤760px) 空白太窄时退回消息头。
- rolepage 悬停气泡对侧空白时的换视角提示是「箭头 + 要切到的 role 名字」, 加了内边距与间隔, 名字可折行; 有「发给谁」描述时门竖排、描述在上箭头在下, 描述折几行箭头就跟着让几行, 不撑高这一行。
- `clone_wizard({task})` 的第一件活同样守回执: fan-out 最常见的形状就是 `clone_wizard({task}) × N`, 现在它们干完会自己把结论送回来。
- 信封措辞改口: 私聊轮不再说「它用 wait_peer 取」, 而是「你一停下守护进程自动把它送过去, **你不需要再调任何工具**」; 公开轮同样点明。charter 的编排剧本重写: 派完就放手、没齐别汇总、齐了才 `close_job`。
- `MirrorBridge` 多两个出口: `replyToPeer` (按信封锚取回复) 与 `paneLive` (有没有能用的 pane, 不重生不猜)。
- **`tell_peer` 的 `when:"idle"` 与回执投递改由事件驱动**: 监听 CLI 会话注册表的 status 翻转 (整轮含工具间隙、审批 hook 都是 busy, 轮结束才翻 idle; 悬着工具调用的 idle 不算闲), 轮一结束即投, 投递时延 5–7.5s → ~0.2s。没有注册表的后端仍按 pane spinner 轮询。
- **生命周期事件不再下发到群**: `stop_wizard` 的「已结束 / 已打断」、`spawn_wizard` 的 📂 项目气泡、交接成功都不再进群 (交接失败由 notices 捎给它自己); 定时任务起白板 wizard 的 ⏰ 照旧。rolepage 记录与同群 wizard 的名册增量不变。
- 管家公开转交后不复述 —— 人看得见群里的公开消息, 转交与回执后都只说人还不知道的。
- wizard 交接 (`wizard_handoff_self`) 用 `/new` 换新进程而非 `/clear` —— MCP 与 charter 随之刷新。
- rolepage 用量条改版: 页脚当前视角一条、窗口对端恰好是一个 wizard 时再挂它的一条; 条首头像 + `.名字`, 模型名高亮, 轮次 / 工具 / API 请求 / ctx / 耗时 emoji 前置, cache read / input / cache write / output 分布是贴底的细色带 + `cr/in/cw/out` 图例; 永远单行, 窄了按分布文字 → 名字 → 耗时依次藏进悬停提示。
- rolepage 数据只取最近 3 天 (轮次、wizard 登记、家谱、已关工单); role 默认看全部 session; session 选择器挪进名片。
- rolepage 侧栏: 搜索框在名片下、「关系图｜日程」是居中的文字链接; 会话项 / 子项 / 关系图卡片的预览在对端不止一个时带说话人前缀; 每个会话项一道内缩的下边线; 忙闲统一成名字右边的一个标签; 保温 ping 折叠条隐藏。

### Deprecated
- `send_peer` 降为 `tell_peer` 的别名 (行为完全一致, `/peers/send` 与 `/peers/tell` 同一个处理函数) —— 正在跑的 wizard 的 MCP 进程是旧代码, 名字是地址, 不能一刀切。
- `wait_peer` 降为**阻塞变体**: 一般不再需要 (回执自己会回来), 但保留两件只有它做得到的事 —— 在**同一轮里**拿到答案 (下一步硬依赖、拆成两轮会丢上下文), 以及 `need:1` 那种「谁先完事就先处理谁」。被它取走的那一份不会再作为回执注入 (`delivered:true` 告诉调用方回执已抢先到), 不会双份。

### Fixed
- **交接换会话后回执、注入与 reload 都不断**: 交接全程立闸, 人话、`tell_peer`、定时任务、回执投递都等交接收尾再进新会话; 欠着的回执随之转交。`injectText` 同样跟随 `/clear` 轮换与静默分叉 —— self-handoff 后镜像不再钉在旧 jsonl。
- 注入的轮不再被认成 CLI 发起, 回执 / peer 回复按频道进群。
- 回执不再取一轮中途的开场白当结论; 等发话方期间被顶掉的不再投; 回执轮在 rolepage 上不再重复画同伴原话, 公开频道里的回复答给人。
- forget 过的分身不再被只读路径复活; 发给非在册 wizard 的 `tell_peer` 降为私聊。
- 孤儿 `tool_result` 回 transcript 补回漏看的 `tool_use`。
- rolepage 名册缺席改用显式信号: 采集失败退回上一份、占位快照不推, svr 推送失败 5s 重试 —— 不再拿空名册顶掉好快照最长 30s。
- rolepage 载入更早的消息时锚住视口顶行, 不再吸底; 文本溢出一律单行省略, 截断处悬停给全文。

## [2.1.4] - 2026-10-01

### Changed
- rolepage 一对一会话 (私聊, 或群里「只看我与 X」) 的顶栏并排显示两端角色的头像。
- rolepage 消息头补齐头像: 收信方名字前带它的头像, 自己发的消息在头部最右带自己的头像; 点头像切到那个角色的视角。
- rolepage 一对一会话 (wizard 私聊、人的单聊、「只看我与 X」) 里自己发的消息头不再写收信方 —— 顶栏已是那个对端; 多人群里照旧标明。人的单聊顶栏同样并排两端头像。
- rolepage 气泡里随消息来的图片按原比例完整显示, 不再裁切。

### Fixed
- 企微图文混排消息里的图片下载超时放宽到 60s, 失败自动重试一次; 仍失败时在转给 agent 的文本里注明丢了几张图, 不再静默丢弃。
- rolepage 里带图的问话以 transcript 落盘的文本为准: 保留 CLI 插进去的 `[Image #N]` 占位, 在 CLI 里手敲的图文消息不再整条丢失。

## [2.1.3] - 2026-10-01

### Added
- rolepage 侧栏未读红点: 按时刻水位计数, 水位之后别人说完的话 (人说的也算) 记为未读; 默认水位取当前视角最后一次开口处, 看过的位置记在本地浏览器。

### Changed
- rolepage 保温 ping 折叠里的气泡描虚线边, 展开区的上内边距加大、下内边距收小。
- wizard 的 emoji 池去掉 🦞。

### Fixed
- **注入判框不再把 CLI 的灰字预测句当成已输入文本**: Claude Code 的 prompt suggestion 以 dim (SGR 2) 渲染, 纯文本读屏把它当成输入框里的内容 —— 一条 `commit` 命中预测句 `commit 这次改动…` 的子串, 被判成「上次已贴未提交」, 于是不贴只按回车, 消息静默丢失。输入框改为带样式读屏, dim 段整段剔除。
- rolepage 换视角的 FLIP 动画: 两边都在的气泡全部参与位移, 滚动锚在被点的那条上; 屏外被推进视窗的行不再闪现, 页头换高度不再半路顶动整列, 列内各块的相对位移不再跳。

## [2.1.2] - 2026-10-01

### Changed
- rolepage 侧栏私聊的预览不再带 `名字:` 前缀 —— 标题行已是对方, 只放正文。
- rolepage 换视角时气泡按消息做位移与底色的过渡动画; 过程框的收起 / 展开态与已取回的工具正文在切换中不再丢失。
- rolepage 侧栏群下的子项默认只露前 5 个, 第 6 位是固定的展开 / 折叠条。

### Fixed
- rolepage 的链接在企业微信里按 wizard 复用窗口 (`ww_uniq` 取 wizard 名字): 此前按聊天复用, 同一个群里不同 wizard 的链接挤进同一个窗口。
- rolepage 侧栏的预览与时间取自同一句话, 私聊 / 群聊 / 子项同一条规则。
- rolepage 的保温 ping 折叠按 wizard 分开计数: 群里几个 wizard 同时挂机时 ping 交错成一串, 旧折叠把它们相加 (6+6 显示 ×12); ping 的发话人记成 wezard, 不再算成人说的。
- rolepage 群内一对一视图找回保温 ping —— 按被保温的 wizard 归入这一对。
- rolepage 的 ping 折叠标题不再转大写 —— wizard 名字大小写敏感。

## [2.1.1] - 2026-10-01

### Added
- rolepage 里一句话尾巴上的 `<system-reminder>` (信封 / 点名 / 名册变动) 默认收成一个 `<reminder>` 标签, 点一下展开原文。

### Changed
- wezard 挂的 `<system-reminder>` 结构化: 事实写在开标签的属性上 (`wezard="envelope" kind from chat scope` / `wezard="mention" names` / `wezard="roster"`), 正文只留给模型的规矩 —— `read_chat` 按属性读回, 改措辞不再牵连解析; 没有属性的老 transcript 仍按原措辞认。
- 回复出来之后, 这一轮的工具调用过程框默认收起。
- 公开 `send_peer` 派来的那一轮, 回复进群时气泡头标出方向 `.me → .它` (与问话气泡的 `.它 → .me` 对称) —— 之前只有 `.me`, 群里看不出这段话是答给转派它的 wizard 而不是答给人的。引用这种气泡仍然路由到发话方。

### Fixed
- rolepage 侧栏里私聊的执行中灯从头像角挪到名字右边, 与会话子项对齐。
- 保温 ping 改为整句锚定匹配: `resumePing` 是一句 `continue`, 同伴或人说的「continue（接着干…）」不再被当成 ping 整轮吞掉。
- 保温的轮次预算把工具调用算作真实活动 —— 长串工具调用之后不再被误判为空闲; CLI 自己的 `Retrying in …s · attempt n/m` 页脚算忙, 不再给正在重试的会话排一句 `continue`。

## [2.1.0] - 2026-09-30

### Added
- MCP `read_chat`: 像人翻聊天记录那样读往来, 一行一句 `[时刻] 谁 → 谁: 正文`。三级收窄 `role` (谁的视角) → `chat` (哪个群) → `target` (和谁), 都不给即调用方这一轮所在的群; `since` / `until` / `limit` 按时间翻页。从各会话的 transcript 现拼 (不经 turn store): 每个来回取问话与终句, 不带工具调用; 频道与发话方读每句话挂着的信封。

### Changed
- 人从别的群叫到一个 wizard、或在多人的群里对它说话时, 那一轮尾巴上挂一段信封 (谁、在哪个群说的); 定时任务放的那一轮同样挂一段。住在单聊里的 wizard 在自己的单聊里被叫到时不挂。
- wizard 之间读信息的工具回**文本**不回 json: `wizard_roster` 一个 wizard 一行 (名字 / 忙闲 / 群 / 工作区 / 模型 / 多久没动 / 家谱, 另加职责与最近几句话), `peek_peer` 首行是状态、下面是对话, 最新一条回复给得最全。
- `peek_peer` 只读 transcript, 不再刮终端兜底; 「它卡在哪」由 transcript 回答 —— 不在转圈却悬着工具调用, 即停在审批卡 / 本地弹窗上。忙闲仍取自 pane 的转圈。
- 保温 ping/pong 从所有给 wizard 读的内容里剔掉: `peek_peer` 的对话、名册的摘要、graph 与交接用的「最后一条回复」。

- `read_chat` / `wizard_roster` / `peek_peer` 的回执收口: 名册的「最近」改成 `▸ 问 ◂ 答` (不再用指代不明的「你:」), 模型取 transcript 里真正跑的那个, home 聊天分「群 / 单聊」; `peek_peer` 的 `turns` 按来回数; `read_chat` 一条消息一行起头 (续行缩进), 没等到回答的问话标在行尾而不另占一条, 翻页时刻精确到毫秒, 往回到头了明说而不是照给游标; 带 role / target 过滤时读不够会自动往回加深。
- 名册与 `/peers` 摘要里被截断的句子带 `…` —— 之前是裸截, 读起来像它只说了半句。
- rolepage 的 markdown-it / highlight.js / 高亮主题随包分发 (`/chat/vendor.js`, 主题并进 `/chat/app.css`), 不再从 unpkg 取 —— 外网慢时 head 里的阻塞脚本会把整页卡上十几秒。脚本改 `defer`, 按 ETag 缓存。

### Removed
- MCP `list_peers`: 并进 `wizard_roster` (`chat` 写自己的群名即同群名册)。`/peers/list` 路由保留给仍在跑的旧 MCP 进程。

### Fixed
- `wait_peer` 在对方答完之后又被保温 ping 过一次时, 交回来的是那个 `pong` 而不是它的答案。
- **keepalive 的轮次预算不再被 daemon reload 清零**。`round` 只活在内存里, 每次 reload 从 0 起数 —— 一个闲着的会话跨 N 次 reload 会被 ping N × `rounds` 次而不是 `rounds` 次。现在起步值从 transcript 读 (`keepaliveStamps.streak`: 最后一条真实轮之后已经发过几次 ping)。

## [2.0.6] - 2026-09-30

### Changed
- rolepage 的回复不再是一张外层卡片: 终句 (不带工具调用的那次应答) 是一颗实线气泡, 去掉 `assistant` 标题行; 终句之前的 API 应答 —— 途中的话、工具调用、审批、子 agent —— 连着的收进一个虚线框, 框头写 `N 次工具调用`, 点框头或框内空白收起, 收起不改变框宽。框与气泡都按发话方着色。本轮的模型 / token / 耗时并进名字那一行, 隔着过程框的终句气泡头上再带一行自己的时刻与这串账; 工具行的时刻只报 `HH:MM:SS`。
- rolepage 会话里的气泡不再描实线边, 只靠底色分发话方: 当前视角的是视角色, 其余的是浅灰; 虚线的过程框保留。
- 工具调用的结果整段是 JSON (对象 / 数组) 时, 展开后按 input 同款的缩进与高亮排版显示; 原文仍收在 `result (raw)` 里。Read 的文件内容与 unified diff 照旧走各自的视图。

### Removed
- rolepage 入消息上的「公开」标记: 公开与否是会话窗口这一层的事 —— 公开的一句必在群窗、私聊的必在私窗, 在群窗里逐条标「公开」是个恒真的章。

## [2.0.5] - 2026-09-30

### Changed
- rolepage 侧栏群聊下的子项预览只显示消息正文, 不再带 `名字:` 前缀 —— 标题行已经是这个名字。
- rolepage 会话顶栏只显示名字, 不再带头像、成员行与「私聊 · N 条」副标题。
- rolepage 的回复不再是一张外层卡片: 每段话是一颗气泡 (去掉 `assistant` 标题行, 时刻挂到气泡外), 连着的工具调用 / 审批 / 子 agent 收进一个虚线框 —— 框头写 `N 次工具调用 · Bash ×5 · Read …`, 点框头或框内空白收起。本轮的模型 / token / 耗时压成末尾一行小字; 工具行的时刻只报 `HH:MM:SS`。

### Fixed
- **keepalive 的 pong 不再在 daemon reload 后漏进群**。吞没 ping 轮的两个开关 (注入时的计时窗、tail 读到 ping 行时的内容标记) 都只在内存里, 而恢复后的 tail 从 EOF 起读 —— reload 恰好落在 ping 与 pong 之间时, ping 行已在 EOF 之前, 两个开关都没了, pong 自己开出一轮发进群。现在多一道回复侧的判定: 没有吞没在持有、而到达的文本含 `pong` 时, 回 transcript 看最后一条 user 轮是不是 keepalive ping (`peers.openKeepalivePing`, 与 `keepaliveStamps` 同一套签名), 是就从这一条起吞到 `turn_end`, 照旧记成带标记的保温轮。判据落在 transcript 上而不是这个词上: 真回答里提到 pong, 它前面是一个真问题。
- rolepage 侧栏的预览不再留白: 最后一轮只有工具调用、或还在跑没吐字时, 预览越过它落在最后一条有正文的消息上 (子项、群聊行、私聊行同一条规则); 时间仍是最近活动的时间。
- **pane 上限 (`maxPanes`) 数不到孤儿 pane**: 上限只数「有绑定指着的 pane」, 而绑定一旦丢了 pane id (2.0.4 修掉的 `-u` 问题让 restore 认不出 pane → 下一条消息另起新 pane, 旧 pane 不杀), 旧 pane 就既没人叫得到、也不在账上, 攒了几十个也触不到上限。sweep 现在先收掉 daemon 自己 tmux session 里没有任何绑定指着的会话 pane (会话注册表认得里面住着活的 AI 会话才算, 普通 pane 一律跳过; 静默 10 分钟以上; 正忙 / 人正盯着的照旧不收), 不占名额、不等超限。
- **正文里提到的 wizard 名字不再抢走路由**: 一条消息只做前缀匹配 —— 清洗之后 (链接标记还原成裸 `.name`、@ 剥掉、去掉开头的空白与不可见字符) 落在消息**开头**的那个 `.x` 才是目标, 认不认识都算 (不认识 = 叫一个新 wizard 出来); 正文里的 `.fix` / `.gitignore` 一律只是提及, 哪怕名册里真有这个名字。此前「第一个解析得出的已知名字」胜出, 一句话里顺口提到另一个 wizard 就会被送错地方。引用消息同一条规则。

### Removed
- **rolepage 群聊顶栏的跳转按钮**: `wxwork://openconversation` 的 `roomid` 要的是客户端内部的数字群 id, 而智能机器人的消息 / 事件帧里只有字符串 `chatid` (`wr…`, 单聊连它都没有), 也没有可反查的接口 —— 按钮拼出来的链接跳不了。

## [2.0.4] - 2026-09-30

### Added
- **wizard 间的每一轮都带信封**: `send_peer` / `clone_wizard({task})` / `spawn_wizard({task})` 注入的文本尾部挂一段 `<system-reminder>`, 写明发话的是哪个 wizard、私聊还是公开 (公开轮带群名)、回执怎么交 (私聊 = 这一轮的最后一条消息, 收口成 `RESULT: …`, 不再 `send_peer` 回去、不 `notify`、不对 wizard 寒暄)。此前同伴的话是裸文本, 收件方分不清它是人说的还是 wizard 说的。信封不进气泡 / rolepage / `peek_peer`; slash 命令不挂。
- **MCP 工具 `set_model`: 给一个已经在跑的 wizard 换模型** (默认换自己, `name` 点名换别的)。口语化写要什么 (`opus` / `sonnet 5` / `最新的 fable` / `默认`), `scope` 选生效范围: `session` (默认, 只换这一个会话) / `default` (同时设为此后新会话的默认模型)。返回 `model` (真正落地的那一项)、`scope` (实际落在哪一档) 与 `catalog` (这台 CLI 此刻的全部模型)。新路由 `POST /wizard/model`。落地的模型记进绑定, 之后被重启也回到它上面。
- **rolepage 群聊顶栏的群名旁加跳转按钮**: `wxwork://openconversation` 直达企业微信里的这个群。只有真群 (`chat:<roomid>`) 才有 —— 人与 bot 的单聊没有可跳的会话。

### Changed
- **BREAKING `wait_peer` 的返回瘦身并与发话对上号**: 只认调用方上次 `send_peer` (或 clone/spawn 的 `task`) **之后**的回复 —— 对方停下了却没有新回复时回 `stale: true`, 不再把上一件事的答案交回来 (分身也不再把被克隆者的旧回复当成自己的)。收口了 `RESULT:` 就只回 `result` (从全文摘取, 不再受 4000 字截断影响) + `omitted`; 没收口才回 `lastText` (保留换行, 超长掐中间保住头尾)。只等一个时结果摊平在顶层, 等一组才有 `results`; `target` / `foreign` / `address` 字段移除, 名字在 `name`。`send_peer` 的返回同样去掉 `target` / `foreign` / `when`。
- **宪章里的同群名册压缩**: 与自己同工作区的不再重复路径, 既没写职责又同工作区的并成一行名字。
- **新建会话到首条消息提交少等约 1.5s**: 粘贴后不再固定睡 (冷启动 1500ms / 热 pane 400ms), 改成每 50ms 查一次「内容已落进输入框且不再变」, 一满足就回车; 原来的时长降为上限, 到上限照旧回车, 输入框认不出来时维持固定等待。新 pane 的就绪判定走注册表时轮询间隔从 400ms 收到 100ms (读屏那一路节奏不变)。
- **选模型改成驱动 `/model` 列表本身, spawn 与 `set_model` 共用一条路**: 打开 pane 里的 `/model` 列表 → 滚动读出全部条目 → 挑与请求最接近的一项 (家族必须对上, 版本号只参与排序, 同分取更新的) → 方向键逐步移到那一行 (每步回读光标) → 选中 → 读回执。不再先盲敲 `/model <名字>` 再猜: 列表里显示的名字 (`Opus 4.7`) 并不是 `/model` 认的名字。选中键就是生效范围: `s` = 仅本会话, Enter = 同时设为新会话默认; spawn 一律走「仅本会话」—— 一个 wizard 换模型不再改掉 `settings.json` 里新会话的默认模型。`spawn_wizard` / `clone_wizard` / `new_claude_session` 返回的 `model` 相应变成列表里的条目名 (如 `Opus 5.5`)。
- rolepage 用量条条首的「用量」标签改成具体模型名, 右端原来的模型一项移除。
- rolepage 的关系图 / 日程入口改成灰色文本按钮, 中间一条分割线, 不再撑满整行。

### Removed
- **单轮详情页 (Turn Details) 及其入口**: rolepage 每张 turn 卡片头上的 `↗` 链接移除, `/detail?id=<turn id>` 不再渲染整页 (回「未找到」) —— 一轮的全部内容本来就在 rolepage 的卡片里。`/detail` 仍服务工具调用与审批详情。

### Fixed
- **多行的 `send_peer({public:true})` / 定时任务提示, 对方的回复不进群**: Claude Code 2.1.27x 起把折叠的粘贴在 transcript 里包成 `<pasted_content>`, 注入的回显去重因此对不上, 这一轮被认成「人在 CLI 里敲的」而被 `chatOriginOnly` 挡在群外 (频道其实是对的)。去重两侧改用同一个规范形 (剥掉粘贴壳与尾部 system-reminder); `peek_peer` / `wait_peer` / 摘要 / rolepage 的 query 同样不再带这层壳。宪章新增一段说明: 整条消息都在 `<pasted_content>` 里时它就是发话人本人的话 —— 此前 wizard 会把派来的指令当成「粘贴的资料」而搁置 (如不肯 push)。
- spawn 时指定 `model` 经常落空并报「/model 没有按预期方式回应」: 回执改为轮询等待 (此前固定等 0.8s 就读屏), 并处理「Switch model?」缓存提示的二次确认。
- **launchd / systemd 下 daemon 认不出任何 tmux pane**: 这样起的 daemon 没有 `LANG` / `LC_*`, tmux 把它当非 UTF-8 client, `-F` 输出里的 tab 被洗成 `_`, 按 tab 切的 boot 恢复 pane 快照 / pane 漂移跟随 / pane 上限 (`maxPanes`) 全部失效, 而带 locale 的 dev shell 里一切正常。`runTmux` 一律带 `-u`。

## [2.0.3] - 2026-09-30

### Changed
- **rolepage 的头像与名字都是进入那个 role 视角的入口**: 侧栏的私聊项 / 群下子项、会话头、消息行 (发言人与 `→ 对方`) 一律可点, 不必先选中; 侧栏选中项上那颗换视角的小图标移除。点行的其余位置仍是选中会话。
- **stream 气泡超时收口改成一句中间结束语**: 一轮跑过 WeCom 的 ~6min stream 窗口时, 气泡以 `⏳ 仍在处理中, 点击链接查看详情…` 收口 —— brief 下不再定格在最后一行 CoT 进度上, 非 brief 下缀在已有正文之后 (没正文时也不再留着 loading 气泡等它自然过期)。已被新消息顶替的旧轮照旧只留链接。

## [2.0.2] - 2026-09-30

### Added
- **rolepage 显示 wizard 是否在执行中**: 左栏会话列表里, 私聊对端与群里的 wizard 在执行时头像角上亮一盏呼吸灯; 名片上多一个状态词 (执行中 / 空闲 / 已关闭)。判定 = pane 的 busy 或 turn 记录还没静默到点 (`/api/role` 与 SSE `role` 事件: `role.runningUntil`, `convs[].status` / `convs[].subs[].status`), 到点由页面本地熄灯。SSE 每 10s 带着新名册重推一次摘要 —— busy 变了不写 store, 没有这一拍灯会一直亮着。

### Changed
- **BREAKING 闲置 pane 回收从「静默超过 48h」改成「超过 pane 上限」**: 配置项 `wrc.mirror.idleReapHours` 移除, 换成 `wrc.mirror.maxPanes` (默认 20, 0 = 关闭)。每新建一个 wizard (`/new`、`.name` 隐式新建、`spawn_wizard` / `clone_wizard`) 数一次, 活着的会话 pane 超过上限就从 transcript 最久没动的收起, 直到回到上限 —— 不再有定时扫描; 照旧只收 pane 不收绑定, 下一条消息 `--resume` 复活。豁免不变 (名下有定时任务 / 挂着审批 / 正忙 / 人正盯着的), 所以实际数量可能暂时高于上限。旧配置里残留的 `idleReapHours` 被忽略。
- **rolepage 的消息分两级下发, 首屏不再带工具调用正文**: `/api/msgs` 与 SSE `msg` 片段里的工具调用只剩摘要行 + ⎿ 预览, 展开正文 (命令 / diff / 文件内容高亮、input、原始 result) 在展开那一刻向新路由 `GET /api/tool?id=&turn=&use=` 取, 取到后留在节点上不重取。`/api/msgs` 同时改为先按时间切片再渲染, 没上屏的轮次不再白排一遍。一个约 300 条消息的窗口: 首屏 60 条 1.27 MB → 107 KB, 全量 7.38 MB → 967 KB。`/detail?id=` 整页不变, 仍是全量内联。
- **rolepage 的用量改成一条页脚组件, 宽屏单行**: 标签 · 指标 · token I/O 条 + 图例 · 模型 一行排完, 窄屏整组折行; 输出 / 缓存不再单列成指标 (就是图例里的那几格)。挂载点跟着账的归属走 —— wizard 视角是横跨两栏的整页页脚 (它自己的总账, 选了 session 只算那一段); 人的视角在群里点开某个 wizard 后, 聊天窗口底下是「我与它在这个群里」这段往来的账 (`/api/role` 与 SSE `role` 事件新增 `winStats`)。左栏底只剩 session 切换。
- **创建同名 wizard 时, 静默超过一天的旧 wizard 直接被顶掉**。`/new`、`new_claude_session`、`spawn_wizard` / `clone_wizard` 撞上的名字若属于一个最后活跃在 1 天前的 wizard (transcript mtime; 没有会话的冷记录按出生时刻), 新的直接拿走名字, 不再退避成 `-N`, 也不再 409 —— 分身整个收掉 (pane、绑定、记录), 聊天的默认会话只让出名字。一天内还活动过的照旧 409 / 退避。

### Fixed
- **工具调用到一半被新消息打断时, 结果不再落进新一轮的气泡**: `tool_result` 改投到持有那次 `tool_use` 的 turn (`detail-store.appendTurnItem` 按 `toolUseId` 找主, 找不到才写当前轮) —— 旧轮的调用拿到结果, 新轮顶上不再多出一个无主的 `tool_result` 块。轮已结束而结果始终没回来的调用, ⎿ 预览显示「已中断 · 无结果」, 不再永远挂着「运行中…」。
- 群里写 `.foo` 隐式新建 (或 `.foo /new`) 时, 若内部 slot `#foo` 被一个改过名的冷 wizard 占着, 新 wizard 的名字不再跟着 slot 退避成 `foo-N` —— slot 照旧挪位, 名字按人写的落定。

## [2.0.1] - 2026-09-30

### Added
- **聊天的默认 wizard = 这个群的管家**。宪章多一段守则: 没点名的话由它分派 —— 小事自己答, 对口已有 wizard 的 `send_peer({public:true})` 转交 (回复直接进群, 管家不等不转述), 没有对口的 `spawn_wizard` 从白板生一个再转; 长活一律转出去, 管家的上下文只留给名册和分派。点了名 (`.name`) 的话照旧直达, 不经过管家。
- **记忆整理者** (`daemon/memory-steward.ts`): 一条内置定时任务 `~/.wezard/tasks/memory-steward.task.mjs` (缺失时开机补写, 已有不覆盖), 每 30 分钟 gate 认领记忆收件箱, 有提议才新起一个白板 wizard 按 新增 / 改写 / 删除 / 不动 合并进 md, 处理过的提议归档进 `~/.wezard/memory/log/`。

### Changed
- **BREAKING `spawn_clone` 拆成两个工具: `spawn_wizard` (从白板生一个子 wizard, 不带上下文, 可换 `cwd`) 与 `clone_wizard` (fork 一个 wizard 此刻的上下文出分身, 默认是自己; `from` 点名可克隆别的 wizard —— 分身仍归调用方管, 家谱多记一笔 `forkOf` 说明上下文从谁来)**。生孩子与克隆是两个操作, 不该是一个 `inherit` 布尔的两档 —— 模型该选的是动词。两者落到同一条 `/wizard/clone` 路由, 已在跑的 wizard 的旧 MCP 进程照常能用。
- **群 / 工作区记忆只有一个写入者**: `wizard_remember({scope:"chat"|"workspace"})` 不再直接追加 md, 改为往 `~/.wezard/memory/inbox/` 投提议 (记下提议者与时刻), 由记忆整理者合并。此前几十个 wizard 同写一份文件, 只会越来越长、互相矛盾; `self` 作用域照旧直写。人照旧可直接改 md。
- 宪章里每份共享记忆上限 4000 字, 超出截断并给出全文路径。
- `wezard init` 开头先探 tmux, 没装直接报错退出 —— 会话只跑在 tmux pane 里, 不再等装完 daemon 才发现。

### Removed
- **BREAKING 删除 `/wrc` 命令**: `/wezard:wrc` slash command、`wezard mirror` 子命令、MCP 工具 `wrc` 与 `POST /mirror/attach` 路由一并移除。mirror 会话只从聊天侧开启 (首条消息自动起 pane、`/new`、`.name`、`switch_claude_session`); 配置键 `wrc.*` 不变。
- **BREAKING 删除 headless 模式**: `daemon/cc-bridge.ts` (每条消息起一个 `claude -p`)、`daemon/sessions.ts` 与配置项 `wrc.mode` / `wrc.sessionMapFile` 移除, daemon 只剩 mirror 一条路; `wezard init` 不再问模式。旧配置里残留的这两个键被忽略 —— 原先 `mode: "headless"` (也是旧默认值) 的部署升级后直接走 mirror, 需要本机有 tmux。

## [2.0.0] - 2026-09-29

### Added
- **闲置 pane 自动回收** (`wrc.mirror.idleReapHours`, 默认 48h, 0 = 关闭)。transcript 静默超过阈值的会话, daemon 每 30min 收掉它的 tmux pane 释放内存与 fd (jsonl tail / subagent watcher 一并 detach) —— 但**保留 store 绑定**, 下一条消息走现成的 dead-pane `--resume` 自愈复活, charter 重新压入, 对话不丢: reap 是"睡着", `/kill` 才是"死了"。豁免: 名下有定时任务的 wizard (调度会唤醒它)、挂着审批长轮询的会话 (hook 还在等点击)、正忙的、人正盯着的 window (`window_active:session_attached`)。keepalive 会话天然豁免 (ping 每几分钟刷新 transcript, 永远到不了阈值)。闲置判据先走 transcript mtime (一次 statSync), tmux 探活只发生在少数 idle 幸存者身上 —— 与 worldPeers 的 WORLD_PROBE 同一取舍。
- **BREAKING wizard 的名字全局唯一, 寻址从 `#tag` 改成 `.name`**。名字不再跟着聊天走 (`chat#tag`): 每个 wizard 有一个全机唯一的名字, 它就是地址 —— 群里、气泡头 (`🦊 .fix`)、工具参数、名册一律写 `.name`。聊天的默认会话取聊天名, 分身取自己的 slot, 撞名挂 `-N`。内部 key (`chat:xxx#slot`) 不变, 改名不搬会话; 启动时一次性把已有 wizard 迁到全局名字 (默认会话先挑)。老 `#tag` 气泡仍可引用路由。MCP 工具的地址参数 `tag` → `name` (`fix` / `.fix` 都认; 守护进程继续接受老字段, 正在跑的 wizard 不受影响)。
- **任意群可 `.name` 叫任意 wizard, 回复回到发话的那个群**。turn 记录新增 `channel` (公开频道的 base) 与 `speaker` (发话人); 本轮的回复与审批/提问卡都推到 channel, 不再固定回 wizard 的 home 群。
- **群 = 公开频道, wizard 之间默认私聊**。`send_peer` 新增 `public` —— 需要人知道、该在公开频道讨论的由模型自己决定公开, 此时群里出 `.a → .b` 气泡、回复也进群; 默认私聊不出任何气泡, 只落在双方的 rolepage。派活回程与分身出生气泡取消, 工单开/收工与 `notify` 保留。
- **群记忆 / 工作区记忆**: `~/.wezard/memory/chats/<base>.md` 与 `~/.wezard/memory/workspaces/<cwd>.md`, 人可直接编辑; `wizard_remember` 新增 `scope: self | chat | workspace`; 每个 wizard 出生时两份都注入宪章。
- **定时任务跟随 wizard**: 任务文件新增 `owner` (排班的那个 wizard), `schedule_task` 自动填, `list_tasks` 回显; 白板 runner 以 owner 为父。
- **BREAKING chat 详情页 → rolepage** (`/role?id=…&role=…`, 老 `/chat` 链接照旧打开): 展示**一个 role 视角**的 IM —— 侧栏是它参与的群聊与单聊 (与人 / 与 wizard 私聊), 选中群时子项列出群里其他 role, 点开即它与该 role 在这个群里的往来; 本人发的靠右、收到的靠左, 点气泡对侧空白切换到对端视角; 顶栏是身份 / cwd / 创建时间, 多个 session 时可切换, 有关系时出「关系图」入口, 另有「日程」入口 (名下定时任务与工单)。任一有效票据可看全部 role。
- **新聊天的工作区从「默认兜底」变成「人确认过」**。一个新群的第一个 wizard 落在 `wrc.cwd` 这个默认目录里 —— 那不是人选的, 只是还没人说过, 而此前没有任何东西区分这两件事, 于是它就在那个目录里把活干了, 人发现时已经晚了一轮。现在这件事有状态: `cwdConfirmed` (聊天级, 与 cwd/pendingCwd 同挂在 base principal 上), **默认按「还要换」办** —— 宪章据此多一段, 要求新 wizard 开工前先问一句「要在哪个项目目录下干活」。人给了路径就照旧 `set_workspace({cwd})` 换目录重开; 人说「不用换」就走新增的 **`set_workspace({keep:true})`**: 只记一笔确认, 不重开会话、不动上下文, 此后谁都不再问。**只有这一个写入点** —— 换去别的目录本身就是一次选择, 那时 runningCwd 已经不等于默认目录, 询问条件自然不成立, 不必再记。`/pwd` 一并回显这个状态。
- **BREAKING 一条定时任务从 config 里的一行记录, 变成一份可注入代码的配置文件** `~/.wezard/tasks/<id>.task.mjs`。旧形状把"什么时候"锁成三选一的枚举 (`daily` / `every` / `once`), 而 wizard 只能隔着人话解析器去碰它 —— 碰不到的说法就做不到: 「白天每隔一个小时」是**两件事的交集** (每小时的时钟 ∧ 08:00–20:00 的筛子), 枚举里无处安放, 只能退化成每小时都放一枪、再在 prompt 里写「先看表, 不在白天就退出」—— 夜里每小时白起一个 pane 加一份上下文, 就为了让它看一眼时间。更做不到的是「有活才干」: 「拉到新 trace 才编排 wizard 处理」在旧形状里只能写成"到点先生一个 wizard 让它自己去拉", 拉空的那些轮次全是纯浪费。
  - **触发条件改成可组合的规约** (`shared/trigger.ts`, Specification + Interpreter): `every("1h")` / `daily("09:00","18:00")` / `at(…)` 产生时刻, `between("08:00","20:00")` / `onDays("工作日")` / `not(…)` 只做筛选, `and(时钟, …筛子)` 组合。是 AST 不是闭包 —— 它要能回显给人看 (`每 1 小时 · 08:00-21:00`)、能算下次触发 (时钟给候选, 筛子挑第一个过的)、能在详情页画出来。人话入口照旧: 「白天每隔一个小时」「工作时间每半小时」「8点到20点每小时」现在都解析得出。
  - **新增 `gate`: 放枪前在 daemon 侧先探一眼**。一段异步函数, 拿得到 `sh(cmd)` (默认在目标 wizard 的工作区跑)、跨轮的 `state`、`log`; 返回 `false` 这一轮就不放枪 —— 不起 wizard, 群里也不出声; 返回 `{vars}` 填进 prompt 里的 `{{名字}}`。「有新东西才处理」这类循环任务从此花几秒钱在 daemon 里问清楚, 而不是花一个 pane 去问。gate 跑在**子进程**里并带超时: 它是用户/wizard 写的代码, 卡住一个 gate 不能等于全机定时一起停摆; 超时、抛错、崩溃三者同义 —— 这一轮不放枪, 下一轮照常。gate **出错**会往群里说一次 (只在由好转坏那一次), 因为一个坏掉的 gate 每轮的沉默和"今天没活"长得一模一样, 最坏的失败是看不见的失败。
  - **文件就是配置, 热加载**: wizard 用 Read/Edit 直接改, 存盘即生效, 不用 reload 守护进程; 改坏了的文件带着理由出现在 `list_tasks` 里 (`loadError`), 并保住上一版继续跑 —— 一个语法错误不该让一条定时凭空消失。`enabled:false` 暂停而不删。源码归源码、状态归状态: `lastFired` 与 gate 的跨轮记忆写在 `~/.wezard/task-state.json`, 不回头覆盖 wizard 刚编辑过的文件。
  - `schedule_task` 仍是最常见那条路的快入口 (什么时候 + 说什么), 新增 `id` 参数决定文件名; 返回值与 `list_tasks` 都回显 `file`, 那是 wizard 继续往下改的地方。老的 `config.jsonc` `schedules` 在守护进程启动时就地抬成任务文件并清空 —— 两处都留着会放两次枪。
- **`spawn_clone` / `new_claude_session` 新增 `keepalive` 参数** —— 可以让某个分身/wizard 永远不被 prompt-cache keepalive 心跳保温, 省下跑腿一次就收工的临时分身那份 ping 的钱; 省略则按新配置项 `wrc.mirror.keepalive.spawnDefault` (默认 `true`) 来。和 `/stop` 那种"直到下一次真活动才恢复"的临时暂停不同, 这是终身粘住的 (`keepaliveDisabled`, 随 `model` 同款的 carry-over 规则持久化, 幸存 daemon reload)。
- **chat 详情页从"一个聊天的线程"扩成三栏: 线程 / 关系 / 日程**。原先那一栏只回答一个聊天内部的问题 (有哪些 `#tag`、某一路的时间线长什么样) —— 它的第一步就是 `baseOfKey === base`, 于是 wizard 之间**跨聊天**的那些关系一条都画不出来: 谁是谁的分身、谁在驱动谁、哪几个属于同一个工单、谁被排了定时。
  - **关系**: 不按聊天切, 按关系切。两种读法一个开关:「卡片」把聊天画成卡片 (归属)、分身按家谱缩进 (层级), SVG 只画布局表达不了的边 —— 跨卡片的分身、同群与跨群的派活、流水线的一步;「关系网」只画 wizard, 聊天收进节点自己 (色条 + 群名), 位置交给力导向。图例同时是开关, 「只看有关系的」把此刻不属于任何关系的收起来, 剩下的就是这张协作网本身。
  - **日程**: 定时任务与工单摆在一起 —— 它们回答同一个问题「什么被安排了」, 区别只在时间的方向 (定时指向未来, 工单指向现在)。顶上是未来 12 小时的刻度条。
  - **侧栏补上身份**: 每一行从裸 `#tag` 变成 wizard 的名字 + 一句职责 + `↳ 分身自 X` 的出身。
- **turn 记录新增出处 `from` (`shared/detail-store`)** —— 这一轮是**谁开的口**: 同伴 `send_peer` 派的、工单 fan-out 派的、定时任务放的枪; `undefined` = 人直接说的。此前只有 graph 有归因 (`origin`), 而 peer 派活是协同网络里最常见的那种边, 却在数据里一点痕迹都没有: 一条 9:30 自动跑出来的轮次和真人发言长得一模一样。和 `origin` 一样走 append-only JSONL 跟着记录过夜, 所以独立 svr 收到 POST 之后画出来的图与本机一致。
- `GET /api/world` (daemon 与 svr 共用) + `shared/world.ts` 的纯折叠。注册表侧的事实 (身份 / 家谱 / 工单 / 日程) 由 daemon 以 provider 注入, svr 拿不到就退化成只画观测到的往来。**正文仍然按聊天关**: 外聊天的节点只有身份与关系, 没有线程、没有对话预览 —— 拿到一条链接看得见拓扑, 读不到别的群的内容。
- **关系图新增「关系网」布局 (力导向)**。卡片布局把归属和层级交给版面, 代价是聊天必须张张画出来: 一个只出了一个分身的群也占一整张卡, 而跨聊天那条边得横穿半张图去找对面 —— 群一多, 卡片就把图撑成一堵墙, 而这张图存在的理由恰恰是"谁在跟谁协作"。新布局换一个折叠轴: 节点只画 wizard, **聊天不再是容器而是节点身上的一道色条 + 一行群名**, 于是位置腾出来交给力 —— 同群相吸自然成簇, 分身的弹簧比派活的短, 家谱仍然读得出来。手写的力学, 无依赖: 斥力 + 弹簧 + 同群内聚 + 朝心收, 外加一轮**矩形**避让 (节点是一行字不是一个点, 圆形斥力挡不住两张卡横向叠在一起, 而这张图的全部价值就在那行字读得出来); 静息长度有个按卡片半宽算的下限, 否则两端贴到一起时连线被两张卡各自吃掉一半, 箭头都放不下。坐标按 target 存活, 6 秒一次的轮询重画 DOM 但不重新点火; 拖动即钉住 (位移 < 5px 仍算点击 = 聚焦), 「↻ 重排」松开全部钉住的节点。选哪种读法记在 localStorage。
- **chat 详情页左上角写聊天的名字**, 不再是那句「会话列表」。侧栏头与顶栏都写一遍: 手机上一进来就是阅读态 (侧栏整个隐藏), 顶栏是唯一还能说清「这是哪个群」的地方 —— `#tag` 退到名字后面当地址。名字只有 `/api/world` 给得出 (`chatNames` 在 daemon 的注册表里), 没回来之前退回原来的静态标题, 不闪空白。
- **连续的 keepalive 保温轮次折成一行 `🏓 ×N`**, 点开才是详情。保温 ping 记成了一轮 (那份花销是真的), 但它不是对话: 挂机一晚能攒出几十轮 ping/pong, 在时间轴上与真实对话等宽排开, 真正说过的话就被挤出了屏幕。服务端只给一个 `.ping` 标记 (`chat-view.isKeepaliveTurn`, 按**形态**认而不按配置认 —— 独立 svr 没有配置, 历史记录里的 ping 文本也可能来自改过的旧配置; `resumePing` 那种「continue」是真的在推进工作, 不折), 折哪几轮由客户端定 —— 只有它知道相邻是谁。折叠只**搬运**既有节点, markdown 渲染态与工具展开态都不丢; 中间夹一轮真对话就断成两段。
- `shared/std.ts` 新增 `mapLimit` —— 带并发上限的 `Promise.all`。凡是 `f` 会 spawn 进程或开文件的, 就不该用裸 `Promise.all` (见下面那条事故)。
- **`POST /w`: daemon 把注册表快照 (身份 / 家谱 / 工单 / 日程) 定期推给 svr**。turn 记录是一条条 `POST /d` 推过去的, 但注册表不是"发生的事"而是"当下的状态", 没有增量可推 —— 于是远端浏览的关系图一直挂着「名册缺席」, 日程栏更是**永远空的**, 而那恰恰是最该被远程看一眼的东西。现在 30s 一份整快照 (一个开着的浏览器本来就 6s 问一次 `/api/world`, 这个频率比它轻五倍), 按**来源机器**分开存: 一个 svr 可能同时接着几台 daemon, 覆盖式写会让先推的那台凭空消失; 读的时候合并, 150s 没再推的来源自动淡出。快照只在 svr 的内存里 —— 它是 daemon 那边的投影, 落盘只会换来一份过期名册在冷启动那几十秒里冒充现状。
- **关系图上双击别的聊天的节点 = 走进那个群**。`/api/world` 的每张聊天卡片现在带一张那个群**既有**的票据 (`chats[].token`: 长期票据优先, 否则借那个群最近一条 turn 的 id), 卡片头也可点。这是对 `/api/world` 那条 capability 说明的一处明说的放宽: 一张看得见的拓扑图点不进去就只是一张画, 所以「拿到一条链接 ⇒ 看得见整张网」后面补上「并且可以顺着网走到相邻的群」。给的是既有凭据, 不新造、不降低强度, 进去之后照常按那张票据的聊天关 (`/api/thread` 的 `authorizedTarget` 不动)。要把正文严格关在一个群里的部署, 不该开放 `/api/world`。
- **BREAKING `schedule_task` 默认到点新起一个白板 wizard 执行, 不再注入任何已有会话**。这个工具的 prompt 设计上本就要求"零上下文也能执行"(到点时目标可能早已 `/clear` 过, 它只看得见这一句) —— 既然如此就没有理由非挤进某个常驻会话: 挤进去把两件不相关的事压进同一个 transcript, 目标那时正忙还会连触发时刻一起被它那一轮拖走。现在到点新起一个白板 wizard (`#<tag>-<taskId 前4位>`) 跑这条自洽 prompt, 跑完自动回收, 群里补一条通知说明"为什么多了个陌生 tag"。**只有排班时用 `tag` 点了名** (用户明说「让 #foo 每天…」「在 #foo 里继续」) 才投进那个已有会话, 且它当时正忙仍退回白板执行。点了名也**不一定**是续: `prompt` 自己在说「在 auto 聊天里建两个 wizard…」这种话时按新建办 (`promptWantsFreshWizard`, 否定说法「不用新建 wizard」不算) —— 那种 tag 只是「在谁的聊天/目录下办」, 这条推断放在 daemon 而不是指望排班的模型每次记得传参。`fresh` 参数可以显式压过这条推断: `tag` + `fresh:true` = 拿它当模板 (继承聊天/cwd/模型) 另起一个干。老记录 (`fresh` 缺省 = false) 语义不变, 照旧注入原目标。`list_tasks` 新增 `runIn` 回显这一条到点去哪儿跑。

### Changed
- **群里出现的每个 `#tag` 都是一条链接**, 点开即那个 wizard 的 chat 详情页。此前只有 mirror 正文气泡、卡片前奏与 relay 的头挂了链接, 其余出站路径 (`/peers` 等命令回复、notify、定时任务、spawn/stop 通告、审批批量提示、graph 步进、MCP `send_markdown`) 走裸 `withTagHeader`, 正文里提到的 `#fix` / `daily#fix` 更是一律不可点。现在 `session-label` 由 daemon 注入一个 `TagLinker` (`bindTagLinker`): `withTagHeader` 默认就挂链 —— 新增调用点不必各自去取票据; 正文里指向**已知** wizard 的 `#tag` / `chat#tag` 经 `linkTags` 挂链 (代码块与行内代码放过, 同一 tag 只挂第一次, 每条最多 `MAX_BODY_LINKS` 个 —— 一条 URL 两百来字节, mirror 的分片预算 `TAG_HEADER_BUDGET` 按「头 + 这么多个」相应放大)。`parseTagHeader` 把正文链接还原成裸 tag, 引用比对与贴进 prompt 的内容不带 URL。卡片标题 (含投票卡) 不支持链接, 只挂 emoji, 它的 tag 链接在卡片前那条 markdown 的头上。
- **rolepage 的气泡收了一轮**: ①**时刻挪到气泡外**, 跟着名字写在归属行上 (等宽数字、hover 出完整时间), 气泡内与卡片头上那两份时间不再重复 —— 一条消息只报一次时间; 归因位没有 chip 要说时整行省掉, 不留空的内边距。②**连着的几次工具调用挤到一起** (`.bubble.tool` 相邻间距 14px → 5px): 它们是一串动作而不是几段话, `.bubbles` 那 14px 的段间距留给真正换了说话内容的地方。③**自己发出的那条整块就是视角色**: TURN_CSS 里写死的白卡/灰底 (嵌套气泡、代码块、折叠头、tile) 在蓝底上显成一张张贴纸, 现在一律收回气泡自己的底色, 需要再沉一档的走新增的 `--mine-soft`。④标题不再写实现名 `rolepage` —— shell 是「对话现场」, 进页面后变成**「<名字> 的视角」**, 切视角时跟着换: 这一页的主张本来就是"你此刻站在谁的位置上"。
- **chat 详情页的「关系」「日程」挪到聊天之外**。它们画的是全部聊天的 wizard、工单与定时, 却一直套在某一个聊天的框里: 左边挂着本群的会话列表、底下是当前那一路的总账、顶栏写着本群的名字 —— 读起来像是「这个群的关系图」。现在切到这两栏就走出聊天: 侧栏与页脚收起, 顶栏只写视图名; 切回「线程」才回到这个聊天。

### Fixed
- **rolepage 上保温 ping 被整条抹掉了**。`🏓 ×N` 那条折叠是给旧的 chat 详情页写的, rolepage 换了行模型之后折叠代码没跟过来, 于是 `convTurns` 里那句 `!isKeepaliveTurn` 成了唯一的处置 —— ping 直接从时间轴上消失, 读起来像那几个小时什么都没发生, 而那份花销在页脚总账里照记。现在 ping 重新进消息流, 片段上带一个 `ping` 标记, 客户端把相邻的整串 (一次 ping 落成问 + pong 两行) 收进一条虚线, 中间夹一轮真对话就断成两段; 折叠只**搬运**既有节点, markdown 渲染态与工具展开态都不丢。会话列表那边仍然当它不存在 —— 条数与预览不该被 pong 顶掉。
- **卡片前那条消息的头不可点**。提问卡/计划卡前面那条 markdown (题目全文 + ABCD 选项, vote 卡自己吃不下正文) 走的是 `withTagHeader` 的裸 `emoji #tag`, 而同一个 wizard 的正文气泡早就是 `[emoji #tag](chat 详情页)` —— 偏偏是这条最需要点进去: 一张卡问的是什么、之前那一轮为什么问到这儿, 全在详情页上。现在卡片前奏与流程里的提示气泡 (超时/失效/驱动失败) 统一走新的 `withLinkedTagHeader`, 票据取该 wizard 最近那条 turn, 取不到退到聊天级长期票据, 都取不到才退回裸头。顺带把三处各写一遍的「头 → 链接」收成 `shared/session-label` 的 `linkedTagHead` / `withLinkedTagHeader` 与 `detail.chatUrlFor` 两个口子。
- **换工作区重开之后, 新 wizard 的宪章里写的还是旧目录**。宪章的工作区来自 `getCwd`, 而 attach 发生在 spawn **之后** —— 渲染那一刻记着的还是上一个 pane 的目录, 于是 `set_workspace` 重开出来的会话在系统提示里一辈子以为自己在旧项目下 (`new_claude_session({cwd})` 生出来的同理: 那个 cwd 只在 spawn 参数里, 注册表还不知道)。现在 spawn 路径把「正要启动的那个目录」随宪章一起传进去 (`setCharterProvider` 的 `ctx.cwd`), 渲染按它来 —— 也正是这条让「还没确认过工作区」不会在刚换好的目录里继续追问。
- **量词「个」让整句定时解析不出来**。`每隔一**个**小时` / `每隔两个小时` / `每半个小时` 里的量词卡在数字与单位之间, 正则要求两者相邻, 于是最自然的那种说法直接报"无法理解"; 中文的「每小时」更是压根没有分支 (英文的 `every hour` 反而能认 —— 数字在那边是可选的)。现在量词被吃掉, 中文也允许省数字 —— 但省数字时只认「小时」类: 「每天」是日程不是间隔, 咬住它会把每天 9 点变成每 24 小时一次。
- **`wizard_handoff_self` 目标一直忙时静默放弃, 群里零通知**。这个工具应答之后是 fire-and-forget: 应答里已经给了 `scheduled:true`, 调用方早就挂断; 真正的交接在后台等目标闲下来, 最长等 10 分钟, 超时此前只写一行 `log.warn`——用户调了这个工具, 十分钟后交接悄悄失败, 没有任何气泡告诉他上下文其实没动。现在超时也补一条 `notifyChat`, 对齐它成功时发的那条。
- **`worldPeers` 全量探活打穿 fd 上限, 把 tmux server 和守护进程一起拖垮**。一个裸 `Promise.all` 铺在全部 349 个 target 上, 每个各要两次 tmux (pane 存活 + capture tail) —— 约 700 个并发子进程, 日志刷满 `tmux command timed out — killed`, tmux server 重启 (活着的 pane 全数丢失, 会话本身可按 `--resume` 恢复), `/api/world` 挂死超过 120s, 守护进程随后 down。正是 CLAUDE.md 记的 launchd fd 那个失效模式。现在两道闸: 先用**不 spawn 的**证据排序 (transcript 的 mtime 一次 statSync, 注册表里登记过的无条件入选), 只探前 48 个, 并发封顶 6。没被探到的照旧出现在名册里, 只是 busy/alive 按冷处理 —— 图上少一盏呼吸灯, 远好过把整台机器上的会话一起搞停。冷 57ms / 命中缓存 4ms, 持续轮询下 tmux 超时 0 次。
- **chat 详情页在关系/日程栏点左侧会话列表毫无反应**。`select()` 只换了 `S.target` 就去拉线程, 而 `#thread` 还 hidden 着 —— 点上去像什么都没发生。现在非线程栏里点一个会话先切回线程栏 (点它的意思本来就是"去读它")。
- **关系图稀疏得像没排版**。卡片用的是 `grid` + `align-items:start`, 行高按本行最高的那张对齐, 于是「2 个 wizard 的群」旁边挨着「20 个 wizard 的群」时, 矮卡片下面全是空白; 列宽 `minmax(300px,1fr)` 在宽屏上还会把两张卡片各拉成半个屏。改成 CSS 多列的砌砖式排布 (`columns: 320px` + `break-inside: avoid`), 卡片顺着列往下码, 没有行的概念, 也不再过度拉伸。
- **关系图上一条跨卡片的连线会被中途吃掉半截**。`.wedges` (SVG) 与 `.wgrid` (卡片) 是同一个层叠上下文里的两个定位兄弟, 后者在 DOM 里靠后于是压在上面, 而卡片是不透明的 —— 一条从左列穿到右列的边只剩两头, 读出来像是断的。给连线层 `z-index:2` 抬到卡片之上, 同时 `.wgrid` **保持 `z-index:auto`** (设了数值它就自成一个层叠上下文, 里面的节点再也抬不过这条线), 悬停/聚焦的那个节点 `z-index:3` 压回线上面, 免得正在读的那行字被线划着。
- **`el.hidden` 对 `.gbar` / `.topbar .cwd` 这类元素不生效**。UA 的 `[hidden]` 规则与类选择器同权重而作者样式胜出, 于是 `hidden=true` 的元素照旧显示 (空的 graph 条会剩一条带边框的窄带)。补一条 `[hidden]{display:none!important}`。
- **rolepage 三处细节**: 自己发的气泡底色调浅一档; 人的视角不再画「私聊」栏 (人没有 wizard 私聊); 在群里「只看我与 X」时换到 X 的视角, 选中的是「只看我与 原视角」而不是整个群。

## [1.4.2] - 2026-09-22

### Fixed
- **`spawn_clone` 撞名时随口建议 `send_peer` 找它, 结果活派进了自己这个聊天, 而不是目标聊天里那个 wizard**。409 响应从没真探过对方死活——`taken` 只看 `chatTargets()` 里有没有这个 tag, 连早断线的冷绑定也算数, 于是文案不由分说写"已经是一个活着的 wizard", 唯一给的路是裸 tag `send_peer`；而裸 tag 解析优先撞调用方**自己**聊天里的同名 wizard, 目标明明该在**另一个**聊天, 活就这样悄悄派错了地方, 也不报错。现在 409 真探一次活 (`alive`/`busy`/`idleForMs`) 并带上能直接回传的完整 `address`：冷绑定才建议 `stop_wizard({mode:"end"})` 收掉腾名字再用同一个 tag 重新 spawn, 真活着就建议换个 tag, 不再默认往里塞不相关的活。`ADDRESS_DOC`(`peek_peer`/`send_peer`/`wait_peer`/`schedule_task`/`stop_wizard` 共用)与宪章编排清单都补了这条: 目标是**特定**聊天就必须写 `聊天名#tag`。
- **`reload` 明明成功却报 "not responding"**。boot 恢复镜像绑定是一次裸 fan-out,每个绑定各问两次 tmux (pane 还活着吗 / cwd 在哪) —— 本机 349 个绑定就是 ~700 个 client 同时排在一台 tmux server 上,全部撞满 10s 超时,而 spawn 风暴顺带把事件循环压住: `:17890` 要 25s 才 bind。CLI 那头 `wait_up` 又是按**次数**收口的 (30 次 × 0.3s),端口没 bind 时 curl 立刻 connection-refused 返回,于是 ~9s 就放弃了 —— 守护进程正常起来了,人看到的是一行失败。两头都改:
  - 恢复改成一次 `list-panes -a` 取全量 pane 快照,所有绑定共用 (并发也封顶,快照取不到才退回逐个探活);`await` 立刻让出,`startHttp` 先绑端口。实测 start→listen 从 25.5s 降到 0.3s,349 个绑定 0.7s 恢复完,tmux 超时 0 次 (此前数千)。
  - `wait_up` / `wait_down` 改按墙钟收口 (90s / 30s),不再被「连接被拒绝返回得快」偷走预算。
- **`worldPeers` 引用了两个没导入的名字** (`mapLimit` / `wizardStore`),`npm run build` 在这棵工作树上是断的。
- **`A → B` 里的 B 几乎总是不可点**。头上那两个名字各挂自己的 chat 详情页,而凭据 (`?id=`) 只能从一条真实的 turn 记录里借 —— detail store 只留 24h/1000 条,于是被派活的那一个(刚出生的分身、闲了一天的同伴;本机 349 个已 attach 的会话里 329 个没有自己的记录)拿不到凭据,名字就退化成一段不可点的裸文本。跨聊天派活更糟:气泡就下发在 B 所在的那个群里,而那个群整个可能一条 turn 记录都没有,于是全场唯一点不开的名字正是这条消息的收件人。
  - 新增一种极小的记录 **聊天票据** (`kind:"chat"`, 一个聊天一条, 只承载「这个 id 属于哪个聊天」): 自己的 turn 取不到就退到它,于是「有没有链接」不再取决于「这个聊天最近有没有跑过一轮」。票据**不参与 TTL / LRU 回收** —— 它是长期凭据,过期等于群里的链接集体失效,而它承载的那点信息永不过时(它也不占预算:上限就是聊天数)。凭据强度按长寿命重新取:96 bit 随机,而不是 turn id 那种按 24h 寿命定的 `t<时间戳><6 随机>`。
  - 页面开在谁那一栏改由新的 `target=` 明说(同聊天才认,跨聊天的 `target` 一律忽略退回票据自己那栏)—— 于是凭据是谁的都不影响落点。零记录的聊天也点得开:页面开着就等于订上了那个 wizard 的 SSE,它一开口正文自己长出来。
  - 票据与其他记录一样转发给 svr,所以远端页面的行为一致;伪造的 id 仍然 404(`?id=` 就是凭据这一条没有变)。
- **一个聊天的默认 wizard 的地址不再拖着一个孤零零的 `#`**。默认 wizard 的名字就是聊天名,地址本该同样是 `lisct-5`,`peerAddress` 却印成 `lisct-5#`;更糟的是这个串喂回 `send_peer` 会被当成「裸 tag」,报的还是「`lisct-5` 是个聊天,不是 tag」—— 名册里读到的地址与工具收得下的地址对不上。现在两头对齐:印出来的是裸聊天名,`resolvePeerTag` 也把裸聊天名解析成那个聊天的默认 wizard(老写法 `lisct-5#` 继续认)。

## [1.4.1] - 2026-09-21

### Changed
- **精简: 把四处各自重写的东西收成一份**。没有行为变化,`npm run build` 与 6 个测试文件照常通过。
  - `shared/json-map-store.ts`: `sessions` / `mirror-store` / `wizard` / `jobs` 四个存储各自抄了一遍「读一份 keyed json、每次改动写穿」。收成一个 `loadJsonMap`,`gc` 钩子让 jobs 继续在写盘前丢掉 24h 前收工的行。顺带统一了容错口径 —— 此前只有 wizard / jobs 的写失败被吞掉,sessions / mirror-store 会抛; 这些都是恢复用的状态,丢了该重挂一次,不该拖垮一个活着的会话。
  - `shared/exec-path.ts`: `augmentedPath` 有 5 份副本 (其中一份还漏了 nvm 的 bin 目录)。合成一份,额外目录走第二个参数 (`session-scan` 要 `/usr/sbin` 找 `lsof`,`cfg-sync` 要 `/usr/bin`)。
  - `shared/std.ts`: `sleep` ×5、`truncate` / `clip` ×6 —— 后者原本有三种语义在互相混用。收成 `truncate` / `truncateWithCount` (`…(+N)`) / `clipLine` (先压成一行再截)。
  - `mirror-bridge.ts` 里 5 个纯改名的本地别名 (`tagOfTarget` = `tagOfKey`、`basePrincipalOf` = `baseOfKey`、`withSessionTag` = `withTagHeader`、`splitChunks` = `splitMarkdown`、`tmuxRun` = `runTmux`) 折回各自模块导出的名字 —— 同一件事两个名字,文件里两种写法都在用。
  - `mcp/server.ts`: 6 个早于 `daemonPost` 的工具还在手搓 fetch。全部折上去,并补一个 `daemonGet`; 现在整个文件只剩这两处 `fetch`。
  - `daemon/index.ts`: 14 处 `await import("./http.js")` 动态导入一个文件顶部已经静态导入的模块,`config-api` 同理。改成静态导入。
  - 删掉真正没人用的: `bindCliBackend` (已被 `bindCliBackends` 取代)、`cacheClear`、`CONFIG_KEYS`、`mainTitle`、`session-scan` 的 `dirnameOfNode`,以及 `approval.ts` 里一个只写不读的 `gone` 标志 (实际止血的是下面那个 `clientGone` race,注释描述的机制并不由它实现)。

### Fixed
- **多行消息注入会重复粘贴, 且回车从未真正被校验过**。Claude Code 把多行粘贴折叠成 `[Pasted text #1 +5 lines]`, 于是按文本指纹 (首 8 / 末 8 个非空白字符) 判定「贴进去了没有」的老判据双双落空: `sawHead` 耗光整个预算后误判为「没贴上」→ 盲目重贴, 而实测第三次粘贴会渲染成 `…OMEGATAIL[Pasted text #2 +5 lines]` —— 两份提示叠进同一个输入框。同一个盲区让回车后的「输入框清空了吗」永远在第一次轮询就为真, 等于根本没校验过提交。改成读**输入框整块** (两条 ruler 之间、首行以 `❯` 打头的那几行), 与贴之前的快照比对: 判据与文本内容无关, 折叠态照样成立。由此 (a) 只有确凿看见框仍是贴前的样子才重贴, 存疑一律不重贴 —— 多贴一次的代价远高于少贴一次; (b) 提交有了可信判据, 回车没落地时最多补到三次 (空框上的回车是 no-op)。认不出输入框布局的后端 (或基线读取失败) 整条退回原来的指纹法, 行为不变。

- 文档: `技术说明.md` 指向一个不存在的 `docs/ONBOARDING.md`; README 与技术说明都还在说「未命名的聊天不可寻址也不可被建入」,而 1.4.0 起没名字的聊天会按工作区自动补名。
- `CODEBUDDY.md` 是 `CLAUDE.md` 的手抄副本, 已经漂移了一条 (缺 daemon fd limit 那段)。改成符号链接, 从此不会再漂。

### Added
- README: 新增「编排: 读完材料才知道要分几路」一节 —— 工单 / 批量 `wait_peer` / `RESULT:` 收口行 / `send_peer({when:"idle"})` / `cloneMax` 各自解决什么问题, 以及 `run_agent_graph` 与它们的分工。另补模型作为 wizard 属性、名册增量、聊天自动命名。
- `技术说明.md`: 新增「wizard 网络: 身份、感知、编排」一节 (charter 为什么是系统提示、fork 的两条不变式、快照 + 增量的感知模型、控制流留在发起方的取舍, 带一张 fan-out 时序图)。
- `CLAUDE.md`: 补上 `jobs.ts` / `notices.ts` / `chat-name.ts` / `tasks.ts` 四个模块的职责, 以及「共享原语」一节 (动手写本地副本之前先看这里)。

## [1.4.0] - 2026-09-21

### Added
- **模型成为 wizard 的一个属性,而不是 spawn 那一瞬的开关**。此前只有 `spawn_clone` 和 `run_agent_graph` 的节点能挑模型,`new_claude_session` 挑不了(它是「造一个白纸 wizard」的唯一入口,而人手敲的 `/new opus` 一直是能挑的 —— 同一件事 IM 侧做得到、MCP 侧做不到);挑了也看不见、也留不住。三处一起补齐:
  - `new_claude_session` 新增 `model`,与 `/new [cli] [model]` 同权;`/sessions/new` 的回执与群里的就位气泡都带上它,分身的就位气泡同理(模型不是默认时才显示)。
  - **模型跟着会话走**。`--model` 写进 attach 状态与 `~/.wezard/mirror.json` 的绑定记录,两条 `--resume` 重生路径(pane 死了的自愈、dispatch 中途的重生)都把它带上 —— 此前一个被放在 haiku 上的 wizard,pane 一死就悄悄回到默认模型,而没有任何地方会说这件事。`/new` 仍然是重置点:它开的是**新会话**,没点名就是该 CLI 的默认。
  - **名册里看得见谁跑在什么模型上**。`wizard_roster` / `wizard_whoami` / `list_peers` 的每一行多一个 `model`(空 = 该 CLI 的默认)。不知道同伴跑在什么模型上,「要判断的给 opus、跑腿的给 haiku」这句话就只能凭记忆执行。宪章的工具清单同步点出这条取舍。
- **协同网络: 补上 fan-out / join 这一层**。此前编排只有两端 —— `send_peer`/`wait_peer` 是手工点对点,`run_agent_graph` 是预先声明好的静态线性循环;中间空着的正是「读完材料才知道要分几路」的那一种活。补的四件都遵循同一条取舍:**控制流留在发起的那个 wizard 的上下文里,守护进程只做账本与执行器**(graph 把控制流搬进 daemon,代价是 run 只能活在内存里、reload 即丢;账本没有这个问题)。
  - **`wait_peer` 一次等一组**。新 `tags`(最多 16 个)与 `need`(满几个就返回,默认全部;`1` = 谁先完事就先处理谁)。分身本来就在并行干活,一个一个等的墙钟是所有人之和,一起等只花最慢那一个的时间。法定人数一满,剩下的等待立刻撤掉,它们照常继续干。地址整批先解析 —— 打错一个不该等十分钟才发现;重复地址去重,不占两个名额。单目标的扁平回显照旧,老调用方无感。
  - **`send_peer` 的投递时机**。新 `when: "now" | "idle"`(默认 `now`,行为照旧)。`idle` 先等对方闲下来再投:两个 wizard 同时找第三个时,两段文本会挤进同一个输入框被当成一轮读掉 —— 这在协同网络里不是边角情况而是常态。「回答它的提问」「打断它」仍然该用 `now`。返回里一律带 `wasBusy`,让编排方知道这句话是被当场读到还是排在了它这一轮后面。
  - **名册增量**(`daemon/notices.ts`)。宪章里那份「出生时群里已有的 wizard」是 spawn 那一刻的快照,只会越来越假。现在群里谁出生、谁收工、谁改了职责,会以一行 `<system-reminder>` 挂在**下一次**进到该 wizard 的任何文本尾巴上(人说的话、同伴派活、定时任务三条注入路径都挂)—— 不占一轮、不进气泡、不进 transcript。感知 = spawn 时的快照 + turn 时的增量,两者都不花额外轮次。信箱是纯内存的,投递即清空。
  - **工单**(`open_job` / `close_job` / `list_jobs`,账本在 `~/.wezard/jobs.json`)。派出两个以上分身时先开一个工单,`spawn_clone` / `send_peer` 带上 `job` 即归属:① 群里只出「开工」「收工」两条气泡 —— 五路 fan-out 原本要刷十条交叉气泡,人从里面读不出结构,过程照旧在各自的 chat 详情页,收工那条把成员(各挂自己的详情链接)与各自那段活一并交代;② `close_job` 把**为这个工单生出来的**分身整批回收(被拉来帮忙的长期 wizard 与调用方自己不在其列)—— 忘记回收是常态,而每个分身都占一个 pane 和一份上下文。
  - **交付收口行**。`wait_peer` 的结果多一个 `result`:从对方最后一条回复里摘出 `RESULT: …`(或「结论:」)那一行,取最后一个匹配;摘不到就是空串,调用方照旧读 `lastText`。fan-out 的 join 载荷本来是「最后一条 assistant 文本」,而分身的最后一句可能是「好的我开始了」也可能是八百字散文,两种都没法直接汇总。对法与 graph 的 `until` 哨兵同源:不改 CLI 的输出格式(改不了),只在派活的提示里要求收口。
  - **分身预算**(`wrc.mirror.cloneMax`,默认 8;工单另有 12 个成员的上限)。分身能递归生分身,一次跑飞的编排足以把 fd 吃光(见 launchd plist 的 `NumberOfFiles`)。撞到上限的回执直接告诉它该怎么办:`stop_wizard` 收单个,`close_job` 整批回收。
  - 宪章同步更新:工具清单、编排剧本(先 `open_job` → `spawn_clone({inherit:true, task})` → 要求 `RESULT:` 收口 → 一次 `wait_peer({tags})` 等回来 → `close_job` 汇总并回收)、以及「名册会自己更新,不必去问」。
- **没名字的聊天按工作区自动起名**。名字就是地址: 一个没名字的聊天在别的聊天眼里只有 `chat:wr4-87DwAA…` 这串 key —— 能寻址,但模型抄错一个字符就找不到,人更读不出那是哪个群。而等人想起来去 `/name` 是等不到的(实测 16 个聊天只有 3 个起过名字,54% 的 wizard 的 `chat` 字段是空的)。每个聊天本来就带着一个可读的标识:它在干哪个项目。于是 `~/develop/Guxi11/weclaude` → `weclaude`,撞名加序号(`lisct` / `lisct-2`),非法字符折成 `-`,推不出名字(工作区为空)的原样留着 —— 宁可没名字,也不造一个同样不可读的 `chat-wr4`。只填空,**永不覆盖人起过的名字**。
  - 补名发生在「**要把名字交给模型**」的那一刻,而不是某条 spawn 路径上:`wizard_roster` / `list_chats` / `list_peers` / `wizard_whoami` / `notify` 的收件解析各一道拦截,外加**渲染 charter 时**一道 —— 后者最要紧:系统提示是随进程终身的,一个在聊天还没名字时出生的 wizard 会一辈子以为自己住在「(未命名)」的地方。再加开机 15s 后一次兜底(IM 侧的 `/peers` / `/help` 不经过任何 MCP 路由)。
  - 一个聊天的工作区取它名下各会话跑得最多的那个目录;分配顺序按会话数从多到少 —— 否则同一目录下 70 个会话的主力群会拿到 `lisct-7`,而一个只有一条冷记录的空群占了裸名 `lisct`。
  - 一次 `patchJsonc` 写完(首次补名会一口气命中十几个),注释与格式原样保留;写失败只记进内存不抛 —— 自动命名是锦上添花,不该把一次 roster 查询搞崩。补名不发群气泡(十几个群同时刷屏),但会给住在里面的 wizard 各投一条名册增量:「这个聊天现在叫 X」。
  - 实测: 16 个聊天全部有名,`chat` 字段为空的 wizard 从 167 降到 **0**,名册里带裸 key 的地址从 133 降到 **0**。
  - 顺带: `resolvePeerTag` 在「这个聊天里没有这个 tag」这一条分支上,候选清单给的是裸 target key,而隔壁两条分支早就映射成地址了 —— 这份清单存在的意义就是让调用方照着改一个能用的串。统一成 `peerAddress`。
- **名册从一份转储变成一张索引**。这台机器上实际有 300+ 个会话,`wizard_roster` 此前一次吐 129KB(≈3.2 万 token)—— 一个 wizard 每次想找人都付这个价,等于找不到人。现在服务端过滤:`query`(名字/职责/地址子串)、`cwd`(**工作区反查** ——「谁在这个目录里干活」此前根本问不出来)、`chat`、`alive`,默认只回最相关的一页(自己 → 活着的 → 最近动过的),并附 `total` / `matched` / `more` 让调用方知道自己看的是不是全部。默认一页 18KB,按职责找人从 308 条收敛到 1 条。
- `list_chats` 的每个会话行补上 `name` / `description` / `cwd`。此前只有 `target` / `tag` / `address`,想知道「那个群里哪个 wizard 是干什么的」必须再拉一次三百条的名册 —— chat → wizard 这条边存在但读不出内容。三个字段都取自注册表与 store,不探 tmux。
- **定时任务: 到点让一个 wizard 真的去干活**。到点把一句 prompt 注入目标 wizard 的会话,与那一刻有人在群里对它说这句话完全等价 —— pane 死了 `injectText` 自己把它拉起来,产出照常落进群和详情页。活在 daemon 里而不是某个会话里,所以 CLI 重启、`/clear`、会话结束都带不走它。
  - **时机写人话,不写 cron**。`shared/schedule-spec.ts` 是一层纯解析:「每个工作日晚上9:30」「每天早上9点」「每周三下午3点」「每周二和周四晚上8点」「每隔两小时」「每30分钟」「20分钟后」「明早9点」,中文数字(九点半/十点)、时段词(凌晨/上午/中午/下午/晚上)、刻钟(一刻/半/三刻)、英文(weekdays 21:30 / every 15m / tomorrow 9:30pm)都认。刻意不收 cron 表达式:人说的是前者,让模型翻译成 `30 21 * * 1-5` 翻错了没人看得出来。认不出就报错并列出能认的说法,绝不猜一个时间存下去;存成功后回显 `when` 与 `next` 供人当场确认。
  - 三种形状足够覆盖:`daily`(某几天的 HH:MM)、`every`(每 N 分钟)、`once`(绝对时刻,触发后自删)。判定收在一个纯函数 `isDue(when, now, since)` 里,同时承担同分钟去重、重启不重放、以及**5 分钟补跑窗口** —— 守护进程重启吃掉的那一下会补上,超窗就放弃(早上 9 点的活中午补跑比不跑更糟)。
  - 新 MCP 工具:`schedule_task`(省略 `tag` = 排给自己)· `list_tasks`(id / 人话回显 / 下次触发时刻)· `cancel_task`。
  - 定时注入强制走出处门(`injectText(…, { fromChat: true })`):定时点的火,结果必须在群里看得见,哪怕上一轮是人在 CLI 里敲的。放枪前先推一条 `⏰ 定时任务 · <时机>` 气泡 —— 否则群里凭空冒出一轮对话,没人知道是谁点的。
  - 定时表从 `topics.schedules` 升到顶层 `schedules`;老 config 读盘时就地抬一手,已排好的任务不会静默消失。
- **wizard: 绑定聊天的会话从此是一个有身份的角色**。一个 `chat:xxx[#tag]` 不再只是路由 key，它有名字(= 聊天名，带 tag 的分身读作 `chat#tag`)、一句职责、一份跨会话的记忆、一条家谱，以及「知道自己活在一个群里、群里还有别的同类」这件事。
  - **身份走系统提示，不走对话**。spawn 时把宪章写进 `~/.wezard/state/charters/<sid>.md`，以 `--append-system-prompt "$(cat …)"` 压进那个进程 —— 不占一轮、群里看不见、`/clear` 抹不掉、上下文窗口也挤不掉。所有 spawn 路径(群里 `/new`、pane 死了的自愈重生、编排生出来的分身)统一从 `setCharterProvider` 取身份，「是谁」不再取决于是哪段代码把它生出来的。没有该 flag 的后端(codebuddy)静默跳过，无回归。
  - **分身(clone) = fork 父亲此刻的上下文**。`spawn_clone({inherit:true})` 以 `--resume <父 sid> --fork-session` 起新 pane，CLI 把父亲的 transcript 复制成一份新的再继续写：分身开局就带着父亲读过的一切，父亲毫发无损。于是「先把公共材料读进一个基座，再从它分出 N 个干活的」成立 —— 材料只读一遍，却进了 N 份上下文。分叉文件在该 pane 收到**第一条消息**时才生成，所以开场白(即第一件活)是分叉的触发器，等到它才 attach；等不到就连 pane 一起收掉，绝不拿父亲的 sid 凑合。`inherit` 必填，没有默认值。
  - 新 MCP 工具：`wizard_whoami`(我是谁 / 上下文用了多少 / 分身有哪些) · `wizard_identity`(给自己起名字、写职责；默认会话起名同时给聊天起名) · `wizard_roster`(全体 wizard 与 clone：名字/聊天/工作区/职责/忙闲/家谱) · `spawn_clone` · `stop_wizard`(打断或终结) · `wizard_remember`(跨 `/clear` 活下来的长期记忆，每次 spawn 重新注入) · `wizard_handoff_self`(上下文快满时自己写简报、原地 `/clear` 重开、把简报贴回去)。
  - 注册表落在 `~/.wezard/wizards.json`(`wrc.mirror.wizardsFile`)。
- `/new` 接受位置参数 `[cli] [model] [prompt…]`，三个都可选、从前往后逐个认领：认得出的 CLI 名吃进后端、认得出的模型别名(`opus` / `sonnet` / `haiku` / `claude-opus-5` 这类完整 slug)吃进 `--model`、剩下的整段作为新会话的第一句话在 spawn 后照常走 dispatch 注入。`/new opus`、`/new 帮我看下这个 bug`、`/new codebuddy opus #docs 先读一遍 README` 都成立。模型槽刻意收窄到已知别名与 `claude|gpt|gemini|deepseek-*` slug —— 认不出的一律当正文，`/new 看看 sonnet 贵不贵` 不会被吃掉第一个词。

### Removed
- **BREAKING: 删掉 topic 订阅 / 广播整套子系统** —— `subscribe_topic` / `unsubscribe_topic` / `list_topics` / `broadcast_topic` / `schedule_broadcast` / `cancel_broadcast` 六个 MCP 工具、`POST /publish` 与五条 `/topics/*` 路由、`config.jsonc` 的 `topics.subs`,以及 `schedules` 里的 `broadcast` 记录形状。pub/sub 的价值是「发布者不认识订阅者」,而这里的收件人全是本机 wizard —— `list_chats` / `wizard_roster` 早就把通讯录完整、人类可读地枚举出来了。topic 于是成了给一本翻得完的通讯录加的一层间接:多一套与地址不兼容的命名、多一步注册、打错一个字永远静默收不到。它占掉 34 个工具里的 6 个、工具描述总量的 15%(这些描述进每一个 wizard 的系统提示),换来的是零真实使用。
  - 能力没丢,换了表达:**要通知人**用新的 `notify`(收件人就是地址,不需要谁先订阅);**要到点干活**用 `schedule_task`(定时广播只是它的退化特例 ——「到点说这一句固定的话」)。
  - 迁移:老 config 里 `topics.schedules` 中的广播记录读盘时被丢弃(不再抛错,一条过期定时不该把 daemon 挡在启动之外);`topics` 段留在盘上无害,可手工删。`POST /publish` 的外部调用方(CI / 监控脚本)改调 `POST /message`(直接给 chatid)。

### Changed
- **chat 详情页按后端的名字称呼它**。「Agent 正在思考」此前是写死的泛称 —— 一台机器上同时跑着 Claude Code 与 CodeBuddy 两种后端,页面却一律说「Agent」,看的人分不出眼前这一轮是谁在跑。现在开 turn 时按 transcript 的落盘路径反查后端(`backendForPath`),记进 `TurnDetailRecord.cli`,详情页与线程片段渲染成「Claude 正在思考」/「CodeBuddy 正在思考」;认不出的后端退回中性的「Agent」——宁可不说,也别说错一个产品名。存量记录没有这个字段,照旧显示「Agent」。
- **`notify`: wizard 说给人听的那条通路**。此前一个 wizard 只有两种开口方式 —— 自己那一轮的正常回复(只到自己群),和 `send_peer`(把话塞进另一个 agent 的输入框,驱动它干活)。「把结论贴到另一个群给人看」既不属于前者也不属于后者,此前只能借广播歪着走。`notify(to?, markdown)` 补上这一格:`to` 写聊天名(可多个),省略即自己这个群;跨群时气泡头沿用 relay 那一套 —— 写成带聊天名的全称并挂上 chat 详情链接,那边的人一眼看出是谁从哪说过来的。收件人认不出整条拒绝并列出来,绝不部分送达 ——「发了但没人收到」是这类工具最难查的故障。
- **把历史上的 peer 话术统一到 wizard/clone**。同一套东西此前有两种说法(「会话 / peer / sibling」与「wizard / 分身」)，模型读到的是分裂的世界观。现在 MCP 工具描述、`#tag` mention 提示(`<system-reminder>`)、`/help`、`/peers`、README 与架构文档一律讲同一种话：一个绑定聊天的会话 = 一个 wizard，它的分身 = clone，同一聊天里的其他 wizard = 同伴。**工具名保持不变** —— 名字是地址，改名会把 hint、文档与用户肌肉记忆一起打碎；`send_peer` 读作「跟另一个 wizard 说话」即可。
  - `/peers`(新增别名 `/wizards`)从「会话列表」改成**名册**：每行带名字、职责、忙闲、以及「分身自 #x」。名字与职责来自注册表，通过 `bindWizardStore` 进程级绑定读到，没登记过的仍只显示 tag。
  - `new_claude_session` 的描述明确写出它与 `spawn_clone` 的分工(白纸一张 vs 继承上下文)，`handoff` 明确指向 `wizard_handoff_self` 处理自己，`stop_graph` 指向 `stop_wizard` 做即时打断 —— 相邻能力之间互相指路，模型不必猜。
- **wizard 之间的对话在群里只留关键节点，且不重复**。一条 relay 只落在**收信那一方**的群里：派活(`send_peer` / `spawn_clone` 的开场白)显示在**目标**所在的群，跨群时源头群不再复述同一句话；跨群气泡的头写成 `源聊天#源wizard → 目标wizard`，对面群里的人一眼看出活是从哪个群派来的，而不是凭空冒出一条 `#tag`。`wait_peer` 拿回的结论反向只推给**提问方**的群 —— 答话方自己的群里那条回复本来就会以它自己的气泡出现；同一个群内更是整条省掉。分身出生、终结、自我交接仍各留一条，中间的催促只落在 chat 详情页。宪章里同时写死了说话的规矩：分清「对人说」与「对 wizard 说」、不复述、不客套、不替别人开口。
  - 头上那两个名字各自挂上**它自己的 chat 详情链接** —— 看见「A → B」的人下一步想问的永远是「A 那边在干嘛」，链接省掉他回群里翻 A 气泡这一步。凭据取该 wizard 最近那条 turn 记录（与 mirror 气泡的链接同源，`ww_uniq` 按聊天收敛，同群的详情页复用一个企微内置浏览器窗口）；`?id=` 同时决定页面默认选中哪个 `#tag`，所以必须是它**自己**的 turn，拿兄弟会话的 id 会把页面开在别人那一栏。从没跑过一轮的会话没有凭据，退回裸名字而不是死链。

### Fixed
- **`notify` 收不下 `聊天名#tag` 形式的地址**。`chatBaseOf` 只认「纯聊天名」与「裸 principal」,而 `wizard_roster` / `list_peers` 交到模型手里的 `address` 恰恰是 `org-archivist#exp` 这种带会话那一截的串 —— 于是同一个地址空间在 `send_peer` 那边通、在 `notify` 这边被整条拒收;更别扭的是全量 key(`chat:wr…#fix`)因为前缀命中而侥幸可用,两种写法行为相反。现在统一走 `parsePeerRef` 剥掉会话那一截(一个 tag 指不出第二个聊天),于是「知道某个 wizard 叫什么」就等于「能往它所在的群里对人说话」,哪怕那个群没起过名字(本机 16 个聊天里 13 个没名字,54% 的 wizard 的 `chat` 字段是空的)。
- **气泡里的表格不再塌成一行带竖线的文字**。头与正文之间只隔一个换行时,markdown 把正文首行当成头那一段的续行 —— 代码栅栏早有补丁,表格没有,而表格**不能打断一个段落**,于是整张表退化成纯文本。分隔逻辑收进 `headSep` 一处:正文以 ``` 开头给一个换行,以 `|` 开头给一个空行,其余照旧同行。wizard 之间的 relay 气泡(`<from> → <to>`)头一律独占一行、正文自成一块;brief 模式带详情链接的 standalone 气泡此前是写死的一个空格,同样接上这套规则。方向信息全在头里,正文不加任何引用/缩进标记。

## [1.3.23] - 2026-09-17

### Added
- `wrc.botNames`: 机器人在 WeCom 里的显示名(可配多个别名)。名字由建机器人的人自己取, 消息体里没有任何字段能读到, 此前硬编码 `wezard` / `weclaude` —— 改名后 `@<真名>` 剥不掉。配了名字的在单聊里也剥。

### Changed
- **@mention 剥离改为「一条消息只认定一个机器人名」**。候选 token = `@` 之后到空格/行尾为止且不含 `/` `\\`;路径优先被识别为路径(`@src/foo.ts` 连候选都进不来, 裸文件名再按扩展名形状排一道);剩下的第一个就是机器人名, 认定后把全文里同名的 `@` 全部剥掉(一条消息里可能 @ 它好几次, 但不可能有两个机器人)。群聊才做这套推断 —— 单聊 @ 不了人, 那里的 `@` 只按配置名剥。

### Fixed
- **引用/@ 机器人后的正文剥离不再依赖机器人叫什么名字**。改名后 `@<真名>` 会原样漏进 prompt 被语义解析(如误触发 wrc)。
- **`@wezard 看看 @src/foo.ts` 不再把文件路径一起吃掉**。旧逻辑按名剥掉 `@wezard` 后 @ 数降到 1, 随后"唯一 @ 即 mention"的兜底就把 `@src/foo.ts` 删了;新规则下路径根本不是候选。
- 引用正文本身的剥离(`parseTagHeader` 的 `emoji #tag` 头)一直是按出站气泡的 emoji 头反解的, 与机器人名无关 —— 不受影响。

## [1.3.22] - 2026-09-16

### Fixed
- `mirror`: **群里不再出现没有正文的消息**。两处噪音一并去掉 —— (1) CLI 轮首次静默时发的「CLI 侧对话不再下发到群里，点标签看实时详情。」入口提示整体移除: 有正文的 standalone 本就由 `withLinkedTag` 自带详情链接, 没正文时一条都不该发; (2) `brief` 下的 user 行无条件丢弃 —— 此前只在 `item.quiet` (即 `includeUser=false`) 时丢, 而 user_text 不在 `BRIEF_TURN_OPENERS` 里, `includeUser=true` 时它会穿过整条 brief 短路落到底部的 standalone fallback, 把人在 CLI 敲的那一行原样回显进群, 正好破掉 `chatOriginOnly`。

## [1.3.21] - 2026-09-16

### Fixed
- `mirror`: **askq 卡选「聊聊这个」不再卡死 CLI 面板**。text 注入复用的 `inject` 自带 modal guard, 而 AskUserQuestion 面板本身就是 modal —— 引导语被守卫拒掉, 自定义文本行永远空着, 驱动必败 (日志实测五连 `mirror askq chat drive failed` 均此因)。该注入现在带 `bypassModalGuard` 豁免; 注入文案改为「聊聊这个」, 并在 `confirmAskqSubmit` 里为 codebuddy 的二次确认框补 Enter (盲按一次 → 轮询面板关闭 → 没关再按, 上限 3 次)。

## [1.3.20] - 2026-09-16

### Fixed
- `mirror`: **CLI 侧一轮的 standalone 不再顶着两条一模一样的详情链接**。`ensureBriefTurn` 会把详情链接暂存到 `pendingBriefHeader` 再拼到首条正文前缀, 而 `sendStandalone` 本就通过 `withLinkedTag` 给每条 standalone 加同一条链接 (`linkedTagPrefix` 读的正是 `a.briefTurnId`) —— 两者叠加, 消息开头就是 `[🧙](url) [🧙](url) 正文`。暂存槽整体移除, 链接只由 withLinkedTag 一处产出。

### Changed
- `chat detail`: **子 agent 的一轮内联回父轮的时间轴, 不再作为兄弟卡片吊在最底下**。subagent turn 记录新增 `agent.parentTurnId`, 线程视图按 `createdAt` 把它插进父轮的气泡序列 (派发那一刻之后、父轮下一条动作之前) —— 此前它是顶层卡片, 父 agent 在 Task 返回后继续调的工具全排在它上面, 贴底阅读看到的反而是早已跑完的子 agent。SSE 相应改推父轮片段; 侧栏的「N 轮」与预览只算主会话自己的轮次 (token/工具用量仍按全部计)。
- `chat detail`: **上下文断点改为独立的分隔行, 在清空发生的那一刻就落地**。`/clear`、`/new`、会话轮换现在各写一条 `mark` 记录 (新的 detail 记录类型, 不占一轮统计), 线程里渲染成一条贯穿的虚线 —— 此前断点只能盖在"下一轮"的卡片头上, 要等人再开口才显形, 而那一轮还可能被当成空壳 turn 丢掉, 分隔就此消失。轮换判定 (`startTurn` 的 rotated) 一并以标记为基准, 不会在标记后再多画一条。

## [1.3.19] - 2026-09-16

### Changed
- `mirror`: **CLI 侧手敲的一轮不再下发到聊天** (`wrc.mirror.chatOriginOnly`, 默认开, 仅 `brief=true` 下生效)。镜像改为发生在两处 —— 人眼前的终端, 和 chat 详情页 (turn store 全量记录 + SSE 实时刷新)。每个 turn 现在带出处标记: 有 WeCom frame = 群里发起 (气泡照旧); 由一条真人 CLI 输入行开头 = CLI 轮, 终稿与斜杠命令回执只写详情页; 收口后的补写 / peer·graph 注入开出的轮沿用上一轮出处。审批与提问卡、卡前 pane 前言、`[mirror]` 系统提示、`/goal` 进度推送均不走这道门。每个 attachment 首次静默时发一条带详情链接的提示, 免得从没收过气泡的会话在群里无处可点。CLI 输入行同时开始写进 turn 的 `userQuery` (此前 `includeUser=false` 下详情页看不到人敲了什么), CLI 轮的 `cwd` 也补上, 与 WeCom 发起的轮次对齐。

### Removed
- `mirror`: **触限额自动续跑 (`wrc.mirror.limitResume`) 整体移除**。限额行不再被解析出 `resetsAt`、不再排定通知与到点注入; 配置项同步从 schema 删除 (旧 config 里残留该键会被 zod 忽略, 无需迁移)。keepalive 的 stall-resume 恢复无条件生效 —— 不再为已排定限额恢复的会话让路。

### Fixed
- `mirror`: **CodeBuddy pane 的 keepalive 不再突破 6 轮预算无限续命**。`tailTurns` 用 `Date.parse` 解析时间戳, 而 CodeBuddy 写的是 epoch-ms 数字 —— `Date.parse(数字)` 恒为 NaN, 每条 turn 的 `ms=0`, `keepaliveStamps` 退化为 mtime 兜底: ping/pong 自己的写入、`file-history-snapshot`/周期 `summary`/`turn-metrics` 等机器记录, 只要落在 ping settle 30s 静默窗之后, 全被当成真实活动把 `round` 清零, 预算重置再发一轮 6 次 (日志实测 #checkrun4 一晚 10+ 次)。现在数字时间戳直接透传 (Claude 的 ISO 字符串照旧 `Date.parse`), 时钟锚回消息轮本身; 同时 pong 判定从「紧邻 ping 的单条 assistant」放宽为「ping 之后到下一条 user 之前的所有 assistant」—— CodeBuddy 会把一条回复拆成多条独立 message 记录, 旧邻接规则会让拆出的后半段被误判为真实活动。

## [1.3.18] - 2026-09-14

### Fixed
- `mirror`: **CLI 敲 `/model` 等 slash 命令的回执即时推送 —— 不再吃 `standaloneDebounceMs` 防抖 (默认 30s)**。非 brief 路径下 skill_output (`⚙️ Switch model to …`) 此前与工具刷屏共用 standalone 防抖窗, 窗口被后续 item 反复重置时延迟还会更长; 现在 skill_output 一律先冲掉在途防抖缓冲 (保序, 同批 drain 里先到的 `> /model` 回显不被反超) 再立即发出。deferred / goal / 常规三条非 brief 消费路径同步生效; brief 路径本就即时, 不受影响。

## [1.3.17] - 2026-09-14

### Fixed
- `mirror`: **代按确认框改为「高亮核对 + 方向键导航」—— 数字键失效的布局 (CodeBuddy) 不再盲补 Enter**。原按法「发数字 N → 同标题框还在就补 Enter」隐含"数字键至少会把高亮挪到 N"的假设; CodeBuddy 的确认框数字键不一定生效 (其快捷键提示是 shift+tab/escape 系), 且实测默认高亮可能停在「Yes, and don't ask again…」上 —— 盲补的 Enter 会把**高亮项**按下去, 恰是哨兵发誓永不自动选中的放宽权限项。现在数字键没关掉框时: 读出当前高亮 → 方向键逐步挪到目标项 → **复核高亮就位后**才 Enter; 高亮读不出 / 挪不动 / 标题变化一律罢手交兜底。`answerNativeModal`(`.claude/**` 守卫) 与哨兵/审批卡代按共用此实现。

### Added
- `mirror`: **哨兵盲区诊断日志**。屏上有高亮编号行 (`looksLikePicker`) 却没判成 modal 时, 按屏去重记一条 `picker sentinel: numbered picker shape on pane but not judged modal` 及末 8 行屏面 —— 远端排查"哨兵为何没反应"不再无迹可循。发卡失败 (WS 断/发送失败) 时清哨兵指纹, 同屏下一 tick 自动重试, 不再被永久静默。

## [1.3.16] - 2026-09-14

### Fixed
- `mirror`: **原生 picker 哨兵识破 CodeBuddy 的确认框布局 —— 子代理 confirm 不再对远端隐形**。1.3.15 的 skipAll 哨兵在 devcloud (CodeBuddy) 上零命中, 成因是 `isModalPane` 的两条判据都被这版布局绕过: 确认框整圈圆角边框让 capture 行带 `│` 前后缀, 行首锚定的选项行正则落空; 快捷键提示内联在选项文案里 (`(escape)`), 没有 `Esc to cancel` footer —— 哨兵全盲且零日志。现在判定前逐行剥框线; footer 缺失时以权限三件套形状 (裸 `Yes` + `Yes, and …` + `No`) 作为 modal 证据补位 (是非题/plan review//model 天然不命中); `Are you sure …?` 纳入标题形状。注入防护 (`injectViaTmux` 的 modal 守卫) 与 `.claude/**` 守卫代按同步受益。
- `mirror`: **哨兵不再 gate 在 `danger.skipAll` 上 —— skipAll 关闭时原生确认框转标准审批卡发到绑定 chat**。此前 skipAll 关闭 = 哨兵整体停摆, 不过 hook 的确认框在远端既无卡也无法代按。现在读屏认出权限确认框后分三路: skipAll 开 → 代按一次性 `Yes` (原行为); 本 chat ⏱自动窗口内且内层工具不踩危险名单 → 同上代按; 否则 → 读屏下钻真实工具名/入参 (`parseConfirmContext`, DeferExecuteTool 布局解析 `toolName:"…"`/`params:{…}`) 发标准审批卡 (`runMirrorPickerFlow`, 与 askq/plan 镜像流同源), 点击后代按对应选项: ✅/⏱ → 一次性 `Yes` (⏱ 同时开 chat 自动窗口), ✅总是 → 原生「本会话不再询问」(静态规则帮不上不过 hook 的框), ❌ → Escape; 危险名单命中的卡走单次确认形态。本地先按掉 → 卡自动作废; 代按前重读屏校验仍是同一调用, 换框绝不盲按。

## [1.3.15] - 2026-09-10

### Fixed
- `approval`: **CodeBuddy 延迟加载工具 (`ToolSearch` → `DeferExecuteTool`) 的审批链按内层工具裁决**。deferred/MCP 工具经 `DeferExecuteTool(toolName, …)` 外层包装派发时, hook/daemon 只见外层名 —— matcher/danger/allow/deny 规则匹配不到真实工具, 卡片也读不出语义。现在 hook (`pre-tool-use.sh`) 与 daemon (`unwrapDeferredTool`, 兜底旧版 hook) 各下钻一层, 用 `tool_input.toolName`/`.toolInput` 替换外层再走审批链; wezard 自家 MCP 工具被 defer 后的 self-call bypass 一并恢复 (否则首次绑定又是鸡生蛋)。
- `approval`: **无 `agent_id`/`agent_type` 标记的子代理请求恢复父会话归属**。部分 CodeBuddy 版本的子代理 hook 两个标记都不带, 而 `subagentParentOf` 与 `fromSubagent` 只认标记 —— 归属反推失效, no-approver 时还错走 `ask` 挂进无人能点的原生 picker。现在 `subagents/agent-*.jsonl` 转录布局本身即子代理证据 (主转录布局仍需标记佐证); hook 侧 `record_mode` 同理改按布局+标记判子代理, 堵住「无标记子代理的 `default` 覆盖父会话 bypass 档案」。
- `mirror`: **`danger.skipAll` 下代按 CLI 原生权限 picker —— 不再对「本地 picker 先行、hook 后到/不到」的调用失明**。CodeBuddy 对一部分调用 (实测: 子代理里经 `ToolSearch`→`DeferExecuteTool` 派发的 MCP 工具) 先弹自家权限 picker、PreToolUse hook 在人点掉之后才触发 —— hook 链路零参与: daemon 无日志、无卡可发、`skipAll` 落空, pane 就地阻塞。与 AskUserQuestion「本地面板先行」同源, 解法同源: mirror 每 5s 读屏, `skipAll` 开启时对形状可信的权限确认框 (裸 `Yes` + `Yes, and …` 放宽变体 + `No` 三件齐全, 排除 是非题/plan review//model) 代按一次性 `Yes` 并发 chat 回执; 放宽静态权限的选项永不选中, 挑不出就不碰。`WEZARD_PICKER_SENTINEL=0` 关闭。

## [1.3.14] - 2026-09-10

### Fixed
- `usage`: **`/usage` 回复不再乱码、代码块恢复生效**。(1) `daemon/quota.ts` 源文件曾被按 GBK 读写的工具 round-trip 保存 (5a68952 引入): 非 ASCII 字节流按 GBK 两两配对, 奇数长度 run 的末字节被替换成字面 `?` (0x3f), 留下非法 UTF-8 —— `█ ░ ⏰ 从 近 •` 与 `🗓️` 的变体选择符全部阵亡 (偶数字节的 `⚠️` 恰好幸存), 编译产物原样带出, WeCom 渲染成 `�?`; 已按前一版完好提交逐字节恢复全部 16 处。(2) `withTagHeader` 同行拼头把 ` ``` ` 挤离行首, WeCom 不认作开栏栅栏 → 头部字面渲染 + 结尾栅栏反向开出空代码块; 现在 content 以栅栏开头时改用换行拼头 (`HEADER_RE` 尾部 `\s*` 吃得掉换行, 剥头/去重比对不受影响)。

## [1.3.13] - 2026-09-09

### Fixed
- `approval`: **"全跳过权限"模式在子代理里不再退化成本地原生 picker**。hook 的权限模式短路只认 `bypassPermissions` 一个字面量, 而 (1) CodeBuddy / IDE 协议注入报的是 `fullAccess`, (2) 子代理是另起的 CLI 实例, 拿不到父的 `--permission-mode`、自身 `permissions.defaultMode` 又通常没写, payload 里只剩 `ignore`/`current`/空这类「继承」语义值 —— 三者都匹配不上, 请求全掉进 daemon 长轮询, 子代理场景下那张卡没人点 → 回 `ask` → CLI 画出远端看不见的原生确认框。现在: (1) 字面量名单扩到 `bypassPermissions|fullAccess`; (2) 主线程每次把实际模式记进 `<stateDir>/modes/<sid>`, 子代理报继承语义值时按 transcript 反推父 sid 读回真实模式 (只有主线程写, 子代理的 `default` 不会覆盖父的 bypass; 父切回 `default` 时下一次主线程调用即自愈); (3) 解析后的模式随请求透传给 daemon, 在 `danger.skipAll` 同层再裁决一次 (`denyRules` / `AskUserQuestion` / `ExitPlanMode` 分支仍在其之前生效)。`WEZARD_HONOR_AUTO_MODE=0` 同时关掉 hook 与 daemon 两侧的直通。

## [1.3.12] - 2026-09-09

### Fixed
- `mirror`: **后台派发 (`run_in_background`) 的子 agent 不再让独白被当成终稿投递**。`openAgents` in-flight 记账原本假设「`function_call_result` 落回父转录 = 子 agent 结束」——该等式只对前台派发成立: 后台派发的 result 是 ~300ms 就回的 spawn 句柄, 账本在子 agent 真正开跑前就被销掉, 软收口 guard 在它唯一被设计来防的场景里 100% 失效 (日志中 `soft turn_end deferred` 零命中)。现在记账按前后台分流: 后台派发只由平台的完成通知 (`<task-notification>` 或无标签的 `[Framework Auto-Notification] …`, 按 label 命中、命中不了按 FIFO) 或 `OPEN_AGENT_TTL_MS`(15min) 销账。
- `mirror`: **软收口 defer 后会重挂, 不再永久悬挂**。此前 `fireSoftTurnEnd` 命中 guard 直接 return, 依赖「子 agent 返回后父侧必写新文本」自带下一次软收口; 而 CLI 侧起的无气泡 turn 没有 hard cap 兜底 (那只挂在 WeCom 发起的气泡上), 后台派发的结束信号又不会让父侧再写一段文本 ⇒ 正文永不投递。现在 defer 会按「最早未返回派发的 TTL 剩余」重挂; 子 agent 一返回则改用 15s 宽限窗口(父侧此刻正要写真正的答复, 立刻收口投出去的还是那句独白)。
- `mirror`: **「欠一次软收口」与静默计时器解耦**。此前任何新 item 都撤销待确认的软收口, 于是子 agent 返回时的 `tool_result`/完成通知/平台注入的 user 行会把欠账一起抹掉。现在只有父 agent 自己的产出 (`text`/`thinking`/`tool_use`/`turn_end`) 才推翻收口意图, 其余 item 只让欠账往后顺延。
- `mirror`: **对话边界清账不再是死代码**。`user` 行的边界语义原本挂在 `includeUser`(默认 false)上, renderLine 直接把整行丢掉 ⇒ 清账/keepalive 释放从不执行。现在无论 `includeUser` 都发出 `user_text`(quiet 只表示不渲染); 且清账按 `turnId` 认人, 只销「已经过去的那一轮」的前台派发, 不误伤本轮正在跑的。
- `mirror`: **同一 query 轮次内的重复终稿只投一次**。平台把「一个后台子 agent 完成」展开成结果与通知两条独立 user 注入, 模型被唤醒两次、各写一遍内容几乎相同的完整终稿; `briefConcluded` 只在 turn 内幂等, turn 一收下一条 text 就补开新 turn 再投一次。现在以 `queryEpoch`(仅真实用户输入推进)为界, 与上一份终稿 4-gram Jaccard ≥0.8 的判为重复投递, 只记进 turn/detail 不发群。

## [1.3.11] - 2026-09-09

### Fixed
- `wrc`: **引用去重的 transcript tail 改取「有效 tail」—— keepalive ping/pong 不再挤占回看轮次**。`quoteInContext` 兜底路径按最近 12 逻辑轮比对引用内容,挂机久了 keepalive 的 ping 及其应答会占满窗口,把用户真正引用的气泡挤出去 → 去重 miss、原文被重复注入 prompt。现在 `tailTurnsWithTools` 先按与 `keepaliveStamps` 同源的签名集(配置的 ping/resumePing + 旧版裸 `ping`)剔除 ping 轮与其紧随的应答轮,再数轮次。

## [1.3.10] - 2026-09-09

### Changed
- `mirror`: **codebuddy 软收口静默期默认 10s → 1s —— 纯文本答复/最终正文落盘 1s 无新 item 即定稿**。codebuddy jsonl 无 `end_turn`/`turn_duration` 硬信号, 每条 assistant 文本只能软收口确认; 实测叙述消息→紧随其后的 function_call 落盘间隔仅 4-8ms, 1s 已含 fs.watch 抖动/落盘延迟余量, 不再让最终结论干等 10s。可由 `wrc.mirror.softTurnEndMs` 覆盖。
- `mirror`: **派发子 agent 期间的独白不再被提前当 final 正文收口**。codebuddy 子 agent 转录 (`subagents/agent-*.jsonl`) 没有结束标记, 子 agent 会话结束返回主会话的唯一硬信号是父转录 `function_call_result` 落盘 —— 故以父转录 `function_call(Agent/Task)` ↔ `function_call_result` 配对判 in-flight。软收口到点若仍有未返回的派发 (`openAgents` 非空) 则 defer: 上一段文本按普通独白保留在流/气泡里, 待子 agent 返回后最终正文以自身的软收口正常收口; 无后续文本的死角由 350s hard cap 兜底。

## [1.3.9] - 2026-09-08

### Fixed
- `approval`: **子代理审批解析不到审批人时不再把 `ask` 送进无人可点的原生 picker —— 消除 headless/后台 subagent 授权永久挂起**。此前 subagent→父会话 re-routing 被 `wrc.mode === "mirror"` 门控: headless(/wrc) 模式 `getMirrorTarget` 为 undefined, re-route 永不触发; 且父会话要求已 mirror 绑定。当 subagent 上报未绑定的自身 session、`approvers` 与 `defaultChat` 又都为空时, `resolveApprover` 返回 undefined → handler 走 `fallback` 的 `ask` → 原生 picker 弹在没人能点的 headless/后台 subagent 里 → 永久卡死 (无卡、`danger.skipAll` 也救不了)。现在: (1) re-route 去掉 mirror 门控, 统一走 `getMirrorTarget` —— headless 模式由 index.ts 注入 sessions store 的反查 (session → 驱动它的 principal chat), 父归属与卡片路由两种模式一致; (2) 归属仍解析不出、`approver` 为 undefined 的子代理请求返回 `deny no_approver_for_subagent` (安全默认 + reason 引导配置), 而非 `ask`。

## [1.3.8] - 2026-09-07

### Added
- `daemon`: **切网后自动重建 WeCom WS 连接**。新增 `net-watch.ts` 轮询网卡 IPv4 指纹(5s 一拍,连续稳定 2 拍算 settle),换 WiFi / 插拔网线 / VPN 起停后立即原地 `disconnect + connect` 重建 socket——旧连接黑洞化时不再等心跳连续 miss 数个 30s 周期才恢复。相比整进程 reload,保留全部内存态(graph 运行、pending 长轮询、镜像绑定),且不依赖 launchd/systemd 的 respawn 策略。断网(指纹变空)只记日志不动作,等新网络 settle 后再触发。
- `mirror`: **触限额会话自动续跑** (`wrc.mirror.limitResume`, 默认开)。CC 触顶时写入 transcript 的 synthetic 限额行自带恢复时刻 (`quotaLimits.resetsAt`, epoch 秒; 旧版无此字段时从 "resets 2:30am" 文案按本机时区解析)。daemon 每 30s 轮询各 attachment: transcript 末轮是限额行 ⇒ 群里通知一次预定续跑时间, 到点 (reset + `delaySec`, 默认 60s) 后向仍停着的会话注入 `text` (默认 `continue`) 续跑。检测纯规则、逐轮从 tail 重推导, 无持久化 —— reload、人工亲自续跑、注入本身都靠「限额行不再是末轮」自然收敛; 再撞 429 会生成带新 resetsAt 的新限额行, 自动开启下一轮排定。pane 已死 (人收摊了)、正忙、`/stop` 静默中的会话不打扰。同时 keepalive 的 stall-resume 对已排定限额恢复的会话不再抢跑 —— reset 前注入只会再吃一条 429。

## [1.3.7] - 2026-09-07

### Added
- `mirror`: **subagent 执行过程进入 chat detail, Agent 调用期间气泡实时显示子 agent 状态**。Task/Agent 工具派出的子 agent 转录 (`<sid>/subagents/agent-*.jsonl`, claude/codebuddy 同构) 此前完全不可见 —— 主 jsonl 只有派发与最终总结, Explore 跑几分钟群里是黑洞。新增 `daemon/subagent-tail.ts` 观察器: 按 attachment 监听 subagents 目录 (fs.watch + 1s poll, 存量文件从 EOF 起、新 spawn 从 0 起拿到 task 原文; 目录跟随主 jsonl 实时路径, worktree 迁移不断流), 经各 backend 的 `normalizeLine` 归一后把子 agent 的 text/tool_use/tool_result/usage 记成带 `agent` 标记的 turn (`TurnDetailRecord.agent: {id,type,description}`), 在 chat 时间轴内联渲染 (绿色归属条 + 缩进卡片, 复用既有折叠工具气泡)。类型归属: claude 读 `agent-*.meta.json`; codebuddy 无 meta, 用父侧捕获的 Task/Agent 入参按 prompt 逐字匹配 (实测一致)。brief 气泡: 父 agent 阻塞在 Agent 调用期间, 子 agent 最新活动以 `🤖 type · 最新工具/思考行` 驱动 CoT 进度行 (last-writer-wins, 复用 1.5s 节流与 100 字单行约束), keepalive 吞没窗内静默。生命周期: 子 turn 随父 turn 收口统一关闭 (closeBriefTurn/finalizeStream/detach/migrate), 会话轮换重建 watch。

### Fixed
- `approval`: **子代理工具调用的审批归属修正 —— 与主会话同一套判定链**。CC/CodeBuddy 通常把子代理 hook 的 `session_id` 上报成父会话 id, 子代理工具调用因此天然被 `danger.skipAll` / 卡片 / ⏱窗口 / 缓存覆盖; 但部分 CC 版本 / IDE 集成会上报子代理**自己**的 session, 该 id 无镜像绑定时请求会落到 `ask` 兜底 —— 镜像 pane 里变成远程无人可点的原生确认框 (卡住、不下发卡片, 看似「不受 skipAll 控制」)。现在 hook 把 CC 的 `agent_id` / `agent_type` 透传给 daemon, daemon 在 mirror 模式下对「session_id 未绑定 + transcript_path 含 `/subagents/` 或落在父会话转录」的请求按 transcript 反推父会话并路由过去, 审批链 (skipAll/卡片/窗口/缓存/规则) 与主会话完全一致。
- `mirror`: **subagent watch 的 EOF/新文件判定修正 + codebuddy 类型归属真正落库**。
  - 此前 `subagent-tail` 首扫对已在盘的 agent 文件**从 0 重放**、之后出现的新 spawn 反而**跳到 EOF** —— 与注释/设计意图正好相反: daemon 重启、re-attach 会把历史 subagent 全量重放成新 turn (chat detail 里同一段执行反复出现), 而会话运行中新 spawn 的 agent (第二个起) 会丢开头、连 task 行都可能错过。现在以「目录是否已成功读过一次 + 文件 mtime 与 watch 建立时刻」判定: watch 建立前就在盘上的老文件从 EOF 起、不重放 (与主 tail 同语义); watch 建立后出现的文件一律从 0 起、完整拿到 task 原文。
  - codebuddy 无 `agent-*.meta.json`, 此前父侧 Task/Agent 入参按 prompt 匹配出的类型只喂了 brief 气泡的进度行, `TurnDetailRecord.agent.type/description` 仍旧是空 —— detail 页 header 只剩干巴巴的 `🤖 subagent`, 与气泡里解析出的类型自相矛盾 (codebuddy 恰恰是首个支持目标)。现在归属解析结果 (`resolveSubagentMeta`) 同时写进记录, 气泡 label 与 detail 页同源。
- `mirror`: **brief 模式 CLI-driven turn 不再单独发"只有链接"的空消息**。此前 `ensureBriefTurn` 通过 `sendRaw` 单独把 `briefDetailLink` 当一条 WeCom 消息推出去 (`web 团队 AI 助理 BOT` 列表里看到一条 `#dev` 标题但正文几乎为空,markdown 链接在客户端渲染为纯文本就成了"空消息");随后 `handleBriefItem`/`concludeBriefTurn` 走 standalone 推正文, 两条连发。现在把链接暂存到 `pendingBriefHeader`, 由该 turn 首条 standalone body (`concludeBriefTurn` / skill_output 路径) 取走拼到前缀, 一条消息同时含详情入口 + 正文。空 body 时整条丢弃、header 跟着清, 不会泄漏到下一 turn。CLI 输入触发 `/model` / `/context` / `/clear` 这类 skill_output 立即到达的命令时,群里从两条变一条,WeCom 渲染也好看。
- `launchd`: **plist 模板加 `SoftResourceLimits.NumberOfFiles`(65536),消除镜像会话一多 spawn 就 EBADF 的崩溃循环**。launchd 默认把软 fd 上限压在 256,而 daemon 启动时按活跃会话逐个恢复镜像(每个 = jsonl tail + subagent watchers + tmux spawn),几百个会话就把 fd 表耗尽,`spawn` 抛 `EBADF`、进程在 HTTP bind 之前就死,KeepAlive 陷入崩溃循环(`/status` 显示 down、`daemon.stderr.log` 报 `spawn EBADF`)。改口只在模板——已装的 plist 会被 `install.sh` 重新生成,手改 `~/Library/LaunchAgents` 那份会被覆盖。

### Changed
- **空消息门控 (chat-gate): 任何通道都不再下发"正文为空"的消息**。空 = 剥掉可路由头 (`🦊 #tag …` / `[🧙 #tag](url) 2/5 …`) 后没有任何可见内容 —— WeCom 把这种气泡渲染成一行光秃秃的 tag。两层拦截:
  - **中央 gate** (`daemon/last-response.ts` 的 SDK 包装层,单一缝全覆盖): `sendMessage` (markdown)、`replyStream` / `replyStreamWithCard` 的 `finish=true` 定稿帧,剥头后无可见正文一律丢弃并 warn 日志。两条豁免: `finish≠true` 的流式中间帧 (打字机 "…"/CoT 进度本来就可能暂时只有头,后续帧会覆盖); 附带 `templateCard` 的定稿 (卡片是载荷,丢卡片会卡死审批流)。headless (`cc-bridge`)、审批回执、MCP `send_markdown`、graph/peers 中继 (`notifyChat`) 等全部出站路径自动受保护。
  - **近源拦截** (`mirror-bridge`): `sendStandalone` / `sendRaw` / `enqueueStandalone` / `flushStandalone` 入口同判 —— 空内容不进 `standalonePending` FIFO、不占防抖 buf、不重置计时器,消除"空 part 入队 → flush join 出空串"的死角。
  判定复用 `parseTagHeader` (与引用去重同一套头解析),已验证: link-only / 纯 tag / 空白全拦, `[链接] 正文` / `🧙 正文` / 意外以动物 emoji 开头的正文全放行。

## [1.3.6] - 2026-09-04

### Added
- CLI/Skill: **`wezard update` 子命令 + `/wezard:update` skill —— 一键升级**。版本判定看**npm 全局副本**而非调用方副本（`npm view` 取 latest，全局已是 latest 则零操作退出；dev 检出领先 npm 时不会误判/误降级全局）→ `npm i -g wezard@latest`（postinstall 顺带 `claude plugin marketplace update` 刷新插件副本里的 hook/MCP/commands）→ **从新装目录 re-exec 收尾**（`__update-finish`，避免在已被 npm 替换的旧树上继续跑；新装副本是 < 1.3.6 旧代码时自动降级为旧副本自带的 `sync` + `reload`）。收尾按 launchd/systemd 记录的 daemon 家目录三分支：指向陈旧 npm prefix（nvm 换 node 后常见）先 HTTP 优雅停再重跑 `install.sh` 重指并顺带重启已注册的 svr；指向源码 dev 检出（`.git`/`tsconfig.json`）只 reload 不动 plist、并跳过 sync（dev 安装的 sync targets 必须继续指向 dev 仓库）；家目录缺失则提示跳过。非 dev 路径收尾统一跑 `wezard sync`（codebuddy hook 是打进本包的绝对路径，prefix 挪了必须重写）。升级后 hook 代码即时生效（每次 tool call 重新 exec），MCP server 与 commands 需重启会话，结束时打印提示。

## [1.3.5] - 2026-09-02

### Fixed
- `mirror`: **引用未收口的 last stream 不再把瞬态内容贴回 prompt**。tag 会话的出站流还在进行中时,群里最新气泡是实时中间态 —— 详情链接 URL + 最新一条 CoT/工具行 (brief) 或累积中的 acc (非 brief);此前引用它走 `quoteInContext` 两级判定 (lastResponse 只记 `finish=true`,transcript tail 里又没有 thinking/CoT 行) 双双 miss,URL 与实时工具/文本被整段注入正文。现在 mirror bridge 暴露 `isOpenBubbleQuote(target, quoted)`: 取该 target 未收口气泡的当前可见正文 (brief 为 `cotLastSent`/`cotText`,非 brief 为 `liveStream` 的 `acc`/`lastSent`),两侧先剥 URL 再做字母数字 canon 比对;引用剥完只剩 URL/省略号直接判命中。命中 ⇒ 只保留路由 tag,正文丢弃;引用旧气泡不受影响 (内容对不上未收口流,照旧走 tail 判定)。

### Changed
- MCP: **`enter` → `set_workspace`，换项目一步到位**。旧 `enter` 只写 pendingCwd、还要人去企微侧补发 `/new` 才生效；`set_workspace` 在 daemon 内部直接走完 `/new` 路径（`setPendingCwd` → 杀 pane → 新 cwd 重开 → attach → 📂 项目回执），等价于「cd 之后用户发了 /new」。调用方就是被换掉的会话时会被当场终止（工具结果不返回，回执气泡即凭证）；spawn 失败时切换仍留在 pendingCwd，手动 `/new` 可兜底。daemon 路由 `POST /mirror/cwd` → `POST /mirror/workspace`，`/pwd` 提示、tips、README、技术说明同步更新。

### Removed
- MCP `enter` 工具与 `POST /mirror/cwd` 写路由（读取用的 `GET /mirror/cwd` 保留），由 `set_workspace` / `POST /mirror/workspace` 取代。

## [1.3.4] - 2026-09-02

### Fixed
- `mirror`: **keepalive 静默判定改为按 user message 内容判断, 不再依赖内存计时窗口**。此前 ping/pong 是否进 chat 取决于 `keepaliveQuiet` 60s 窗口与 `isOwnInject` 60s TTL —— daemon reload / tail replay / 回复慢于 60s 时窗口失效, ping 原文与 pong 回复泄进群聊。现在 `renderLine` 对 user 行先做内容匹配 (`isKeepalivePing`, 与 `keepaliveStamps` 同一套归一化签名: `kc.ping` / `kc.resumePing` 前缀 + 裸 `ping`), 命中即发 `keepalive_start`, `onItem` 据此开启**内容级吞没** (`keepaliveByContent`): ping 行本身不回显、整轮回复(含 thinking/CoT 进度)全吞直到 `turn_end`; 真实 user 行或 5min fail-safe 兜底解除, 崩溃的 ping 轮不会永久静默真轮次。detail turn 与计时路径互不复开 (`fireKeepalive` 检查 `keepaliveTurnId` 已存在)。

## [1.3.3] - 2026-09-02

### Changed
- 文档: **README 与技术说明对齐现状并补全缺口**。README 目录补「跨聊天:给聊天命名」;init 问题表补 wrc 模式行(修复 4 问 ↔ 3 行不一致),前置与自动流程链补 `codebuddy` / 插件安装 / svr 详情中继 / Claude permissions 一次性导入。技术说明新增「多会话路由」(`#tag` 提取与剥离、auto-spawn、命名聊天四级地址空间、多 CLI 由 jsonl 路径反推 dialect)与「Prompt-cache 保活」(`lastMs`/`lastRealMs` 双时钟、四道判定门、零污染与 reload 不复燃)两章,均附流程图。

## [1.3.2] - 2026-09-02

### Added
- `wrc.allowFrom` 支持 `"all"` 通配: 数组含 `"all"` 时任何人可用 (鉴权、`/id` 授权状态展示同步生效)。

- `approval`: **新配置 `approval.danger.skipAll`(MCP key `danger_skip_all`) —— 跳过所有审批**。命中 matcher 的调用一律静默放行, 压过危险名单 / `askRules` / ⏱窗口 / 会话缓存; 与 `danger.skip`(只豁免名单命中) 成对、跳过范围递增。`denyRules` 拒绝与 `EnterPlanMode` 拦截仍生效 (拒绝不是审批), `AskUserQuestion` / `ExitPlanMode` 交互卡不受影响。与 `approval.enabled=false` 的区别: skipAll 明确回答 allow (CLI 零打扰), enabled=false 回答 ask (退回 CLI 本地权限)。`config_set` 的 `approval_mode` 增加枚举校验 (非法值会让 daemon reload 时 zod 抛错起不来)。新增 [审批配置.md](审批配置.md) 覆盖审批粒度、两个跳过开关、判定链与运行时切换。

- `mirror`: 新配置 `wrc.mirror.slashAckFirstLine`(默认 `false`)。开启后 `/clear`、`/new` 的会话边界回执只发第一行 ack(`cleared` / `created`),不再附 📂 项目信息与 💡 tip;含 `/clear`→`/new` 升级路径。cwd 随时 `/pwd` 可查。已加入 MCP `config_set` 白名单(key `slash_ack_first_line`),可在 wezard 会话里直接开关,写盘 + 内存即时生效、无需 reload。

## [1.3.1] - 2026-09-02

### Changed
- `mirror`: **对话边界收口不再凭空新发/覆盖消息**。连续发消息触发上一轮的强制结束时:(a) 有正文才写 —— brief 气泡以 `链接 正文` 收口、非 brief 的 liveStream 以累积 acc 收口、deferred 缓冲收入旧 streamId(`finish=true` 顺带关掉它的 loading 气泡),不再整体另发 standalone;(b) 没正文一个字都不写 —— 旧代码的裸链接/`" "` 空收口会把 `链接 …`/CoT 进度行整条覆盖掉,结束处理自己制造错发,现在气泡保持现有内容由企微 6min 窗口自然到期。`closeBriefTurn` 软/硬/边界三路统一为先 `concludeBriefTurn(briefLastText)` 再清态,`soft` 形参移除。

- `mirror` brief: **CoT 进度行的内容源补上非终句文本**。此前只取 thinking 与工具调用,模型在工具之间打的叙述性文字("我先看看这个文件…")不进气泡;现在进度行取"最新一条 CoT 内容"——thinking / 非终句文本(软后端含最终答案本身,收口时整条被覆盖)/ 工具调用,三类 whichever-latest。

## [1.3.0] - 2026-09-02

### Added
- `mirror` brief: **气泡在正文落地前实时显示 CoT 进度**。一轮里正文要等 final text 才落地,中间几十秒到几分钟气泡只有一个 `…`;现在最新的 thinking(codebuddy 的 reasoning 归一后的 `thinking` 块)与工具调用会持续覆盖进这条未收口的气泡,形态为 `tag 详情链接 \`进度片段…\``,片段压成单行、截断 100 字符(尾随省略号兼任"进行中"标记, 与截断标记合一不叠加)、刷新节流 1.5s。只写"还没收口的气泡":结论一到即被 `链接 正文` 整条替换,进度不残留在最终气泡里 —— 这是它与已下线的 thinkStyle 的分界线(后者把整轮 reasoning 拼进正文,单条体积翻几倍被分页切成多页刷屏)。

### Changed
- `mirror`: **新消息即对话边界 —— 上一 turn 的出站状态当场全部收尾,新回复只走最新气泡**。收到 WeCom 新消息时:(a) brief 模式立刻收掉上一 turn(气泡以详情链接收口、CoT 进度撤销、turn 记录关闭),新 turn 直接激活,不再排队 —— 排队 turn 的 frame 在前一个长 turn 期间(可达数分钟)过期,激活后 `replyStream` 全被企微拒收,是 #stream 会话"发卡后 mirror 静默"的根因;(b) 非 brief 的 deferred 缓冲(已消费未下发的 item)冲成 standalone 收尾,不再静默丢弃;(c) 旧 turn 挂着的 `softEnd` 静默期判决撤销,防止它在新 turn 中途开火提前收掉新气泡。`briefQueue` 排队机制随之整体移除;代价是旧 turn 页提前标"已完成"、CLI 侧仍在产出的尾部 item 记到新 turn 名下 —— 这正是"新回复走最新气泡"的语义。
- `mirror` brief: **收到消息那一刻就把详情链接挂进气泡**,ack 内容从 `…` 变成 `tag 详情链接 …`。链接的三个入参(turnId / target / host)在收消息时全部已知 —— turnId 本地生成、详情页记录由 `recordTurnStart` 先建好 —— 所以无需等任何 CLI 产出;尾随的 `…` 表示"正文还没到",正文到位时整条内容被 `链接 正文` 覆盖,始终没正文则以纯链接收口。此前是"3s 无产出才补链接"的 `earlyTimer`,既被 codebuddy 后端整体跳过,又会被 `user_text` 清表,实际常年不触发,气泡整轮停在纯文本占位上。
- `mirror` 分页预算改按**字节**计,单页上限抬到 3800B(`wrc.mirror.chunkChars` → `chunkBytes`,默认 `1800` → `3800`)。企微 markdown 的 `content` 上限是 4096 **字节**而非字符,旧的字符预算对英文浪费了大半页,对中文又必然超限;`shared/md-chunk` 的 `sizeOf` / `sliceLine` 同步改成 `Buffer.byteLength` 计量,长行按 code point 切(不再切断 emoji 代理对)。头部分片预留 32 → 64B(链接态 `[🧙 #tag](url)` 可达 110B)。
- `mirror` brief 模式: **气泡不再按"有无工具"分岔**。此前无工具的 turn 以 `正文\n\n链接` 收口(经 `withLinkedTag` 再包一次头,群里出现两个链接),有工具的走另一条路;现在统一为 `链接 正文`,`briefHadTool` 只用于判断 slash 命令的 `skill_output` 是不是本轮答案。

### Removed
- `mirror` **think-style 实验下线**: `wrc.mirror.thinkStyle` 及 `pushThink` / `doStreamThink` / `formatThinkStandalone` 全套移除(`<think>` 折叠区、standalone 的 `💭` 传输标记、`parseTagHeader` 的 `<think>` 剥离一并清掉), 实验代码保留在 `backup/think-style` 分支。

## [1.2.31] - 2026-09-01

### Fixed
- `mirror` think-style: **气泡收口后的 reasoning 不再作为裸正文泄进聊天**。长 turn 里气泡一旦收口(6min 编辑窗口、`earlyLinkBubble`、工具密集),后续落盘的 thinking 只能走 standalone 补发,而 standalone 的 think 识别只认 `🔧` / `↳` 两个工具行前缀 —— 纯 reasoning 段落被当成正文整段裸奔出去。`pushThink` 现在给进 standalone 的中间内容打 `💭` 传输标记,`formatThinkStandalone` 凭它分流入 `<think>`(标记在渲染时剥掉;`🔧` / `↳` 是给用户的工具行标记,保留)。
- `mirror` think-style: **软后端(codebuddy)的最终答复不再被误包进 `<think>`**。软后端没有 `final` 标记,终句与中间文本共用 `final===undefined`,此前一律走 `pushThink` —— 气泡活着时无害(收口有 `stripTrailingBody` 剥重复纠偏),气泡死了就等于给答复打上 think 标记直接发出去。现在该分支按气泡状态分流:活则仍进 think 累积并记 `briefLastText`,终句身份留给 `closeBriefTurn(soft)` 定夺;死则按正文发 —— 没有收口阶段可纠偏,而它很可能就是终句。

## [1.2.30] - 2026-09-01

### Changed
- `mirror` standalone 防抖窗口默认 `8s → 30s`(`wrc.mirror.standaloneDebounceMs`)。长 turn 里工具调用之间的间隔动辄十几秒,8s 仍会切成多条气泡;30s 能把一整段工具链聚合成一条再补发。

## [1.2.29] - 2026-09-01

### Changed
- `mirror` standalone 防抖窗口默认 `3s → 8s`(`wrc.mirror.standaloneDebounceMs`)。连续工具调用间隔常超过 3s,窗口太短仍会按气泡刷屏;8s 能把一整串工具调用聚合成一条 markdown 后再补发。

## [1.2.22] - 2026-08-27

### Changed
- `mirror` think-style: **中间过程实时流进 `<think>`,不再只在收口时拼前缀**。开启 `wrc.mirror.thinkStyle` 后,本轮的 reasoning、非 final 的中途文本、以及**每一次工具调用/结果**(`🔧 Name …` / `↳ …` 摘要)都实时追加进气泡里那段 `<think>🧙 …` 流,只有 final 文本才结束思考、落成 `</think>` 之后的正文。用户一发消息气泡立刻以 `<think>🧙 #tag ` 开头(tag 塞在 `<think>` 内),看得到 Claude 正在想什么,而不是先干等一个 `…` 占位再一次性出全文。

### Fixed
- `mirror` think-style: **气泡过了 6min 编辑窗口后,累积的思考不再丢**。窗口外气泡刷不动了,改走 10s 防抖把 think 增量整段补发成一条独立 `<think>🧙 …</think>` standalone;turn 收口时冲干净残余,不漏最后一段思考。
- `mirror` think-style: **软后端的最终正文不再重复出现一次**。软后端(如 codebuddy)的最终正文会先作为「非 final 中途文本」进过 think 流,收口再当正文用一次;收口前把 think 尾部恰好等于正文的那段剥掉(含前导 `\n\n`),保证正文只出现在 `</think>` 之后一次。
- `inbound` 引用去重: **带引用新建 / 改投到别的 `#tag` 时,原文不再被重复注入**。去重比对的会话改成引用气泡真正的**源会话**(反解 `emoji #tag` 头得知),而非路由目标——原文天然存在于源的 transcript,与你把它投到哪个 tag 无关;源未知(用户自打的引用)才回退按目标查。
- `inbound` 引用去重: **引用一个 `🔧 Grep …` 工具气泡不再误判为「不在上下文」而重复注入**。末轮 transcript 的扁平化文本现在也纳入 `tool_use` / `tool_result`(工具名+入参、结果文本),与出站工具气泡的 `🔧 <Name> <input>` / `↳ <result>` 渲染对齐,子串比对才能命中。
- `session-label` `parseTagHeader`: **think-style 气泡被引用时能正确反解出 tag 头**。tag 头此时塞在 `<think>` 内(`<think>🦊 #fix …</think>\n\n正文`),微信引用时 `<think>` 标记有时保留有时被渲染剥掉;现在先剥掉可能存在的起始 `<think>` 再认头,body 保留 think+正文全文(仅去 `<think>`/`</think>` 标记杂质),`canonContains` 子串比对必然命中。
- `approval` 「聊聊这个」: **补第二个 Enter,talk-about-this 不再卡在提交页**。自定义文本确认为本题答案后前进到提交页,还需再一个 Enter 在提交页(光标 0 = `1. Submit answers`)收工;缺它 CLI 会一直等输入。

## [1.2.21] - 2026-08-25

### Fixed
- `peers`: **compound `chatName#tag` 地址在用户正文里被正确识别并标注**。此前 `#tag` 的正则要求 `#` 前有空白,导致 `sanitizer#handle824` 这种紧凑写法对路由和标注都不可见——消息整条落进本 chat 的默认会话,目标 chat 里什么都没被创建。现在 `peerMentions` 在 `allTags` 之外额外扫描 `word#word` 形式的 compound 地址,chat 名合法即标注;目标会话尚不存在时(unborn peer)也注入提示,告诉 agent 先 `new_claude_session` 再 `send_peer`。

### Changed
- `launchd`: plist 模板移除 `NODE_ENV=production`——daemon 不依赖该变量,且它会干扰 tsx dev 模式。

## [1.2.20] - 2026-08-24

### Fixed
- `sessions`: **`new_claude_session` 在调用方自己的 chat 里建 peer**,不再掉进 `defaultChat`。这个工具此前不带 `selfRef`,daemon 只能 `target ?? cfg.defaultChat` 兜底,于是非 default 会话里的 agent 一喊「新开一个会话」,session 就落到另一个群里 —— 叫它的人既看不见也够不着;而且落点是**不带 tag 的 key**,那就是那个 chat 的默认会话,attach 直接把原本镜像在那儿的会话顶掉。现在:调用方按 `sessionId` / `tmuxPane` 解析出自己所在的 chat,新会话一律带 `#tag` 落成同 chat 的 peer(tag 可显式给,省略则由目录名派生并去重;撞上已存在的 tag 直接拒绝,而不是 respawn 掉那个正在跑的 peer),并且改走 `newSession` 而非裸 spawn+attach —— cwd/CLI 的 chat 级继承、tmux 窗口名、以及「created + 📂 当前项目」那条气泡全都和用户手打 `/new #tag` 完全一致:群里发得出消息、chat detail 里有记录、`list_peers` / `send_peer` 立刻能寻址。

### Added
- `chats`: **给聊天命名,跨聊天寻址与建会话**。一个 WeCom 聊天的身份是 `chat:wrkS…` 这种既读不出也打不进去的 id,所以在此之前跨聊天只有「全局唯一 tag」一条路:两个群各有一个 `#fix`,就谁也叫不动谁,唯一的出路是回去改别人的 tag。现在 `/name daily` 给聊天起个名(`/name` 查看、`/name -` 取消;名字全机唯一、大小写不敏感,落在 `config.jsonc` 的 `chats` 里,和 `topics` 同一套写法),地址空间随之变成两级:`fix` 仍是本聊天的 `#fix`(老语义一字不改,不唯一时才回退全局搜),`daily#fix` 精确到那个聊天的那个会话、不问 tag 全不全局唯一,`daily#` 是它的默认会话。`send_peer` / `peek_peer` / `wait_peer` 都收这个全称,`list_peers` 的每一行现在直接给出该照抄的 `address`,`foreignPeers` 也从「只有全局唯一 tag」放宽到「全局唯一 tag **或** 所在聊天有名字」。新增 `/chats` 与 `list_chats` 作为跨聊天目录(谁有名字、各自跑着哪些会话),以及 `name_chat` 让 agent 也能读写名字。最后一块:`new_claude_session` 新增 `chat` 参数,可以直接在**另一个已命名的聊天**里建 peer —— 「目标 peer 还不存在」不再需要找个人去那个群里手打 `/new`。未命名的聊天依旧无法被寻址、也无法被建入,这是刻意的:往一个谁也读不出的 `chat:wr…` id 里塞会话,等于把它扔进一个调用方根本不该进的群。
- `peers`: **跨 chat 的 peer 寻址**。`send_peer` / `peek_peer` / `wait_peer` / `handoff` 的 `tag` 参数在本 chat 找不到目标时,会在全 host 的 sessions 里回退搜同名 tag —— 只当命中数**正好为 1** 时才认(0/多命中都拒绝、把原因回给调用方),把「跨 chat 交接」收敛成「让目标群里的 peer 起一个全局唯一的 tag」这一个约束,不引入 alias 表、不改授权模型。相应地 `list_peers` 新增 `foreignPeers`(其他 chat 里全局唯一 tag 的 session 列表),给 agent 发现可跨群命中的 peer。跨 chat 的 relay 气泡两侧 chat 都会推,免得被叫的那侧看不到「另一个群的 agent 找上门了」这件事。典型用法:daily 语料链的 peer 产出 corpus,直接 `send_peer("sanitizer-ingest")` 交给 sanitizer 群里的 `#sanitizer-ingest` 继续。

## [1.2.19] - 2026-08-19

### Fixed
- `approval`: `.claude/**` 守卫退出 `mustCard` 语义——守卫要的不是「强制发卡」而是「allow 之后有人去按 CC 原生框」,⏱ 自动过窗口恢复生效。排掉 `.claude/worktrees/**`(整棵检出代码树,非配置面）但 worktree 自己的 `.claude/` 仍拦截。错误出口保持 `ask` 降级;收尾按 sessionId 串 promise 链防并发代按;必发卡按钮面改由 `forceSingle` 决定。

## [1.2.18] - 2026-08-19

### Fixed
- `approval`: 时间窗按钮不再是红色(企微 `style:3` 渲染成红色,与「放行」语义相悖),改 `style:1`(蓝)+ 文案 `⏱10h自动过` 点明语义;单条卡与批量卡同步。

### Changed
- `keepalive`: **每轮心跳都发完整指令**,不再从第二轮起缩成裸 `ping`。缩写省下的那点 cache-write 换来的是不确定的回复 —— 裸 `ping` 在模型看来只是一次普通提问,爱怎么答怎么答,而任何非 `pong` 的回复都会被当成真实活动:心跳被"解吞"发进企微、`lastRealMs` 重新锚定、轮次计数清零。完整指令每轮重述,回复才稳定是 `pong`。`keepaliveStamps` 仍认裸 `ping`(旧 transcript 里还留着)。

## [1.2.17] - 2026-08-17

### Fixed
- `approval`: 「✅总是」补两处遗漏。① **批量卡上也给这个按钮** —— 合流的成员是同一个工具的 N 次调用,单卡有「总是」而批量卡没有,只能先等它拆开或逐个点,机制在最需要的场景(一串同类调用)恰好用不上;逐位成员各自走一遍规则生成,已被现有规则覆盖的不重复加,结果与逐个点「总是」一致。② **`.claude/**` 守卫生效时不生成规则**,并说明原因。此前这种卡上点「总是」会存下一条**永远被守卫压过**的死规则,更糟的是万一日后关掉守卫,这条 allow 就把静默死锁原样放回来(不发卡 + pane 无限期阻塞);现在只做一次性放行,并回执讲清「那个原生确认框只有在你点过卡之后才能被代按,免审就等于回到死锁」。同理,「提炼不出可靠字面规则」的兜底提示也不再在守卫卡上误报。
- `ws`: WS 握手加 15s 超时,防止睡眠唤醒后 TCP 通但 upgrade 不返回导致重连链悬挂、对企微永久失聪(补 #7 之外的第二条失聪路径)。

## [1.2.16] - 2026-08-12

### Changed
- `approval`: **审批卡信息架构重排** —— 解决的是「看不出这张卡要批的是什么」。旧布局把 `🔐 授权 · <工具名> · <目录>/` 放在一级标题(26 字里有 8 个花在固定的锁图标与「授权」二字上),真正决定要不要点的**命令主体**却挤在描述行里被截断;并行跑多个会话时,几张卡长得一模一样,分不清是谁在请求。新布局按「谁在问 > 想干什么 > 具体命令 > 上下文」重排:一级标题放 Claude 自己写的 `tool_input.description`(它回答"想干什么",是 26 字里最值钱的内容;没有 description 的 `Read`/`Write`/`Edit` 回落「工具 · 目录/」,因为路径在下面引用区里已经有了);**命令主体搬进 `quote_area`**、无标题、整块可点进详情页;`horizontal_content` 放「上文」(最近一条用户消息)与**为什么要人来点这一下**(危险卡显示命中的名单规则,普通卡显示「审核」行 —— 即这条命令是**哪一段**没被 `allowRules` 覆盖,能算出规则时直接显示「点总是会生成什么」;没配任何规则时这行不显示,免得变成每张卡都有的噪声)。
- `approval`: **卡片标题带会话名** —— 一个 chat 里并行跑多个会话时,`⏱`/`✅` 点下去到底作用在谁身上是靠猜的。会话名按可靠度降级取:`#tag`(企微侧显式命名,人起的名最准)→ Claude Code 自己的会话名(`~/.claude{,-internal}/sessions/<pid>.json` 注册表的 `name`,即 CC 会话列表显示的那个;只覆盖活着的进程,而发卡时会话必然活着 —— hook 正是它触发的)→ transcript 首条用户消息首句 → sessionId 尾八位。发卡时算好写进 pending,已决卡重渲染直接复用(点击事件回调里拿不到 `transcript_path`,现算不出来)。
- `approval`: **长命令看全文的两条路径**,都挂在卡片自己身上,不再默认额外推一条全文消息:引用区整块可点 → 详情页(有高亮,PC 端好用);右上角「⋯」→「📄 展开完整命令」→ 按需在群里发全文(不跳出企微,手机端可用,按 1800 字/条分块)。起因是手机端客户端**实测只渲染 `quote_area` 前 2~3 行**,长命令在卡上根本看不完,而无条件先发一条全文消息会把群刷满。新增 `approval.cardQuoteMaxChars`(默认 1200;企微未公开 `quote_text` 上限,发送失败自动缩到 600 重试一次)与 `approval.fullCommandPreludeChars`(默认 **0 = 关闭**旧的无条件前置;设正数可恢复,用于客户端不渲染 `action_menu`、或就是要全文无条件落在群里的场景)。

### Added
- `approval`: 审批卡新增 **「✅总是」按钮** —— 由本次调用生成 `allowRules` 规则,热生效 + 追加写回 `config.jsonc`(对齐 Claude Code 原生弹窗的 Always allow)。解决的是三层规则的**上手断层**:规则机制有了,但要用就得离开企微、打开 `config.jsonc`、自己想清楚该写 `Bash(git log *)` 还是 `Bash(git *)` —— 于是绝大多数人一条都不配,继续每次都点卡。现在在手机上点一下就长一条规则出来。生成器 `alwaysAllowRulesFor`(已随三层规则合入,此前没有调用方)负责挑安全的字面前缀。三种「点了但不该存」的情况都**明确回执、不静默**:① 命中 `askRules` → allow 永远被 ask 压过,存了是死规则,提示要改 `askRules`;② 命中危险名单 → 提示只能用 `danger.allowPatterns`;③ 提炼不出可靠前缀(含 `$()`/反引号、未闭合引号、异形段首)→ 说明**具体是哪一种**成因后一次性放行。规则生成用未脱敏的原始 `toolInput`(`sensitiveArgRedact` 改写过的副本会生成匹配不上真实命令的前缀)。写盘失败只 `warn`、不回滚内存,本次点击的意图不因文件权限问题丢失。
- `init`: **一次性导入 Claude Code 的 `permissions`**(`wezard init` 交互确认,或 `wezard-init --import-claude-permissions [settings.json]` 随时增量重跑)。三层规则的语法本来就是 Claude `permissions` 的子集,而用惯 Claude Code 的人手上早就攒了几十条 allow/ask/deny —— 让他为了少收几张卡再手抄一遍 `config.jsonc` 是没必要的门槛,而门槛的实际后果是规则一条都不配、继续每次都发卡。`mapClaudePermissions` 逐条映射,引擎不支持的条目(如带 `//` 路径限定的 `Read(~/foo/**)`、`WebFetch(domain:*)`)**跳过并计数报给用户**,不静默丢。写回走 `appendUnique`,重复导入不会堆出重复规则。刻意只读一次、不做运行时耦合:Claude 的配置格式演进不会影响 daemon,导入后 `allowRules` 由 wezard 自管。
- `approval`: **`.claude/**` 写守卫** —— 补一个架构级的静默死锁。改动 Claude 自己的配置面(`settings.json` / `hooks` / `skills` / `commands` …)时,Claude Code 会立起它**自己的**原生确认框,而那个框**不经过 PreToolUse hook**:企微端既看不到也点不到,pane 就无限期阻塞,用户只看到会话「卡住了」。配了 `allowRules` 之后更糟(尤其从 Claude `settings.json` 批量导入的宽规则):规则一放行 = 不发卡 + pane 静默阻塞,连「有东西在等确认」这个信号都没有。现在命中 `.claude/**` 写、且该 session 有**活 pane** 可代按时强制发卡(压过 `allowRules` / ⏱窗口 / 会话缓存),用户点「允许」后 daemon 去 pane 上把那个框按掉。代按的边界刻意收得很窄——它做的是「完成用户已经作出的决定」,不是替他决定:只认标题形如 `Do/Would/Should you …` 的**权限**确认框(`/model` 选择器、plan review 同样是 modal 但语义完全不同,一律不碰)、只挑**裸 `Yes`**、永不选 `Yes, and don't ask again` 这类放宽后续权限的选项、只取屏上**最后一组**连续编号选项(屏上残留的旧确认不会被误按)。挑不出可信选项就不按:Esc 取消本次调用,再把原因作为一条用户消息注入会话,模型收到的是「这条路走不通 + 该怎么绕」,等价于预拦截 `deny + reason`。没有活 pane(headless / 未镜像的本地会话)则**完全不介入**——那种情形用户就在键盘前,自己按掉即可。新增配置 `approval.claudeConfigGuard`(默认开)/ `claudeConfigModalWaitMs`(4s;CC 要等 hook 进程退出才渲染那个框,所以代按只能在响应发出之后 fire-and-forget 地轮询等它出现)。路径判定 `claudeConfigWrite` 是纯函数:认 `Write`/`Edit`/`NotebookEdit` 的 `file_path` 与 Bash 重定向目标,按**路径段**比较(`.claude` 必须是完整一段,`foo.claude/x` 不算),软链目标也解析,`Read` 不拦。新增 36 例测试(`tests/claude-config-path.test.ts` 20 例 + `tests/modal-pane.test.ts` 补 6 例选项解析与代按挑选)。
- `approval`: **Claude-Code 风格的三层规则** `allowRules` / `askRules` / `denyRules`(语法子集见 `shared/allow-rules.ts`),判定链 `denyRules → danger → askRules → allowRules → ⏱窗口 → sessionCache → 发卡`。补的是 `matcher` 的粒度缺口:`matcher` 只认工具名,而「`git log` 免卡、`git push` 必卡」这类区分只能按**命令前缀**表达。支持 `Read` / `mcp__server__tool` / `Bash(git status)` 精确 / `Bash(git log *)` 前缀 / `Bash(npm run test:*)` 冒号前缀。安全语义都在纯函数里,可单测:复合命令按 `&&` `;` `|` 逐段校验(**任一段没被覆盖就发卡**,`ruleMatchesAny` 对 deny/ask 则是任一段命中即生效)、反斜杠转义的分隔符不切、引号内的分隔符不切、heredoc 体不参与匹配、段首 `VAR=value` 前缀剥掉后再比、fd 重定向里的 `&` 当数据而非后台符、命令含 `$()`/反引号一律不命中(展开结果静态判不了)。`AskUserQuestion` / `ExitPlanMode` / `EnterPlanMode` 在引擎内部硬保护,写了规则也不放行。**危险名单(`danger`)与 `askRules` 同层、排在 `allowRules` 之前**:否则一条 `Bash(git *)` 这样的宽 allow 规则就能让整份危险名单失效;`danger.skip` / `danger` 模式的早退也不再顺带关掉用户显式配的 `askRules`(`dangerEarlyExit`)。`fallbackOnError:"allow"` 的降级保护同样从「只护 danger」扩到「护住一切必发卡的请求」—— 否则 daemon 挂掉时 `askRules` 反而失效。新增 88 例单测(`tests/allow-rules.test.ts` / `tests/deny-reason.test.ts` / `tests/danger-early-exit.test.ts`,独立可执行,无 runner 依赖)。
- `inbound`: `/kill` —— 结束会话并移除 pane。先 Esc(给 CLI 一拍收尾 transcript 的时间)再 `kill-pane`,随后 detach 并**丢掉持久化绑定**:留着的话下一条消息会走死 pane 的 `--resume` 自愈把它原地复活,与 `/kill` 语义相反。之后该聊天的下一条消息自动新开会话。与 `/stop` 一样按 `#tag` 路由(`/kill #docs` 只干掉那个兄弟会话)。
- `chat details`: turn 记录带上运行时 `cwd`(取自 pane 的 `runningCwd`,而非全局 `wrc.cwd`),详情页两处呈现:顶栏 `📁 …/尾两段`(hover 出全路径)、侧栏会话行末尾 `📁 <目录名>`。同一 chat 的兄弟会话可以各跑各的目录(主仓 / worktree),不标出来光看 `#tag` 分不清谁在哪。
- `keepalive`: stall 恢复,**纯规则判定、不让 model 自判**。transcript 末轮是 synthetic API-error/limit 行(`API Error: Connection closed mid-response` / `You've hit your session limit`),或空闲 pane footer 出现错误横幅 —— 判定某轮因限流/接口失败中途夭折,ping 改发 `resumePing`(直接“继续未完成的工作”)。新增 config `keepalive.resumeOnStall`(默认开)/ `keepalive.resumePing`;`transcriptStalled` / `paneIsStalled` 两个规则信号。
- `inbound`: **引用即路由** —— 直接「引用」某个 `#tag` 会话的气泡来回复,等价于手打该 tag,消息投递到那个会话;且 quote 内容**不再进 prompt**(被引用的那条本就在目标会话自己的上下文里,重复贴入纯属污染)。识别依据是出站气泡的 `emoji #tag` 头(`parseTagHeader`,裸头与 chat-detail 链接头 `[🦊 #fix](url)` 两种形态都认,分片序号 / `← View chat details` 一并算作头),用户自己发的行首 `#tag` 消息同样可被引用。引用之外自己打的 `#tag` 优先级更高。配套规则:引用内容若**已在目标会话 context 尾部**(先比对最近一条出站气泡,miss 再归一化匹配目标 transcript 末 12 轮)则只保留这层路由绑定、正文丢弃;不在(跨会话转发 / 引同事的消息 / 目标已 `/clear`)才照旧渲染成引用块。text / image / mixed 三条入站路径统一走 `composeInbound`,图片消息因此也能被引用路由到 `#tag` 会话。
- `keepalive`: ping 的 assistant 回复只要不是纯 "pong" 即视为 real activity —— 从 chat 里放行(un-swallow)整轮续跑内容,并重锚 `lastRealMs` / 重置 round 预算。据此“回复是 pong 还是其他内容”刷新真实输出时钟。

- `chat details`: **graph 归因**。graph 注入的每一轮在 turn 记录上落一枚 `origin`(`runId` / 轮次 / 步序 / `fromTag`),随 `details.jsonl` 持久化 —— graph run 本身是内存态,一次 reload 就没了,归因必须自己过夜,否则重启后历史 turn 说不清是谁派的。三处呈现:turn 卡片顶部的紫色归因条(与上下文断点条并列,两者可同时出现)、侧栏会话行的 `🕸 runId` 徽标(区分「有人在跟 #fix 说话」和「graph 在喂它」)、以及主区顶部的运行条 `🕸 id · 🦊#fix → 🐢#review · ⟳ 轮 3/5`,当前步高亮、可点击跳转。**不画节点图**:`steps` 结构上不可能分叉,拓扑永远是一条线,画出来是纯装饰;真正有信息量的时间维度已经由 thread 承载。运行条的流水线从这些 `origin` 反推(`graphSummaries`),不依赖内存 run,svr 侧同样成立。

### Changed
- `peers`: **peer 之间的对话改从 transcript 读,不再抓 tmux pane**。`peek_peer` 返回 `dialog` —— 目标会话最近 N 轮的真实对话(`▸` 问 / `◂` 答),来自它自己的 jsonl:整条消息(pane 会被视口截断)、无 ANSI / TUI 噪声、天然带 role。pane 只保留两个它独有的职责:`busy` 判定,以及 transcript 尚未可读(没绑定 / 刚 `/clear`)时的兜底 `pane` 字段。入参 `rows` → `turns`(1-40,默认 6)。新增 `renderDialog`(纯函数)/ `peekTurns`(bridge)。
- `peers`: **agent↔agent 的问询与回复下发到 chat**。`send_peer` 注入成功后推一条 `<发起方> → <目标>` 气泡带原文,`wait_peer` 等到目标真正空闲后推一条 `<目标> → <发起方>` 带回复(超时不推 —— 半截的回答不是答案)。此前这些流量只发生在两个没人盯着的 pane 里。
- `graph`: 步骤气泡带上流量本身 —— `▸` 本步注入的 prompt、`◂` 该节点的回复,而非只有 `2/6 ✅`。
- `peers`: `keepaliveStamps` 判据从「紧跟 ping 的 assistant 回复一律算 keepalive」收窄为「仅纯 pong 算 keepalive」,配合 stall 恢复识别续跑;签名改收 `pingSigs: string[]`(同时匹配普通 ping 与 resume ping 的注入 user 行)。
- `peers`: `/peers` 输出重排 —— 摘要文本剥掉 markdown 活跃字符(反引号/星号/竖线,来自 transcript 的原文会被 WeCom 渲染成代码块而撕裂排版),同值字段(项目目录 / CLI)上提到标题行,条目之间空行分隔。
- `mirror`: 移除 `broadcastTo` 转发管道 —— `base#tag` 与 `base` 剥出来是同一个 WeCom chatid,节点自己的推送本就落在这个会话里,再广播一次纯属重复。

### Removed
- `keepalive`: 移除 KeepAlive 心跳通知(`keepalive.notify` 配置项及第 1/3/6 轮的 `KeepAlive n/N · ~Nk` 气泡)。保活是纯后台省钱动作,群里不需要看见;完整 ping/pong 仍留痕在 chat detail 时间线。

### Fixed
- `sessions`: **`/sessions` 扫描的子进程加硬超时**(`SCAN_CMD_TIMEOUT_MS`,15s)。`session-scan.ts` 的 `runCmd` 是上一轮 tmux 超时收敛漏掉的第四条 exec 路径 —— 它跑 `lsof` 和 `tmux`,两者都能无限期挂住:`lsof` 卡在僵死的网络挂载上、tmux server wedged。挂住的后果比丢一次扫描严重得多:`/sessions` 永远不回答,调用方的 `await` 也永远不返回。现在到点 `SIGKILL` 并退化成「没有输出」,与其它失败路径同一处理。
- `approval`: **`askRules` 的「必须单独确认」补齐到所有旁路**。上一版只在判定链上让 `askRules` 压过 `allowRules` 与 ⏱窗口,但发卡之后的五条旁路仍然只认 `danger`,于是命中 `askRules` 的卡照样会被绕过:① 另一张卡的「⏱ N 分钟全过」sweep 把它一并放行(`resolvePendingsByChat` 只排除 `p.meta.danger`);② 与其它请求合流成批量卡,被「全过」一次点掉;③ 命中会话缓存直接放行;④ 用户在这张卡上点「本会话都放行」/「N 分钟全过」时落缓存、开窗口;⑤ daemon 超时/断线时走 `fallbackOnError:"allow"` 静默放行(`fallback` 的第三参已改名 `forceSingle`,但传进去的仍是 `danger`)。现在这五处统一判 `mustCard`(危险名单 ∪ `askRules`),并把「必须单独点」作为 `forceSingle` 落到 pending meta 上 —— `danger` 字段退回只负责卡片渲染(⚠️ 标题 + 去掉「全过」按钮)。
- `mirror`: **tmux 调用全部收敛到一条 exec 路径并加硬超时**(`TMUX_TIMEOUT_MS`,默认 10s,`WEZARD_TMUX_TIMEOUT_MS` 可调,0 关闭)。此前 daemon 里有三份手写的 `spawn("tmux", …)`(`spawn-tmux.runTmux`、`mirror-bridge` 模块级 `tmuxRun`、`startMirror` 内又一个同名局部 `tmuxRun` 遮蔽了它),全部无超时:tmux server 一旦卡住,调用方永久 pending 且零日志 —— 一条入站消息建了 pane,随后 `tmuxPaneAlive` 再也不返回,该会话的 inject 队列被僵尸 job 锁住,那个聊天从此彻底静默,只能重启 daemon。现在三处合一,超时用 `SIGKILL`(卡在 wedged server 上的 tmux client 不理 `SIGTERM`)并以普通失败态 resolve,所有现存 `if (!r.ok)` 分支照旧生效;超时必留痕,由 daemon 启动时注入的 reporter 打 `warn`。`load-buffer -` 这类 stdin 变体一并走同一路径。
- `mirror`: **inject job 加 watchdog**(`INJECT_JOB_TIMEOUT_MS`)。job 链上每个 `await` 原本都是无界的,超时后队列不再释放;现在到点释放队列、告知用户,并 bump `injectGen` 让僵尸 job 醒来后不再往 pane 里贴。job 起手先打一行 `inject job start`,下次卡住能定位到具体步骤。
- `mirror`: **`/stop` 改为先收口、后 Esc**。旧实现先探 pane、探不到就早退 —— 而 tmux 本身就是卡住的那一环时,用户手上留着一个关不掉的 `…` 气泡和一条谁也过不去的 inject 队列。现在先做与 tmux 无关的部分(bump `injectGen`、清 inject 队列、收掉所有挂起气泡/stream),再尽力 Esc;Esc 失败只报告不致命,并带上收了几个气泡。只想按 Esc 的调用方(不传 `opts`)行为不变。
- `mirror`: **拒绝往 modal 状态的 CLI picker 里注入**。权限确认框 / `/model` 选择器 / plan review 这类 modal 会把粘贴进去的文本吃掉,并把随后的 Enter 读成「确认当前高亮项」—— 一条 WeCom 消息就此丢失,同时替用户点掉了一个他没看到的确认框。最典型的触发场景:编辑 `.claude/**` 下任何文件都会让 Claude Code 立起它自己的「allow Claude to edit its own settings」确认,而那个框**不过 PreToolUse hook**,daemon 完全不知情,pane 就一直阻塞在那里。现在注入前先 `capture-pane -p` 看一屏,判定为 modal 就带标题原因返回失败(消息不丢,用户可去 tmux 处理或 `/stop` 后重发)。判定放在**按后端分流之前** —— 每个 CLI 后端都有自己的原生确认框,放到分流之后只保护得住 claude 一家;图片注入路径同样先过这道判定。判据刻意保守:必须同时出现「编号选项行」与「`Esc to cancel` footer」两个信号才算 modal(误判会挡住正常消息,比漏判一个冷门布局更糟);capture 只取当前屏、不进 scrollback(用户答完的旧确认会永远留在 scrollback 里,带上它会把镜像永久堵死)。逃生开关 `WEZARD_MODAL_GUARD=0`。
- `ws`: **重连上限改为无限**(`MAX_RECONNECT = -1`,走 SDK 原生无限重连 + 30s 封顶的指数退避)。有限次数是个陷阱:睡眠唤醒 / 切网时 DNS 短暂 `ENOTFOUND`,10 次重连累计只撑约 2 分钟就耗尽,此后 SDK 抛 `WSReconnectExhaustedError` 彻底躺平 —— 进程活着、`/healthz` 的 `ok` 仍为 true、HTTP 端口也通,但对 WeCom 完全失聪:发不出卡、收不到按钮点击,且不会自行恢复(DNS 早已好了也没用)。两个 fail-fast 边界不受影响:认证失败走独立的 `MAX_AUTH_FAIL` 计数器;被服务端踢下线(别处建了新连接)时 SDK 置 `isManualClose` 后本就不重连,不会两个 daemon 互抢。
- `mirror`: **`/clear` 轮换的会话认领必须可归属到本 pane**,否则拒绝认领。轮换后的 transcript 只有「首条 user 行是 `/clear`」这一个特征,每个 chat 的 `/clear` 都长这样;同一 project dir 下两个 chat 先后 `/clear` 时,先起的 watcher 会把后者刚轮换出来的会话抢走 —— 两个 chat 就此永久串线(还会写盘固化):A 的消息注进自己的 pane,产出却镜像到 B 的会话里。现在目录扫描只在「候选唯一 且 窗口内本目录没有别的 chat 也在 `/clear`」时才认领,否则退让给下一条注入的文本指纹(`armSilentForkRebind`,pane 级确定)来定位。`/clear` 的登记发生在 inject **之前**,以便更早武装的兄弟 watcher 能看见重叠。
- `mirror`: `injectText` 成功后清除 `muteUntilInject` / `justSpawned`。graph 拉起的节点由 `newSession` 置静音、再由 `injectText` 注入,而清除静音只写在 WeCom dispatch 路径上 —— 结果 `onItem` 永远在静音分支早退,节点既不推气泡也不 `recordTurnStart`,在 chat 列表和 chat 详情里完全不存在。

## [1.2.15] - 2026-08-07

### Fixed
- `session-label`: `withTagHeader` 对无 tag 默认会话不加前缀 —— approval vote 回执、plan 卡、error 等经 `withTagHeader` 发送的消息无 🧙 标识。现统一为所有 target 都带前缀(tagged → `emoji #tag`，untagged → `🧙`)。

## [1.2.14] - 2026-08-07

### Changed
- `mirror`: 所有 emoji+tag 前缀和 detail link 文本去掉反引号包裹 —— WeCom markdown 里 backtick 渲染为代码样式,与可点击链接视觉冲突。
- `mirror`: 默认会话（无 tag）所有推送现统一带 🧙 前缀,不再裸发。
- `mirror`: KeepAlive 通知也带 chat detail 链接(使用 `keepaliveTurnId`)。

### Fixed
- `peers`: `keepaliveStamps` 对 ping 后紧跟的 assistant pong 未识别为 keepalive 回复,导致 pong 误算为 real activity 重置 round。

## [1.2.13] - 2026-08-07

### Added
- `mirror`: 所有 standalone 消息和 finalized bubble 的 emoji+tag 前缀现在是可点击的 chat detail 链接(有活跃 turn 时);无 tag 的默认会话使用 🧙 作为链接图标。

### Fixed
- `inbound`: `/stop` 成功时不再回复消息,仅失败时通知。
- `mirror`: KeepAlive 通知只在第 1、3、6 轮发送(不再每轮都推)。
- `mirror`: KeepAlive 轮次计数修复 —— ping/pong 结算后的 mtime 抖动不再误触 `grewSinceLast` 重置 round(添加 30s `settledAt` 宽限窗口)。
- `mirror`: chat detail 链接格式统一:emoji+tag 包在反引号内作为链接文本,🧙 作为无 tag 会话的默认图标,"← View chat details" 变为普通文本提示。

### Fixed
- `mirror`: inline peer spawn(`#tag` 首条消息自动建会话)和 graph runner spawn 不再下发 "📂 当前项目" 提示消息到 WeCom — `newSession` 新增 `silent` 选项,隐式路径传 `silent: true` 跳过 `pushProjectInfo`;显式 `/new` 仍正常推送。

## [1.2.11] - 2026-08-06

### Added
- `mirror`: `muteUntilInject` — 新 spawn 的 session 在首次 inject 成功前静默初始输出(greeting/system),避免 `#tag` 自动建会话时把 CLI 开场白推到 WeCom。
- `mirror`: `earlyTimer` (3s) — inject 后若 CLI 在 3s 内无任何产出,先把 loading 气泡收成 chat detail 链接;首条 item 到达即清除,不影响正常流。

### Fixed
- `mirror`: `muteUntilInject` 在 inject 失败路径未清除(return 在赋值前),导致会话永久静默。
- `mirror`: `earlyTimer` 对排队中的 turn 错引 `a.briefBubble`(仍指向前一个活跃 bubble),改为闭包捕获的 bubble ref。

## [1.2.10] - 2026-08-06

### Changed
- `mirror`: 保活默认轮次 8 → 6(桥接窗口 ~34min → ~26min)。
- `mirror`: 保活连击瘦身 —— 一轮连击里只有第一发 ping 带完整指令文案,后续轮次只注入 bare `ping`(指令已在上下文里,cache-write delta 更小、pane 更干净)。`keepaliveStamps` 同步识别 bare `ping`,否则连击轮会被误判为真实活动、重置轮次并自我续命。

### Fixed
- `mirror`: TUI 里手打 `/clear` 后保活仍继续 —— `migrateAttachment`(所有会话轮换的唯一漏斗)此前不碰保活态,旧时钟接着 ping 空上下文;且其 `store.set` 整记录替换会把 dispatch 刚落盘的 `/clear` 暂停从盘上抹掉(reload 后复活)。现迁移目标判定为真清空时像 `/stop` 一样置 `keepaliveOff` 并清时钟,暂停态随迁移记录一并落盘。

## [1.2.9] - 2026-08-05

### Fixed
- `mirror`: `/clear` 与 `/new` 现和 `/stop` 一样暂停保活。二者都把会话重置为空壳 —— 缓存里没有任何真实上下文可保温,继续 ping 只是白烧预算(此前 `/new` 建会话不暂停、`/clear` 在 dispatch 里反而**解除**了暂停)。`/new` 在 `newSession` attach 后落停,`/clear` 在 dispatch 里改为暂停而非解除;停顿持久化,下一个真实 turn(WeCom inbound,或 pane 过 grace 后转 busy)自动恢复。

## [1.2.8] - 2026-08-05

### Fixed
- `inbound`: `#tag` 后夹一个不可见格式字符(输入法/复制常带的 `U+2060` word-joiner、零宽空格等)时,tag 右边界断言 `(?=\s|$)` 落空 —— 整个 `TAG_RE` 不匹配,`parseTag` 返回空 tag,消息被误路由到**默认会话**而非目标 `#tag` 会话。右边界字符类补入零宽(`U+200B–200D`)、word joiner(`U+2060`)、BOM(`U+FEFF`),与空白同等视作合法分隔。

## [1.2.7] - 2026-08-01

### Fixed
- `mirror`: KeepAlive 轮次计数卡在 `1/N` —— 1.2.6 把调度改用消息时钟后,`grewSinceLast`(轮次重置 + 真实活动重锚的判据)错用了 `lastMs`(**含保活自己的 ping/pong**)。心跳的 ping+pong 也是消息 turn,会推高 `lastMs`,在交互式会话里 pong 隔几秒才生成、时序有缝,导致下一个非 pinging tick 把自己的心跳误判为「新活动」而把 `round` 归零,`n` 永远爬不过 1。改为只看 `lastRealMs`(已滤除 ping/pong):纯保活期间轮次正常累加 `1/N→2/N→…`,只有真实对话才重置。

## [1.2.6] - 2026-07-31

### Fixed
- `mirror`: **保活调度彻底改用消息 turn 时间戳,不再依赖文件 mtime**。Claude Code 每轮会往 jsonl 追加 `file-history-snapshot` / `ai-title` / `mode` / `permission-mode` 等**无 `timestamp` 的非消息行**,它们顶高文件 mtime 却不代表任何真实对话。旧逻辑 `idleSinceTouch` / `realIdle` / `grewSinceLast` 全建立在 `statSync(mtime)` 上,于是这些元数据写入被误判为「活跃」:`grewSinceLast` 每周期重锚 `realMtime` 使 `realIdle` 永不过 `maxIdleSec` —— **真实对话在数小时前的死会话被无限保活**(daemon 每次启动/reload 还会把「末行是 ping」的死会话集体复活)。现新增 `keepaliveStamps` 从消息 turn 取 `lastMs`(最后一条消息=缓存触碰)/`lastRealMs`(最后一条非 ping/非 pong=真实空闲基准),文件 mtime 仅作「要不要重读 tail」的廉价闸门;tail 内无真实 turn ⇒ 判死。移除 `realMtime` 字段;`n/N` 分母按实际 cadence(`ttlSec-marginSec`)floor 计。
- `mirror`: `/stop` 暂停保活现**持久化**(`keepaliveOff` / `keepaliveOffAt` 写入 `mirror-attachments.json`),daemon reload / launchd 重启不再复活一个被用户显式静音的会话;真实 inbound 或 busy-resume 解除时同步落盘。

## [1.2.5] - 2026-07-31

### Added
- `mcp`: 新增 `config_set` tool — 在对话中直接读写 wezard 配置（allowFrom、审批时间窗口、danger skip、cwd、log level 等），无需手动编辑 config.jsonc。

## [1.2.4] - 2026-07-31

### Changed
- `mirror`: KeepAlive 心跳通知带回轮次计数 —— 从 `KeepAlive · ~Nk tokens` 恢复为 `KeepAlive n/N · ~Nk tokens`。`n` = 上次真实（非 ping）活动以来的 ping 轮数（真实活动重新锚定时归零），`N` = 当前配置下缓存冷掉前的最大保活轮数。1.2.1 随 `maxPings`→`maxIdleSec` 一并去掉的 `n/max`，现按需求改以派生分母回归。

## [1.2.3] - 2026-07-31

### Fixed
- `mirror`: `/stop` 暂停保活的第二个自我唤醒漏洞 —— 1.2.0 给 busy-resume 加了 grace，但 `grewSinceLast`（transcript 增长）分支没有守卫。`/stop` 的 Esc 打断会产生尾部写入（被中断的 turn + 残留 tool result），下一个 tick 把它当成真实活动立刻解除刚请求的暂停，KeepAlive 照常触发。现在纯 transcript 增长不再解除 `/stop` 暂停，只有 busy pane（过 grace）或 WeCom inbound 能恢复。

## [1.2.2] - 2026-07-31

### Fixed
- `mirror`: tagged-only chat（无 untagged 默认会话）中 `enter` 设置 cwd 后 `/clear` 不触发目录切换 — `chatCwdFallback` 只读 base principal，base 不存在时返回空；dispatch 和 newSession 现在都 fallback 到 caller 自身的 `pendingCwd`。

## [1.2.1] - 2026-07-31

### Changed
- `mirror`: 保活调度改为**锚定最后一次真实（非 ping）对话** — 保活自己的 ping 不再刷新空闲锚点，因此不会把一个搁置很久的会话误判成活跃而无限续命。真实空闲超过 `maxIdleSec`（新配置，默认 = `ttlSec` 5min）即停手，让缓存自然冷掉；reload 时若 transcript 末轮是自己的 ping，则视作早已空闲、不重新烧热。配置项 `maxPings` 移除，替换为 `maxIdleSec`（保活功能在 1.2.0 刚发布，此为随即修正）。聊天心跳去掉 `n/max` 计数，只显示 `❤️ 保活 · context ~Nk tokens`。

## [1.2.0] - 2026-07-31

### Added
- `mcp`: 事件订阅/广播全面 MCP 化 — 新增 `subscribe_topic` / `unsubscribe_topic` / `broadcast_topic` / `schedule_broadcast` / `cancel_broadcast` / `list_topics`,直接对 AI 说人话即可订阅/广播/定时。
- `mcp`: 新增 `handoff` tool — 原地把一个 pane 的会话交接给全新会话。
- `mirror`: prompt-cache 保活心跳 — 空闲 pane 在缓存过期前廉价续命；心跳记入 chat detail，留痕含真实 cache-read usage。
- `approval`: 新增 `danger.skip` — 命中危险名单也免卡直接放行。

### Changed
- `mirror`: `/stop` 暂停保活 + 明确终止语义。

### Removed
- **BREAKING** `topics`: 移除订阅/广播的 IM 文本命令(「订阅」「广播」「每天…广播」「取消广播」「订阅列表」「广播列表」)及 `/skill-b`,全部改由 MCP 工具驱动。`POST /publish` 外部触发接口保留。

### Fixed
- `mirror`: `/stop` 暂停保活失效 — 保活自身的 ping 会让 pane 变 busy，而 busy 被当成「真实活动」立刻解除暂停；改为对 busy-resume 加 30s grace 窗口，只有暂停后真正的新一轮才恢复（WeCom dispatch 仍即时恢复）。
- `sync`: 为 CodeBuddy targets 把 MCP entry 写入 `mcp.json`。
- 发布包补齐 svr plist/service 模板。

## [1.1.4] - 2026-07-31

### Fixed
- `approval`: reload 续接 — 重启时挂着的审批不再 fallback 成本地权限框。

## [1.1.3] - 2026-07-31

### Added
- `approval`: 新增 `danger` 模式 — 只对危险名单发卡,其余静默放行。

### Changed
- `mcp`: 重命名 `cd` 工具为 `enter` — 更贴合实际语义。

## [1.1.2] - 2026-07-30

### Added
- `approval`: codebuddy 下 `AskUserQuestion` / `ExitPlanMode` 由 mirror 接管下发卡片。
- `detail`: detail/chat url 参数加 `ww_uniq=1`。

## [1.1.1] - 2026-07-30

### Changed
- `approval`: 危险名单移除普通 `git push` — 仅保留强推等不可逆操作。

## [1.1.0] - 2026-07-30

### Added
- `chat`: 上下文断点可见化 — `/clear`、`/new`、会话轮换在线程里显式分隔。

## [1.0.0] - 2026-07-29

首个稳定版:项目更名 `weclaude` → `wezard`。

### Changed
- **BREAKING**: 项目更名 `weclaude` → `wezard`,新增 `wezard migrate` 迁移命令。
- `init`: 本地拉起 svr,详情/会话链接默认走内网 IP。

### Added
- `approval`: 危险操作名单 — 命中者强制逐次单独审批。
- `session-scan`: 通过 `ps` + `lsof` fallback 支持 macOS。

### Fixed
- `chat`: 修复移动端滚动 — `.main` 加 `min-height:0`,叠加 overscroll + safe-area。

[Unreleased]: https://github.com/guxi11/wezard/compare/v3.0.1...HEAD
[3.0.1]: https://github.com/guxi11/wezard/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/guxi11/wezard/compare/v2.9.0...v3.0.0
[2.9.0]: https://github.com/guxi11/wezard/compare/v2.8.8...v2.9.0
[2.8.8]: https://github.com/guxi11/wezard/compare/v2.8.7...v2.8.8
[2.8.7]: https://github.com/guxi11/wezard/compare/v2.8.6...v2.8.7
[2.8.6]: https://github.com/guxi11/wezard/compare/v2.8.5...v2.8.6
[2.8.5]: https://github.com/guxi11/wezard/compare/v2.8.4...v2.8.5
[2.8.4]: https://github.com/guxi11/wezard/compare/v2.8.3...v2.8.4
[2.8.3]: https://github.com/guxi11/wezard/compare/v2.8.2...v2.8.3
[2.8.2]: https://github.com/guxi11/wezard/compare/v2.8.1...v2.8.2
[2.8.1]: https://github.com/guxi11/wezard/compare/v2.8.0...v2.8.1
[2.8.0]: https://github.com/guxi11/wezard/compare/v2.7.7...v2.8.0
[2.7.7]: https://github.com/guxi11/wezard/compare/v2.7.6...v2.7.7
[2.7.6]: https://github.com/guxi11/wezard/compare/v2.7.5...v2.7.6
[2.7.5]: https://github.com/guxi11/wezard/compare/v2.7.4...v2.7.5
[2.7.4]: https://github.com/guxi11/wezard/compare/v2.7.3...v2.7.4
[2.7.3]: https://github.com/guxi11/wezard/compare/v2.7.2...v2.7.3
[2.7.2]: https://github.com/guxi11/wezard/compare/v2.7.1...v2.7.2
[2.7.1]: https://github.com/guxi11/wezard/compare/v2.7.0...v2.7.1
[2.7.0]: https://github.com/guxi11/wezard/compare/v2.6.4...v2.7.0
[2.6.4]: https://github.com/guxi11/wezard/compare/v2.6.3...v2.6.4
[2.6.3]: https://github.com/guxi11/wezard/compare/v2.6.2...v2.6.3
[2.6.2]: https://github.com/guxi11/wezard/compare/v2.6.1...v2.6.2
[2.6.1]: https://github.com/guxi11/wezard/compare/v2.6.0...v2.6.1
[2.6.0]: https://github.com/guxi11/wezard/compare/v2.5.1...v2.6.0
[2.5.1]: https://github.com/guxi11/wezard/compare/v2.5.0...v2.5.1
[2.5.0]: https://github.com/guxi11/wezard/compare/v2.4.1...v2.5.0
[2.4.1]: https://github.com/guxi11/wezard/compare/v2.4.0...v2.4.1
[2.4.0]: https://github.com/guxi11/wezard/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/guxi11/wezard/compare/v2.2.2...v2.3.0
[2.2.2]: https://github.com/guxi11/wezard/compare/v2.2.1...v2.2.2
[2.2.1]: https://github.com/guxi11/wezard/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/guxi11/wezard/compare/v2.1.4...v2.2.0
[2.1.4]: https://github.com/guxi11/wezard/compare/v2.1.3...v2.1.4
[2.1.3]: https://github.com/guxi11/wezard/compare/v2.1.2...v2.1.3
[2.1.2]: https://github.com/guxi11/wezard/compare/v2.1.1...v2.1.2
[2.1.1]: https://github.com/guxi11/wezard/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/guxi11/wezard/compare/v2.0.6...v2.1.0
[2.0.6]: https://github.com/guxi11/wezard/compare/v2.0.5...v2.0.6
[2.0.5]: https://github.com/guxi11/wezard/compare/v2.0.4...v2.0.5
[2.0.4]: https://github.com/guxi11/wezard/compare/v2.0.3...v2.0.4
[2.0.3]: https://github.com/guxi11/wezard/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/guxi11/wezard/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/guxi11/wezard/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/guxi11/wezard/compare/v1.4.2...v2.0.0
[1.4.2]: https://github.com/guxi11/wezard/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/guxi11/wezard/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/guxi11/wezard/compare/v1.3.23...v1.4.0
[1.3.23]: https://github.com/guxi11/wezard/compare/v1.3.22...v1.3.23
[1.3.22]: https://github.com/guxi11/wezard/compare/v1.3.21...v1.3.22
[1.3.21]: https://github.com/guxi11/wezard/compare/v1.3.20...v1.3.21
[1.3.20]: https://github.com/guxi11/wezard/compare/v1.3.19...v1.3.20
[1.3.19]: https://github.com/guxi11/wezard/compare/v1.3.18...v1.3.19
[1.3.18]: https://github.com/guxi11/wezard/compare/v1.3.17...v1.3.18
[1.3.17]: https://github.com/guxi11/wezard/compare/v1.3.16...v1.3.17
[1.3.16]: https://github.com/guxi11/wezard/compare/v1.3.15...v1.3.16
[1.3.15]: https://github.com/guxi11/wezard/compare/v1.3.14...v1.3.15
[1.3.14]: https://github.com/guxi11/wezard/compare/v1.3.13...v1.3.14
[1.3.13]: https://github.com/guxi11/wezard/compare/v1.3.12...v1.3.13
[1.3.12]: https://github.com/guxi11/wezard/compare/v1.3.11...v1.3.12
[1.3.11]: https://github.com/guxi11/wezard/compare/v1.3.10...v1.3.11
[1.3.10]: https://github.com/guxi11/wezard/compare/v1.3.9...v1.3.10
[1.3.9]: https://github.com/guxi11/wezard/compare/v1.3.8...v1.3.9
[1.3.8]: https://github.com/guxi11/wezard/compare/v1.3.7...v1.3.8
[1.3.7]: https://github.com/guxi11/wezard/compare/v1.3.6...v1.3.7
[1.3.6]: https://github.com/guxi11/wezard/compare/v1.3.5...v1.3.6
[1.3.5]: https://github.com/guxi11/wezard/compare/v1.3.4...v1.3.5
[1.3.3]: https://github.com/guxi11/wezard/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/guxi11/wezard/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/guxi11/wezard/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/guxi11/wezard/compare/v1.2.31...v1.3.0
[1.2.31]: https://github.com/guxi11/wezard/compare/v1.2.30...v1.2.31
[1.2.30]: https://github.com/guxi11/wezard/compare/v1.2.29...v1.2.30
[1.2.29]: https://github.com/guxi11/wezard/compare/v1.2.28...v1.2.29
[1.2.21]: https://github.com/guxi11/wezard/compare/v1.2.20...v1.2.21
[1.2.20]: https://github.com/guxi11/wezard/compare/v1.2.19...v1.2.20
[1.2.19]: https://github.com/guxi11/wezard/compare/v1.2.18...v1.2.19
[1.2.18]: https://github.com/guxi11/wezard/compare/v1.2.17...v1.2.18
[1.2.17]: https://github.com/guxi11/wezard/compare/v1.2.16...v1.2.17
[1.2.16]: https://github.com/guxi11/wezard/compare/v1.2.15...v1.2.16
[1.2.15]: https://github.com/guxi11/wezard/compare/v1.2.14...v1.2.15
[1.2.14]: https://github.com/guxi11/wezard/compare/v1.2.13...v1.2.14
[1.2.13]: https://github.com/guxi11/wezard/compare/v1.2.12...v1.2.13
[1.2.12]: https://github.com/guxi11/wezard/compare/v1.2.11...v1.2.12
[1.2.11]: https://github.com/guxi11/wezard/compare/v1.2.10...v1.2.11
[1.2.10]: https://github.com/guxi11/wezard/compare/v1.2.9...v1.2.10
[1.2.9]: https://github.com/guxi11/wezard/compare/v1.2.8...v1.2.9
[1.2.8]: https://github.com/guxi11/wezard/compare/v1.2.7...v1.2.8
[1.2.7]: https://github.com/guxi11/wezard/compare/v1.2.6...v1.2.7
[1.2.6]: https://github.com/guxi11/wezard/compare/v1.2.5...v1.2.6
[1.2.5]: https://github.com/guxi11/wezard/compare/v1.2.4...v1.2.5
[1.2.4]: https://github.com/guxi11/wezard/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/guxi11/wezard/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/guxi11/wezard/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/guxi11/wezard/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/guxi11/wezard/compare/v1.1.4...v1.2.0
[1.1.4]: https://github.com/guxi11/wezard/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/guxi11/wezard/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/guxi11/wezard/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/guxi11/wezard/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/guxi11/wezard/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/guxi11/wezard/releases/tag/v1.0.0
