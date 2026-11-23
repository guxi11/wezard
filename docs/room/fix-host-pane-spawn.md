# 修复单: 频道管家实例有记录无 pane (「已被结束」)

## 现场 (2026-11-23 人报, duty 6b664ebb.419)

- 人在频道 room 发消息, host OliveBrown-2 不响应, 提示「已被结束」。
- daemon.log: `monitor: activate` 唤醒 wf9b1e23fb452 → `result:"gone"` → `room: 唤醒投递失败, 游标不动, 30s 后重试`。
- 「已被结束」文案 = room-hub.ts reportGone: 探活 pane "gone" → `<名字> 没有会话 (已被结束)…`。
- wizards.json 里 wf9b1e23fb452 (OliveBrown-2): **无 tmuxPane 字段**; 全盘无它的会话文件 —— 记录被创建、被 join 进频道 room, 但 **pane 从未被起**。

## 根因

群落定与频道路径不同构:

- guideSettleRoom (index.ts ~2180): join 后 `m.hasMirrorTarget(bound.target) ? hub.kick() : m.newSession(bound.target, name, {silent:true}).then(() => hub.kick())` —— **有起 pane 逻辑**。
- settleBoundChannel (index.ts ~2191, 频道落定): 只有 hostJoinOps + ensureMonitor, **没起 pane**。
- steward-repair 换实例 (boot 自愈): 只写 leave/join ops, **没起 pane**。OliveBrown-2 的记录就是 repair 那轮 join 进来的, pane 一直不存在。

monitor activate → 唤醒 OliveBrown-2 → probePane 无 paneId → "gone" → reportGone。

### 为什么「被唤醒时也没有重新拉起来」不是另一个 bug

room-hub.ts:249 起注释: 没有活 pane ≠ 忙, 那是**冷会话** (曾有会话绑定, reload 后没重挂 / pane 已死), 贴进去会自动重生。但 gone 的定义 (room-hub.ts:25) 是「目标**没有任何会话绑定**」—— 重试也贴不进去, 更不会触发重生。OliveBrown-2 从未被 spawn 过, 没有任何会话绑定, 所以唤醒只能 gone。这不是唤醒重生机制坏了, 修法 ①② 落地后「无会话绑定的 host 记录」不会再出现/存量被补, 即闭环。不要去改 gone 的判定或给 gone 加重生逻辑。

## 修法

1. **settleBoundChannel 补起 pane** (index.ts): hostJoinOps/ensureMonitor 之后, 加与 guideSettleRoom 完全同构的两分支 (`m.hasMirrorTarget(bound.target) ? hub.kick() : void m.newSession(bound.target, settleName(wizards, chatNameOf(cfg, bound.target), bound.target) || bound.target, { silent: true }).then(() => hub.kick()).catch(() => undefined)`)。频道 room 与帖子 room 共用同一管家, 一次即可。
2. **boot 兜底 (纯函数 + 接线)**: repair 是幂等的, 复跑时旧实例已请出、foreign 为空、joined 为空 → 永远不会补 spawn。在 daemon/steward-repair.ts 加导出纯函数 (建议名 `unspawnedStewards`): 入参 `(store, rooms, stateOf, boundClassOf, hasPane: (target) => boolean)`, 对每个直绑 room 用 localManifestation 解析本 room 管家实例, 若该实例是 room 成员 (host) 且 hasPane=false → 收集其 target 返回。index.ts 在 repair 调用点之后接线: 逐个 `m.newSession(target, settleName(...) || target, {silent:true}).then(() => hub.kick())`。这条管存量恢复 (OliveBrown-2), 也管今后任何「记录在、pane 没了」的漂移; dhtpm 的 OliveBrown-1 有 pane, 不会触发。
3. **单测** (tests/steward-instance.test.ts 加一组): 无 pane 的直绑实例命中 / 有 pane 跳过 / 幂等 (hasPane 恒 true 后不再命中) / 帖子 room 不重复收集 (同一频道管家去重)。

## 验收

- tsc + build + 全套相关单测绿 (codex 两红是基线)。
- reload 后真机: OliveBrown-2 有活 pane (tmux 可见 / 记录有 pane 或会话文件出现), 人在频道发消息它能被唤醒响应 (不再 reportGone); dhtpm 群 OliveBrown-1 不受扰动。
- 修完在 wezard dev 群对人交代 (经 .AliceLane), 再继续三件套验收。

## 规矩

同前: 一次一个提交者, pathspec commit, 不手改 room JSONL, 完成后 chat_reply 交代。

## 进度

- [ ] 修法 1: settleBoundChannel 起 pane
- [ ] 修法 2: unspawnedStewards 纯函数 + boot 接线
- [ ] 修法 3: 单测
- [ ] tsc + build + 单测绿
- [ ] reload + 真机验证 OliveBrown-2 可响应
