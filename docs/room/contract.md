# room 模型 · 契约定稿 (检查点 1)

分支 `room-model` @ worktree `../cc-wecom-room` (基于 origin/v3 cf3e0b3)。未写实现代码。
已按裁决定: 终句零语义 (F-1, 无兜底投递) · 一次切换无影子/flag · host 动态求值 · 其余取设计稿推荐 (A-1b / B-3 订阅默认关 M=20 / C-1 全量镜像 / D-1 DM 自动落 / W-1 默认可切全量)。

## 1. room id

| room | id | 例 |
|---|---|---|
| 绑定传输 (企微群 / 企微单聊 / topic 帖 / 微信) | **= 现有 base principal 原样** (含 `~bot` 后缀) | `chat:wrkSF…` · `user:T0388…` · `chat:wrkSF…~b2` |
| wizard 两人 (无绑定) | `dm:` + 两个实例的**稳定身份 uid** 字典序 `|` 拼接 —— 同一对唯一、复用 | `dm:w3f9a0c12e4b7|w8d21be07aa95` |
| 3 人以上临时 (无绑定) | `adhoc:` + 8 位随机 hex, room_open 显式开, 或 chat_ask 点名多个群外 wizard 时按成员集合复用 / 新开 | `adhoc:9f3c01ab` |

- 绑定 room 沿用 base principal: 与 chatPolicy / chat-name / members.json / chat-records 同一键空间, 迁移零换键; 聊天名照样能当 room 参数。
- **room id 与显示名彻底解耦 (硬约束)**: 现有 target / identity 键都带名字 tag (`chat:wr…#LeoAdams`), 不能进 room id。新增实例字段 `uid` (wizards.json, 不含名字, 一旦写入永不改):
  - 新建实例: 生成时随机 `w` + 12 hex。
  - 存量实例: `uidOf(rec) = rec.uid ?? "w" + sha1(rec.target + "|" + rec.bornAt).slice(0, 12)`, 纯函数, 迁移脚本与 daemon 算出同一个值; daemon boot 时回填落盘, 之后只读字段。
  - 改名 / 交接 / /new / 换 slot 都不动 uid。
- 账本里一切 wizard 引用 (Who.id、dm room id、closes 里的 holder、wake) 都用 uid; target / 名字只在投递 pane 和渲染那一刻由 registry 现查。
- kind 由 id 前缀 + 传输推出: `wecom-group | wecom-dm | topic-post | wx | dm | adhoc`。
- 落盘: `~/.wezard/state/rooms/<encodeURIComponent(id)>.jsonl` (目录 = roomsDirOf(daemon.stateDir), 配置可改; 迁移 / observe / daemon 同一处推导), 一 room 一文件; `rooms/registry.json` 只是缓存, 可由各文件重建。
- **消息 id** = `<roomHash8>.<seq>` (如 `a1b2c3d4.41`): 全机唯一, 自带 room (re 一个 id 就知道 room, chat_reply 不必给 room)。

## 2. 账本行 schema (rooms/<id>.jsonl, append-only, fsync)

全部行 `{ op, at, room }` 打头。room 状态 = 按文件 fold, 不读别处。

```ts
type Who = { kind: "human"; id: string /*userid*/ }
         | { kind: "wizard"; id: string /*实例 uid, 不含名字*/ }
         | { kind: "daemon"; id: string /*"wezard" | "task:<id>"*/ };

// 成员
{ op: "join";  who: Who; ord: number;   // 加入序: room 内单调, 退出再进拿新号 (排到队尾)
  via: "founder"|"invite"|"approve"|"mention"|"spawn"|"transfer"|"inbound"|"migrate"; by: Who }
{ op: "leave"; who: Who; by: Who; why?: string }
{ op: "seen";  who: Who; seq: number }  // 游标, 只进不退; 恢复/交接/reload 只靠它

// 消息 (人和 wizard 同一种行)
{ op: "msg";
  id: string; seq: number;              // seq room 内单调
  author: Who;                          // 作者 (显式, append 时定死)
  ord: number;                          // 作者此刻的加入序 (人 / daemon = 0)
  speak: "member"|"human"|"daemon"|"join-req";  // 发言权判定结果: 放行依据。被拒不成行, 只进 daemon.log
  kind: "say"|"ask"|"task"|"reply"|"file"|"join-req"|"system"|"trigger";  // trigger = 定时任务唤醒 (daemon 写)
  text: string;
  to?: Who[];                           // 点名
  re?: string[];                        // reply 指向的消息 id (可多条)
  status?: "done"|"need"|"progress"|"passed"|"canceled"|"error";  // 仅 reply; error 只有 daemon 能写
  closes?: string[];                    // 本行实际关掉的 duty (msgId@holder), append 时算定 —— 完成的唯一事实
  wake: string[];                       // 本行实际唤醒的 wizard uid (预算降级的不在内)
  interrupt?: boolean;                  // 带 interrupt 投递 (先 Esc 打断再投; 限权见 §3b)
  for?: string; after?: string[]; planId?: string;
  files?: { path: string; kind: "image"|"file"|"voice"|"video"; name: string }[];
  origin: "inbound"|"tool"|"daemon"|"migrate";
  ext?: string;                         // 企微 msgid (入站去重 / 占位气泡挂点)
  bubble?: { stream: string; expires: number };    // 只挂在人话行: 第一条 re 它的 reply 覆盖占位气泡
  sys?: string }                        // daemon 系统行的机器语义 (undelivered / left / quota …), 用于去重, 不给模型推断

// duty 移交
{ op: "move";  duty: string /*msgId*/; from: Who; to: Who; by: Who }

// 元数据 (不是消息, 不推进 seq): 显示名 / 群公告, 最后一条生效
{ op: "name";   title: string; by: Who }     // 空串忽略; 只是别名, 不参与寻址
{ op: "notice"; text: string;  by: Who }     // 群公告, 每 room 一条; 空 (或纯空白) = 清除; 状态是 fold 出来的, 不另存文件
```

**群公告**: 让 room 里所有 wizard 一直知道一句话 (本周重点 / 某条规矩)。`text` 空白折成单空格, 上限 `NOTICE_MAX` = 500 字。改的权限同起名 —— wizard 只有当前 host (`room_name({room, notice})`, 非 host 403); 人不受此限, 在企微里 `/notice <文字>` 设 / `/notice` 看 / `/notice clear` 清 (inbound 的 allowFrom 门授权, 改的是本群 room)。与现有相同 = 无变化, 不落行。一次有效改动: ① 写 `notice` 行; ② 追加一条 daemon `system` 行 (`sys:"notice"`, 「📌 群公告: …」/「📌 群公告已清除」, 不唤醒任何人; 绑定 room 照 §3a 镜像进企微); ③ 在跑的 wizard 成员 (除改的人自己) 经 `notices` 在下一次注入时随 system-reminder 带一行, 不额外唤醒。读侧: 新 wizard 的 charter 里 home 群 room 的公告占一节「本群公告」(没有就不出现); `RoomFact.notice` (`/api/room` 的 `room`、`/api/world` 的 room 节点) 与 `room_read` 单 room 输出头部 (`📌 群公告: …`) 都带它。

**duty 不落第二份数据**, fold 时派生:
- 开: ask / task 行对每个 `to` 各开一条; 绑定 room 里**没点名的人话**开一条给 host; 人话 `.name` 点名开给被点名者; join-req 开给 **host (读时求值)**。
- 关: holder 写 `reply` 且 status ∈ {done, passed, canceled}, 写进该行 `closes`。need / progress / error 不关。
- **status 写入权** (append 时判, 不过即 403, 绝不静默降级成不带 status 的行):
  - done / passed / canceled / need / progress: 只有该 duty 的处理人 (holder, 含 move 之后的新 holder) 能写; re 是数组时**逐条**判, 任一条不是自己的整行 403 并列出哪几条。
  - 人可对任何 duty 写任何非 error 的 status (超集)。host 没有这项特权。
  - error: 只有 daemon 能写 (CLI 报错)。
  - 不带 status 时: 调用方是 holder → 缺省 `text ? "done" : "passed"`; 不是 holder → 普通线程回复 (行里无 status, closes 为空)。这是唯一允许无 status 的 reply, 且由「没给 status」显式触发, 不是降级。
- 覆盖检查: 关 duty X 时, 若提问者在 X 线程里有 seq > holder 游标的补充 → 409「先读 seq N」。
- after: 前置 duty 全部 done 之前不唤醒 holder。

**人也有 duty** (`Duty.kind` 多一个 `"need"`; 人名下的 duty 槽位是 `human:<userid>`, 读侧 `dutiesHeldBy` / `dutyFacts` 与 wizard 同口径):
- 开: (a) wizard 对 asker 是人的 duty 写 `reply status:"need"` —— judge 把这些人补进该行的 `to`, fold 据此在每个人名下开一条 `need` (asker = 这个 wizard, msg = 这条 reply 的 id); (b) `chat_ask` 的 `to` 可点名本 room 的人成员 (`human:<userid>`), 人名下开 ask / task (`to` 里至少一个 wizard 或人)。
- 关: 人在本 room 的**下一句话**关掉它名下未关的 duty, 状态记 done (写进该行 `closes`)。这句带 `re` (企微引用, daemon 把引用正文对回账本里最近一条互相包含的行: `quotedRowIds`) 且命中其中几条 → 只关那几条; 没引用 / 引用没命中它名下的账 → 全关。人写 `chat_reply` 照旧 (超集)。**提问的 wizard** 对自己开出的人名下 duty 可显式写 `canceled` / `passed` (不再需要了; done 仍只有人), 且不受「提问者补充先读」覆盖检查。
- 唤醒: 人话关了谁的账, 谁 (提问者, 仍在 room 的 wizard) 由 judge 补进这行的 `to` —— 与点名同义: 唤醒它、给它开 `human` duty、且这句不再当「没点名的人话」落给 host (所以非 host 的提问者被叫醒, host 不被连带吵醒)。
- 人叫不醒、也不被 pane 投递 (唤醒泵、Stop hook / 欠账提醒、`reportGone` 都只认 wizard holder)。
- 逾期 (§overdue): 人名下的 duty 不发 remind; 到 `groupMin` 在该 room 写一行 `sys:"overdue-group@<userid>"` 的 system 行「⏰ <人> 有一条 .<wizard> 的提问 (<id>) N 分钟没回」(绑定 room 镜像进企微, 非绑定 room 另发提问者 home 群); 提问的 wizard 已不在 room 里就不催。反过来 wizard 名下那条若它最后一条非终态是 `need`、且那句 need 在人名下开的账还开着, 不对该 wizard 计逾期 (球在人那边)。

## 3. 五个工具 (+ 管理面)

room 缺省 = 唤醒本轮的那条消息所在 room; 本轮由多个 room 一起唤醒 → 400 要求显式给。回包一律回显 `room` 与新行 `id`。

```ts
chat_say ({ room?, text, to?: string[] })                 // 发言; to 只唤醒不开 duty
chat_ask ({ room?, to: string|string[], text, kind?: "ask"|"task" /*缺省 ask*/,
            after?: string[], for?: string, planId?: string })    // 每个 to 开一条 duty
chat_reply({ re: string|string[], text?, status?: "done"|"need"|"progress"|"passed"|"canceled" })
            // 唯一完成信号; room 由 re 定; 写入权见 §2: 只有 holder (和人), 别人给 status → 403
notify   ({ room?: string|string[], markdown })           // 发进一个或多个 room, 不唤醒任何 wizard
send_file({ room?, path, kind?, caption?, title?, description?, re?: string })  // 文件行; re 只挂线程, 不关 duty
```

缺省 room 的落点规则 (chat_ask / chat_say 带 to):
- to 全是触发 room 的成员 → 触发 room;
- 单个 to 不在 → 自动落 `dm:<我>|<它>` (D-1);
- 多个 to 有非成员 → 400, 让先 room_open。

管理面:
- `room_open({ with: string[], title? })`: 开 adhoc, 调用方 ord=1 即 host。
- `room_invite({ room, who })`: host / 人 / 拉自己直属子 wizard 立即入; 其余成员邀请转成 join-req。
- `room_join({ room, reason })`: 写 join-req, 唤醒 host。
- `room_approve({ re, accept })`: 仅 host / 人。
- `room_leave({ room, who? })`: 缺省自己; host / 人可移出别人。
- `room_members({ room? })` (取代 chat_members)。
- `room_transfer({ re, to })`: 写 move; to 非成员按 invite 规则。
- `room_read({ room?, from?, since?, until?, limit?, all? })` (取代 read_chat; 默认 W-1)。
- `room_watch({ room, on })`: B-3 订阅, 默认关。

spawn / clone / delegate 增 `room?` (子 wizard 以 via:"spawn" 免审入群); delegate 的产出改为 chat_ask。

**删除**: tell_peer、wait_peer 的回执语义、read_chat、chat_members、`return` / `public` / `fyi` 参数位。
- taskFile + params 只留在 delegate。
- priority 取消: 唤醒一律等对方本轮结束; 答 need 的 reply 照旧插话。

## 3a. 镜像规则 (绑定 room → 企微, 一条规则)

**一行 op:"msg" 镜像进企微 ⇔ room 绑定了传输 ∧ origin ∉ {inbound, migrate} ∧ kind ≠ trigger。**
- 也就是说 wizard 的 say / ask / task / reply / file / join-req、daemon 的 system 行 (未交代升级、离开 canceled、额度 / 预算拒绝说明) **全部**进群, 没有受众开关、没有按作者或轮次的例外。
- inbound 不回镜 (它本来就来自企微); migrate 是历史; trigger 是定时任务唤醒, 不是对人说的话。
- 非 msg 的 op (join / leave / seen / move / name / notice) 不镜像 (公告变动由上面那条 daemon system 行镜像)。无绑定的 dm / adhoc room 一律不镜像, 只在 rolepage 可见。
- 形态: 气泡头署作者名; 人话行带 bubble 时, **第一条 re 它的 reply** 覆盖占位气泡, 之后的作为新消息。file 行走媒体消息。
- 镜像失败只改 Xport 状态, 不回滚、不影响完成。

## 3b. 打断一个正忙的 wizard (人已拍 I-1)

删掉 tell_peer.priority 以后, 「打断」只剩 stop_wizard。前提事实: room 模型里 pane 投递队列**不是事实来源**, 每次唤醒都按 `seen` 游标从账本重算, 所以就算 teardown 清掉了内存里的队列, 未投递的消息也会在下次唤醒时补上, 不会丢。

| 方案 | 做法 | 代价 |
|---|---|---|
| **I-1 chat_ask / chat_say 加 `interrupt: true`** | 等价原 urgent: 先 Esc 打断对方当前这一轮, 再投本条, 不拆 pane | 能被打断的是对方**正在替别人干**的那一轮: 被打断的 duty 不关, 下次唤醒重投, 但已经花的这一轮白付。所以要限权: 只有调用方是对方的直属 parent、room 的 host, 或者是人才能用, 并计入回合预算 (M=20); 否则 403。实现面: 复用现有 Esc 路径, 多一个参数和一条权限判定 |
| I-2 打断统一走 stop_wizard | 不加参数。stop_wizard({mode:"interrupt"}) 照旧 Esc; 排队的行按上面的前提由游标重建 | 工具面最小。代价: 打断和投递分成两次调用 (先 stop 再 chat_ask), 中间对方可能已经闲下来又被别的唤醒抢先; stop_wizard 的权限 (自己或直属 parent) 比 I-1 更窄, host 打断不了 room 里非自己子嗣的成员 |

**定案 I-1**, 四条约束都写成断言 (tests/room-interrupt.test.ts):
1. chat_ask / chat_say 带 `interrupt: true`: 先 Esc 打断再投本条, 不拆 pane;
2. 只有对方的直属 parent、该 room 的 host、人能用, 其余 403;
3. 计入该 room 的回合预算 (M=20 / 10 分钟), 超了 409;
4. 被打断那一轮的 duty 不关, 之后按 seen 游标重投。

## 4. host 求值

```ts
// 纯函数, 每次读时算, 不落字段、不缓存进账本
export const hostOf = (members: readonly { who: Who; ord: number }[]): string | undefined =>
  members.filter((m) => m.who.kind === "wizard").sort((a, b) => a.ord - b.ord)[0]?.who.id;
// undefined = 无 wizard 成员: 绑定 room 里人话下一次触发 onboarding 拉 guide 入群 (founder);
//             无绑定 room 无人 → 归档
```

- 新群: guide 以 founder 入群 (ord=1) 即 host。交接 host = guide room_invite 人指定的成员, 然后 room_leave 自己 → host 自然落到下一位。
- 人不进 host 排序, 但拥有 host 的全部权限。
- 未决 join-req 的 holder 读时 = hostOf(当前成员), host 换人自动归新 host, 无转交状态。
- 离开: 离开者手上该 room 的未结 duty 由 daemon 写 status:"canceled" 的系统 reply (`closes` 记上), 唤醒提问者。
  - 必带测试 `tests/room-leave-cancel.test.ts`, 至少覆盖:
    - X 持有 Y 提的 duty D 时离开 → 账本多一行 `{author: daemon, kind: reply, status: canceled, re: [D], closes: [D@X], wake: [Y]}`;
    - 提问者是人 → 不唤醒 wizard, 该行按 §3a 镜像进企微;
    - X 是 host 时离开 → 未决 join-req 的 holder 变成下一位;
    - re 数组里混着别人的 duty → 只关 X 名下的;
    - 重复 fold 结果幂等。
- 实例被结束: 从所有 room 退出, 规则同上。

## 4a. 轮终与看门狗 (2026-11-19 裁决)

- 轮终事件驱动: mirror tail 的 turn_end → hub.onIdle, 正常路径零轮询。
- 全局看门狗一个 (rooms.watchdog.intervalSec 缺省 60 / staleMin 缺省 5): 每次一条 `tmux list-panes -a`, 只看「有未结 duty 且 staleMin 内无任何事件」的 wizard。
  - pane 活且闲 → 视为漏了 turn_end, onIdle 一次并补投。
  - **首轮只建基线**: daemon boot 后第一次扫描只记 lastEvent 与 pane 快照, 不取消、不补判闲。重启窗口不得被当成「很久没事件」。
  - **取消是破坏性操作, 两次扫描确认**: 第一次判 pane 不存在只记「疑似」, 下一次扫描 (间隔 ≥ intervalSec) 仍不存在才执行下面的结束处理; 其间 pane 回来 / 有新事件 / pane id 变化即清疑似。tmux 调用失败或返回空表 → 本轮整体跳过, 但**计连续失败数**: 到 3 轮打一条停摆 warn (只打一次), 恢复时打一条 recovered; failStreak 与 lastScanAt 进汇总行与 /status.watchdog —— 跳过不能变成静默失效。
  - **解析输入以真机为准**: pane 列表解析的单测 fixture 是真机抓下的原始输出 (tests/fixtures/), 外加含分隔符用例; 不用手写数组 (2026-11-19 `split("\\\\n")` 误杀 bug 的根因就是自造输入)。
  - **pane 不存在 → 按实例结束**: leaveOps 写 canceled 唤醒提问者, 并在它所在每个 room 落一行 `sys:"instance-ended"` 系统消息 (成员都看得见, 绑定 room 镜像)。**不自动重生**。理由: 自动重生会带着不确定的模型档位与上下文把别人的活接回去, 失败一次还要再兜第二层; 「实例结束了」是账本里说得清、人看得懂的事实。
  - **pane 忙 → 只 warn 不纠偏** (带 busyForMs + openDuties)。理由: 卡死与长活在外部不可分, 猜错就是打断正在干的活; 卡死由人 stop_wizard。
- pane cap 清扫误杀导致的 pane 消失属于 spawn 侧问题, 单独开活, 不进看门狗。

## 5. 终句与提醒 (F-1)

- 终句只进 turn store / rolepage, 不进任何 room, 不关任何 duty。mirror 的流式终句投递整段删除。
- 一轮结束时, 若唤醒它的 duty 未关且本轮没调 chat_reply → **当轮注入一次**提醒 (带 msgId)。
- 之后再闲下来仍未关 → 写一条 system 行进该 room (to = 提问者, 镜像进企微)。
- 同一 duty 只升级一次, 账本里留行即去重。

## 6. 迁移脚本 `cli/migrate-rooms.ts` (可重复跑)

- **只读源**: routes.jsonl、state/members.json、state/chats/*.jsonl、wizards.json、state/message-events.json。原文件一个字不改。
- **uid**: 每个实例的 uid 由 §1 的 `uidOf` 现算 (脚本不写 wizards.json; daemon boot 回填同一个值)。
- **建 room**:
  - 每个绑定 base 一个文件。
  - join 顺序: 绑定的管家 (founder, ord=1) → members.json 行按 since → 近 7 天在该群有轮次的 wizard。
  - home ≠ 成员, 不全拉。
- **历史**:
  - chat-records 每行 → `origin:"migrate"` 的 msg, seq 重排, 老 seq 记进 ext。
  - 成员游标折成 seen 行。
- **未结 route** (fold 后非终态, 现 5 条):
  - chat receiver → 人话 msg (to = owner)。
  - wizard receiver → `dm:<uid>|<uid>` room 里的 task msg。
  - 老 event id 写进 ext 备查。
- **message-events**:
  - uncertain (103) → 原样拷进 `rooms/_archive/`, 不迁。
  - queued (3) → 转成 msg。
  - 其余不动。
- **幂等**:
  - 每条迁入行的 id 由源键确定 (`mig:<sha8(源文件+源键)>`), 已在 room 文件里的跳过。
  - 第二次跑写 0 行, 输出计数报表。
  - `--dry-run` 只出报表。
- **daemon 侧**: 新 daemon 不再打开 routes.jsonl / members.json / chat-records / obligations / idle-nudges / strict-delivery-notices, 全部冻结。

## 7. 切换形态 (实现阶段的约束, 先报备)

- **config BREAKING**: `chatPolicy.topOnly` / `speech` / known-chats 的 strict 缺省删除 (zod 遇到旧键忽略并 warn, 不拒启动)。
- **强制 /new**: 宪章与 MCP schema 都变了, 所有活会话必须 /new。daemon boot 时把每个绑定 pane 标为待 /new, 下一次唤醒先 /new 再注入。
- 管家手闸改由 role (steward / guide) 触发, 不再看 topOnly。