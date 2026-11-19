#!/usr/bin/env bash
# room 切换 · 第 0-8 步一次执行 (docs/room/cutover.md)。daemon 停着时 wezard 工具与审批都不可用,
# 所以整段由一次 Bash 调用跑完, 每步一行写进 $LOG; 任何一步红 → 按逆序回退到切换前并重启旧 daemon。
# 用法: scripts/room-cutover/run-cutover.sh <room-model 期望 HEAD>
#   只在人点头后执行。第 9 步 (观察 O1-O4) 不在本脚本内。
set -uo pipefail
EXPECT="${1:?需要 room-model 期望 HEAD}"
ROOM=${ROOM:-/Users/zyy/develop/Guxi11/cc-wecom-room}
LIVE=${LIVE:-/Users/zyy/develop/Guxi11/cc-wecom}   # 演练时用 LIVE=<临时 worktree> HOME=<临时目录> 覆盖
W=$HOME/.wezard
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p $HOME/wezard-backups
LOG=$HOME/wezard-backups/cutover-$TS.log
BAK=$HOME/wezard-backups/pre-room-$TS.tgz
MARK=$(mktemp /tmp/cutover-mark.XXXX)
DONE=()   # 已完成的步骤 (回退用)
say() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG"; }
step_ok() { DONE+=("$1"); say "step $1 | OK | $2"; }

rollback() {
  say "ROLLBACK 开始 (原因: $1); 已完成: ${DONE[*]:-无}"
  for ((i=${#DONE[@]}-1; i>=0; i--)); do
    case "${DONE[i]}" in
      8)  launchctl kill TERM gui/$UID/com.wezard.daemon; sleep 3; say "rb 8: 新 daemon 已停";;
      7b) rm -f "$W/state/rooms-cutover-new.flag"; say "rb 7b: 标记已删";;
      7)  (cd "$LIVE" && git reset -q --keep pre-room && npm run build >/dev/null 2>&1) && say "rb 7: 线上回到 pre-room 并重建" || say "rb 7: !!! 失败, 人工处理";;
      6)  [ -d "$W/rooms" ] && mv "$W/rooms" "$W/rooms.rejected-$TS"; say "rb 6: rooms/ → rooms.rejected-$TS";;
      2)  tar -xzf "$BAK" -C "$W" && say "rb 2-5: 从 $BAK 还原 state wizards.json config.jsonc memory tasks" || say "rb 2-5: !!! tar 还原失败, 人工处理";;
      0)  launchctl kickstart gui/$UID/com.wezard.daemon; launchctl kickstart -k gui/$UID/com.wezard.svr; say "rb 0: 旧 daemon + svr 已拉起";;
    esac
  done
  say "ROLLBACK 结束"; exit 1
}
need() { "$@" >>"$LOG" 2>&1 || rollback "命令失败: $*"; }

say "=== room 切换 $TS, 期望 room-model=$EXPECT, 日志 $LOG"
# 前置: 线上工作树干净且在 cf3e0b3, room-model 头对得上, 可 ff
[ -z "$(git -C "$LIVE" status --porcelain)" ] || { say "前置失败: 线上工作树不干净"; exit 1; }
[ "$(git -C "$LIVE" rev-parse --short HEAD)" = cf3e0b3 ] || { say "前置失败: 线上不在 cf3e0b3"; exit 1; }
[ "$(git -C "$ROOM" rev-parse --short room-model)" = "$EXPECT" ] || { say "前置失败: room-model 不是 $EXPECT"; exit 1; }
git -C "$LIVE" merge-base --is-ancestor HEAD room-model || { say "前置失败: 不能 ff"; exit 1; }
say "前置 OK: 线上干净@cf3e0b3, room-model=$EXPECT 可 ff"

# 0 停 daemon
touch "$MARK"
launchctl kill TERM gui/$UID/com.wezard.daemon
for i in $(seq 1 30); do launchctl list | grep -q '^-.*com.wezard.daemon' && break; sleep 1; done
launchctl list | grep -q '^-.*com.wezard.daemon' || { say "step 0 | 红 | 30s 内没停下"; launchctl kickstart gui/$UID/com.wezard.daemon; exit 1; }
step_ok 0 "daemon 已停 (svr 照跑); 下一步 1 备份"

# 1 备份
need tar -czf "$BAK" -C "$W" state wizards.json config.jsonc memory tasks
[ "$(tar -tzf "$BAK" | wc -l)" -gt 0 ] || rollback "备份为空"
step_ok 1 "$BAK ($(du -h "$BAK" | cut -f1)), 余 $(df -h ~ | awk 'NR==2{print $4}'); 下一步 2 config-strip"
DONE+=(2)   # 从这里起 rb 2 = 整体 tar 还原 (覆盖 2-5)

# 2 / 2a config
need node "$ROOM/scripts/room-cutover/config-strip.mjs" --apply
C=$(mktemp -d); cp "$W/config.jsonc" "$C/c.jsonc"
WEZARD_CONFIG="$C/c.jsonc" node "$ROOM/scripts/room-cutover/config-check.mjs" >>"$LOG" 2>&1 || rollback "2a config-check 非 0"
grep -q '残留旧键 0' "$LOG" || rollback "2a 残留旧键不为 0"
say "step 2/2a | OK | 旧键已删, 新 dist 解析 exit 0 残留 0; 下一步 3"

# 3 / 4 / 5
need node "$ROOM/scripts/room-cutover/wizard-memory.mjs" --apply
say "step 3 | OK | $(grep -o '共 [0-9]* 个身份、[0-9]* 条变更' "$LOG" | tail -1); 下一步 4"
if node "$ROOM/scripts/room-cutover/text-memory.mjs" --apply >>"$LOG" 2>&1; then say "step 4 | OK | 4 个文件"
else say "step 4 | 跳过 (非阻断: 记忆文本规则未命中, 切后手工改) | 下一步 5"; fi
need node "$ROOM/scripts/room-cutover/charters-archive.mjs" --apply
say "step 5 | OK | state/charters 剩 $(ls "$W/state/charters" 2>/dev/null | wc -l | tr -d ' ') 份; 下一步 6"

# 6 账本迁移
[ -e "$W/rooms" ] && rollback "6 前 rooms/ 已存在 (应已移走)"
need node "$ROOM/dist/cli/migrate-rooms.js"
DONE+=(6)
second=$(node "$ROOM/dist/cli/migrate-rooms.js" 2>&1 | tail -1); echo "$second" >>"$LOG"
echo "$second" | grep -q '写入 0 行' || rollback "6 第二次迁移不是 0 行: $second"
say "step 6 | OK | $(grep -E '^room [0-9]+ 个' "$LOG" | tail -1); 复跑写 0 行; 下一步 7"

# 7 代码 ff + 期间无人写线上工作树
dirty=$(git -C "$LIVE" status --porcelain; find "$LIVE" -newer "$MARK" -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' 2>/dev/null | head -5)
[ -z "$dirty" ] || rollback "7 前线上工作树在停机期间被写过: $dirty"
git -C "$LIVE" tag pre-room cf3e0b3 2>/dev/null || true
need git -C "$LIVE" merge --ff-only room-model
DONE+=(7)
(cd "$LIVE" && npm run build) >>"$LOG" 2>&1 || rollback "7 build 失败"
[ -z "$(git -C "$LIVE" status --porcelain)" ] || rollback "7 build 后工作树不干净"
say "step 7 | OK | 线上 $(git -C "$LIVE" log --oneline -1 | cut -c1-60), build 绿; 下一步 7a"

# 7a / 7b
cp "$W/config.jsonc" "$C/c2.jsonc"
WEZARD_CONFIG="$C/c2.jsonc" node "$ROOM/scripts/room-cutover/config-check.mjs" "$LIVE/dist" >>"$LOG" 2>&1 || rollback "7a 线上 dist config-check 非 0"
say "step 7a | OK | 线上 dist 解析 exit 0; 下一步 7b"
touch "$W/state/rooms-cutover-new.flag"; DONE+=(7b)
say "step 7b | OK | /new 标记已放; 下一步 8"

# 8 起 daemon + svr
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
launchctl kickstart gui/$UID/com.wezard.daemon; DONE+=(8)
launchctl kickstart -k gui/$UID/com.wezard.svr
up=0; for i in $(seq 1 60); do curl -s --noproxy '*' -m 2 http://127.0.0.1:17890/healthz >/dev/null && { up=1; break; }; sleep 1; done
[ $up = 1 ] || rollback "8 daemon 60s 内 healthz 不通"
p1=$(launchctl list | awk '/com.wezard.daemon/{print $1}'); sleep 20; p2=$(launchctl list | awk '/com.wezard.daemon/{print $1}')
[ "$p1" = "$p2" ] && [ "$p1" != "-" ] || rollback "8 daemon 20s 内重启过 ($p1→$p2), crash-loop"
say "step 8 | OK | daemon pid $p2 稳定 20s, T0=$T0; status: $(curl -s --noproxy '*' http://127.0.0.1:17890/status | head -c 300)"
say "=== 0-8 完成。T0=${T0}。下一步 9: observe.mjs 取 O1-O4 (T0+5min / T0+30min)"
