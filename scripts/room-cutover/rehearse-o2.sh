#!/usr/bin/env bash
# O2 演练 (2026-11-19 切换失败复盘): 真跑 cutover 第 6-8 步 (迁移 → 起 daemon → 读账本)。
# 起的是真的新 daemon —— 临时 HOME + 临时端口 + 假 bot 凭据 + 隔离 tmux (TMUX_TMPDIR),
# 全程不碰真实 ~/.wezard; 凭据是假的, WS 认证失败不影响 HTTP 面与 room 账本 (healthz 在
# startHttp 即通, ws.ready 只挡最后的 ready log)。
# 同一把 o2-gate.sh 验两种情况:
#   A 目录对: 新迁移代码写 <stateDir>/rooms, daemon 读同一处 → O2 绿 (mem == disk, disk >= 1)
#   B 目录错: 迁移后把账本挪到 <home>/rooms (11-19 事故的落点), daemon 读 <stateDir>/rooms
#             (空) → O2 红, 报两个数 (mem=0, disk=N) —— 复刻事故形状 (当时 1 vs 17)
# 用法: scripts/room-cutover/rehearse-o2.sh [room 工作树]   exit 0 = 两种情况都按预期
set -uo pipefail
ROOM=${1:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -f "$ROOM/dist/daemon/index.js" ] || { echo "先 npm run build: $ROOM/dist/daemon/index.js 不存在"; exit 1; }
[ -f "$ROOM/dist/cli/migrate-rooms.js" ] || { echo "先 npm run build: $ROOM/dist/cli/migrate-rooms.js 不存在"; exit 1; }
PORT_A=${PORT_A:-27931}
PORT_B=${PORT_B:-27932}
T=$(mktemp -d /tmp/o2-rehearse-XXXXXX)
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$T/rehearse.log"; }
fail() { say "演练失败: $*"; say "现场保留在 $T"; exit 1; }
say "O2 演练: room=$ROOM, 临时 HOME=$T, 端口 $PORT_A/$PORT_B, 不碰真实 ~/.wezard"

# 夹具: 旧模型源 (wizards.json / routes.jsonl / state/...) —— 一条未结 wizard 路由 + 一条 queued
# peer 事件 → 迁移后 dm room 里 2 条 task msg = 2 个未结 duty (chat 路由的 msg 不开 duty)。
fixture() { # $1 = <home>/.wezard
  env HOME=/nonexistent node - "$1" <<'FIXEOF'
const fs = require("fs");
const path = require("path");
const root = process.argv[2];
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const WR_A = "chat:wrA";
const now = Date.now();
w(path.join(root, "wizards.json"), JSON.stringify({
  [WR_A]: { target: WR_A, name: "Alice", description: "", bornAt: 1000, memory: [] },
  "chat:wrA#bob": { target: "chat:wrA#bob", name: "Bob", description: "", bornAt: 2000, memory: [] },
}, null, 2));
w(path.join(root, "routes.jsonl"), [
  { op: "open", at: 5000, event: "e2", owner: "chat:wrA#bob", receiver: { kind: "wizard", to: WR_A, event: "h2" }, deadlineAt: 0 },
].map(JSON.stringify).join("\n") + "\n");
w(path.join(root, "state", "members.json"), JSON.stringify({
  [WR_A + "|chat:wrA#bob"]: { mode: "speaker", since: 1500, by: "human:u1", cursor: 2 },
}, null, 2));
w(path.join(root, "state", "chats", encodeURIComponent(WR_A) + ".jsonl"), [
  { chat: WR_A, seq: 1, at: 1000, id: "m1", author: "u1", kind: "human", text: "早" },
  { chat: WR_A, seq: 2, at: 2000, id: "m2", author: "bob", kind: "wizard", text: "在" },
].map(JSON.stringify).join("\n") + "\n");
w(path.join(root, "state", "details.jsonl"), [
  { kind: "turn", id: "t1", target: "chat:wrA#bob", channel: WR_A, createdAt: now - 3600_000, items: [] },
].map(JSON.stringify).join("\n") + "\n");
w(path.join(root, "state", "message-events.json"), JSON.stringify({
  h2: { id: "h2", target: "chat:wrA#bob", channel: WR_A, speaker: "user:u9", execution: "open", exposure: "consumed", payload: { text: "帮我看看" } },
  q2: { id: "q2", target: "chat:wrA#bob", execution: "queued", exposure: "none", payload: { text: "去干这个", peer: { from: { from: WR_A } } } },
}, null, 2));
FIXEOF
}

# 起 daemon (env 隔离: 去 WEZARD_CONFIG/TMUX, HOME/TMUX_TMPDIR 指进本例), 回 PID。
start_daemon() { # $1 = home  $2 = port
  env -u WEZARD_CONFIG -u TMUX HOME="$1" TMUX_TMPDIR="$1/tmux" \
    node "$ROOM/dist/daemon/index.js" >>"$1/daemon-stdout.log" 2>&1 &
  echo $!
}
stop_daemon() { # $1 = pid  $2 = home
  kill -TERM "$1" 2>/dev/null
  for i in $(seq 1 15); do kill -0 "$1" 2>/dev/null || break; sleep 1; done
  kill -KILL "$1" 2>/dev/null || true
  env HOME="$2" TMUX_TMPDIR="$2/tmux" tmux kill-server 2>/dev/null || true
}
wait_healthz() { # $1 = port
  up=0
  for i in $(seq 1 60); do curl -s --noproxy '*' -m 2 "http://127.0.0.1:$1/healthz" >/dev/null && { up=1; break; }; sleep 1; done
  [ "$up" = 1 ]
}
# o2-gate 输出行里「(」之前的数字 = [内存, 账本重放]。
o2_nums() { echo "$1" | cut -d'(' -f1 | grep -oE '[0-9]+'; }
mig_rooms() { echo "$1" | sed -n 's/^写入 [0-9]* 行 → //p'; }
setup_case() { # $1 = home  $2 = port
  mkdir -p "$1/.wezard"
  fixture "$1/.wezard"
  printf '{"daemon":{"port":%s}}' "$2" >"$1/.wezard/config.jsonc"
  printf '{"bot":{"botId":"wrkO2REHEARSALFAKE","secret":"fake-secret-for-o2-rehearsal"}}' >"$1/.wezard/secrets.json"
}

# ── A 目录对 ─────────────────────────────────────────────────────────────
A=$T/home-a
setup_case "$A" "$PORT_A"
migA=$(env -u WEZARD_CONFIG HOME="$A" node "$ROOM/dist/cli/migrate-rooms.js" 2>&1) || fail "A 迁移失败: $migA"
say "A 迁移: $(echo "$migA" | tail -1)"
MIG_ROOMS_A=$(mig_rooms "$migA")
[ -n "$MIG_ROOMS_A" ] || fail "A 迁移输出没有写入目录: $migA"
[ -d "$MIG_ROOMS_A" ] || fail "A 迁移报的写入目录不存在: $MIG_ROOMS_A"
[ "$(cd "$MIG_ROOMS_A" && pwd)" = "$(cd "$A/.wezard/state/rooms" && pwd)" ] || fail "A 迁移目录不在 stateDir 下: $MIG_ROOMS_A"
[ ! -e "$A/.wezard/rooms" ] || fail "A 不该有 <home>/rooms (旧 bug 落点): $A/.wezard/rooms"
say "A 目录核对: 写入目录 == daemon 读取目录 == $MIG_ROOMS_A, <home>/rooms 不存在"
DPID_A=$(start_daemon "$A" "$PORT_A")
wait_healthz "$PORT_A" || fail "A daemon 60s 内 healthz 不通 (看 $A/daemon-stdout.log)"
say "A daemon 起来 (pid $DPID_A, 端口 $PORT_A), 跑 o2-gate"
o2A=$(env HOME="$A" "$ROOM/scripts/room-cutover/o2-gate.sh" "http://127.0.0.1:$PORT_A/status" "$MIG_ROOMS_A" 2>>"$T/rehearse.log")
rcA=$?
say "A o2-gate: $o2A"
[ "$rcA" = 0 ] || fail "A (目录对) O2 闸应绿却红了: $o2A"
diskA=$(o2_nums "$o2A" | sed -n 2p)
[ -n "$diskA" ] && [ "$diskA" -ge 1 ] || fail "A 账本重放数应 >=1 (夹具有一件未结), 拿到: $diskA"
stop_daemon "$DPID_A" "$A"
say "A 完成: O2 绿, 内存 == 账本重放 == $diskA"

# ── B 目录错 (复刻 11-19 事故形状) ────────────────────────────────────────
B=$T/home-b
setup_case "$B" "$PORT_B"
migB=$(env -u WEZARD_CONFIG HOME="$B" node "$ROOM/dist/cli/migrate-rooms.js" 2>&1) || fail "B 迁移失败: $migB"
MIG_ROOMS_B=$(mig_rooms "$migB")
[ -n "$MIG_ROOMS_B" ] || fail "B 迁移输出没有写入目录: $migB"
# 老代码把账本写在 <home>/rooms, daemon 读 <stateDir>/rooms —— 迁移完把账本挪过去,
# 「迁移报告的写入目录」也按老代码口径记成 <home>/rooms。
mv "$MIG_ROOMS_B" "$B/.wezard/rooms" || fail "B 挪账本失败"
say "B 已复刻目录错: 账本在 $B/.wezard/rooms, daemon 读 $B/.wezard/state/rooms (空)"
DPID_B=$(start_daemon "$B" "$PORT_B")
wait_healthz "$PORT_B" || fail "B daemon 60s 内 healthz 不通 (看 $B/daemon-stdout.log)"
say "B daemon 起来 (pid $DPID_B, 端口 $PORT_B), 跑 o2-gate"
o2B=$(env HOME="$B" "$ROOM/scripts/room-cutover/o2-gate.sh" "http://127.0.0.1:$PORT_B/status" "$B/.wezard/rooms" 2>>"$T/rehearse.log")
rcB=$?
say "B o2-gate: $o2B"
[ "$rcB" != 0 ] || fail "B (目录错) O2 闸应红却绿了: $o2B"
memB=$(o2_nums "$o2B" | sed -n 1p)
diskB=$(o2_nums "$o2B" | sed -n 2p)
[ "${memB:-x}" = 0 ] || fail "B 内存数应为 0 (daemon 起来账本为空), 拿到: $memB"
[ "${diskB:-x}" = "$diskA" ] || fail "B 账本重放数应等于夹件数 $diskA, 拿到: $diskB"
stop_daemon "$DPID_B" "$B"
say "B 完成: O2 红, 内存 $memB != 账本重放 $diskB (与 A 的绿互为镜像)"

say "演练达标: 目录对 → O2 绿 (mem == 重放 == $diskA); 目录错 → O2 红 (mem $memB != 重放 $diskB), 两个数都报了"
say "现场保留在 $T (daemon 日志在 $T/home-*/daemon.log)"
