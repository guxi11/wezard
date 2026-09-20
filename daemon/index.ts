// Daemon entry. Resident process — exits only on signal or fatal WS auth failure.
import { loadConfig } from "../shared/config.js";
import { makeLogger } from "../shared/log.js";
import { bindCliBackends, type CliBackendName } from "../shared/cli-backends.js";
import { startWs } from "./ws.js";
import { startNetWatch } from "./net-watch.js";
import { startHttp, json } from "./http.js";
import { installInboundRouter } from "./inbound.js";
import { loadSessionStore } from "./sessions.js";
import { loadMirrorStore } from "./mirror-store.js";
import { makeBridge } from "./cc-bridge.js";
import { startMirror, installMirrorEventListener, type MirrorBridge } from "./mirror-bridge.js";
import { setTmuxTimeoutReporter, spawnTmuxClaude } from "./spawn-tmux.js";
import { installApprovalEventListener, makeApproveHandler } from "./approval.js";
import { initDetailPersistence, makeDetailHandler, chatHandlers, configureRemoteForward } from "./detail.js";
import { initAutoWindowPersistence } from "./session-cache.js";
import { makeMessageHandler } from "./outbound.js";
import { makeCardHandler, makeAskHandler, installAskEventListener } from "./ask.js";
import { drainForReload } from "./pending.js";
import {
  makeClaimStartHandler,
  makeClaimStatusHandler,
  makeClaimResetHandler,
} from "./claim.js";
import { makeWedocBridge } from "./wedoc.js";
import { installResponseTracker } from "./last-response.js";
import { scanClaudeSessions } from "./session-scan.js";
import {
  startScheduler,
  publish as publishTopic,
  subscribe as subscribeTopic,
  unsubscribe as unsubscribeTopic,
  listSubs,
  listSchedules,
  addSchedule,
  removeSchedulesByTopic,
} from "./topics.js";
import { baseOfKey, keyOf, normalizeTag, tagFromCwd, tagOfKey, uniqueTag, withTagHeader } from "../shared/session-label.js";
import { chatBaseOf, chatNameOf, clearChatName, listChatNames, normChatName, peerAddress, setChatName } from "./chat-name.js";
import {
  bindWizardStore,
  loadWizardStore,
  wizardName,
  childrenOf,
  ancestorsOf,
  renderCharter,
  type WizardBrief,
  type WizardRecord,
} from "./wizard.js";
import {
  startGraph,
  stopRun,
  getRun,
  listRuns,
  validateSpec,
  waitForIdle,
  type GraphSpec,
  type GraphNodeSpec,
  type GraphStepSpec,
} from "./graph.js";

// pino's file transport is async; without flush, log.fatal before process.exit
// vanishes. Mirror anything fatal to stderr too so launchd's stderr.log captures it.
const fatalExit = (msg: string, extra?: Record<string, unknown>): never => {
  // eslint-disable-next-line no-console
  console.error(`[wezard-daemon] FATAL: ${msg}`, extra ?? "");
  process.exit(1);
};

const main = async (): Promise<void> => {
  const { config: cfg, sourcePath } = loadConfig();
  const log = makeLogger({
    logFile: cfg.daemon.logFile,
    logLevel: cfg.daemon.logLevel,
    name: "wezard-daemon",
  });
  log.info({ sourcePath, pid: process.pid }, "daemon start");

  // Bind the CLI backend registry. `primary` (= defaultCli) drives new-session
  // spawns; `backends` is every installed CLI whose transcript root exists, so
  // sessions from all of them can be mirrored concurrently — each attachment
  // derives its dialect from its own jsonl path. Must run BEFORE any mirror
  // attach / tmux spawn.
  const { primary, backends } = bindCliBackends({ ...cfg.wrc, projectsDirOverride: cfg.wrc.mirror.projectsDir });
  log.info({ primary: primary.name, bin: primary.bin, backends: backends.map((b) => b.name) }, "cli backends bound");

  // A killed-on-timeout tmux call is the ONLY externally visible symptom of a
  // wedged tmux server, and the exec helper has no logger of its own. Wire it
  // up before anything can spawn a pane.
  setTmuxTimeoutReporter(({ args, timeoutMs }) =>
    log.warn({ args: args.slice(0, 4), timeoutMs }, "tmux command timed out — killed"),
  );

  // Restore auto-approve windows persisted across daemon restarts —
  // otherwise a `wezard reload` silently drops the user's "10min" choice.
  initAutoWindowPersistence(cfg.daemon.stateDir);
  // Replay tool/approval detail records so reload doesn't lose click-to-detail
  // links from messages already on the user's WeCom timeline.
  initDetailPersistence(cfg.daemon.stateDir, log.child({ mod: "detail" }));
  configureRemoteForward(cfg.daemon.detailRemoteBase, cfg.daemon.detailRemoteToken);

  const ws = startWs(cfg, log);
  // 切网 (换 WiFi / VPN 起停) 后原地重建 WS, 等价于自动做了一次 reload 的
  // 联通性部分 — 但保留全部内存态 (graph 运行、pending 长轮询、镜像绑定),
  // 也不依赖 launchd/systemd 的 respawn 策略 (nohup fallback 没有 supervisor)。
  const netWatch = startNetWatch(log.child({ mod: "net" }), (from, to) =>
    ws.reconnect(`network changed: ${from || "<offline>"} → ${to}`),
  );
  // Wrap replyStream / replyStreamWithCard before any module sends —
  // last-response tracker enables inbound's `quote` dedup of bot self-replies,
  // and its chat-gate drops header-only pushes (empty messages) daemon-wide.
  installResponseTracker(ws.client, log.child({ mod: "chat-gate" }));
  const sessions = loadSessionStore(cfg.wrc.sessionMapFile);
  const mirrorStore = loadMirrorStore(cfg.wrc.mirror.attachmentsFile);
  const bridge =
    cfg.wrc.mode === "mirror"
      ? startMirror({ cfg, log: log.child({ mod: "mirror" }), client: ws.client, store: mirrorStore })
      : makeBridge({ cfg, log: log.child({ mod: "bridge" }), client: ws.client, sessions });
  if (!bridge) {
    log.fatal("bridge failed to start");
    fatalExit("bridge failed to start");
  }
  installInboundRouter(ws.client, cfg, log, bridge, sourcePath);
  // approval click → finalize 当前 liveStream, 后续 tool/text 落到 standalone。
  // 规则 2: 用户点击授权那一刻就是"上一段对话"的边界, 截断 stream 让授权后的
  // 工作单独成块, 比让 stream 一直长到下一个 inbound / hardTimer 更清晰。
  // headless 模式没有 liveStream 概念, onApproved 只在 mirror 模式接。
  const onApproved =
    cfg.wrc.mode === "mirror"
      ? (sid: string): void => (bridge as MirrorBridge).terminateLiveStream(sid)
      : undefined;
  installApprovalEventListener(ws.client, log.child({ mod: "approval" }), cfg, onApproved);
  // Route approval cards to the WeCom chat bound to the requesting session.
  // mirror: the chat this session's pane is attached to; headless: the principal
  // (user:/chat:) that /wrc-dispatched this session — reverse of the sessions store.
  // Falls back to cfg.approval.approvers / cfg.defaultChat when nothing is bound.
  const getMirrorTarget =
    cfg.wrc.mode === "mirror"
      ? (sid: string): string | undefined => (bridge as MirrorBridge).targetForSession(sid)
      : (sid: string): string | undefined => {
          for (const [principal, s] of Object.entries(sessions.all())) {
            if (s === sid) return principal;
          }
          return undefined;
        };
  // Pre-card barrier: drain pending mirror text/tool markdown for this session
  // and await its FIFO so vote/approval cards never overtake the "thinking" bubble.
  // Headless mode has no mirror pipe — leave undefined so approval skips the call.
  const flushBeforeCard =
    cfg.wrc.mode === "mirror"
      ? (sid: string, expect?: { toolName: string; toolInput: unknown }): Promise<void> =>
          (bridge as MirrorBridge).flushBeforeCard(sid, expect)
      : undefined;
  // `.claude/**` 写守卫要用的四个 pane 原语。cancel/tell 复用现成的 target 级方法
  // (先 sessionId → target 再调), 只有 hasPane / answerNativeModal 是 pane 级新增。
  // headless 模式没有 live pane 可按 → 留 undefined, 守卫自动不介入。
  const nativeModal =
    cfg.wrc.mode === "mirror"
      ? (() => {
          const b = bridge as MirrorBridge;
          return {
            hasPane: (sid: string): boolean => b.hasLivePane(sid),
            answer: (sid: string, opts: { waitMs: number }) => b.answerNativeModal(sid, opts),
            cancel: async (sid: string): Promise<{ ok: boolean; reason?: string }> => {
              const t = b.targetForSession(sid);
              return t ? await b.interruptPane(t) : { ok: false, reason: "no mirror target for session" };
            },
            tell: async (sid: string, text: string): Promise<{ ok: boolean; reason?: string }> => {
              const t = b.targetForSession(sid);
              return t ? await b.injectText(t, text) : { ok: false, reason: "no mirror target for session" };
            },
          };
        })()
      : undefined;
  const http = startHttp({ cfg, ws, log, sourcePath });
  http.register(
    "POST /approve",
    makeApproveHandler({ cfg, log: log.child({ mod: "approval" }), client: ws.client, sourcePath, getMirrorTarget, flushBeforeCard, nativeModal }),
  );
  http.register("POST /message", makeMessageHandler(ws.client, log.child({ mod: "outbound" })));
  http.register("POST /card", makeCardHandler(ws.client, log.child({ mod: "outbound" })));
  http.register("POST /ask", makeAskHandler(ws.client, log.child({ mod: "ask" })));
  // 事件订阅广播: 外部脚本/CI 可 curl :17890/publish 触发一次广播,不用关心订阅者。
  http.register("POST /publish", async (req, res) => {
    const { readBody } = await import("./http.js");
    const body = (await readBody(req)) as Partial<{ topic: string; markdown: string; text: string }>;
    const topic = (body.topic ?? "").trim();
    const content = body.markdown ?? body.text ?? "";
    if (!topic || !content) { json(res, 400, { ok: false, error: "topic and markdown/text required" }); return; }
    if (!ws.client.isConnected) { json(res, 503, { ok: false, error: "ws_disconnected" }); return; }
    try {
      const r = await publishTopic(ws.client, cfg, log.child({ mod: "topics" }), topic, content);
      json(res, 200, { ok: true, ...r });
    } catch (e) {
      json(res, 502, { ok: false, error: (e as Error).message });
    }
  });
  http.register("POST /claim/start", makeClaimStartHandler({ log: log.child({ mod: "claim" }) }));
  http.register("GET /claim/status", makeClaimStatusHandler());
  http.register("POST /claim/reset", makeClaimResetHandler());
  http.register("GET /detail", makeDetailHandler(log.child({ mod: "detail" })));
  for (const [key, handler] of Object.entries(chatHandlers())) http.register(key, handler);
  installAskEventListener(ws.client, log.child({ mod: "ask" }));

  // 智能机器人 doc / smartsheet / contact MCP 桥接 — 总是注册路由, 失败让
  // 错误透传到上游 (Claude / curl)。requesterUserId 解析顺序:
  // 调用方 body.requesterUserId → defaultChat 里 user:<id> 部分 → 不传
  // (server 侧会拒, 错误消息原样回去, 比 daemon 提前判更透明)。
  {
    const wedocLog = log.child({ mod: "wedoc" });
    const bridge = makeWedocBridge({
      client: ws.client,
      log: wedocLog,
      pluginVersion: "wezard-0.1",
      cacheTtlMs: 30 * 60_000,
      configFetchTimeoutMs: 15_000,
      requestTimeoutMs: 30_000,
    });
    const fallbackUserId = (): string | undefined => {
      const dc = cfg.defaultChat.trim();
      if (dc.startsWith("user:")) return dc.slice(5);
      return undefined;
    };
    const resolveUid = (raw: unknown): string | undefined => {
      const v = typeof raw === "string" ? raw.trim() : "";
      if (v) return v.startsWith("user:") ? v.slice(5) : v;
      return fallbackUserId();
    };
    http.register("POST /wedoc/list", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{ category: string; requesterUserId: string }>;
      const category = (body.category ?? "").trim();
      if (!category) { json(res, 400, { ok: false, error: "category required" }); return; }
      try {
        const result = await bridge.list(category, resolveUid(body.requesterUserId));
        json(res, 200, { ok: true, result });
      } catch (e) {
        wedocLog.error({ err: (e as Error).message, category }, "wedoc list failed");
        json(res, 502, { ok: false, error: (e as Error).message });
      }
    });
    http.register("POST /wedoc/call", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{
        category: string;
        method: string;
        args: Record<string, unknown>;
        requesterUserId: string;
      }>;
      const category = (body.category ?? "").trim();
      const method = (body.method ?? "").trim();
      if (!category || !method) {
        json(res, 400, { ok: false, error: "category and method required" });
        return;
      }
      try {
        const result = await bridge.call(category, method, body.args ?? {}, resolveUid(body.requesterUserId));
        json(res, 200, { ok: true, result });
      } catch (e) {
        wedocLog.error({ err: (e as Error).message, category, method }, "wedoc call failed");
        json(res, 502, { ok: false, error: (e as Error).message });
      }
    });
    http.register("POST /wedoc/invalidate", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{ category: string }>;
      bridge.invalidate(body.category?.trim() || undefined);
      json(res, 200, { ok: true });
    });
    wedocLog.info("wedoc bridge ready");
  }

  // Mirror-mode: expose attach/status so a slash command can pin the live session.
  if (cfg.wrc.mode === "mirror") {
    const m = bridge as MirrorBridge;
    installMirrorEventListener(ws.client, m, log.child({ mod: "mirror" }));
    http.register("GET /mirror/status", (_req, res) => json(res, 200, m.status()));
    http.register("POST /mirror/attach", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{ sessionId: string; jsonlPath: string; target: string; tmuxPane: string; tmuxSession: string }>;
      if (!body.sessionId || !body.jsonlPath) {
        json(res, 400, { ok: false, reason: "sessionId and jsonlPath required" });
        return;
      }
      const r = m.attach({ sessionId: body.sessionId, jsonlPath: body.jsonlPath, target: body.target, tmuxPane: body.tmuxPane, tmuxSession: body.tmuxSession });
      json(res, r.ok ? 200 : 400, r);
    });
    // Manual auto-spawn trigger — used by `wezard init` to materialize a
    // tmux+claude pane immediately after claim, instead of waiting for the
    // first inbound. Body: { target?: "user:xxx" | "chat:xxx" }. Falls back
    // to cfg.defaultChat. Same code path as the inbound auto-spawn so any
    // future fix benefits both.
    http.register("POST /mirror/spawn", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{ target: string }>;
      const target = (body.target ?? cfg.defaultChat ?? "").trim();
      if (!target) {
        json(res, 400, { ok: false, reason: "target required (and cfg.defaultChat empty)" });
        return;
      }
      const spawnLog = log.child({ mod: "mirror", sub: "spawn-init", target });
      const r = await spawnTmuxClaude({ cfg, log: spawnLog, windowName: target, systemPrompt: charterFor(target, {}) });
      if (!r.ok) { json(res, 500, { ok: false, reason: r.reason }); return; }
      const att = m.attach({ sessionId: r.sessionId!, jsonlPath: r.jsonlPath!, target, tmuxPane: r.tmuxPane, tmuxSession: r.tmuxSession });
      json(res, att.ok ? 200 : 500, att.ok ? { ok: true, sessionId: r.sessionId, tmuxSession: r.tmuxSession, tmuxPane: r.tmuxPane, target } : { ok: false, reason: att.reason });
    });
    // Which chat is the caller? An MCP tool can only see its own process, so
    // every route an agent drives has to be told: explicit target → sessionId
    // → tmuxPane (stable across `/clear`, which rotates sessionId) → the
    // configured defaultChat. Same precedence as /mirror/workspace.
    const resolveSelf = (b: Partial<{ target: string; sessionId: string; tmuxPane: string }>): string => {
      const explicit = (b.target ?? "").trim();
      if (explicit) return explicit;
      const bySid = b.sessionId?.trim() ? m.targetForSession(b.sessionId.trim()) : undefined;
      if (bySid) return bySid;
      const byPane = b.tmuxPane?.trim() ? m.targetForPane(b.tmuxPane.trim()) : undefined;
      if (byPane) return byPane;
      return (cfg.defaultChat ?? "").trim();
    };
    // ── Session discovery / switching (conversational, via MCP tools) ───────
    // GET /sessions/list — enumerate live claude sessions in tmux + a one-line
    // "what is it doing" summary each, with a stable animal-emoji label. The
    // session currently mirrored to defaultChat (if any) is flagged `current`.
    http.register("GET /sessions/list", async (_req, res) => {
      try {
        const sessions = await scanClaudeSessions();
        const cur = m.status();
        const currentSid = cur?.attached ? cur.sessionId : "";
        json(res, 200, {
          ok: true,
          current: currentSid,
          sessions: sessions.map((s) => ({ ...s, current: s.sessionId === currentSid })),
          backends: backends.map((b) => b.name),
        });
      } catch (e) {
        json(res, 500, { ok: false, reason: (e as Error).message });
      }
    });
    // POST /sessions/switch { sessionId, target? } — re-point the WeCom mirror
    // at an already-running session. We re-scan to recover its live pane/jsonl
    // (the caller MCP tool only knows its OWN session), then attach — which
    // replaces any existing binding for the target.
    http.register("POST /sessions/switch", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{ sessionId: string; target: string }>;
      const sessionId = (body.sessionId ?? "").trim();
      if (!sessionId) {
        json(res, 400, { ok: false, reason: "sessionId required" });
        return;
      }
      const target = (body.target ?? cfg.defaultChat ?? "").trim();
      if (!target) {
        json(res, 400, { ok: false, reason: "target required (and cfg.defaultChat empty)" });
        return;
      }
      const sessions = await scanClaudeSessions();
      const hit = sessions.find((s) => s.sessionId === sessionId);
      if (!hit) {
        json(res, 404, { ok: false, reason: `session ${sessionId} not found among live tmux sessions` });
        return;
      }
      const att = m.attach({ sessionId: hit.sessionId, jsonlPath: hit.jsonlPath, target, tmuxPane: hit.tmuxPane, tmuxSession: hit.tmuxSession, cwd: hit.cwd });
      json(res, att.ok ? 200 : 500, att.ok
        ? { ok: true, sessionId: hit.sessionId, label: hit.label, target, cwd: hit.cwd, tmuxSession: hit.tmuxSession }
        : { ok: false, reason: att.reason });
    });
    // POST /sessions/new { cwd, tag?, chat?, cli?, target?|sessionId?|tmuxPane? } —
    // 在调用方自己的聊天里 (或者给了 `chat` 就在那个**起过名字**的聊天里) 让一个
    // 全新的 wizard 在 `cwd` 下就位。它不继承任何上下文 —— 要继承的那种是 clone,
    // 走 /wizard/clone。
    //
    // The caller is an agent living in some chat, so "new session" means what
    // it means to the human typing `/new #tag` there: another `#tag` sibling of
    // THIS chat. Two things this must not do, both of which the old
    // `target ?? defaultChat` fallback did: (1) materialize the session in
    // defaultChat, where the agent that asked for it can neither see nor reach
    // it; (2) land untagged, which IS the chat's default session — attaching
    // there evicts whoever is already mirrored to it, quite possibly the caller.
    // 走 `m.newSession` (而不是 spawn+attach) 才能让这个 wizard 与人手敲出来的那种
    // 完全一样: 聊天级的 cwd/CLI 继承、tag 当 tmux 窗口名、以及那条
    // "created + 📂 当前项目" 气泡 —— 它在群里和详情页留下可见的出生记录。
    //
    // `chat` lifts that from "in my chat" to "in that chat", and it is why chat
    // naming exists: a NAMED chat is the only kind an agent can point at, so
    // 「我要的那个 wizard 在别的群、而且还不存在」从此不必再靠"找个人去那边敲
    // /new"来解决。
    // Unnamed chats stay unaddressable ON PURPOSE — spawning into a raw
    // `chat:wr…` id nobody can read is how you strand a session in a group the
    // caller has no business in.
    http.register("POST /sessions/new", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{ cwd: string; tag: string; chat: string; target: string; sessionId: string; tmuxPane: string; cli: CliBackendName }>;
      const cwd = (body.cwd ?? "").toString().trim();
      if (!cwd) {
        json(res, 400, { ok: false, reason: "cwd required" });
        return;
      }
      const self = resolveSelf(body);
      if (!self) {
        json(res, 400, { ok: false, reason: "cannot resolve caller chat (pass target/sessionId/tmuxPane, or set cfg.defaultChat)" });
        return;
      }
      const wantChat = (body.chat ?? "").toString().trim();
      const base = wantChat ? chatBaseOf(cfg, wantChat) : baseOfKey(self);
      if (!base) {
        json(res, 404, {
          ok: false,
          reason: `unknown chat '${wantChat}' — only NAMED chats can be spawned into; have someone run \`/name ${normChatName(wantChat) || "<name>"}\` there first`,
          candidates: listChatNames(cfg).map((c) => c.name),
        });
        return;
      }
      const foreign = base !== baseOfKey(self);
      const taken = new Set(m.chatTargets(base).map(tagOfKey).filter(Boolean));
      const asked = normalizeTag(body.tag);
      // 复用一个活着的 tag 等于 respawn —— 也就是杀掉那个 wizard。调用方要的是
      // 「再来一个」, 不是「把那个重启」; 让它换个名字。
      if (asked && taken.has(asked)) {
        json(res, 409, { ok: false, reason: `peer '#${asked}' already exists in ${foreign ? `chat '${wantChat}'` : "this chat"} — pick a different tag, or drive that one with send_peer`, tag: asked });
        return;
      }
      const tag = asked || uniqueTag(tagFromCwd(cwd) || "peer", taken);
      const target = keyOf(base, tag);
      log.child({ mod: "mirror", sub: "sessions-new", target }).info({ self, cwd, foreign, cli: body.cli }, "spawning peer session");
      const r = await m.newSession(target, tag, body.cli, { cwd });
      json(res, r.ok ? 200 : 500, r.ok
        ? {
            ok: true,
            sessionId: r.sessionId,
            self,
            target,
            base,
            tag,
            cwd: r.cwd,
            foreign,
            // 调用方之后拿这个串 send_peer / peek_peer 驱动它。
            address: peerAddress(cfg, self, target),
          }
        : { ok: false, reason: r.reason });
    });
    // Frame-less inject — used by `wezard init` to fire a demo prompt right
    // after /mirror/spawn so first-time users see the full PreToolUse → card
    // → mirror loop without needing to type in WeCom.
    http.register("POST /mirror/inject", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{ target: string; text: string }>;
      const target = (body.target ?? cfg.defaultChat ?? "").trim();
      const text = (body.text ?? "").toString();
      if (!target) { json(res, 400, { ok: false, reason: "target required" }); return; }
      if (!text.trim()) { json(res, 400, { ok: false, reason: "text required" }); return; }
      const r = await m.injectText(target, text);
      json(res, r.ok ? 200 : 500, r);
    });
    // One-shot project switch: bind the chat-wide cwd AND apply it right here
    // by walking the exact /new path (kill pane → respawn in pendingCwd →
    // attach → "📂 当前项目" push). Resolved target
    // precedence: explicit body.target → sessionId-derived (so MCP can omit
    // it) → tmuxPane (stable across /clear) → cfg.defaultChat. When the caller
    // IS the session being replaced, its pane dies mid-tool-call — the
    // project-info bubble is the receipt. On spawn failure the pendingCwd
    // stays queued, so a manual /new from WeCom still completes the switch.
    http.register("POST /mirror/workspace", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{ target: string; sessionId: string; tmuxPane: string; cwd: string }>;
      const cwd = (body.cwd ?? "").toString();
      let target = (body.target ?? "").trim();
      if (!target && body.sessionId) {
        const t = m.targetForSession(body.sessionId.trim());
        if (t) target = t;
      }
      // sessionId rotates on /clear; the MCP caller's env sessionId may be stale.
      // Pane id is stable, so resolve by it before falling back to defaultChat.
      if (!target && body.tmuxPane) {
        const t = m.targetForPane(body.tmuxPane.trim());
        if (t) target = t;
      }
      if (!target) target = (cfg.defaultChat ?? "").trim();
      if (!target) { json(res, 400, { ok: false, reason: "target required (or pass sessionId of an attached chat)" }); return; }
      if (!cwd) { json(res, 400, { ok: false, reason: "cwd required" }); return; }
      const set = m.setPendingCwd(target, cwd);
      if (!set.ok) { json(res, 400, { ...set, target }); return; }
      // Same shape as inbound's /new: windowName = tag for tagged sessions,
      // principal for the default one. No explicit cwd — newSession reads the
      // pendingCwd just queued and clears it once applied.
      const r = await m.newSession(target, tagOfKey(target) || target, undefined, {});
      json(res, r.ok ? 200 : 500, r.ok
        ? { ok: true, target, sessionId: r.sessionId, cwd: r.cwd }
        : { ok: false, reason: r.reason, target, runningCwd: set.runningCwd, pendingCwd: set.pendingCwd });
    });
    // ── wizard ↔ wizard + 流水线 ───────────────────────────────────────
    // 这组路由让一个 pane 里的 wizard 作用到它的**同伴**身上: 同一个聊天里别的
    // `#tag` wizard。MCP 工具只看得见自己那个进程, 所以"#fix 在干嘛""把这句话注入
    // #review"只有守护进程答得了 —— 它才持有全部 attachment。调用方靠上面的
    // `resolveSelf` 说明自己是谁。
    // 地址语义见 mirror-bridge.resolvePeerTag: "" = 本聊天的默认 wizard (它是正当的
    // 协作对象 ——「回去跟主会话汇报」); 裸 `fix` 先找本聊天、再退回全机唯一的那个;
    // `daily#fix` 直接指名聊天, 不要求任何唯一性。
    const resolvePeer = (
      self: string,
      tag: string,
    ): { ok: true; target: string; foreign: boolean } | { ok: false; status: number; reason: string; candidates?: string[] } => {
      const r = m.resolvePeerTag(self, tag);
      if (r.ok) return r;
      return { ok: false, status: 404, reason: r.reason, candidates: r.candidates };
    };

    // ── Chat naming ────────────────────────────────────────────────────
    // A WeCom chat's identity is an unreadable `chat:wrkS…` id. Naming it is
    // what makes cross-chat addressing (`daily#fix`) and cross-chat spawning
    // (`new_claude_session({ chat: 'daily' })`) expressible at all.
    http.register("POST /chats/list", async (req, res) => {
      const { self } = await readPeerBody(req);
      const roster = self ? m.chatRoster(self) : listChatNames(cfg).map((c) => ({ ...c, self: false, targets: [] }));
      json(res, 200, {
        ok: true,
        self,
        chats: roster.map((c) => ({
          ...c,
          sessions: c.targets.map((t) => ({
            target: t,
            tag: tagOfKey(t),
            address: self ? peerAddress(cfg, self, t) : t,
          })),
        })),
      });
    });

    http.register("POST /chats/name", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller chat (pass target/sessionId/tmuxPane)" }); return; }
      const raw = ((body as { name?: string }).name ?? "").toString().trim();
      // "-" is the same erase gesture `/name -` uses in the chat — one verb,
      // one meaning, whether a human or an agent performs it.
      if (raw === "-") {
        const gone = clearChatName(cfg, sourcePath, self);
        json(res, 200, { ok: true, base: baseOfKey(self), name: "", previous: gone });
        return;
      }
      const previous = chatNameOf(cfg, self);
      const r = setChatName(cfg, sourcePath, self, raw);
      json(res, r.ok ? 200 : 409, r.ok ? { ok: true, base: r.base, name: r.name, previous } : { ok: false, reason: r.reason });
    });

    interface PeerBody { target?: string; sessionId?: string; tmuxPane?: string; tag?: string }
    const readPeerBody = async (req: import("node:http").IncomingMessage): Promise<{ self: string; body: PeerBody }> => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as PeerBody;
      return { self: resolveSelf(body), body };
    };

    http.register("POST /peers/list", async (req, res) => {
      const { self } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session (pass target/sessionId/tmuxPane)" }); return; }
      const [peers, foreignPeers] = await Promise.all([m.peers(self), m.foreignPeers(self)]);
      json(res, 200, { ok: true, self, base: baseOfKey(self), peers, foreignPeers });
    });

    // Push a plain markdown bubble into a chat. `base` may carry a `#tag` — a
    // tagged key strips down to the same WeCom chatid as its base.
    const notifyChat = (base: string, markdown: string): void => {
      const chatId = baseOfKey(base).replace(/^(user|chat|group):/, "");
      void ws.client
        .sendMessage(chatId, { msgtype: "markdown", markdown: { content: markdown } })
        .catch((e: unknown) => log.warn({ err: (e as Error).message }, "chat notify failed"));
    };
    // wizard 在群里的称呼, 只用在**正文**里。气泡的头照旧交给 withTagHeader ——
    // 那一段是路由信息 (`emoji #tag`), parseTagHeader 靠它反解, 群里引用一条气泡
    // 就能直接跟那个 wizard 说话; 把它换成名字会把这条通路弄断。
    const displayName = (t: string): string => {
      const tag = tagOfKey(t);
      const name = wizardName(wizards.get(t), chatNameOf(cfg, t), t);
      return name || (tag ? `#${tag}` : "默认 wizard");
    };

    // wizard 之间的往返本来是看不见的: 它发生在两个没人盯着的 pane 里。关键的那几
    // 次 (派活、结论) 各自成一条气泡, 头写成
    // `<from> → <to>` so the direction reads at a glance in the chat timeline.
    // 跨 chat 时两端都要看得见 —— from 的群显示 "我发出去了",to 的群显示
    // "另一个群的 agent 找上门了",否则 to 侧的人以为消息是凭空冒出来的。
    const RELAY_MAX = 1200;
    /** `where`: 这条 relay 该出现在谁的群里。
     *  - "both" (派活): 双方都要看见 —— to 那边的人得知道活是谁派来的, 而被注入的
     *    那一轮在 brief 模式下只把提问写进详情页, 群里没有别的痕迹。
     *  - "from" (回程结论): 只发给问的人。答话方自己的群里, 它的回复本来就会以它
     *    自己的气泡出现, 再 relay 一条就是同一句话在同一个群里说两遍。 */
    const relayPeer = (from: string, to: string, body: string, where: "both" | "from" = "both"): void => {
      const text = body.trim();
      if (!text) return;
      const head = `${withTagHeader(from, "→")} ${withTagHeader(to, "")}`.trim();
      const clipped = text.length > RELAY_MAX ? `${text.slice(0, RELAY_MAX)}…` : text;
      const bubble = `${head}\n${clipped}`;
      notifyChat(from, bubble);
      if (where === "both" && baseOfKey(from) !== baseOfKey(to)) notifyChat(to, bubble);
    };


    http.register("POST /peers/peek", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const r = resolvePeer(self, body.tag ?? "");
      if (!r.ok) { json(res, r.status, { ok: false, reason: r.reason, candidates: r.candidates }); return; }
      const { target, foreign } = r;
      const turns = Math.min(Math.max(Number((body as { turns?: number }).turns ?? 6) || 6, 1), 40);
      // 先读 transcript —— 那才是对话本身。只有当这个 wizard 还没有可读的 jsonl
      // (从没 attach 过, 或者刚 `/clear` 完) 才退回去刮它的终端。
      const peek = await m.peekTurns(target, turns);
      const pane = peek.ok ? undefined : await m.peekPane(target, 24);
      json(res, 200, {
        ok: true,
        target,
        foreign,
        dialog: peek.dialog ?? "",
        pane: pane?.pane ?? "",
        error: peek.ok ? undefined : (pane?.reason ?? peek.reason),
        busy: peek.busy ?? false,
        lastText: m.lastText(target),
      });
    });

    http.register("POST /peers/send", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const text = ((body as { text?: string }).text ?? "").toString();
      if (!text.trim()) { json(res, 400, { ok: false, reason: "text required" }); return; }
      const r = resolvePeer(self, body.tag ?? "");
      if (!r.ok) { json(res, r.status, { ok: false, reason: r.reason, candidates: r.candidates }); return; }
      const { target, foreign } = r;
      // Injecting into your own pane would type into the box you're generating
      // from — Claude Code queues it and the caller deadlocks waiting for itself.
      if (target === self) { json(res, 400, { ok: false, reason: "refusing to inject into the calling session itself" }); return; }
      const inj = await m.injectText(target, text);
      if (inj.ok) relayPeer(self, target, text);
      json(res, inj.ok ? 200 : 502, { ...inj, target, foreign });
    });

    http.register("POST /peers/wait", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const r = resolvePeer(self, body.tag ?? "");
      if (!r.ok) { json(res, r.status, { ok: false, reason: r.reason, candidates: r.candidates }); return; }
      const { target, foreign } = r;
      if (target === self) { json(res, 400, { ok: false, reason: "refusing to wait on the calling session itself" }); return; }
      const timeoutMs = Math.min(Math.max(Number((body as { timeoutSec?: number }).timeoutSec ?? 900) || 900, 10), 7200) * 1000;
      const wr = await waitForIdle(target, m.isBusy, timeoutMs, () => false);
      const lastText = m.lastText(target);
      // 回程只在跨聊天时下发。同一个群里, 对方的回复本来就会以它自己的 `emoji #tag`
      // 气泡出现 —— 再 relay 一条 `B → A` 就是同一句话在同一个群里出现两次, 正是
      // 「A 告诉 B 之后不必再展示 B 收到了」要消灭的那种重复。跨聊天则相反: A 的群
      // 里看不到 B 的任何气泡, 这条 relay 是那边唯一能看见结论的地方。
      if (wr.idle && foreign) relayPeer(target, self, lastText, "from");
      json(res, 200, { ok: true, target, foreign, idle: wr.idle, reason: wr.reason, lastText });
    });

    // POST /handoff — 交接一个 pane 的会话给一个全新会话,原地完成。先让目标
    // 会话把当前工作压成一份"零上下文也能接手"的交接简报,等它写完并抓取,
    // 再向同一 pane 注入 `/clear`(原地重开 session、重置上下文窗口、cwd 不变),
    // settle 后把简报作为新会话的首条消息贴进去。全程只操控 tmux。拒绝对调用方
    // 自身 pane 操作(会 deadlock,同 /peers/send)。
    http.register("POST /handoff", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const pane = ((body as { pane?: string }).pane ?? "").trim();
      let target: string | undefined;
      if (pane) {
        target = m.targetForPane(pane);
        if (!target) { json(res, 404, { ok: false, reason: `no mirror session bound to pane ${pane}` }); return; }
      } else {
        const r = resolvePeer(self, body.tag ?? "");
        if (!r.ok) { json(res, r.status, { ok: false, reason: r.reason, candidates: r.candidates }); return; }
        target = r.target;
      }
      // 注入到自己的 pane = 往正在生成的输入框里打字,Claude Code 会把它排队,
      // 调用方等自己等成死锁(同 /peers/send)。
      if (target === self) { json(res, 400, { ok: false, reason: "refusing to hand off the calling session itself (would deadlock)" }); return; }
      const focus = ((body as { focus?: string }).focus ?? "").toString().trim();
      const timeoutMs = Math.min(Math.max(Number((body as { timeoutSec?: number }).timeoutSec ?? 600) || 600, 30), 7200) * 1000;

      const briefPrompt = [
        "把你当前会话的全部工作压缩成一份**交接简报**,目标是让一个零上下文的全新会话仅凭这份简报就能无缝接手。必须自洽、具体、可执行,涵盖:",
        "1. 总目标 / 用户到底想要什么",
        "2. 已完成的事、关键决策与其理由",
        "3. 当前状态:改到哪了、什么能跑、什么还没跑通",
        "4. 下一步该做什么(有序)",
        "5. 涉及的关键文件/路径/符号,以及非显而易见的坑",
        focus ? `特别强调:${focus}` : "",
        "只输出这份简报本身,不要寒暄、不要反问。",
      ].filter(Boolean).join("\n");

      const inj1 = await m.injectText(target, briefPrompt);
      if (!inj1.ok) { json(res, 502, { ok: false, target, reason: `summary inject failed: ${inj1.reason}` }); return; }
      const idle = await waitForIdle(target, m.isBusy, timeoutMs, () => false);
      const brief = m.lastText(target);
      // 没等到 idle 就不能 /clear —— 那会丢掉这次还在生成的交接总结。
      if (!idle.idle) { json(res, 504, { ok: false, target, brief, reason: `target still working: ${idle.reason}; not clearing to avoid losing the turn` }); return; }
      if (!brief.trim()) { json(res, 502, { ok: false, target, reason: "target produced no summary text" }); return; }

      const clr = await m.injectText(target, "/clear");
      if (!clr.ok) { json(res, 502, { ok: false, target, brief, reason: `/clear inject failed: ${clr.reason}` }); return; }
      // /clear 后 TUI 重绘出全新空会话 + 首条注入需要 warmup,给足 settle。
      await new Promise((r) => setTimeout(r, 3000));

      const carry = `以下是上一个会话交接过来的工作简报,请据此无缝接手并继续:\n\n${brief}`;
      const inj2 = await m.injectText(target, carry);
      json(res, inj2.ok ? 200 : 502, inj2.ok
        ? { ok: true, target, brief }
        : { ok: false, target, brief, reason: `handoff carry inject failed: ${inj2.reason}` });
    });

    // ── Wizard: 会话的身份层 ────────────────────────────────────────────
    // 一个会话 (`chat:xxx#tag`) 从此是一个 wizard: 名字 (= 聊天名, 带 tag 的分身读作
    // `chat#tag`)、一句职责、一份跨会话的记忆、一条家谱。身份不靠"在对话里讲一遍"
    // 维持 —— spawn 时以 `--append-system-prompt` 压进那个进程, `/clear` 抹不掉、
    // 上下文窗口也挤不掉。
    // 这里只做三件事: 读身份、改身份、按身份生/收分身。tmux 一概不碰, 动作全在
    // mirror-bridge。
    const wizards = bindWizardStore(loadWizardStore(cfg.wrc.mirror.wizardsFile));

    /** 上下文超过这个数就该自己交接了。Claude 家族最小的窗口是 200k, 留三成余量
     *  给交接那一轮本身 —— 提示而已, 决定权在 wizard 自己。 */
    const HANDOFF_HINT_TOKENS = 140_000;

    const briefOf = (self: string, target: string): WizardBrief => ({
      name: wizardName(wizards.get(target), chatNameOf(cfg, target), target),
      address: peerAddress(cfg, self, target),
      description: wizards.get(target)?.description ?? "",
      cwd: m.getCwd(target).runningCwd,
    });

    /** 自己的地址要写成**全局**形态 (`聊天名#tag`), 不是同群内部的裸 tag —— 宪章
     *  和 whoami 里的这个串会被它原样贴给别的聊天的 wizard, 裸 tag 到了那边只有
     *  在全机唯一时才碰巧能解析。聊天没起名时只能退回裸 tag。 */
    const selfAddress = (target: string): string => {
      const chat = chatNameOf(cfg, target);
      const tag = tagOfKey(target);
      return chat ? `${chat}#${tag}` : tag;
    };

    /** 开局宪章。出生时的兄弟只是快照 —— 名册随时可查, 写进系统提示的那份只为了
     *  让它一睁眼就知道自己不是一个人在跑。 */
    const charterFor = (target: string, o: { parent?: string; inherited?: boolean }): string =>
      renderCharter({
        self: { ...briefOf(target, target), address: selfAddress(target) },
        chat: chatNameOf(cfg, target),
        principal: baseOfKey(target),
        parent: o.parent ? briefOf(target, o.parent) : undefined,
        inherited: !!o.inherited,
        siblings: m.chatTargets(baseOfKey(target)).filter((t) => t !== target).map((t) => briefOf(target, t)),
        memory: wizards.get(target)?.memory ?? [],
      });

    // 所有 spawn 路径 (群里手打 /new、pane 自愈重生、编排出来的分身) 都从这里
    // 取身份, 于是「是谁」不再取决于是哪段代码把它生出来的。
    m.setCharterProvider((target) => {
      const rec = wizards.get(target);
      return charterFor(target, { parent: rec?.parent, inherited: !!rec?.clonedFrom });
    });

    const kinOf = (self: string, all: readonly WizardRecord[], target: string) => ({
      parent: wizards.get(target)?.parent ? briefOf(self, wizards.get(target)!.parent!) : undefined,
      ancestors: ancestorsOf(all, target).map((t) => briefOf(self, t)),
      clones: childrenOf(all, target).map((w) => briefOf(self, w.target)),
    });

    const identityOf = (self: string, target: string) => {
      const rec = wizards.get(target);
      const info = m.sessionInfo(target);
      const me = briefOf(self, target);
      return {
        target,
        ...me,
        address: self === target ? selfAddress(target) : me.address,
        chat: chatNameOf(cfg, target),
        principal: baseOfKey(target),
        tag: tagOfKey(target),
        named: !!(rec?.name ?? "").trim() || !!chatNameOf(cfg, target),
        bornAt: rec?.bornAt,
        inheritedFrom: rec?.clonedFrom || "",
        memory: rec?.memory ?? [],
        ...kinOf(self, wizards.all(), target),
        sessionId: info?.sessionId ?? "",
        cli: info?.cli,
        contextTokens: info?.contextTokens ?? 0,
        handoffSuggested: (info?.contextTokens ?? 0) > HANDOFF_HINT_TOKENS,
      };
    };

    /** 全体名册: 活着的 (peers + 跨聊天可寻址的) 在前, 注册表里有记录但此刻不在
     *  可寻址集合里的 (pane 死了 / 聊天没起名) 跟在后面 —— 它们仍是这个世界的一员,
     *  只是暂时叫不动。 */
    const rosterOf = async (self: string) => {
      const [peers, foreign] = await Promise.all([m.peers(self), m.foreignPeers(self)]);
      const all = wizards.all();
      const live = [...peers, ...foreign].map((p) => {
        const b = briefOf(self, p.target);
        return {
          ...b,
          target: p.target,
          chat: chatNameOf(cfg, p.target) || p.chat,
          label: p.label,
          cli: p.cli,
          busy: p.busy,
          alive: p.paneAlive,
          self: p.self,
          lastActivity: p.lastActivity,
          summary: p.summary,
          ...kinOf(self, all, p.target),
        };
      });
      const seen = new Set(live.map((r) => r.target));
      const cold = all
        .filter((w) => !seen.has(w.target))
        .map((w) => ({
          ...briefOf(self, w.target),
          target: w.target,
          chat: chatNameOf(cfg, w.target),
          busy: false,
          alive: false,
          self: false,
          summary: "(未运行 —— 发消息或 send_peer 会把它唤醒)",
          ...kinOf(self, all, w.target),
        }));
      return [...live, ...cold];
    };

    http.register("POST /wizard/whoami", async (req, res) => {
      const { self } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      // 身份已经写在系统提示里了, whoami 回答的是"此刻"的部分: 上下文用了多少、
      // 分身还剩几个、工作区有没有被换掉。
      json(res, 200, { ok: true, ...identityOf(self, self), peers: (await m.peers(self)).filter((p) => !p.self).length });
    });

    // 起名字 / 写职责。默认会话的名字就是聊天的名字 (需求: wizard 的名字 = chat
    // 的名字), 所以那一路同时写 chats 表 —— 否则别的聊天仍然叫不到它。带 tag 的
    // 分身只写自己的记录, 它的地址本来就是 `chat#tag`。
    http.register("POST /wizard/identity", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { name?: string; description?: string };
      const name = (b.name ?? "").toString().trim();
      const description = (b.description ?? "").toString().trim();
      const wasNamed = !!wizardName(wizards.get(self), chatNameOf(cfg, self), self);
      let chatNamed: string | undefined;
      if (name && !tagOfKey(self)) {
        const r = setChatName(cfg, sourcePath, self, name);
        if (!r.ok) { json(res, 409, { ok: false, reason: r.reason }); return; }
        chatNamed = r.name;
      }
      wizards.upsert(self, {
        ...(name ? { name: chatNamed ?? name } : {}),
        ...(description ? { description } : {}),
      });
      const me = identityOf(self, self);
      // 起名是稀有事件, 值得在群里留一条 —— 人得知道群里这个角色叫什么了。
      if (name && !wasNamed) notifyChat(self, withTagHeader(self, `我是 **${me.name}**${description ? ` · ${description}` : ""}`));
      json(res, 200, { ok: true, ...me, chatNamed });
    });

    http.register("POST /wizard/roster", async (req, res) => {
      const { self } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      json(res, 200, { ok: true, self: identityOf(self, self), wizards: await rosterOf(self) });
    });

    http.register("POST /wizard/remember", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { note?: string; forget?: string };
      const cur = wizards.get(self)?.memory ?? [];
      const note = (b.note ?? "").toString().trim();
      const forget = (b.forget ?? "").toString().trim();
      // 忘记按子串匹配: 模型记不住自己当初一字不差写了什么, 但记得大意。
      const next = forget ? cur.filter((x) => !x.includes(forget)) : cur;
      const memory = note ? [...next.filter((x) => x !== note), note] : next;
      wizards.upsert(self, { memory });
      json(res, 200, { ok: true, memory, added: !!note, forgotten: cur.length - next.length });
    });

    // 生分身。默认 fork 调用方此刻的上下文 —— 这是"先把公共材料读进来, 再分出 N
    // 个干活的"之所以省事的原因: 材料只读一遍, 却进了 N 份上下文。
    http.register("POST /wizard/clone", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { tag?: string; description?: string; inherit?: boolean; cwd?: string; chat?: string; cli?: CliBackendName; model?: string; task?: string };
      // `inherit` 没有默认值 —— 继承与否是两种完全不同的分身 (一种开局就带着你
      // 读过的一切, 另一种白纸一张), 猜错了要么白烧一份上下文, 要么让它从零重读。
      // 逼调用方每次自己说。
      if (typeof b.inherit !== "boolean") {
        json(res, 400, { ok: false, reason: "inherit 必填: true = fork 你此刻的上下文 (它开局就有你读过的材料, 必须留在同一个 cwd); false = 空白分身, 只继承身份" });
        return;
      }
      const inherit = b.inherit;
      const wantChat = (b.chat ?? "").toString().trim();
      const base = wantChat ? chatBaseOf(cfg, wantChat) : baseOfKey(self);
      if (!base) {
        json(res, 404, {
          ok: false,
          reason: `unknown chat '${wantChat}' — 只有起过名字的聊天能被指名; 让那边先 /name`,
          candidates: listChatNames(cfg).map((c) => c.name),
        });
        return;
      }
      const taken = new Set(m.chatTargets(base).map(tagOfKey).filter(Boolean));
      const asked = normalizeTag(b.tag);
      if (asked && taken.has(asked)) {
        json(res, 409, { ok: false, reason: `'#${asked}' 已经是一个活着的 wizard —— 换个名字, 或者直接 send_peer 找它`, tag: asked });
        return;
      }
      const tag = asked || uniqueTag(normalizeTag(b.description?.split(/\s+/)[0]) || "clone", taken);
      const target = keyOf(base, tag);
      const parentInfo = m.sessionInfo(self);
      // 先落身份再 spawn: 宪章是从注册表渲染出来的, 记录不在就渲染出一个无名分身。
      wizards.upsert(target, {
        description: (b.description ?? "").toString().trim(),
        parent: self,
        bornAt: Date.now(),
        clonedFrom: inherit ? parentInfo?.sessionId ?? "" : "",
      });
      const charter = charterFor(target, { parent: self, inherited: inherit });
      const task = (b.task ?? "").toString().trim();
      const r = await m.cloneSession({
        parent: self,
        target,
        windowName: tag,
        cli: b.cli,
        model: b.model,
        cwd: b.cwd,
        systemPrompt: charter,
        inherit,
        // 继承路径上第一句话是分叉的触发器, 所以直接把活当开场白 —— 少一次往返,
        // 也少一次"就位了但没事干"的空转。
        bootstrap: task || undefined,
      });
      if (!r.ok) {
        wizards.drop(target);
        json(res, 500, { ok: false, reason: r.reason });
        return;
      }
      wizards.upsert(target, { clonedFrom: r.inherited ? parentInfo?.sessionId ?? "" : "" });
      const me = briefOf(self, self);
      const kid = briefOf(self, target);
      // 分身出生要在群里留一条 —— 群里多了一个成员, 人有权当场知道。
      notifyChat(base, withTagHeader(target, `已就位 · ${r.inherited ? `${displayName(self)} 的分身 (继承了它的上下文)` : "全新 wizard (空白上下文)"}${kid.description ? ` · ${kid.description}` : ""}`));
      // 派活在群里留一条 (它是关键节点)。继承路径上活已经随开场白进去了, 空白分身
      // 才需要在这里补一次注入。
      let dispatched = r.inherited && !!task;
      if (task && !r.inherited) {
        const inj = await m.injectText(target, task);
        dispatched = inj.ok;
      }
      if (dispatched) relayPeer(self, target, task);
      json(res, 200, { ok: true, target, tag, address: peerAddress(cfg, self, target), name: kid.name, inherited: r.inherited, sessionId: r.sessionId, cwd: r.cwd, dispatched });
    });

    // 收掉一个 wizard。interrupt = 打断它这一轮 (Esc); end = 结束它并回收 pane。
    // 自己终结自己是合法的 (分身干完活自我了结), 代价是这次工具调用不会返回 ——
    // 群里的气泡就是回执, 与 set_workspace 同款。
    http.register("POST /wizard/stop", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { tag?: string; mode?: string; forget?: boolean };
      const r = resolvePeer(self, b.tag ?? "");
      if (!r.ok) { json(res, r.status, { ok: false, reason: r.reason, candidates: r.candidates }); return; }
      const { target } = r;
      const victim = briefOf(self, target);
      const end = (b.mode ?? "end") === "end";
      if (!end && target === self) { json(res, 400, { ok: false, reason: "打断自己没有意义 —— 你就是正在生成的那一个" }); return; }
      const done = end ? await m.killPane(target) : await m.interruptPane(target, { teardown: true });
      if (!done.ok) { json(res, 502, { ok: false, target, reason: done.reason }); return; }
      if (end && b.forget) wizards.drop(target);
      notifyChat(target, withTagHeader(target, `${end ? "已结束" : "已打断"} · 由 ${displayName(self)} 发起`));
      json(res, 200, { ok: true, target, name: victim.name, mode: end ? "end" : "interrupt", forgotten: !!(end && b.forget) });
    });

    // 自我交接: 上下文撑不住了, 自己把工作压成简报, 原地 /clear 重开, 再把简报贴
    // 回去。和 /handoff 的区别是**简报由调用方自己写在入参里** —— 它没法在自己
    // 生成的当口再被问一次 (那正是 /handoff 拒绝对自身操作的原因)。所以这里先应答,
    // 等它这一轮说完、pane 空下来再动手。
    http.register("POST /wizard/handoff-self", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const brief = ((body as { brief?: string }).brief ?? "").toString().trim();
      if (brief.length < 40) { json(res, 400, { ok: false, reason: "brief 太短 —— 要写到零上下文也能接手: 目标 / 已完成 / 当前状态 / 下一步 / 关键文件与坑" }); return; }
      const info = m.sessionInfo(self);
      json(res, 200, { ok: true, target: self, contextTokens: info?.contextTokens ?? 0, scheduled: true });
      // 应答之后再干活: 调用方此刻还在生成, 必须等它把话说完。
      void (async () => {
        const lg = log.child({ mod: "wizard", sub: "handoff-self", target: self });
        const idle = await waitForIdle(self, m.isBusy, 10 * 60_000, () => false);
        if (!idle.idle) { lg.warn({ reason: idle.reason }, "self-handoff: 目标一直忙, 放弃"); return; }
        const clr = await m.injectText(self, "/clear");
        if (!clr.ok) { lg.warn({ reason: clr.reason }, "self-handoff: /clear 注入失败"); return; }
        await new Promise((r2) => setTimeout(r2, 3000));
        const carry = `以下是你自己上一段会话压缩出来的交接简报, 据此无缝接着干:\n\n${brief}`;
        const inj = await m.injectText(self, carry);
        lg.info({ ok: inj.ok, reason: inj.reason }, "self-handoff: 完成");
        notifyChat(self, withTagHeader(self, `上下文已交接重开 (${info?.contextTokens ?? 0} tok → 0), 工作照旧`));
      })();
    });

    // ── Topic pub/sub (MCP-driven) ─────────────────────────────────────
    // 订阅/退订/列表/定时/取消 全部走 MCP,不再有 IM 文本命令。self 复用 peer
    // 路由的解析链(target → sessionId → tmuxPane → defaultChat),把调用方所在
    // 的聊天当作订阅者。即时广播是订阅者无关的,复用全局 POST /publish,不在这里
    // 另开。持久化与 startScheduler 定时器不变。
    const topicOf = (body: PeerBody): string => ((body as { topic?: string }).topic ?? "").trim();

    http.register("POST /topics/subscribe", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const topic = topicOf(body);
      if (!topic) { json(res, 400, { ok: false, reason: "topic required" }); return; }
      const r = subscribeTopic(cfg, sourcePath, topic, self);
      json(res, 200, { ok: true, ...r, topic, target: self, subs: (cfg.topics.subs[topic] ?? []).length });
    });

    http.register("POST /topics/unsubscribe", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const topic = topicOf(body);
      if (!topic) { json(res, 400, { ok: false, reason: "topic required" }); return; }
      const r = unsubscribeTopic(cfg, sourcePath, topic, self);
      json(res, 200, { ok: true, ...r, topic, target: self });
    });

    // List = 本聊天订阅了哪些 topic + 全部定时广播(scheduler 是进程级的)。
    http.register("POST /topics/list", async (req, res) => {
      const { self } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      json(res, 200, { ok: true, target: self, subs: listSubs(cfg, self), schedules: listSchedules(cfg) });
    });

    http.register("POST /topics/schedule", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const topic = topicOf(body);
      const b = body as { hour?: number; minute?: number; content?: string };
      const hour = Number(b.hour);
      const minute = Number(b.minute ?? 0);
      const content = (b.content ?? "").toString();
      if (!topic) { json(res, 400, { ok: false, reason: "topic required" }); return; }
      if (!content.trim()) { json(res, 400, { ok: false, reason: "content required" }); return; }
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) { json(res, 400, { ok: false, reason: "hour must be 0-23" }); return; }
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) { json(res, 400, { ok: false, reason: "minute must be 0-59" }); return; }
      addSchedule(cfg, sourcePath, { topic, hour, minute, content, createdBy: self, createdAt: Date.now() });
      json(res, 200, { ok: true, topic, hour, minute, subs: (cfg.topics.subs[topic] ?? []).length });
    });

    http.register("POST /topics/cancel-schedule", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const topic = topicOf(body);
      if (!topic) { json(res, 400, { ok: false, reason: "topic required" }); return; }
      const removed = removeSchedulesByTopic(cfg, sourcePath, topic);
      json(res, 200, { ok: true, topic, removed });
    });

    // POST /config/set — modify daemon config from MCP
    http.register("POST /config/set", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as { key?: string; value?: unknown; action?: string };
      const { configSet } = await import("./config-api.js");
      const r = configSet(cfg, sourcePath, body.key, body.value, body.action);
      json(res, r.ok ? 200 : 400, r);
    });

    http.register("POST /config/get", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as { key?: string };
      const { configGet } = await import("./config-api.js");
      const r = configGet(cfg, body.key);
      json(res, r.ok ? 200 : 400, r);
    });

    // POST /graph/run — declare a loop graph over this chat's tagged sessions
    // and start walking it. Fire-and-forget: returns a runId immediately, then
    // narrates progress into the chat while it advances.
    http.register("POST /graph/run", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{
        target: string; sessionId: string; tmuxPane: string;
        nodes: GraphNodeSpec[]; steps: GraphStepSpec[];
        rounds: number; until: string; idleTimeoutSec: number;
      }>;
      const self = resolveSelf(body);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const spec: GraphSpec = {
        base: baseOfKey(self),
        nodes: Array.isArray(body.nodes) ? body.nodes : [],
        steps: Array.isArray(body.steps) ? body.steps : [],
        rounds: body.rounds,
        until: body.until,
        idleTimeoutSec: body.idleTimeoutSec,
      };
      const bad = validateSpec(spec);
      if (bad) { json(res, 400, { ok: false, reason: bad }); return; }
      const graphLog = log.child({ mod: "graph", base: spec.base });
      const run = startGraph(spec, {
        // Reuse a live tagged pane; only spawn when the node doesn't exist yet
        // (or its pane died). Re-spawning a healthy node would throw away the
        // context that makes a multi-round loop worth running.
        ensureNode: async (target, node) => {
          const existing = (await m.peers(target)).find((p) => p.target === target);
          if (existing?.paneAlive) return { ok: true };
          // No broadcast plumbing needed: a `base#tag` target strips down to the
          // same WeCom chatid as `base`, so the node's own pushes already land
          // in this chat — mirroring them again was pure duplication.
          const r = await m.newSession(target, node.tag, node.cli, { model: node.model, cwd: node.cwd, silent: true });
          return { ok: r.ok, reason: r.reason };
        },
        send: (target, text, origin) => m.injectText(target, text, origin),
        isBusy: m.isBusy,
        lastText: async (target) => m.lastText(target),
        notify: notifyChat,
        log: graphLog,
      });
      json(res, 200, { ok: true, runId: run.runId, base: run.base, nodes: spec.nodes.length, steps: spec.steps.length, rounds: spec.rounds ?? 1 });
    });

    http.register("GET /graph/status", (req, res) => {
      const u = new URL(req.url ?? "", "http://x");
      const runId = (u.searchParams.get("runId") ?? "").trim();
      if (runId) {
        const run = getRun(runId);
        json(res, run ? 200 : 404, run ? { ok: true, run } : { ok: false, reason: `unknown runId ${runId}` });
        return;
      }
      const base = (u.searchParams.get("target") ?? "").trim();
      json(res, 200, { ok: true, runs: listRuns(base ? baseOfKey(base) : undefined) });
    });

    http.register("POST /graph/stop", async (req, res) => {
      const { readBody } = await import("./http.js");
      const body = (await readBody(req)) as Partial<{ runId: string }>;
      const runId = (body.runId ?? "").trim();
      if (!runId) { json(res, 400, { ok: false, reason: "runId required" }); return; }
      const stopped = stopRun(runId);
      json(res, stopped ? 200 : 404, stopped ? { ok: true, runId } : { ok: false, reason: `run ${runId} not found or already finished` });
    });

    http.register("GET /mirror/cwd", async (req, res) => {
      const u = new URL(req.url ?? "", "http://x");
      let target = (u.searchParams.get("target") ?? "").trim();
      const sid = (u.searchParams.get("sessionId") ?? "").trim();
      const pane = (u.searchParams.get("tmuxPane") ?? "").trim();
      if (!target && sid) {
        const t = m.targetForSession(sid);
        if (t) target = t;
      }
      if (!target && pane) {
        const t = m.targetForPane(pane);
        if (t) target = t;
      }
      if (!target) target = (cfg.defaultChat ?? "").trim();
      if (!target) { json(res, 400, { ok: false, reason: "target required (or pass sessionId)" }); return; }
      json(res, 200, { ok: true, target, ...m.getCwd(target) });
    });
  }

  // 事件订阅调度器 — 每 20s 检查 topics.schedules,匹配当前分钟即广播。
  const scheduler = startScheduler({ client: ws.client, cfg, log: log.child({ mod: "topics" }) });

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutdown signal");
    scheduler.stop();
    netWatch.stop();
    // 同 POST /shutdown: 先把挂着的审批长轮询了结成「稍后续接」, 再关连接。
    log.info(drainForReload(), "pending drained for reload");
    // Hard-exit watchdog: http.close() blocks until every in-flight connection
    // (long-poll approvals, keep-alive) drains, which can hang forever. SIGTERM
    // (launchctl bootout / systemctl stop) must never wedge on that — force exit.
    setTimeout(() => process.exit(0), 1500).unref();
    await new Promise((r) => setTimeout(r, 200));
    await Promise.allSettled([ws.shutdown(), http.close()]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await ws.ready;
    log.info("daemon ready");
  } catch (e) {
    log.fatal({ err: (e as Error).message }, "WS fatal — exiting");
    fatalExit("WS fatal", { err: (e as Error).message });
  }
};

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("[wezard-daemon] fatal:", e);
  process.exit(1);
});
