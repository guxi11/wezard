# delegate 与 room: 关系、融合方案、「公开 / 新生」标签审计

> `.DavidBrown` · 2026-11-22 · 应 admin「思考 delegate 和 room 的关系, 是否有必要更紧密地关联或融合 (创建群聊 + 点名发言); 检查 delegate 的『公开』标签是否仍有必要」。
> 依据: `daemon/index.ts` (`POST /dispatch`、`roomTargetOf`、`ensureDmRoom`、`joinRoomSpawn`、`bearAs`)、`shared/room.ts` (`judge`)、`mcp/tools.ts`、`daemon/wizard.ts` (charter)、`shared/detail-render.ts` (提示行)。只有标签做了改动 (§3), 融合部分只是方案, 等拍板。

## 1. 现状: 一次 delegate 实际落在哪

`delegate` = **选人** (`route.ts`: `rankCandidates` → `decide`, 或 `to` / `spawn` / `lead` 推翻) + 必要时 **造人** (`bearAs`, 与 `spawn_wizard` 同一个函数) + **一条 `task` 行** (`hub.append`, 和 `chat_ask` 走同一个 `judge`)。所以它的产物和 `chat_ask` 写下的行一模一样, duty 的归属也一样 (asker = 调用方, holder = 执行者)。

落在哪个 room 由 `roomTargetOf(me, [who], room)` 决定, 和 `chat_ask` 是同一个函数:

| 情况 | 落点 |
|---|---|
| 给了 `room` | 那个 room (见下面的 bug) |
| 执行者已经是缺省 room (唤醒这一轮的那个) 的成员 | 缺省 room。若它是绑定群, 会镜像进企微 |
| 其余情况 (单个 wizard) | `ensureDmRoom(调用方, 执行者)`, 即 dm。dm 若已变成多人, 就落进成员恰好是这两人的 adhoc |

推论:
- **新生的执行者不是任何 room 的成员**, 所以 spawn 出来的 delegate **总是落在调用方↔子 wizard 的 dm**, 调用方就是 host (最早入座)。admin 截图里那条 `e0ca1c9b.1` 就落在 `dm:wf2e2cd80bd49|wf483a663b0b7`。
- 只有选中一个**已在群里入座**的已有 wizard 时, 才会落进绑定群, 那时是真的公开。
- overdue / budget / wake / plan 关联都按落点 room 算, 和 `chat_ask` 没有差别 (非绑定 room 的 `overdue-group` 会转发到 holder 的 home 群)。

### 1.1 发现的 bug: `room` 参数从来没成功过 (未修, 建议)

`delegate`、带 `task` 的 `spawn_wizard` / `clone_wizard` 都是**先 `hub.append` task 行、后 `joinRoomSpawn` 入座**。而 `judge` 第 ⑤ 条要求 `to` 只能是成员 (`shared/room.ts`, 「这些不是本 room 成员 … 先邀请」, 409):
- `delegate({room})` 遇到新生的执行者: 子 wizard 已经生出来, task 投递 409, 接口返回失败。结果是留下一个**没活的孤儿 wizard**, 也不会入座。
- `spawn_wizard` / `clone_wizard({task, room})`: append 失败被吞掉, 回包仍是 `dispatched:true`, 只有 `event:""`, **活静默丢了**; 之后子 wizard 照样入座, 但没有活可干。
- 实据: `~/.wezard/state/rooms/*.jsonl` 里一条 `"via":"spawn"` 的 join 都没有。
- 修法 (light, 低风险): 给了 `room` 时先 `joinRoomSpawn`, 再 append (调用方必须是那个 room 的成员, 这本来就是 judge 的要求)。另外 spawn/clone 路径里 append 失败时, 回包应如实写 `dispatched:false` 加上原因。补一条测试即可。charter 的「spawn / clone / delegate 都可以带 `room` 让它免审进那个 room」在修好之前是在宣传一个坏功能。

### 1.2 重复、割裂与概念负担

- **开 duty 的动词有四个**: `chat_ask`、`delegate`、`spawn_wizard{task}`、`clone_wizard{task}`。写进账本的都是同一种行, 区别只在「对方是谁」: 点名 / 让 route 选 / 白板新生 / fork 新生。其中 `delegate({spawn:true})` 和 `spawn_wizard({task})` 几乎等价: 前者有 taskFile、自动 tier、lead; 后者有 cwd / chat / model / effort。
- **开房间有三条路**: `room_open` (显式 adhoc), `chat_ask` 对单个非成员时隐式开 dm, `delegate` / spawn 也隐式开 dm。但 **chat_ask 的 `to` 有多个非成员时报 400**, 模型得先 `room_open` 再 `chat_ask`, 用两次调用表达一个意图。
- **charter 里没有真正互相打架的句子**: 「多步的活默认开跟进 room (`room_open`, 或单个非成员 `chat_ask` 自动落的 dm)」与 delegate 自动落 dm 是一致的。缺的是**一句明说的话**: delegate 的活缺省落在你和它的 dm。现在模型只能从「产出是一条 chat_ask」自己推出这一点。唯一错的一句是 §1.1 那条 `room` 宣传。

## 2. 融合方案

admin 的方向: 「创建群聊 (单聊是一种形式) 并点名发言」。拆开看, 「点名发言」就是 `chat_ask`, 「单聊」也已经由 `chat_ask` 自动建 dm 实现了。真正缺的只有一块: **多人时自动建群**。delegate 现在已经是「选人 + chat_ask」的薄糖, 产物在账本上和 chat_ask 无法区分。所以融合不需要动 delegate, 只需要补齐 chat_ask。

| | A. 保持现状, 只修术语和 bug | B. chat_ask 的多个 `to` 自动建 adhoc (推荐) | C. delegate 并入 chat_ask / room_open |
|---|---|---|---|
| 做什么 | 修 §1.1 的入座顺序; 标签按 §3 修 (已做); charter 的 delegate 行补半句「活缺省落在你和它的 dm」 | A 的全部, 再加: `roomTargetOf` 在「多个 `to` 里有非成员」时不再 400, 改为找成员集合恰好是 {me, …to} 的 adhoc (把 `findPairAdhoc` 推广到任意集合), 没有就 `openAdhoc(me, to)`; `room_open` 留着, 用来起标题或先拉人后说话 | 删掉 `delegate` 工具, 让 `chat_ask` 不给 `to` 或给 `to:"auto"` 时走 route; tier / lead / spawn / force / taskFile / params / name / description 都并进 chat_ask; `route_candidates` 变成 `dryRun` |
| 改动面 | `daemon/index.ts` 两处顺序 + 一条测试, `wizard.ts` 一句 | 再加 `roomTargetOf` 一个分支, 一个纯函数 (按成员集合找 adhoc) 及其测试; chat_ask 描述和 charter 各删一个从句 | MCP schema、`/room/ask` 并入 dispatch 的全部分支; steward 手刹的拒绝理由 (「去 delegate」)、`refuseGuide`、onboarding 白名单、rolepage 提示行 (`via:"dispatch"`)、charter 的编排段落、相关测试 |
| 风险 | 很低 | 低。① **绝不扩大绑定群**: 唤醒你的是企微群, 而 to=[群内的 A, 群外的 B] 时, 要新建 adhoc{me,A,B}, 不能把 B 拉进群 (否则人会看到陌生 wizard 入群)。② adhoc 泛滥: 靠「成员集合相同就复用」压住。③ interrupt 预算按 room 计, 新建 room 等于换了一份预算, 需要限制 (例如自动建的 adhoc 继承调用方在缺省 room 剩下的额度, 或自动建 adhoc 时禁止 interrupt)。duty 归属、host (= 调用方, 即 founder)、overdue (非绑定 → 发 home 群)、wake、planId 都不变 | 中高。最常用的 `chat_ask` 描述会膨胀 (route 的一整套规矩都搬进去); 「点名问」和「替我挑人」混进同一个动词, 模型在一个参数上猜意图, 正是当初把 spawn 和 clone 拆开时想避免的; 历史 transcript 里的 delegate 提示行要保留兼容渲染 |
| 工具数 / charter | 不变 | 不变; charter 少一个从句 (「多个非成员先 room_open」) | 少 1 个工具 (`delegate`), 可能再少 `route_candidates`, 但 chat_ask 的 schema 大约多 9 个参数。在 Claude Code 上 MCP schema 是 deferred 的, 一直占上下文的是 charter 的「何时用」行, 所以实际省下的不多 |

**推荐 A + B**: 先做 A (bug 一定要修), 再做 B, 这就是 admin 说的「创建群聊并点名发言」: `chat_ask({to:[…]})` 一步完成, 单人是 dm, 多人是 adhoc, 已在同一个 room 就直接说。delegate 不动, 定位写清楚: 「不知道该交给谁时用 delegate, 它替你选人, 然后照样是一条 chat_ask」。C 不做: 省掉的工具名不抵 chat_ask 语义变糊的代价。spawn/clone 的 `task` 参数可以在以后评估是否收进 delegate (`delegate({spawn:true})` 已覆盖白板的场景, clone 的 fork 语义 delegate 没有), 不在这次范围内。

## 3. 「公开」「新生」标签审计 (已改)

渲染位置: `shared/detail-render.ts` `renderHandoff`, 即 turn 过程框里那行「↪ 派活 .X …」。rolepage 的 `roomDeco.pub` 恒为 `undefined`, 所以完全靠 `Handoff.public` 判断。

- **「公开」(及其反面「私聊」)**: 本意是「这句话落进了企微群, 回复也进群」。room 模型之前, 回包带 `public`。**room 模型之后, delegate 的回包不再带 `public`** (`return` / `public` 参数已退役), 只剩回退表达式 `via==="dispatch" && a.public !== false`, 结果**每一条 delegate 都被标成「公开」**, 而新生的 delegate 必定落在 dm, 等于在说假话。chat_ask 那一支本来就用回包的 `room` 判断, 是对的。
  - 在 room 模型下, 这个事实严格等价于「落点是不是绑定 room」(dm: / adhoc: 都不是)。rolepage 账本气泡的头上已经写了 room 名, 所以「私聊」这一半是冗余的; 「进了企微群」是派活里的少数情况, 值得单独标出来。
  - **结论: 改**。`public` 改由回包的 `room` 判断 (老回包的 `public` 照旧采信); 只在落进绑定 room 时挂一个「进群」标签 (悬停提示: 人看得见, 交代也进群); 「私聊」标签删掉。附带效果: 落在 dm 的 delegate 行重新带上原文的 chevron, 和 chat_ask 一致 (以前被误判成公开, 原文被藏起来了)。
- **「新生」(及其反面「选中」)**: 数据来自 delegate 回包的 `decision` (`spawn` / `existing`), 悬停显示 route 的理由 `reason`。它说的是 route 的决定, 和 room 无关。旁边的信息 (谱系图) 只能间接看出「是新生的」, 看不出「为什么没复用别人」; 这个悬停是 rolepage 上唯一能看到 route 理由的地方。**结论: 保留**。

改后截图: `/home/ubuntu/.wezard/shots/delegate-row-after.png` (「↪ 派活 CarolAdams e0ca1c9b.1 新生 【admin 原话】…」, 已经没有「公开」)。
