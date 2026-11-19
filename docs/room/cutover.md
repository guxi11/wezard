# room 模型 · 切换清单 (草案 v2)

相关文档 (都在本目录): design.md 设计稿 · contract.md 契约 · cutmap.md daemon 切割图 · grep.md 旧引用清单 · brief.md 分身简报

原则: 每一步单独执行、单独验证、单独回退; 不串成一个大脚本。改文件的步骤缺省 dry-run 只出 diff, 加 `--apply` 才落盘, 落盘前自动写 `.pre-room-<ts>.bak`, 并打印这一步的回退命令。
脚本位置: `cc-wecom-room/scripts/room-cutover/` (分支 room-model)。
前提: 新代码已在 room-model 分支上通过 typecheck、build 和单测 (检查点 2)。
执行顺序: 从上往下。出事时从出事那一步往回逆序回退 (先退当前步, 再退上一步)。

| # | 步骤 | 执行 | 验证 | 回退 |
|---|---|---|---|---|
| 0 | 停 daemon (svr 不停) | `launchctl kill TERM gui/$UID/com.wezard.daemon`。plist 是 KeepAlive.SuccessfulExit=false, 正常退出不会被拉起 | `launchctl list \| grep wezard.daemon` 显示 PID 为 `-` | `launchctl kickstart gui/$UID/com.wezard.daemon` |
| 1 | **备份** (放 repo 外, 也不放 ~/.wezard 内, 免得下次备份把它也打进去) | `mkdir -p ~/wezard-backups && TS=$(date +%Y%m%d-%H%M%S) && tar -czf ~/wezard-backups/pre-room-$TS.tgz -C ~/.wezard state wizards.json config.jsonc memory tasks` (state 约 228M, 磁盘余 14G) | `tar -tzf ~/wezard-backups/pre-room-$TS.tgz \| wc -l` 非 0; `df -h ~` 余量仍 > 10G | 不需要 (只读); 出事时整体还原 = 停 daemon → `tar -xzf … -C ~/.wezard` |
| 2 | config 删 topOnly / speech | `node scripts/room-cutover/config-strip.mjs` → 看 diff → `--apply` | dry-run 共 7 个键 (topOnly×3、speech×4) + 1 行注释; steward 绑定不动 | 按脚本打印的命令 `cp config.jsonc.pre-room-<ts>.bak config.jsonc` |
| 2a | **config 解析 dry-run** (只读, 不连 WS、不起 daemon) | `T=$(mktemp -d) && cp ~/.wezard/config.jsonc $T/c.jsonc && WEZARD_CONFIG=$T/c.jsonc node scripts/room-cutover/config-check.mjs` (缺省用 room 工作树的新 dist; 读副本, secrets.json 只读合并) | exit 0, 且输出「残留旧键 0」; 非 0 时打印 zod 问题清单 | 失败即停在这里: 按第 2 步回退命令还原 config, 线上其余一概未动 |
| 3 | wizards.json self 记忆 | `node scripts/room-cutover/wizard-memory.mjs` → 看 diff → `--apply` (**daemon 必须停着**) | dry-run 19 个身份、34 条: 15×2 句模板改写, 3 条旧回执口径删除, 1 条 read_chat → room_read; S2/S3 历史交付记录保留 | `--revert <patch.json>`: 只还原 memory 仍等于改后值的身份, 不覆盖新 daemon 回填的 uid; 整份兜底用 `.pre-room-<ts>.bak` |
| 4 | memory md + 定时任务 prompt | `node scripts/room-cutover/text-memory.mjs` → 看 diff → `--apply` | 4 个文件; 每条规则恰好命中一次, 否则整步中止, 一个字不写 | 按脚本逐文件打印的 `cp <bak> <file>` |
| 5 | 旧宪章归档 (**移走, 不删**) | `node scripts/room-cutover/charters-archive.mjs` → `--apply` | `state/charters/` 空; `state/archive/charters-<ts>/` 下 200 份 | `mv state/archive/charters-<ts>/*.md state/charters/` |
| 6 | 账本迁移 | `node dist/cli/migrate-rooms.js --dry-run` → 看报表 → 去掉 --dry-run 跑 | 报表计数对得上源 (未结路由 5、uncertain 103 归档、queued 3); 再跑一次写 0 行 | `mv ~/.wezard/rooms ~/.wezard/rooms.rejected-<ts>`。源文件迁移时一个字不改, 旧 daemon 也不读 rooms/ |
| 7 | 代码切到 room-model (细节见下节「第 7 步」) | 线上工作树 `cc-wecom` 在 v3 上: 先确认工作树干净 → `git tag pre-room cf3e0b3` → `git merge --ff-only room-model` → `npm run build` | `git status --porcelain` 前后都为空; `git log -1` = room-model 头; build 绿 | `git reset --keep pre-room && npm run build` |
| 7a | **config 解析 dry-run 复跑** (新 dist 已就位, 起 daemon 前最后一道) | 同 2a, 但第一个参数指线上 dist: `WEZARD_CONFIG=$T/c.jsonc node scripts/room-cutover/config-check.mjs ~/develop/Guxi11/cc-wecom/dist` (副本取自此刻的 ~/.wezard/config.jsonc) | exit 0 | 失败不起 daemon: 先退 7 (`git reset --keep pre-room && npm run build`), 再查 |
| 8 | 起 daemon + svr | `launchctl kickstart gui/$UID/com.wezard.daemon`; 前端资源有变, svr 也要 `launchctl kickstart -k gui/$UID/com.wezard.svr` | daemon.log 无 crash-loop; uid 回填条数 = 实例数; 每个绑定 pane 都标成待 /new | 从这一步起逆序回退: 8 → 7 → 6 → … |
| 9 | 旧会话换新工具面 | 不用手动做: daemon 启动时把每个绑定 pane 标为待 /new, 下次唤醒先 /new 再注入, 新会话由 armCharter 拿到新宪章。session-mcp*.json / session-hooks.json 指向的入口不变 (http /mcp 加 hook 路径), 由 daemon writeIfChanged 重写, 不用手改; 真正要换的是会话里缓存的 tools/list, 由 /new 解决 | 抽 1 个群发话: 首轮宪章里没有 tell_peer, 工具列表里有 room_*; 看门狗: 给一个正忙的测试 wizard 派一条 chat_ask 后 `tmux kill-pane` 掉它的 pane, staleMin (缺省 5 分钟) + 一个扫描周期内该 duty 出现 daemon 写的 canceled reply 并唤醒提问者 | 回到 7 后, 旧代码下的下一次 /new 拿回旧工具面 |

| 10 | 切换后清理 (稳定 7 天、未回退之后) | ① `rm ~/wezard-backups/pre-room-*.tgz` (只删第 1 步的切换前快照); ② 冻结的旧源 (~/.wezard/routes.jsonl 3.9M、state/members.json、state/chats/、state/message-events.json*、state/obligations.json、state/idle-nudges.json、state/strict-delivery-notices.json) **原样 mv 到 `~/.wezard/state/archive/pre-room-sources-<ts>/`, 不删、不压缩**: 同卷 rename, 不额外占盘, 逐字节不变; ③ `git branch -d room-model room-mig room-tools room-ui`, 删对应 worktree | `ls state/archive/pre-room-sources-<ts>/` 文件数 = 移动前; `df -h ~`; `git tag -l pre-room` 仍在 | ① 不可逆, 这就是要等满 7 天的原因; ② `mv state/archive/pre-room-sources-<ts>/* 原位` (回退到旧 daemon 前必须先做这一步); ③ 分支可从 tag 与 v3 历史重建 |

## 配置: 未知键与校验 (2026-11-19 实测)

- **结论: 删键只是清理, 漏删不会让新 daemon 起不来。**
  - `ConfigSchema` 及各子对象都是 zod 缺省 (strip): 未知键静默丢弃, 不报错。全仓 shared/daemon/cli/svr 没有 `.strict()`。
  - `ChatPolicy` 在 C 节 (fd4715b) 改成 `.passthrough()`: topOnly / speech 留在盘上会原样保留并被忽略, daemon boot 时 warn 一次 (daemon/index.ts 契约 §7 注释处), 不拒启动。passthrough 不校验值类型, 所以「值类型不对」的旧键同样不会炸。
- **真正会让 boot 失败的只有: 已知键的值不合法** (例如 `rooms.watchdog.intervalSec < 10`, 或手改出错的 steward / stewardBudget 类型)。这才是 2a / 7a 要拦的。
- 实测矩阵 (线上 config 副本, 不碰线上文件, 跑完核对线上 config 逐字节未变):

| 输入 | dist | 结果 |
|---|---|---|
| 原样 (7 个旧键: topOnly×3、speech×4) | 新 (room-model) | exit 0, 报「残留旧键 7」 |
| config-strip --apply 后 | 新 | exit 0, 残留 0 |
| config-strip --apply 后 | 旧 (cc-wecom v3, 回退方向) | exit 0 |
| 顶层 / wrc 下加未知键 | 新 | exit 0 (静默丢弃) |
| `rooms.watchdog.intervalSec: 5` | 新 | exit 1, `rooms.watchdog.intervalSec: Number must be greater than or equal to 10` |

- **回退注意**: 旧代码下 topOnly 省略 = 开 (现值全是 true, 删了等价); 但 speech 省略 = 运行时判定 (首见 strict / 存量 implicit), 线上 4 个显式 strict 群在旧代码下可能退成 implicit。所以**回退越过第 7 步时, 第 2 步必须一起退** (还原 config 备份), 不能只退代码。

## 第 7 步: 代码怎么接

- **当前分支关系** (2026-11-19 实测):
  - 线上 daemon 跑的是 `cc-wecom/dist`, 工作树在 **v3** (= origin/v3 = cf3e0b3, 2026-11-18 23:00)。
  - origin/main (7a910d3) 是 v3 的祖先, 落后 76 笔; 本地 main (1605062) 又落后 origin/main 2 笔。
  - room-model 从 cf3e0b3 分出, 子分支 (mig / tools / ui) 都以 `--no-ff` 合进 room-model。
- **怎么接**: 在 v3 上 `git merge --ff-only room-model`。
  - 不 squash: 保留子分支的合并结构, 出事时能 bisect 到是哪一路。
  - 不 reset: ff 失败就说明 v3 在此期间被推过。这时回 room 工作树执行 `git rebase origin/v3`, 重跑 typecheck / build / 单测, 再 ff。
  - 不在线上工作树里解冲突。
- **main 不在这一步动**: main → v3 是发版动作 (ff 即可, 两者是祖先关系), 由发版单独做。
- **room-model 留不留**: 切换后保留到第 10 步, 期间是回退时对照用的坐标; 第 10 步再删分支和 worktree。
- **origin 怎么对齐**:
  - 本步只改本地 v3, **不 push**。
  - 线上验收过 (第 9 步抽查通过) 且人点头后, 才 `git push origin v3` (ff 推送, 不 force)。
  - push 之前 origin/v3 一直停在 cf3e0b3, 天然就是回滚坐标。
- **别人的 WIP**: 共享工作树里可能正有人改着 daemon/index.ts。
  - 第 0 步之前先用 roster 查 cwd 在 cc-wecom 的 wizard, 通知它们冻结。daemon 停了它们的 MCP 就断了, 但 CLI 仍能改文件, 所以必须先通知。
  - 第 7 步要求 `git status --porcelain` **必须为空**:
    - 有任何改动就停下, 让改动的主人先提交到自己的分支或挪进自己的 worktree;
    - 不用 `git stash` / autostash (pop 会把别人的 WIP stage 进去, 本仓库踩过);
    - 不用 `reset --hard`。
  - 原因: ff 只会拒绝改动与它撞上的文件, 没撞上的 WIP 会被一起编进 dist, 悄悄上线。
- **回滚坐标** (写死):
  - 回到 **cf3e0b3** (tag `pre-room`, = origin/v3 在 2026-11-18 23:00 的头): `git reset --keep pre-room && npm run build`。
  - 用 `--keep` 而不用 `--hard`: 遇到本地改动会拒绝执行, 不会吞掉别人的 WIP。
  - 若已 push: `git revert -m 1` 不适用于 ff, 所以 push 后回滚改为在 v3 上 `git revert --no-edit pre-room..HEAD` 生成反向提交再推, 不 force-push。

## 磁盘与保留期

- **备份**: tar 放 `~/wezard-backups/`, 不在 repo 里, 也不在 ~/.wezard 里; 第 10 步删除。
- **旧源 (路由 / 成员 / chat-records / message-events)**: 第 10 步只移进 archive/, 不删。它们是旧模型下唯一的线上历史, 删不删至少等半年后另议。
- **room 账本保留期**: 消息历史**永久保留**, 不按时间回收、不压缩、不删。
  - 设计稿里的 7 天回收说的是 routes (路由账), room 模型里已经不存在这类东西。
  - dm / adhoc room 在成员都已结束后也不删, 只是不再增长。
- **为什么放得下**: 现有 24 个聊天的 chat-records 从 2026-11-13 到今天共 596K。
  - 按 room 模型「wizard 之间的往来也进账本」估 5–10 倍, 约 1–2 MB/天, 一年在 1G 以内。
  - 对照: 现在占盘大头是 daemon.log 386M。
- **护栏** (随 daemon 接线实现):
  - boot 和每天一次记录 rooms/ 的总大小;
  - 超过 1G 打 warn 并发一条 [wezard] 系统行给人。
  - 那时再决定要不要按 room 切段, 而不是按时间删。

## 有意不改的
- `memory/episodes/*.jsonl`、`memory/log/*.jsonl`: append-only 历史日志。
- `tasks/memory-steward.task.mjs.retired`: 已退役。
- wizards.json 里 S2/S3/P7 的历史交付记录。
- `~/.codebuddy/projects/*/memory` 下需删或改写的 21 处: 这些是各 CLI 自己的项目记忆, 不属于 wezard 状态。切换后由我按 grep 清单 §5 逐条处理, 同样先备份、后 diff。

## 跟代码一起改的 (不在本清单)
grep 清单 §1 (CLAUDE.md / CODEBUDDY / README / docs) 和 §6 (宪章、MCP 描述、tool-hints、reminder): 在 room-model 分支上提交, 第 7 步随代码生效, 第 7 步回退时一起回退。
## 改了什么 / 会打破什么 / 怎么退 (一页摘要)

**改了什么**
- 沟通层只剩一个原语: room 账本 (`~/.wezard/rooms/<id>.jsonl`, append-only)。人话、wizard 之间的往来、定时任务唤醒、系统行都是同一种 `msg` 行; 成员、游标、duty 都由按文件 fold 推出, 不再有第二份状态。
- 完成只有一个信号: `chat_reply` (holder 写 done / passed / canceled)。终句零语义 —— 只进 turn store / rolepage, 不投递、不关账。
- 唤醒由账本驱动: 一行的 `wake` 决定叫醒谁, pane 空闲时按 `seen` 游标补投未读; 投递队列不是事实来源, reload 不丢。
- 工具面: chat_say / chat_ask / chat_reply / notify / send_file + room_*(open/invite/join/approve/leave/members/transfer/read/watch); spawn / clone / delegate 加 `room?`; chat_ask / chat_say 加 `interrupt` (限 parent / host / 人)。
- 宪章与工具描述按新模型重写; 「严格模式」「顶层模式」「回执信封」概念整体退役。
- rolepage: 关系图改成 wizard ↔ room 二部图, 会话视图改按 room 读账本。

**会打破什么**
- **工具**: tell_peer、wait_peer 的回执语义、read_chat、chat_members、pending_items 的旧口径、tell_peer 的 return / public / fyi / priority 全部消失。旧会话缓存的 tools/list 会调到不存在的工具 → 靠第 9 步强制 /new 解决, 在 /new 之前的那一轮可能报「工具不存在」。
- **行首 `.name RESULT:` 不再有投递语义**: 写在终句里的 RESULT / NEED / PROGRESS 只是文字, 不会被当成回执送达; 没调 chat_reply 的 duty 当轮被提醒一次, 再不关就进 room 的系统行。
- **config**: `chatPolicy.<chat>.topOnly` / `speech` 被忽略并在 boot 打一行 warn (第 2 步已删, 不删也不拒启动)。
- **人侧命令**: `/owed`、`/strict`、`/chats` 下线。
- **HTTP**: `/peer`、`/peers/tell` 等旧路由删除, 外部脚本若直接打这两个口会 404; 新口是 `/room/*`。
- **数据**: routes.jsonl / members.json / state/chats / message-events / obligations / idle-nudges / strict-delivery-notices 冻结, 新 daemon 不读也不写; 切换后在旧源上发生的事 (无) 不会回流。
- **在飞的活**: 切换瞬间 5 条未结路由由迁移脚本转成 room 里的 msg (人话 → 原 owner 的 duty, wizard 之间 → dm room 的 task); 103 条 uncertain 只归档不迁。

**怎么退**
- 代码: 第 7 步回退 `git reset --keep pre-room && npm run build`, 再按第 8 步重起。
- 数据: 旧源一个字没改, 旧 daemon 照常读; rooms/ 旧 daemon 不读, 不用删 (要干净就 `mv rooms rooms.rejected-<ts>`)。
- 切换后新产生的 room 消息**不会**回写旧源: 退回去之后, 切换期间 room 里的往来在旧模型里看不到 (rolepage 旧视图也没有)。这是回退唯一的信息损失, 所以第 9 步的抽查要在切换后尽快做。
- 第 10 步之前任何时候都能退; 第 10 步只删切换前的 tar 快照, 旧源移进 archive/ 而不删, 退回前先 mv 回原位。

## 存量群切换后的行为变化

适用于切换时已存在的全部群 (含原 implicit 与原 strict), 不区分: 严格 / 宽松两档被一条规则取代。
- **一律变成「只有正式发言进群」**: wizard 的终句不再自动进群。原 implicit 群的人会第一次感到差异 —— 以前回复「自己冒出来」, 切换后由管家 (host) 用 chat_reply 交付; 没交付的话当轮被提醒, 再闲下来未交付就有一行 [wezard] 系统提示点名提问者。
- **原 strict 群的手感基本不变**, 但少掉三样: 义务提醒 (idle-nudge) 改为 duty 未关提醒; 每轮 ≤3 / 每分钟 ≤10 的出站额度改为 room 回合预算 (M=20 / 10 分钟, 超了 409 并写一条系统行); /owed 下线 (欠账看 rolepage 的 room 视图)。
- **wizard 之间的往来现在进群**: 绑定群 room 里 wizard 的 say / ask / task / reply 全部镜像进企微 (署作者名)。以前私聊派活人看不见, 切换后在群里开 room 内对话的会被看见; 只有落到 dm / adhoc room (无绑定) 的往来才只在 rolepage 可见。默认路径是「to 全是本群成员 → 留在本群」, 所以**管家在群里派给本群成员的活会出现在群里**。
- **成员**: 迁移时 join 顺序 = 绑定管家 (host) → members.json 按 since → 近 7 天在该群有轮次的 wizard。没被迁进来的 wizard 被人 `.name` 点名时自动入群 (via mention)。
- **管家**: host = 最早入群的 wizard, 读时求值; 管家手闸只看 role, 原 topOnly 条件删掉, 已有管家行为不变。
- **人点名 `.name`、斜杠命令、审批卡 / 提问卡**: 不变 (卡片绑到唤醒它的那个 room)。
- **定时任务**: 到点写一条 trigger 行唤醒, 不镜像进群; 任务里 wizard 的回复按普通规则 (要交付就 chat_reply / notify)。
- **第一句话**: 所有绑定 pane 在下次唤醒前先 /new, 所以每个群切换后的第一句话会多一个新会话开局 (宪章重读), 首次回复慢一拍。
