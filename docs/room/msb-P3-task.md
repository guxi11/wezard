# multi-source-binding · P3 频道首触与绑定工具 (任务文件, 以此为准)

仓库 /Users/zyy/develop/Guxi11/cc-wecom, 分支 v3 (勿切勿 push)。先读 docs/room/multi-source-binding.md 的 §4.1/§5.1/§5.2(只取硬门)/§6/§7 与你落的 P1 (28b3471) / P2 (f172181)。与本文件冲突以设计稿为准。拍板结论都在设计稿 §11。

## 范围 = 设计稿 §8 的 P3

1. 频道 @ 首触改走接待 (§4.1)
   - 原生帧 + topic_at_bot 配对成功 (postBorn) 时: **不再自动开帖子 room + 领号新实例**。人话落频道 room, 行带 post + mention:"bot" + src:"chat:<opk…>" (src 按 P1 字段、入站写死), 直达频道 room 的 host (开 duty 唤醒)。
   - 未配上对的兜底路径: 落频道 room (现状本就如此, 补 src/对齐)。
   - 未 @ bot 的新帖/评论落频道 room 由 monitor 判激活 —— 现行路径不动。
   - 现行测试断言「@ 即开帖子 room」的要按新语义改 (测试是规格, 改断言不是放宽)。

2. host 三出口与 10 分钟兜底 (§5.1, 拍板 §11-2)
   - 出口 1 自己处理: host 调 room_bind 把源绑进本 room (见 3)。
   - 出口 2 高度相关的旧 room: 判定 host 不是目标 room host → 先 chat_ask 目标 host, 由目标 host 自己 bind (权限模型天然如此, 无需 daemon 代码; 写进工具描述)。
   - 出口 3 另起: 帖子 room 诞生 + 领号新实例 (现行 channelPostBorn 行为, by=判定者或兜底时 DAEMON)。
   - 兜底: 频道 room host 被首触唤醒后 rooms.binding.decideTimeoutMin (缺省 10, shared/config.ts, hot-read) 内没有 bind 也没有显式另起 → daemon 自动走出口 3。幂等: 兜底触发前再查一次 bind 索引, 已绑/已另起就不做; overdue 提醒机制照常独立运行。

3. room_bind / room_unbind 工具 (§6, 拍板 §11-1/3)
   - mcp/tools.ts 注册 + daemon/room-bind.ts: bind 走 store.append 落 op (P1 的口), 对账闸关时拒绝 (BindGateClosed); unbind 删。
   - 权限: 目标 room 的 host 或人可写; 其他一律拒 (提示先 chat_ask 目标 host)。room 缺省 = 调用者所在 room (出口 1); 显式 room = 只有目标 host/人能成功。
   - 硬门 (§5.2 ①-⑤, daemon 静态判): 同 bot / 源未被绑定(一源一 room, 想换先 unbind) / 目标 room 存在且有 host / 源类型 ∈ {chat:群id, chat:opk…} / 源不是目标 room 主源。
   - 工具描述写清三出口用法与权限; 候选证据 (dry-run) 不做, 属 P4。
   - 绑定后: 该源的入站消息落目标 room (行 src=源 base) —— 入站分流接线: daemon 源→room 解析处先查索引 (roomOfSource), 恒等回落 = 现行为 (§4.1 roomOf)。频道帖子评论进绑定 room 的路径也要接 (行 src + post)。
   - 解绑 (拍板 §11-5 lazy): unbind 后源回落恒等, 帖子 room 下一条消息时才按需诞生 (现行 lazy 语义), 加测试锁定。

4. 另起时新 host 拉进频道 room (人 2026-11-24 追加, §5.1 出口 3)
   - 出口 3 执行时 (host 判定或兜底): 新实例同步加为频道 room 成员, 走 hub 正常 join (via spawn, by=判定者 host / DAEMON), 不走 join-req; ord=nextOrd; 频道 host (最早加入序) 身份不变; 新成员 watch 关、未点名人话不唤醒它 (现行唤醒规则应天然如此, 用测试锁死)。
   - boot 补拉存量 (§7): 与 settleBoundChannel/channel-rebind 同钩子, 幂等补拉已存在帖子 room 的 host 实例进频道 room; 条件: 频道已绑定、频道 room 有 host、实例仍在册 (stop/forget 跳过); 频道 room 无 wizard host (引导期) 不拉。

## 验收
- 单测 (新建 tests/room-bind-tool.test.ts + 扩 channel 首触测试): @ 首触落频道 room 唤醒 host 且不开帖子 room; bind 后帖子评论落本 room、reply 评论回原帖 (P2 机制); unbind 回落 lazy; 10min 兜底幂等另起; 另起后新 host 在频道成员表、host 身份不变、未点名不醒; boot 补拉幂等、实例不在册跳过; 硬门各拒绝分支; 闸关时 bind 拒绝。
- 回归: tests/room-*.test.ts、tests/channel-*.test.ts 全绿 (改断言要有理由, 别删测试); npx tsc --noEmit 干净。
- 真 daemon 演练 (临时 HOME + 临时端口) 由我 (UmaFord) 验收时做, 你不用 reload 真机。

## 纪律 (红线, 违者返工)
- 不 push、不 reload、不 build 上线; 只改代码+测试+git 提交。
- 严禁引入任何出站额度/限流逻辑 (拍板 §11-4, a3653e2 已删)。
- 允许触碰: daemon/index.ts、daemon/inbound.ts、daemon/room-bind.ts (新)、mcp/tools.ts、shared/config.ts、daemon/channel*.ts/steward.ts (如必要)、对应测试。别动 web/、docs (charter/dev-guide/CHANGELOG 属收口阶段)。提交前 git diff --cached 核对; pathspec 提交, commit 信息: feat(room): P3 频道首触接待+room_bind/unbind 工具+兜底另起+频道成员补拉
- 拆提交可以 (每笔 pathspec 干净), 但一笔逻辑一笔提交, 别把无关文件卷进去。

## 交代
完成后 chat_reply (status done): commit hash 列表、测试结果、取舍/遗留单列一段 (尤其: 现行为改了哪些断言、多 re/边角怎么处理的)。卡住 status need 写清卡点; 工程量大想分两次交代也行 (先 progress)。

## 进度 (执行者自维护)
- [x] 读设计稿 §4.1/§5.1/§6/§7 + P1/P2 代码
- [x] @ 首触落频道 room (不开帖子 room)
- [x] room_bind/unbind 工具 + 硬门 + 权限
- [x] 入站查索引分流 (bind 后落目标 room, src 写死)
- [x] 10min 兜底另起 (幂等) + 另起拉进频道 room
- [x] boot 补拉存量
- [x] unbind lazy 锁定
- [x] 单测 + 回归全绿 + tsc 干净
- [ ] pathspec 提交 + chat_reply 交代

