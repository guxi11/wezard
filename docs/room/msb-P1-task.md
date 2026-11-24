# multi-source-binding · P1 数据模型 (任务文件, 以此为准)

仓库: /Users/zyy/develop/Guxi11/cc-wecom, 分支 v3 (已在 v3, 勿切分支勿 push)。
先读 docs/room/multi-source-binding.md 全文 —— 设计已拍板 (§11 是拍板结果), §3/§7/§8 是你的规格; 与本文件冲突时以设计稿为准。

## 范围 = 设计稿 §8 的 P1, 只做 P1

1. shared/room.ts
   - 新 op: bind / unbind (字段见设计稿 §3.2: op, at, room, source: string, by: Who, why?: string), 进 RoomOp 联合类型。
   - fold: RoomState 增 bindings: Map<source, {at; by: Who; why?}> —— bind 设/覆盖条目, unbind 删条目; 重放结果一致 (与 closes/to 同纪律: 判定在 append 时算死, 重放不再推断)。
   - MsgRow 增可选 src?: string (§3.3: 这行从哪个副源进来, 缺省=主源=room id, 不落字段)。P1 只加类型字段, 不接任何写入/读出路径 (那是 P2/P3)。

2. daemon/rooms.ts
   - boot 装载: 扫 stateDir 下 rooms/*.jsonl, fold 出全部 bindings, 内存维护 source→roomId 索引 (纯缓存, 可重建)。
   - 对账闸 (§3.2): 索引重建后与逐 room fold 的 bindings 全量比对; 差一笔 → fail-closed: 拒绝后续 bind/unbind 写并记日志; 路由与读侧回落恒等 (= 现行为), 不得炸主流程。

3. 测试 (新建 tests/room-bindings.test.ts)
   - fold: bind/unbind 序列 → bindings 终态; 同一账本重放两次结果一致。
   - 对账闸: 构造索引与 fold 不一致的目录 → fail-closed 生效, 读侧不受影响。
   - 存量兼容: 无 bind op 的账本 fold 输出与改动前一致 (RoomState 关键字段逐项对比即可)。
   - 运行: npx tsx tests/room-bindings.test.ts (别加 --import); 再跑 npx tsx tests/room-hub.test.ts 应全绿。

## 纪律 (红线, 违者返工)
- 不 push、不 reload、不做任何 build/上线动作; 只改代码+测试+git 提交。
- 共享工作树: 只改上面列的文件; 不碰 daemon/index.ts、daemon/steward.ts、daemon/inbound.ts、mcp/tools.ts、web/ (P2/P3 的事)。提交前 git diff --cached 核对; commit 用 pathspec: git commit -m 'feat(room): P1 绑定数据模型 bind/unbind+src+boot索引对账闸' -- shared/room.ts daemon/rooms.ts tests/room-bindings.test.ts
- 测试基线: 仓库有 13 个历史基线红与本任务无关, 只保证你新建/触碰的测试绿。

## 交代
完成后 chat_reply (status done): commit hash、测试结果、取舍/遗留单列一段。卡住就 status need 把问题写清。

## 进度 (执行者自维护)
- [ ] 读设计稿全文
- [ ] shared/room.ts: op + fold bindings + MsgRow.src
- [ ] daemon/rooms.ts: boot 索引 + 对账闸
- [ ] tests/room-bindings.test.ts 全绿
- [ ] pathspec 提交 + chat_reply 交代

