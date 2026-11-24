# multi-source-binding · P4 群源+判定证据+显式另起 (任务文件, 以此为准)

仓库 /Users/zyy/develop/Guxi11/cc-wecom, 分支 v3 (勿切勿 push)。先读 docs/room/multi-source-binding.md §4.1/§5.1/§5.2 与你落的 P1 28b3471 / P2 f172181 / P3 52e665d。冲突以设计稿为准。

## 范围 = §8 的 P4 + P3 遗留的显式另起

1. 群源绑定入站 (§4.1)
   - 群消息 dispatch 前: 源→room 解析先查 bind 索引 (roomOfSource); 已绑 → 落目标 room, 行 src 写死 (P2 出站已能按 src 回群消息)。
   - daemon/steward.ts stewardRoute: 先查索引 —— 源已绑进 room R 时, 裸消息的接待对象 = R 的 host, 不走该源类绑定化身; 恒等路径不变。

2. 判定证据 dry-run (§5.2, 拍板后daemon只给证据, 决定权在模型)
   - room_bind 带 dryRun (或不带 source 时的候选模式, 按你 P3 已做的「最近带 src 人话」缺省逻辑顺势设计) → 返回候选 room + 证据行, 词汇与 route_candidates 同一套:
     证据 (强→弱): 同 asker (发话人在候选 room 近期说过话) / 正文相关 (trigram 规范化重叠率, simMin 缺省 0.3) / 职责匹配 (候选 host 职责 vs 正文关键词) / 近期接待 (该源历史消息曾落该 room)。
   - veto (daemon 硬判, 列出被否决原因): 目标 room host 不在座 / 近 busyWindowMin 无活动且未结 duty 为 0 (死 room) / 跨 bot / 源已绑别处。
   - 阈值 rooms.binding.simMin / busyWindowMin / decideTimeoutMin 全部 hot-read (decideTimeoutMin 已有)。
   - 只读, 不写账本。

3. 显式另起入口 (P3 遗留: 出口 3 目前只有 10min 超时兜底)
   - 新 MCP 工具 room_fork({source}): 对首触落频道的帖子源**立即**走出口 3 —— 调 birthPostRoom (by=调用者), 幂等判据同 P3 (帖子 room 已在/已绑/引导期都不动)。权限: 该频道 room 的 host 或人; 其余 403。
   - 工具描述写清: host 判定「这该是新 room」时用它, 不必等超时。

## 验收
- 单测 (扩 tests/room-bind-tool.test.ts 或新建): 群源已绑 → 消息落目标 room (行 src) 且 steward 接待 = 目标 host; 恒等回落不变; dry-run 证据排序/阈值/veto 各分支; room_fork 权限/幂等/未首触源拒绝。
- 回归: tests/room-*.test.ts、tests/channel-*.test.ts 全绿; npx tsc --noEmit 干净。
- 真机两向通验收由我 (UmaFord) 在演练阶段做。

## 纪律 (红线, 违者返工)
- 不 push、不 reload、不 build; 严禁引入任何出站额度/限流逻辑。
- 允许触碰: daemon/steward.ts、daemon/inbound.ts、daemon/room-bind.ts、daemon/index.ts (如必要)、mcp/tools.ts、shared/config.ts、shared/room.ts (如需 helper)、对应测试、本任务文件。别动 web/、docs 其他文件、CHANGELOG (收口阶段)。pathspec 提交; commit: feat(room): P4 群源入站+绑定证据 dry-run+显式另起 room_fork

## 交代
完成后 chat_reply (status done): commit、测试结果、取舍/遗留单列。卡住 status need。

## 进度 (执行者自维护)
- [x] 读设计稿 §4.1/§5.2 + P1-P3 代码
- [x] 群源入站查索引分流 + stewardRoute 改道
- [x] dry-run 证据/阈值/veto
- [x] room_fork 显式另起
- [x] 单测 + 回归全绿 + tsc 干净
- [ ] pathspec 提交 + 交代

