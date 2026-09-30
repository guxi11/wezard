// Daemon entry. Resident process — exits only on signal or fatal WS auth failure.
import { homedir } from "node:os";
import { loadConfig } from "../shared/config.js";
import { makeLogger } from "../shared/log.js";
import { bindCliBackends, type CliBackendName } from "../shared/cli-backends.js";
import { startWs } from "./ws.js";
import { startNetWatch } from "./net-watch.js";
import { startHttp, json, readBody } from "./http.js";
import { configGet, configSet } from "./config-api.js";
import { installInboundRouter } from "./inbound.js";
import { loadMirrorStore } from "./mirror-store.js";
import { startMirror, installMirrorEventListener } from "./mirror-bridge.js";
import { setTmuxTimeoutReporter, spawnTmuxClaude } from "./spawn-tmux.js";
import { installApprovalEventListener, makeApproveHandler } from "./approval.js";
import { initDetailPersistence, makeDetailHandler, chatHandlers, configureRemoteForward, chatUrlFor, setWorldFactsProvider } from "./detail.js";
import { EMPTY_FACTS, type WorldFacts, type WorldFactWizard } from "../shared/world.js";
import { initAutoWindowPersistence } from "./session-cache.js";
import { makeMessageHandler } from "./outbound.js";
import { makeCardHandler, makeAskHandler, installAskEventListener } from "./ask.js";
import { drainForReload, listPending } from "./pending.js";
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
  migrateLegacySchedules,
  promptWantsFreshWizard,
  renderTask,
  sinceOf,
} from "./tasks.js";
import { openTaskRegistry } from "./task-registry.js";
import { describeTrigger, nextFire, parseTrigger, WHEN_HELP } from "../shared/trigger.js";
import { slugify, uniqueId } from "../shared/task-file.js";
import { baseOfKey, bindTagLinker, keyOf, linkTags, normalizeTag, tagFromCwd, tagHead, tagLink, tagOfKey, uniqueTag, withTagHeader } from "../shared/session-label.js";
import { clipForCharter, inboxPath, memoryPath, memoryRoot, proposeMemory, readMemory, type MemoryScope } from "./wizard-memory.js";
import { ensureStewardTask } from "./memory-steward.js";
import { applyChatNames, chatBaseOf, chatNameOf, clearChatName, listChatNames, normChatName, peerAddress, planChatNames, setChatName } from "./chat-name.js";
import {
  bindWizardStore,
  loadWizardStore,
  wizardStore,
  settleName,
  settleAll,
  evictStaleName,
  childrenOf,
  ancestorsOf,
  renderCharter,
  renderRoster,
  type WizardBrief,
  type WizardRecord,
} from "./wizard.js";
import { bindNoticeBox, createNoticeBox, chatAudience } from "./notices.js";
import { loadJobStore, renderJobOpen, renderJobClose, JOB_MEMBER_MAX } from "./jobs.js";
import { clipMiddle, extractResult, keepalivePingSigs, lastExchange, lastModel, renderPeerEnvelope, renderTaskEnvelope } from "./peers.js";
import { parseWhen, renderChatLog, type LogSession } from "./chat-log.js";
import {
  startGraph,
  stopRun,
  getRun,
  listRuns,
  validateSpec,
  waitForIdle,
  waitForQuorum,
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

  // 定时调度器的 `inject` 真正实现, 赋值在 mirror-mode 的大块里 (要用到那里面的
  // wizards / m / notifyChat), 但 startScheduler 在那块外面接线 —— 见文件尾。
  let scheduledTaskInject:
    | ((target: string, text: string, opts: { taskId: string; fresh: boolean }) => Promise<{ ok: boolean; reason?: string }>)
    | undefined;

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
  const mirrorStore = loadMirrorStore(cfg.wrc.mirror.attachmentsFile);
  // 定时任务表 —— 每条任务是 ~/.wezard/tasks/<id>.task.mjs 一份可注入代码的配置
  // (见 shared/task-file.ts)。目录是热加载的: wizard 改完文件不用 reload 守护进程。
  // 共享记忆的整理者是一条定时任务 (memory-steward.ts), 缺了就补一份默认的。
  try { ensureStewardTask(memoryRoot(cfg.daemon.stateDir)); } catch (e) { log.warn({ err: (e as Error).message }, "memory steward task not written"); }
  const tasks = await openTaskRegistry(
    log.child({ mod: "tasks" }),
    (added, removed) => log.info({ added, removed }, "task files changed"),
  );
  const bridge = startMirror({ cfg, log: log.child({ mod: "mirror" }), client: ws.client, store: mirrorStore });
  // 群里每个 `.name` 都挂它的 rolepage (见 session-label 的 TagLinker)。正文提及
  // 只认真有其人的 —— 随手写的 `.gitignore` 不该变成一个开在空栏上的链接。
  const known = (t: string): boolean => bridge.chatTargets(t).includes(t);
  // 名册在下面的 mirror 块里才绑 (bindWizardStore) —— 这里全走 wizardStore() 惰性取。
  bindTagLinker({
    urlOf: (t) => chatUrlFor(cfg.daemon, t, baseOfKey(t).replace(/^(user|chat|group):/, "")),
    resolve: (name) => {
      const t = wizardStore()?.byName(name)?.target;
      return t && known(t) ? t : undefined;
    },
    nameOf: (t) => settleName(wizardStore(), chatNameOf(cfg, t), t),
  });
  installInboundRouter(ws.client, cfg, log, bridge, sourcePath);
  // approval click → finalize 当前 liveStream, 后续 tool/text 落到 standalone。
  // 规则 2: 用户点击授权那一刻就是"上一段对话"的边界, 截断 stream 让授权后的
  // 工作单独成块, 比让 stream 一直长到下一个 inbound / hardTimer 更清晰。
  const onApproved = (sid: string): void => bridge.terminateLiveStream(sid);
  installApprovalEventListener(ws.client, log.child({ mod: "approval" }), cfg, onApproved);
  // Route approval cards to the WeCom chat bound to the requesting session.
  // — the chat this session's pane is attached to. Falls back to
  // cfg.approval.approvers / cfg.defaultChat when nothing is bound.
  const getMirrorTarget = (sid: string): string | undefined => bridge.targetForSession(sid);
  // Pre-card barrier: drain pending mirror text/tool markdown for this session
  // and await its FIFO so vote/approval cards never overtake the "thinking" bubble.
  const flushBeforeCard = (sid: string, expect?: { toolName: string; toolInput: unknown }): Promise<void> =>
    bridge.flushBeforeCard(sid, expect);
  // `.claude/**` 写守卫要用的四个 pane 原语。cancel/tell 复用现成的 target 级方法
  // (先 sessionId → target 再调), 只有 hasPane / answerNativeModal 是 pane 级新增。
  const nativeModal = {
    hasPane: (sid: string): boolean => bridge.hasLivePane(sid),
    answer: (sid: string, opts: { waitMs: number }) => bridge.answerNativeModal(sid, opts),
    cancel: async (sid: string): Promise<{ ok: boolean; reason?: string }> => {
      const t = bridge.targetForSession(sid);
      return t ? await bridge.interruptPane(t) : { ok: false, reason: "no mirror target for session" };
    },
    tell: async (sid: string, text: string): Promise<{ ok: boolean; reason?: string }> => {
      const t = bridge.targetForSession(sid);
      return t ? await bridge.injectText(t, text) : { ok: false, reason: "no mirror target for session" };
    },
  };
  const http = startHttp({ cfg, ws, log, sourcePath });
  http.register(
    "POST /approve",
    makeApproveHandler({ cfg, log: log.child({ mod: "approval" }), client: ws.client, sourcePath, getMirrorTarget, flushBeforeCard, nativeModal }),
  );
  http.register("POST /message", makeMessageHandler(ws.client, log.child({ mod: "outbound" })));
  http.register("POST /card", makeCardHandler(ws.client, log.child({ mod: "outbound" })));
  http.register("POST /ask", makeAskHandler(ws.client, log.child({ mod: "ask" })));
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
      const body = (await readBody(req)) as Partial<{ category: string }>;
      bridge.invalidate(body.category?.trim() || undefined);
      json(res, 200, { ok: true });
    });
    wedocLog.info("wedoc bridge ready");
  }

  // Mirror-mode: status + the spawn/switch routes the chat side drives.
  {
    const m = bridge;
    installMirrorEventListener(ws.client, m, log.child({ mod: "mirror" }));
    http.register("GET /mirror/status", (_req, res) => json(res, 200, m.status()));
    // Manual auto-spawn trigger — used by `wezard init` to materialize a
    // tmux+claude pane immediately after claim, instead of waiting for the
    // first inbound. Body: { target?: "user:xxx" | "chat:xxx" }. Falls back
    // to cfg.defaultChat. Same code path as the inbound auto-spawn so any
    // future fix benefits both.
    http.register("POST /mirror/spawn", async (req, res) => {
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
      const body = (await readBody(req)) as Partial<{ cwd: string; name: string; tag: string; chat: string; target: string; sessionId: string; tmuxPane: string; cli: CliBackendName; model: string; keepalive: boolean }>;
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
      const slotR = await claimSlot(base, String(body.name ?? body.tag ?? ""), tagFromCwd(cwd) || "peer", [self]);
      if (!slotR.ok) { json(res, slotR.status, slotR.body); return; }
      const { target, slot: tag } = slotR;
      const existed = !!wizards.get(target);
      const name = wizards.rename(target, normalizeTag(String(body.name ?? body.tag ?? "")) || tag);
      const model = (body.model ?? "").toString().trim();
      // 没点名就按配置的 keepalive.spawnDefault 来 —— 调用方明说的永远优先。
      const keepalive = typeof body.keepalive === "boolean" ? body.keepalive : cfg.wrc.mirror.keepalive.spawnDefault;
      log.child({ mod: "mirror", sub: "sessions-new", target }).info({ self, cwd, foreign, cli: body.cli, model, keepalive }, "spawning peer session");
      const r = await m.newSession(target, name, body.cli, { cwd, model, keepalive });
      if (!r.ok && !existed) wizards.drop(target);
      // r.model 是 spawnTmuxClaude 通过 /model 实测确认落地的那个 —— 可能跟调用方
      // 传的原始字符串不一样 (口语化 → 目录里匹配到的关键词), 播报要报实情。
      const modelNote = r.model
        ? (r.modelWarning ? ` · 模型 ${r.model} (⚠️ ${r.modelWarning})` : ` · 模型 ${r.model}`)
        : "";
      if (r.ok) postRoster(base, [target, self], `新 wizard **.${name}** 就位${r.cwd ? ` · 工作区 ${r.cwd}` : ""}${modelNote}${keepalive ? "" : " · 已关闭 keepalive"} —— 空白起步, 由 ${displayName(self)} 造的`);
      json(res, r.ok ? 200 : 500, r.ok
        ? {
            ok: true,
            sessionId: r.sessionId,
            self,
            target,
            base,
            name,
            cwd: r.cwd,
            ...(r.model ? { model: r.model } : {}),
            ...(r.modelWarning ? { modelWarning: r.modelWarning } : {}),
            foreign,
            keepalive,
            // 调用方之后拿这个串 send_peer / peek_peer 驱动它。
            address: peerAddress(cfg, self, target),
          }
        : { ok: false, reason: r.reason });
    });
    // Frame-less inject — used by `wezard init` to fire a demo prompt right
    // after /mirror/spawn so first-time users see the full PreToolUse → card
    // → mirror loop without needing to type in WeCom.
    http.register("POST /mirror/inject", async (req, res) => {
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
      const body = (await readBody(req)) as Partial<{ target: string; sessionId: string; tmuxPane: string; cwd: string; keep: boolean }>;
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
      // keep = 人回答了「不用换, 就用现在这个」。只落一笔确认, 不碰 pane —— 把
      // 「保持现状」也走成 setPendingCwd + newSession 的话, 代价是白杀一个会话。
      if (body.keep === true) {
        const c = m.confirmCwd(target);
        json(res, c.ok ? 200 : 400, c.ok ? { ok: true, target, cwd: c.cwd, confirmed: true } : { ok: false, reason: c.reason, target });
        return;
      }
      if (!cwd) { json(res, 400, { ok: false, reason: "cwd required (or keep:true to confirm the current one)" }); return; }
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
      if (self) ensureChatNames(self);
      const roster = self ? m.chatRoster(self) : listChatNames(cfg).map((c) => ({ ...c, self: false, targets: [] }));
      json(res, 200, {
        ok: true,
        self,
        chats: roster.map((c) => ({
          ...c,
          // 每一行带上"它是谁": 只有 target/tag/address 的话, 想知道哪个会话
          // 是干什么的就得再拉一次三百条的名册。名字/职责取注册表, 工作区取
          // store —— 都是内存里的, 不探 tmux。
          sessions: c.targets.map((t) => ({
            target: t,
            tag: tagOfKey(t),
            address: self ? peerAddress(cfg, self, t) : t,
            name: settleName(wizards, chatNameOf(cfg, t), t),
            description: wizards.get(t)?.description ?? "",
            cwd: m.getCwd(t).runningCwd || m.getCwd(t).defaultCwd,
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
      if (!r.ok) { json(res, 409, { ok: false, reason: r.reason }); return; }
      // 默认 wizard 的名字取自聊天名; 它还叫旧聊天名 (没被单独改过) 就跟着改。
      const home = baseOfKey(self);
      const cur = wizards.get(home)?.name ?? "";
      const wizardRenamed = previous && cur.toLowerCase() === previous.toLowerCase() ? wizards.rename(home, r.name) : undefined;
      json(res, 200, { ok: true, base: r.base, name: r.name, previous, ...(wizardRenamed ? { wizardRenamed } : {}) });
    });

    interface PeerBody { target?: string; sessionId?: string; tmuxPane?: string; name?: string; tag?: string }
    const readPeerBody = async (req: import("node:http").IncomingMessage): Promise<{ self: string; body: PeerBody }> => {
      const body = (await readBody(req)) as PeerBody;
      return { self: resolveSelf(body), body };
    };

    // list_peers 已并进 wizard_roster ({chat}); 路由留着, 是因为正在跑的 wizard 的
    // MCP 进程还是旧代码, 仍会打到这里。
    http.register("POST /peers/list", async (req, res) => {
      const { self } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session (pass target/sessionId/tmuxPane)" }); return; }
      ensureChatNames(self);
      const [peers, foreignPeers] = await Promise.all([m.peers(self), m.foreignPeers(self)]);
      json(res, 200, { ok: true, self, base: baseOfKey(self), peers, foreignPeers });
    });

    // Push a plain markdown bubble into a chat. `base` may carry a `#tag` — a
    // tagged key strips down to the same WeCom chatid as its base.
    // 头不走 withTagHeader 的那些 (relay / notify / 工单) 正文里的 tag 在这里挂链;
    // 已挂过的 linkTags 认得出, 不会再套一层。
    const chatIdOf = (t: string): string => baseOfKey(t).replace(/^(user|chat|group):/, "");
    const notifyChat = (base: string, markdown: string): void => {
      const chatId = chatIdOf(base);
      void ws.client
        .sendMessage(chatId, { msgtype: "markdown", markdown: { content: linkTags(base, markdown) } })
        .catch((e: unknown) => log.warn({ err: (e as Error).message }, "chat notify failed"));
    };
    // wizard 在群里的称呼, 只用在**正文**里。气泡的头照旧交给 withTagHeader ——
    // 那一段是路由信息 (`emoji #tag`), parseTagHeader 靠它反解, 群里引用一条气泡
    // 就能直接跟那个 wizard 说话; 把它换成名字会把这条通路弄断。
    const displayName = (t: string): string => {
      const name = settleName(wizards, chatNameOf(cfg, t), t);
      return name ? `.${name}` : "默认 wizard";
    };

    // wizard 之间的往返默认是私聊, 不进群。只有发话方判断「该当着人说」的那一次
    // (send_peer public:true) 在公开频道里成一条气泡, 头写成 `.a → .b`, 方向一眼可读。
    const RELAY_MAX = 1200;
    /** 一个 wizard 在群里的称呼: `emoji .name`, 挂它的 rolepage。名字全局唯一, 不再
     *  因为落在哪个群而换写法 —— 引用这一段就能跟它说话 (parseTagHeader 认得)。 */
    const relayLabel = (t: string, _dest?: string): string => tagLink(t, tagHead(t));
    /** 公开的 wizard 间对话: 落在 `channel` 这个群。 */
    const relayPeer = (from: string, to: string, body: string, channel: string): void => {
      const text = body.trim();
      if (!text || !channel) return;
      const head = `${relayLabel(from)} → ${relayLabel(to)}`;
      const clipped = text.length > RELAY_MAX ? `${text.slice(0, RELAY_MAX)}…` : text;
      // 头独占一行, 正文自成一个块 —— 只隔一个换行的话, markdown 会把正文首行
      // 当成头那一段的续行; 表格因此整张塌成一行带竖线的文字 (表格不能打断段落)。
      notifyChat(channel, `${head}\n\n${clipped}`);
    };
    /** 调用方这一轮所在的公开频道: 人从哪个群叫的它 / 公开 peer 轮的那个群;
     *  私聊轮或无记录 → 它的 home 群。notify 与 public send_peer 默认发到这里。 */
    const channelOf = (self: string): string => m.currentChannel(self) || baseOfKey(self);
    /** 同伴注入的信封: 公开轮写上那个群的名字, 私聊不写 (见 peers.renderPeerEnvelope)。 */
    const envelopeFor = (from: string, channel: string): string =>
      renderPeerEnvelope(displayName(from), channel ? chatNameOf(cfg, channel) : undefined);
    // 发话时刻 —— wait_peer 拿它把「回复」和「这一次发话」对上 (peers.lastReply)。
    // 纯内存: reload 之后退化成不带关联的旧行为, 不值得为它落盘。
    const sentAt = new Map<string, number>();
    const pairOf = (from: string, to: string): string => `${from}\u0000${to}`;
    const stampSend = (from: string, to: string): void => void sentAt.set(pairOf(from, to), Date.now());
    /** 入参里的地址: 新字段 `name`, 老 MCP 进程 (正在跑的 wizard) 仍在传 `tag`。 */
    const addrOf = (b: { name?: unknown; tag?: unknown }): string => String(b.name ?? b.tag ?? "");

    /** 撞上的名字属于一个静默超过一天的 wizard → 顶掉它 (见 evictStaleName), 同群的
     *  wizard 收到一行名册变动; 返回是否腾出了名字。 */
    const displace = async (name: string, keep: readonly string[]): Promise<boolean> => {
      const gone = await evictStaleName(wizards, name, keep, { lastActivity: m.lastActivity, retire: m.killPane });
      if (!gone) return false;
      const slot = !!tagOfKey(gone.target);
      log.child({ mod: "wizard" }).info({ target: gone.target, name: gone.name, slot }, "stale name evicted");
      postRoster(baseOfKey(gone.target), [], `**.${gone.name}** 静默超过一天, ${slot ? "已被同名的新 wizard 顶掉并收工" : "名字让给了同名的新 wizard"}`);
      return true;
    };

    /** 给一个要出生的 wizard 挑槽位 (target key) 并落定名字。名字全局唯一:
     *  - 撞上的只是目标群里同一个槽位的冷记录 (会话早没了) → 复用这个槽, 即原名重生,
     *    与从前「同一个 tag 重开」一样, 家谱/记忆都还在;
     *  - 撞上的 wizard 静默超过一天 (不在 `keep` 里) → 顶掉它, 名字归新的;
     *  - 其余 (还新鲜的) → 409, 附上它的死活, 调用方据此换名或先收掉它。
     *  槽位 (key 里的 `#k`) 只是内部 id: 默认取名字本身, 被占了就加序号, 与名字无关。 */
    const claimSlot = async (
      base: string,
      want: string,
      fallback: string,
      keep: readonly string[] = [],
    ): Promise<{ ok: true; target: string; slot: string } | { ok: false; status: number; body: Record<string, unknown> }> => {
      const asked = normalizeTag(want);
      const clash = asked ? wizards.byName(asked) : undefined;
      const bound = !!clash && m.chatTargets(baseOfKey(clash.target)).includes(clash.target);
      if (clash && !bound && baseOfKey(clash.target) === base && tagOfKey(clash.target)) {
        return { ok: true, target: clash.target, slot: tagOfKey(clash.target) };
      }
      if (clash && !(await displace(asked, keep))) {
        const info = bound ? (await m.peers(clash.target)).find((p) => p.target === clash.target) : undefined;
        const alive = info?.paneAlive ?? false;
        const idleForMs = info?.lastActivity ? Date.now() - info.lastActivity : undefined;
        const idleDesc = idleForMs !== undefined ? `静默 ${Math.round(idleForMs / 60000)} 分钟` : "从没动过";
        const advice = alive
          ? "它的 pane 还活着 —— 除非这就是同一件事的延续, 否则换个名字重新生, 别把不相关的活塞给一个已经有职责的 wizard"
          : bound
            ? `pane 已经不在了 (${idleDesc}), 真要复用这个名字就先 stop_wizard({name:"${clash.name}", mode:"end"}) 收掉, 再用同一个名字重新生 —— 拿到干净的上下文; 别直接 send_peer 唤醒它接手, 它会带着上一件事的记忆答你这件`
            : "这个名字被一个一天内还活动过、眼下没有会话的 wizard 占着 —— 换个名字 (它静默满一天后名字会自动让出)";
        return {
          ok: false,
          status: 409,
          body: {
            ok: false,
            reason: `名字 '.${clash.name}' 已经属于一个${alive ? "活着的" : "不再活跃的"} wizard (名字全局唯一) —— ${advice}`,
            name: clash.name,
            address: clash.name,
            alive,
            busy: info?.busy ?? false,
            idleForMs,
          },
        };
      }
      const taken = new Set([
        ...m.chatTargets(base).map(tagOfKey),
        ...wizards.all().filter((w) => baseOfKey(w.target) === base).map((w) => tagOfKey(w.target)),
      ].filter(Boolean));
      const slot = uniqueTag(asked || normalizeTag(fallback) || "wizard", taken);
      return { ok: true, target: keyOf(base, slot), slot };
    };

    // ── 给人看的消息 ──────────────────────────────────────────────────
    // send_peer 把话塞进另一个 agent 的输入框 (驱动它干活); 这条把话贴进一个聊天
    // 给**人**看。收件人就是地址 —— 聊天名或裸 principal, 没有「先订阅才收得到」
    // 这一步。头沿用 relay 那一套: 本群退化成寻常的 `emoji #tag`, 外群写成带聊天
    // 名的全称, 于是那边的人一眼看得出是谁、从哪个群说过来的。
    http.register("POST /notify", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { to?: string[]; markdown?: string };
      const content = (b.markdown ?? "").trim();
      if (!content) { json(res, 400, { ok: false, reason: "markdown required" }); return; }
      // 收件人写的就是名字 —— 补名必须发生在解析之前, 否则一个刚被别处命名的聊天
      // 在这里仍然认不出来。
      ensureChatNames(self);
      // 认不出的名字原样报回去, 绝不静默跳过 ——「发了但没人收到」是这类工具最难查
      // 的故障; 有一个收件人错了整条就不发, 部分送达比不送达更难对账。
      const refs = (b.to ?? []).map((r) => (r ?? "").trim()).filter(Boolean);
      const bad = refs.filter((r) => !chatBaseOf(cfg, r));
      if (bad.length) {
        json(res, 400, { ok: false, reason: `认不出这些聊天: ${bad.join(", ")} (list_chats 看有哪些; 没起名的聊天寻址不到)` });
        return;
      }
      const dests = [...new Set(refs.length ? refs.map((r) => chatBaseOf(cfg, r)) : [channelOf(self)])];
      for (const dest of dests) notifyChat(dest, `${relayLabel(self)}\n\n${content}`);
      json(res, 200, { ok: true, sent: dests.map((d) => chatNameOf(cfg, d) || d) });
    });

    http.register("POST /peers/peek", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const r = resolvePeer(self, addrOf(body));
      if (!r.ok) { json(res, r.status, { ok: false, reason: r.reason, candidates: r.candidates }); return; }
      const { target, foreign } = r;
      const turns = Math.min(Math.max(Number((body as { turns?: number }).turns ?? 6) || 6, 1), 40);
      // 对话只从 transcript 读 (正文轮次, 去掉保温 ping/pong), 不刮终端: pane 是
      // 截断的视口加一层 TUI 装饰, 而「它卡在哪」transcript 答得更准 —— 不在转圈
      // 却悬着工具调用, 就是停在审批卡 / 本地弹窗上等人点。
      const peek = await m.peekTurns(target, turns);
      const waiting = peek.waiting ?? [];
      const state = peek.busy
        ? "正在生成"
        : waiting.length
          ? `停在 ${waiting.join(" / ")} 上 —— 工具调用发出去了还没结果, 多半在等人点审批卡或本地弹窗`
          : "空闲";
      json(res, 200, {
        ok: true,
        name: peerAddress(cfg, self, target),
        busy: peek.busy ?? false,
        ...(waiting.length ? { waiting } : {}),
        text: [`${displayName(target)} · ${state}${foreign ? ` · 住在群 ${chatNameOf(cfg, target) || "(未命名)"}` : ""}`, peek.dialog ?? `(${peek.reason})`].join("\n"),
      });
    });

    // ── 聊天记录 ────────────────────────────────────────────────────────
    // peek_peer 读的是**一个会话**听到和说过的一切; 这条读的是**往来**: 三级收窄
    // role (谁的视角) → chat (哪个群) → target (和谁), 再按时间窗与条数裁 —— 与
    // rolepage 同一条轴。全部从各会话的 transcript 现算 (见 chat-log.ts), 不经 turn
    // store。名字全局可达, 一句话可能落在任何一个会话的 transcript 里 (A 对 B 说的
    // 在 B 那份), 所以候选是全体; 按 mtime 只留最近动过的那一批 (一次 stat, 不
    // spawn), 点了名的 role / target 与调用方自己无条件入选。
    const LOG_RECENT_MS = 7 * 24 * 3600_000;
    const LOG_SESSIONS = 40;
    const logSession = (t: { target: string; jsonlPath: string }): LogSession => {
      const home = baseOfKey(t.target);
      const rec = wizards.get(t.target);
      return {
        name: displayName(t.target),
        jsonlPath: t.jsonlPath,
        homeChat: chatNameOf(cfg, home),
        homeHuman: home.startsWith("user:") ? home.slice(5) : "人",
        since: rec?.clonedFrom ? rec.bornAt : 0,
      };
    };
    /** role / target 的写法: wizard 的名字解析成它的称呼; 解析不出的原样当作人的
     *  userid (或 `定时 <id>`) —— 记录里人就是按这个字面出现的。 */
    const logRole = (self: string, ref: string): { name: string; target?: string } => {
      const r = resolvePeer(self, ref);
      return r.ok ? { name: displayName(r.target), target: r.target } : { name: ref };
    };

    http.register("POST /chats/read", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      // 线上字段是 `with`: 请求体里的 `target` 已经是「调用方是谁」的覆盖 (resolveSelf)。
      const b = body as { role?: string; chat?: string; with?: string; since?: string; until?: string; limit?: number; per?: number };
      ensureChatNames(self);
      const now = Date.now();
      const [roleRef, chatRef, targetRef, sinceRef, untilRef] = [b.role, b.chat, b.with, b.since, b.until].map((x) => (x ?? "").toString().trim());
      // 什么都没给 = 调用方这一轮所在的群; 只给 target = 调用方与它的往来。
      const base = chatRef ? chatBaseOf(cfg, chatRef) : roleRef || targetRef ? "" : channelOf(self);
      if (chatRef && !base) { json(res, 404, { ok: false, reason: `认不出聊天 '${chatRef}' (list_chats 看有哪些)` }); return; }
      const role = roleRef ? logRole(self, roleRef) : targetRef ? { name: displayName(self), target: self } : undefined;
      const target = targetRef ? logRole(self, targetRef) : undefined;
      const since = sinceRef ? parseWhen(sinceRef, now) : undefined;
      const until = untilRef ? parseWhen(untilRef, now) : undefined;
      if ((sinceRef && since === undefined) || (untilRef && until === undefined)) {
        json(res, 400, { ok: false, reason: "时间认不出 —— 写 `2h` / `30m` / `3d` (多久以前)、`14:30` (今天)、`09-30 14:30` 或 ISO 时间" });
        return;
      }
      const limit = Math.min(Math.max(Number(b.limit ?? 30) || 30, 1), 200);
      const per = Math.min(Math.max(Number(b.per ?? 500) || 500, 40), 4000);
      const pinned = new Set([self, role?.target, target?.target]);
      const all = m.transcripts();
      // 两方之间的话只可能落在这两方里的 wizard 自己的 transcript 里 (人没有 transcript)
      // —— 不必去翻别的会话, 「往回还有没有」也因此答得准。
      const between = [role?.target, target?.target].filter((t): t is string => !!t);
      const sessions = role && target && between.length
        ? all.filter((t) => between.includes(t.target))
        : [
            ...all.filter((t) => pinned.has(t.target)),
            ...all.filter((t) => !pinned.has(t.target) && now - t.mtime < LOG_RECENT_MS).sort((x, y) => y.mtime - x.mtime).slice(0, LOG_SESSIONS),
          ];
      const chat = base ? chatNameOf(cfg, base) : undefined;
      const log_ = renderChatLog(
        sessions.map(logSession),
        { role: role?.name, chat, target: target?.name, since, until, limit, per },
        keepalivePingSigs(cfg.wrc.mirror.keepalive.ping),
        now,
      );
      const scope = [
        chat !== undefined ? `${base.startsWith("user:") ? "单聊" : "群"} ${chat || base}` : "",
        role && target ? `${role.name} ⇄ ${target.name}` : role ? `${role.name} 的往来` : "",
      ].filter(Boolean).join(" · ");
      json(res, 200, {
        ok: true,
        shown: log_.shown,
        total: log_.total,
        text: [
          `${scope} · ${log_.shown} 条`,
          log_.text || "(没有读到对话)",
          ...(log_.earlier ? [`更早的: until="${log_.earlier}"`] : log_.later || !log_.shown ? [] : ["(往回已经到头)"]),
          ...(log_.later ? [`往后还有 ${log_.total - log_.shown} 条: since="${log_.later}"`] : []),
        ].join("\n"),
      });
    });

    http.register("POST /peers/send", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const text = ((body as { text?: string }).text ?? "").toString();
      if (!text.trim()) { json(res, 400, { ok: false, reason: "text required" }); return; }
      const jobId = ((body as { job?: string }).job ?? "").trim();
      if (jobId) {
        const jc = checkJob(jobId);
        if (!jc.ok) { json(res, jc.status, { ok: false, reason: jc.reason }); return; }
      }
      const r = resolvePeer(self, addrOf(body));
      if (!r.ok) { json(res, r.status, { ok: false, reason: r.reason, candidates: r.candidates }); return; }
      const { target, foreign } = r;
      // 公开与否由发话方 (LLM) 判断: 公开 = 在它这一轮的公开频道里说, 气泡进群、对方
      // 那一轮的回复也发进这个群; 私聊 (默认) = 只落双方的 rolepage, 回复靠 wait_peer 取。
      const isPublic = (body as { public?: boolean }).public === true;
      const channel = isPublic ? channelOf(self) : "";
      // Injecting into your own pane would type into the box you're generating
      // from — Claude Code queues it and the caller deadlocks waiting for itself.
      if (target === self) { json(res, 400, { ok: false, reason: "refusing to inject into the calling session itself" }); return; }
      // 投递时机。默认照旧立刻投 —— 「回答它的提问」「打断它」本来就是冲着一个
      // 正在忙的会话去的。`when:"idle"` 是**派新活**该用的那一种: 两个 wizard 同时
      // 找第三个时, 两段文本会挤进同一个输入框、被当成一轮读掉, 这在协同网络里
      // 不是边角情况而是常态。等它闲下来再投, 一句话就是一轮。
      const when = ((body as { when?: string }).when ?? "now") === "idle" ? "idle" : "now";
      const waitSec = Math.min(Math.max(Number((body as { waitSec?: number }).waitSec ?? 600) || 600, 10), 3600);
      const wasBusy = await m.isBusy(target);
      let waitedMs = 0;
      if (when === "idle" && wasBusy) {
        const t0 = Date.now();
        // rampMs=0: ramp 是给「刚注入、这一轮还没起来」准备的; 这里相反, 一旦它
        // 真闲下来就该立刻投。
        const wr = await waitForIdle(target, m.isBusy, waitSec * 1000, () => false, { rampMs: 0, confirm: 2 });
        waitedMs = Date.now() - t0;
        if (!wr.idle) {
          json(res, 409, { ok: false, target, foreign, wasBusy, waitedMs, reason: `它一直在忙, ${waitSec}s 内没闲下来 —— peek_peer 看看它卡在哪, 或者用 when:"now" 插队` });
          return;
        }
      }
      stampSend(self, target);
      const inj = await m.injectText(target, text, undefined, {
        from: { kind: "peer", from: self, ...(jobId ? { job: jobId } : {}), ...(isPublic ? { public: true } : {}) },
        channel,
        envelope: envelopeFor(self, channel),
      });
      // 工单成员照旧记账 (收工那一条会列出各自那段活); 公开的那一句在群里成气泡。
      if (inj.ok && jobId) jobs.attach(jobId, { target, task: text, spawned: false });
      if (inj.ok && isPublic) relayPeer(self, target, text, channel);
      // `wasBusy` 是给调用方的判断依据: 立刻投给一个正在生成的会话, 这句话会排在
      // 它这一轮后面, 而不是马上被读到。
      json(res, inj.ok ? 200 : 502, { ...inj, name: peerAddress(cfg, self, target), public: isPublic, wasBusy, ...(waitedMs ? { waitedMs } : {}), ...(jobId ? { job: jobId } : {}) });
    });

    // 等一个 wizard, 或者等一**组**。fan-out 之后 join 必须是并行的: 串行地等五个
    // 分身, 墙钟是五个之和, 而它们本来就在同时干活。`need` 把 all / any / 过半收进
    // 一个数字 (默认全等), 满了就撤掉剩下的等待。
    http.register("POST /peers/wait", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { name?: string; tag?: string; names?: string[]; tags?: string[]; need?: number; timeoutSec?: number };
      const many = Array.isArray(b.names) && b.names.length > 0 ? b.names : b.tags;
      const asked = (Array.isArray(many) && many.length > 0 ? many : [addrOf(b)]).map((x) => String(x ?? ""));
      if (asked.length > 16) { json(res, 400, { ok: false, reason: "一次最多等 16 个 wizard" }); return; }
      // 全部先解析: 地址错了就整批拒绝, 而不是等了十分钟才发现有一个打错了。
      const resolved = asked.map((address) => ({ address, r: resolvePeer(self, address) }));
      const bad = resolved.find((x) => !x.r.ok);
      if (bad && !bad.r.ok) {
        json(res, bad.r.status, { ok: false, reason: `地址 '${bad.address}': ${bad.r.reason}`, candidates: bad.r.candidates });
        return;
      }
      const hits = resolved.map((x) => ({ address: x.address, ...(x.r as { ok: true; target: string; foreign: boolean }) }));
      if (hits.some((h) => h.target === self)) { json(res, 400, { ok: false, reason: "refusing to wait on the calling session itself" }); return; }
      // 同一个 wizard 写两遍不该顶掉两个名额。
      const uniq = hits.filter((h, i) => hits.findIndex((o) => o.target === h.target) === i);
      const need = Math.min(Math.max(Number(b.need ?? uniq.length) || uniq.length, 1), uniq.length);
      const timeoutMs = Math.min(Math.max(Number(b.timeoutSec ?? 900) || 900, 10), 7200) * 1000;
      const wrs = await waitForQuorum(uniq.map((h) => h.target), m.isBusy, timeoutMs, need);
      // 回程不再进群: 私聊的结论由调用方自己收口给人; 公开轮的回复 mirror 早已发进那个群。
      // 载荷只给一份, 且只给该给的那一份 —— 这段 json 是原样进调用方上下文的:
      //   - 只认**这一次发话之后**的回复 (lastReply); 停下了却没有新回复 = `stale`,
      //     绝不把上一件事的答案当成这一件的交回去;
      //   - 它收口了 `RESULT:` → 只回 `result` (从全文里摘, 不受截断影响), 正文不再
      //     重复一遍, `omitted` 说还有多少字没给 (要读就 peek_peer);
      //   - 没收口 → 回 `lastText`, 超长掐中间保住头尾;
      //   - 内部 key (`target`) 与 `foreign` 不回: 模型用不上, 还会被诱导去拼 key。
      const results = uniq.map((h, i) => {
        const wr = wrs[i]!;
        const full = wr.idle ? m.lastReply(h.target, sentAt.get(pairOf(self, h.target)) ?? 0) : "";
        const result = extractResult(full);
        return {
          name: h.address,
          idle: wr.idle,
          ...(wr.reason ? { reason: wr.reason } : {}),
          ...(result
            ? { result, ...(full.length > result.length + 200 ? { omitted: full.length - result.length } : {}) }
            : full
              ? { lastText: clipMiddle(full) }
              : wr.idle
                ? { stale: true, reason: "它停下了, 但自你上次 send_peer 以来没有新回复 —— 多半停在一个等人点的弹窗上, 或那句话没被接住; peek_peer 看一眼" }
                : {}),
        };
      });
      const done = results.filter((x) => x.idle).length;
      // 只等一个就摊平, 等一组才给数组 —— 同一份载荷不出现两遍。
      json(res, 200, results.length === 1
        ? { ok: true, ...results[0]! }
        : { ok: true, need, done, satisfied: done >= need, results });
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
        const r = resolvePeer(self, addrOf(body));
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
    // 一个会话 (`chat:xxx#k`) 从此是一个 wizard: 一个全局唯一的名字 (默认会话出生时
    // 取聊天名, 分身取自己的名字)、一句职责、一份跨会话的记忆、一条家谱。身份不靠"在对话里讲一遍"
    // 维持 —— spawn 时以 `--append-system-prompt` 压进那个进程, `/clear` 抹不掉、
    // 上下文窗口也挤不掉。
    // 这里只做三件事: 读身份、改身份、按身份生/收分身。tmux 一概不碰, 动作全在
    // mirror-bridge。
    const wizards = bindWizardStore(loadWizardStore(cfg.wrc.mirror.wizardsFile));

    // 名册增量的投递面 (见 notices.ts)。charter 只是出生那一刻的快照; 此后的成员
    // 变动从这里搭下一次注入的车进到每个在场 wizard 的上下文里, 不占一轮。
    // 一条变动只投给**同一个聊天**里在场的其他 wizard: 群成员变动是那个群的事,
    // 当事人自己做的自己知道, 所以排除在外。
    const notices = bindNoticeBox(createNoticeBox());
    const postRoster = (base: string, except: readonly string[], line: string): void =>
      notices.post(chatAudience(m.chatTargets(base), base, except), line);

    /** 一个聊天的工作区: 它名下各会话跑在哪个目录, 取最多的那个。聊天与工作区是
     *  一对多, 但绝大多数聊天只围着一个项目转。 */
    const chatCwd = (targets: readonly string[]): string => {
      const counts = targets.reduce<Record<string, number>>((acc, t) => {
        const c = m.getCwd(t).runningCwd;
        return c ? { ...acc, [c]: (acc[c] ?? 0) + 1 } : acc;
      }, {});
      return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    };

    /** 拦在每一个「把名字交给模型」的入口前: 没名字的聊天按它的工作区补一个。
     *
     *  名字就是地址。一个没名字的聊天在别的聊天眼里只有 `chat:wr4-87DwAA…` 这串
     *  key —— 能寻址, 但模型抄错一个字符就找不到, 人更读不出那是哪个群。等人想起来
     *  去 `/name` 是等不到的 (实测 16 个聊天只有 3 个有名字), 而每个聊天本来就带着
     *  一个可读的标识: 它在干哪个项目。所以在这里补, 而不是在某个 spawn 路径上补 ——
     *  聊天是先于 wizard 存在的, 只有"要用到名字"这个时刻才是它必须有名字的时刻。
     *  只填空, 从不覆盖人起过的名字; 推不出名字 (工作区为空) 的原样留着。 */
    const ensureChatNames = (self: string): Record<string, string> => {
      const blank = m.chatRoster(self).filter((c) => !c.name);
      if (blank.length === 0) return {};
      // 会话多的先排 —— 同一个目录下的几个聊天要靠序号区分 (`lisct` / `lisct-2`),
      // 而裸名字该归那个真正在干这个项目的群; 按 chatRoster 的字典序分配的话,
      // 70 个会话的主力群会拿到 `lisct-7`, 一个只有一条冷记录的空群反倒占了裸名。
      const plan = planChatNames(
        cfg,
        blank
          .slice()
          .sort((x, y) => y.targets.length - x.targets.length)
          .map((c) => ({ base: c.base, cwd: chatCwd(c.targets) })),
      );
      const named = applyChatNames(cfg, sourcePath, plan);
      for (const [base, name] of Object.entries(named)) {
        log.info({ base, name }, "chat: auto-named from workspace");
        // 群里不发气泡 (一次补名会命中十几个群, 那是刷屏), 但住在里面的 wizard
        // 得知道自己的地址变了 —— 它的 charter 里写的还是「(未命名)」。
        postRoster(base, [], `这个聊天现在叫 **${name}** (按工作区自动起的) —— notify / new_claude_session 可以用这个名字指到这里。`);
      }
      return named;
    };

    // 名字全局唯一 (见 wizard.ts): 先给没名字的聊天补名, 再按「默认会话先挑」把
    // 每个已知 wizard 的名字落定 —— 老记录 (名字还跟着聊天走的那一代) 在这里一次迁完。
    ensureChatNames(cfg.defaultChat || "");
    settleAll(
      wizards,
      [...m.chatRoster("").flatMap((c) => c.targets), ...wizards.all().map((w) => w.target)],
      (t) => chatNameOf(cfg, t),
    );

    // 工单账本 (见 jobs.ts)。只在**显式传了 `job`** 时起作用 —— 不用工单的调用方
    // 行为与从前一模一样。
    const jobs = loadJobStore(cfg.wrc.mirror.jobsFile);
    /** 派活前先验工单: 生完分身才发现工单号打错了, 那个分身就成了没人认领的孤儿。 */
    const checkJob = (id: string): { ok: true } | { ok: false; status: number; reason: string } => {
      const j = jobs.get(id);
      if (!j) return { ok: false, status: 404, reason: `没有工单 '${id}' —— open_job 先开一个, 或者 list_jobs 看还开着哪些` };
      if (j.status !== "open") return { ok: false, status: 409, reason: `工单 '${id}' 已经收工了` };
      if (j.members.length >= JOB_MEMBER_MAX) return { ok: false, status: 409, reason: `工单 '${id}' 的成员已经满了 (${JOB_MEMBER_MAX} 个) —— 分身是有成本的, 拆成两个工单, 或者先收工回收掉一批` };
      return { ok: true };
    };

    // ── 关系视图的数据面 ──────────────────────────────────────────────
    // `/api/world` (chat 详情页的「关系」「日程」两栏) 要的是注册表侧的事实:
    // 身份、家谱、工单、日程, 外加此刻的忙闲。turn 记录里没有这些 —— 它只知道
    // "某个 target 跑了一轮"。
    //
    // 活体状态要一个 pane 一次 tmux, 而这条路由会被前端定时轮询, 几十个 wizard
    // 就是几十次 shell-out。所以整份快照带一个短 TTL 缓存: 页面上的呼吸灯晚几秒
    // 亮起无所谓, 把 tmux 打爆则会连累所有正在跑的会话。
    const WORLD_TTL_MS = 5_000;
    let worldCache: { at: number; facts: Promise<WorldFacts> } | undefined;
    const collectWorldFacts = async (): Promise<WorldFacts> => {
      // self 只影响 PeerInfo.address 的写法, 关系图不用它 —— 传 defaultChat 让
      // peerInfoOf 有个基准即可。
      const anchorSelf = cfg.defaultChat || m.chatRoster("").at(0)?.base || "";
      const peers = await m.worldPeers(anchorSelf);
      const known = wizards.all();
      const byTarget = new Map(known.map((w) => [w.target, w] as const));
      const seen = new Set(peers.map((p) => p.target));
      const live: WorldFactWizard[] = peers.map((p) => {
        const w = byTarget.get(p.target);
        return {
          target: p.target,
          name: settleName(wizards, chatNameOf(cfg, p.target), p.target),
          description: w?.description ?? "",
          chat: chatNameOf(cfg, p.target) || p.chat,
          cwd: p.cwd,
          model: p.model,
          cli: p.cli,
          busy: p.busy,
          alive: p.paneAlive,
          parent: w?.parent,
          clonedFrom: w?.clonedFrom,
          forkOf: w?.forkOf,
          bornAt: w?.bornAt,
          lastActivity: p.lastActivity,
          summary: p.summary,
        };
      });
      // 注册表里有、但一个 pane / 绑定都不剩的 —— 仍是家谱上的一环 (它的分身还在
      // 跑), 漏掉它会让那些分身看着像是凭空长出来的。
      const cold: WorldFactWizard[] = known
        .filter((w) => !seen.has(w.target))
        .map((w) => ({
          target: w.target,
          name: settleName(wizards, chatNameOf(cfg, w.target), w.target),
          description: w.description,
          chat: chatNameOf(cfg, w.target),
          cwd: "", model: "", cli: "",
          busy: false, alive: false,
          parent: w.parent,
          clonedFrom: w.clonedFrom,
          forkOf: w.forkOf,
          bornAt: w.bornAt,
          lastActivity: 0,
          summary: "(未运行)",
        }));
      const nowDate = new Date();
      return {
        wizards: [...live, ...cold],
        jobs: jobs.all().map((j) => ({
          id: j.id, base: j.base, owner: j.owner, title: j.title, status: j.status,
          openedAt: j.openedAt, closedAt: j.closedAt, summary: j.summary,
          members: j.members.map((mm) => ({ target: mm.target, task: mm.task, spawned: mm.spawned })),
        })),
        schedules: tasks.list().filter((x) => x.enabled).map((x) => {
          const st = tasks.stateOf(x.id);
          return {
            id: x.id,
            target: x.target || (cfg.defaultChat ?? ""),
            when: describeTrigger(x.trigger),
            nextAt: nextFire(x.trigger, sinceOf(st), nowDate),
            lastFired: st.lastFired,
            prompt: x.prompt,
            note: x.note,
            createdBy: x.createdBy,
            owner: x.owner || (cfg.defaultChat ?? ""),
          };
        }),
        chatNames: Object.fromEntries(listChatNames(cfg).map((c) => [c.base, c.name])),
      };
    };
    setWorldFactsProvider(() => {
      const now = Date.now();
      if (!worldCache || now - worldCache.at > WORLD_TTL_MS) {
        worldCache = { at: now, facts: collectWorldFacts().catch(() => EMPTY_FACTS) };
      }
      return worldCache.facts;
    });

    /** 上下文超过这个数就该自己交接了。Claude 家族最小的窗口是 200k, 留三成余量
     *  给交接那一轮本身 —— 提示而已, 决定权在 wizard 自己。 */
    const HANDOFF_HINT_TOKENS = 140_000;

    const briefOf = (self: string, target: string): WizardBrief => ({
      name: settleName(wizards, chatNameOf(cfg, target), target),
      address: peerAddress(cfg, self, target),
      description: wizards.get(target)?.description ?? "",
      cwd: m.getCwd(target).runningCwd,
    });

    /** 自己的地址 = 全局名字, 与住在哪个群无关。 */
    const selfAddress = (target: string): string => settleName(wizards, chatNameOf(cfg, target), target);

    const sharedMemory = (scope: MemoryScope, key: string): string => {
      const path = memoryPath(cfg.daemon.stateDir, scope, key);
      return clipForCharter(readMemory(path), path);
    };

    /** 开局宪章。出生时的兄弟只是快照 —— 名册随时可查, 写进系统提示的那份只为了
     *  让它一睁眼就知道自己不是一个人在跑。 */
    const charterFor = (target: string, o: { parent?: string; forkOf?: string; inherited?: boolean; cwd?: string }): string =>
      renderCharter({
        // o.cwd = 正在启动的那个 pane 的目录; 没给才退回"现在记着的那个"。
        self: { ...briefOf(target, target), address: selfAddress(target), ...(o.cwd ? { cwd: o.cwd } : {}) },
        chat: chatNameOf(cfg, target),
        principal: baseOfKey(target),
        parent: o.parent ? briefOf(target, o.parent) : undefined,
        inherited: !!o.inherited,
        forkOf: o.forkOf ? briefOf(target, o.forkOf) : undefined,
        cwdUnconfirmed: m.cwdUnconfirmed(target, o.cwd),
        siblings: m.chatTargets(baseOfKey(target)).filter((t) => t !== target).map((t) => briefOf(target, t)),
        memory: wizards.get(target)?.memory ?? [],
        chatMemory: sharedMemory("chat", baseOfKey(target)),
        workspaceMemory: (() => {
          const cwd = o.cwd || m.getCwd(target).runningCwd || m.getCwd(target).defaultCwd;
          return cwd ? sharedMemory("workspace", cwd) : "";
        })(),
        steward: !tagOfKey(target),
      });

    // 所有 spawn 路径 (群里手打 /new、pane 自愈重生、编排出来的分身) 都从这里
    // 取身份, 于是「是谁」不再取决于是哪段代码把它生出来的。
    m.setCharterProvider((target, ctx) => {
      // 这里是最要紧的那道拦截: 宪章把「所在聊天」写进系统提示, 而系统提示是随进程
      // 终身的 —— 一个在聊天还没名字时出生的 wizard, 会一辈子以为自己住在一个
      // 「(未命名)」的地方。所以补名要发生在渲染之前, 不能等它以后自己去查。
      ensureChatNames(target);
      const rec = wizards.get(target);
      return charterFor(target, { parent: rec?.parent, forkOf: rec?.forkOf, inherited: !!rec?.clonedFrom, cwd: ctx?.cwd });
    });

    // 开机也补一次: IM 侧的 `/peers`、`/help` 直接读名字, 不经过任何 MCP 路由。
    // 延后是因为附着表要先从盘上恢复完, 否则这一刻还看不见那些聊天; 补不全也无妨,
    // 上面每一道拦截都会再补。
    setTimeout(() => {
      try { ensureChatNames(cfg.defaultChat ?? ""); } catch (e) { log.warn({ err: (e as Error).message }, "boot auto-name failed"); }
    }, 15_000).unref();

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
        named: !!(rec?.name ?? "").trim(),
        bornAt: rec?.bornAt,
        inheritedFrom: rec?.clonedFrom || "",
        ...(rec?.forkOf ? { forkOf: briefOf(self, rec.forkOf) } : {}),
        memory: rec?.memory ?? [],
        ...kinOf(self, wizards.all(), target),
        sessionId: info?.sessionId ?? "",
        cli: info?.cli,
        model: info?.model ?? "",
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
          solo: baseOfKey(p.target).startsWith("user:"),
          jsonlPath: p.jsonlPath,
          model: p.model,
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
          solo: baseOfKey(w.target).startsWith("user:"),
          jsonlPath: "",
          model: "",
          busy: false,
          alive: false,
          self: false,
          // 没跑过就没有活动时刻。排序拿它当最旧 —— 冷会话排在活着的后面, 正是
          // 截断时该被留下的顺序。
          lastActivity: 0,
          summary: "",
          ...kinOf(self, all, w.target),
        }));
      return [...live, ...cold];
    };

    http.register("POST /wizard/whoami", async (req, res) => {
      const { self } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      // 身份已经写在系统提示里了, whoami 回答的是"此刻"的部分: 上下文用了多少、
      // 分身还剩几个、工作区有没有被换掉。
      ensureChatNames(self);
      json(res, 200, { ok: true, ...identityOf(self, self), peers: (await m.peers(self)).filter((p) => !p.self).length });
    });

    // 改名字 / 写职责。名字全局唯一、与聊天名脱钩 (默认会话只是出生时取了聊天名):
    // 撞名自动挂 `-N`, 返回里的 `name` 才是落定的那个。
    http.register("POST /wizard/identity", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { name?: string; description?: string };
      const asked = normalizeTag((b.name ?? "").toString());
      const description = (b.description ?? "").toString().trim();
      if ((b.name ?? "").toString().trim() && !asked) { json(res, 400, { ok: false, reason: "名字只能是 1-32 位字母/数字/`_`/`-`" }); return; }
      const before = settleName(wizards, chatNameOf(cfg, self), self);
      const name = asked ? wizards.rename(self, asked) : before;
      if (description) wizards.upsert(self, { description });
      const me = identityOf(self, self);
      // 职责是别人决定"该不该找你"的依据, 改了就得让同群的知道 —— 否则他们照着
      // 出生快照里那句旧的 (或者空的) 职责派活。
      if (asked || description) postRoster(baseOfKey(self), [self], `${before && before !== name ? `**.${before}** 改名为 **.${name}**` : `**.${name}** 改了身份`}${description ? ` · 职责: ${description}` : ""}`);
      json(res, 200, {
        ok: true,
        ...me,
        ...(asked && name.toLowerCase() !== asked.toLowerCase() ? { renamed: `'.${asked}' 已被占用, 落定为 '.${name}'` } : {}),
      });
    });

    // 名册是**索引**, 不是转储: 这台机器上现在有 300+ 个会话, 整表吐出来是三万
    // token —— 一个 wizard 每次想找人都付这个价, 等于找不到人。所以服务端过滤
    // (名字/职责/工作区/聊天/死活), 并且默认只给最相关的一页, 同时回 total 让
    // 调用方知道自己看的是不是全部。
    const rosterFilters = (b: { query?: string; chat?: string; cwd?: string; alive?: boolean }) => {
      const q = (b.query ?? "").trim().toLowerCase();
      const chat = (b.chat ?? "").trim().toLowerCase();
      const cwd = (b.cwd ?? "").trim().toLowerCase();
      return (w: { name: string; address: string; description: string; cwd: string; chat: string; target: string; alive: boolean }): boolean =>
        (!q || [w.name, w.address, w.description, w.target].some((f) => (f ?? "").toLowerCase().includes(q))) &&
        (!chat || (w.chat ?? "").toLowerCase() === chat || (w.target ?? "").toLowerCase().includes(chat)) &&
        (!cwd || (w.cwd ?? "").toLowerCase().includes(cwd)) &&
        (b.alive !== true || w.alive);
    };

    http.register("POST /wizard/roster", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { query?: string; chat?: string; cwd?: string; alive?: boolean; limit?: number };
      ensureChatNames(self);
      const all = await rosterOf(self);
      const hit = all.filter(rosterFilters(b));
      // 自己在最前, 然后活着的, 然后最近动过的 —— 截断时留下的正是最可能有用的。
      const ranked = hit.slice().sort((x, y) =>
        Number(y.self) - Number(x.self) || Number(y.alive) - Number(x.alive) || (y.lastActivity ?? 0) - (x.lastActivity ?? 0));
      const limit = Math.min(Math.max(Number(b.limit ?? 40) || 40, 1), 300);
      // 「最近」与模型都从 transcript 读, 而且只为列出来的这一页读: 摘要用不指代任何人
      // 的箭头 (读名册的是另一个 wizard), 模型取它真正跑的那个 —— 绑定里的 model 只在
      // 有人显式选过时才有。
      const warm = keepalivePingSigs(cfg.wrc.mirror.keepalive.ping);
      const shown = ranked.slice(0, limit).map((r) => ({
        ...r,
        model: r.model || (r.jsonlPath ? lastModel(r.jsonlPath) : ""),
        summary: r.jsonlPath ? lastExchange(r.jsonlPath, 80, warm) : "",
      }));
      json(res, 200, {
        ok: true,
        total: all.length,
        matched: hit.length,
        shown: shown.length,
        text: [
          `名册 · 列出 ${shown.length}/${hit.length} 个 (全机 ${all.length} 个) · 忙 = 正在生成, 闲 = 活着没在跑, 冷 = 没有 pane (发消息会唤醒)`,
          renderRoster(shown, Date.now(), homedir()),
          ...(hit.length > shown.length
            ? [`还有 ${hit.length - shown.length} 个没列出来 —— 用 query (名字/职责) / cwd (工作区) / chat 收窄, 或者调大 limit`]
            : []),
        ].join("\n"),
      });
    });

    // 记忆三种作用域: self 跟着自己 (wizards.json), 直写; chat / workspace 是共享的 md,
    // 每个在那个群 / 那个目录出生的 wizard 都会读到 —— 它们只收提议, 由整理者合并
    // (见 wizard-memory.ts / memory-steward.ts)。
    http.register("POST /wizard/remember", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { note?: string; forget?: string; scope?: string };
      const note = (b.note ?? "").toString().trim();
      const forget = (b.forget ?? "").toString().trim();
      const scope = (b.scope ?? "self").toString();
      if (scope === "chat" || scope === "workspace") {
        const key = scope === "chat" ? baseOfKey(self) : (m.getCwd(self).runningCwd || m.getCwd(self).defaultCwd);
        if (!key) { json(res, 400, { ok: false, reason: "这个 wizard 没有工作区, 记不了 workspace 记忆" }); return; }
        if (!note && !forget) { json(res, 400, { ok: false, reason: "note 和 forget 至少给一个" }); return; }
        const path = memoryPath(cfg.daemon.stateDir, scope as MemoryScope, key);
        const queued = proposeMemory(inboxPath(cfg.daemon.stateDir, scope as MemoryScope, key), {
          at: Date.now(),
          by: selfAddress(self),
          ...(note ? { note } : {}),
          ...(forget ? { forget } : {}),
        });
        if (!queued) { json(res, 500, { ok: false, reason: "提议没写进收件箱" }); return; }
        json(res, 200, {
          ok: true, scope, queued, file: path, memory: readMemory(path),
          hint: "已提交给记忆整理者, 下一轮整理 (半小时内) 合并进上面这份记忆; 此后出生的 wizard 才读得到",
        });
        return;
      }
      const cur = wizards.get(self)?.memory ?? [];
      // 忘记按子串匹配: 模型记不住自己当初一字不差写了什么, 但记得大意。
      const next = forget ? cur.filter((x) => !x.includes(forget)) : cur;
      const memory = note ? [...next.filter((x) => x !== note), note] : next;
      wizards.upsert(self, { memory });
      json(res, 200, { ok: true, scope: "self", memory, added: !!note, forgotten: cur.length - next.length });
    });

    // 生分身。默认 fork 调用方此刻的上下文 —— 这是"先把公共材料读进来, 再分出 N
    // 个干活的"之所以省事的原因: 材料只读一遍, 却进了 N 份上下文。
    http.register("POST /wizard/clone", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { name?: string; tag?: string; description?: string; inherit?: boolean; from?: string; cwd?: string; chat?: string; cli?: CliBackendName; model?: string; task?: string; job?: string; keepalive?: boolean };
      // 工单先验: 生完分身才发现工单号打错了, 那个分身就成了没人认领的孤儿。
      const jobId = (b.job ?? "").trim();
      if (jobId) {
        const jc = checkJob(jobId);
        if (!jc.ok) { json(res, jc.status, { ok: false, reason: jc.reason }); return; }
      }
      // `inherit` 没有默认值 —— 继承与否是两种完全不同的分身 (一种开局就带着你
      // 读过的一切, 另一种白纸一张), 猜错了要么白烧一份上下文, 要么让它从零重读。
      // 逼调用方每次自己说。
      if (typeof b.inherit !== "boolean") {
        json(res, 400, { ok: false, reason: "inherit 必填: true = fork 你此刻的上下文 (它开局就有你读过的材料, 必须留在同一个 cwd); false = 空白分身, 只继承身份" });
        return;
      }
      const inherit = b.inherit;
      // 克隆的源头: 默认是调用方自己; `from` 点名就 fork 那个 wizard 此刻的上下文。
      // 分身仍归调用方管 (parent = self: 占它的预算、随它的工单回收), 只有上下文来自别处。
      // 空串不能交给 resolvePeer —— 那是「本聊天的默认 wizard」, 不是「我自己」。
      const fromAddr = (b.from ?? "").toString().trim();
      if (fromAddr && !inherit) {
        json(res, 400, { ok: false, reason: "from 只对克隆有意义 —— 白板生出来的 wizard 不带任何人的上下文" });
        return;
      }
      const fromR = fromAddr ? resolvePeer(self, fromAddr) : { ok: true as const, target: self };
      if (!fromR.ok) { json(res, fromR.status, { ok: false, reason: fromR.reason, ...(fromR.candidates ? { candidates: fromR.candidates } : {}) }); return; }
      const source = fromR.target;
      const sourceInfo = m.sessionInfo(source);
      // 别人的会话 fork 不出来就是失败, 不能像克隆自己那样悄悄退化成白板 —— 调用方
      // 要的恰恰是它的上下文, 给一张白纸等于答非所问。
      if (source !== self && !sourceInfo?.sessionId) {
        json(res, 409, { ok: false, reason: `${displayName(source)} 没有可 fork 的会话 (还没说过话, 或绑定已失效)` });
        return;
      }
      const alivePeers = await m.peers(self);
      // 预算。撞到上限不是"不许再分", 是"先把干完活的收掉": stop_wizard 收单个,
      // close_job 整批回收一个工单的临时分身。只数**本聊天里**活着的 ——
      // 生到别的聊天去的归那边管, 为了数它们再探一遍 tmux 不值当。
      const aliveKids = childrenOf(wizards.all(), self).filter((k) =>
        alivePeers.some((pp) => pp.target === k.target && pp.paneAlive));
      if (aliveKids.length >= cfg.wrc.mirror.cloneMax) {
        json(res, 429, {
          ok: false,
          reason: `你名下已经有 ${aliveKids.length} 个活着的分身 (上限 ${cfg.wrc.mirror.cloneMax}) —— 先 stop_wizard 收掉干完活的那些, 或者 close_job 整批回收一个工单`,
          clones: aliveKids.map((k) => peerAddress(cfg, self, k.target)),
        });
        return;
      }
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
      const askedName = String(b.name ?? b.tag ?? "");
      const slotR = await claimSlot(base, askedName, normalizeTag(b.description?.split(/\s+/)[0]) || "clone", [self, source]);
      if (!slotR.ok) { json(res, slotR.status, slotR.body); return; }
      const { target, slot: tag } = slotR;
      const forkOf = inherit && source !== self ? source : undefined;
      // 先落身份再 spawn: 宪章是从注册表渲染出来的, 记录不在就渲染出一个无名分身。
      wizards.upsert(target, {
        description: (b.description ?? "").toString().trim(),
        parent: self,
        bornAt: Date.now(),
        clonedFrom: inherit ? sourceInfo?.sessionId ?? "" : "",
        ...(forkOf ? { forkOf } : {}),
      });
      const name = wizards.rename(target, normalizeTag(askedName) || tag);
      const charter = charterFor(target, { parent: self, forkOf, inherited: inherit });
      const task = (b.task ?? "").toString().trim();
      // 没点名就按配置的 keepalive.spawnDefault 来 —— 调用方明说的永远优先。
      const keepalive = typeof b.keepalive === "boolean" ? b.keepalive : cfg.wrc.mirror.keepalive.spawnDefault;
      // 先盖章再生: 分叉出来的 transcript 里躺着被克隆者的旧回复, 时刻早于这一枚章,
      // wait_peer 才不会把它们当成分身对这件活的答复。
      if (task) stampSend(self, target);
      const r = await m.cloneSession({
        parent: source,
        target,
        windowName: name,
        cli: b.cli,
        model: b.model,
        cwd: b.cwd,
        systemPrompt: charter,
        inherit,
        // 继承路径上第一句话是分叉的触发器, 所以直接把活当开场白 —— 少一次往返,
        // 也少一次"就位了但没事干"的空转。
        bootstrap: task ? task + envelopeFor(self, "") : undefined,
        keepalive,
      });
      if (!r.ok) {
        wizards.drop(target);
        json(res, 500, { ok: false, reason: r.reason });
        return;
      }
      wizards.upsert(target, { clonedFrom: r.inherited ? sourceInfo?.sessionId ?? "" : "", ...(r.inherited ? {} : { forkOf: undefined }) });
      const kid = briefOf(self, target);
      // r.model 是 spawnTmuxClaude 通过 /model 实测确认落地的那个 —— 可能跟调用方
      // 传的原始字符串不一样 (口语化 → 目录里匹配到的关键词), 播报要报实情。
      const modelNote = r.model
        ? (r.modelWarning ? ` · 模型 ${r.model} (⚠️ ${r.modelWarning})` : ` · 模型 ${r.model}`)
        : "";
      // 出生不再发群气泡 (人要看的是结论, 不是谁生了谁 —— 过程在 rolepage 里);
      // 同群的 wizard 仍要知道群里多了一个成员。工单里的临时工连这条也省掉。
      if (!jobId) {
        postRoster(base, [target, self], `新 wizard **.${name}** 就位${kid.description ? ` · ${kid.description}` : ""}${r.cwd ? ` · 工作区 ${r.cwd}` : ""}${modelNote}${keepalive ? "" : " · 已关闭 keepalive"} —— ${displayName(self)} 的分身${r.inherited ? ` (继承了${forkOf ? ` ${displayName(forkOf)} ` : "它"}的上下文)` : ""}`);
      }
      // 继承路径上活已经随开场白进去了, 空白分身才需要在这里补一次注入 (私聊)。
      let dispatched = r.inherited && !!task;
      if (task && !r.inherited) {
        const inj = await m.injectText(target, task, undefined, { from: { kind: "peer", from: self, ...(jobId ? { job: jobId } : {}) }, channel: "", envelope: envelopeFor(self, "") });
        dispatched = inj.ok;
      }
      if (jobId) jobs.attach(jobId, { target, task, spawned: true });
      json(res, 200, { ok: true, target, name, address: name, inherited: r.inherited, sessionId: r.sessionId, cwd: r.cwd, dispatched, keepalive, ...(r.model ? { model: r.model } : {}), ...(r.modelWarning ? { modelWarning: r.modelWarning } : {}), ...(jobId ? { job: jobId } : {}) });
    });

    // 收掉一个 wizard。interrupt = 打断它这一轮 (Esc); end = 结束它并回收 pane。
    // 自己终结自己是合法的 (分身干完活自我了结), 代价是这次工具调用不会返回 ——
    // 群里的气泡就是回执, 与 set_workspace 同款。
    http.register("POST /wizard/stop", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { name?: string; tag?: string; mode?: string; forget?: boolean };
      const r = resolvePeer(self, addrOf(b));
      if (!r.ok) { json(res, r.status, { ok: false, reason: r.reason, candidates: r.candidates }); return; }
      const { target } = r;
      const victim = briefOf(self, target);
      const end = (b.mode ?? "end") === "end";
      if (!end && target === self) { json(res, 400, { ok: false, reason: "打断自己没有意义 —— 你就是正在生成的那一个" }); return; }
      const done = end ? await m.killPane(target) : await m.interruptPane(target, { teardown: true });
      if (!done.ok) { json(res, 502, { ok: false, target, reason: done.reason }); return; }
      if (end && b.forget) wizards.drop(target);
      notifyChat(target, withTagHeader(target, `${end ? "已结束" : "已打断"} · 由 ${displayName(self)} 发起`));
      // 打断只是停了它这一轮, 它还在; 只有结束才是名册变了。
      if (end) postRoster(baseOfKey(target), [target, self], `**${victim.name || target}** 已收工 · 由 ${displayName(self)} 结束${b.forget ? " (记录一并抹掉)" : ""}`);
      json(res, 200, { ok: true, target, name: victim.name, mode: end ? "end" : "interrupt", forgotten: !!(end && b.forget) });
    });

    // 换模型: 省略名字 = 换自己 (选择器盖在正在跑的这一轮上面照样能开), 点名 = 换
    // 那个 wizard。与 spawn 时的 `model` 是同一条路 (model-select.ts)。
    http.register("POST /wizard/model", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { model?: string; scope?: string };
      const model = (b.model ?? "").toString().trim();
      if (!model) { json(res, 400, { ok: false, reason: "model 必填 —— 口语化写就行 ('opus' / 'haiku' / 'sonnet 5')" }); return; }
      const scope = (b.scope ?? "session").toString().trim();
      if (scope !== "session" && scope !== "default") { json(res, 400, { ok: false, reason: "scope 只有两档: 'session' (只换这一个会话) / 'default' (同时设为新会话的默认模型)" }); return; }
      // 空串不能交给 resolvePeer —— 那是「本聊天的默认 wizard」, 不是「我自己」。
      const addr = addrOf(body).trim();
      const r = addr ? resolvePeer(self, addr) : { ok: true as const, target: self };
      if (!r.ok) { json(res, r.status, { ok: false, reason: r.reason, candidates: r.candidates }); return; }
      const done = await m.setModel(r.target, model, scope);
      json(res, done.ok ? 200 : 502, { ...done, target: r.target, name: briefOf(self, r.target).name, ...(done.ok ? { model: done.applied } : {}) });
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
        if (!idle.idle) {
          lg.warn({ reason: idle.reason }, "self-handoff: 目标一直忙, 放弃");
          // 之前这里只写日志: 调用方早就拿到 `scheduled:true` 挂了, 交接静悄悄
          // 放弃, 群里没有任何气泡告诉人。补一条 notify, 对齐它成功时的那条。
          notifyChat(self, withTagHeader(self, `上下文交接放弃: 一直没能闲下来 (${idle.reason}), 上下文和之前一样没动, 有空再试一次`));
          return;
        }
        const clr = await m.injectText(self, "/clear");
        if (!clr.ok) { lg.warn({ reason: clr.reason }, "self-handoff: /clear 注入失败"); return; }
        await new Promise((r2) => setTimeout(r2, 3000));
        const carry = `以下是你自己上一段会话压缩出来的交接简报, 据此无缝接着干:\n\n${brief}`;
        const inj = await m.injectText(self, carry);
        lg.info({ ok: inj.ok, reason: inj.reason }, "self-handoff: 完成");
        notifyChat(self, withTagHeader(self, `上下文已交接重开 (${info?.contextTokens ?? 0} tok → 0), 工作照旧`));
      })();
    });

    // ── Job: 一次 fan-out 的工单 ─────────────────────────────────────────
    // 账本, 不是编排器: 控制流留在发起的那个 wizard 手里 (它自己 spawn / wait /
    // 汇总), 这里只记谁属于这个活、谁是为它临时生的、群里该出哪两条气泡。
    // 见 jobs.ts 开头那段取舍。
    http.register("POST /jobs/open", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { title?: string; plan?: string };
      const title = (b.title ?? "").toString().trim();
      if (!title) { json(res, 400, { ok: false, reason: "title required —— 一句话说清这个工单要干成什么" }); return; }
      const base = baseOfKey(self);
      const job = jobs.open(base, self, title);
      notifyChat(base, renderJobOpen(job, (b.plan ?? "").toString()));
      json(res, 200, {
        ok: true,
        job: job.id,
        title,
        memberMax: JOB_MEMBER_MAX,
        hint: "把这个 id 传给 spawn_wizard / clone_wizard / send_peer 的 `job` 参数, 它们就归到这个工单名下 (期间不再逐条出气泡); 活干完调 close_job 收尾并回收临时分身。",
      });
    });

    http.register("POST /jobs/close", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { job?: string; summary?: string; stop?: boolean };
      const id = (b.job ?? "").toString().trim();
      const job = jobs.get(id);
      if (!job) { json(res, 404, { ok: false, reason: `没有工单 '${id}'` }); return; }
      if (job.status !== "open") { json(res, 409, { ok: false, reason: `工单 '${id}' 已经收工了`, closedAt: job.closedAt }); return; }
      // 回收只针对**为这个工单生出来的**分身: 被拉来帮忙的长期 wizard 不该因为一次
      // 活结束就被杀掉。调用方自己也不收 —— 那会在这次工具调用里把自己干掉。
      const recycle = b.stop !== false;
      const victims = recycle ? job.members.filter((mm) => mm.spawned && mm.target !== self) : [];
      const killed = await victims.reduce(
        async (acc, mm) => (await acc) + ((await m.killPane(mm.target)).ok ? 1 : 0),
        Promise.resolve(0),
      );
      const closed = jobs.close(id, (b.summary ?? "").toString())!;
      notifyChat(job.base, renderJobClose(closed, (t) => relayLabel(t, job.base), killed));
      json(res, 200, { ok: true, job: id, members: closed.members.length, recycled: killed, kept: victims.length - killed });
    });

    http.register("POST /jobs/list", async (req, res) => {
      const { self } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      json(res, 200, {
        ok: true,
        jobs: jobs.openOf(baseOfKey(self)).map((j) => ({
          job: j.id,
          title: j.title,
          owner: displayName(j.owner),
          mine: j.owner === self,
          openedAt: j.openedAt,
          members: j.members.map((mm) => ({ address: peerAddress(cfg, self, mm.target), task: mm.task.split("\n")[0] ?? "", spawned: mm.spawned })),
        })),
      });
    });

    // ── 定时任务 ────────────────────────────────────────────────────
    // 到点把一句 prompt 注入一个 wizard 会话 —— 和人在群里对它说话走的是同一条路
    // (injectText), 所以 pane 死了会被拉起来, 输出照常落进群和详情页。
    /** 日程归谁: 排班那个 wizard (createdBy); 老文件没写就归执行它的那个。 */
    const ownerOf = (t: { owner: string }): string => t.owner || (cfg.defaultChat ?? "");

    http.register("POST /tasks/schedule", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { when?: string; prompt?: string; note?: string; fresh?: boolean; id?: string };
      const prompt = (b.prompt ?? "").toString().trim();
      const whenText = (b.when ?? "").toString().trim();
      if (!prompt) { json(res, 400, { ok: false, reason: "prompt required" }); return; }
      const trigger = parseTrigger(whenText, new Date());
      if (!trigger) { json(res, 400, { ok: false, reason: WHEN_HELP(whenText) }); return; }
      // tag 省略 = 排给调用者自己。这是最常见的用法: wizard 给自己定一个夜里跑的活。
      // 注入自身在**当下**是死锁 (往正在生成的输入框里打字), 但定时是未来的事,
      // 那时这一轮早已收工, 所以这里不套 /peers/send 的自我保护。
      const tag = addrOf(body).trim();
      let target = self;
      if (tag) {
        const r = resolvePeer(self, tag);
        if (!r.ok) { json(res, r.status, { ok: false, reason: r.reason, candidates: r.candidates }); return; }
        target = r.target;
      }
      // 到点是新建还是续用, 在**排班时**就定死。两条都指向新建:
      //   · 没点名 wizard —— 定时的 prompt 本就要求零上下文自洽, 没理由挑一个会话挤进去;
      //   · prompt 自己就在说「建两个 wizard 去干 xxx」—— 这时 tag 只是「在谁的聊天/
      //     目录下办」, 不是「在它的上下文里续」。
      // `fresh` 显式传入压过这两条推断 (要强行在 tag 那一轮里续就传 false)。
      const fresh = typeof b.fresh === "boolean" ? b.fresh : !tag || promptWantsFreshWizard(prompt);
      const note = (b.note ?? "").toString();
      const id = uniqueId(slugify((b.id ?? "").toString() || note || prompt.slice(0, 24), "task"), tasks.takenIds());
      const created = tasks.create({ id, trigger, prompt, target, fresh, note, createdBy: self });
      if ("error" in created) { json(res, 400, { ok: false, reason: created.error }); return; }
      tasks.patchState(id, { createdAt: Date.now() });
      json(res, 200, {
        ok: true,
        ...renderTask(created, tasks.stateOf(id)),
        address: peerAddress(cfg, self, target),
        owner: peerAddress(cfg, self, self),
      });
    });

    http.register("POST /tasks/list", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const mineOnly = (body as { mine?: boolean }).mine === true;
      const now = new Date();
      const errs = tasks.errors();
      const rows = tasks.list()
        .filter((t) => !mineOnly || ownerOf(t) === self)
        .map((t) => ({
          ...renderTask(t, tasks.stateOf(t.id), now, errs[t.id]),
          address: peerAddress(cfg, self, t.target || (cfg.defaultChat ?? "")),
          owner: peerAddress(cfg, self, ownerOf(t)),
        }));
      // 加载失败的那些没有记录可回显, 但必须出现在列表里 —— 否则 wizard 改错了
      // 一个字, 那条定时就像凭空消失了。
      const broken = Object.entries(errs)
        .filter(([id]) => !tasks.get(id))
        .map(([id, loadError]) => ({ id, file: `${tasks.dir}/${id}.task.mjs`, loadError }));
      json(res, 200, { ok: true, self, dir: tasks.dir, tasks: [...rows, ...broken] });
    });

    http.register("POST /tasks/cancel", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const id = ((body as { id?: string }).id ?? "").toString().trim();
      if (!id) { json(res, 400, { ok: false, reason: "id required (list_tasks 里那个 id)" }); return; }
      const state = tasks.stateOf(id);
      const gone = tasks.remove(id);
      if (!gone) { json(res, 404, { ok: false, reason: `no schedule with id ${id}` }); return; }
      json(res, 200, { ok: true, removed: renderTask(gone, state) });
    });

    // POST /config/set — modify daemon config from MCP
    http.register("POST /config/set", async (req, res) => {
      const body = (await readBody(req)) as { key?: string; value?: unknown; action?: string };
      const r = configSet(cfg, sourcePath, body.key, body.value, body.action);
      json(res, r.ok ? 200 : 400, r);
    });

    http.register("POST /config/get", async (req, res) => {
      const body = (await readBody(req)) as { key?: string };
      const r = configGet(cfg, body.key);
      json(res, r.ok ? 200 : 400, r);
    });

    // POST /graph/run — declare a loop graph over this chat's tagged sessions
    // and start walking it. Fire-and-forget: returns a runId immediately, then
    // narrates progress into the chat while it advances.
    http.register("POST /graph/run", async (req, res) => {
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

    // 定时任务的执行体。schedule_task 的 prompt 设计上本就要求"零上下文也能执行"
    // (到点时目标可能早已 /clear 过, 它只看得见这一句) —— 既然如此, 默认就不在任何
    // 已有会话里跑: 硬塞进去会把两件不相关的事挤进同一个 transcript, 目标正忙时
    // 还要连触发时间点一起被它那一轮拖走。所以到点起一个白板 wizard 单独执行,
    // 跑完自动收掉。只有排班时点名了某个 wizard (fresh=false) 且它此刻闲着,
    // 才把这句话直接投进它那一轮 —— 「在已有会话里继续」是要求出来的, 不是默认。
    scheduledTaskInject = async (target, text, { taskId, fresh }) => {
      const busy = fresh ? false : await m.isBusy(target);
      if (!fresh && !busy) return m.injectText(target, text, undefined, { fromChat: true, from: { kind: "task", taskId }, envelope: renderTaskEnvelope(taskId) });

      // 执行体挂在日程的主人名下: 名字 `<主人>-task-xxxx`, parent = 主人 —— 它的
      // rolepage 里看得见这一枪是谁的日程放的。落在执行目标的群/目录里。
      const base = baseOfKey(target);
      const rec = tasks.get(taskId);
      const owner = rec ? ownerOf(rec) : target;
      const ownerName = settleName(wizards, chatNameOf(cfg, owner), owner) || "task";
      const slotR = await claimSlot(base, "", `${ownerName}-task-${taskId.slice(0, 4)}`);
      if (!slotR.ok) return { ok: false, reason: "起白板 wizard 失败: 挑不出槽位" };
      const runner = slotR.target;
      const info = m.sessionInfo(target);
      const why = busy ? ` (起因: ${displayName(target)} 当时正忙)` : "";
      wizards.upsert(runner, {
        description: `定时任务 ${taskId} 的一次性执行体${why}`,
        parent: owner,
        bornAt: Date.now(),
      });
      const runnerName = wizards.rename(runner, `${ownerName}-task-${taskId.slice(0, 4)}`);
      const spawned = await m.newSession(runner, runnerName, info?.cli, { cwd: info?.cwd, model: info?.model, silent: true });
      if (!spawned.ok) {
        wizards.drop(runner);
        return { ok: false, reason: `起白板 wizard 失败: ${spawned.reason ?? "unknown"}` };
      }
      notifyChat(base, withTagHeader(target, busy
        ? `⏰ 定时任务到点时正忙, 已起白板 wizard .${runnerName} 单独执行, 完成后自动收掉`
        : `⏰ 定时任务已起白板 wizard .${runnerName} 执行, 完成后自动收掉`));
      const inj = await m.injectText(runner, text, undefined, { fromChat: true, from: { kind: "task", taskId }, envelope: renderTaskEnvelope(taskId) });
      if (!inj.ok) { wizards.drop(runner); return inj; }
      // 没有人会对这个一次性分身喊 stop_wizard, 只能自己等它闲下来再收。30min
      // 内没闲下来就放弃自动回收 (它大概率还在干一个长活), 留给人手动处理 ——
      // 比杀掉一个还在跑的 pane 安全。
      void (async () => {
        const idle = await waitForIdle(runner, m.isBusy, 30 * 60_000, () => false);
        if (!idle.idle) {
          log.warn({ runner, reason: idle.reason }, "task runner: 30min 未闲下来, 放弃自动回收");
          return;
        }
        await m.killPane(runner);
        wizards.drop(runner);
      })();
      return inj;
    };
  }

  // 定时调度器 — 每 20s 检查任务表, 到点把 prompt 注入目标 wizard。
  migrateLegacySchedules(cfg, sourcePath, tasks, log.child({ mod: "tasks" }));
  const scheduler = startScheduler({
    client: ws.client,
    registry: tasks,
    log: log.child({ mod: "tasks" }),
    inject: scheduledTaskInject,
    // gate 里的 `sh` 默认就在目标 wizard 此刻的工作区跑 —— 任务文件里不必写死绝对路径。
    cwdOf: (t) => { const c = bridge.getCwd(t); return c.runningCwd || c.pendingCwd || c.defaultCwd; },
    fallbackTarget: () => (cfg.defaultChat ?? "").trim(),
  });

  // pane 上限 — 每新建一个 wizard 数一次: 活着的会话 pane 超过 wrc.mirror.maxPanes
  // (默认 20, 0=关) 就从最久没动的收起。数量只在出生时增长, 所以不设定时器。只收
  // pane 不收绑定: 下一条消息 `--resume` 复活。豁免: 名下有定时任务的 wizard (调度
  // 本身会唤醒/需要它), 挂着审批长轮询的会话 (hook 还停在等点击), 忙着的 / 人正
  // 盯着的 (bridge 内部判)。
  if (cfg.wrc.mirror.maxPanes > 0) {
    const max = cfg.wrc.mirror.maxPanes;
    const sweep = async (): Promise<void> => {
      const taskOwners = new Set(
        tasks.list()
          .filter((t) => t.enabled)
          .map((t) => wizardStore()?.byName(t.owner)?.target)
          .filter((t): t is string => !!t),
      );
      const pendingSids = new Set(listPending().map((p) => p.meta.sessionId).filter((s): s is string => !!s));
      const r = await bridge.reapOverflow(max, (target, sid) =>
        taskOwners.has(target) ? "owns scheduled task"
          : pendingSids.has(sid) ? "pending approval"
          : undefined);
      if (r.reaped.length || r.orphans.length) log.info({ reaped: r.reaped.length, targets: r.reaped, orphans: r.orphans.length, max }, "pane cap sweep");
    };
    bridge.onSpawn(() => void sweep().catch((e) => log.warn({ err: (e as Error).message }, "pane cap sweep failed")));
  }

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutdown signal");
    scheduler.stop();
    tasks.stop();
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
