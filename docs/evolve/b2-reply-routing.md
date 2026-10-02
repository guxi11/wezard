# B2a · 回执之后那一轮的去向 (父 continuation)

> `.ev-route` (克隆自 `.ev-proto`) · 2026-10-02 · 并入 B2a, 落在 ⓪ 判闲修复之后
> 对照代码: `daemon/receipts.ts` (`watch` / `register`) · `daemon/index.ts` (`tellPeer`, `deliver`, `channelOf`) · `daemon/mirror-bridge.ts` (`currentChannel` = attachment 的 `channel`, 注入时写) · `daemon/peers.ts` (`answerOf`, 信封渲染) · `shared/reminder.ts`

## 0. 一句话

一轮回复去哪, 现在只由**这一轮是被谁注入的**决定 (`injectText` 时写进 attachment 的 `channel`)。回执是 `deliver` 直接注入的, 带的是**那一次 tell_peer 的频道** (私聊就是 `""`)。所以一个 wizard 在回答人或上游的那一轮里派了活, 等回执回来, 它据此写出的真结论就只落在 rolepage, 人和上游都收不到。缺的是 continuation 里的「父 k」: tell_peer 时没有记下「发出这句话的那一轮本该把结论交给谁」。

## 1. 现状: 每种形状的终句去了哪

记号: `A` 收到请求, 在那一轮里 `tell_peer` 了 `B` (默认私聊); `B` 的回执注入 `A` 之后, `A` 再说的那一轮叫「回执轮」。

| 形状 | A 的首轮终句 | A 的回执轮终句 | 问题 |
|---|---|---|---|
| 人在群 G 问 A, A 私聊派 B | 进群 G (多半是「已派给 B」) | channel `""` → **只进 rolepage** | **丢**: 人永远看不到结论, 除非 A 自觉 `notify` |
| 人在群 G 问 A, A 公开派 B (`public:true`) | 进 G | channel G → 进 G | 对。但「公开」是为了让人看见 A→B 的往来, 不该是让结论回群的唯一办法 |
| 定时任务放给 A, A 派 B | 进 home 群 | `""` → rolepage | **丢** (同第一行) |
| `.evolve` 私聊派 A, A 再派 B (两级) | 被 `evolve←A` 的 watcher 当成回执**提前送走** (「已派给 B, 等它回来」) | `""` → rolepage, 没有 watcher | **错投 + 丢**: 上游拿到半成品并据此计数; 真结论丢了。工单里这一份已被计为「到齐」 |
| A 开工单派 5 路 (私聊) | — | 每份回执各自一轮, `""` | 中途 4 轮无害 (rolepage); 最后一轮的汇总同样**丢** (该进群或该回上游) |
| 同上, 但 A 用 `public:true` 派 | — | 每份回执一轮都进群 | **刷屏**: 人看到 4 条半成品 |
| A 用 `wait_peer` 同轮取走 | 同一轮里继续, 终句照首轮的频道 | 无回执轮 | 对 (阻塞式本来就没有这个问题) |

结论: **丢** 发生在「回执轮」, **错投** 发生在「首轮带着未回的子委托就结束」。两者是同一个缺口的两面: 首轮的结论本该延后到回执轮再交付。

## 2. 取舍: 去向由谁定

| | (a) daemon 确定性算去向, 写进信封, 模型据此措辞 | (b) 模型在终句里加标记 (`TO: .x` / `TO: 群` / `QUIET`), daemon 解析转发 |
|---|---|---|
| 默认对不对 | 对, 由派活链决定, 不依赖模型自觉 | 模型忘了写就退回现状 (丢) |
| 可调试性 | 去向写在信封属性上, rolepage / read_chat 读得出来 | 标记写在正文里, 被截断 / 引用 / 复述时会误触 |
| 改道 | 已有显式工具: `notify` (给人)、`tell_peer` (给 wizard) | 一个标记就改道, 但错一个字就把结论送错地方 |
| 成本 | 一个 Slot 字段 + 一个信封属性 + 一处 re-arm | 解析 + 校验 + 回退 |

**采用 (a), 暂不做 (b) 的 `TO:`。** 理由: 改道是少数情况, 而且现成的显式工具已经能做到; 默认路径必须不依赖模型记得某个格式。`QUIET` (这一轮不外发) 留给 B4 的定时任务静默哨兵一起设计, 两处用同一个词, 不在这里先发明。

## 3. 设计

### 3.1 父 k

```ts
/** 发出这次 tell_peer 的那一轮, 结论本该交给谁。 */
type ParentK =
  | { kind: "chat"; channel: string }   // 那一轮是人 / 定时任务 / 公开 peer 发起的: 结论进这个群
  | { kind: "peer"; from: string };     // 那一轮是 `from` 私聊派来的: 结论作为回执回给它 (slot from→A)
```

`Slot.k?: ParentK`, 在 `tellPeer` / clone·spawn 带 task 时由 daemon 计算, 写进 Slot (落盘)。计算 **只读 A 自己 transcript 最后一句 user 行的信封** (`parseEnvelope`), 与 read_chat 同一口径:

| A 当前这一轮的信封 | k |
|---|---|
| 无信封 / `kind=human` / `kind=task` / `kind=peer scope=public` | `chat`, channel = `currentChannel(A)` |
| `kind=peer scope=private`, 非回执, 且 `slots(X→A)` 未落定 | `peer`, from = X |
| 回执, 带 `reply-to` 属性 | **继承**: 与那份回执的 k 相同 (属性里写明, 见 §3.4) |
| 回执, 不带 `reply-to` (上游已经收到过, 或没有父) | 无 k (退回现状) |

读 transcript 而不是读 attachment 上的状态, 理由: attachment 的 `channel` 在注入时就改写了, 排队中的下一句会覆盖正在跑的这一轮; transcript 里的 user 行就是「这一轮是谁发起的」, reload 之后也读得到。

### 3.2 首轮不提前交付 (修错投)

`receipts.watch(P)` (P = 上游 `X→A` 那一份) 拿到 A 的终句之后、投递之前:

```
children(P) = 由 A 发出、k = {peer, from: X}、还没落定的 slot
若 children 非空 → P.deferred = true, 不投、不计数、不 settle (落盘, reload 后重查结果相同)
```

A 首轮那句「已派给 B」只留在 rolepage。上游的工单计数不前进, 直到真结论回来。

### 3.3 回执轮续回 (修丢失)

`deliver(child)` 投递子回执时决定这一轮的频道与 `reply-to`:

```
siblings = 由 A 发出、k 与 child.k 相同、还没落定的 slot (不含 child)
k = child.k
若 siblings 非空 (工单中途 / 还有别的子委托没回)  → channel = ""        , 不写 reply-to  —— 半成品只进 rolepage
否则若 k.kind = chat                              → channel = k.channel , reply-to = 那个群名 —— 终句进群
否则若 k.kind = peer 且 P = slot(k.from→A) 已 deferred → channel = ""   , reply-to = .X ;
      投递后 re-arm P: P.at = 投递时刻, P.deferred = false, P.anchor = "reply-to"
```

re-arm 后的 P 照常 `awaitReply`, 只是定位锚从「`from=.X` 的 peer 信封」换成「`reply-to=.X` 的回执信封」。为此 `answerOf` 的命中条件加一条: `t.env.replyTo === fromName`。三态语义不变。

多级 A→B→C 自然成立: B 的首轮因为 C 未回而 deferred; C 回执到 B, B 的回执轮终句由 re-arm 的 `A←B` 送回 A; A 的回执轮再按 A 自己的 k 继续往上冒。每一级只看自己的直接父, 没有全局链表。

### 3.4 信封

回执信封新增两个属性 (`shared/reminder.ts` `envelopeAttrs.receipt`):

| 属性 | 值 | 含义 |
|---|---|---|
| `reply-to` | `.evolve` 或群名 (`wezard`) | 这一轮的终句会被送到哪里; 缺省 = 只进 rolepage |
| `k` | `peer:.evolve` / `chat:<base>` | 机器读的父 k (§3.1 「继承」一行读的就是它); 不给模型看 |

正文按去向换一句 (替换现在的「这段对话是私聊, 人看不见」):

- `reply-to` = 群: 「你这一轮的**最后一条消息会发进群 G**, 人在等这件事的结论 —— 写给人看: 做成了什么、没做成什么。」
- `reply-to` = .X: 「你这一轮的**最后一条消息会作为回执送回 `.X`** (它当初把这件活派给你) —— 收口成 `RESULT: …`。」
- 无 `reply-to` 且有 siblings: 「还有 N 份没回, 这一轮的回复只记在 rolepage, 不外发; 先记下这一份, 等最后一份到了再收口。」
- 无 `reply-to` 且无 k: 维持现措辞。

去重 / 防回环:
- re-arm 的是**已有**的 P, 不新建 watcher; `deliver` 仍然不登记 slot。回执轮的终句经由 P 交付, 而 P 是上游自己当初的那一份, 所以不可能自我触发。
- P 已被 `wait_peer` 取走 (`claimed`) → 不再 deferred / re-arm; 子回执按无 k 处理。
- 同一对又说了一句 → P stale → 新 slot 接管, 旧 P 的 deferred 作废 (现有 `stale` 判定覆盖)。
- k 的计算只看 A 自己 transcript 的那一行, 不跟随链条上溯, 所以链再长也不会出现环。

### 3.5 charter 与描述

- charter「怎么说话」一节加一句: 「回执带着去向: 回执信封写明你这一轮的终句会去哪 (群 / 上游 wizard / 只进 rolepage), 照它写。人问的事你转给了别人, 结论回来那一轮就是给人的交代; 等待期间值得让人知道的进展 (预计多久、卡在哪), 用 `notify` 先说一句。」
- 现有回执信封里「不要为收到回执而回话」那一句只保留在「无 reply-to」那一档。

## 4. 与 `.ev-proto` 的 B2a 对齐

- 同改 `receipts.ts` / `reminder.ts` / `peers.ts` (`answerOf`) / `index.ts` (`tellPeer`、`deliver`)。顺序: 等 ⓪ (判闲) 提交之后再落本节; 与 ① (失败回执) 的交点是「deferred 的 P 遇到子回执失败」: **失败的子回执同样触发续回**, 由 A 决定怎么向上交代。
- 与 ⑤ (工单总数) 的交点: siblings 判断用的是 slot 集合; 有了 `expect` 之后, 「还差几份」以工单为准, siblings 判断改用 `done < total`。

## 5. 实测清单

1. 人在群里问 A → A 私聊派 B → B 回执 → A 的回执轮终句**进群**, 首轮「已派」也在群里。
2. `.evolve` 私聊派 A → A 派 B: evolve 只收到**一份**回执, 内容是 A 在回执轮写的结论。
3. 两级 A→B→C: C 的结论经 B 冒泡到 A, 再进群。
4. 工单 3 路: 前两份回执轮不外发, 第三份的回执轮终句进群 / 回上游。
5. 上游对 A 用 `wait_peer` 取走: 子回执轮不再往上投 (不双投)。
