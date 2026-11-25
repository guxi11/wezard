#!/usr/bin/env bash
# wezard Stop hook: CLI 要结束这一轮时问 daemon「唤醒它的 duty 交代了没有」(POST /room/stop-check)。
# daemon 回 {decision:"block", reason} → 原样输出, CLI 让模型同一轮接着去 chat_reply;
# 其余一切 (不是 wezard 的会话 / daemon 连不上 / 回包坏了) → 零输出 exit 0, 照常结束。
# 这个 hook 只能催, 不能拦死: 每条 duty daemon 至多拦一次, CLI 自己也有 block 次数上限。
set -uo pipefail

pass() { exit 0; }
PAYLOAD=$(cat) || pass

# 归属闸门同 pre-tool-use.sh: 只管 wezard 自己 spawn 的会话。
if [[ "${WEZARD_MANAGED:-}" != "1" ]]; then
  [[ -n "${TMUX_PANE:-}" ]] && command -v tmux >/dev/null 2>&1 || pass
  [[ "$(tmux show-options -pqv -t "$TMUX_PANE" @wezard_managed 2>/dev/null || true)" == "1" ]] || pass
fi
command -v jq >/dev/null 2>&1 || pass
command -v curl >/dev/null 2>&1 || pass

# 控制面 = daemon 的 unix socket (规则同 pre-tool-use.sh; 不再读旧的 WEZARD_DAEMON_URL)。
STATE_DIR="${WEZARD_STATE_DIR:-${HOME:-}/.wezard/state}"
SOCK="${WEZARD_DAEMON_SOCK:-$STATE_DIR/run/daemon.sock}"
URL="http://wezard/room/stop-check"
BODY=$(jq -c --arg pane "${TMUX_PANE:-}" '{sessionId:(.session_id // ""), tmuxPane:$pane, stopHookActive:(.stop_hook_active // false)}' <<<"$PAYLOAD" 2>/dev/null) || pass
RESP=$(curl -sS --noproxy '*' --unix-socket "$SOCK" --max-time 5 -H 'content-type: application/json' -d "$BODY" "$URL" 2>/dev/null) || pass
# 只认形状完整的 block; 别的一律放行。
OUT=$(jq -ce 'select(.decision == "block" and (.reason | type) == "string" and (.reason | length) > 0) | {decision, reason}' <<<"$RESP" 2>/dev/null) || pass
printf '%s\n' "$OUT"
exit 0
