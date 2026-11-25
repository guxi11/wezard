#!/usr/bin/env bash
# 外部 agent (CoC) 接入第 1 步的真 daemon 演练 (docs/evolve/external-gateway.md「真 daemon 演练」)。
#
# 隔离: 临时 HOME + 临时 WEZARD_CONFIG + 临时 stateDir (两个都改 —— 只改后者会读到真 secrets
# 并踢掉生产企微连接), 假 bot 凭据 (WS 认证失败不影响控制面), 控制面 socket / 视图口都在临时目录。
# 接待 wizard 用名册里登记、没有活 pane 的条目; 它的交代用 /room/reply 以它的 target 身份模拟。
#
# 覆盖: ① ask → 交代 → wait answered → inbox → ack 后空 ② need → 带 re 续问
# ③ daemon 停机期间写下的交代, 重启后 wait / inbox 拿得到 ④ 10 分钟内重复同一正文返回同一个 req
# ⑤ cancel 后迟到的交代仍是 canceled 且不进 inbox ⑥ 三种额度超限都 429 ⑦ TCP 视图口打 /external/* 得 410
# ⑧ 口令轮换过 daemon 口令闸 + 旧口令立即失效
# ⑨ (第 2 步) 接待 wizard 往绑定 room 发话 / 改配置被拒, 在自己的 adhoc room 放行; 出口 answer 抹掉 daemon-token
# ⑩ (第 2 步) 逾期升级行落 owner room ⑪ (第 2 步) 额度告警只发一次 + ext status
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
  # ⑫ 的接待 wizard 冷启动会真的起 tmux; 演练用 TMUX_TMPDIR 把它关在临时目录里, 收尾连服务器一起收掉。
  TMUX_TMPDIR="$T/tmux" tmux kill-server 2>/dev/null || true
  if [ "$KEEP" = "1" ]; then echo "现场保留: $T"; else rm -rf "$T"; fi
}
trap cleanup EXIT

mkdir -p "$H/.wezard" "$STATE" "$T/workspace"

# 归属 room (owner): 一个绑定 room 的账本 (chat: 前缀 = 绑定), 只给人一个成员 —— 逾期 / 额度告警落这里。
node -e '
const fs = require("fs"), path = require("path");
const [stateDir] = process.argv.slice(1);
const room = "chat:wrOwner";
const dir = path.join(stateDir, "rooms");
fs.mkdirSync(dir, { recursive: true });
const rows = [
  { op: "open", at: 1, room, kind: "wecom-group", by: { kind: "daemon", id: "wezard" } },
  { op: "join", at: 1, room, who: { kind: "human", id: "T1" }, ord: 1, via: "inbound", by: { kind: "daemon", id: "wezard" } },
];
fs.writeFileSync(path.join(dir, encodeURIComponent(room) + ".jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
' "$STATE"

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
  "rooms": { "watchdog": { "intervalSec": 10 }, "overdue": { "remindMin": 0, "groupMin": 1 } },
  "external": {
    "enabled": true,
    "principals": [
      { "name": "CoC",  "reception": "recv", "owner": "chat:wrOwner", "enabled": true, "perMinute": 10,  "perDay": 50,  "maxOpen": 5 },
      { "name": "Tiny", "reception": "recv", "owner": "chat:wrOwner", "enabled": true, "perMinute": 1,   "perDay": 50,  "maxOpen": 5 },
      { "name": "Few",  "reception": "recv", "enabled": true, "perMinute": 100, "perDay": 100, "maxOpen": 1 },
      { "name": "Day",  "reception": "recv", "enabled": true, "perMinute": 100, "perDay": 1,   "maxOpen": 100 },
      { "name": "Slow", "reception": "recv", "owner": "chat:wrOwner", "enabled": true, "perMinute": 100, "perDay": 100, "maxOpen": 10 }
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
# 指定调用方 (⑫ 的 Neo / Morpheus 不在配置里, 只能 --as)。
extas()     { local who="$1" c="$2"; shift 2; HOME="$H" WEZARD_CONFIG="$CFG" WEZARD_DAEMON_SOCK="$SOCK" node "$ROOM/dist/cli/ext.js" "$c" --as "$who" "$@"; }

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
  # TMUX_TMPDIR: ⑫ 的冷启动起 tmux 也只能起在临时服务器里 (不碰人的 tmux)。
  # WEZARD_TEST_ENROLL_DECIDE: ⑫ 专用的登记卡决定文件 (写到 yes / no, 读一次即消费);
  #   只有登记卡那条路径会看它, 生产不设这个环境变量 = 走真卡片。
  env -u TMUX -u TMUX_PANE -u WEZARD_DAEMON_SOCK -u WEZARD_STATE_DIR \
    HOME="$H" WEZARD_CONFIG="$CFG" TMUX_TMPDIR="$T/tmux" WEZARD_TEST_ENROLL_DECIDE="$T/enroll-decide" \
    node "$ROOM/dist/daemon/index.js" >>"$T/daemon.stdout.log" 2>&1 &
  DPID=$!
  for _ in $(seq 1 300); do
    if sock -o /dev/null -f "http://wezard/healthz" 2>/dev/null; then return 0; fi
    kill -0 "$DPID" 2>/dev/null || break
    sleep 0.2
  done
  echo "daemon 起不来 (pid $DPID); 尾部日志:"; tail -30 "$T/daemon.stdout.log"
  return 1
}

# 演练环境没有真企微连接: WS 认证耗尽重试会把进程带走 (实现里 await ws.ready 失败 = 退出)。
# 控制面不通就原样再起一份 —— 账本与索引都在盘上, 重启不丢事实, 这也是 ③ 已在验的性质。
ensure_daemon() {
  if sock -o /dev/null -f "http://wezard/healthz" 2>/dev/null; then return 0; fi
  say "daemon 不在了 (演练的 WS 凭据是假的), 用同一份盘上状态重启"
  start_daemon
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

# ④b thread 缺省取 env CODEBUDDY_SESSION_ID, --thread 压过它 (只记录, 不按它过滤)
th1=$(CODEBUDDY_SESSION_ID='sess-env-123' ext ask "带会话 id 的那句")
req_th=$(printf '%s' "$th1" | jget req)
thv=$(node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
const hit = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((o) => o && o.op === "ask" && o.req === process.argv[2]).pop();
process.stdout.write(hit && hit.thread ? hit.thread : "");' "$STATE/external/requests.jsonl" "$req_th")
check "$thv" "sess-env-123" "④ thread 缺省取 env CODEBUDDY_SESSION_ID"
th2=$(ext ask --thread 'explicit-9' "再带一个显式 thread")
req_th2=$(printf '%s' "$th2" | jget req)
thv2=$(node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
const hit = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((o) => o && o.op === "ask" && o.req === process.argv[2]).pop();
process.stdout.write(hit && hit.thread ? hit.thread : "");' "$STATE/external/requests.jsonl" "$req_th2")
check "$thv2" "explicit-9" "④ --thread 压过 env"

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

# ⑤b cancel 的 system 行要真的叫醒接待 wizard (wake 含它的 uid, 不是直写空 wake)
node -e '
const fs = require("fs"), path = require("path");
const [stateDir, req, uid] = process.argv.slice(1);
const ops = fs.readFileSync(path.join(stateDir, "external", "requests.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
const ask = ops.filter((o) => o && o.op === "ask" && o.req === req).pop();
if (!ask) { process.stdout.write("no-ask"); process.exit(0); }
const rows = fs.readFileSync(path.join(stateDir, "rooms", encodeURIComponent(ask.room) + ".jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
const sys = rows.filter((r) => r && r.op === "msg" && r.sys === "ext-cancel" && (r.re || []).includes(req)).pop();
process.stdout.write(!sys ? "no-row" : (sys.wake || []).includes(uid) ? "woke" : "nowake:" + JSON.stringify(sys.wake));
' "$STATE" "$req5" "$UID_W" >"$T/cancel-wake.txt"
check "$(cat "$T/cancel-wake.txt")" "woke" "⑤ cancel 的 system 行 wake 含接待 wizard 的 uid"

ensure_daemon

# ── ⑥ 三种额度超限都是 429 ──────────────────────────────────────────────────
t1=$(ext ask --as Tiny "tiny 第一句")
check "$(printf '%s' "$t1" | jget state)" "open" "⑥ Tiny 第一句放行"
ext ask --as Tiny "tiny 第二句" >"$T/tiny.out" 2>"$T/tiny.err"
check "$?" "1" "⑥ 每分钟额度超了退非 0"
if grep -q "429" "$T/tiny.err"; then pass "⑥ 每分钟额度: stderr 写明 429"; else bad "⑥ 每分钟额度没有 429: $(cat "$T/tiny.err")"; fi

# 额度先于开房: 被 429 的那次不该替它多开一间接待 room (索引里 Tiny 只有一条 room op)
tiny_rooms=$(node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
const n = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((o) => o && o.op === "room" && o.principal === process.argv[2]).length;
process.stdout.write(String(n));' "$STATE/external/requests.jsonl" "Tiny")
check "$tiny_rooms" "1" "⑥ 额度超限那次没有先开房 (Tiny 仍只有 1 间)"

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

# ── ⑧ 口令轮换: rotate 要 daemon 口令, 旧口令立即失效 ──────────────────────────
rot_none=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --unix-socket "$SOCK" -m 5 -X POST \
  -H 'content-type: application/json' -d '{"name":"CoC"}' "http://wezard/external/rotate")
check "$rot_none" "403" "⑧ 不带 daemon 口令的 rotate 被拒 (403)"

OLD_TOKEN=$(cat "$H/.wezard/external/CoC.token")
rot_ext=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --unix-socket "$SOCK" -m 5 -X POST \
  -H 'content-type: application/json' -H 'x-wezard-ext: CoC' -H "x-wezard-ext-token: $OLD_TOKEN" \
  -d '{"name":"CoC"}' "http://wezard/external/rotate")
check "$rot_ext" "403" "⑧ 只有调用方口令 (没有 daemon 口令) 也不能 rotate (403)"

rot_ok=$(ext rotate CoC)
check "$(printf '%s' "$rot_ok" | jget ok)" "true" "⑧ CLI rotate 带 daemon 口令可用"
check "$(printf '%s' "$(ext inbox --all)" | jget 0.req)" "$req1" "⑧ 轮换后 CLI 读新口令照常可用"

NEW_TOKEN=$(cat "$H/.wezard/external/CoC.token")
[ "$NEW_TOKEN" != "$OLD_TOKEN" ] && pass "⑧ 口令文件确实换了一串" || bad "⑧ 口令文件没变"
old_code=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --unix-socket "$SOCK" -m 5 \
  -H 'x-wezard-ext: CoC' -H "x-wezard-ext-token: $OLD_TOKEN" "http://wezard/external/inbox")
check "$old_code" "403" "⑧ 旧口令立即失效 (403)"

ensure_daemon

# ── ⑨ 接待 wizard 的禁用表 + 出口脱敏 (第 2 步) ───────────────────────────────
recv_403() { # $1 路由 $2 body
  curl -sS --noproxy '*' --unix-socket "$SOCK" -m 10 -X POST -H 'content-type: application/json' \
    -H "x-wezard-token: $(cat "$H/.wezard/daemon-token")" -d "$2" "http://wezard$1"
}
room_coc=$(node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
const hit = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((o) => o && o.op === "room" && o.principal === "CoC").pop();
process.stdout.write(hit ? hit.room : "");' "$STATE/external/requests.jsonl")

n_bound=$(recv_403 /room/notify "{\"target\":\"$TARGET\",\"room\":[\"chat:wrOwner\"],\"markdown\":\"外部不该进绑定群\"}")
check "$(printf '%s' "$n_bound" | jget ok)" "false" "⑨ 接待 wizard 往绑定 room notify 被拒"
printf '%s' "$n_bound" | jget reason | grep -q "外部接待" && pass "⑨ 拒绝原因写明是外部接待" || bad "⑨ 拒绝原因不对: $(printf '%s' "$n_bound" | jget reason)"

s_adhoc=$(recv_403 /room/say "{\"target\":\"$TARGET\",\"room\":\"$room_coc\",\"text\":\"在自己的接待 room 里说话\"}")
check "$(printf '%s' "$s_adhoc" | jget ok)" "true" "⑨ 接待 wizard 在接待 adhoc room 说话放行"

s_bound=$(recv_403 /room/say "{\"target\":\"$TARGET\",\"room\":\"chat:wrOwner\",\"text\":\"不该进绑定群\"}")
check "$(printf '%s' "$s_bound" | jget ok)" "false" "⑨ 接待 wizard 往绑定 room say 被拒"

cfg_deny=$(recv_403 /config/set "{\"target\":\"$TARGET\",\"path\":\"external.enabled\",\"op\":\"set\",\"value\":false}")
check "$(printf '%s' "$cfg_deny" | jget ok)" "false" "⑨ 接待 wizard 改配置被拒"
printf '%s' "$cfg_deny" | jget reason | grep -q "外部接待" && pass "⑨ 改配置的拒绝原因写明是外部接待" || bad "⑨ 改配置原因不对: $(printf '%s' "$cfg_deny" | jget reason)"

# 脱敏: 交代正文里带 daemon-token 原文, ext wait 拿到的 answer 必须是 ***
DTOK=$(cat "$H/.wezard/daemon-token")
r9=$(ext ask "第九件: 回一句带令牌的")
req9=$(printf '%s' "$r9" | jget req)
reply "$req9" done "令牌是 $DTOK 你自己看" >/dev/null
w9=$(ext wait "$req9" --timeout 10)
case "$(printf '%s' "$w9" | jget answer)" in
  "令牌是 *** 你自己看") pass "⑨ 出口 answer 里的 daemon-token 被抹成 ***" ;;
  *) bad "⑨ 脱敏不对: $(printf '%s' "$w9" | jget answer)" ;;
esac
node -e '
const fs = require("fs"), path = require("path");
const [stateDir, room, req, tok] = process.argv.slice(1);
const rows = fs.readFileSync(path.join(stateDir, "rooms", encodeURIComponent(room) + ".jsonl"), "utf8");
process.stdout.write(rows.includes(tok) ? "raw" : "gone");' "$STATE" "$room_coc" "$req9" "$DTOK" >"$T/ledger-raw.txt"
check "$(cat "$T/ledger-raw.txt")" "raw" "⑨ 账本原样 (脱敏只作用在出口)"

# ── ⑩ 逾期通知落 owner room ─────────────────────────────────────────────────
r10=$(ext ask --as Slow "第十件: 一直没人回")
req10=$(printf '%s' "$r10" | jget req)
check "$(printf '%s' "$r10" | jget state)" "open" "⑩ Slow 的请求挂着"
say "⑩ 等逾期扫描 (groupMin=1 分钟, 扫描 10s 一拍, 最多等 140s)…"
found=''
for _ in $(seq 1 28); do
  sleep 5
  ensure_daemon
  found=$(node -e '
const fs = require("fs"), path = require("path");
const [stateDir, req] = process.argv.slice(1);
const f = path.join(stateDir, "rooms", encodeURIComponent("chat:wrOwner") + ".jsonl");
let rows = "";
try { rows = fs.readFileSync(f, "utf8"); } catch { process.stdout.write(""); process.exit(0); }
const hit = rows.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .find((r) => r && r.op === "msg" && typeof r.text === "string" && r.text.includes("外部调用方 Slow 的请求 " + req));
process.stdout.write(hit ? hit.text : "");' "$STATE" "$req10")
  [ -n "$found" ] && break
done
if [ -n "$found" ]; then pass "⑩ owner room 收到逾期行: $found"; else bad "⑩ 140s 内 owner room 没收到逾期行"; fi

# ── ⑪ 额度告警只发一次 + ext status ────────────────────────────────────────
ensure_daemon
ext ask --as Tiny "tiny 第三句" >/dev/null 2>&1
ext ask --as Tiny "tiny 第四句" >/dev/null 2>&1
alerts=$(node -e '
const fs = require("fs"), path = require("path");
const [stateDir] = process.argv.slice(1);
let rows = "";
try { rows = fs.readFileSync(path.join(stateDir, "rooms", encodeURIComponent("chat:wrOwner") + ".jsonl"), "utf8"); } catch {}
const n = rows.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && r.op === "msg" && typeof r.sys === "string" && r.sys.startsWith("ext-quota:Tiny:minute:")).length;
process.stdout.write(String(n));' "$STATE")
check "$alerts" "1" "⑪ 额度告警同一天同一种只发一次 (索引去重)"

st=$(ext status)
check "$(printf '%s' "$st" | jget ok)" "true" "⑪ ext status 可用"
check "$(printf '%s' "$st" | jget principals.length)" "5" "⑪ ext status 列出全部调用方 (CoC/Tiny/Few/Day/Slow)"
st_coc=$(node -e '
const j = JSON.parse(process.argv[1]); const p = (j.principals || []).find((x) => x.name === "CoC") || {};
process.stdout.write(String(p.today) + ":" + String(p.perDay) + ":" + (p.open > 0 ? "open" : "0"));' "$st")
node -e 'const [t, d, o] = process.argv[1].split(":"); process.exit(Number(t) >= 1 && Number(d) === 50 && o === "open" ? 0 : 1)' "$st_coc" \
  && pass "⑪ ext status 里 CoC 的今日 / 上限 / 未结 都对 ($st_coc)" || bad "⑪ ext status 的 CoC 行不对: $st_coc"

# ── ⑫ 首连审批登记 (第 3 步): 不预写 external 配置 ─────────────────────────
say "⑫ 去掉 external 配置节 (只靠缺省 enabled=true) + 给一个审批人 user:T1, 重启 daemon"
stop_daemon
node -e '
const fs = require("fs");
const cfg = process.argv[1];
const j = JSON.parse(fs.readFileSync(cfg, "utf8"));
delete j.external;
j.approval = { approvers: ["user:T1"] };
fs.writeFileSync(cfg, JSON.stringify(j, null, 2));
' "$CFG"
start_daemon || bad "⑫ daemon 起不来"

out12=$(extas Neo ask "第一次连: 在吗" 2>"$T/n12.err")
rc12=$?
check "$rc12" "3" "⑫ 未登记时 ask 自动发登记卡, 退出码 3"
check "$(printf '%s' "$out12" | jget state)" "pending" "⑫ 回包 state=pending"
grep -q "登记审批卡" "$T/n12.err" && pass "⑫ stderr 告诉 agent 等人点卡" || bad "⑫ stderr 没写登记卡提示: $(cat "$T/n12.err")"
[ -f "$STATE/external/principals.json" ] && bad "⑫ 还没批准就写了登记表" || pass "⑫ 待决期间登记表不存在"
[ -f "$H/.wezard/external/Neo.token" ] && bad "⑫ 还没批准就生成了口令" || pass "⑫ 待决期间没有口令文件"

echo yes >"$T/enroll-decide"
for _ in $(seq 1 40); do [ -f "$H/.wezard/external/Neo.token" ] && break; sleep 0.5; done
[ -f "$H/.wezard/external/Neo.token" ] && pass "⑫ 点了确认后口令文件出现" || bad "⑫ 点了确认后 20s 内没有口令文件"
reg12=$(node -e '
const fs = require("fs");
const [stateDir] = process.argv.slice(1);
try {
  const j = JSON.parse(fs.readFileSync(stateDir + "/external/principals.json", "utf8"));
  const p = (j.principals || []).find((x) => x.name === "Neo") || {};
  process.stdout.write([p.reception, p.owner, p.enabled, p.approvedBy].join("|"));
} catch { process.stdout.write(""); }' "$STATE")
check "$reg12" "ext-neo|user:T1|true|user:T1" "⑫ 登记表记下接待 / owner / 审批人"
wiz12=$(node -e '
const fs = require("fs");
const [home, target] = process.argv.slice(1);
try {
  const j = JSON.parse(fs.readFileSync(home + "/.wezard/wizards.json", "utf8"));
  const r = j[target];
  process.stdout.write(r ? String(r.name) : "");
} catch { process.stdout.write(""); }' "$H" "user:T1#ext-neo")
check "$wiz12" "ext-neo" "⑫ 名册里有接待 wizard ext-neo (会话在审批人私聊)"

out13=$(extas Neo ask "登记后再问一句")
check "$(printf '%s' "$out13" | jget state)" "open" "⑫ 登记后 ask 落行 (open)"

out14=$(extas Morpheus ask "我也要连" 2>/dev/null)
check "$?" "3" "⑫ 第二个调用方也走登记卡"
echo no >"$T/enroll-decide"
cool=''
for _ in $(seq 1 40); do
  sleep 0.5
  out15=$(extas Morpheus enroll 2>/dev/null)
  cool=$(printf '%s' "$out15" | jget state)
  [ "$cool" = "cooldown" ] && break
done
check "$cool" "cooldown" "⑫ 被拒后冷却: 再登记回 429 冷却中"
node -e '
const fs = require("fs");
const [stateDir] = process.argv.slice(1);
const j = JSON.parse(fs.readFileSync(stateDir + "/external/principals.json", "utf8"));
process.exit((j.principals || []).some((x) => x.name === "Morpheus") ? 1 : 0);' "$STATE" \
  && pass "⑫ 被拒的调用方没进登记表" || bad "⑫ 被拒的 Morpheus 却进了登记表"

echo "-----"
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASS ($PASS 项)"
  exit 0
fi
echo "FAILED: $FAIL 项 (PASS $PASS 项); 现场 $T"
exit 1
