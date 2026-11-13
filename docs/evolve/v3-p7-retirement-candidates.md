# v3 P7 退役候选清单 (S3 ⑤: 只登记, 不删)

> 人拍板的口径: implicit 模式退役之前, 这些「implicit 时代的推断路径」**原样保留**;
> 这份清单只登记它们是什么、被 strict 的什么取代、退役时要先核什么。任何一条都
> 没有随 S3 代码被删除或旁路 (S3 只加不改: strict 群走新口径, implicit 群行为零变化)。

## 退役的前置条件 (所有条目共用)

- known-chats 册 (state/known-chats.json) 里 legacy 集合 **为空或全部已显式 strict**:
  即所有在册聊天生效 speech=strict (chatPolicyOf 判定, 不看历史遗留);
  `/strict --all` 预演的候选列表为空即是最直接的判据。
- 观察期: 最后一个 implicit 群切走后跑满一个保留周期 (chat-records keepDays=30),
  确认没有新 implicit 聊天溜进来 (boot 增量只加 legacy, 不产 implicit 新群; S3 后
  首见一律 strict, 单聊除外 —— 单聊的 implicit 退役**不在**本清单范围)。
- 回归基线: strict-* 七个测试文件 + chat-record + channel 全绿后再动手。

## 候选 1: deferred 出站 (打字机流的延迟裁决)

- **位置**: daemon/mirror-bridge.ts `OutboundState` 的 `kind: "deferred"` 分支与
  `flushStream` (3119 起的联合类型; 3284 的 timer 清理)。
- **它是什么**: implicit 时代出站没有「这一轮服务哪条路由行」的概念, 流式帧先攒
  在 deferred 缓冲里等 timer, 猜「这轮还会不会有正文」再决定发不发。
- **strict 取代它**: 出站由事件的路由上下文裁决 (eventFinalGate / strict 出站门),
  strict 群的流式帧一律不出 (人只见占位+详情), 不再需要「攒一会儿猜意图」。
- **退役动作**: 出站状态机收敛为「路由行放行即发, 否则丢弃」; 删 deferred 分支与
  它的 timer。先跑 strict-outbound / pane-delivery。

## 候选 2: standalone 出站 (无轮次正文的兜底口子)

- **位置**: daemon/mirror-bridge.ts `sendStandalone` (「Like sendStandalone but skips」
  注释前) 与 skill_output 的 standalone 旁路 (544 起)。
- **它是什么**: 没挂在任何轮上的正文 (skill 输出、CLI 侧 user 行后的散句) 从这里
  直接顶一条气泡 —— implicit 群里「人必须看得见一切」的兜底。
- **strict 取代它**: strict 群里出站只有两个被批准的口子 (chat_reply / chat_say),
  standalone 在 strict 群已被出站门拦住 (S2 起 strictChat 直接 return); 它活着
  只为 implicit 群与私聊。
- **退役动作**: implicit 退役后 standalone 只剩私聊一条合法去向 —— 把它改名/收窄成
  「私聊兜底」并删掉群聊分支; skill_output 的 quiet 语义不变。先跑 strict-outbound。

## 候选 3: CoT 进度行 (未收口气泡的定长 thinking 行)

- **位置**: daemon/mirror-bridge.ts `flushCot` / `updateBriefProgress` /
  `updateBriefToolProgress` (COT_FLUSH_MS=1500 一带)。
- **它是什么**: 正文落地之前, 未收口气泡里的一行定长 CoT 进度 (1.5s 节流、截断、
  必被终句覆盖) —— 2026-09-02 人要求的例外实现, 详见记忆 feedback_mirror_thinkstyle。
- **strict 取代它**: strict 群占位气泡只有「链接 …」一行 (armBriefBubble strict 分支),
  CoT 行根本不立; 它只服务 implicit 群与私聊的等待体验。
- **退役动作**: implicit 退役后 CoT 行只剩私聊; 评估私聊是否还需要等待指示, 需要
  就留着, 不需要就连 flushCot 一起删。**注意**: 这不是恢复 think-style —— 正文内联
  reasoning 的禁令 (backup/think-style 分支) 与本条无关, 永不复活。先跑 strict-outbound。

## 候选 4: eventFinalGate / finalReleased 推断

- **位置**: daemon/router.ts `finalReleased` (522 起, 「三套推断都退化成这一条」的
  注释所在) + daemon/mirror-bridge.ts `eventFinalGate` (3257 的默认放行、8185 的接线)。
- **它是什么**: implicit 时代「这句终句该不该进群」没有行可查, 只能按 held/在飞/
  已落定/RESULT: 关键字四层推断 (router.ts 348 注释: topOnly 收口、eventFinalGate
  三套推断)。
- **strict 取代它**: strict 群 chat 接收行终句零 op (S2 起 finalReleased 的 strict
  参数直接 false), 交付走 chat_reply; 推断分支在 strict 群已经不跑。
- **退役动作**: implicit 退役后 finalReleased 只剩「显式 RESULT 寻址」一个真实语义,
  held/在飞两支推断可删; eventFinalGate 的默认放行 (`() => true`) 收窄为
  「无行=私聊照放」。**这是四条里风险最高的一条** —— 回执/追述语义全压在它上面,
  退役前先跑 strict-final / strict-obligation / receipt 全套。

## 不在本清单 (明确不退役)

- 单聊/私聊的 implicit 口径: strict 是群治理概念, 私聊永远走现行口径。
- keepalive 吞没链 (mirror-bridge keepaliveByContent): 与发言模式无关, 永不退役。
- chat-records / members / obligations 账本: strict 的地基, 只增不删。
