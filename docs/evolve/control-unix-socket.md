# 控制面改 unix socket (多用户同机隔离)

状态: 设计定稿 (DavidXu, 2026-11-25) · 实现分 P1~P3 提交, P4 实测。

## 问题 (YaraTaylor 多用户同机审查)

daemon 的 HTTP 控制面绑在固定 TCP `127.0.0.1:17890`, 绝大多数路由不鉴权, 客户端也不核对对端:

- (a) 同机别的 uid 直接 `/mirror/inject`、`/message`、`/approve`、`/room/*`、`/peers/peek`、`/shutdown` —— 操纵 wizard、读对话。
- (b) daemon 重启空窗里别人抢先 bind 17890, 冒充 daemon 给 hook 回 `allow` / 改写入参, 或收走 MCP 请求头里的口令。
- (c) 第二个用户装 wezard: EADDRINUSE 崩溃循环, CLI 写死 17890 还会串到别人的 daemon。

## 方案

### 1. 控制面 = unix domain socket

- 路径: `daemon.socket` (新键, 缺省 `""` = `<stateDir>/run/daemon.sock`, 即 `~/.wezard/state/run/daemon.sock`)。
  客户端解析顺序: env `WEZARD_DAEMON_SOCK` → (能读配置的) `daemon.socket` → `${WEZARD_STATE_DIR:-~/.wezard/state}/run/daemon.sock`。
  单一派生函数 `shared/daemon-addr.ts` `daemonSocketPath(cfg)` / `socketFromEnv()`; 别处不许本地拼。
- sun_path: macOS 104 字节 (含 NUL), Linux 108。解析后 `Buffer.byteLength(path) > 103` 启动即报错退出, 报出路径与「把 daemon.socket 设短」。
- 目录: `mkdir -p run` 后 `lstat`: 必须是目录、不是 symlink、owner = `process.getuid()`, 然后 `chmod 0700` (已存在也收紧)。不满足 → 报错退出, 不去「修」别人的目录。
- 启动探测已存在的 socket 文件:
  - 不存在 → 直接 listen。
  - 存在但不是 socket (`lstat().isSocket()` 为假) → 报错退出, 不删。
  - `net.connect` 连得上 → **有活 daemon 在听**: 报错 `another wezard daemon is listening on <path> (pid?)` 退出 (exit 1; systemd/launchd 会重试, 等对方退出后自然接手 —— 这正是想要的)。
  - `ECONNREFUSED` → 陈旧, `unlink` 后 listen。其余错误 → 当作不确定, 报错退出, 不覆盖。
- listen 后立刻 `chmod 0600`; bind 与 chmod 之间的窗口由 0700 目录兜住。
- 退出 (`/shutdown`、SIGTERM) 时只在 socket 的 inode 仍是自己 listen 的那个时才 unlink (别删掉接手者的)。
- 全部现有路由 (含 `/mcp`、guarded 路由) 都挂在 socket 上。口令 (`x-wezard-token`) 保留: socket 只挡别的 uid, 口令挡的是本 uid 下的模型直接 `curl --unix-socket … /config/set` 绕过审批卡。
- daemon 启动时 `process.env.WEZARD_DAEMON_SOCK = <path>`: 进程内 MCP (`mcp/tools.ts` 的 daemonPost 回打自己) 走同一个 socket。

### 2. 浏览器视图 = 可选 TCP 只读监听 (`daemon.host` / `daemon.port` 改义)

rolepage / 详情页是给浏览器看的, 浏览器连不了 unix socket, 本机没配 svr 的用户还要靠它。所以 TCP 监听留下, 但**只挂只读视图路由**:
`chatRouteTable` 的全部 key (`GET /role`、`/chat/*`、`/api/*`) + `GET /detail` + `GET /healthz`。

- 其余任何路由在 TCP 上一律 `410 { ok:false, reason: "wezard 控制面已迁到 unix socket (<path>); 这个会话起于旧版, 需要重开 (daemon 会在它空闲时自动回收, 下一句话 --resume 重起)" }`。
  `POST /mcp` 回同义的 JSON-RPC error (按请求 id), 旧版 http MCP 客户端看到的是明确的原因, 不是静默超时。
- `EADDRINUSE` 等 listen 失败**不致命**: warn 一行 `view listener disabled`, 控制面照常 (第二个用户不再崩溃循环)。`daemon.port: 0` = 关闭视图监听。
- 键保留, 描述改为「浏览器视图 (rolepage / 详情页) 只读监听地址/端口」。不 deprecated: 它仍有用, 只是不再是控制面。
- 视图端口被抢的残余风险: 抢占者能给浏览器假页面、收到浏览器带的 `?id=` 票据 (读权限)。不再能碰控制面。写进取舍。

### 3. MCP: 默认改为 socket relay (方案 i 的轻量版)

`type:"http"` 的 MCP 客户端只能连 URL, 连不了 unix socket; 而任何留给 MCP 的 TCP 端口都能在重启空窗被抢占 —— 抢占者收走请求头里的口令, 之后就能以任意 pane 身份调全套工具 (含 config_set)。客户端无法校验服务端身份, 鉴权补不上这个洞。所以 (ii) 与 (iii) 都否决, 走 stdio, 但不用整套 SDK server:

- 新增 `mcp/relay.ts` → `dist/mcp/relay.js`: **只用 node 内建模块** (`node:http`、`node:readline`), 不 import SDK / zod。
  stdin 每行一条 JSON-RPC → `POST /mcp` 经 socket (`Accept: application/json, text/event-stream`, `content-type: application/json`,
  `x-wezard-token` 现读口令, `x-wezard-pane: $TMUX_PANE`, `x-wezard-session: $CODEX_THREAD_ID|$CODEBUDDY_SESSION_ID|$CLAUDE_CODE_SESSION_ID|$CLAUDE_SESSION_ID`)。
  响应 JSON 原样一行写回 stdout (每条一次 write, 并发请求各自独立); 202/空体 (notification) 不写。
  socket 不在 / 拒连: 退避重试至多 ~15s (reload 空窗), 仍不行则对带 id 的请求回 JSON-RPC error `{code:-32000, message:"wezard daemon unreachable via <sock>"}`, 不吞、不挂起。
- 内存 (本机实测 node 22): 全量 `dist/mcp/server.js` 每 pane RssAnon ≈ 33MB (Pss ≈ 50MB); 裸 node 进程 RssAnon ≈ 7MB (node 二进制的 ~35MB 文件页各进程共享)。
  relay 预计每 pane ≈ 7~9MB 独占。10 个 pane ≈ +80MB, 42 个 ≈ +350MB (对比旧 stdio 的 ~1.0GB、http 的 0)。这是这次改动的唯一常驻代价, 换来 MCP 通路也不出 uid。
- `daemon.mcpTransport`: `"relay"` (缺省) | `"stdio"` (全量 server.js, 排障用)。旧值 `"http"` 用 `z.preprocess` 映射成 `"relay"` 并在 describe 里标注 deprecated —— 已有配置不报错。
- 产物: **新文件名** `<stateDir>/session-mcp-sock.json` (内容按 mcpTransport 是 relay 或全量 server.js, 均带 `env.WEZARD_DAEMON_SOCK`)。新文件名本身就是「起于新控制面」的判据 (见 §6)。旧的 `session-mcp.json` / `session-mcp-http.json` 不再生成, daemon 启动时 unlink (后者里有口令原文)。`supportsHttpMcp` 与 `HTTP_MCP_BACKENDS` 删除。
- codex: `-c mcp_servers.wezard.command/args` 指向 relay (按 mcpTransport), env 带 `WEZARD_DAEMON_SOCK`, 不再带 `WEZARD_DAEMON_BASE`。
- `mcp/server.js` 保留 (dist 路径 load-bearing): 它的 daemonPost 也改走 socket。

### 4. 客户端

- `shared/daemon-client.ts`: `daemonRequest(method, path, {body, headers, timeoutMs, socketPath})` → `{status, json}`, 基于 `node:http` 的 `socketPath`。TS 客户端全部改用它: `mcp/tools.ts` (daemonPost/daemonGet)、`cli/codex-hook.ts` (删 loopback URL 校验, socket 本身就是本机)、`cli/init.ts`、`cli/audit.ts`、`cli/wx.ts`。
- `hooks/pre-tool-use.sh`、`hooks/stop.sh`: `SOCK="${WEZARD_DAEMON_SOCK:-$STATE_DIR/run/daemon.sock}"`, `curl --unix-socket "$SOCK" http://wezard/approve` (healthz 同)。不再读 `WEZARD_DAEMON_URL` —— 旧 pane 的启动行还带着它, 但 hook 脚本每次从盘上现读, 升级后旧 pane 的审批也直接走 socket。
  socket 缺失 / 连不上与今天的「连不上 daemon」走**同一条**降级: 服务仍注册才等, 否则零输出 exit 0。绝不 allow。
  **改 hook 脚本要换 inode (写临时文件再 `mv`)**: 正挂在 long-poll 里的 bash 按字节偏移懒读脚本, 原地改写会让它醒来后执行错位的内容。
- `cli/wezard.sh`: `SOCK` 同上解析 (可读 `WEZARD_DAEMON_SOCK`, 否则 `$HOME/.wezard/state/run/daemon.sock`, 或从 `/status` 不可得时按 config stateDir), `http_get/http_post/probe` 用 `--unix-socket`。
  reload/stop 在新旧 daemon 间不卡: socket 在 → 先 `POST /shutdown` (drain) 再 kickstart/restart; socket 不在 (旧 TCP daemon 或已停) → **只**用 `systemctl --user restart` / `launchctl kickstart -k`, 绝不向 TCP 17890 发 `/shutdown` (那可能是别的用户的旧 daemon)。「等端口释放」改为等 socket 探测失败或旧 pid 退出。`status` 打印 socket 路径。
- `shared/codex-hooks.ts` `codexHookCommand(configPath, socketPath, entry)`: 命令里带 `WEZARD_DAEMON_SOCK=`; 所有权识别 (`isOwned…`) 同时认旧的 `WEZARD_DAEMON_BASE=` 形态, 以便 sync 清理/替换。`cli/sync.ts` 跟着改。
- `scripts/shot.mjs` 只连视图端口, 不动 (确认它没打控制路由)。`scripts/install.sh` 的健康检查改 socket。`scripts/room-cutover/*` 是已执行过的一次性脚本, 不改, 文件头加一行注释说明它们针对旧 TCP 控制面。

### 5. spawn 注入

- `launchEnv` (spawn-tmux) 与 headless inject env (mirror-bridge): `WEZARD_DAEMON_SOCK=<path>` + `WEZARD_STATE_DIR`, 删 `WEZARD_DAEMON_BASE` / `WEZARD_DAEMON_URL`。`cli/sync.ts` 的清理名单保留这两个旧名。

### 6. 升级路径 (旧 pane)

| 旧 pane 里的东西 | 升级后 |
| --- | --- |
| PreToolUse / Stop hook | 脚本现读, 走 socket, **照常工作** |
| codex 审批 hook | `codex-hook.js` 现读, 走 socket, 照常工作 |
| http MCP (`session-mcp-http.json`) | 打到视图端口 → 明确的 JSON-RPC error「需重开」; 端口未开则连接拒绝 |
| 旧 stdio `server.js` 子进程 | 内存里是旧代码, 打 TCP → 410 原因 / 拒连 |

- **自动回收**: daemon 识别「起于旧控制面」的 pane —— pane 里 CLI 进程的 argv (`ps -o args`, macOS/Linux 通用) 含 `session-mcp.json` / `session-mcp-http.json` (claude 系) 或 `WEZARD_DAEMON_BASE` (codex 的 `-c`)。argv 里什么 wezard MCP 痕迹都没有的 pane 不动 (不是本次升级造成的)。纯函数 `isLegacyCtlArgs(args)` 单测。
  在 watchdog 节拍上, 对**空闲** (`!isBusy`, 不在审批卡上) 的这类 pane 调 `sleepPane(target)` (保留绑定与身份, 下一条注入 `--resume` 用新启动行重起), 每个 pane 记一行 info; 忙的等下一拍。不需要人去 handoff。
- 直到被回收前, 旧 pane 的 MCP 工具调用失败且原因可读 (410 文案)。
- `wezard.sh reload` 从旧 daemon 切到新 daemon: 见 §4, 只走进程管理器重启, 旧 daemon 不 drain。**这一次**已经挂在 long-poll 上的审批并不会「新 daemon 起来后重新推卡」: 正挂着的 bash hook 跑的是内存里的旧脚本 (脚本 `mv` 换了 inode, 但它已经读进内存), 它对旧 TCP 地址做 `wait_for_daemon`, 新 daemon 视图端口的 `/healthz` 会答, 随后它 POST TCP `/approve` → 410 → `.decision // "ask"` → **ask (本地弹框, 人在 CLI 里点)**。不会 allow, 但卡不会重推。codex 同理: 正在飞的旧 `codex-hook` 进程跑的是内存里的旧代码, 打 TCP 得到 410 → 视作断连, 约 60s 后按**旧代码**对 PreToolUse 放行 (`daemon down, auto-allow`) —— 这是只发生在「首次从 TCP 旧 daemon reload 的那一刻、恰好有 codex 审批在飞」的一次性窗口; 新启动的 hook 进程已是 fail-closed (outage 用完 PreToolUse deny / PermissionRequest ask)。此后 (socket 版 daemon 之间的 reload) 仍走 drain + `retry` + 续接同一张卡。

## 测试 (新增 / 改)

- socket 目录 0700、socket 0600; 目录被设成别的权限会被收紧; symlink 目录拒绝。
- 陈旧 socket (无人 listen) 被清理后 listen 成功; 活 socket (另一个 server 在听) 拒绝启动且文件原样保留。
- sun_path 超长报错。
- 视图端口: 只读路由 200, 控制路由 410, `POST /mcp` 回 JSON-RPC error; EADDRINUSE 不抛。
- hook: socket 缺失时零输出 exit 0 (服务未注册); 起一个 socket server 时正常往返 (`tests/hook-mode`, `tests/stop-hook` 改造)。
- codex hook 经 socket 往返; socket 缺失 PreToolUse 仍 deny (`tests/codex-approval`)。
- MCP: relay 进程 + 挂 `registerMcpHttp` 的 socket server, `initialize` / `tools/list` / 一次 `tools/call` 往返; daemon 不在时带 id 的请求得到 JSON-RPC error 而非挂起。
- `tests/session-mcp`、`tests/codex-hooks`、`tests/ws-status` 跟随改造。

## 取舍 / 遗留

- relay 每 pane 多一个 ~7~9MB 的 node 进程 (http 形态为 0)。可接受: 换来 MCP 通路也走 uid 隔离的 socket。
- 视图端口仍是 TCP: 被抢只泄露读票据、给假页面, 碰不到控制面。要彻底就配 `detailRemoteBase` (svr) + `daemon.port: 0`。
- 两个 daemon 同时冷启动的竞态 (都判陈旧、都 unlink) 未加文件锁; 实际只在人手同时起两个时出现。
