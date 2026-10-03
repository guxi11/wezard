// Daemon entry. Resident process — exits only on signal or fatal WS auth failure.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { loadOrCreateSvrToken } from "../shared/svr-token.js";
import { DAEMON_TOKEN_FILE, DAEMON_TOKEN_HEADER } from "../shared/daemon-token.js";
import { homedir } from "node:os";
import { TIERS, loadConfig } from "../shared/config.js";
import { makeLogger } from "../shared/log.js";
import { clipLine, sleep, truncate } from "../shared/std.js";
import { patchJsonc } from "../shared/config-writer.js";
import { EFFORTS, parseEffort } from "../shared/effort.js";
import { bindCliBackends, projectDirsFor, type CliBackendName } from "../shared/cli-backends.js";
import { startWs } from "./ws.js";
import { startNetWatch } from "./net-watch.js";
import { startHttp, json, readBody, type Handler } from "./http.js";
import { parsePath } from "../shared/config-meta.js";
import { applyHot, patchedTop, configGet, fromLegacy, legacyGet, pickTier, planSet, renderPlan, tierEvidence, type Plan, type SetReq, type TierUsage, type UsageTotals } from "./config-api.js";
import { computeUsage, costOf, fmtCost, fmtTokens, sumTotal, type ModelTotals } from "./usage.js";
import { installInboundRouter } from "./inbound.js";
import { loadMirrorStore } from "./mirror-store.js";
import { startMirror, installMirrorEventListener } from "./mirror-bridge.js";
import { runTmux, setTmuxTimeoutReporter, spawnTmuxClaude } from "./spawn-tmux.js";
import { installApprovalEventListener, makeApproveHandler, requestConfirm } from "./approval.js";
import { initDetailPersistence, makeDetailHandler, chatHandlers, configureRemoteForward, chatUrlFor, setWorldFactsProvider, currentHumanQueryOf, recordPost, recordCharter, backfillCharter } from "./detail.js";
import { EMPTY_FACTS, type WorldFacts, type WorldFactWizard } from "../shared/world.js";
import { clearAutoWindow, initAutoWindowPersistence, setAutoWindow } from "./session-cache.js";
import { makeMessageHandler } from "./outbound.js";
import { makeCardHandler, makeAskHandler, installAskEventListener } from "./ask.js";
import { drainForReload, listPending } from "./pending.js";
import {
  makeClaimStartHandler,
  makeClaimStatusHandler,
  makeClaimResetHandler,
} from "./claim.js";
import { makeWedocBridge } from "./wedoc.js";
import { errText, installResponseTracker } from "./last-response.js";
import { scanClaudeSessions } from "./session-scan.js";
import {
  startScheduler,
  migrateLegacySchedules,
  promptWantsFreshWizard,
  renderTask,
  sinceOf,
  TASK_POSTPONE_MS,
  TASK_QUIET_WAIT_MS,
} from "./tasks.js";
import { openTaskRegistry } from "./task-registry.js";
import { describeTrigger, nextFire, parseTrigger, WHEN_HELP } from "../shared/trigger.js";
import { isQuiet, slugify, uniqueId } from "../shared/task-file.js";
import { baseOfKey, bindTagLinker, isInternalKey, keyOf, linkTags, normalizeTag, tagFromCwd, tagHead, tagLink, tagOfKey, uniqueTag, withTagHeader } from "../shared/session-label.js";
import { appendEpisode, clipForCharter, cwdOfMd, episodePath, inboxPath, mdsOf, proposedCwds, memoryPath, memoryRoot, proposeMemory, readMemory, type MemoryScope } from "./wizard-memory.js";
import { retireStewardTask, startSteward, stewardEnvelope, STEWARD_ID, STEWARD_RUN_MS, STEWARD_TARGET, type RefsOf } from "./memory-steward.js";
import type { Asker, TurnFrom } from "../shared/detail-store.js";
import { applyChatNames, chatBaseOf, chatNameOf, chatPolicyOf, clearChatName, listChatNames, normChatName, peerAddress, planChatNames, setChatName, type CharterChange, type CharterGuard } from "./chat-name.js";
import { createTopOnlyNudge, gcNudge, policyKeyOf, renderNudge, type NudgeRow } from "./top-only-nudge.js";
import {
  bindWizardStore,
  loadWizardStore,
  wizardStore,
  settleName,
  settleAll,
  backfillBorn,
  sweepUnborn,
  BOOT_ID,
  evictStaleName,
  childrenOf,
  ancestorsOf,
  renderCharter,
  renderLead,
  renderLeadPlaybook,
  ROSTER_FRESH_MS,
  renderRoster,
  handoffAt,
  memoryNudgeAt,
  MEMORY_NUDGE_FLOOR,
  MEMORY_MAX,
  NOTE_MAX,
  type WizardBrief,
  type WizardRecord,
} from "./wizard.js";
import { bindNoticeBox, createNoticeBox, createSeenRing, gcSeen, chatAudience, hears, noticeSuffixFor, type Notice, type Subject, type Part, type SeenRow, type Via } from "./notices.js";
import { createLedger, digest, pendingGc, renderDigest, renderTable, renderAwaiting, renderStalled, renderShelved, ago as agoMs, HEARD_EVERY_MS, type Item as PendingItem, type LiveOf, type Mark } from "./pending-items.js";
import { loadJobStore, dutyLine, awaitingAccept, stalledRoots, shelvedRoots, nudgeDue, dayClamp, childrenOf as jobChildren, jobEpisode, rejectReason, ACCEPTS, JOB_MEMBER_MAX, JOB_DEPTH_MAX, depthOf, ancestorsOf as jobAncestors, treeOrder, jobStage, type Accept, type JobMark, type JobRecord, type MemberLive } from "./jobs.js";
import type { MemberRole } from "../shared/world.js";
import { cacheTouchMs, cacheTtlSec, clipMiddle, contextFiles, firstStamp, parseClosing, lastContextTokens, lastExchange, lastModel, openingTurn, replyClosedBefore, talkTurns, renderPeerEnvelope, renderReceiptEnvelope, renderTaskEnvelope } from "./peers.js";
import { keepalivePingSigs } from "../shared/keepalive.js";
import { expandHome } from "../shared/paths.js";
import { loadJsonMap } from "../shared/json-map-store.js";
import { createReceipts, deadlineOf, kAttr, kOfAttr, newTurn, type InFlight, type ParentK, type Slot as ReceiptSlot } from "./receipts.js";
import { renderInFlight } from "../shared/turn-state.js";
import { startIdleNudge } from "./idle-nudge.js";
import { renderReminder, type TurnTag } from "../shared/reminder.js";
import { createHandoffs, handedOff, handingOff, type Owe, type Pending as PendingHandoff } from "./handoff.js";
import { coldGateOf, decide, rankCandidates, renderCandidates, tierFor, wakeNoteOf, type RouteRow } from "./route.js";
import { parseWhen, renderChatLog, UNKNOWN_HUMAN, type LogSession } from "./chat-log.js";
import { audienceOf } from "../shared/role-view.js";
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
  // 记忆整理者的执行体, 同样只有 mirror 模式给得出 —— 赋值见 scheduledTaskInject 旁边。
  let stewardRun: ((prompt: string) => Promise<{ ok: boolean; reason?: string }>) | undefined;
  let stewardWiring: { refsOf?: RefsOf; onMerged?: (mds: readonly string[]) => void } = {};
  let scheduledTaskInject:
    | ((target: string, text: string, opts: { taskId: string; fresh: boolean; quiet: boolean }) => Promise<{ ok: boolean; reason?: string }>)
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
  // 共享记忆的整理者改成了 daemon 内建定时器 (memory-steward.ts); 老版本写下的那条
  // 定时任务要在任务表加载前停用, 否则两路并跑。
  try {
    const retired = retireStewardTask();
    if (retired) log.info({ retired }, "memory steward task file retired");
  } catch (e) { log.warn({ err: (e as Error).message }, "memory steward task not retired"); }
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
    urlOf: (t) => chatUrlFor(cfg.daemon, t),
    resolve: (name) => {
      const t = wizardStore()?.byName(name)?.target;
      return t && known(t) ? t : undefined;
    },
    nameOf: (t) => settleName(wizardStore(), chatNameOf(cfg, t), t),
  });
  // 人话也过交接的闸 (见 handoff.ts): 交接期间说的话进新会话, 不被旧会话带走、也不在
  // 重开的空档里 resume 回旧 sid。
  // 宪章守卫 (见「改配置会不会动到宪章」): 要等下面宪章渲染那一块立起来才有; 之前 (启动时那次自动补名) 只写不比对。
  let guardCharter: CharterGuard = (write) => ({ r: write(), note: Promise.resolve("") });
  installInboundRouter(ws.client, cfg, log, { ...bridge, dispatch: async (a) => (await handedOff(a.principal), bridge.dispatch(a)) }, sourcePath, (w, c) => guardCharter(w, c));
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
    // 告知那一句接着被取消的那一轮说: 频道照它的走 —— 不带频道就等于在 home 群里开口。
    tell: async (sid: string, text: string): Promise<{ ok: boolean; reason?: string }> => {
      const t = bridge.targetForSession(sid);
      return t ? await bridge.injectText(t, text, undefined, { channel: bridge.currentChannel(t) }) : { ok: false, reason: "no mirror target for session" };
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
  // 写敏感状态的路由只认出示口令的 —— wezard 的 MCP server 与 CLI 读得到 0600 的口令文件
  // (见 shared/daemon-token.ts), 本机别的进程 curl 不进来: 写配置、改 allowFrom 的认领
  // 口令、落一份 daemon 会执行其 gate 的任务文件, 都不该是谁连上 127.0.0.1 就能做的。
  const daemonToken = loadOrCreateSvrToken(DAEMON_TOKEN_FILE);
  const tokenOk = (req: import("node:http").IncomingMessage): boolean => {
    const got = Buffer.from(String(req.headers[DAEMON_TOKEN_HEADER] ?? ""));
    const want = Buffer.from(daemonToken);
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const guarded = (h: Handler): Handler => async (req, res, url, ctx) => {
    if (tokenOk(req)) return h(req, res, url, ctx);
    json(res, 403, { ok: false, reason: `这条路由要出示 ${DAEMON_TOKEN_FILE} 里的口令 (header ${DAEMON_TOKEN_HEADER}); 正在跑的 wizard 若是旧版 MCP 进程, 重开会话即可` });
  };
  http.register("POST /claim/start", guarded(makeClaimStartHandler({ log: log.child({ mod: "claim" }) })));
  http.register("GET /claim/status", makeClaimStatusHandler());
  http.register("POST /claim/reset", guarded(makeClaimResetHandler()));
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
      // silent: 新 wizard 就位不进群 (生命周期事件), 同群的 wizard 从名册增量里得知。
      const r = await m.newSession(target, name, body.cli, { cwd, model, keepalive, silent: true });
      if (!r.ok && !existed) wizards.drop(target);
      if (r.ok) postRoster(base, [target, self], { op: "born", name: `.${name}`, by: displayName(self), cwd: r.cwd }, subjectOf(wizards.get(target)));
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
      // 聊天名进宪章: 过宪章守卫, 受影响的 wizard 被提醒 handoff, 调用方自己受影响的那段话放在 `charter`。
      const byHuman = !!askerOf(self)?.who.startsWith("user:");
      const charterOf = async (note: Promise<string>): Promise<{ charter?: string }> => ((t) => (t ? { charter: t } : {}))((await note).trim());
      if (raw === "-") {
        const { r: gone, note } = guardCharter(() => clearChatName(cfg, sourcePath, self), (g) => g ? { what: `\`name_chat\` 取消了聊天名 \`${g}\``, self, byHuman } : undefined);
        json(res, 200, { ok: true, base: baseOfKey(self), name: "", previous: gone, ...(await charterOf(note)) });
        return;
      }
      const previous = chatNameOf(cfg, self);
      const home = baseOfKey(self);
      const { r, note } = guardCharter(() => {
        const r = setChatName(cfg, sourcePath, self, raw);
        if (!r.ok) return r;
        // 默认 wizard 的名字取自聊天名; 它还叫旧聊天名 (没被单独改过) 就跟着改。
        const cur = wizards.get(home)?.name ?? "";
        return { ...r, wizardRenamed: previous && cur.toLowerCase() === previous.toLowerCase() ? wizards.rename(home, r.name) : undefined };
      }, (r) => r.ok && r.name !== previous ? { what: `\`name_chat\` 把聊天${previous ? ` \`${previous}\`` : ""}改名为 \`${r.name}\``, self, byHuman } : undefined);
      if (!r.ok) { json(res, 409, { ok: false, reason: r.reason }); return; }
      if (r.wizardRenamed) void m.retitlePane(home);
      json(res, 200, { ok: true, base: r.base, name: r.name, previous, ...(r.wizardRenamed ? { wizardRenamed: r.wizardRenamed } : {}), ...(await charterOf(note)) });
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
        .catch((e: unknown) => log.warn({ chatId, err: errText(e) }, "chat notify failed"));
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
    // 没开顶层模式的群里公开气泡多了 → 往那个群的管家 (群默认会话, target 就是 base principal) 信箱挂一行,
    // 让它问人要不要开顶层模式 (见 top-only-nudge.ts)。路径里写聊天名: 管家照抄就能 config_set。
    const topOnlyNudge = createTopOnlyNudge({
      store: loadJsonMap<NudgeRow>("~/.wezard/top-only-nudge.json", gcNudge),
      policy: () => ((p) => ({ windowMs: p.windowMin * 60_000, threshold: p.threshold, cooldownMs: p.cooldownH * 3_600_000 }))(cfg.wrc.mirror.topOnlyNudge),
      nudge: (chat, n) => {
        const p = cfg.wrc.mirror.topOnlyNudge;
        notices.post([chat], renderNudge(policyKeyOf(chatNameOf(cfg, chat), chat), n, p.windowMin, p.cooldownH));
        log.info({ chat, n }, "top-only nudge: 已提醒管家问人要不要开顶层模式");
      },
    });
    /** 公开的 wizard 间对话: 落在 `channel` 这个群。 */
    const relayPeer = (from: string, to: string, body: string, channel: string): void => {
      const text = body.trim();
      if (!text || !channel) return;
      const head = `${relayLabel(from)} → ${relayLabel(to)}`;
      const clipped = text.length > RELAY_MAX ? `${text.slice(0, RELAY_MAX)}…` : text;
      // 头独占一行, 正文自成一个块 —— 只隔一个换行的话, markdown 会把正文首行
      // 当成头那一段的续行; 表格因此整张塌成一行带竖线的文字 (表格不能打断段落)。
      notifyChat(channel, `${head}\n\n${clipped}`);
      if (!chatPolicyOf(cfg, channel).topOnly) topOnlyNudge.count(baseOfKey(channel));
    };
    /** 调用方这一轮所在的公开频道: 人从哪个群叫的它 / 公开 peer 轮的那个群;
     *  私聊轮或无记录 → 它的 home 群。notify 与 public send_peer 默认发到这里。 */
    const channelOf = (self: string): string => m.currentChannel(self) || baseOfKey(self);
    /** 同伴注入的信封: 公开轮写上那个群的名字, 私聊不写 (见 peers.renderPeerEnvelope)。 */
    const envelopeFor = (from: string, channel: string, t?: TurnTag & { legs?: number }): string =>
      renderPeerEnvelope(displayName(from), channel ? chatNameOf(cfg, channel) : undefined, t);
    // 回执 (见 receipts.ts): 一次 tell_peer 之后对方干完那一轮, 它的结论自动 paste
    // 回发话方的输入框, 发话方全程不阻塞。这里只提供四样能力给那个模块 —— 忙闲、
    // 死活、「它答我那一句的是哪段话」、以及怎么把一段话送进去 —— 投递逻辑在那边。
    // 工单账本 (见 jobs.ts)。只在**显式传了 `job`** 时起作用 —— 不用工单的调用方
    // 行为与从前一模一样。回执要数它的成员, 所以先于回执载入。
    const jobs = loadJobStore(cfg.wrc.mirror.jobsFile);
    /** 回执那一轮在群里的终句答给谁 (userid) —— 与 rolepage 同一个判定, 写进信封给模型与
     *  read_chat; 认不出 = ""。 */
    const audienceName = (channel: string, asker: Asker | undefined): string => {
      const id = audienceOf(channel, asker);
      return id === "human:" ? "" : id.slice("human:".length);
    };
    // 挂起事项表 (见 pending-items.ts): 派活时记一行, 回执落定时由下面的 onOutcome 记账。
    const ledger = createLedger(loadJsonMap<PendingItem>(cfg.wrc.mirror.pendingFile, pendingGc));
    const receipts = createReceipts({
      idleNow: m.idleNow,
      onOutcome: (s, status, bodyText, bySender) => ledger.outcome(s.from, s.turn ?? "", status, parseClosing(bodyText).text || bodyText, bySender),
      jobTally: (id) => jobs.tally(id),
      parkedNow: m.parkedNow,
      settleJob: (id, target, outcome, artifacts) => { jobs.settle(id, target, outcome, artifacts); },
      accept: (id, body) => { const j = jobs.get(id); return j?.status === "open" ? rejectReason(j.accept ?? "result", parseClosing(body)) : undefined; },
      rebound: async (x, why) => (await m.injectText(x.to, `（守护进程代 ${displayName(x.from)} 打回一次: 这件活是工单里的一份, 你的回复${why}。请按约定收口 —— 末尾一行 \`RESULT: <结论>\`, 交付了文件每个加一行 \`ARTIFACT: <路径> — 一句话\`; 真缺信息就 \`NEED: <问题>\`。）`, undefined, {
        from: { kind: "peer", from: x.from, turn: x.turn, ...(x.asker ? { asker: x.asker } : {}) },
        channel: x.channel,
        envelope: envelopeFor(x.from, x.channel, { turn: x.turn, legs: x.legs, re: true }),
      })).ok,
      untilIdle: m.untilIdle,
      paneLive: m.paneLive,
      nameOf: displayName,
      log,
      store: loadJsonMap<ReceiptSlot>(cfg.wrc.mirror.receiptsFile),
      handingOff,
      handedOff,
      replyFor: (to, fromName, since, turn) => m.replyToPeer(to, fromName, since, turn),
      lastWords: m.lastReply,
      deliver: (to, bodyText, meta) =>
        m.injectText(to, clipMiddle(bodyText), undefined, {
          // receipt:true 是「这一轮不该再生回执」的记录 —— 回环在结构上就不成立:
          // 只有 tell_peer 那条路登记 watcher, 这里是直接注入。
          from: { kind: "peer", from: meta.from, receipt: true, status: meta.status, ...(meta.turn ? { turn: meta.turn } : {}), ...(meta.job ? { job: meta.job, done: meta.done, total: meta.total } : {}), ...(meta.asker ? { asker: meta.asker } : {}) },
          channel: meta.channel,
          envelope: renderReceiptEnvelope(
            displayName(meta.from),
            meta.channel ? chatNameOf(cfg, meta.channel) : undefined,
            meta.job ? { job: meta.job, done: meta.done, total: meta.total, closed: jobs.get(meta.job)?.status !== "open", ...(jobs.get(meta.job)?.kind === "req" ? { req: true } : {}) } : undefined,
            meta.status,
            meta.turn || undefined,
            {
              ...(meta.replyTo ? { replyTo: meta.replyTo.kind === "chat" ? chatNameOf(cfg, meta.replyTo.channel) : displayName(meta.replyTo.from) } : {}),
              ...(meta.k ? { k: kAttr(meta.k) } : {}),
              ...(meta.pending ? { pending: meta.pending } : {}),
              ...(audienceName(meta.channel, meta.asker) ? { audience: audienceName(meta.channel, meta.asker) } : {}),
            },
          ),
        }),
    });
    const turnsLine = (xs: readonly InFlight[], target: string): string => renderInFlight(xs, target, displayName);
    // reload 前在飞的回执: 等 mirror 把绑定都恢复了再续守 —— 早一步读 target 会拿不到
    // transcript, 退回按时刻取就可能把上一件事的结论当回执。
    // 交接 (见 handoff.ts): 换会话不换身份。这里给它重开、贴话、读旧 transcript 的能力,
    // 闸、回执清点与断点续做在那边。
    const pingSigs = keepalivePingSigs(cfg.wrc.mirror.keepalive.ping);
    /** 情景记忆 (memory/episodes/<name>.jsonl) 按名字归档; 默认会话没名字时退回 slot / "default"。 */
    const episodeName = (t: string): string => wizards.get(t)?.name || tagOfKey(t) || "default";
    const handoffs = createHandoffs({
      isBusy: m.isBusy,
      sessionId: (t) => m.sessionInfo(t)?.sessionId ?? "",
      restart: (t) => restartFresh(t),
      // 欠着回执的发话方挂上它的信封: 新会话那一轮就是在答它, 回执照常按信封定位, 频道也接回
      // 原来那一句所在的地方 (私聊不进群)。欠好几份时每份各开一轮 (见 carryRest): 并成一句,
      // 那一轮就只有一个去向, 别的上游拿到的是答给第一份的话。
      inject: async (t, text, owe, channel) => {
        const [first, ...rest] = owe;
        if (!first) return m.injectText(t, text, undefined, { channel });
        const r = await m.injectText(t, text, undefined, carryOpts(first));
        if (r.ok && rest.length) void carryRest(t, rest);
        return r;
      },
      channelOf: m.currentChannel,
      lastText: m.lastText,
      answeredBefore: (to, from, since, until, turn) => {
        const p = m.sessionInfo(to)?.jsonlPath;
        return p ? replyClosedBefore(expandHome(p), displayName(from), since, until, pingSigs, turn) : undefined;
      },
      receipts,
      // 交接是生命周期事件, 不进群; 失败只捎给它自己 (它调完 handoff_self 拿到的是
      // scheduled:true, 不说的话它不知道上下文其实没换)。
      notify: (t, text) => notices.post([t], text),
      log,
      store: loadJsonMap<PendingHandoff>(cfg.wrc.mirror.handoffsFile),
      archive: (e) => {
        if (!e.brief.trim()) return;
        const name = episodeName(e.target);
        const ok = appendEpisode(episodePath(cfg.daemon.stateDir, name), { at: e.at, kind: "handoff", name, sid: e.sid, nextSid: e.nextSid, text: e.brief });
        if (!ok) log.warn({ target: e.target, name }, "handoff episode not archived");
      },
    });
    /** 交接续答一份欠账的那一句: 挂发话方的信封, 出处与频道都是它当初那一句的。 */
    function carryOpts(o: Owe): { from: TurnFrom; channel: string; envelope: string } {
      return {
        from: { kind: "peer", from: o.from, ...(o.turn ? { turn: o.turn } : {}), ...(o.channel ? { public: true } : {}), ...(o.asker ? { asker: o.asker } : {}) },
        channel: o.channel,
        envelope: envelopeFor(o.from, o.channel, o.turn ? { turn: o.turn } : undefined),
      };
    }
    /** 简报那一轮之后, 余下的欠账一份一轮: 等它接住上一句 (至多 20s 动起来) 并答完, 再贴下一份。 */
    async function carryRest(t: string, owe: readonly Owe[]): Promise<void> {
      for (const o of owe) {
        for (const end = Date.now() + 20_000; Date.now() < end && (await m.idleNow(t)); ) await sleep(1000);
        await m.untilIdle(t, 3600_000);
        const r = await m.injectText(t, `（交接续答）接着上面的简报: 你交接前还欠 ${displayName(o.from)} 一个交代${o.turn ? ` (件 \`${o.turn}\`)` : ""} —— 现在只就这件收口。`, undefined, carryOpts(o));
        log.info({ mod: "handoff", target: t, from: o.from, turn: o.turn, ok: r.ok, reason: r.reason }, "handoff: 欠账续答");
      }
    }
    /** `self` 此刻这一轮派出去的活, 结论该交给谁 (见 receipts.parentOf)。只读它自己
     *  transcript 里开这一轮的那句 user 行的信封: attachment 上的 channel 在注入时就被
     *  排队的下一句改写了, transcript 才记着「这一轮是谁发起的」, reload 后也读得到。 */
    /** `target` 手上这一轮是哪件 peer 活 —— 认开头那句的信封: 有件号按件号, 老信封按发话方。 */
    /** `target` 手上这一轮若是某个 wizard 派来的活: 发话方的称呼 (`.x`) 与件号。人 / 定时 / 回执轮 = undefined。 */
    const openingAsk = (target: string): { from: string; turn?: string } | undefined => {
      const p = m.sessionInfo(target)?.jsonlPath;
      const env = p ? openingTurn(expandHome(p), pingSigs)?.env : undefined;
      return env?.kind === "peer" && !env.receipt ? { from: env.from, ...(env.turn ? { turn: env.turn } : {}) } : undefined;
    };
    const currentAsk = (target: string): ((x: { from: string; turn: string }) => boolean) => {
      const env = openingAsk(target);
      if (!env) return () => false;
      return (x) => (env.turn ? x.turn === env.turn : displayName(x.from) === env.from);
    };
    /** 打断 `target` 会不会误伤别人的活: 它正忙, 且这一轮不是调用方派的 —— 别的 wizard 派的、
     *  人说的、定时任务放的 → 那一方的称呼。回执轮是它自己那件活的延续, 不算别人的。 */
    const othersTurn = async (target: string, self: string): Promise<{ from: string; turn?: string } | undefined> => {
      if (await m.idleNow(target)) return undefined;
      const p = m.sessionInfo(target)?.jsonlPath;
      const env = p ? openingTurn(expandHome(p), pingSigs)?.env : undefined;
      if (env?.receipt) return undefined;
      if (env?.kind === "peer") return env.from === displayName(self) ? undefined : { from: env.from, ...(env.turn ? { turn: env.turn } : {}) };
      return { from: env?.kind === "task" ? env.from : env?.from ? `人 (${env.from})` : "人" };
    };
    const openingOfSelf = (self: string) => {
      const p = m.sessionInfo(self)?.jsonlPath;
      return p ? openingTurn(expandHome(p), pingSigs) : undefined;
    };
    const parentKOf = (self: string): ParentK | undefined => {
      const opening = openingOfSelf(self);
      // 不用 channelOf: 它把私聊轮 ("") 回落成 home, 私聊轮派出的活就会续回 home 群。
      return receipts.parentOf(self, opening?.env, m.currentChannel(self), String(opening?.ms ?? 0));
    };
    /** `self` 此刻这一轮的链头 (见 Asker), 同样认开头那句的信封: 人在群里说的 → 信封上的
     *  userid 与群; 与人的单聊里没挂信封 → 那个人; 同伴派的活 / 回执 → 登记那件活时记下的;
     *  定时任务、CLI 敲字、认不出 → undefined (如实不知道, 不猜)。 */
    const askerOf = (self: string): Asker | undefined => {
      const env = openingOfSelf(self)?.env;
      const home = baseOfKey(self);
      if (!env) return home.startsWith("user:") ? { who: home, chat: home } : undefined;
      if (env.kind === "human") {
        const chat = env.chat ? chatBaseOf(cfg, env.chat) : home;
        return chat ? { who: `user:${env.from}`, chat } : undefined;
      }
      return env.kind === "peer" ? receipts.askerOf(self, env) : undefined;
    };
    // 交接先续做: 它的闸要在回执续守之前立起来, 否则续守的 watcher 会读到换了一半的会话。
    void m.restored.then(() => { handoffs.resume(); receipts.resume(); });
    // 闲置追问 (见 idle-nudge.ts): 对方持续闲着又没回执 → 代发话方同件号问一句进展, 答复照常回执。
    // 注入照抄工单打回 (rebound) 那条: 私聊信封挂发话方的名义与件号, 父 k 等由 reask 沿用原件。
    void m.restored.then(() => startIdleNudge({
      inflight: () => receipts.states(),
      idleNow: m.idleNow,
      handingOff,
      jobOpen: (id) => jobs.get(id)?.status === "open",
      policy: () => ({ afterMs: cfg.wrc.mirror.idleNudge.afterMin * 60_000, max: cfg.wrc.mirror.idleNudge.max }),
      ask: async ({ from, to, turn, text }) => {
        const x = receipts.reask(from, to, turn);
        if (!x) return false;
        ledger.touch(from, turn);
        return (await m.injectText(to, text, undefined, {
          from: { kind: "peer", from, turn, ...(x.asker ? { asker: x.asker } : {}) },
          channel: x.channel,
          envelope: envelopeFor(from, x.channel, { turn, legs: x.legs, re: true }),
        })).ok;
      },
      nameOf: displayName,
      store: loadJsonMap<{ asks: number }>(join(cfg.daemon.stateDir, "idle-nudges.json")),
      log: log.child({ mod: "idle-nudge" }),
    }));
    /** 入参里的地址: 新字段 `name`, 老 MCP 进程 (正在跑的 wizard) 仍在传 `tag`。 */
    const addrOf = (b: { name?: unknown; tag?: unknown }): string => String(b.name ?? b.tag ?? "");

    /** 撞上的名字属于一个静默超过一天的 wizard → 顶掉它 (见 evictStaleName), 同群的
     *  wizard 收到一行名册变动; 返回是否腾出了名字。 */
    const displace = async (name: string, keep: readonly string[]): Promise<boolean> => {
      const gone = await evictStaleName(wizards, name, keep, { lastActivity: m.lastActivity, retire: m.killPane });
      if (!gone) return false;
      const slot = !!tagOfKey(gone.target);
      log.child({ mod: "wizard" }).info({ target: gone.target, name: gone.name, slot }, "stale name evicted");
      postRoster(baseOfKey(gone.target), [], { op: "ended", name: `.${gone.name}`, why: slot ? "evicted (idle >1d, name reused)" : "name yielded (idle >1d)" }, subjectOf(gone));
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
        json(res, 400, { ok: false, reason: `认不出这些聊天: ${bad.join(", ")} (wizard_roster 每行有 home 聊天名, 人侧 /chats; 没起名的聊天寻址不到)` });
        return;
      }
      const dests = [...new Set(refs.length ? refs.map((r) => chatBaseOf(cfg, r)) : [channelOf(self)])];
      // 顶层模式: 只有顶层 wizard 对人说话。拦的是「这一轮在为同伴干活」的: 同伴私聊派来的活, 或
      // 回执轮但那件活是为上游同伴派的 (k 是 peer)。人说的、定时任务放的、旁支 (chain:false, 无 k)
      // 的回执轮都不拦; 管家只在自己的群里豁免。
      const env = openingOfSelf(self)?.env;
      const belowTop = env?.kind === "peer" && (env.receipt ? kOfAttr(env.k ?? "")?.kind === "peer" : env.private);
      const muted = dests.filter((d) => chatPolicyOf(cfg, d).topOnly && !(!tagOfKey(self) && baseOfKey(self) === d));
      if (muted.length && belowTop) {
        json(res, 409, { ok: false, topOnly: true, reason: `${muted.map((d) => chatNameOf(cfg, d) || d).join(", ")} 开着顶层模式: 你这一轮是同伴派来的活, 不对人说话 —— 要说的写进终句 (\`RESULT:\` / \`NEED:\`), 由派你的那个代你向人交代` });
        return;
      }
      const asker = askerOf(self);
      for (const dest of dests) {
        notifyChat(dest, `${relayLabel(self)}\n\n${content}`);
        recordPost({ target: self, channel: dest, body: content, ...(asker ? { asker } : {}) });
      }
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
      const inflight = turnsLine(receipts.states(), target);
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
        text: [`${displayName(target)} · ${state}${foreign ? ` · 住在群 ${chatNameOf(cfg, target) || "(未命名)"}` : ""}`, ...(inflight ? [inflight] : []), peek.dialog ?? `(${peek.reason})`].join("\n"),
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
        homeHuman: home.startsWith("user:") ? home.slice(5) : UNKNOWN_HUMAN,
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
      if (chatRef && !base) { json(res, 404, { ok: false, reason: `认不出聊天 '${chatRef}' (wizard_roster 每行有 home 聊天名, 人侧 /chats)` }); return; }
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

    // 跟另一个 wizard 说一句话。`tell_peer` 是它现在的名字 —— 「说」而不是「发送并
    // 等待」: 调用方注入完就返回, 对方干完那一轮的结论由守护进程自动送回来 (receipts)。
    // `/peers/send` 保留为同一个处理函数: 正在跑的 wizard 的 MCP 进程是旧代码, 换名字
    // 不能把它们的通路掐断。
    // 冷与否 = 缓存最近一次被碰 (最近一次真实请求的开始; 读不到退回 mtime) 距今多久 vs 它实际按多长 TTL 写的
    // (与 route_candidates 同一口径)。
    const touchOf = (p: string): number => { try { return cacheTouchMs(p) || statSync(p).mtimeMs; } catch { return 0; } };
    const ttlOf = (p: string): number => (cacheTtlSec(p) || cfg.wrc.mirror.keepalive.ttlSec) * 1000;
    // 被冷门控退回过的 `self\0target` → 到期时刻: 老 MCP 进程原样重发即视为 force。
    const coldRefused = new Map<string, number>();
    type Reply = { status: number; body: Record<string, unknown> };
    /** tell_peer 的本体: 以 `self` 的名义说一句 —— HTTP 路由与 dispatch 共用。`extra` = 挂在信封后面的
     *  一段 (只进对方输入框, 不进 `text`: 公开时 text 会成群气泡)。 */
    const tellPeerAs = async (self: string, body: PeerBody, extra = ""): Promise<Reply> => {
      const text = ((body as { text?: string }).text ?? "").toString();
      if (!text.trim()) { return { status: 400, body: { ok: false, reason: "text required" } }; }
      // 这句话要对方怎么接 (priority 管何时投, receipt 管要不要回执, 这个管它怎么接):
      // task 一件活 (默认) / ask 只答一问 / fyi 知会 —— fyi 不要回执、不进工单、不进群。
      const rawKind = (body as { kind?: string }).kind;
      const kind: "task" | "ask" | "fyi" = rawKind === "ask" || rawKind === "fyi" ? rawKind : "task";
      const r = resolvePeer(self, addrOf(body));
      if (!r.ok) { return { status: r.status, body: { ok: false, reason: r.reason, candidates: r.candidates } }; }
      const { target, foreign } = r;
      // 件号先于一切: `re` 续问沿用那件活的件号、工单与频道 (见 receipts.prepare)。
      const re = ((body as { re?: string }).re ?? "").toString().trim();
      const turn = receipts.prepare(self, target, re || undefined);
      // 续问只在那个工单还开着时沿用它: 收了工的工单不再收成员, 续问照样能发。
      // 没带工单的一句顶掉一份还没落定的工单活, 也算在那张工单上 (receipts.register 同理
      // 继承): 不然换个不带 job 的 tell_peer 就绕开了预算。
      const open = receipts.pending(self, target);
      const isOpen = (id?: string): string => (id && jobs.get(id)?.status === "open" ? id : "");
      const askedJob = ((body as { job?: string }).job ?? "").trim();
      // 挂起等子活的那份不算被顶掉: 它会按件号停放、自己计数, 新的一件不继承它的工单。
      // 返工兜底: 回执槽 24h 过期 / 被顶掉后, 带了 re 却落空成新件, 不带 job 就和根单断了 ——
      // 只在这种情形下, 发话方是某张开着的需求根单的 owner、目标恰是它的 lead 时才补上;
      // 没带 re 的普通 task / ask / dispatch 一律不并进根单。
      const leadJob = jobs.all().find((j) => j.kind === "req" && j.status === "open" && j.owner === self && j.members.some((x) => x.target === target && x.role === "lead"))?.id ?? "";
      const jobId = kind === "fyi" ? "" : askedJob || isOpen(turn.job) || (open?.deferred ? "" : isOpen(open?.job)) || (re && turn.reUnknown ? leadJob : "");
      if (jobId) {
        const jc = checkJob(jobId, target, !!open?.need && open.turn === turn.turn);
        if (!jc.ok) { return { status: jc.status, body: { ok: false, reason: jc.reason } }; }
      }
      // 公开与否由发话方 (LLM) 判断: 公开 = 在它这一轮的公开频道里说, 气泡进群、对方
      // 那一轮的回复也发进这个群; 私聊 (默认) = 只落双方的 rolepage, 回复靠 wait_peer 取。
      // 只有两端都是登记在册的 wizard 才能当着人说: 裸 target 冒充的发话方、forget
      // 掉的分身不是谁, 它们的往来进群只会留下一段人找不到主的对话 —— 降为私聊。
      // 工单里的派活一律私聊: 人看不懂 fan-out 的过程, 群里只留发起者自己的收口。
      // 知会不进群: 公开信封要对方「照对人说话的方式答」, 一句「收到」会被发给一群人。
      // 顶层模式 (chatPolicy.topOnly): 那个群里 wizard 之间不当着人说话 —— 公开与否不归模型判断,
      // 续问沿用的公开频道也一样降为私聊; 人只从顶层 wizard 的收口里听到结论。
      const wantPublic = !jobId && kind !== "fyi" && (turn.channel !== undefined ? !!turn.channel : (body as { public?: boolean }).public === true) && !!wizards.get(self) && !!wizards.get(target);
      const topOnly = wantPublic && chatPolicyOf(cfg, turn.channel || channelOf(self)).topOnly;
      const isPublic = wantPublic && !topOnly;
      const channel = isPublic ? turn.channel || channelOf(self) : "";
      // Injecting into your own pane would type into the box you're generating
      // from — Claude Code queues it and the caller deadlocks waiting for itself.
      if (target === self) { return { status: 400, body: { ok: false, reason: "refusing to inject into the calling session itself" } }; }
      // 它正在交接: 这句话等它换完会话再进 —— 投进旧会话会被交接一并带走, 投进重开中的
      // 空 pane 会 resume 回旧 sid (见 handoff.ts)。发话时刻取在这之后。
      await handedOff(target);
      // 投递策略。对方闲着三者一样 —— 立刻投; 只在它正忙时分岔:
      //   normal (默认) 等它这一轮结束再投 —— 派新活的常态: 两个 wizard 同时找第三个时,
      //     两段文本会挤进同一个输入框、被当成一轮读掉, 这在协同网络里不是边角情况而是常态;
      //   urgent 先打断它这一轮 (与 stop_wizard 的 interrupt 同一下 Esc) 再投 —— 紧急改道;
      //   now   不等不打断, 落进输入框由 CLI 并进它这一轮 —— 插话、补一句、答它的问。
      // 老 MCP 进程只认 `when` (默认 now): idle ≡ normal, now ≡ now。都没给时, `re` 续问默认 now ——
      // 续问是同一场来回里的应答, 对方可能正挂在 wait_peer 上等你, 等它闲下来就互相干等到超时。
      const bp = body as { priority?: string; when?: string };
      const asked: "normal" | "urgent" | "now" =
        bp.priority === "urgent" ? "urgent"
          : bp.priority === "normal" ? "normal"
            : bp.priority === "now" || bp.when === "now" ? "now"
              : bp.when === "idle" ? "normal"
                : re ? "now" : "normal";
      const waitSec = Math.min(Math.max(Number((body as { waitSec?: number }).waitSec ?? 600) || 600, 10), 3600);
      // 冷门控: 派新活 (task、不是续问、不是插话) 给一个冷且大的 wizard, 先退回一行让派活的
      // 算账 —— 唤醒它要整段重写缓存, 点名或职责对口只说明相关, 不说明划算。`force:true`
      // 是「真依赖它那段上下文」的明说。老 MCP 进程的 schema 里没有 force (请求里压根没这个键,
      // 新的一律显式带上): 同一对 10 分钟内原样再发一次就算 force, 不然它们被拦下就没有出路。
      const force = (body as { force?: boolean }).force;
      if (kind === "task" && !re && asked !== "now" && force !== true) {
        const gk = `${self}\0${target}`;
        const retried = force === undefined && (coldRefused.get(gk) ?? 0) > Date.now();
        coldRefused.delete(gk);
        const gi = retried ? undefined : m.sessionInfo(target);
        const gate = gi ? coldGateOf(`.${displayName(target).replace(/^\./, "")}`, gi.contextTokens, touchOf(gi.jsonlPath), Date.now(), ttlOf(gi.jsonlPath)) : "";
        if (gate) {
          if (force === undefined) coldRefused.set(gk, Date.now() + 10 * 60_000);
          return { status: 409, body: { ok: false, gated: "cold", reason: gate + (force === undefined ? " (你的 MCP 是旧版、没有 force 参数: 10 分钟内原样再发一次即视为 force)" : "") } };
        }
      }
      // 「忙」= 这一轮还没结束, 或停在审批上等人 —— 都不是能接新活的时候。
      const wasBusy = !(await m.idleNow(target));
      // urgent 只打断你自己派的那一轮 (或它自己的回执轮): 手上若是别的 wizard / 人 / 定时任务的活,
      // 打断就误伤了那件 —— 降成 normal, 等它这一轮做完再投。
      const others = asked === "urgent" && wasBusy ? await othersTurn(target, self) : undefined;
      const policy = others ? "normal" : asked;
      let waitedMs = 0;
      let interrupted: boolean | undefined;
      if (policy === "normal" && wasBusy) {
        const t0 = Date.now();
        // 它那一轮一结束就投: 注册表 status 翻 idle 是事件, 不抽样也不等稳定期。
        const wr = await m.untilIdle(target, waitSec * 1000);
        waitedMs = Date.now() - t0;
        if (!wr.idle) {
          return { status: 409, body: { ok: false, target, foreign, wasBusy, waitedMs, reason: `它一直在忙, ${waitSec}s 内没闲下来 —— peek_peer 看看它卡在哪; 真急就 priority:"urgent" 打断它` } };
        }
      }
      if (policy === "urgent" && wasBusy) {
        // 只按 Esc, 不走 /stop 的 teardown: 那会清掉它的注入队列 (别人排着的话一起丢)
        // 并暂停 keepalive —— 这里打断它是为了马上接着干, 不是让它安静。
        const t0 = Date.now();
        const esc = await m.interruptPane(target);
        // 等 Esc 生效、这一轮真收住再投; 收不住也照投 —— 落进输入框排在后面, 退化成 now。
        interrupted = esc.ok && (await m.untilIdle(target, 15_000)).idle;
        waitedMs = Date.now() - t0;
      }
      // 时刻取在注入**之前**: 晚于那一句落盘的话, 回执定位的下界就偏了。
      const at = Date.now();
      // 唤醒代价同样要在注入之前量: 投进去 transcript 一动, 就看不出它冷了多久。
      const info = m.sessionInfo(target);
      const wake = info?.jsonlPath
        ? wakeNoteOf(info.contextTokens, touchOf(info.jsonlPath), at, ttlOf(info.jsonlPath))
        : "";
      const deadlineSec = (body as { deadline?: number }).deadline;
      // 回执: 对方干完那一轮, 守护进程把它的结论自动送回来 (默认开)。`receipt:false`
      // 是"放出去就不管了"的那种派活; fyi 一定不要。对方的信封据此改口, 不再让它收口。
      const wantReceipt = kind !== "fyi" && (body as { receipt?: boolean }).receipt !== false;
      const deadlineAt = deadlineOf(at, deadlineSec === undefined ? undefined : Number(deadlineSec));
      const asker = askerOf(self);
      const inj = await m.injectText(target, text, undefined, {
        from: { kind: "peer", from: self, turn: turn.turn, ...(jobId ? { job: jobId } : {}), ...(isPublic ? { public: true } : {}), ...(asker ? { asker } : {}) },
        channel,
        envelope: envelopeFor(self, channel, {
          turn: turn.turn,
          legs: turn.legs,
          ...(turn.legs > 1 ? { re: true } : {}),
          // 期限只在发话方明说时写给对方看: 默认的一小时不值得每轮多一句。
          ...(deadlineSec !== undefined ? { deadline: deadlineAt } : {}),
          ...(kind !== "task" ? { act: kind } : {}),
          ...(wantReceipt ? {} : { quiet: true }),
        }) + extra,
      });
      // 注入失败就不守 —— 没有问话, 也不会有回答。不要回执 (receipt:false / fyi) 就不登记:
      // 一份不守的槽会以同一对的 key 顶掉发话方还在等它答的那件活, 那件的回执就再也来不了。
      // 父 k: 默认这件活算发话方此刻在答的那件的子活 (链式续回); `chain:false` = 旁支,
      // 回执照常回来, 但不挂住它给上游的交代 —— 只有发话方知道这件活是不是为上游派的。
      const k = (body as { chain?: boolean }).chain === false ? undefined : parentKOf(self);
      if (inj.ok && wantReceipt) receipts.register({ from: self, to: target, channel, job: jobId, at, turn: turn.turn, legs: turn.legs, deadlineAt, ...(k ? { k } : {}), ...(asker ? { asker } : {}) });
      if (inj.ok && wantReceipt) {
        if (turn.legs > 1) ledger.touch(self, turn.turn);
        else ledger.open({ turn: turn.turn, owner: self, to: target, text, at, ...(jobId ? { job: jobId } : {}), ...(k ? { for: k } : {}), ...(asker ? { asker } : {}) });
      }
      // 工单成员照旧记账 (收工那一条会列出各自那段活); 公开的那一句在群里成气泡。
      // 续问 (re) 不是一段新活: 工单页与留档里该列的仍是当初派的那段。
      if (inj.ok && jobId) {
        const role = roleParam((body as { role?: string }).role);
        // G2: 需求根单的 owner 答了 lead 的 NEED —— 方案闸过了 (只记第一次)。
        const rj = jobs.get(jobId);
        if (rj?.kind === "req" && self === rj.owner && !rj.gate?.g2 && !!open?.need && open.turn === turn.turn && rj.members.some((x) => x.target === target && x.role === "lead")) jobs.mark(jobId, { gate: { g2: Date.now() } });
        jobs.attach(jobId, { target, task: turn.legs > 1 ? "" : text, spawned: false, ...(role ? { role } : {}) }, kind === "ask" ? "ask" : "task");
      }
      const spent = inj.ok && jobId ? jobs.spend(jobId) : undefined;
      if (inj.ok && isPublic) relayPeer(self, target, text, channel);
      // `wasBusy` 是给调用方的判断依据: 立刻投给一个正在生成的会话, 这句话会排在
      // 它这一轮后面, 而不是马上被读到。
      return { status: inj.ok ? 200 : 502, body: {
        ...inj,
        name: peerAddress(cfg, self, target),
        public: isPublic,
        ...(topOnly ? { topOnly: "这个群开着顶层模式: wizard 之间一律私聊, 已按私聊投出; 结论回到你这儿, 由你 (或你的上游) 对人收口" } : {}),
        priority: policy,
        ...(kind !== "task" ? { kind } : {}),
        ...(kind === "fyi" && askedJob ? { jobIgnored: true } : {}),
        ...(others ? { urgentDowngraded: `它此刻在做 ${others.from} 派的活, 没打断它 —— 按 normal 等它这一轮做完再投` } : {}),
        wasBusy,
        ...(interrupted !== undefined ? { interrupted } : {}),
        ...(waitedMs ? { waitedMs } : {}),
        ...(jobId ? { job: jobId } : {}),
        ...(inj.ok ? { turn: turn.turn } : {}),
        ...(spent?.maxTurns ? { budget: `${spent.turns}/${spent.maxTurns}${spent.turns >= spent.maxTurns ? " —— 用完了, 这是最后一次派活, 下一步收口" : ""}` } : {}),
        ...(inj.ok && wake ? { wakeCost: wake } : {}),
        ...(turn.reUnknown ? { reUnknown: true, reNote: `re "${re}" 不是你正在等 ${displayName(target)} 答的那件, 按新活发出` } : {}),
        // 回执怎么回来 —— 写在回包里, 调用方 (模型) 不必从工具描述里回忆。
        ...(inj.ok && wantReceipt
          ? { receipt: "它干完那一轮, 结论会作为新的一轮自动进到你这里 —— 不要挂在 wait_peer 上等, 接着干你自己的事" }
          : {}),
        ...(inj.ok && wantReceipt && k?.kind === "peer"
          ? { chained: `这件活算在你答 ${displayName(k.from)} 的那件 (${k.turn}) 名下: 它回来之前, 你这一轮的终句不会先交给 ${displayName(k.from)}; 与那件活无关就带 chain:false 发` }
          : {}),
      } };
    };
    const tellPeer: Handler = async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const r = await tellPeerAs(self, body);
      json(res, r.status, r.body);
    };
    http.register("POST /peers/tell", tellPeer);
    http.register("POST /peers/send", tellPeer); // 老 MCP 进程还在调这个名字

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
        // 取走就占位: 同一段话不会再作为回执 paste 进来一遍 (见 receipts.claim)。
        const full = wr.idle ? m.lastReply(h.target, receipts.sentAt(self, h.target)) : "";
        const already = full ? receipts.claim(self, h.target) : false;
        const closing = parseClosing(full);
        const result = closing.kind === "result" ? closing.text : "";
        return {
          name: h.address,
          idle: wr.idle,
          // 回执早一步到了: 这段话已经作为新的一轮进过你的会话, 别再处理第二遍。
          ...(already ? { delivered: true } : {}),
          ...(wr.reason ? { reason: wr.reason } : {}),
          ...(closing.kind === "need" ? { need: closing.text } : {}),
          ...(closing.artifacts.length ? { artifacts: closing.artifacts } : {}),
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

    // 交接的「重开」一步: 走 /new (杀旧 pane、起新进程) 而不是往原 pane 注入 /clear。
    // /clear 只换会话不换进程 —— MCP 子进程、charter 都还是旧的, 新工具拿不到; 镜像
    // 还得靠 sid 轮换探测才跟得上。模型 / CLI / cwd / keepalive 照旧沿用。
    const restartFresh = (target: string) => {
      const info = m.sessionInfo(target);
      return m.newSession(target, displayName(target) || tagOfKey(target) || target, info?.cli, { model: info?.model || undefined, silent: true, warm: true });
    };

    // POST /handoff — 交接一个 pane 的会话给一个全新会话。先让目标会话把当前工作
    // 压成一份"零上下文也能接手"的交接简报,等它写完并抓取,再 restartFresh 换一个
    // 全新的进程(同名、同 cwd),把简报作为新会话的首条消息贴进去。拒绝对调用方
    // 自身操作(会 deadlock,同 /peers/send)。
    /** 交接自己: 简报由调用方给, 排在它这一轮说完之后 (见 handoff.ts)。/handoff 点名点到
     *  自己与老路由 /wizard/handoff-self 共用。 */
    const handoffSelf = (self: string, brief: string): { status: number; body: Record<string, unknown> } => {
      if (brief.length < 40) return { status: 400, body: { ok: false, reason: "brief 太短 —— 要写到零上下文也能接手: 目标 / 已完成 / 当前状态 / 下一步 / 关键文件与坑" } };
      const info = m.sessionInfo(self);
      const r = handoffs.self(self, brief);
      return r.ok
        ? { status: 200, body: { ok: true, target: self, contextTokens: info?.contextTokens ?? 0, scheduled: true } }
        : { status: 409, body: { ok: false, reason: r.reason } };
    };
    http.register("POST /handoff", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const pane = ((body as { pane?: string }).pane ?? "").trim();
      let target: string | undefined;
      if (pane) {
        target = m.targetForPane(pane);
        if (!target) { json(res, 404, { ok: false, reason: `no mirror session bound to pane ${pane}` }); return; }
      } else {
        // 不点名不能落成「本聊天的默认 wizard」(resolvePeer 对 "" 的语义): 交接是把人家的
        // 上下文清掉重开, 一个漏传的参数不该把群管家交接掉。不点名的交接只能是交接自己。
        if (!addrOf(body).trim()) { json(res, 400, { ok: false, reason: "要点名 (name) —— 交接你自己走 /wizard/handoff-self (MCP: handoff 不传 name, 带 brief)" }); return; }
        const r = resolvePeer(self, addrOf(body));
        if (!r.ok) { json(res, r.status, { ok: false, reason: r.reason, candidates: r.candidates }); return; }
        target = r.target;
      }
      // 点名点到自己: 不能走「让它写简报」那条 (往正在生成的输入框里打字, 等自己等成
      // 死锁), 改走交接自己 —— 简报得由调用方自己给。
      if (target === self) {
        const brief = ((body as { brief?: string }).brief ?? "").toString().trim();
        if (!brief) { json(res, 400, { ok: false, reason: "这是交接你自己: 把简报写在 brief 里 (不传 name 即可; 旧会话的 handoff 没有 brief 参数, 用 wizard_handoff_self)" }); return; }
        const r = handoffSelf(self, brief);
        json(res, r.status, r.body);
        return;
      }
      const focus = ((body as { focus?: string }).focus ?? "").toString().trim();
      const timeoutMs = Math.min(Math.max(Number((body as { timeoutSec?: number }).timeoutSec ?? 600) || 600, 30), 7200) * 1000;
      const r = await handoffs.other(target, focus, timeoutMs);
      json(res, r.ok ? 200 : r.status, r.ok ? { ok: true, target, brief: r.brief } : { ok: false, target, reason: r.reason, ...(r.brief ? { brief: r.brief } : {}) });
    });

    // ── Wizard: 会话的身份层 ────────────────────────────────────────────
    // 一个会话 (`chat:xxx#k`) 从此是一个 wizard: 一个全局唯一的名字 (默认会话出生时
    // 取聊天名, 分身取自己的名字)、一句职责、一份跨会话的记忆、一条家谱。身份不靠"在对话里讲一遍"
    // 维持 —— spawn 时以 `--append-system-prompt` 压进那个进程, `/clear` 抹不掉、
    // 上下文窗口也挤不掉。
    // 这里只做三件事: 读身份、改身份、按身份生/收分身。tmux 一概不碰, 动作全在
    // mirror-bridge。
    const bornOf = (t: string): number | undefined => firstStamp(m.sessionInfo(t)?.jsonlPath ?? "");
    const wizards = bindWizardStore(loadWizardStore(cfg.wrc.mirror.wizardsFile, bornOf));

    // 名册增量的投递面 (见 notices.ts)。charter 只是出生那一刻的快照; 此后的成员
    // 变动从这里搭下一次注入的车进到每个在场 wizard 的上下文里, 不占一轮。
    // 一条变动只投给**同一个聊天**里在场的其他 wizard: 群成员变动是那个群的事,
    // 当事人自己做的自己知道, 所以排除在外。
    // 上下文逼近自动压缩时提醒一句「先记」: 压缩 / 交接都会丢细节。每段会话 (sid) 只提一次。
    const nudged = new Set<string>();
    // 线按模型的窗口算 (memoryNudgeAt); 模型取 transcript 里实际跑的那个 id, pane 记的常是空串或 `opus` 这种别名。
    const memoryNudge = (t: string): string[] => {
      const i = m.sessionInfo(t);
      // 最低的那条线先挡: 不到它就不必再读一次 transcript 取模型。
      if (!i?.sessionId || nudged.has(i.sessionId) || i.contextTokens < MEMORY_NUDGE_FLOOR) return [];
      if (i.contextTokens < memoryNudgeAt(lastModel(i.jsonlPath) || i.model)) return [];
      nudged.add(i.sessionId);
      return [`你的上下文已到 ${Math.round(i.contextTokens / 1000)}k, 快到自动压缩了: 这段里学到的、值得跨会话活下来的东西, 先 \`wizard_remember\` 记下 (自己的选 self, 属于群 / 仓库的选 chat / workspace), 再考虑 \`handoff\``];
    };
    // 越过交接判断线 (handoffAt) 也只提一次: 交接不是压缩, 不该等快满。同样每段会话一次 ——
    // 交接后换了 sid, 新会话再越线会再提。
    const handoffNudged = new Set<string>();
    const handoffNudge = (t: string): string[] => {
      const i = m.sessionInfo(t);
      if (!i?.sessionId || handoffNudged.has(i.sessionId) || i.contextTokens < handoffAt(lastModel(i.jsonlPath) || i.model)) return [];
      handoffNudged.add(i.sessionId);
      return [`你的上下文已到 ${Math.round(i.contextTokens / 1000)}k: 该判断要不要 \`handoff\` 了 —— 手上这摊活告一段落、或往后的活不再依赖前面的大段材料, 就交接 (值得跨会话留下的先 \`wizard_remember\`); 还在一件离不开它们的活中间, 做完这一段再交`];
    };
    // 挂起事项的提醒 (见 pending-items.digest): 只给管家 —— 各群的默认会话, 同时挂着多件活、
    // 又被人随时打断的就是它。上次全表时的样子纯内存: reload 后头一次见到只立基线。
    const pendingMarks = new Map<string, Mark>();
    /** 上次注入之后被 /clear 或压缩截断过的 (onContextCut 记, 下一次注入取走)。 */
    const pendingCuts = new Map<string, "clear" | "compact">();
    const liveOfTurns = (): LiveOf => {
      let byTurn: Map<string, InFlight> | undefined;
      return (turn) => (byTurn ??= new Map(receipts.states().map((x) => [x.turn, x]))).get(turn);
    };
    /** 管家等人验收的根单行 (需求已交付、单还开着)。 */
    const stalledRows = (owner: string): string[] =>
      stalledRoots(jobs.all(), owner, jobLive()).map(({ job, status }) => renderStalled(job.title, job.id, status));
    const awaitingRows = (owner: string, now: number): string[] =>
      awaitingAccept(jobs.all(), owner, jobLive()).map(({ job, at }) => renderAwaiting(job.title, job.id, at, now));
    const shelvedRows = (owner: string, now: number): string[] =>
      shelvedRoots(jobs.all(), owner).map((j) => renderShelved(j.title, j.id, j.hold ?? j.openedAt, now));
    const pendingNames = { nameOf: displayName, chatOf: (b: string) => chatNameOf(cfg, b) || b };
    /** 人在某个群最近一次开口 (内存; reload 丢了就当没说过): 重试冒泡避开人在场的时候。 */
    const humanAt = new Map<string, number>();
    /** 「人这句可能在验收某张」同一张至多隔 HEARD_EVERY_MS 提一次。 */
    const acceptHeard = new Map<string, number>();
    const pendingDigest = (t: string, via: Via): Part => (seen) => {
      const cut = pendingCuts.get(t);
      pendingCuts.delete(t);
      const now = Date.now();
      if (via.human) humanAt.set(via.human.channel, now);
      if (tagOfKey(t)) return { text: "", keys: [] };
      // 人在等验收那件需求的群里开了口: 这句可能就是验收 (是不是由管家判断)。与 digest 的 heard 同一个节流。
      const acceptLines = (via.human ? awaitingAccept(jobs.all(), t, jobLive()) : [])
        .filter(({ job }) => job.origin?.chat === via.human?.channel && now - (acceptHeard.get(job.id) ?? 0) >= HEARD_EVERY_MS)
        .map(({ job, at }) => {
          acceptHeard.set(job.id, now);
          return `heard? accept ${job.id} "${job.title}" delivered ${agoMs(now - at)} ago, awaiting the human's verdict: if this line is the verdict → close_job (ok) / tell_peer re to lead (not ok); else ignore`;
        });
      const rule = !seen("rule:pending");
      const items = ledger.openOf(t);
      // 没挂着的事: 不读会话, 也不留基线 —— 有了第一件再从那一刻立。
      if (!items.length) {
        pendingMarks.delete(t);
        const text = acceptLines.length ? renderDigest({ full: "", lines: acceptLines, touched: [], mark: { sid: "", ctx: 0, ctxAtFull: 0, drains: 0 } }, "", rule) : "";
        return { text, keys: text && rule ? ["rule:pending"] : [] };
      }
      const i = m.sessionInfo(t);
      const o = digest({ items, mark: pendingMarks.get(t), ...(cut ? { cut } : {}), session: i ? { sid: i.sessionId, ctx: i.contextTokens } : undefined, ...(via.human ? { human: via.human } : {}), now, nameOf: displayName });
      pendingMarks.set(t, o.mark);
      o.touched.forEach(ledger.put);
      const text = renderDigest({ ...o, lines: [...o.lines, ...acceptLines] }, o.full ? renderTable(items, liveOfTurns(), pendingNames, now, awaitingRows(t, now), stalledRows(t), shelvedRows(t, now)) : "", rule);
      return { text, keys: text && rule ? ["rule:pending"] : [] };
    };
    const notices = bindNoticeBox(createNoticeBox({
      probe: (t) => [...handoffNudge(t), ...memoryNudge(t)],
      digest: pendingDigest,
      seen: createSeenRing(loadJsonMap<SeenRow>(cfg.wrc.mirror.noticeSeenFile, gcSeen), (t) => m.sessionInfo(t)?.sessionId ?? ""),
      cwdOf: (t) => ((c) => c.runningCwd || c.defaultCwd)(m.getCwd(t)),
    }));
    // 重试冒泡 (设计文档 §3.3.1): 做完了没人验收的需求, 守护进程以管家的名义往原群提醒一句, 不占管家一轮、
    // 不带单号 (人只认标题); 同时往管家的信箱挂一行带单号的, 人下一句进来时它知道可能在答哪张。
    // 节奏由根单上的 nudge {n, lastAt} 现算 (见 jobs.nextNudgeAt), 只在白天, 人刚说过话的群顺延 —— reload 不丢、不重发。
    const NUDGE_TICK_MS = 5 * 60_000;
    const HUMAN_QUIET_MS = 30 * 60_000;
    const agoZh = (ms: number): string =>
      ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} 分钟前` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)} 小时前` : `${Math.round(ms / 86_400_000)} 天前`;
    const nudgeTick = (now = Date.now()): number => {
      if (dayClamp(now) !== now) return 0;
      const owners = [...new Set(jobs.all().filter((j) => j.kind === "req" && j.status === "open").map((j) => j.owner))];
      // 只冒群默认管家 (无 tag) 自己的根单: lead 自己 dispatch 出来的子需求不该推给人; 与 pendingDigest 只服务默认会话一致。
      // owner 须是已登记的 wizard: 伪造的 owner/群 (调试、回归) 不得往 turn store 落 post, 否则 rolepage 凭空长出一个群和一个「人」。
      const due = owners
        .filter((o) => !tagOfKey(o) && !!wizards.get(o))
        .flatMap((o) => awaitingAccept(jobs.all(), o, jobLive()))
        .filter(({ job, at }) => !!job.origin?.chat && baseOfKey(job.owner) === job.origin.chat && nudgeDue(at, job.nudge, now) && now - (humanAt.get(job.origin.chat) ?? 0) >= HUMAN_QUIET_MS);
      // 按 (群, owner) 分组: 署名与信箱都跟着 owner。
      const byChat = due.reduce((acc, x) => { const k = `${x.job.origin!.chat}\0${x.job.owner}`; return acc.set(k, [...(acc.get(k) ?? []), x]); }, new Map<string, typeof due>());
      byChat.forEach((xs) => {
        const owner = xs[0]!.job.owner;
        const chat = xs[0]!.job.origin!.chat;
        const one = xs.length === 1;
        const mark = (i: number): string => (one ? "" : "①②③④⑤⑥⑦⑧⑨⑩"[i] ?? `${i + 1}.`);
        const text = `有 ${xs.length} 件做完了等你看: ${xs.map(({ job, at }, i) => `${mark(i)}「${job.title}」(${agoZh(now - at)}交付)`).join(" ")} —— 回一句「好」就收, 或者说哪里不对。`;
        notifyChat(chat, `${relayLabel(owner)}\n\n${text}`);
        recordPost({ target: owner, channel: chat, body: text });
        xs.forEach(({ job }) => jobs.mark(job.id, { nudge: { n: (job.nudge?.n ?? 0) + 1, lastAt: now } }));
        notices.post([owner], `nudged the human (daemon, in your name) about finished requests; their next line may be the verdict on one: ${xs.map(({ job }) => `${job.id} "${job.title}"`).join(" · ")}`);
      });
      return due.length;
    };
    setInterval(() => { try { nudgeTick(); } catch (e) { log.warn({ err: (e as Error).message }, "accept nudge failed"); } }, NUDGE_TICK_MS).unref();
    /** `who` = 这次变动的当事人 (见 hears): 不给 = 聊天自己的事 (改名), 全群都听。 */
    const postRoster = (base: string, except: readonly string[], n: Notice, who?: Subject): void =>
      notices.post(chatAudience(m.chatTargets(base), base, except).filter(who ? hears(who) : () => true), n);
    /** 注册表里的当事人。要在 forget 抹掉记录之前取; 没有记录 = 谁也不告诉。 */
    const subjectOf = (w: WizardRecord | undefined): Subject => (w
      ? { parent: w.parent, description: w.description, owners: jobs.all().filter((j) => j.status === "open" && j.members.some((x) => x.target === w.target)).map((j) => j.owner) }
      : {});

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
      if (!Object.keys(plan).length) return {};
      const { r: named } = guardCharter(() => applyChatNames(cfg, sourcePath, plan), (n) => Object.keys(n).length ? { what: `自动补的聊天名 (${Object.values(n).map((x) => `\`${x}\``).join(" ")})` } : undefined);
      for (const [base, name] of Object.entries(named)) {
        log.info({ base, name }, "chat: auto-named from workspace");
        // 群里不发气泡 (一次补名会命中十几个群, 那是刷屏), 但住在里面的 wizard
        // 得知道自己的地址变了 —— 它的 charter 里写的还是「(未命名)」。
        postRoster(base, [], { op: "chat", name });
      }
      return named;
    };

    // 名字全局唯一 (见 wizard.ts): 先给没名字的聊天补名, 再按「默认会话先挑」把
    // 每个已知 wizard 的名字落定 —— 老记录 (名字还跟着聊天走的那一代) 在这里一次迁完。
    ensureChatNames(cfg.defaultChat || "");
    const reborn = backfillBorn(wizards, bornOf);
    if (reborn.length) log.child({ mod: "wizard" }).info({ n: reborn.length }, "bornAt backfilled from transcript heads");
    settleAll(
      wizards,
      [...m.chatRoster("").flatMap((c) => c.targets), ...wizards.all().map((w) => w.target)],
      (t) => chatNameOf(cfg, t),
    );
    // 上一个进程生到一半就没了的身份 (spawn 途中 reload): 没会话的删掉, 腾出名字。
    // 它们的 tmux window 也一并收掉 (没人叫得到它, 只会占着 pane): 等绑定恢复完再看,
    // 免得把还没恢复的活 pane 当成没绑定; 期间名字已被新 spawn 认领的不碰。
    const unborn = sweepUnborn(wizards, (t) => m.chatTargets(baseOfKey(t)).includes(t));
    unborn.forEach((w) => log.child({ mod: "wizard" }).warn({ target: w.target, name: w.name }, "unborn identity swept"));
    if (unborn.length) {
      void m.restored
        .then(() => m.reapUnborn(unborn.map((w) => w.name).filter((n) => n && !wizards.byName(n))))
        .then((killed) => { if (killed.length) log.child({ mod: "wizard" }).info({ killed }, "unborn windows killed"); })
        .catch((e: unknown) => log.warn({ err: (e as Error).message }, "unborn window reap failed"));
    }

    /** 成员角色参数: 只认 exec / reviewer / expert (lead 只由 dispatch 在派成之后记, 免得谁都能自封 lead); 不认识的 = 不给。 */
    const roleParam = (v: unknown): Exclude<MemberRole, "lead"> | undefined =>
      (["exec", "reviewer", "expert"] as const).find((x) => x === v);
    /** 成员此刻的态: 定论 > 在飞的实时态。每次取一份回执快照。 */
    const jobLive = (): MemberLive => {
      const inflight = receipts.states();
      return (j, mm) => mm.outcome ?? inflight.find((x) => x.to === mm.target && x.job === j.id)?.state;
    };

    /** 派活前先验工单: 生完分身才发现工单号打错了, 那个分身就成了没人认领的孤儿。 */
    /** `free` = 这次不花预算 (不带 task 的 spawn; 答一份停在 NEED 上的反问 —— 拒了它就只能干等到超时)。 */
    const checkJob = (id: string, target?: string, free = false): { ok: true } | { ok: false; status: number; reason: string } => {
      const j = jobs.get(id);
      if (!j) return { ok: false, status: 404, reason: `没有工单 '${id}' —— open_job 先开一个, 或者 list_jobs 看还开着哪些` };
      if (j.status !== "open") return { ok: false, status: 409, reason: `工单 '${id}' 已经收工了` };
      // 已在册的成员 (续问 / 再派一句) 不占新名额。
      if (j.members.length >= JOB_MEMBER_MAX && !j.members.some((x) => x.target === target)) return { ok: false, status: 409, reason: `工单 '${id}' 的成员已经满了 (${JOB_MEMBER_MAX} 个直接成员) —— 管辖幅度有限: 把一块子活交给现有成员 (它自己开子单、长一层子 lead), 或者先收工回收掉一批` };
      // 预算是硬的: 与单件活的 legs 不同, 这里拒了也无路可绕 —— 换个人派照样记在这张工单上。
      if (!free && j.maxTurns && (j.turns ?? 0) >= j.maxTurns) return { ok: false, status: 409, reason: `工单 '${id}' 的派活预算用完了 (${j.turns}/${j.maxTurns} 次) —— 拿手上已有的结论 close_job 收口, 缺的如实写; 真要接着干就 open_job 开一张新的` };
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
      // 「卡在审批」以 daemon 手里的 pending 为准 —— 审批长轮询期间 pane 照样在转圈,
      // 拿 busy 去推会把它当成「执行中」。归属走 approval 认卡的同一口径 (getMirrorTarget):
      // hook 的 sid 在 /clear 之后先变, 镜像绑定的 sid 要等新 jsonl 出现才跟上。
      // ask_user 的 pending 不带 sessionId —— 它是 MCP 工具在等, 不归哪张卡, 不亮。
      const waitingOf = listPending().reduce((m, { meta }) => {
        const t = meta.sessionId ? getMirrorTarget(meta.sessionId) : undefined;
        const tool = meta.toolName || meta.kind;
        return t ? m.set(t, [...new Set([...(m.get(t) ?? []), tool])]) : m;
      }, new Map<string, string[]>());
      const live: WorldFactWizard[] = peers.map((p) => {
        const w = byTarget.get(p.target);
        const waiting = waitingOf.get(p.target);
        return {
          target: p.target,
          name: settleName(wizards, chatNameOf(cfg, p.target), p.target),
          description: w?.description ?? "",
          chat: chatNameOf(cfg, p.target) || p.chat,
          cwd: p.cwd,
          model: p.model,
          ...((e) => (e ? { effort: e } : {}))(mirrorStore.get(p.target)?.effort),
          cli: p.cli,
          busy: p.busy,
          alive: p.paneAlive,
          ...(waiting ? { waiting } : {}),
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
        jobs: ((all, live) => all.map((j) => ({
          id: j.id, base: j.base, owner: j.owner, title: j.title, status: j.status,
          openedAt: j.openedAt, closedAt: j.closedAt, summary: j.summary, ...(j.expect ? { expect: j.expect } : {}), ...(j.plan ? { plan: j.plan } : {}),
          ...(j.parent ? { parent: j.parent } : {}), ...(j.kind ? { kind: j.kind } : {}), ...(j.criteria ? { criteria: j.criteria } : {}), ...(j.origin ? { origin: j.origin } : {}), ...(j.end ? { end: j.end } : {}),
          stage: jobStage(j, all, live),
          members: j.members.map((mm) => ({ target: mm.target, task: mm.task, spawned: mm.spawned, ...(mm.outcome ? { outcome: mm.outcome } : {}), ...(mm.artifacts?.length ? { artifacts: mm.artifacts } : {}), ...(mm.role ? { role: mm.role } : {}), ...(mm.forkOf ? { forkOf: mm.forkOf } : {}) })),
        })))(jobs.all(), jobLive()),
        // rolepage 的待办托盘: 与名册 / peek 的「在等 / 欠着」同一份 (receipts.states)。
        inflight: receipts.states().map(({ ageMs, ...x }) => ({ ...x, at: Date.now() - ageMs })),
        schedules: tasks.list().filter((x) => x.enabled).map((x) => {
          const st = tasks.stateOf(x.id);
          const loadError = tasks.errors()[x.id];
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
            fresh: x.fresh,
            hasGate: x.hasGate,
            lastGate: st.lastGate,
            lastGateAt: st.lastGateAt,
            lastError: st.lastError,
            ...(loadError ? { loadError } : {}),
            file: x.file,
          };
        }),
        chatNames: Object.fromEntries(listChatNames(cfg).map((c) => [c.base, c.name])),
      };
    };
    // 一次采集失败 (某个 pane 的 tmux 抖了一下) 不等于注册表没了: 退回上一份好的,
    // 否则这份空占位会被推给 svr, 把整张名册抹成「缺席」直到下一次推送。
    let lastGood: WorldFacts = EMPTY_FACTS;
    setWorldFactsProvider(() => {
      const now = Date.now();
      if (!worldCache || now - worldCache.at > WORLD_TTL_MS) {
        worldCache = {
          at: now,
          facts: collectWorldFacts().then((f) => (lastGood = f), () => lastGood),
        };
      }
      return worldCache.facts;
    });

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

    /** transcript 最后写入的时刻; 没有会话 / 读不到 = 0。 */
    const lastTouched = (t: string): number => {
      const p = m.sessionInfo(t)?.jsonlPath;
      try { return p ? statSync(p).mtimeMs : 0; } catch { return 0; }
    };

    // 每个会话的宪章里写进了哪些 self 记忆。`/clear` 抹掉对话却不重写系统提示, 此后
    // 新记的那些就只活在被抹掉的对话里 —— onContextCut 据这份快照补发差集。纯内存: reload
    // 之后没有快照, 只指路不补发。
    const chartered = new Map<string, readonly string[]>();

    type CharterOpts = { parent?: string; forkOf?: string; inherited?: boolean; cwd?: string };
    const charterOptsOf = (target: string, cwd?: string): CharterOpts => {
      const rec = wizards.get(target);
      return { parent: rec?.parent, forkOf: rec?.forkOf, inherited: !!rec?.clonedFrom, cwd };
    };
    /** 宪章正文, 只读 —— 只由 cfg 与此刻的注册表 / 附着表算出, config_set 据此比对前后。`forDiff` 去掉
     *  宪章里自认是出生快照的配置 (档位那一行, 真相在 config_get): 改档位不该叫全员 handoff。 */
    const charterText = (target: string, o: CharterOpts, forDiff = false): string =>
      renderCharter({
        // o.cwd = 正在启动的那个 pane 的目录; 没给才退回"现在记着的那个"。
        self: { ...briefOf(target, target), address: selfAddress(target), ...(o.cwd ? { cwd: o.cwd } : {}) },
        chat: chatNameOf(cfg, target),
        principal: baseOfKey(target),
        parent: o.parent ? briefOf(target, o.parent) : undefined,
        inherited: !!o.inherited,
        forkOf: o.forkOf ? briefOf(target, o.forkOf) : undefined,
        cwdUnconfirmed: m.cwdUnconfirmed(target, o.cwd),
        // 最近动过的排前面: 名册只点名前几个, 截掉的该是早就停了的那些。
        // 没有 transcript 的冷记录按 bornAt 算, 刚生下还没开口的照样在。
        siblings: m.chatTargets(baseOfKey(target))
          .filter((t) => t !== target)
          .map((t) => [t, Math.max(lastTouched(t), wizards.get(t)?.bornAt ?? 0)] as const)
          .filter(([, at]) => Date.now() - at <= ROSTER_FRESH_MS)
          .sort((x, y) => y[1] - x[1])
          .map(([t]) => briefOf(target, t)),
        memory: wizards.get(target)?.memory ?? [],
        tiers: forDiff ? [] : TIERS.map((n) => { const s = cfg.models.tiers[n]; return `${n}=${s.model || "默认"}${s.effort ? `·${s.effort}` : ""}`; }),
        chatMemory: sharedMemory("chat", baseOfKey(target)),
        workspaceMemory: (() => {
          const cwd = o.cwd || m.getCwd(target).runningCwd || m.getCwd(target).defaultCwd;
          return cwd ? sharedMemory("workspace", cwd) : "";
        })(),
        steward: !tagOfKey(target),
        stewardBudget: chatPolicyOf(cfg, target).stewardBudget,
        lead: !!wizards.get(target)?.lead,
        topOnly: chatPolicyOf(cfg, target).topOnly,
      });
    /** 开局宪章。出生时的兄弟只是快照 —— 名册随时可查, 写进系统提示的那份只为了
     *  让它一睁眼就知道自己不是一个人在跑。 */
    const charterFor = (target: string, o: CharterOpts): string => {
      chartered.set(target, wizards.get(target)?.memory ?? []);
      const text = charterText(target, o);
      recordCharter(target, text, o.parent ? { parent: o.parent, kind: o.inherited ? "clone" : "spawn", ...(o.forkOf ? { forkOf: o.forkOf } : {}) } : undefined);
      return text;
    };

    m.onContextCut((t, cut) => {
      pendingCuts.set(t, cut);
      // 之前挂过的提示随对话一起没了: 去重窗口清零, 下一次该给的规矩照给。
      notices.forget(t);
      const now = wizards.get(t)?.memory ?? [];
      const seen = chartered.get(t);
      // 没有快照 (reload 之后) 就不猜差集, 只指路 —— 整份塞进一行能有几万字。
      if (!seen) {
        if (now.length) notices.post([t], `你有 ${now.length} 条 self 记忆, 宪章里那份可能是旧的: \`wizard_whoami\` 看全的`);
        return;
      }
      const fresh = now.filter((x) => !seen.includes(x));
      const gone = seen.filter((x) => !now.includes(x)).length;
      const shown = fresh.slice(-10).map((x) => `「${clipLine(x, 200)}」`).join(" ");
      if (fresh.length) notices.post([t], `你出生之后记下的 self 记忆 (${cut === "clear" ? "/clear 抹掉了对话" : "上下文压缩把对话换成了摘要"}, 宪章里没有它们)${fresh.length > 10 ? `, 最新 10 条` : ""}: ${shown}`);
      if (gone) notices.post([t], `宪章「我的记忆」里有 ${gone} 条已被你 forget, 别再照它们办`);
    });

    // 所有 spawn 路径 (群里手打 /new、pane 自愈重生、编排出来的分身) 都从这里
    // 取身份, 于是「是谁」不再取决于是哪段代码把它生出来的。
    m.setCharterProvider((target, ctx) => {
      // 这里是最要紧的那道拦截: 宪章把「所在聊天」写进系统提示, 而系统提示是随进程
      // 终身的 —— 一个在聊天还没名字时出生的 wizard, 会一辈子以为自己住在一个
      // 「(未命名)」的地方。所以补名要发生在渲染之前, 不能等它以后自己去查。
      ensureChatNames(target);
      // 信箱里装的是相对上一份宪章的变化; 新宪章一渲染就都过期了 (名册、记忆都已在里面)。
      notices.drain(target);
      notices.forget(target);
      return charterFor(target, charterOptsOf(target, ctx?.cwd));
    });

    // 宪章记录是后来才有的: 已经在跑的 wizard 拿 spawn 落盘的那份 (state/charters/<sid>.md) 补上,
    // 否则要等它下次重生, rolepage 的「宪章」入口才出现。与自动命名同一个延迟: 等附着表恢复完。
    setTimeout(() => {
      const dir = join(expandHome(cfg.daemon.stateDir), "charters");
      wizards.all().forEach((w) => {
        const sid = m.sessionInfo(w.target)?.sessionId;
        const file = sid ? join(dir, `${sid}.md`) : "";
        try { if (file && existsSync(file)) backfillCharter(w.target, readFileSync(file, "utf8"), statSync(file).mtimeMs); } catch { /* 补不上就等它重生 */ }
      });
    }, 15_000).unref();

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
        ...(info?.effort ? { effort: info.effort } : {}),
        contextTokens: info?.contextTokens ?? 0,
        handoffSuggested: !!info && info.contextTokens > handoffAt(lastModel(info.jsonlPath) || info.model),
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
      if (asked || description) postRoster(baseOfKey(self), [self], before && before !== name
        ? { op: "renamed", name: `.${name}`, was: `.${before}`, ...(description ? { job: description } : {}) }
        : { op: "job", name: `.${name}`, job: description }, subjectOf(wizards.get(self)));
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
      const inflight = receipts.states();
      const shown = ranked.slice(0, limit).map((r) => ({
        ...r,
        turns: turnsLine(inflight, r.target),
        duty: dutyLine(jobs.all(), r.target),
        model: r.model || (r.jsonlPath ? lastModel(r.jsonlPath) : ""),
        summary: r.jsonlPath ? lastExchange(r.jsonlPath, 80, warm) : "",
        contextTokens: r.jsonlPath ? lastContextTokens(r.jsonlPath) : 0,
      }));
      json(res, 200, {
        ok: true,
        total: all.length,
        matched: hit.length,
        shown: shown.length,
        text: [
          `名册 · 列出 ${shown.length}/${hit.length} 个 (全机 ${all.length} 个) · 忙 = 正在生成, 闲 = 活着没在跑, 冷 = 没有 pane (发消息会唤醒) · ctx = 当前上下文用量`,
          renderRoster(shown, Date.now(), homedir()),
          ...(hit.length > shown.length
            ? [`还有 ${hit.length - shown.length} 个没列出来 —— 用 query (名字/职责) / cwd (工作区) / chat 收窄, 或者调大 limit`]
            : []),
        ].join("\n"),
      });
    });

    // 管家分派前的候选表: 事实在这里算 (交集、读过的文件、ctx), 权衡留给管家。
    // 只为活着的读 transcript —— 冷的没有 jsonl 可读, 靠职责命中进表。
    /** 候选的原料: 除自己之外每个 wizard 的上下文事实 (文件集 / 最近的话 / ctx / 缓存 TTL)。 */
    const routeRowsOf = async (self: string): Promise<(RouteRow & { target: string })[]> => {
      ensureChatNames(self);
      const warm = keepalivePingSigs(cfg.wrc.mirror.keepalive.ping);
      return (await rosterOf(self))
        .filter((r) => !r.self)
        .map((r) => {
          const live = r.jsonlPath ? r.jsonlPath : "";
          const ttl = live ? cacheTtlSec(live) : 0;
          return {
            ...r,
            contextTokens: live ? lastContextTokens(live) : 0,
            ...(ttl ? { cacheTtlMs: ttl * 1000 } : {}),
            ...(live ? { cacheAt: cacheTouchMs(live) } : {}),
            files: live ? contextFiles(live) : [],
            asks: live ? talkTurns(live, 12, warm).filter((t) => t.role === "user").map((t) => t.text) : [],
            summary: live ? lastExchange(live, 80, warm) : "",
          };
        });
    };
    http.register("POST /wizard/route", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { task?: string; cwd?: string; limit?: number };
      const task = (b.task ?? "").trim();
      if (!task) { json(res, 400, { ok: false, reason: "task is required" }); return; }
      const limit = Math.min(Math.max(Number(b.limit ?? 5) || 5, 1), 20);
      const cands = rankCandidates(task, (b.cwd ?? "").trim() || m.getCwd(self).runningCwd, await routeRowsOf(self)).slice(0, limit);
      json(res, 200, { ok: true, text: renderCandidates(task, cands, Date.now(), cfg.wrc.mirror.keepalive.ttlSec * 1000, homedir()) });
    });

    // 派活收成一步 (见 route.decide): 查候选 → 过成本门控 → 转给已有的或按档白板 spawn →
    // tell_peer 投出去, 回决定与理由。默认决定由守护进程算; 管家不同意就 `to` 点名、
    // `force` 越过冷门控、`spawn:true` 硬要新的 —— 推翻要显式说。
    http.register("POST /dispatch", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { task?: string; name?: string; description?: string; tier?: string; to?: string; force?: boolean; lead?: boolean; spawn?: boolean; public?: boolean; deadline?: number; dryRun?: boolean; criteria?: string };
      const task = (b.task ?? "").toString().trim();
      if (!task) { json(res, 400, { ok: false, reason: "task is required" }); return; }
      const lead = b.lead === true;
      const force = b.force === true;
      const to = (b.to ?? "").toString().trim();
      const now = Date.now();
      const ttlMs = cfg.wrc.mirror.keepalive.ttlSec * 1000;
      // 自动选只在这些里选: 在线的 (没 pane 的 ctx 量不出, 成本门会盲过)、不是哪个群的管家、
      // 不是别人开着的工单里的队员 —— 点名 (`to`) 不受此限。
      const inOthersJob = (t: string): boolean => jobs.openOf(baseOfKey(t)).some((j) => j.owner !== self && j.members.some((mm) => mm.target === t));
      const pool = to || b.spawn || lead ? [] : (await routeRowsOf(self)).filter((r) => r.alive && !!tagOfKey(r.target) && !inOthersJob(r.target));
      const cands = rankCandidates(task, m.getCwd(self).runningCwd, pool).slice(0, 5);
      let d: { kind: "existing"; why: string; row?: RouteRow } | { kind: "spawn"; why: string } = to ? { kind: "existing" as const, why: `你点名了 ${to}` }
        : b.spawn ? { kind: "spawn" as const, why: "你要了新的" }
          : lead ? { kind: "spawn" as const, why: "复杂活: 白板起一个 hard 档的 lead, 由它组队" }
            : decide(task, cands, now, ttlMs, force);
      // 复杂活 (lead:true) 是一件「需求」: 先开需求根单 (账本, 不占 pane), 这一句带它派下去, lead 记成根单成员。
      // 小活不开单。dryRun 不落账, 所以放在它后面开 (见下)。
      const criteria = (b.criteria ?? "").toString().trim();
      let rootId = "";
      const tell = (name: string, text: string, extra = ""): Promise<Reply> => tellPeerAs(self, {
        name, text, public: b.public !== false, force,
        // lead 的活远超默认的 1h: 不给 deadline 就按 12h (回执的上限)。
        ...(b.deadline !== undefined ? { deadline: b.deadline } : lead ? { deadline: 43200 } : {}),
        ...(rootId ? { job: rootId } : {}),
      } as PeerBody, extra);
      const shown = cands.slice(0, 3).map((e) => `.${e.row.address || e.row.name}${e.row.busy ? " 忙" : ""}`);
      if (b.dryRun) {
        json(res, 200, { ok: true, dryRun: true, decision: d.kind, reason: d.why, ...(d.kind === "existing" ? { name: to || (d.kind === "existing" && d.row ? d.row.address || d.row.name : "") } : { tier: (b.tier ?? "").toString().trim() || tierFor(task, lead) }), ...(shown.length ? { candidates: shown } : {}) });
        return;
      }
      if (lead) {
        const head = (b.description ?? "").toString().trim() || task.split("\n")[0]!.trim();
        rootId = jobs.open(baseOfKey(self), self, truncate(head, 60), {
          kind: "req", ...(criteria ? { criteria, gate: { g1: now } } : {}),
          origin: { text: (currentHumanQueryOf(self) || task).trim(), chat: channelOf(self) },
        }).id;
      }
      // 没投成的根单当场收掉: 留着只是一张没人干的空单。
      const settleRoot = (ok: boolean): void => { if (rootId && !ok) jobs.close(rootId, "派活没投成"); };
      const withRoot = (body: Record<string, unknown>): Record<string, unknown> => rootId
        ? { ...body, job: rootId, hint: "需求根单已开, 对人**别提单号**。lead 交付后根单仍开着, 等人验收: 人认可 → close_job(job) 归档并回收 lead; 人说不对 → tell_peer({name, re, job}) 给 lead 返工 (同一张单, 不开新单); 人说不要了 → close_job({job, as:\"cancel\"}); 先放着 → close_job({job, as:\"shelve\"}) (停提醒, 不关单)。" }
        : body;
      if (d.kind === "existing") {
        const name = to || (d.kind === "existing" && d.row ? d.row.address || d.row.name : "");
        const r = resolvePeer(self, name);
        if (!r.ok) { settleRoot(false); json(res, r.status, { ok: false, reason: r.reason, candidates: r.candidates }); return; }
        // 已有 wizard 当 lead: 宪章是出生时定的 (里面没有 lead 一节), 规矩加打法挂在信封后面带过去;
        // 已是 lead 的宪章里已有层级规矩, 只带打法。投成了才记 lead, 它下次重生宪章里就有。
        const t = await tell(name, task, lead ? renderReminder({ wezard: "lead" }, wizards.get(r.target)?.lead ? renderLeadPlaybook() : renderLead()) : "");
        if (lead && t.status === 200) wizards.upsert(r.target, { lead: true });
        if (rootId && t.status === 200) jobs.attach(rootId, { target: r.target, task: "", spawned: false, role: "lead" });
        // 自动选中的被冷门控退回 (decide 用名册的活动时刻, 门控用 transcript 的, 口径差一点): 改走 spawn。
        if (!(t.body.gated === "cold" && !to)) {
          settleRoot(t.status === 200);
          json(res, t.status, withRoot({ ...t.body, decision: "existing", reason: d.why, ...(shown.length ? { candidates: shown } : {}) }));
          return;
        }
        d = { kind: "spawn", why: `${d.why}; 但它被冷门控退回 (${String(t.body.reason)}) —— 改为白板 spawn` };
      }
      const name = (b.name ?? "").toString().trim();
      const description = (b.description ?? "").toString().trim();
      if (!name || !description) {
        settleRoot(false);
        json(res, 400, { ok: false, decision: "spawn", reason: `${d.why} —— 要新生一个, 带上 name (这件事的短名) 与 description (它的职责) 重发`, ...(shown.length ? { candidates: shown } : {}) });
        return;
      }
      const tier = (b.tier ?? "").toString().trim() || tierFor(task, lead);
      const born = await bearAs(self, { inherit: false, name, description, tier, ...(lead ? { lead: true } : {}) } as PeerBody);
      if (born.status !== 200) { settleRoot(false); json(res, born.status, { ...born.body, decision: "spawn", reason: d.why }); return; }
      // 宪章里只有层级规矩, 打法随信封带 (宪章每轮都在上下文里, 打法只这一件活用得上)。
      const t = await tell(String(born.body.name), task, lead ? renderReminder({ wezard: "lead" }, renderLeadPlaybook()) : "");
      settleRoot(t.status === 200);
      // 为这张根单生出来的: 归档 close_job 时要回收它 (tell 记的是 spawned:false, 再 attach 一次补上; lead 角色也在这里记)。
      if (rootId && t.status === 200) jobs.attach(rootId, { target: String(born.body.target), task: "", spawned: true, role: "lead" });
      json(res, t.status, withRoot({
        ...t.body,
        decision: "spawn",
        reason: d.why,
        tier,
        ...(born.body.model ? { model: born.body.model } : {}),
        ...(born.body.effort ? { effort: born.body.effort } : {}),
        ...(shown.length ? { candidates: shown } : {}),
      }));
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
          ...(scope === "workspace" ? { cwd: key } : {}),
          ...(note ? { note } : {}),
          ...(forget ? { forget } : {}),
        });
        if (!queued) { json(res, 500, { ok: false, reason: "提议没写进收件箱" }); return; }
        // 不回全文: 每提一条就把整份 md 吐回上下文, 连交几条就是几倍的 token。
        // forget 是子串, 回它此刻命中几行 —— 0 行就是写错了, 当场能改。
        const lines = readMemory(path).split("\n").filter((l) => l.trim());
        json(res, 200, {
          ok: true, scope, queued, file: path, lines: lines.length,
          ...(forget ? { forgetHits: lines.filter((l) => l.includes(forget)).length } : {}),
          hint: "已提交给记忆整理者, 下一轮整理 (半小时内) 合并进 file; 此后出生的 wizard 才读得到",
        });
        return;
      }
      const cur = wizards.get(self)?.memory ?? [];
      // 忘记按子串匹配: 模型记不住自己当初一字不差写了什么, 但记得大意。
      const next = forget ? cur.filter((x) => !x.includes(forget)) : cur;
      // 先截再比: 注册表存的是截到 NOTE_MAX 的那版, 拿原文比就永远去不了重。
      const n = note.slice(0, NOTE_MAX);
      const want = n ? [...next.filter((x) => x !== n), n] : next;
      // 满额时注册表从最旧的挤掉 —— 挤掉的、截短的都要明说, 不让它以为全记住了。
      const dropped = want.slice(0, Math.max(0, want.length - MEMORY_MAX));
      const { memory } = wizards.upsert(self, { memory: want });
      json(res, 200, {
        ok: true, scope: "self", count: memory.length, added: !!note, forgotten: cur.length - next.length,
        ...(dropped.length ? { dropped, hint: `self 记忆满 ${MEMORY_MAX} 条, 最旧的 ${dropped.length} 条被挤掉了 (见 dropped); 还要的话 forget 掉不重要的再记回来, 或合并成一条` } : {}),
        ...(note.length > NOTE_MAX ? { truncated: `这条超过 ${NOTE_MAX} 字, 只记下了前 ${NOTE_MAX} 字` } : {}),
      });
    });

    // 生分身。默认 fork 调用方此刻的上下文 —— 这是"先把公共材料读进来, 再分出 N
    // 个干活的"之所以省事的原因: 材料只读一遍, 却进了 N 份上下文。
    /** spawn_wizard / clone_wizard 的本体 —— HTTP 路由与 dispatch 共用。 */
    const bearAs = async (self: string, body: PeerBody): Promise<Reply> => {
      const b = body as { name?: string; tag?: string; description?: string; inherit?: boolean; detached?: boolean; from?: string; cwd?: string; chat?: string; cli?: CliBackendName; model?: string; effort?: string; tier?: string; task?: string; job?: string; keepalive?: boolean; lead?: boolean };
      const askedEffort = parseEffort(b.effort);
      if (b.effort !== undefined && !askedEffort) { return { status: 400, body: { ok: false, reason: `effort 只有这几档: ${EFFORTS.join(" / ")}` } }; }
      const pick = pickTier(cfg.models, b.tier, { cli: b.cli, model: b.model, effort: askedEffort }, b.inherit === true);
      if (!pick.ok) { return { status: 400, body: pick }; }
      const effort = pick.effort;
      // 工单先验: 生完分身才发现工单号打错了, 那个分身就成了没人认领的孤儿。
      const jobId = (b.job ?? "").trim();
      if (jobId) {
        const jc = checkJob(jobId, undefined, !(b.task ?? "").toString().trim());
        if (!jc.ok) { return { status: jc.status, body: { ok: false, reason: jc.reason } }; }
      }
      // `inherit` 没有默认值 —— 继承与否是两种完全不同的分身 (一种开局就带着你
      // 读过的一切, 另一种白纸一张), 猜错了要么白烧一份上下文, 要么让它从零重读。
      // 逼调用方每次自己说。
      if (typeof b.inherit !== "boolean") {
        return { status: 400, body: { ok: false, reason: "inherit 必填: true = fork 你此刻的上下文 (它开局就有你读过的材料, 必须留在同一个 cwd); false = 空白分身, 只继承身份" } };
      }
      const inherit = b.inherit;
      // detached = 独立长住 (原 new_claude_session / 人在群里 `/new .x`): 不挂家谱、不占
      // 调用方的分身名额、不随工单回收。它和「fork 我的上下文」「归某张工单」都互斥。
      const detached = b.detached === true;
      if (detached && (inherit || (b.job ?? "").trim())) {
        return { status: 400, body: { ok: false, reason: "detached 只用于白板 (inherit:false) 且不带 job —— 独立长住的 wizard 不归你管, 也不随工单回收" } };
      }
      // 克隆的源头: 默认是调用方自己; `from` 点名就 fork 那个 wizard 此刻的上下文。
      // 分身仍归调用方管 (parent = self: 占它的预算、随它的工单回收), 只有上下文来自别处。
      // 空串不能交给 resolvePeer —— 那是「本聊天的默认 wizard」, 不是「我自己」。
      const fromAddr = (b.from ?? "").toString().trim();
      if (fromAddr && !inherit) {
        return { status: 400, body: { ok: false, reason: "from 只对克隆有意义 —— 白板生出来的 wizard 不带任何人的上下文" } };
      }
      const fromR = fromAddr ? resolvePeer(self, fromAddr) : { ok: true as const, target: self };
      if (!fromR.ok) { return { status: fromR.status, body: { ok: false, reason: fromR.reason, ...(fromR.candidates ? { candidates: fromR.candidates } : {}) } }; }
      const source = fromR.target;
      const sourceInfo = m.sessionInfo(source);
      // 别人的会话 fork 不出来就是失败, 不能像克隆自己那样悄悄退化成白板 —— 调用方
      // 要的恰恰是它的上下文, 给一张白纸等于答非所问。
      if (source !== self && !sourceInfo?.sessionId) {
        return { status: 409, body: { ok: false, reason: `${displayName(source)} 没有可 fork 的会话 (还没说过话, 或绑定已失效)` } };
      }
      const alivePeers = detached ? [] : await m.peers(self);
      // 预算。撞到上限不是"不许再分", 是"先把干完活的收掉": stop_wizard 收单个,
      // close_job 整批回收一个工单的临时分身。只数**本聊天里**活着的 ——
      // 生到别的聊天去的归那边管, 为了数它们再探一遍 tmux 不值当。
      const aliveKids = childrenOf(wizards.all(), self).filter((k) =>
        alivePeers.some((pp) => pp.target === k.target && pp.paneAlive));
      if (!detached && aliveKids.length >= cfg.wrc.mirror.cloneMax) {
        return { status: 429, body: {
          ok: false,
          reason: `你名下已经有 ${aliveKids.length} 个活着的分身 (上限 ${cfg.wrc.mirror.cloneMax}) —— 先 stop_wizard 收掉干完活的那些, 或者 close_job 整批回收一个工单`,
          clones: aliveKids.map((k) => peerAddress(cfg, self, k.target)),
        } };
      }
      const wantChat = (b.chat ?? "").toString().trim();
      const base = wantChat ? chatBaseOf(cfg, wantChat) : baseOfKey(self);
      if (!base) {
        return { status: 404, body: {
          ok: false,
          reason: `unknown chat '${wantChat}' — 只有起过名字的聊天能被指名; 让那边先 /name`,
          candidates: listChatNames(cfg).map((c) => c.name),
        } };
      }
      const askedName = String(b.name ?? b.tag ?? "");
      // 没起名: 独立长住的按目录名 (同 /new 与 new_claude_session), 分身按职责的首词。
      const fallback = (detached && b.cwd ? tagFromCwd(b.cwd) : "") || normalizeTag(b.description?.split(/\s+/)[0]) || "clone";
      const slotR = await claimSlot(base, askedName, fallback, [self, source]);
      if (!slotR.ok) { return { status: slotR.status, body: slotR.body }; }
      const { target, slot: tag } = slotR;
      // claimSlot 会复用同名的冷记录 (detached 正是「叫回一个老名字」的场景): 生不出来时
      // 只回滚这一次的新记录, 不能把那个老 wizard 的记忆和家谱一起删掉。
      const existed = !!wizards.get(target);
      const forkOf = inherit && source !== self ? source : undefined;
      // 先落身份再 spawn: 宪章是从注册表渲染出来的, 记录不在就渲染出一个无名分身。
      wizards.upsert(target, {
        description: (b.description ?? "").toString().trim(),
        // 显式写 undefined: upsert 是合并写, 复用的冷记录里旧的 parent 会留下来。
        parent: detached ? undefined : self,
        bornAt: Date.now(),
        clonedFrom: inherit ? sourceInfo?.sessionId ?? "" : "",
        ...(forkOf ? { forkOf } : {}),
        // fork 了上下文就一并继承 self 记忆: 系统提示不随 fork 走 (分身拿的是自己的宪章),
        // 不拷的话它开局就没有, /clear 或交接重开后更是彻底没了。标上来源; 已经是继承来的不再套一层。
        ...(inherit ? { memory: (wizards.get(source)?.memory ?? []).map((x) => x.startsWith("(继承自 ") ? x : `(继承自 ${displayName(source)}) ${x}`) } : {}),
        tier: pick.tier,
        // 显式写 undefined: 复用的冷记录可能当过 lead。
        lead: b.lead === true ? true : undefined,
        // 生完才清; 这个进程中途没了, 下次开机由 sweepUnborn 认出并收掉。
        spawning: BOOT_ID,
      });
      const name = wizards.rename(target, normalizeTag(askedName) || tag);
      const charter = charterFor(target, { ...(detached ? {} : { parent: self }), forkOf, inherited: inherit });
      const task = (b.task ?? "").toString().trim();
      // 没点名就按配置的 keepalive.spawnDefault 来 —— 调用方明说的永远优先。
      const keepalive = typeof b.keepalive === "boolean" ? b.keepalive : cfg.wrc.mirror.keepalive.spawnDefault;
      // 先盖章再生: 分叉出来的 transcript 里躺着被克隆者的旧回复, 时刻早于这一枚章,
      // wait_peer 才不会把它们当成分身对这件活的答复。
      const taskAt = Date.now();
      const taskTurn = newTurn();
      const asker = task ? askerOf(self) : undefined;
      const r = await m.cloneSession({
        parent: source,
        target,
        windowName: name,
        cli: pick.cli,
        model: pick.model,
        effort,
        cwd: b.cwd,
        systemPrompt: charter,
        inherit,
        // 继承路径上第一句话是分叉的触发器, 所以直接把活当开场白 —— 少一次往返,
        // 也少一次"就位了但没事干"的空转。
        // 子 lead 的宪章只有层级规矩, 打法跟第一句的信封走 (同 dispatch 对已有 wizard 的做法)。
        bootstrap: task ? task + envelopeFor(self, "", { turn: taskTurn }) + (b.lead === true ? renderReminder({ wezard: "lead" }, renderLeadPlaybook()) : "") : undefined,
        ...(task ? { bootstrapFrom: { from: { kind: "peer" as const, from: self, turn: taskTurn, ...(jobId ? { job: jobId } : {}), ...(asker ? { asker } : {}) }, query: task } } : {}),
        keepalive,
      }).catch((e: unknown) => ({ ok: false as const, reason: `spawn threw: ${String(e)}`, inherited: false }));
      // 生不出来就回滚身份 —— 否则名字被一个永远没有会话的记录占住。
      if (!r.ok) {
        if (existed) wizards.upsert(target, { spawning: undefined });
        else wizards.drop(target);
        return { status: 500, body: { ok: false, reason: r.reason } };
      }
      wizards.upsert(target, { spawning: undefined, clonedFrom: r.inherited ? sourceInfo?.sessionId ?? "" : "", ...(r.inherited ? {} : { forkOf: undefined }) });
      const kid = briefOf(self, target);
      // 出生不再发群气泡 (人要看的是结论, 不是谁生了谁 —— 过程在 rolepage 里);
      // 同群的 wizard 仍要知道群里多了一个成员。工单里的临时工连这条也省掉。
      if (!jobId) {
        // 模型 / keepalive 不报: 那是生它的那位的事, 旁人要时 wizard_roster 有。
        postRoster(base, [target, self], {
          op: "born", name: `.${name}`, by: displayName(self), clone: !detached,
          ...(r.inherited ? { ctx: forkOf ? displayName(forkOf) : displayName(self) } : {}),
          ...(kid.description ? { job: kid.description } : {}), cwd: r.cwd,
        }, subjectOf(wizards.get(target)));
      }
      // 继承路径上活已经随开场白进去了, 空白分身才需要在这里补一次注入 (私聊)。
      let dispatched = r.inherited && !!task;
      if (task && !r.inherited) {
        const inj = await m.injectText(target, task, undefined, { from: { kind: "peer", from: self, turn: taskTurn, ...(jobId ? { job: jobId } : {}), ...(asker ? { asker } : {}) }, channel: "", envelope: envelopeFor(self, "", { turn: taskTurn }) });
        dispatched = inj.ok;
      }
      if (jobId) {
        const role = roleParam((body as { role?: string }).role);
        const from = inherit ? source : undefined;
        jobs.attach(jobId, { target, task, spawned: true, ...(role ? { role } : {}), ...(from ? { forkOf: from } : {}) });
      }
      if (jobId && dispatched) jobs.spend(jobId);
      // 分身的第一件活也守回执: fan-out 最常见的形状就是 clone_wizard({task}) × N,
      // 让它们干完自己把结论送回来, 发起方不必挂在 wait_peer 上。
      const k = (body as { chain?: boolean }).chain === false ? undefined : parentKOf(self);
      if (dispatched) receipts.register({ from: self, to: target, channel: "", job: jobId, at: taskAt, turn: taskTurn, ...(k ? { k } : {}), ...(asker ? { asker } : {}) });
      if (dispatched) ledger.open({ turn: taskTurn, owner: self, to: target, text: task, at: taskAt, ...(jobId ? { job: jobId } : {}), ...(k ? { for: k } : {}), ...(asker ? { asker } : {}) });
      return { status: 200, body: { ok: true, target, name, address: name, inherited: r.inherited, sessionId: r.sessionId, cwd: r.cwd, dispatched, ...(dispatched ? { turn: taskTurn } : {}), keepalive, ...(r.model ? { model: r.model } : {}), ...(r.modelWarning ? { modelWarning: r.modelWarning } : {}), ...(r.effort ? { effort: r.effort } : {}), ...(pick.tier ? { tier: pick.tier } : {}), via: pick.via, ...(pick.note ? { tierNote: pick.note } : {}), ...(jobId ? { job: jobId } : {}), ...(detached ? { detached: true } : {}) } };
    };
    http.register("POST /wizard/clone", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const r = await bearAs(self, body);
      json(res, r.status, r.body);
    });

    // 收掉一个 wizard。interrupt = 打断它这一轮 (Esc); end = 结束它并回收 pane。
    // 自己终结自己是合法的 (分身干完活自我了结), 代价是这次工具调用不会返回 ——
    // 回执只在 rolepage (生命周期事件不进群); 同群的 wizard 从名册增量里得知。
    /** 抹掉一个 wizard 的身份; 它在开着的工单里没落定的那一份记成 canceled —— 名字都没了, 不会再落定。 */
    const forgetWizard = (target: string): string[] => {
      wizards.drop(target);
      return jobs.detach(target);
    };

    http.register("POST /wizard/stop", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { name?: string; tag?: string; mode?: string; forget?: boolean; turn?: string; force?: boolean };
      const r = resolvePeer(self, addrOf(b));
      // 有身份没会话 (冷记录 / 生到一半的僵尸): resolvePeer 够不着它, 但收它不需要
      // 会话 —— end 视为早已结束, forget 删掉记录、腾出名字。interrupt 无从谈起。
      const found = r.ok || r.candidates?.length ? undefined : wizards.byName(addrOf(b));
      const cold = found && !m.chatTargets(baseOfKey(found.target)).includes(found.target) ? found : undefined;
      if (cold && (b.mode ?? "end") === "end") {
        const detached = b.forget ? forgetWizard(cold.target) : [];
        json(res, 200, { ok: true, target: cold.target, name: cold.name, mode: "end", forgotten: !!b.forget, note: "它本来就没有会话在跑", ...(detached.length ? { canceledIn: detached } : {}) });
        return;
      }
      if (!r.ok) { json(res, r.status, { ok: false, reason: r.reason, candidates: r.candidates }); return; }
      const { target } = r;
      const victim = briefOf(self, target);
      // 当事人要在 forget 抹掉记录之前取 (见 subjectOf)。
      const victimRec = wizards.get(target);
      const end = (b.mode ?? "end") === "end";
      if (!end && target === self) { json(res, 400, { ok: false, reason: "打断自己没有意义 —— 你就是正在生成的那一个" }); return; }
      // 按件号撤回自己派的那一件: 它此刻正在做的就是这件才按 Esc; 否则 (排着 / 在做别人的)
      // 只把这件记成 canceled —— 它之后答出来也不再回执, 手上别人的那一轮不受影响。
      const turn = (b.turn ?? "").replace(/[`\s]/g, "");
      if (!end && turn) {
        const mine = receipts.pending(self, target);
        if (mine?.turn !== turn) { json(res, 404, { ok: false, reason: `你没有在等 ${victim.name ? `.${victim.name}` : target} 答 '${turn}' 这件 (已落定、件号写错, 或不是你派的)` }); return; }
        // 先落 canceled 再按 Esc: 被打断那一轮的半截话不该被 watcher 当成答案投回来。
        const busy = !(await m.idleNow(target));
        const canceled = receipts.cancel(target, self, (x) => x.from === self && x.turn === turn);
        // 按 Esc 之前再认一次手上这一轮: 上面那次 await 期间它可能已经做完这件、接了别人的下一件。
        const current = busy && openingAsk(target)?.turn === turn;
        // 还没轮到 / 排在后面: 捎一句给它, 轮到那句话时别再做了 (notices 挂在下一条注入的尾巴上)。
        if (!current) notices.post([target], `${displayName(self)} 撤回了它派给你的 ${turn} —— 那件活不用做了; 读到它时直接略过, 不必回复。`);
        // 只按 Esc, 不 teardown: teardown 会清掉它的注入队列, 别人排着的话一起丢。
        const esc = current ? await m.interruptPane(target) : undefined;
        // Esc 没按成也不回滚撤回: 这件已经不等了, 只是它手上那一轮还在跑 —— 如实说。
        json(res, 200, {
          ok: true, target, name: victim.name, mode: "interrupt", turn, canceled, interrupted: !!esc?.ok,
          ...(esc && !esc.ok ? { note: `这件已撤回 (不会再回执给你), 但 Esc 没按成 (${esc.reason ?? "unknown"}), 它这一轮可能还在跑` } : {}),
          ...(current ? {} : { note: "它此刻没在做这件 (还排着, 或在做别人的活), 没按 Esc —— 这件已撤回, 它之后答出来也不会再回执给你" }),
        });
        return;
      }
      // 不带件号的打断会停掉它手上整轮: 那一轮若是别的 wizard 派的, 先拒 —— 误伤的是别人的活。
      const others = !end && !b.force ? await othersTurn(target, self) : undefined;
      if (others) {
        json(res, 409, { ok: false, target, reason: `它此刻在做 ${others.from} 派的活${others.turn ? ` (${others.turn})` : ""}, 打断会连那件一起停掉 —— 只想撤回你自己派的那件, 传 turn (件号); 确要打断它这一轮, 加 force:true` });
        return;
      }
      // 先落 canceled 再动 pane: pane 一死, 守着的 watcher 会把同一份报成 dead。
      // 打断只停它手上这一轮: 只掐这一轮开头那句派来的活 (人 / 定时 / 回执轮不掐任何一份)。
      const canceled = receipts.cancel(target, self, end ? undefined : currentAsk(target));
      const done = end ? await m.killPane(target) : await m.interruptPane(target, { teardown: true });
      if (!done.ok) { json(res, 502, { ok: false, target, reason: done.reason }); return; }
      const detached = end && b.forget ? forgetWizard(target) : [];
      // 打断只是停了它这一轮, 它还在; 只有结束才是名册变了。
      if (end) postRoster(baseOfKey(target), [target, self], { op: "ended", name: victim.name ? `.${victim.name}` : target, by: displayName(self), ...(b.forget ? { why: "forgotten" } : {}) }, subjectOf(victimRec));
      json(res, 200, { ok: true, target, name: victim.name, mode: end ? "end" : "interrupt", forgotten: !!(end && b.forget), ...(canceled ? { canceled } : {}), ...(detached.length ? { canceledIn: detached } : {}) });
    });

    // 换模型 / effort: 省略名字 = 换自己 (选择器盖在正在跑的这一轮上面照样能开), 点名 =
    // 换那个 wizard。与 spawn 时的 `model` 是同一条路 (model-select.ts); effort 走
    // `/effort` 档位条的「只本会话」键, 不碰全机默认。两样都给就先模型后档位。
    http.register("POST /wizard/model", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { model?: string; scope?: string; effort?: string };
      const model = (b.model ?? "").toString().trim();
      const effort = parseEffort(b.effort);
      if (b.effort !== undefined && !effort) { json(res, 400, { ok: false, reason: `effort 只有这几档: ${EFFORTS.join(" / ")}` }); return; }
      if (!model && !effort) { json(res, 400, { ok: false, reason: "model / effort 至少给一个 —— model 口语化写就行 ('opus' / 'haiku' / 'sonnet 5')" }); return; }
      const scope = (b.scope ?? "session").toString().trim();
      if (scope !== "session" && scope !== "default") { json(res, 400, { ok: false, reason: "scope 只有两档: 'session' (只换这一个会话) / 'default' (同时设为新会话的默认模型)" }); return; }
      // 空串不能交给 resolvePeer —— 那是「本聊天的默认 wizard」, 不是「我自己」。
      const addr = addrOf(body).trim();
      const r = addr ? resolvePeer(self, addr) : { ok: true as const, target: self };
      if (!r.ok) { json(res, r.status, { ok: false, reason: r.reason, candidates: r.candidates }); return; }
      const done = model ? await m.setModel(r.target, model, scope) : undefined;
      const eff = effort && (done?.ok ?? true) ? await m.setEffort(r.target, effort) : undefined;
      const ok = (done?.ok ?? true) && (eff?.ok ?? true);
      json(res, ok ? 200 : 502, {
        ...done,
        ok,
        target: r.target,
        name: briefOf(self, r.target).name,
        ...(done?.ok ? { model: done.applied } : {}),
        ...(eff?.ok ? { effort: eff.applied } : {}),
        ...(eff && !eff.ok ? { reason: [done?.reason, `effort: ${eff.reason}`].filter(Boolean).join("; ") } : {}),
      });
    });

    // 自我交接: 上下文撑不住了, 自己把工作压成简报, /new 换一个全新进程, 再把简报贴
    // 回去。和 /handoff 的区别是**简报由调用方自己写在入参里** —— 它没法在自己
    // 生成的当口再被问一次 (那正是 /handoff 拒绝对自身操作的原因)。所以这里先应答,
    // 等它这一轮说完、pane 空下来再动手。
    http.register("POST /wizard/handoff-self", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const r = handoffSelf(self, ((body as { brief?: string }).brief ?? "").toString().trim());
      json(res, r.status, r.body);
    });

    // ── Job: 一次 fan-out 的工单 ─────────────────────────────────────────
    // 账本, 不是编排器: 控制流留在发起的那个 wizard 手里 (它自己 spawn / wait /
    // 汇总), 这里只记谁属于这个活、谁是为它临时生的、群里该出哪两条气泡。
    // 见 jobs.ts 开头那段取舍。
    http.register("POST /jobs/open", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { title?: string; plan?: string; expect?: number; maxTurns?: number; accept?: string; parent?: string; criteria?: string };
      const title = (b.title ?? "").toString().trim();
      const expect = Math.min(JOB_MEMBER_MAX, Math.max(0, Math.floor(Number(b.expect) || 0)));
      if (!title) { json(res, 400, { ok: false, reason: "title required —— 一句话说清这个工单要干成什么" }); return; }
      const base = baseOfKey(self);
      const maxTurns = Math.min(200, Math.max(0, Math.floor(Number(b.maxTurns) || 0)));
      const plan = (b.plan ?? "").toString().trim();
      const criteria = (b.criteria ?? "").toString().trim();
      // 上级工单: 显式传的要求自己是它的成员或开单者; 不传 = 自己作为未落定成员所在的、最近开的那张
      // (lead 在需求根单里领了活, 开的第一张子单自然挂在根单下, 不用自己记号)。
      const all = jobs.all();
      const mineIn = (j: JobRecord): boolean => j.owner === self || j.members.some((x) => x.target === self);
      const askedParent = (b.parent ?? "").toString().trim();
      // 推断: 同一个群里、我作为未落定成员的开着的单, 取我**最近一次领活** (mm.at) 的那张; 它已在最深一层就不挂了 (退成根单, 不 409)。
      const inferred = all
        .filter((j) => j.base === base && j.status === "open")
        .flatMap((j) => j.members.filter((x) => x.target === self && !x.outcome).map((x) => ({ j, at: x.at })))
        .sort((x, y) => y.at - x.at)[0]?.j;
      const parentJob = askedParent ? jobs.get(askedParent) : inferred && depthOf(jobs.get, inferred) < JOB_DEPTH_MAX ? inferred : undefined;
      if (askedParent && !parentJob) { json(res, 404, { ok: false, reason: `没有上级工单 '${askedParent}'` }); return; }
      if (askedParent && parentJob && (parentJob.status !== "open" || !mineIn(parentJob))) { json(res, 409, { ok: false, reason: `上级工单 '${askedParent}' 已收工, 或你既不是它的成员也不是它的开单者` }); return; }
      if (parentJob && depthOf(jobs.get, parentJob) + 1 > JOB_DEPTH_MAX) {
        json(res, 409, { ok: false, reason: `工单树最深 ${JOB_DEPTH_MAX} 层, 你这张 (挂在 ${parentJob.id} 下) 会是第 ${depthOf(jobs.get, parentJob) + 1} 层 —— 子活交给现有成员, 别再往下长` });
        return;
      }
      // 不出群气泡: 工单是私下的过程, 人看到的只有发起者那一轮的最终回复。
      const accept = ACCEPTS.find((x) => x === b.accept) as Accept | undefined;
      const job = jobs.open(base, self, title, { ...(plan ? { plan } : {}), ...(accept ? { accept } : {}), ...(expect ? { expect } : {}), ...(maxTurns ? { maxTurns } : {}), ...(parentJob ? { parent: parentJob.id } : {}), ...(criteria ? { criteria } : {}) });
      json(res, 200, {
        ok: true,
        job: job.id,
        title,
        ...(parentJob ? { parent: parentJob.id } : {}),
        memberMax: JOB_MEMBER_MAX,
        hint: "把这个 id 传给 spawn_wizard / clone_wizard / tell_peer 的 `job` 参数, 它们就归到这个工单名下 (一律私聊, 不进群); 活干完调 close_job 留档并回收临时分身, 给人的结论写在你自己这一轮的最终回复里。",
      });
    });

    http.register("POST /jobs/close", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { job?: string; summary?: string; stop?: boolean; as?: string };
      const id = (b.job ?? "").toString().trim();
      const job = jobs.get(id);
      if (!job) { json(res, 404, { ok: false, reason: `没有工单 '${id}'` }); return; }
      if (job.status !== "open") { json(res, 409, { ok: false, reason: `工单 '${id}' 已经收工了`, closedAt: job.closedAt }); return; }
      // 只有这张单或它某个祖先单的 owner 能关 (成员、同群的旁人不行)。
      if (![job, ...jobAncestors(jobs.get, job)].some((j) => j.owner === self)) { json(res, 403, { ok: false, reason: `工单 '${id}' 不是你开的, 也不是你开的某张上级单的后代 —— 只有开单者 (或上级单的开单者) 能收工` }); return; }
      // 四种收法 (只 accept / cancel 真关单): shelve / resume 只动需求根单的搁置标记, 单照旧开着。
      const how = ["accept", "cancel", "shelve", "resume"].find((x) => x === (b.as ?? "accept"));
      if (!how) { json(res, 400, { ok: false, reason: `as 只认 accept / cancel / shelve / resume, 收到 '${b.as}'` }); return; }
      if ((how === "shelve" || how === "resume") && job.kind !== "req") { json(res, 400, { ok: false, reason: `只有需求根单能搁置 / 恢复, '${id}' 不是 (它不是 dispatch({lead:true}) 开的根单)` }); return; }
      if (how === "shelve" || how === "resume") {
        // 恢复不是「又交付了」: 保留 n, lastAt 记成此刻, 下一次冒泡从现在起算, 不一恢复就立刻冒。
        jobs.mark(id, how === "shelve" ? { hold: Date.now() } : { hold: undefined, nudge: { n: job.nudge?.n ?? 0, lastAt: Date.now() } });
        json(res, 200, { ok: true, job: id, [how === "shelve" ? "shelved" : "resumed"]: true });
        return;
      }
      // 关一张单连它还开着的后代单一起关 (深的先关): 否则子 lead 的分身留在原地、账本上挂着没人收的单。
      // 回收只针对**为这个工单生出来的**分身: 被拉来帮忙的长期 wizard 不该因为一次活结束就被杀掉。
      // 调用方自己也不收 —— 那会在这次工具调用里把自己干掉。
      const recycle = b.stop !== false;
      const openKids = (j: JobRecord): JobRecord[] => jobChildren(jobs.all(), j.id).filter((c) => c.status === "open").flatMap((c) => [...openKids(c), c]);
      const cascade = openKids(job);
      const closeOne = async (j: JobRecord, summary: string, mark?: JobMark): Promise<{ members: number; killed: number; kept: number }> => {
        const victims = recycle ? j.members.filter((mm) => mm.spawned && mm.target !== self) : [];
        // 收掉之前把它们手上没落定的活记成 canceled: 不然发起者收工之后还会收到一串 dead 回执。
        victims.forEach((mm) => receipts.cancel(mm.target, j.owner));
        // 留档要的 sessionId 得在回收之前取: killPane 连绑定一起删。
        const sids = new Map([j.owner, ...j.members.map((mm) => mm.target)].map((t) => [t, m.sessionInfo(t)?.sessionId ?? ""]));
        const killed = await victims.reduce(
          async (acc, mm) => (await acc) + ((await m.killPane(mm.target)).ok ? 1 : 0),
          Promise.resolve(0),
        );
        // 取消: 还没落定、又不是为这张单生的成员 (长住 wizard) 不杀, 但它们名下这张单派的活记成 canceled, 发起者不会再收到一串回执。
        if (how === "cancel") j.members.filter((mm) => !mm.outcome && !victims.includes(mm)).forEach((mm) => receipts.cancel(mm.target, j.owner, (x) => x.from === j.owner));
        const closed = jobs.close(j.id, summary, mark)!;
        ledger.closeJob(j.id);
        // 收工结论留档到开单者名下 (与交接简报同一份 jsonl); 空工单 (没人、没结论) 不记。
        if (closed.members.length || closed.summary?.trim()) {
          const ep = jobEpisode(closed, { nameOf: episodeName, sidOf: (t) => sids.get(t) ?? "", chat: chatNameOf(cfg, j.base) || j.base });
          if (!appendEpisode(episodePath(cfg.daemon.stateDir, ep.name), ep)) log.warn({ job: j.id, name: ep.name }, "job episode not archived");
        }
        return { members: closed.members.length, killed, kept: victims.length - killed };
      };
      const rs = await [...cascade.map((c) => [c, `随上级单 ${id} 收工`] as const), [job, how === "cancel" ? `取消: ${(b.summary ?? "").toString()}` : (b.summary ?? "").toString()] as const]
        // 根单收工: accept = G3 验收过闸 (人认可), cancel = 取消; 非根单没有闸。
        .reduce(async (acc, [j, sum]) => [...(await acc), await closeOne(j, sum, j !== job ? undefined : how === "cancel" ? { end: "cancel" } : job.kind === "req" ? { gate: { g3: Date.now() }, end: "accept" } : undefined)], Promise.resolve([] as Array<{ members: number; killed: number; kept: number }>));
      const sum = (f: (r: { members: number; killed: number; kept: number }) => number): number => rs.reduce((n, r) => n + f(r), 0);
      json(res, 200, { ok: true, job: id, members: rs[rs.length - 1]!.members, recycled: sum((r) => r.killed), kept: sum((r) => r.kept), ...(cascade.length ? { cascaded: cascade.map((c) => c.id) } : {}) });
    });

    // 挂起事项全表 (见 pending-items.ts): 你派出去、还没了结的事。`drop` 显式消项;
    // `name` 看别人的 (只读)。读过全表就算刚给过一次: 自动的全表提醒从此刻重新计。
    http.register("POST /pending", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { name?: string; drop?: unknown; why?: string };
      const who = (b.name ?? "").toString().trim();
      const r = who ? resolvePeer(self, who) : undefined;
      if (r && !r.ok) { json(res, r.status, { ok: false, reason: r.reason, candidates: r.candidates }); return; }
      const owner = r?.ok ? r.target : self;
      const drop = Array.isArray(b.drop) ? b.drop.map(String) : typeof b.drop === "string" ? [b.drop] : [];
      if (drop.length && owner !== self) { json(res, 403, { ok: false, reason: "只能消自己派出去的" }); return; }
      const dropped = drop.length ? ledger.drop(self, drop, (b.why ?? "").toString().trim()) : [];
      const now = Date.now();
      const items = ledger.openOf(owner);
      if (owner === self) {
        const i = m.sessionInfo(self);
        if (i) pendingMarks.set(self, { sid: i.sessionId, ctx: i.contextTokens, ctxAtFull: i.contextTokens, drains: 0 });
      }
      const missed = drop.filter((t) => !dropped.some((x) => x.turn === t.replace(/[`\s]/g, "")));
      json(res, 200, {
        ok: true,
        text: [
          ...(dropped.length ? [`已消掉: ${dropped.map((x) => `\`${x.turn}\``).join(" ")}`] : []),
          ...(missed.length ? [`没找到 (不是你开着的): ${missed.join(" ")}`] : []),
          renderTable(items, liveOfTurns(), pendingNames, now, awaitingRows(owner, now), stalledRows(owner), shelvedRows(owner, now)),
        ].join("\n"),
      });
    });

    http.register("POST /jobs/list", async (req, res) => {
      const { self } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const inflight = receipts.states();
      const live = jobLive();
      const everything = jobs.all();
      // 本群还开着的, 外加它们名下已收工的子单 (账本留着, 面包屑 / 树才不断)。
      const shown = everything.filter((j) => j.base === baseOfKey(self) && (j.status === "open" || jobAncestors(jobs.get, j).some((a) => a.status === "open")));
      json(res, 200, {
        ok: true,
        jobs: treeOrder(shown).map(([j, depth]) => ({
          job: j.id,
          title: j.title,
          depth,
          ...(j.parent ? { parent: j.parent } : {}),
          ...(j.kind ? { kind: j.kind } : {}),
          stage: jobStage(j, everything, live),
          ...(j.criteria ? { criteria: j.criteria } : {}),
          status: j.status,
          owner: displayName(j.owner),
          mine: j.owner === self,
          openedAt: j.openedAt,
          ...jobs.tally(j.id),
          ...(j.maxTurns ? { budget: `${j.turns ?? 0}/${j.maxTurns}` } : {}),
          members: j.members.map((mm) => ({
            address: peerAddress(cfg, self, mm.target),
            role: mm.role ?? "exec",
            task: mm.task.split("\n")[0] ?? "",
            spawned: mm.spawned,
            state: mm.outcome ?? inflight.find((x) => x.to === mm.target && x.job === j.id)?.state ?? "unknown",
            ...(mm.forkOf ? { forkOf: peerAddress(cfg, self, mm.forkOf) } : {}),
            ...(mm.artifacts?.length ? { artifacts: mm.artifacts } : {}),
          })),
        })),
      });
    });

    // ── 定时任务 ────────────────────────────────────────────────────
    // 到点把一句 prompt 注入一个 wizard 会话 —— 和人在群里对它说话走的是同一条路
    // (injectText), 所以 pane 死了会被拉起来, 输出照常落进群和详情页。
    /** 日程归谁: 排班那个 wizard (createdBy); 老文件没写就归执行它的那个。 */
    const ownerOf = (t: { owner: string }): string => t.owner || (cfg.defaultChat ?? "");

    http.register("POST /tasks/schedule", guarded(async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { when?: string; prompt?: string; note?: string; fresh?: boolean; quiet?: boolean; id?: string };
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
      const created = tasks.create({ id, trigger, prompt, target, fresh, quiet: b.quiet === true, note, createdBy: self });
      if ("error" in created) { json(res, 400, { ok: false, reason: created.error }); return; }
      tasks.patchState(id, { createdAt: Date.now() });
      json(res, 200, {
        ok: true,
        ...renderTask(created, tasks.stateOf(id)),
        address: peerAddress(cfg, self, target),
        owner: peerAddress(cfg, self, self),
      });
    }));

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

    // 确认卡在请求里最多等 4 分钟 (留出 fetch 5 分钟收头的余量), 卡本身半小时有效。
    const CONFIRM_INLINE_MS = 240_000;
    const CONFIRM_TIMEOUT_MS = 30 * 60_000;
    // computeUsage 要扫一周的 transcript, 一分钟内的连问共用一份。
    let usageMemo: { at: number; u: TierUsage } | undefined;
    const tierUsage = (): TierUsage => {
      if (usageMemo && Date.now() - usageMemo.at < 60_000) return usageMemo.u;
      const r = computeUsage();
      const fold = (m: Map<string, ModelTotals>): Map<string, UsageTotals> =>
        new Map([...m].map(([id, x]) => [id, { tokens: sumTotal(x), cost: costOf(id, x) }]));
      usageMemo = { at: Date.now(), u: { today: fold(r.today), week: fold(r.week) } };
      return usageMemo.u;
    };
    /** chatPolicy 的依据: 各聊天名 ↔ principal 与它此刻的顶层模式 —— 键落盘是 principal, 人和模型认的是名字。 */
    const chatPolicyEvidence = (p: string[]): string[] => {
      if (p[0] !== "chatPolicy") return [];
      const named = listChatNames(cfg);
      const line = (b: string): string => `${named.filter((c) => c.base === b).map((c) => c.name).join(" / ") || "(未命名)"} = ${b} · 顶层模式 ${chatPolicyOf(cfg, b).topOnly ? "开" : "关"}`;
      // 查某一个聊天: 只报它; 查整张表: 报写过策略的, 其余命名聊天只报个数。
      if (p[1]) return [line(p[1])];
      const set = Object.keys(cfg.chatPolicy);
      const rest = named.filter((c) => !set.includes(c.base)).length;
      return [
        "键写聊天名或 principal 都行, 落盘换成 principal:",
        ...set.map(line),
        ...(rest ? [`其余 ${rest} 个已命名聊天没写, 按默认 (顶层模式关) —— 查某个: config_get({path:"chatPolicy.<聊天名>"})`] : []),
      ];
    };
    const configEvidence = (p: string[]): string[] => [
      ...tierEvidence(cfg.models, p, tierUsage, (tier) => wizards.all().filter((w) => w.tier === tier).length, { tokens: fmtTokens, cost: fmtCost }),
      ...chatPolicyEvidence(p),
    ];

    // ── 改配置会不会动到宪章 ─────────────────────────────────────────
    // 宪章是 --append-system-prompt 压进去的, 随进程终身: 改了进宪章的配置, 已在跑的 wizard
    // 看不见, 要 handoff 重开 (重新渲染宪章) 才换上。不按字段清单判 —— 宪章读哪些配置随代码变,
    // 清单迟早漏; 改前改后各渲染一遍有会话的 wizard 的宪章, 变了的就是受影响的。
    const charterSections = (text: string): Map<string, string> =>
      new Map(text.split(/^(?=## )/m).map((sec) => [sec.split("\n", 1)[0]!.replace(/^## /, ""), sec] as const));
    const changedSections = (a: string, b: string): string[] => {
      const x = charterSections(a), y = charterSections(b);
      return [...new Set([...x.keys(), ...y.keys()])].filter((k) => x.get(k) !== y.get(k));
    };
    /** 宪章挂在 pane 上的 wizard —— 候选。同步取: 守卫要在写之前拍快照, 中间不能 await。 */
    const attachedWizards = (): string[] => wizards.all().map((w) => w.target).filter((t) => !!m.sessionInfo(t)?.tmuxPane);
    /** 其中 pane 活着的 —— 宪章在效的只有它们; 冷的醒来时宪章重渲染, 自然是新的。一次 list-panes 答完。 */
    const liveOf = async (targets: readonly string[]): Promise<string[]> => {
      const snap = await runTmux(["list-panes", "-a", "-F", "#{pane_id}"]);
      const live = new Set(snap.ok ? snap.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : []);
      return targets.filter((t) => live.has(m.sessionInfo(t)?.tmuxPane ?? ""));
    };
    /** 这些 wizard 此刻的宪章正文。 */
    const charterSnapshot = (targets: readonly string[]): Map<string, string> =>
      new Map(targets.map((t) => [t, charterText(t, charterOptsOf(t, m.getCwd(t).runningCwd || undefined), true)] as const));
    /** 把 `next` 那一节换进活的 cfg 渲染一遍再换回 —— 同步完成, 中间没有 await, 别的模块看不见这一瞬。
     *  reload 项落盘后活值不变, 只有这样才算得出它 reload 之后的宪章。 */
    const charterUnder = (pl: Plan) => (targets: readonly string[]): Map<string, string> => {
      const live = cfg as unknown as Record<string, unknown>;
      const key = pl.path[0]!;
      const saved = live[key];
      live[key] = patchedTop(cfg, pl);
      try { return charterSnapshot(targets); } finally { live[key] = saved; }
    };
    type CharterHit = { target: string; sections: string[] };
    const charterImpact = (before: Map<string, string>, after: Map<string, string>): CharterHit[] =>
      [...before].flatMap(([t, a]) => { const secs = changedSections(a, after.get(t) ?? a); return secs.length ? [{ target: t, sections: secs }] : []; });
    /** 受影响的 wizard 各挂一条提醒 (随它下一条消息到); 给调用方的那段话。调用方自己受影响就直说要它 handoff。
     *  人发起的改动多一句「交接之前还是旧规矩」: 管家要知道它此刻向人汇报的方式还没变, 别让人以为已经生效。 */
    const announceCharterImpact = (c: CharterChange, hits: CharterHit[]): string => {
      if (!hits.length) return "";
      const ask = `${c.reload ? "等守护进程 reload 之后再" : ""}调 \`handoff({brief})\` 原地重开 (手上这件告一段落就交; 宪章在 handoff 时重新生成)`;
      const lag = (t: string): string => !c.byHuman ? "" : tagOfKey(t)
        ? " —— 这是人发起的改动: 交接之前你仍按旧规矩做事, handoff 之后才按新的"
        : " —— 这是人发起的改动: 交接之前你仍按旧规矩向人汇报, handoff 之后才会按新规矩汇报; 回人时说一句「交接后生效」";
      const others = hits.filter((h) => h.target !== c.self);
      others.forEach((h) => notices.post([h.target], `${c.what} 改动了你的宪章 (系统提示, 变了的段: ${h.sections.join(" / ")}); 已在跑的你看不见新规矩 —— ${ask}${lag(h.target)}`));
      const mine = hits.find((h) => h.target === c.self);
      return [
        "",
        `⚠ 这次改动进了宪章 (系统提示): 已在跑的 wizard 看不见, 要 handoff 才换上。受影响 ${hits.length} 个: ${hits.map((h) => displayName(h.target)).join(" ")}`,
        ...(others.length ? [`已给其余 ${others.length} 个各挂一条提醒 (随它们下一条消息到), 让它们${ask}`] : []),
        ...(mine ? [`**你自己也在其中** (变了的段: ${mine.sections.join(" / ")}): 这一轮收尾后${ask}${lag(mine.target)}`] : []),
      ].join("\n");
    };
    // 所有会动宪章的写入 (config_set、人 `/name`、name_chat、自动补名) 共用这一个守卫: 写前写后各渲染一遍
    // 挂在 pane 上的 wizard 的宪章, 变了的、pane 还活着的挂提醒。快照到写完之间不能有 await —— 别人的写入
    // 插进来, 前后就对不上了。已经写了: 比对失败只少一句提醒, 不能让调用方以为没写而重发。
    guardCharter = (write, change) => {
      const targets = attachedWizards();
      const before = charterSnapshot(targets);
      const r = write();
      const c = change(r);
      if (!c) return { r, note: Promise.resolve("") };
      const fail = (e: unknown): string => {
        log.warn({ err: errText(e), what: c.what }, "宪章影响比对失败");
        return `\n(宪章影响没比对出来: ${errText(e)} —— 改的若是进宪章的内容, 受影响的 wizard 要 handoff 才换上)`;
      };
      try {
        const hits = charterImpact(before, (c.after ?? charterSnapshot)(targets));
        return { r, note: liveOf(hits.map((h) => h.target)).then((live) => announceCharterImpact(c, hits.filter((h) => live.includes(h.target)))).catch(fail) };
      } catch (e) { return { r, note: Promise.resolve(fail(e)) }; }
    };

    // POST /config/get —— 新 MCP 带 `path` (可空) 拿渲染好的文本; 老 MCP 带 `key` 拿 {key, value}。
    http.register("POST /config/get", async (req, res) => {
      const body = (await readBody(req)) as { key?: string; path?: string };
      if (typeof body.key === "string") { const r = legacyGet(cfg, body.key); json(res, r.ok ? 200 : 400, r); return; }
      // chatPolicy.<聊天名>… 换成它指向的 principal 再查 (同 config_set 的 pinChatKeys); 认不出的原样查。
      const p = parsePath(body.path);
      const base = p[0] === "chatPolicy" && p[1] ? chatBaseOf(cfg, p[1]) : "";
      const r = configGet(cfg, sourcePath, base ? ["chatPolicy", base, ...p.slice(2)].join(".") : body.path, configEvidence);
      json(res, r.ok ? 200 : 400, r);
    });

    // chatPolicy 的键一律落成 base principal: 聊天名会改, 拿它当键一改名策略就悄悄失效。写名字照收,
    // 换成它此刻指向的 principal; 认不出的拒写 (写错的键静默无效, 比报错难查)。unset 一个盘上原样存在的
    // 键不换 —— 留给清理老写法 / 失效的键。
    const pinChatKeys = (req: SetReq): SetReq | { ok: false; reason: string } => {
      const p = parsePath(req.path);
      if (p[0] !== "chatPolicy") return req;
      const bad = (k: string) => ({ ok: false as const, reason: `认不出聊天 \`${k}\`: 键写 base principal (\`chat:wr…\` / \`user:…\`) 或聊天名 (/chats)` });
      if (p.length === 1) {
        if (req.value === undefined || typeof req.value !== "object" || Array.isArray(req.value)) return req;
        const pairs = Object.entries(req.value as Record<string, unknown>).map(([k, v]) => [k, chatBaseOf(cfg, k), v] as const);
        const miss = pairs.find(([, b]) => !b);
        return miss ? bad(miss[0]) : { ...req, value: Object.fromEntries(pairs.map(([, b, v]) => [b, v])) };
      }
      const key = p[1]!;
      if (req.op === "unset" && p.length === 2 && key in cfg.chatPolicy) return req;
      const base = chatBaseOf(cfg, key);
      return base ? { ...req, path: ["chatPolicy", base, ...p.slice(2)].join(".") } : bad(key);
    };

    // POST /config/set —— 口令门见 `guarded`。分级在这里而不在 hook: `card` 项由守护进程
    // 自己推确认卡, 所以 danger.skipAll / ⏱窗口 都放不掉它。卡等 CONFIRM_INLINE_MS 还没人点
    // 就先回 pending (fetch 默认 5 分钟收不到头就断), 卡仍有效, 迟到的确认照常落盘并捎一句给调用方。
    http.register("POST /config/set", guarded(async (req, res) => {
      const body = (await readBody(req)) as SetReq & { key?: string; action?: string; sessionId?: string; tmuxPane?: string; target?: string };
      const legacy = typeof body.key === "string";
      const asked = legacy ? fromLegacy(body.key!, body.value, body.action) : body;
      if ("ok" in asked) { json(res, 400, asked); return; }
      const ask = pinChatKeys(asked);
      if ("ok" in ask) { json(res, 400, ask); return; }
      const reply = (pl: Plan, text: string, extra: Record<string, unknown> = {}): void =>
        json(res, 200, legacy
          ? { ok: true, key: body.key, before: pl.before, after: pl.after, ...extra }
          : { ok: true, text, ...extra });
      const pl = planSet(cfg, sourcePath, ask);
      if (!pl.ok) { json(res, 400, pl); return; }
      if (ask.dryRun || !pl.changed) { reply(pl, `${ask.dryRun ? "dryRun, 没写:\n" : ""}${renderPlan(pl)}`); return; }

      // 落盘时重算一遍: 等卡期间文件可能被别人改过, 按那一刻的文件打补丁、再校验。
      // 宪章快照取在落盘之前 (守卫里): hot 项一 applyHot, 活的 cfg 就已经是新的了。
      // 不用 resolveSelf: 它最后回落到 defaultChat, 会把认不出的调用方当成那个群的管家。
      const caller = (body.sessionId?.trim() && m.targetForSession(body.sessionId.trim())) || (body.tmuxPane?.trim() && m.targetForPane(body.tmuxPane.trim())) || undefined;
      // 人发起 = 调用方这一轮的链头是人 (人在群里 / 单聊里叫它改的)。
      const byHuman = !!caller && !!askerOf(caller)?.who.startsWith("user:");
      const commit = async (): Promise<(Plan & { charter: string }) | { ok: false; reason: string }> => {
        const { r: now, note } = guardCharter(() => {
          const now = planSet(cfg, sourcePath, ask);
          if (!now.ok) return now;
          patchJsonc(sourcePath, [{ path: now.jsonPath, value: now.value }]);
          applyHot(cfg, now);
          return now;
        }, (now) => now.ok ? { what: `\`config_set ${now.path.join(".")}\``, self: caller, byHuman, reload: now.apply === "reload", after: charterUnder(now) } : undefined);
        return now.ok ? { ...now, charter: await note } : now;
      };
      const done = (now: Plan & { charter: string }): string =>
        `已写入${now.apply === "hot" ? ", 已生效" : "; 需 reload (`./cli/wezard.sh reload`) 才生效"}:\n${renderPlan(now)}${now.charter}`;

      if (pl.gate !== "card") {
        const now = await commit();
        if (!now.ok) { json(res, 400, now); return; }
        reply(now, done(now));
        return;
      }
      const self = resolveSelf(body);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session; 这一项要发确认卡给人点" }); return; }
      let decided: Promise<boolean>;
      try {
        ({ decided } = await requestConfirm({
          client: ws.client, principal: self, who: displayName(self),
          title: `配置变更待确认 · ${pl.path.join(".")}`,
          body: `${displayName(self)} 要改配置:\n${renderPlan(pl)}`,
          timeoutMs: CONFIRM_TIMEOUT_MS,
        }));
      } catch (e) {
        json(res, 503, { ok: false, reason: `确认卡发不出去 (${errText(e)}), 没写` });
        return;
      }
      const settle = async (yes: boolean): Promise<string> => {
        if (!yes) return `人没确认 (拒绝或超时), \`${pl.path.join(".")}\` 没写`;
        const now = await commit();
        return now.ok ? done(now) : `人确认了, 但落盘前重算没过, 没写: ${now.reason}`;
      };
      const inline = await Promise.race([decided, sleep(CONFIRM_INLINE_MS).then(() => undefined)]);
      if (inline !== undefined) {
        const text = await settle(inline);
        json(res, 200, legacy ? { ok: inline, key: body.key, before: pl.before, after: inline ? pl.after : pl.before, note: text } : { ok: true, text, confirmed: inline });
        return;
      }
      void decided.then(async (yes) => notices.post([self], `config_set 的确认卡有结果了: ${await settle(yes)}`))
        .catch((e: unknown) => log.warn({ err: errText(e) }, "config_set: 迟到的确认落盘失败"));
      json(res, 200, legacy
        ? { ok: false, reason: "确认卡已发到群里, 还没人点; 点了之后自动落盘" }
        : { ok: true, pending: true, text: `确认卡已发到群里, 还没人点 (卡 ${CONFIRM_TIMEOUT_MS / 60_000} 分钟内有效)。点了之后守护进程自动落盘, 结果会捎在你下一条收到的消息上 —— 不用重发。\n${renderPlan(pl)}` });
    }));

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
      // 每一步、每条进度都在发起这次 run 的那一轮的频道里: 人在群里叫它发起的才进群,
      // 私聊轮里发起的整场只进 rolepage —— 步骤不带频道就等于在节点的 home 群里开口。
      const channel = m.currentChannel(self);
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
        send: async (target, text, origin) => (await handedOff(target), m.injectText(target, text, origin, { channel })),
        isBusy: m.isBusy,
        lastText: async (target) => m.lastText(target),
        notify: (_base, markdown) => { if (channel) notifyChat(channel, markdown); },
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
    scheduledTaskInject = async (target, text, { taskId, fresh, quiet }) => {
      // 安静任务私下跑 (channel ""): 镜像不推它的任何一句, 终句由 relayUnlessQuiet 判断要不要进群。
      const inNamed = async (): Promise<{ ok: boolean; reason?: string }> => {
        const at = Date.now();
        const turn = newTurn();
        const inj = await m.injectText(target, text, undefined, quiet
          ? { from: { kind: "task", taskId }, channel: "", envelope: renderTaskEnvelope(taskId, { turn }) }
          : { fromChat: true, from: { kind: "task", taskId }, envelope: renderTaskEnvelope(taskId) });
        if (inj.ok && quiet) void relayUnlessQuiet(target, at, turn, baseOfKey(target));
        return inj;
      };
      if (!fresh) await handedOff(target); // 交接中途 pane 是空的, 别当成闲着投进去
      const busy = fresh ? false : await m.isBusy(target);
      if (!fresh && !busy) return inNamed();
      // 点名的目标正忙: 顺延到它这一轮结束再投 (与 tell_peer 默认的 normal 同一口径) ——
      // 「在它那儿继续」是排班时要求的, 不该因为撞上它在干活就换成白板。后台等, 别拖住
      // 调度器的其它任务; 等满 30 分钟仍忙才退回起白板。
      const inRunner = (wasBusy: boolean): Promise<{ ok: boolean; reason?: string }> => runTaskInRunner(target, text, taskId, quiet, wasBusy);
      if (!fresh && busy) {
        // 同一条任务已有一枪在等这个目标: 这一枪并进去 —— 等它闲下来时几枪一起投, 会挤进同一个输入框。
        if (postponed.has(taskId)) return { ok: true, reason: "上一枪还在等它闲下来, 这一枪并入" };
        postponed.add(taskId);
        void (async () => {
          const wr = await m.untilIdle(target, TASK_POSTPONE_MS);
          postponed.delete(taskId);
          const r = wr.idle ? await inNamed() : await inRunner(true);
          log.info({ taskId, target, postponed: true, idle: wr.idle, ok: r.ok, reason: r.reason }, "scheduled task: 目标正忙, 顺延");
          if (!r.ok) notifyChat(baseOfKey(target), withTagHeader(target, `⏰ 定时任务 \`${taskId}\` 顺延后注入失败: ${r.reason ?? "unknown"}`));
        })();
        return { ok: true, reason: "目标正忙, 顺延到它闲下来" };
      }
      return inRunner(busy);
    };
    /** 顺延中的任务 (内存即可: reload 丢了只是少放一枪, 下一次到点照常)。 */
    const postponed = new Set<string>();
    /** 安静任务那一轮的终句: 它私下跑, 镜像不推; 等它这一轮跑完, 终句不是 `QUIET` 就替它
     *  发进群 (头写它的名字, 人知道是谁说的)。按信封件号定位答句 (同回执): 按时刻取会把紧随
     *  其后的私聊 / 人话那一轮的答案当成它的, 把私下内容发进群。 */
    const relayUnlessQuiet = async (t: string, at: number, turn: string, base: string): Promise<void> => {
      quietRelays.set(turn, { target: t, at, base });
      const end = at + TASK_QUIET_WAIT_MS;
      // 先等它动起来: 刚注入时注册表还报 idle。
      await sleep(5000);
      while (Date.now() < end) {
        await m.untilIdle(t, end - Date.now());
        const reply = (m.replyToPeer(t, "", at, turn)?.text ?? "").trim();
        if (reply && (await m.idleNow(t))) {
          if (!isQuiet(reply)) notifyChat(base, withTagHeader(t, reply));
          log.info({ target: t, quiet: isQuiet(reply), len: reply.length }, "quiet task: 一轮结束");
          quietRelays.drop(turn);
          return;
        }
        await sleep(5000);
      }
      log.warn({ target: t }, "quiet task: 等满仍没收口, 不转发");
      quietRelays.drop(turn);
    };
    // 落盘: 这个仓库里 reload 是常态, 守在内存里的那一轮一 reload 就既不转发也不说 QUIET 了。
    const quietRelays = loadJsonMap<{ target: string; at: number; base: string }>(
      join(cfg.daemon.stateDir, "quiet-relays.json"),
      (rows) => Object.fromEntries(Object.entries(rows).filter(([, r]) => Date.now() - r.at < TASK_QUIET_WAIT_MS)),
    );
    void m.restored.then(() => Object.entries(quietRelays.all()).forEach(([turn, r]) => void relayUnlessQuiet(r.target, r.at, turn, r.base)));
    /** 到点起一个白板 wizard 执行这一枪, 跑完自动收掉。 */
    const runTaskInRunner = async (target: string, text: string, taskId: string, quiet: boolean, busy: boolean): Promise<{ ok: boolean; reason?: string }> => {

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
      if (!quiet) {
        notifyChat(base, withTagHeader(target, busy
          ? `⏰ 定时任务到点时正忙, 已起白板 wizard .${runnerName} 单独执行, 完成后自动收掉`
          : `⏰ 定时任务已起白板 wizard .${runnerName} 执行, 完成后自动收掉`));
      }
      const at = Date.now();
      const turn = newTurn();
      const inj = await m.injectText(runner, text, undefined, quiet
        ? { from: { kind: "task", taskId }, channel: "", envelope: renderTaskEnvelope(taskId, { turn }) }
        : { fromChat: true, from: { kind: "task", taskId }, envelope: renderTaskEnvelope(taskId) });
      if (!inj.ok) { wizards.drop(runner); return inj; }
      // 没有人会对这个一次性分身喊 stop_wizard, 只能自己等它闲下来再收。30min
      // 内没闲下来就放弃自动回收 (它大概率还在干一个长活), 留给人手动处理 ——
      // 比杀掉一个还在跑的 pane 安全。
      void (async () => {
        // 安静任务先把终句取走 (收掉 pane 之后就读不到了)。
        if (quiet) await relayUnlessQuiet(runner, at, turn, base);
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

    // 记忆整理者的一轮: 在内部 key 上起白板 wizard, 私聊注入, 闲下来就收 —— 全程不碰
    // 任何群 (silent spawn、channel ""、无 notifyChat)。它没有人能点审批卡, 所以这一轮
    // 给它的 key 开一个 ⏱ 窗口; 危险名单照旧逐条要卡, 而它的活 (读收件箱、改 md) 不在其列。
    stewardRun = async (prompt) => {
      const target = STEWARD_TARGET;
      wizards.upsert(target, { description: "共享记忆整理的一次性执行体 (守护进程内建, 不属于任何群)", bornAt: Date.now() });
      const name = wizards.rename(target, "memsteward-run");
      setAutoWindow(target, STEWARD_RUN_MS + 5 * 60_000);
      const done = async (r: { ok: boolean; reason?: string }) => {
        await m.killPane(target).catch(() => undefined);
        wizards.drop(target);
        clearAutoWindow(target);
        return r;
      };
      const spawned = await m.newSession(target, name, undefined, { cwd: memoryRoot(cfg.daemon.stateDir), silent: true, keepalive: false });
      if (!spawned.ok) return done({ ok: false, reason: `spawn: ${spawned.reason ?? "unknown"}` });
      const inj = await m.injectText(target, prompt, undefined, { from: { kind: "task", taskId: STEWARD_ID }, channel: "", envelope: stewardEnvelope() });
      if (!inj.ok) return done(inj);
      // 超时也收: 没人会对它喊 stop_wizard; 认领留着, 孤儿回收会再派一轮。
      const idle = await waitForIdle(target, m.isBusy, STEWARD_RUN_MS, () => false);
      return done(idle.idle ? { ok: true } : { ok: false, reason: idle.reason });
    };

    // 整理者与在场 wizard 之间的两根线 (memory.md ①②): 合并前给它看 CLAUDE.md /
    // auto-memory 好去重, 合并后告诉读这份 md 的 wizard —— 它们的宪章是出生时的快照。
    // md ↔ wizard 一律正向算 (mdsOf / cwdOfMd), 不从文件名反推。
    const stateDir = cfg.daemon.stateDir;
    // 全量绑定 (含冷的), 与 settleAll 同一份 —— 不依赖身份记录在不在。
    const boundTargets = (): string[] => m.chatRoster("").flatMap((c) => c.targets).filter((t) => !isInternalKey(t));
    const cwdOfTarget = (t: string): string => { const c = m.getCwd(t); return c.runningCwd || c.defaultCwd; };
    // 人和各家 CLI 自己读的那几份项目说明 + 各 backend 的 auto-memory 索引。
    const PROJECT_DOCS = ["CLAUDE.md", "CODEBUDDY.md", "AGENTS.md", join(".claude", "CLAUDE.md")];
    stewardWiring = {
      refsOf: (md) => {
        // cwd 候选: 提议里带的 (提议者可能早收工了) + 在场绑定的; 再正向算出 md 比对。
        const cwds = [...new Set([...proposedCwds(stateDir), ...boundTargets().map(cwdOfTarget)].filter(Boolean))];
        const cwd = cwdOfMd(stateDir, md, cwds);
        if (!cwd) return [];
        return [...PROJECT_DOCS.map((f) => join(cwd, f)), ...projectDirsFor(cwd).map((d) => join(d.dir, "memory", "MEMORY.md"))].filter((f) => existsSync(f));
      },
      // 只投给 pane 活着的: 冷的那些醒来时宪章重渲染, 新记忆已在里面, 再提一句就重复了。
      onMerged: (mds) => void (async () => {
        const changed = new Set(mds);
        const snap = await runTmux(["list-panes", "-a", "-F", "#{pane_id}"]);
        if (!snap.ok) return;
        const live = new Set(snap.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
        for (const t of boundTargets()) {
          const pane = m.sessionInfo(t)?.tmuxPane;
          if (!pane || !live.has(pane)) continue;
          const where = (scope: MemoryScope): string => (scope === "workspace" ? "本工作区" : baseOfKey(t).startsWith("user:") ? "本单聊" : "本群");
          for (const h of mdsOf(stateDir, baseOfKey(t), cwdOfTarget(t)).filter((x) => changed.has(x.md))) {
            notices.post([t], `${where(h.scope)}记忆已更新, 全文见 \`${h.md}\``);
          }
        }
      })().catch((e: unknown) => log.warn({ err: (e as Error).message }, "memory steward: notice fan-out failed")),
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

  // 共享记忆整理 — daemon 内建, 不进任务表 / 日程, 不出任何气泡。
  const steward = stewardRun
    ? startSteward({ root: memoryRoot(cfg.daemon.stateDir), log: log.child({ mod: "steward" }), run: stewardRun, ...stewardWiring })
    : undefined;

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
    steward?.stop();
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
