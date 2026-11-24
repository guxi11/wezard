# multi-source-binding · P2 出站按源分流 (任务文件, 以此为准)

仓库 /Users/zyy/develop/Guxi11/cc-wecom, 分支 v3 (勿切勿 push)。先读 docs/room/multi-source-binding.md 的 §3.3/§4.2/§10, 以及你刚落的 P1 (28b3471: MsgRow.src, daemon/rooms.ts 索引)。与本文件冲突以设计稿为准。

## 范围 = 设计稿 §8 的 P2, 只做 P2

出站 roomMirror (daemon/index.ts) 的分流依据从 row.room 改为「本行的目标源」:
1. reply re 到某行: 目标源 = 被引用行的 src, 缺省 = 主源 (room id)。查行走现行 byId/行查找, 别新造第二份索引; 查不到被引用行 (或行不在本 room 账本) → 回落主源并记日志, 不炸。
2. say / file / notify (非 re): 目标源 = 主源, 与现状一致。
3. 占位气泡/流覆盖: 覆盖对象 = 人话行的发生源 (那条行的 src, 缺省主源) —— 换成按 src 找流, cover 机制本身不动。

传输按目标源类型 (设计稿 §4.2 表):
- 帖子源 (chat:opk…): send_reply 评论根帖; {channel, post} 仍查 channel-posts, 绑定不改企微侧地址。
- 群源 (chat:群id): 群消息。
- 频道主源 (chat:topic_id): 现行 channelOutboundOf 逻辑不变 (含行带 post 时评论回原帖)。
- 单聊主源 (user:…): 现行路径不变。

## 验收
- 单测 (新建 tests/outbound-src.test.ts 或并入现有出站桩风格): ① re 到带 src 行 → 分流到该源类型; ② re 到无 src 行 → 现行为不变; ③ say → 主源; ④ cover 按人话行 src。
- 回归: tests/room-*.test.ts 与 tests/channel-*.test.ts 全绿; npx tsc --noEmit 干净。
- src 缺省路径必须 = 现行为 (这是存量兼容的硬要求)。

## 纪律 (红线, 违者返工)
- 不 push、不 reload、不 build; 只改代码+测试+git 提交。
- 出站额度已于 a3653e2 整体删除 —— 严禁顺手加任何额度/限流/预算逻辑 (拍板 §11-4)。
- 允许触碰: daemon/index.ts、shared/room.ts (如需小 helper)、对应测试文件。别动 daemon/steward.ts、daemon/inbound.ts、mcp/tools.ts、web/ (P3/P4 的事)。提交前 git diff --cached 核对; pathspec 提交。
- commit 信息: feat(room): P2 出站按行目标源分流 (reply 跟所 re 行的源)

## 交代
完成后 chat_reply (status done): commit hash、测试结果、取舍/遗留单列。卡住 status need 写清问题。

## 进度 (执行者自维护)
- [ ] 读设计稿 §3.3/§4.2 + 复看 P1 代码
- [ ] roomMirror 按目标源分流 (reply/say)
- [ ] cover 按人话行 src
- [ ] 单测 + 回归绿 + tsc 干净
- [ ] pathspec 提交 + chat_reply 交代

