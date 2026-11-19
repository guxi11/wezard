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
| 3 | wizards.json self 记忆 | `node scripts/room-cutover/wizard-memory.mjs` → 看 diff → `--apply` (**daemon 必须停着**) | dry-run 19 个身份、34 条: 15×2 句模板改写, 3 条旧回执口径删除, 1 条 read_chat → room_read; S2/S3 历史交付记录保留 | `--revert <patch.json>`: 只还原 memory 仍等于改后值的身份, 不覆盖新 daemon 回填的 uid; 整份兜底用 `.pre-room-<ts>.bak` |
| 4 | memory md + 定时任务 prompt | `node scripts/room-cutover/text-memory.mjs` → 看 diff → `--apply` | 4 个文件; 每条规则恰好命中一次, 否则整步中止, 一个字不写 | 按脚本逐文件打印的 `cp <bak> <file>` |
| 5 | 旧宪章归档 (**移走, 不删**) | `node scripts/room-cutover/charters-archive.mjs` → `--apply` | `state/charters/` 空; `state/archive/charters-<ts>/` 下 200 份 | `mv state/archive/charters-<ts>/*.md state/charters/` |
| 6 | 账本迁移 | `node dist/cli/migrate-rooms.js --dry-run` → 看报表 → 去掉 --dry-run 跑 | 报表计数对得上源 (未结路由 5、uncertain 103 归档、queued 3); 再跑一次写 0 行 | `mv ~/.wezard/rooms ~/.wezard/rooms.rejected-<ts>`。源文件迁移时一个字不改, 旧 daemon 也不读 rooms/ |
| 7 | 代码切到 room-model (细节见下节「第 7 步」) | 线上工作树 `cc-wecom` 在 v3 上: 先确认工作树干净 → `git tag pre-room cf3e0b3` → `git merge --ff-only room-model` → `npm run build` | `git status --porcelain` 前后都为空; `git log -1` = room-model 头; build 绿 | `git reset --keep pre-room && npm run build` |
| 8 | 起 daemon + svr | `launchctl kickstart gui/$UID/com.wezard.daemon`; 前端资源有变, svr 也要 `launchctl kickstart -k gui/$UID/com.wezard.svr` | daemon.log 无 crash-loop; uid 回填条数 = 实例数; 每个绑定 pane 都标成待 /new | 从这一步起逆序回退: 8 → 7 → 6 → … |
| 9 | 旧会话换新工具面 | 不用手动做: daemon 启动时把每个绑定 pane 标为待 /new, 下次唤醒先 /new 再注入, 新会话由 armCharter 拿到新宪章。session-mcp*.json / session-hooks.json 指向的入口不变 (http /mcp 加 hook 路径), 由 daemon writeIfChanged 重写, 不用手改; 真正要换的是会话里缓存的 tools/list, 由 /new 解决 | 抽 1 个群发话: 首轮宪章里没有 tell_peer, 工具列表里有 room_* | 回到 7 后, 旧代码下的下一次 /new 拿回旧工具面 |

| 10 | 切换后清理 (稳定 7 天、未回退之后) | `rm ~/wezard-backups/pre-room-*.tgz`; 冻结的旧源 (routes.jsonl 3.9M、state/members.json、state/chats/、message-events.json*) 打成一个 tgz 放 ~/wezard-backups/ 后删原文件; `git branch -d room-model room-mig room-tools room-ui`, 删对应 worktree | `df -h ~` 余量回升; `git tag -l pre-room` 仍在 | tgz 删除不可逆, 所以要等满 7 天; 仍保留 tag pre-room 与 state/archive/ 里的旧宪章 |

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