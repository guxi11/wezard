# room 切换前修复单 (room-fix)

> **本文件是这件活的唯一事实来源。** 会话重开 / /clear / handoff 后从这里复原; 任何插话与本文件冲突, 以本文件为准。要求有增补, 派活方直接改这个文件并提交, 只发一句「重读 docs/room/fix-task.md」。
> 派活方: .LeoAdams。执行者: 见 plan d3ab1b5e 的 fix 任务。

## 0. 边界

- 工作区 `/Users/zyy/develop/Guxi11/cc-wecom-room-fix` (分支 room-fix, 起点 room-model @ 56d9418)。
- 不起 / 不 reload 线上 daemon, 不碰 ~/.wezard 下任何文件, 不 push, 不动别的 worktree。
- 只改 daemon/ shared/ mcp/ scripts/room-cutover/ 与下面点名的 tests (room-watchdog / class-migration / onboarding / strict-new-ack / room-quota 等新增测试与 tests/fixtures/)。tests/ 下其它文件另一个执行者在改, 不碰。
- 测试跑法: `ONLY="tests/a.test.ts tests/b.test.ts" /tmp/room-run-tests.sh /Users/zyy/develop/Guxi11/cc-wecom-room-fix /tmp/<out>` (HOME 指 /tmp/room-test-home); 全量去掉 ONLY。
- 提交前 `git diff --cached --name-only` 核对只含上面范围内的文件。可以分多笔提交, 鼓励每完成一条就提交一笔。
- 先读: docs/room/verify-fd4715b.md (含末尾「复核更正」)、docs/room/contract.md §4a、docs/room/cutover.md 的 7b 与「第 9 步附: 30 分钟观察清单」。

## 1. 看门狗 tmux 解析

daemon/index.ts ≈1755 的 `split("\\n")` 是字面反斜杠 + n, 多 pane 时全员误判「pane 消失」。把解析抽成 room-watchdog.ts 导出的纯函数 (如 `parsePaneIds(stdout)`), index.ts 用它。顺手核 index.ts 另两处 list-panes (≈3240 / ≈3569) 有没有同样问题。

**测试数据用真机原始输出 (C)**: 本机跑 daemon 实际用的 `tmux list-panes -a -F '#{pane_id}'` (改了 format 就跑改后的; 只读命令, 允许跑), 字节原样存 `tests/fixtures/tmux-list-panes-*.txt` (含末尾换行)。另加「字段里含分隔符」用例: 单字段 format → 末尾空行 / CRLF / 前后空白; 多字段 format → pane 标题里含分隔符, 断言 pane id 仍解对。提交说明写 fixture 的来源命令与抓取时间。不许用手写数组当解析输入。

## 2. 看门狗安全闸

- **(B) 首轮只建基线**: daemon boot 后第一次**成功**扫描只记各持有者 lastEvent = now 与 pane 快照, 不取消、不补判闲、不 warn; 汇总行标 `baseline: true`。写进 room-watchdog.ts 顶部规格注释。
- **(A) 取消两次确认**: 第一次判 pane 不存在只记「疑似」(Map target → 首次疑似时刻 + pane id), 不写账本、不唤醒; 下一次扫描 (距首次疑似 ≥ intervalSec) 仍不存在, 才写 canceled + 唤醒提问者 + instance-ended。其间 pane 回来 / 有新事件 (touch) / pane id 变化 → 清疑似。
- **(D) 防静默失效**: tmux 调用失败或返回空表 → 本轮整体跳过, failStreak++; 成功一轮清零。failStreak 到 3 打**一条** warn `{mod:"room-watchdog", failStreak, lastError}`「看门狗连续 3 轮拿不到 pane 列表, 已停摆」, 之后继续失败不再打; 恢复成功那轮打一条 recovered `{failedRounds}`。首轮失败也计数 (基线等第一次成功扫描才建立)。
- **冷 wizard**: 只有「绑定里有 pane id 且该 id 不在列表里」才算实例结束; 没有 pane 绑定的冷 wizard 不算。先查清 hub 的 paste / injectText 对冷 wizard 是重生还是失败, 按事实处理 (重生则交给 hub; 失败则只计数进汇总行 cold), 结论写进提交说明。
- instance-ended 正文里的计数按 room 分别算 (现在跨 room 累加)。

## 3. 看门狗日志形状 (观察项 O4)

每次扫描至多一行 info 汇总:
`{mod:"room-watchdog", baseline, holders, stale, suspect, idleFixed, ended, busy, cold, failStreak, lastScanAt, busyList:[{name, uid, busyForMs, openDuties}]}`
全零时降为 debug。去掉逐 wizard 的 warn; 「结束」事件可以保留一行 warn (罕见且是状态变化)。

## 4. /status

加 `openDuties` (daemon 内存里全部 room 的 openDuties 总数) 与 `watchdog: { failStreak, lastScanAt }`。现有 `pending` 是审批卡数, 不动。

## 5. 投递日志 (观察项 O3)

- room 镜像进企微成功: info `room: mirrored` {room, msg, lagMs = now − 行 at}。
- hub 注入成功: info `room: delivered` {room, msg, target, lagMs}。hub 的 paste 端口现在只拿 (target, text), 需要时扩签名带上行信息。

## 6. scripts/room-cutover/observe.mjs (只读)

- `log --since <ISO>`: pino 日志按 level 计数 + warn 按 msg 聚合, 与 since 前 24h 对比列出新出现的 warn 文案。
- `duties`: 读 ~/.wezard/rooms/ 用 dist/shared/room.js 的 fold 重放, 输出未结 duty 数。
- `lag <msgId>`: 从 daemon.log 取 mirrored / delivered 两行, 打 lagMs。
- `watchdog --since <ISO>`: 每次扫描行数最大值 / 总行数 / 各计数和 / failStreak 最大值。
- 日志路径与 rooms 目录可用参数覆盖; 用 /tmp 夹具测一遍 (不读线上文件)。

## 7. 切换 /new 标记 (index.ts ≈1306-1326)

删掉无用的 origPaste 两行; injectText 因 pane 忙失败的目标不得丢 —— 保留待 /new, 等它闲 (可挂 onTurnEnd) 再做, 全部成功后才删标记。核清 `m.chatRoster("")` 是否真返回全部绑定 pane, 不是就换成正确来源。

## 8. 验证报告 II 的 3 个真红

1. class-migration: uid 回填让 `.pre-classes.bak` 不再是原样字节 —— **修代码** (迁移前先拿原文件字节做备份, 或回填延迟到首次显式写盘), 不许改断言。**同一根因还让 tests/wizard-identity-migration.test.ts:49,66 (`.pre-identities.bak` 原样字节) 红** —— 修一处两处都要绿 (该测试文件在 room-model 上已被改过 import, 合并后再跑)。
2. onboarding + 3. strict-new-ack: 删掉残留的 `.speech` 读点 (inbound.ts isStrictChat ≈660、channel.ts strictTopicOf ≈553 及调用点), 行为按 room 口径统一 (系统行前缀写法一处定), 对应测试按新语义改写断言。
- 改完把 `speech` 整词加进三条 grep 的第二条复跑, 贴输出。

## 8a. 出站额度 (2026-11-19 增补, design.md:147 / :212)

C 节删 strict-gate 时 `openSayMeter` 没移植, room 出站当前无额度。按设计补成**全量生效**: 每个 wizard 每轮 ≤3 条、每 room 每分钟 ≤10 条, 超出 409 (文案给出口: 合并成一条 / 下一轮再说)。计入面: room_say / room_ask / room_reply (带 text) / notify / send_file 进 room 的行; daemon 系统行与人话不计。计数器纯函数放 shared/ 或 daemon/ 新模块, 轮界按 turn_end 重置。单测: 同轮第 4 条 409、同 room 第 11 条 409、换轮后恢复、系统行不计。tests/strict-chat.test.ts 在 room-model 上已改写 (AliceOwen 913bda2), 你的额度断言写进新文件 tests/room-quota.test.ts, 不碰 strict-chat。

## 9. 单测清单 (每条要能在修之前红)

| # | 用例 |
|---|---|
| ① | 一次疑似不取消, 第二次 (≥ intervalSec) 才取消 |
| ② | 两次之间 pane 回来 → 不取消 |
| ③ | boot 首轮零动作 (连 onIdle 都不调), 汇总行 baseline:true |
| ④ | 真机 fixture 解析出的 pane 数 = 文件非空行数 |
| ⑤ | 含分隔符用例 |
| ⑥ | 连续 5 次失败只出 1 条停摆 warn; 第 6 次成功出 1 条 recovered 且 failStreak 归零 |
| ⑦ | 失败 2 次后成功, 零 warn |
| ⑧ | 3 个忙 wizard 一次扫描只出 1 行日志 |
| ⑨ | tmux 失败零结束; 冷 wizard 零结束 |
| ⑩ | class-migration / onboarding / strict-new-ack 绿; 合并 room-model 后 wizard-identity-migration 绿 |
| ⑪ | room-quota: 同轮第 4 条 409 / 同 room 第 11 条 409 / 换轮恢复 / 系统行不计 |

## 10. 验收与交付

**验证口径 (2026-11-19 人拍板, 优先于下面各条)**: 不跑全量 —— 不要再排 97 个的回归; 全量计数直接引用 room-model 已有那次 (913bda2: 97 例 · PASS 78 · FAIL 18 · SKIP 1)。但**你新增或修改的每个测试文件各跑一次该文件** (`ONLY="tests/x.test.ts" /tmp/room-run-tests.sh ...`), 交付时逐文件贴 rc —— 至少: room-quota (8a)、class-migration 与 wizard-identity-migration (8.1, 后者先 `git merge room-model` 拿到改过 import 的版本再跑)、room-watchdog、onboarding、strict-new-ack。tsc + build 照跑。
交付三样: ① 全量计数 (引用上面那次) ② 新增/修改文件的单测 rc 表 ③ 本文件末尾的勾选进度。

**收口口径 (2026-11-19 上级钉死)**:
1. **合并方向**: 跑测试前先把 room-model 拿进来 —— 先提交你自己的改动, 再在 room-fix 上 `git merge room-model` (room-model 已含 9c727f3 那批测试改写)。是 merge 进来, 不许用 fix 的版本覆盖 room-model 的测试文件; 有冲突就解冲突并在提交说明里写怎么解的。不先合并就跑, 等于在旧 import 上验。
2. **红数必须是 14, 而且正好是基线那 14 个** (docs/room/test-baseline.md 表里的名字, codex-approval 已转绿不算)。上一次全量 (913bda2) 的 18 红 = 基线 14 + class-migration / onboarding / strict-new-ack + wizard-identity-migration; 这 4 个加上新增的 room-quota, **逐个贴 rc=0**。
3. **不许混出第 15 个红**: 不跑全量, 但要跑「受影响面」—— 用 `git diff --name-only room-model...HEAD -- daemon shared mcp` 列出你改过的源文件, 再 `git grep -l` 出 tests/ 里 import 这些模块 (或对它们做源码切片) 的测试, 用 ONLY 跑这一批, 贴清单与每个的 rc。其中出现基线 14 之外的红 = 修复引入的新问题, 必须修掉, 不许算作基线。
4. 在执行者自己的 worktree 里提交也只用 `git add <具体路径>`, 不用 -a、不用 `.`。

- tsc + build 绿; tests/room-*.test.ts 全绿 + ⑩ 三个绿。
- 提交说明贴: 各单测名、fixture 来源命令与时间、冷 wizard 结论、`speech` grep 复跑输出。
- 回执贴单测里捕获的**首轮扫描日志原文** (O4「首轮结束计数 = 0」要靠 B 保证)。
- 终句: `.LeoAdams RESULT: <一行>` + 提交 hash 列表。

## 进度 (执行者自己维护, 每完成一条打勾并提交)

- [ ] 1 解析 + fixture
- [ ] 2 安全闸 (A/B/D/冷/计数)
- [ ] 3 日志形状
- [ ] 4 /status
- [ ] 5 投递日志
- [ ] 6 observe.mjs
- [ ] 7 /new 标记
- [ ] 8 三个真红 + speech grep (+ wizard-identity-migration 同根因)
- [ ] 8a 出站额度