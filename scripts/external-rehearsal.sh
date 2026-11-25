#!/usr/bin/env bash
# 外部 agent (CoC) 接入第 1 步的真 daemon 演练 (docs/evolve/external-gateway.md「真 daemon 演练」)。
#
# 隔离: 临时 HOME + 临时 WEZARD_CONFIG + 临时 stateDir (两个都改 —— 只改后者会读到真 secrets
# 并踢掉生产企微连接), 假 bot 凭据 (WS 认证失败不影响控制面), 控制面 socket / 视图口都在临时目录。
# 接待 wizard 用名册里登记、没有活 pane 的条目; 它的交代用 /room/reply 以它的 target 身份模拟。
#
# 覆盖七项: ① ask → 交代 → wait answered → inbox → ack 后空 ② need → 带 re 续问
# ③ daemon 停机期间写下的交代, 重启后 wait / inbox 拿得到 ④ 10 分钟内重复同一正文返回同一个 req
# ⑤ cancel 后迟到的交代仍是 canceled 且不进 inbox ⑥ 三种额度超限都 429 ⑦ TCP 视图口打 /external/* 得 410
set -uo pipefail

ROOM=''
if [ "$#" -ge 1 ]; then ROOM="$1"; fi
[ -n "$ROOM" ] || ROOM=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$ROOM/dist/daemon/index.js" ] || { echo "先 npm run build: $ROOM/dist/daemon/index.js 不存在"; exit 1; }
[ -f "$ROOM/dist/cli/ext.js" ] || { echo "先 npm run build: $ROOM/dist/cli/ext.js 不存在"; exit 1; }

PORT=27951
KEEP=0
T=$(mktemp -d /tmp/ext-rehearsal-XXXXXX)
H="$T/home"
STATE="$H/.wezard/state"
CFG="$H/.wezard/config.jsonc"
SOCK="$T/d.sock"
TARGET='chat:wrReception#recv'
UID_W='w0123456789ab'
NOTIFY_TEXT='停机期间做完了'

PASS=0
FAIL=0
DPID=''
say()  { echo "[$(date +%H:%M:%S)] $*" | tee -a "$T/rehearse.log"; }
pass() { PASS=$((PASS + 1)); echo "PASS  $*" | tee -a "$T/rehearse.log"; }
bad()  { FAIL=$((FAIL + 1)); echo "FAIL  $*" | tee -a "$T/rehearse.log"; }
check() { if [ "$1" = "$2" ]; then pass "$3 ($1)"; else bad "$3 (期望 [$2], 实际 [$1])"; fi; }

stop_daemon() {
  [ -n "$DPID" ] || return 0
  kill "$DPID" 2>/dev/null
  for _ in $(seq 1 100); do kill -0 "$DPID" 2>/dev/null || break; sleep 0.2; done
  kill -9 "$DPID" 2>/dev/null
  wait "$DPID" 2>/dev/null
  DPID=''
}
cleanup() {
  stop_daemon
  if [ "$KEEP" = "1" ]; then echo "现场保留: $T"; else rm -rf "$T"; fi
}
trap cleanup EXIT

mkdir -p "$H/.wezard" "$STATE" "$T/workspace"

cat >"$CFG" <<EOF
{
  "bot": { "botId": "rehearsal-bot", "secret": "rehearsal-secret" },
  "daemon": {
    "stateDir": "$STATE",
    "socket": "$SOCK",
    "logFile": "$T/daemon.log",
    "logLevel": "info",
    "host": "127.0.0.1",
    "port": $PORT,
    "portSpan": 2
  },
  "wrc": { "allowFrom": [], "cwd": "$T/workspace" },
  "external": {
    "enabled": true,
    "principals": [
      { "name": "CoC",  "reception": "recv", "owner": "T1", "enabled": true, "perMinute": 10,  "perDay": 50,  "maxOpen": 5 },
      { "name": "Tiny", "reception": "recv", "enabled": true, "perMinute": 1,   "perDay": 50,  "maxOpen": 5 },
      { "name": "Few",  "reception": "recv", "enabled": true, "perMinute": 100, "perDay": 100, "maxOpen": 1 },
      { "name": "Day",  "reception": "recv", "enabled": true, "perMinute": 100, "perDay": 1,   "maxOpen": 100 }
    ]
  }
}
EOF

cat >"$H/.wezard/wizards.json" <<EOF
{
  "$TARGET": {
    "target": "$TARGET",
    "uid": "$UID_W",
    "name": "recv",
    "description": "演练用接待 wizard (登记在名册, 没有活 pane)",
    "kind": "worker",
    "bornAt": 1700000000000,
    "memory": []
  }
}
EOF

sock()      { curl -sS --noproxy '*' --unix-socket "$SOCK" -m 30 "$@"; }
sock_post() { curl -sS --noproxy '*' --unix-socket "$SOCK" -m 30 -X POST -H 'content-type: application/json' -d "$2" "http://wezard$1"; }
# 默认以 CoC 身份调用 (配置里启用着多个调用方, CLI 不会替我们挑); 要换身份就在子命令后再写 --as <名字>。
ext()       { local c="$1"; shift; HOME="$H" WEZARD_CONFIG="$CFG" WEZARD_DAEMON_SOCK="$SOCK" node "$ROOM/dist/cli/ext.js" "$c" --as CoC "$@"; }

jget() {
  node -e '
let d = "";
process.stdin.on("data", (c) => (d += c)).on("end", () => {
  try {
    const j = JSON.parse(d);
    let v = j;
    for (const k of process.argv[1].split(".")) v = v == null ? undefined : (/^\d+$/.test(k) ? v[Number(k)] : v[k]);
    process.stdout.write(typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));
  } catch { process.stdout.write(""); }
});' "$1"
}

start_daemon() {
  env -u TMUX -u TMUX_PANE -u WEZARD_DAEMON_SOCK -u WEZARD_STATE_DIR \
    HOME="$H" WEZARD_CONFIG="$CFG" node "$ROOM/dist/daemon/index.js" >>"$T/daemon.stdout.log" 2>&1 &
  DPID=$!
  for _ in $(seq 1 300); do
    if sock -o /dev/null -f "http://wezard/healthz" 2>/dev/null; then return 0; fi
    kill -0 "$DPID" 2>/dev/null || break
    sleep 0.2
  done
  echo "daemon 起不来 (pid $DPID); 尾部日志:"; tail -30 "$T/daemon.stdout.log"
  return 1
}

reply() { # $1 = req, $2 = status, $3 = text
  node -e 'process.stdout.write(JSON.stringify({ target: process.argv[1], re: [process.argv[2]], status: process.argv[3], text: process.argv[4] }))' \
    "$TARGET" "$1" "$2" "$3" >"$T/reply.json"
  sock_post /room/reply "$(cat "$T/reply.json")"
}

say "外部接入演练: repo=$ROOM, 临时 HOME=$H, socket=$SOCK, 视图口 $PORT (不碰真实 ~/.wezard)"

start_daemon || { bad "daemon 启动"; exit 1; }
pass "daemon 起来 (pid $DPID), 控制面可用"

# ── ① ask → 模拟交代 → wait answered → inbox → ack 后 inbox 空 ──────────────────
r1=$(ext ask "第一件: 回一句就好")
req1=$(printf '%s' "$r1" | jget req)
check "$(printf '%s' "$r1" | jget state)" "open" "① 新请求是 open"
check "$(printf '%s' "$r1" | jget ok)" "true" "① ask 回包 ok"

rep1=$(reply "$req1" done "第一件做完了")
check "$(printf '%s' "$rep1" | jget ok)" "true" "① 接待 wizard 的交代落行"

w1=$(ext wait "$req1" --timeout 10)
check "$(printf '%s' "$w1" | jget state)" "answered" "① wait 拿到 answered"
check "$(printf '%s' "$w1" | jget answer)" "第一件做完了" "① answer 是关账行正文"

i1=$(ext inbox)
check "$(printf '%s' "$i1" | jget length)" "1" "① inbox 有这一条"
check "$(printf '%s' "$i1" | jget 0.req)" "$req1" "① inbox 的 req 对得上"
check "$(printf '%s' "$i1" | jget 0.state)" "answered" "① inbox 的 state 是 answered"

a1=$(ext ack "$req1")
check "$(printf '%s' "$a1" | jget acked.0)" "$req1" "① ack 回 acked"
check "$(printf '%s' "$(ext inbox)" | jget length)" "0" "① ack 之后 inbox 为空"

# ask --wait: wait>0 时同 /wait 语义 (没人交代就等到上限, 回 open + waitedMs)
wt=$(ext ask --wait 1 "等一秒的那句")
check "$(printf '%s' "$wt" | jget state)" "open" "① ask --wait 没人交代时回 open"
node -e 'process.exit(Number(process.argv[1]) >= 900 ? 0 : 1)' "$(printf '%s' "$wt" | jget waitedMs)"   && pass "① ask --wait 真的等了 (waitedMs >= 900)" || bad "① ask --wait 没等: waitedMs=$(printf '%s' "$wt" | jget waitedMs)"

# ── ② need → 带 re 续问 ────────────────────────────────────────────────────
r2=$(ext ask "第二件: 要看机器名")
req2=$(printf '%s' "$r2" | jget req)
reply "$req2" need "哪台机器?" >/dev/null
w2=$(ext wait "$req2" --timeout 10)
check "$(printf '%s' "$w2" | jget state)" "need" "② wait 拿到 need"
check "$(printf '%s' "$w2" | jget answer)" "哪台机器?" "② need 的 answer 是反问正文"

a2=$(ext ask --re "$req2" "在 build-01 上")
req2b=$(printf '%s' "$a2" | jget req)
if [ -n "$req2b" ] && [ "$req2b" != "$req2" ]; then pass "② 续问是新的 req ($req2b)"; else bad "② 续问应当是新 req (旧 $req2, 新 $req2b)"; fi
reply "$req2b" done "好, 在 build-01 上做完了" >/dev/null
w2b=$(ext wait "$req2b" --timeout 10)
check "$(printf '%s' "$w2b" | jget state)" "answered" "② 续问拿到 answered"
check "$(printf '%s' "$(ext wait "$req2" --timeout 1)" | jget state)" "need" "② 旧请求维持 need 不动"

# ── ③ daemon 停机期间写下的交代: 重启后 wait / inbox 拿得到 ────────────────────
r3=$(ext ask "第三件: 停机期间交代")
req3=$(printf '%s' "$r3" | jget req)
room3=$(node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
const ops = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
const hit = ops.filter((o) => o && o.op === "ask" && o.req === process.argv[2]).pop();
process.stdout.write(hit ? hit.room : "");' "$STATE/external/requests.jsonl" "$req3")
if [ -n "$room3" ]; then pass "③ 索引里有这条请求的 room ($room3)"; else bad "③ 索引里没有 $req3 的 room"; fi

stop_daemon
pass "③ daemon 已停 (pid 清空)"

node --input-type=module -e '
const [root, stateDir, room, req, uid, text] = process.argv.slice(1);
const { openRoomStore } = await import(root + "/dist/daemon/rooms.js");
const { dutyKey, msgIdOf } = await import(root + "/dist/shared/room.js");
const store = openRoomStore(stateDir + "/rooms");
const st = store.get(room);
const seq = (st?.seq ?? 0) + 1;
store.append(room, [{
  op: "msg", at: Date.now(), room, id: msgIdOf(room, seq), seq,
  author: { kind: "wizard", id: uid }, ord: 1, speak: "member", kind: "reply", status: "done",
  re: [req], closes: [dutyKey(req, "wizard:" + uid)], text, wake: [], origin: "tool",
}]);
process.stdout.write("written");
' "$ROOM" "$STATE" "$room3" "$req3" "$UID_W" "$NOTIFY_TEXT" >"$T/offline.out" 2>"$T/offline.err"
check "$(cat "$T/offline.out")" "written" "③ 停机期间直接把交代写进账本"
if [ -s "$T/offline.err" ]; then echo "  (offline stderr: $(cat "$T/offline.err"))"; fi

start_daemon || { bad "33 daemon 重启"; exit 1; }
pass "③ daemon 重启 (pid $DPID)"
w3=$(ext wait "$req3" --timeout 10)
check "$(printf '%s' "$w3" | jget state)" "answered" "③ 重启后 wait 拿到 answered"
check "$(printf '%s' "$w3" | jget answer)" "$NOTIFY_TEXT" "③ 重启后 answer 是停机期间写下的那句"
check "$(printf '%s' "$(ext inbox --all)" | jget 0.req)" "$req1" "③ --all 也含已送达的旧请求"

# ── ④ 10 分钟内重复同一正文返回同一个 req ─────────────────────────────────────
d1=$(ext ask "重复的那一句")
d2=$(ext ask "重复的那一句")
check "$(printf '%s' "$d2" | jget req)" "$(printf '%s' "$d1" | jget req)" "④ 同一正文 10 分钟内返回同一个 req"
reply "$(printf '%s' "$d1" | jget req)" done "重复的那句也做完了" >/dev/null

# ── ⑤ cancel 后迟到的交代: 仍 canceled, 不进 inbox ────────────────────────────
r5=$(ext ask "第五件: 会撤回的那件")
req5=$(printf '%s' "$r5" | jget req)
c5=$(ext cancel "$req5")
check "$(printf '%s' "$c5" | jget state)" "canceled" "⑤ cancel 回 canceled"
reply "$req5" done "迟到的交代" >/dev/null
check "$(printf '%s' "$(ext wait "$req5" --timeout 2)" | jget state)" "canceled" "⑤ 迟到的交代之后仍是 canceled"
i5=$(ext inbox --all)
node -e '
const arr = JSON.parse(process.argv[1]); const hit = (Array.isArray(arr) ? arr : []).find((x) => x.req === process.argv[2]);
process.stdout.write(hit ? hit.state : "absent");' "$i5" "$req5" >"$T/i5.txt"
check "$(cat "$T/i5.txt")" "canceled" "⑤ --all 里它是 canceled"

# ── ⑥ 三种额度超限都是 429 ──────────────────────────────────────────────────
t1=$(ext ask --as Tiny "tiny 第一句")
check "$(printf '%s' "$t1" | jget state)" "open" "⑥ Tiny 第一句放行"
ext ask --as Tiny "tiny 第二句" >"$T/tiny.out" 2>"$T/tiny.err"
check "$?" "1" "⑥ 每分钟额度超了退非 0"
if grep -q "429" "$T/tiny.err"; then pass "⑥ 每分钟额度: stderr 写明 429"; else bad "⑥ 每分钟额度没有 429: $(cat "$T/tiny.err")"; fi

f1=$(ext ask --as Few "few 第一件")
check "$(printf '%s' "$f1" | jget state)" "open" "⑥ Few 第一件放行"
ext ask --as Few "few 第二件" >"$T/few.out" 2>"$T/few.err"
check "$?" "1" "⑥ 未结额度超了退非 0"
if grep -q "429" "$T/few.err"; then pass "⑥ 未结额度: stderr 写明 429"; else bad "⑥ 未结额度没有 429: $(cat "$T/few.err")"; fi

y1=$(ext ask --as Day "day 第一句")
check "$(printf '%s' "$y1" | jget state)" "open" "⑥ Day 第一句放行"
ext ask --as Day "day 第二句" >"$T/day.out" 2>"$T/day.err"
check "$?" "1" "⑥ 每日额度超了退非 0"
if grep -q "429" "$T/day.err"; then pass "⑥ 每日额度: stderr 写明 429"; else bad "⑥ 每日额度没有 429: $(cat "$T/day.err")"; fi

# ── ⑦ TCP 视图口打 /external/* 得 410 ───────────────────────────────────────
VPORT=$(node -e '
const fs = require("fs");
try { const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(j.view?.port ?? "")); } catch { process.stdout.write(""); }' "$STATE/run/ports.json")
if [ -n "$VPORT" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -m 5 -X POST -H 'content-type: application/json' \
    -d '{"text":"x"}' "http://127.0.0.1:$VPORT/external/ask")
  check "$code" "410" "⑦ 视图口 (:$VPORT) /external/ask 得 410"
else
  bad "⑦ 读不到视图口 (ports.json), 没法验 410"
fi

echo "-----"
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASS ($PASS 项)"
  exit 0
fi
echo "FAILED: $FAIL 项 (PASS $PASS 项); 现场 $T"
exit 1
