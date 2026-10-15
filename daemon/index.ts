import { wxMarkdown } from "../shared/wx-text.js";
// Daemon entry. Resident process — exits only on signal or fatal WS auth failure.
import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { loadOrCreateSvrToken } from "../shared/svr-token.js";
import { DAEMON_TOKEN_FILE, DAEMON_TOKEN_HEADER } from "../shared/daemon-token.js";
import { homedir } from "node:os";
import { TIERS, defaultChatFor, tiersForBackend, loadConfig, type TierName } from "../shared/config.js";
import { makeLogger } from "../shared/log.js";
import { clipLine, sleep, truncate } from "../shared/std.js";
import { patchJsonc } from "../shared/config-writer.js";
import { EFFORTS, parseEffort } from "../shared/effort.js";
import { bindCliBackends, projectDirsFor, type CliBackendName } from "../shared/cli-backends.js";
import { bindCodexStateDir } from "../shared/codex.js";
import { startMux, pinFrameBot } from "./bot-mux.js";
import { startWeixin } from "./weixin.js";
import { installWeixinPort } from "./weixin-port.js";
import { bindWxCommands, makeOnBound, makeWxCommands, routeSendMedia, wecomBindSink, weixinSendMedia, wxAdmins, wxRoutes } from "./weixin-cmd.js";
import { bindChatReach } from "./reach.js";
import { planMedia, type MediaKind, type SendMedia } from "./media.js";
import { aibotSendMedia } from "./aibot-media.js";
import { startNetWatch } from "./net-watch.js";
import { startHttp, json, readBody, type Handler } from "./http.js";
import { parsePath } from "../shared/config-meta.js";
import { applyHot, cfgSeenBy, patchedTop, pinChatKeys, configGet, fromLegacy, legacyGet, pickTier, planSet, renderPlan, tierEvidence, type Plan, type SetReq, type TierUsage, type UsageTotals } from "./config-api.js";
import { computeUsage, costOf, fmtCost, fmtTokens, sumTotal, type ModelTotals } from "./usage.js";
import { installInboundRouter } from "./inbound.js";
import { loadMirrorStore } from "./mirror-store.js";
import { cancelOps, deadlineOf, eventRef, isEventRef, makeOutcome, openRouter, ops, pickPair, type EventId, type FinalVerdict, type Op, type Receiver, type Route } from "./router.js";
import { createMessageEvents, messageId, finalId, type MessageAdapters, type MessageEvent } from "./message-events.js";
import { startMirror, installMirrorEventListener } from "./mirror-bridge.js";
import { backendFor, runTmux, setTmuxTimeoutReporter, spawnTmuxClaude } from "./spawn-tmux.js";
import { bindCardChannel, installApprovalEventListener, makeApproveHandler, requestConfirm } from "./approval.js";
import { initDetailPersistence, makeDetailHandler, chatHandlers, configureRemoteForward, chatUrlFor, buildChatUrl, getDetail, setWorldFactsProvider, currentHumanQueryOf, recordPost, recordCharter, backfillCharter } from "./detail.js";
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
import { footerTarget, responseFormatPolicy } from "./message-format.js";
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
import { deliverScheduled, type ScheduledDispatchOptions, type ScheduledResult } from "./scheduled-delivery.js";
import { describeTrigger, nextFire, parseTrigger, WHEN_HELP } from "../shared/trigger.js";
import { isQuiet, slugify, uniqueId } from "../shared/task-file.js";
import { baseOfKey, bindMultiBot, bindTagLinker, botOfKey, headed, ownHead, isInternalKey, keyOf, linkTags, normalizeTag, sameBot, speakerHead, tagFromCwd, tagHead, tagLink, tagOfKey, uniqueTag, withTagHeader } from "../shared/session-label.js";
import { appendEpisode, clipForCharter, cwdOfMd, episodePath, inboxPath, mdsOf, proposedCwds, memoryPath, memoryRoot, proposeMemory, readMemory, type MemoryScope } from "./wizard-memory.js";
import { retireStewardTask, startSteward, stewardEnvelope, STEWARD_ID, STEWARD_RUN_MS, STEWARD_TARGET, type RefsOf } from "./memory-steward.js";
import type { Asker, TurnFrom } from "../shared/detail-store.js";
import { applyChatNames, chatBaseOf, chatNameOf, chatPolicyOf, clearChatName, listChatNames, normChatName, peerAddress, planChatNames, setChatName, stewardTierOf, type CharterChange, type CharterGuard } from "./chat-name.js";
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
import { activeRows, bindNoticeBox, createNoticeBox, createSeenRing, gcSeen, chatAudience, hears, noticeSuffixFor, type Notice, type Subject, type Part, type SeenRow, type TimedSnapRow, type Via } from "./notices.js";
import { createLedger, digest, pendingGc, renderDigest, renderTable, renderAwaiting, renderStalled, renderShelved, ago as agoMs, HEARD_EVERY_MS, type Item as PendingItem, type LiveOf, type Mark } from "./pending-items.js";
import { checkDirection } from "./direction.js";
import { loadJobStore, dutyLine, awaitingAccept, stalledRoots, shelvedRoots, nudgeDue, dayClamp, childrenOf as jobChildren, jobEpisode, rejectReason, ACCEPTS, JOB_MEMBER_MAX, JOB_DEPTH_MAX, depthOf, ancestorsOf as jobAncestors, treeOrder, jobStage, type Accept, type JobMark, type JobRecord, type MemberLive } from "./jobs.js";
import type { MemberRole } from "../shared/world.js";
import { cacheTouchMs, cacheTtlSec, clipMiddle, contextFiles, firstStamp, parseClosing, stripClosingMark, stripForChat, lastContextTokens, lastExchange, lastModel, openingTurn, replyClosedBefore, talkTurns, turnsSince, renderPeerEnvelope, renderReceiptEnvelope, renderTaskEnvelope } from "./peers.js";
import { expandHome } from "../shared/paths.js";
import { loadJsonMap } from "../shared/json-map-store.js";
import { createWorkflowNodes, type FileVersion, type NodeAttempt } from "./workflow-nodes.js";
import { loadWorkflowPlans, createWorkflowPlanRunner, type PlanPermit } from "./workflow-plans.js";
import { registerWorkflowPlanRoutes } from "./workflow-plan-http.js";
import { returnOpOf, type HeldSeen, type InFlight, type Prereq, type ReturnOp, type Tell } from "./dispatch.js";
import { isTerminal, renderInFlight, turnState } from "../shared/turn-state.js";
import { startIdleNudge } from "./idle-nudge.js";
import { askerFromEnvelope, renderReminder, withMsg, type ReceiptStatus, type TurnTag } from "../shared/reminder.js";
import { createHandoffs, handedOff, handingOff, type Pending as PendingHandoff } from "./handoff.js";
import { coldGateOf, decide, rankCandidates, renderCandidates, routeDutiesOf, tierFor, wakeCostOf, wakeNoteOf, type RouteRow } from "./route.js";
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
  bindMultiBot(cfg.bots.length > 0);
  const log = makeLogger({
    logFile: cfg.daemon.logFile,
    logLevel: cfg.daemon.logLevel,
    name: "wezard-daemon",
  });
  log.info({ sourcePath, pid: process.pid }, "daemon start");

  // 定时调度器的 `inject` 真正实现, 赋值在 mirror-mode 的大块里 (要用到那里面的
  // wizards / m / notifyChat), 但 startScheduler 在那块外面接线 —— 见文件尾。
  // 记忆整理者的执行体, 同样只有 mirror 模式给得出 —— 赋值见 scheduledTaskInject 旁边。
  /** T6: 失败合成的 sweeper (§4.2) —— 与 receipts 的 watcher 并跑, 投递只走路由表。 */
  let stopSweep = (): void => {};
  let stewardRun: ((prompt: string) => Promise<{ ok: boolean; reason?: string }>) | undefined;
  let stewardWiring: { refsOf?: RefsOf; onMerged?: (mds: readonly string[]) => void } = {};
  let scheduledTaskInject:
    | ((target: string, text: string, opts: ScheduledDispatchOptions) => Promise<ScheduledResult>)
    | undefined;

  // Bind the CLI backend registry. `primary` (= defaultCli) drives new-session
  // spawns; `backends` is every installed CLI whose transcript root exists, so
  // sessions from all of them can be mirrored concurrently — each attachment
  // derives its dialect from its own jsonl path. Must run BEFORE any mirror
  // attach / tmux spawn.
  const { primary, backends } = bindCliBackends({ ...cfg.wrc, projectsDirOverride: cfg.wrc.mirror.projectsDir });
  bindCodexStateDir(cfg.daemon.stateDir);
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
  // 回执路由表 (docs/evolve/receipt-router.md): 一件活 = 一行 `<event, owner, receiver>`,
  // 表 = 对 append-only journal 的 fold。boot 时只 fold 一次; 写入点 (open/move) 从 T3 起接。
  const router = openRouter({ note: (msg, extra) => log.child({ mod: "router" }).info(extra ?? {}, msg) });
  /** 新根 event: 来源自己的一笔 (人的一句话 / 定时任务 / detach 派活) 新领一个 (§9.1)。 */
  const newRootEvent = (): EventId => `e${randomBytes(3).toString("hex")}`;
  // T10 §9.6: 旧回执状态文件一次性归档 —— 表上还压着在飞的活就这次不动 (等它们收口, 下次 boot
  // 再试), 空表 = 那些账已经没有活的依据了, 留着只会让人误以为它在飞。工作流存档
  // (`*.nodes.json` / `*.plans.json`) 与回执文件同前缀但**不**归档 —— 那是计划的历史, 不是账。
  const archiveLegacyReceipts = (): void => {
    if (router.rows().some((r) => ["open", "need", "error", "held"].includes(r.status))) return;
    // 第三个路径按片段拼: 这里只是旧状态文件的**文件名**, 不是对退役模块的引用, 而 T10 的验收
    // grep 会扫那个词 (docs/evolve/receipt-router.md §9.6)。
    const legacyAnswerTransfers = `~/.wezard/${["answer", "transfers.json"].join("-")}`;
    [cfg.wrc.mirror.receiptsFile, cfg.wrc.mirror.holdsFile, legacyAnswerTransfers].forEach((file) => {
      const abs = expandHome(file);
      const bak = `${abs}.t10.bak`;
      if (!existsSync(abs) || existsSync(bak)) return;
      try { renameSync(abs, bak); log.child({ mod: "router" }).info({ from: abs, to: bak }, "legacy receipt state archived"); }
      catch (e) { log.child({ mod: "router" }).warn({ err: errText(e), file: abs }, "legacy receipt state not archived"); }
    });
  };
  archiveLegacyReceipts();

  // 一个或多个企微机器人 (bot + bots): 对下面所有模块只露主机器人那个 client, 分流在 bot-mux 里。
  // 必须先于 weixin-port / response-tracker 建好 —— 它们包在 mux 外层。
  const ws = startMux(cfg, log);
  // 切网 (换 WiFi / VPN 起停) 后原地重建 WS, 等价于自动做了一次 reload 的
  // 联通性部分 — 但保留全部内存态 (graph 运行、pending 长轮询、镜像绑定),
  // 也不依赖 launchd/systemd 的 respawn 策略 (nohup fallback 没有 supervisor)。
  const netWatch = startNetWatch(log.child({ mod: "net" }), (from, to) => {
    ws.reconnect(`network changed: ${from || "<offline>"} → ${to}`);
    wx.kick(`network changed → ${to}`);
  });
  // 微信 ClawBot: 每个扫码绑定的微信用户 = 一个群聊 `chat:wx_…`。分流层装在 tracker 里面 (先装) ——
  // tracker 的空消息 gate / last-response 记录照样覆盖微信; 其余模块照旧只认 ws.client。
  // 这里只建状态, 收发要等下面的入站监听全装好 (wx.start)。onBound 用到的 bridge 在下面
  // 才立起来, 绑定只会在开机很久之后发生, 闭包里取得到。
  const wxLog = log.child({ mod: "weixin" });
  // `/wx` 命令与续上的绑定共用的企微出口 (原生 aibot, 不经微信分流)。
  const wxPush = {
    log: wxLog,
    sendWecom: (p: string, md: string): void => void ws.client
      .sendMessage(baseOfKey(p).replace(/^(user|chat|group):/, ""), { msgtype: "markdown", markdown: { content: md } })
      .catch((e: unknown) => wxLog.warn({ to: p, err: errText(e) }, "wx cmd push failed")),
    sendWecomMedia: aibotSendMedia(ws.client, log.child({ mod: "media" })),
  };
  const wx = startWeixin({
    cfg,
    log: wxLog,
    sinkFor: (to) => wecomBindSink(wxPush, to),
    onBound: (acct, name) => makeOnBound({
      cfg, sourcePath, log: wxLog,
      hasSession: (t) => bridge.hasMirrorTarget(t),
      newSession: (t, win) => bridge.newSession(t, win, undefined, { silent: true }),
    })(acct, name),
    notifyWecom: (p, md) => void ws.client
      .sendMessage(baseOfKey(p).replace(/^(user|chat|group):/, ""), { msgtype: "markdown", markdown: { content: md } })
      .catch((e: unknown) => wxLog.warn({ to: p, err: errText(e) }, "weixin → wecom notice failed")),
  });
  installWeixinPort(ws.client, wx, wxLog);
  // 审批 / ask / outbound 的「送得到吗」: 微信 chat 看它自己的号, 不看企微长连接。
  bindChatReach((c) => (wx.owns(c) ? wx.live(c) : undefined));
  // Wrap replyStream / replyStreamWithCard before any module sends —
  // last-response tracker enables inbound's `quote` dedup of bot self-replies,
  // and its chat-gate drops header-only pushes (empty messages) daemon-wide.
  // 微信出站不走企微长连接, 不必等它连上。
  const responseTracker = installResponseTracker(ws.client, log.child({ mod: "chat-gate" }), (c) => wx.owns(c),
    (context) => responseFormatPolicy(cfg, context, (target) => chatUrlFor(cfg.daemon, target)));
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
  let peerEvents: Pick<MessageAdapters, "accepted" | "committed" | "canceled" | "valid" | "ready" | "inject"> | undefined;
  /** T4: 路由表的投递层 —— 在 mirror 大块里接线 (要用到 jobs / 回执信封 / 事件泵), 这里先留个口。 */
  let deliverFinal: ((e: MessageEvent, verdict: FinalVerdict) => void) | undefined;
  const events = createMessageEvents(join(cfg.daemon.stateDir, "message-events.json"), {
    resource: (target) => bridge.sessionInfo(target)?.tmuxPane || target,
    transcript: (target) => bridge.inputSessionInfo(target)?.jsonlPath ?? bridge.sessionInfo(target)?.jsonlPath,
    sessionId: (target) => bridge.inputSessionInfo(target)?.sessionId,
    valid: (e) => e.payload.peer ? !!peerEvents?.valid(e) : true,
    accepted: (e) => { if (e.payload.peer) peerEvents?.accepted(e); },
    committed: (e) => { if (e.payload.peer) peerEvents?.committed(e); },
    canceled: (e) => {
      if (e.payload.peer) peerEvents?.canceled(e);
      else if (e.payload.human && e.exposure === "none") {
        const body = `这条消息未执行：${e.reason ?? "已取消"}。`;
        events.result(e.id, body, finalId(e.id, e.channel, body));
        // A canceled, unexposed input has a terminal response owned by its original channel.
        events.delivery({ id: finalId(e.id, e.channel, body), eventId: e.id, target: e.target, turn: e.turn || e.id,
          channel: e.channel, revision: finalId(e.id, e.channel, body), body, chunks: bridge.formatFinal(e.target, e.turn || e.id, e.channel, body) });
      }
    },
    // 人话 (非 peer) 不再问「pane 闲不闲」: 忙就贴进去, 顺序交给 backend CLI 自己的输入队列
    // (贴进运行中的一轮记成 queued 轮, 终句照样归到这条 event —— 见 brief 的 seal/bindLine)。
    // 这一句曾是要 idleNow 的, 也就是那个反复 5s 超时的探测源头: 一超时就退避, 把同一 target
    // 后面排着的每一笔 (含后到的人话) 一起钉住十几分钟。交接期间照旧等 —— 那几秒 pane 真是死的。
    ready: async (e) => !handingOff(e.target) && (e.payload.peer ? !!(await peerEvents?.ready(e)) : true),
    inject: async (e, boundary) => {
      if (e.payload.peer) return peerEvents!.inject(e, boundary);
      if (!bridge.hasMirrorTarget(e.target)) {
        const spawned = await bridge.newSession(e.target, wizardStore()?.get(e.target)?.name || e.target, undefined, { silent: true });
        if (!spawned.ok) return { ok: false, retryable: true, reason: spawned.reason };
      }
      let outcome: { ok: boolean; retryable?: boolean; uncertain?: boolean; reason?: string } | undefined;
      pinFrameBot(e.payload.human!.frame, botOfKey(e.channel));
      await bridge.dispatch({ ...e.payload.human!, eventId: e.id,
        text: withMsg(e.payload.text, e.id),
        guard: (phase, identity) => boundary(phase, identity), onSubmitted: (r) => { outcome = r; } });
      return outcome ?? { ok: false, retryable: events.get(e.id)?.exposure === "none", uncertain: events.get(e.id)?.exposure !== "none", reason: "dispatch ended without a submission acknowledgement" };
    },
    evidence: async (e) => {
      const info = bridge.sessionInfo(e.target);
      const sameSession = e.sessionId ? e.sessionId === info?.sessionId
        : !e.transcript || e.transcript === info?.jsonlPath;
      if (e.canceled && sameSession && await bridge.idleNow(e.target)) events.released(e.id);
      const paths = [...new Set([bridge.sessionInfo(e.target)?.jsonlPath, e.transcript].filter((p): p is string => !!p))];
      for (const path of paths) {
        const turns = turnsSince(expandHome(path), e.at - 60_000);
        const start = turns.findIndex((t) => t.role === "user" && t.env?.eventId === e.id);
        if (start < 0) continue;
        const next = turns.findIndex((t, i) => i > start && t.role === "user" && !t.queued);
        const replies = turns.slice(start + 1, next < 0 ? undefined : next).filter((t) => t.role === "assistant");
        const last = replies.at(-1);
        // 软后端 (codebuddy 不写 stop_reason) 的「写完了」不是终句: 中途叙述 (「先跑 typecheck」)
        // 与终稿同形, 下一秒就跟着 function_call —— 必须见到轮终证据 (紧跟的 turn-metrics /
        // 下一句 user 行 / CLI 已闲) 才算这一轮说完, 否则假定论先落 answer、真结论再落一个 rev。
        const ended = next >= 0 || (last && !last.mid && !last.apiError && (!last.soft || last.end)) || (sameSession && await bridge.idleNow(e.target));
        // 一轮以 CLI 报错收尾: 那段报错不是定论, 但要作为中途态 (error) 报给 receiver ——
        // 所以照旧不落成 result, 只把原文交给 final (见 §9.4)。
        return { consumed: true, interjected: !!turns[start]!.queued,
          ...(next >= 0 ? { closedAt: turns[next]!.ms ?? Date.now() } : {}),
          ...(ended && last && !last.mid
            ? last.apiError ? { body: last.text, error: true } : { body: last.text, revision: finalId(e.id, e.channel, last.text) }
            : {}) };
      }
      return { consumed: false };
    },
    recovered: (e) => bridge.recoverEventFinal(e),
    // T4: 终句 → 路由表。onFinal 连同投递一起做 —— 定论先落盘 (`answer`), 再按 receiver
    // 投出去 (§9.3/§9.4); 实现在 mirror 大块里 (要 jobs / 信封 / 事件泵)。
    final: (e, verdict) => deliverFinal?.(e, verdict),
    format: (d) => ({ ...d, chunks: d.chunks.map((c) => responseTracker.freeze(d.channel.replace(/^(user|chat|group):/, ""), c)) }),
    send: async (d, n) => {
      await bridge.settleFinalProgress(d.id);
      const chat = d.channel.replace(/^(user|chat|group):/, "");
      if (wx.owns(chat)) {
        const result = wx.sendFinal(chat, wxMarkdown(d.chunks[n]!), `${d.id}:${n}`);
        return { ack: result.ack, queued: result.state === "queued" || result.state === "sending",
          uncertain: result.state === "uncertain" ? result.reason ?? "Weixin send ACK unknown" : undefined,
          failed: result.state === "failed" ? result.reason ?? "Weixin final rejected" : undefined };
      }
      const stream = d.stream && n === 0 && d.chunks.length === 1 && Date.now() < d.stream.expires ? d.stream : undefined;
      const ack = await responseTracker.sendFrozen(chat, d.chunks[n]!, stream, events.running);
      return ack && typeof ack === "object" && "errcode" in ack && ack.errcode === 0 ? { ack: JSON.stringify(ack) }
        : { ack: JSON.stringify(ack), uncertain: "final transport returned no explicit success ACK" };
    },
    deliveryEvidence: (d, n) => wx.finalStatus(`${d.id}:${n}`) as { state: "queued" | "delivered" | "uncertain" | "failed"; ack?: string; reason?: string } | undefined,
    held: (e, why, forMs) => log.warn({ event: e.id, target: e.target, speaker: e.speaker, priority: e.priority,
      serves: e.serves, after: e.payload.peer?.after, why, heldSec: Math.round(forMs / 1000) }, "message event held in queue"),
    error: (e) => log.error({ err: errText(e) }, "message event scheduler"),
  });
  const bridge = startMirror({ cfg, log: log.child({ mod: "mirror" }), client: ws.client, store: mirrorStore, events, sendFrozen: (channel, content, stream) => responseTracker.sendFrozen(channel.replace(/^(user|chat|group):/, ""), content, stream, events.running) });
  // 群里每个 `.name` 都挂它的 rolepage (见 session-label 的 TagLinker)。正文提及
  // 只认真有其人的 —— 随手写的 `.gitignore` 不该变成一个开在空栏上的链接。
  const known = (t: string): boolean => bridge.chatTargets(t).includes(t);
  // 名册在下面的 mirror 块里才绑 (bindWizardStore) —— 这里全走 wizardStore() 惰性取。
  bindTagLinker({
    targetOfUrl: (url) => footerTarget(url,
      new URL(".", buildChatUrl(cfg.daemon.detailPublicBase, cfg.daemon.host, cfg.daemon.port, "")).href,
      (id) => { const r = getDetail(id); return r && "target" in r ? r.target : undefined; }, known),
    urlOf: (t) => chatUrlFor(cfg.daemon, t),
    resolve: (name, from) => {
      const t = wizardStore()?.byName(name)?.target;
      return t && known(t) && sameBot(from, t) ? t : undefined;
    },
    nameOf: (t) => settleName(wizardStore(), chatNameOf(cfg, t), t),
    voiceOf: (t) => wizardStore()?.get(t)?.voiceOf,
  });
  // 人话也过交接的闸 (见 handoff.ts): 交接期间说的话进新会话, 不被旧会话带走、也不在
  // 重开的空档里 resume 回旧 sid。
  // 宪章守卫 (见「改配置会不会动到宪章」): 要等下面宪章渲染那一块立起来才有; 之前 (启动时那次自动补名) 只写不比对。
  let guardCharter: CharterGuard = (write) => ({ r: write(), note: Promise.resolve("") });
  const who = (t: string): string => `.${wizardStore()?.get(t)?.name || t}`;
  const ago = (at: number): string => { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`; };
  const rowLabel = (x: MessageEvent): string => `${x.payload.human ? "人话" : x.id.startsWith("rcpt:") ? `回执 ← ${x.speaker}` : `派活 ← ${x.speaker}`}`
    + `「${clipLine(x.payload.text, 24)}」${({ queued: "排队", dispatching: "正在贴", "awaiting-result": "在跑" } as Record<string, string>)[x.execution] ?? x.execution} ${ago(x.at)}`;
  /** 会话还没起好时气泡里那三个点 —— 不是提示文案, 就是 loading。 */
  const LOADING = "…";
  /** 人话的排队实况; "" = 这一刻没什么可说的 (气泡归 mirror 的 ack 或上一句实况)。 */
  const queueNote = (q: NonNullable<ReturnType<typeof events.queue>>, target: string, cold: boolean): string => {
    // 起会话那一段只留 loading, 不再写「正在拉起 … 的会话」: 那句话带着 `.x:` 头, 而此刻冷目标
    // 还没进名册的 known —— 头里的半截链接改写落空 (withMessageFooter 找不到 sender 就原样放行),
    // `[`.x`](url):` 进群被企微渲染成一个空链接; 它还会抢先 mirror 的 ack 进气泡、紧接着被顶掉,
    // 白闪一下。loading 才是这一段该有的内容。
    if (q.execution === "dispatching") return cold ? LOADING : "";
    if (q.execution !== "queued") return "";
    const holds = [handingOff(target) ? `${who(target)} 正在交接，交接完贴进新会话` : "", ...q.holds].filter(Boolean);
    // 前面既没有别的件、也没有否决项 ⇒ 没什么可报的, 别拿一句「排队中（前面 0 件）」去顶掉气泡。
    if (!q.ahead.length && !holds.length) return "";
    return [`排队中（同 pane 前面 ${q.ahead.length} 件）`,
      ...holds.map((h) => `- ${h}`),
      ...q.ahead.slice(0, 5).map((x, i) => `${i + 1}. ${rowLabel(x)}`),
      ...(q.ahead.length > 5 ? [`… 另 ${q.ahead.length - 5} 件`] : [])].join("\n");
  };
  /** 1.5s 内贴进去了就不出声 (mirror 会开它自己的气泡); 还在队里就把实况写进这条气泡, 每 3s
   *  刷一次, 直到它离队。企微流式气泡活不过 6 分钟, 刷到 5 分钟为止。
   *  loading 是纯文案, 不带头 —— 冷目标此刻还挂不出链接 (见 queueNote)。 */
  const watchQueue = async (a: { frame: Parameters<typeof ws.client.replyStream>[0]; streamId: string; principal: string }, id: string, cold: boolean, last = "", until = Date.now() + 300_000, wait = 1500): Promise<void> => {
    await sleep(wait);
    const q = events.queue(id);
    if (!q || Date.now() > until) return;
    const note = queueNote(q, a.principal, cold);
    if (note && note !== last) await ws.client.replyStream(a.frame, a.streamId, note === LOADING ? note : withTagHeader(a.principal, note), false).catch(() => undefined);
    // queued / dispatching 之外没有「排队实况」可言 —— 收工, 气泡从此归 mirror。
    if (!["queued", "dispatching"].includes(q.execution)) return;
    return watchQueue(a, id, cold, note || last, until, 3000);
  };
  installInboundRouter(ws.client, cfg, log, { ...bridge, dispatch: async (a) => {
    if (a.text.trimStart().startsWith("/")) { await handedOff(a.principal); await bridge.dispatch(a); return; }
    const id = a.eventId ?? messageId(botOfKey(a.principal), a.channel!, a.streamId);
    // 人话开一条根行 (§3.1): owner = 被点名的那个 wizard, 定论 = 这句人话的答复气泡;
    // 这一轮服务的正是它, 于是它在群里再派活都挂在这条根下。
    const at = Date.now();
    const deadlineAt = at + 12 * 3600_000;
    const root = newRootEvent();
    router.commit(ops.open({ event: root, owner: a.principal, at, deadlineAt,
      receiver: { kind: "chat", channel: baseOfKey(a.channel!), message: id },
      asker: { who: a.speaker!, chat: a.channel! } }));
    events.accept({ id, identity: a.identity, originalAt: a.originalAt, target: a.principal, speaker: a.speaker!, channel: a.channel!, serves: root,
      asker: { who: a.speaker!, chat: a.channel! }, priority: "normal", deadline: deadlineAt,
      payload: { text: a.text, human: a } });
    void watchQueue(a, id, !bridge.hasMirrorTarget(a.principal));
  } }, sourcePath, (w, c) => guardCharter(w, c));
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
  // 终端 / 持口令的进程发起绑定: 先推确认卡给审批人 (口令每个 wizard 都读得到), 点了才出二维码。
  const confirmBind = async (name: string): Promise<boolean> => {
    const to = wxAdmins(cfg)[0];
    if (!to) throw new Error("没有审批人 (approval.approvers / defaultChat / allowFrom 里都没有 user:)");
    const { decided } = await requestConfirm({
      client: ws.client, principal: to, who: "本机 `wezard wx bind`",
      title: "微信绑定待确认",
      body: `本机有进程 (终端或持 daemon 口令的 wizard) 要绑定一个新微信${name ? ` (群名「${name}」)` : ""}: 同意才会出二维码, 扫码的那个微信将能驱动本机。`,
      timeoutMs: 180_000,
    });
    return decided;
  };
  for (const [key, handler] of Object.entries(wxRoutes({ cfg, wx, sourcePath, confirmBind }))) http.register(key, guarded(handler));
  bindWxCommands(makeWxCommands({ cfg, sourcePath, wx, ...wxPush }));
  installAskEventListener(ws.client, log.child({ mod: "ask" }));
  // 入站监听 (inbound / approval / ask) 都装好了才开收: 首轮 getupdates 会立刻带回 reload 期间
  // 人发的话 (含回菜单的数字), 游标随即前移 —— 早了就是永久丢。
  wx.start();

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
    http.register("GET /message-events/status", (_req, res) => json(res, 200, events.status()));
    // 路由表的诊断视图 (`?owner=` = 那个 wizard 名下的行, 缺省 = 全表)。
    http.register("GET /routes", (_req, res, url) => {
      const owner = url.searchParams.get("owner")?.trim();
      json(res, 200, { ok: true, ...router.diagnose(owner || undefined) });
    });
    http.register("POST /message-events/reconcile", async (req, res) => {
      const body = await readBody(req) as { id?: string };
      json(res, 200, await events.reconcile(String(body.id ?? "")) ?? { error: "unknown event" });
    });
    http.register("POST /message-events/release", guarded(async (req, res) => {
      const body = await readBody(req) as { id?: string; reason?: string };
      const result = events.release(String(body.id ?? ""), String(body.reason ?? ""));
      json(res, result.ok ? 200 : 409, result);
    }));
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
      if (!planStore.allowExternal(target, wizards.get(target)?.name)) { json(res, 409, { ok: false, reason: "workflow plan reserves this executor" }); return; }
      const spawnLog = log.child({ mod: "mirror", sub: "spawn-init", target });
      const r = await spawnTmuxClaude({ cfg, log: spawnLog, windowName: target, systemPrompt: charterFor(target, { cli: backendFor(cfg).name }) });
      if (!r.ok) { json(res, 500, { ok: false, reason: r.reason }); return; }
      if (!planStore.allowExternal(target, wizards.get(target)?.name)) { if (r.tmuxPane) await runTmux(["kill-pane", "-t", r.tmuxPane]); json(res, 409, { ok: false, reason: "executor reserved during spawn; binding withheld" }); return; }
      const att = m.attach({ sessionId: r.sessionId!, jsonlPath: r.jsonlPath!, target, tmuxPane: r.tmuxPane, tmuxSession: r.tmuxSession });
      json(res, att.ok ? 200 : 500, att.ok ? { ok: true, sessionId: r.sessionId, tmuxSession: r.tmuxSession, tmuxPane: r.tmuxPane, target } : { ok: false, reason: att.reason });
    });
    // A missing agent identity is an error, never an invitation to impersonate defaultChat.
    // Pane wins across native session switches; the MCP session id is a spawn-time snapshot.
    const resolveSelf = (b: Partial<{ target: string; sessionId: string; tmuxPane: string }>): string => {
      const explicit = (b.target ?? "").trim();
      if (explicit) return explicit;
      const pane = b.tmuxPane?.trim();
      if (pane) return m.targetForPane(pane) ?? "";
      return b.sessionId?.trim() ? m.targetForSession(b.sessionId.trim()) ?? "" : "";
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
      if (!planStore.allowExternal(target, wizards.get(target)?.name)) { json(res, 409, { ok: false, reason: "workflow plan reserves this executor" }); return; }
      const sessions = await scanClaudeSessions();
      // 已绑在别的机器人聊天上的会话与不存在同形。
      const hit = sessions.find((s) => s.sessionId === sessionId && ((t) => !t || sameBot(target, t))(m.targetForSession(s.sessionId)));
      if (!hit) {
        json(res, 404, { ok: false, reason: `session ${sessionId} not found among live tmux sessions` });
        return;
      }
      if (!planStore.allowExternal(target, wizards.get(target)?.name) || !planStore.allowExternal(m.targetForSession(hit.sessionId))) { json(res, 409, { ok: false, reason: "workflow plan reserves this executor" }); return; }
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
      const body = (await readBody(req)) as Partial<{ cwd: string; name: string; tag: string; chat: string; target: string; sessionId: string; tmuxPane: string; cli: CliBackendName; model: string }>;
      const cwd = (body.cwd ?? "").toString().trim();
      if (!cwd) {
        json(res, 400, { ok: false, reason: "cwd required" });
        return;
      }
      const self = resolveSelf(body);
      if (!self) {
        json(res, 400, { ok: false, reason: "cannot resolve caller chat (pass target/sessionId/tmuxPane)" });
        return;
      }
      const wantChat = (body.chat ?? "").toString().trim();
      const base = ((b) => (b && sameBot(self, b) ? b : ""))(wantChat ? chatBaseOf(cfg, wantChat) : baseOfKey(self));
      if (!base) {
        json(res, 404, {
          ok: false,
          reason: `unknown chat '${wantChat}' — only NAMED chats can be spawned into; have someone run \`/name ${normChatName(wantChat) || "<name>"}\` there first`,
          candidates: chatNamesFor(self),
        });
        return;
      }
      const foreign = base !== baseOfKey(self);
      const slotR = await claimSlot(base, String(body.name ?? body.tag ?? ""), tagFromCwd(cwd) || "peer", [self]);
      if (!slotR.ok) { json(res, slotR.status, slotR.body); return; }
      const { target, slot: tag } = slotR;
      if (!planStore.allowExternal(target, wizards.get(target)?.name ?? tag)) { json(res, 409, { ok: false, reason: "workflow plan reserves this executor" }); return; }
      const existed = !!wizards.get(target);
      const name = wizards.rename(target, normalizeTag(String(body.name ?? body.tag ?? "")) || tag);
      const model = (body.model ?? "").toString().trim();
      log.child({ mod: "mirror", sub: "sessions-new", target }).info({ self, cwd, foreign, cli: body.cli, model }, "spawning peer session");
      // silent: 新 wizard 就位不进群 (生命周期事件), 同群的 wizard 从名册增量里得知。
      const r = await m.newSession(target, name, body.cli, { cwd, model, silent: true, guard: () => planStore.allowExternal(target, wizards.get(target)?.name ?? name) });
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
      const guard = () => planStore.allowExternal(target, wizards.get(target)?.name);
      if (!guard()) { json(res, 409, { ok: false, reason: "workflow plan reserves this executor" }); return; }
      const r = await m.injectText(target, text, undefined, { guard });
      json(res, r.ok ? 200 : 500, r);
    });
    // One-shot project switch: bind the chat-wide cwd AND apply it right here.
    // 活会话走交接 (handoff): 守护进程请它写简报 → 重开 (pendingCwd 在这一步被消费,
    // 落进新目录, 宪章随之重渲染) → 简报贴回, 上下文跟着过去, 「📂 当前项目」气泡
    // 照发 (announce —— 那是人看得见的回执)。一律 fire-and-forget: 调用方常常就是被换
    // 的那个, 它得先拿到这份应答、把这一轮说完, 交接才动得了手 (other 的第一拍就是等它
    // 闲)。交接没做成 → 捎一条提醒给它, pendingCwd 仍排着队, 人手 /new 照样完成切换
    // (若它本就在交接中, 那场交接的重开同样会消费这笔 pendingCwd)。冷会话 (pane 不在)
    // 没有可交接的上下文, 按老路直接新开。Resolved target
    // precedence: explicit body.target → sessionId-derived (so MCP can omit
    // it) → tmuxPane (stable across /clear) → cfg.defaultChat.
    http.register("POST /mirror/workspace", async (req, res) => {
      const body = (await readBody(req)) as Partial<{ target: string; sessionId: string; tmuxPane: string; cwd: string; keep: boolean }>;
      const cwd = (body.cwd ?? "").toString();
      const target = resolveSelf(body);
      if (!target) { json(res, 400, { ok: false, reason: "target required (or pass sessionId of an attached chat)" }); return; }
      if (!planStore.allowExternal(target, wizards.get(target)?.name)) { json(res, 409, { ok: false, reason: "workflow plan fixes executor cwd" }); return; }
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
      if ((await liveOf([target])).length) {
        const focus = `工作区切到 ${set.pendingCwd}: 简报里点一句手头活在新目录下怎么接着干`;
        void handoffs.other(target, focus, CHARTER_HANDOFF_MS, { announce: true }).then((r) => {
          if (!r.ok) notices.post([target], `换工作区到 ${set.pendingCwd} 的自动交接没做成: ${r.reason} —— 切换仍排着队, 手上这件告一段落后自己 \`handoff({brief})\`, 或让人在群里 /new 一下`);
        });
        json(res, 200, { ok: true, target, cwd: set.pendingCwd, scheduled: true });
        return;
      }
      // Same shape as inbound's /new: windowName = tag for tagged sessions,
      // principal for the default one. No explicit cwd — newSession reads the
      // pendingCwd just queued and clears it once applied.
      const r = await m.newSession(target, tagOfKey(target) || target, undefined, { guard: () => planStore.allowExternal(target, wizards.get(target)?.name) });
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
    // 多机器人隔离: 别的机器人名下的 wizard 由 resolvePeerTag 当作查无此名 (同形、candidates 只列
    // 同机器人的) —— 点名寻址 (peek / tell / wait / stop / clone from / handoff / set_model / pending /
    // schedule) 全过这一道。
    const resolvePeer = (
      self: string,
      tag: string,
    ): { ok: true; target: string; foreign: boolean } | { ok: false; status: number; reason: string; candidates?: string[] } => {
      const r = m.resolvePeerTag(self, tag);
      if (r.ok) return r;
      return { ok: false, status: 404, reason: r.reason, candidates: r.candidates };
    };
    /** 聊天名候选只列与调用方同机器人的 —— 别的机器人的聊天名也是它的存在。指名别的机器人的聊天,
     *  各路由一律走它们自己「认不出这个聊天」的分支 (同状态码同原话), 不说「那边有, 但归别人」。 */
    const chatNamesFor = (self: string): string[] => listChatNames(cfg).filter((c) => sameBot(self, c.base)).map((c) => c.name);

    // ── Chat naming ────────────────────────────────────────────────────
    // A WeCom chat's identity is an unreadable `chat:wrkS…` id. Naming it is
    // what makes cross-chat addressing (`daily#fix`) and cross-chat spawning
    // (`new_claude_session({ chat: 'daily' })`) expressible at all.
    http.register("POST /chats/list", async (req, res) => {
      const { self } = await readPeerBody(req);
      if (self) ensureChatNames(self);
      const roster = self ? m.chatRoster(self).filter((c) => sameBot(self, c.base)) : listChatNames(cfg).map((c) => ({ ...c, self: false, targets: [] }));
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
    // 出站媒体只经这一个口子 (通道无关, 见 media.ts); 别的通道接进来时在这里按 principal 分流。
    // 绑定过的微信群聊走微信 (上限不同, 校验也跟着各通道走 —— planFor)。
    const media = routeSendMedia(wx, weixinSendMedia(wx), aibotSendMedia(ws.client, log.child({ mod: "media" })));
    const sendMedia: SendMedia = media.send;
    const notifyChat = (base: string, markdown: string): void => {
      const chatId = chatIdOf(base);
      void ws.client
        .sendMessage(chatId, { msgtype: "markdown", markdown: { content: linkTags(base, markdown) } })
        .catch((e: unknown) => log.warn({ chatId, err: errText(e) }, "chat notify failed"));
    };
    // wizard 在群里的称呼, 只用在**正文**里。气泡的头照旧交给 withTagHeader ——
    // 那一段是路由信息 (`emoji.name:`), parseTagHeader 靠它反解, 群里引用一条气泡
    // 就能直接跟那个 wizard 说话; 把它换成名字会把这条通路弄断。
    const displayName = (t: string): string => {
      const name = settleName(wizards, chatNameOf(cfg, t), t);
      return name ? `.${name}` : "默认 wizard";
    };

    // wizard 之间的往返默认是私聊, 不进群。只有发话方判断「该当着人说」的那一次
    // (send_peer public:true) 在公开频道里成一条气泡, 头写成 `.a: .b`, 方向一眼可读。
    const RELAY_MAX = 1200;
    /** 一个 wizard 在群里的称呼: `.name`, 挂它的 rolepage。名字全局唯一, 不再
     *  因为落在哪个群而换写法 —— 引用这一段就能跟它说话 (parseTagHeader 认得)。 */
    const relayLabel = (t: string): string => ((h) => (h ? tagLink(t, h) : ""))(tagHead(t));
    /** 以 `self` 的名义往 `dest` 群发一条: 头独占一行; 头怎么写 (群默认 wizard 报不报名) 归 ownHead。 */
    const postAs = (self: string, dest: string, text: string): void => notifyChat(dest, headed(ownHead(self, dest), text, "\n\n"));
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
      const head = speakerHead(relayLabel(from), relayLabel(to));
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
      return id.startsWith("human:") ? id.slice("human:".length) : "";
    };
    // 挂起事项表 (见 pending-items.ts): 派活时记一行, 回执落定时由下面的 onOutcome 记账。
    const ledger = createLedger(loadJsonMap<PendingItem>(cfg.wrc.mirror.pendingFile, pendingGc, { strict: true }));
    const workflow = createWorkflowNodes(`${cfg.wrc.mirror.receiptsFile}.nodes.json`);
    const planStore = loadWorkflowPlans(`${cfg.wrc.mirror.receiptsFile}.plans.json`, workflow.prereq);
    const pendingBirthJobs = new Map<string, number>();
    let advancePlans = (): void => {};
    // Lifecycle continuations carry the same live attempt, never a new task.
    // Human inbound remains an explicit intervention; agent handoff/receipts
    // must not revive canceled or unconfirmed planned executions.
    const planContinuationAllowed = (target: string): boolean => {
      const r = planStore.reservation(target, wizards.get(target)?.name);
      if (!r) return planStore.healthy();
      const n = r.nodes.find((n) => n.to === target);
      const a = n && workflow.byTurn(r.owner, n.turn);
      return !!n && !!a && planStore.healthy() && r.state === "active" && n.phase === "observing"
        && !a.canceled && a.acceptance !== "rejected" && jobs.get(r.plan.job)?.status === "open" && ["running", "needs-input", "errored"].includes(a.execution)
        && (r.plan.nodes.find((x) => x.id === n.id)?.after ?? []).every((id) => workflow.prereq(r.owner, r.nodes.find((x) => x.id === id)!.turn)?.state === "done");
    };
    /** 一笔活第几个来回 (§3.2): 同一行上已经注入过的续问数 + 1 —— 现算, 不落第二份数据。
     *  续问的注入事件 id 是 `route:<event>:r<legs>`, 所以从它自己就能数回来 (reload 也在盘上)。 */
    const legsOf = (event: EventId): number =>
      events.status().events.reduce((n, e) => {
        const m = e.id.startsWith(`route:${event}:r`) ? Number(e.id.slice(`route:${event}:r`.length)) : NaN;
        return Number.isInteger(m) && m > n ? m : n;
      }, 1);
    /** 同一笔活上的一句续问 (idle-nudge 追问 / 工单打回): 不新开行, 注入事件 id
     *  `route:<event>:r<legs>` —— 它的终句照旧落到那一行上 (§9.4)。 */
    const acceptContinuation = (tell: Tell, text: string): boolean => {
      const event = tell.event ?? "";
      if (!event) return false;
      if (workflow.byTurn(tell.from, event) || !planStore.allowExternal(tell.to, wizards.get(tell.to)?.name)) return false;
      const legs = tell.legs ?? legsOf(event) + 1;
      const id = `route:${event}:r${legs}`;
      events.accept({ id, target: tell.to, speaker: tell.from, channel: tell.channel, serves: event, asker: tell.asker,
        priority: "normal", deadline: tell.deadlineAt ?? deadlineOf(tell.at ?? Date.now()), payload: { text, peer: {
          from: { kind: "peer", from: tell.from, event, ...(tell.asker ? { asker: tell.asker } : {}) },
          envelope: envelopeFor(tell.from, tell.channel, { legs, re: true, asker: tell.asker }),
          tell: { ...tell, event, legs, dispatchKey: id }, job: tell.job ?? "", kind: "task", held: true,
        } } });
      return true;
    };
    /** 已经因为不合工单验收被打回过的那些笔 (行状态会随打回留在 `open`, 光看它认不出「打回过」)
     *  → 被打回的那一轮的注入事件 id: 同一轮的终句重放 (见 deliverFinal) 认得出不是补交。 */
    const bounced = new Map<EventId, string>();
    /** 工单验收 (§9.6, 从 receipts 的 watcher 重建): 交的活不合规格 → 这一份不算交差。
     *  计划节点有自己的验收 (workflow), 不经这里。 */
    const acceptanceOf = (row: Route, body: string): string | undefined => {
      if (!row.job || bounced.has(row.event)) return undefined;
      // 计划节点有自己的验收 (workflow): 那份活由计划 runner 收口, 不走工单的工具级验收。
      if (workflow.all().some((a) => a.job === row.job && a.to === row.owner)) return undefined;
      const j = jobs.get(row.job);
      return j?.status === "open" ? rejectReason(j.accept ?? "result", parseClosing(body)) : undefined;
    };
    /** 以工单 owner 的名义在同一笔上打回一次: 不新开行, 行留在 `open` 等它按约定再交一份。 */
    const rebound = (row: Route, why: string, eventId: string): void => {
      bounced.set(row.event, eventId);
      const from = ledgerOwnerOf(row.event) || row.owner;
      acceptContinuation({
        from, to: row.owner, channel: "", event: row.event, legs: legsOf(row.event) + 1,
        deadlineAt: row.deadlineAt, ...(row.asker ? { asker: row.asker } : {}), ...(row.job ? { job: row.job } : {}),
      }, `（守护进程代 ${displayName(from)} 打回一次: 这件活是工单里的一份, 你的回复${why}。请按约定收口：RESULT: <结论>；交付文件逐项 ARTIFACT: <路径> — 一句话；真缺信息用 NEED: <问题>。）`);
      log.info({ event: row.event, why }, "receipt: 不合工单验收, 打回一次");
    };
    const turnsLine = (xs: readonly InFlight[], target: string): string => renderInFlight(xs, target, displayName);
    // reload 前在飞的回执: 等 mirror 把绑定都恢复了再续守 —— 早一步读 target 会拿不到
    // transcript, 退回按时刻取就可能把上一件事的结论当回执。
    // 交接 (见 handoff.ts): 换会话不换身份。这里给它重开、贴话、读旧 transcript 的能力,
    // 闸、回执清点与断点续做在那边。
    /** 情景记忆 (memory/episodes/<name>.jsonl) 按名字归档; 默认会话没名字时退回 slot / "default"。 */
    const episodeName = (t: string): string => wizards.get(t)?.name || tagOfKey(t) || "default";
    const handoffs = createHandoffs({
      isBusy: m.isBusy,
      sessionId: (t) => m.sessionInfo(t)?.sessionId ?? "",
      restart: (t, p) => restartFresh(t, p),
      // 简报是新会话的开场白, 但它不挂任何信封 (服务不着哪一笔) —— 交接前欠着的那几笔由
      // 「继续 <event>」逐笔续答 (见 resume), 别把简报那一轮的回复当成回执。
      inject: async (t, text, channel) => {
        if (!planContinuationAllowed(t)) return { ok: false, reason: "workflow continuation withdrawn" };
        if (planStore.reservation(t, wizards.get(t)?.name)) return { ok: false, reason: "workflow handoff requires the original attempt" };
        return m.injectText(t, text, undefined, { channel, guard: () => planContinuationAllowed(t) });
      },
      channelOf: m.currentChannel,
      lastText: m.lastText,
      // 欠账不落盘在交接里: 路由表按 target 记着它欠谁、欠哪几笔, 换会话不影响 (T8)。
      owed: (t) => router.owedBy(t).filter((r) => r.status === "open").map((r) => r.event),
      resume: async (t, event, at) => injectResume(t, event, at),
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
    /** 交接后把「你还欠着这一笔」再点一次 (§9.5): 注入一句 `继续 <event>`, 该轮的信封把
     *  `serves` 指回那一行 (注入事件 id `route:<event>:resume`), 于是它的终句照旧落定、
     *  照旧投给 receiver —— 换会话丢掉的只是 transcript, 不是这笔账。
     *  id 按这一场交接的起点 (`at`) 区分: 同一场 reload 重放判重不重投, 换一场才配一条新的。 */
    function injectResume(t: string, event: EventId, at: number): { ok: boolean; reason?: string } {
      const row = router.get(event);
      if (!row || row.owner !== t || row.status !== "open") return { ok: false, reason: "no open row to resume" };
      const r = row.receiver;
      const waiting = r.kind === "wizard" ? r.to : baseOfKey(r.channel);   // 等着它交代的那一方 (信封挂在它名下)
      const channel = r.kind === "chat" ? r.channel : "";                  // 结论要落回群里时才带频道 (§9.4)
      const base = `route:${event}:resume`;
      const id = events.status().events.some((e) => e.id === base) ? `${base}:${at}` : base;
      try {
        events.accept({
          id, identity: JSON.stringify([t, event, "resume", at]),
          target: t, speaker: waiting, channel, serves: event,
          ...(row.asker ? { asker: row.asker } : {}),
          priority: "normal", deadline: Date.now() + 12 * 3600_000,
          payload: { text: `继续 ${event}` + " —— 这是你交接前还没交代的那一笔: 现在就把它做完并收口 (RESULT 交差 / NEED 反问)。", peer: {
            from: { kind: "peer", from: waiting, ...(row.asker ? { asker: row.asker } : {}) },
            // 不是一件新活 (没有件号、不收新回执): 它只是把那一笔重新指给 owner。
            job: "", kind: "task",
            // 这一笔由注入事件的 `serves` 认 (信封不带 event)。
            envelope: envelopeFor(waiting, channel, { ...(row.asker ? { asker: row.asker } : {}) }),
          } },
        });
        return { ok: true };
      } catch (e) { return { ok: false, reason: errText(e) }; }
    }
    /** `self` 此刻这一轮派出去的活, 结论该交给谁 (见 planReturn)。只读它自己
     *  transcript 里开这一轮的那句 user 行的信封: attachment 上的 channel 在注入时就被
     *  排队的下一句改写了, transcript 才记着「这一轮是谁发起的」, reload 后也读得到。 */
    /** `target` 手上这一轮是哪件 peer 活 —— 认开头那句的信封: 有件号按件号, 老信封按发话方。 */
    /** `target` 手上这一轮若是某个 wizard 派来的活: 发话方的称呼 (`.x`) 与件号。人 / 定时 / 回执轮 = undefined。 */
    const openingAsk = (target: string): { from: string; event?: string } | undefined => {
      const p = m.sessionInfo(target)?.jsonlPath;
      const env = p ? openingTurn(expandHome(p))?.env : undefined;
      return env?.kind === "peer" && !env.receipt ? peerAsk(env) : undefined;
    };
    /** 一句同伴派活的出处: 发话方与它服务的那一笔 —— 派活信封不再带 event, 问注入事件的 `serves`;
     *  老信封带着的照用。 */
    const peerAsk = (env: { from: string; event?: string; eventId?: string }): { from: string; event?: string } => {
      const event = env.event ?? (env.eventId ? events.get(env.eventId)?.serves : undefined);
      return { from: env.from, ...(event ? { event } : {}) };
    };
    // ── 新路由表 (T3): 写入点 ──────────────────────────────────────────────
    // 一件活 = 一行 (§3.1)。这一层只做 open / move 与 serves 真值 —— 件号 (`t…`) 那套桥随
    // T10 全体退役: 注入事件的 id 就是 `route:<event>` (续问 `route:<event>:r<legs>`), 于是
    // 「W 这一轮服务哪一笔」直接问事件自己 (§9.4), 不再有第二套 id 要来回翻。
    /** 这一轮服务的那一笔 (§9.4): 开轮那句话的注入事件上记着 `serves` —— 人话轮是根行, 派活轮是
     *  新开的子行, **回执轮是 `receiver.event`**, 续问就是同一行。定时任务那一枪没有消息事件,
     *  它的信封上直接带着为它开的群根行 (`event`)。 */
    const servesOfTurn = (self: string): EventId | undefined => {
      const env = openingOfSelf(self)?.env;
      if (!env) return undefined;
      const e = env.eventId ? events.get(env.eventId) : undefined;
      return e?.serves || (env.kind === "task" ? env.event : undefined) || undefined;
    };
    /** 本轮若是一份回执: 它回的是哪一笔 (owner = 回执的发话方) —— `re` / 撤回不必再抄 id 的依据。 */
    const receiptOfTurn = (self: string): EventId | undefined => {
      const id = openingOfSelf(self)?.env?.eventId;
      const from = id ? events.get(id)?.payload.peer?.from : undefined;
      return from?.receipt ? from.event : undefined;
    };
    /** 开一行 (owner = 领活的人)。子行挂在自己服务的那一笔下, 挂不上就是新根 —— 建行这一处
     *  只认这两条, 别的判定 (§3.4 transfer 前置、409) 都在入口先做完。 */
    const openRow = (p: { event?: EventId; owner: string; receiver: Receiver; deadlineAt: number; job?: string; asker?: Asker; after?: readonly EventId[] }): EventId => {
      const event = p.event ?? newRootEvent();
      router.commit(ops.open({
        event, owner: p.owner, receiver: p.receiver, deadlineAt: p.deadlineAt,
        ...(p.job ? { job: p.job } : {}), ...(p.asker ? { asker: p.asker } : {}),
        ...(p.after?.length ? { after: [...p.after] } : {}),
      }));
      return event;
    };
    /** 派一件活的写入端 (§3.1): self 服务着某一笔 → 它的子行; 服务不着 → 新根;
     *  transfer = 把服务的那一笔 move 给目标 (不插行, 注入那一轮仍服务它); none = 不开行。
     *  返回这一轮服务的 event (不开行 = "") —— 注入事件的 id 就是从它算出来的。 */
    const openDispatchRow = (p: { self: string; target: string; op: ReturnOp; deadlineAt: number; job?: string; asker?: Asker; after?: readonly EventId[]; serves?: EventId }): EventId => {
      if (p.op === "none") return "";
      // 计划节点 / 停放放行: 那一笔在 plan 发起 / 停放那一刻就定了; 其余看本轮服务谁。
      const f = p.serves ?? servesOfTurn(p.self);
      if (p.op === "transfer") {
        if (f && router.get(f)?.owner === p.self) router.commit(ops.move({ event: f, owner: p.target }));
        return f ?? "";
      }
      const parent = p.op === "self" ? f : undefined;
      return openRow({
        ...(parent ? { event: `${parent}.${(router.get(parent)?.seq ?? 0) + 1}` } : {}),
        owner: p.target,
        receiver: parent ? { kind: "wizard", to: p.self, event: parent } : { kind: "wizard", to: p.self },
        deadlineAt: p.deadlineAt,
        ...(p.job ? { job: p.job } : {}), ...(p.asker ? { asker: p.asker } : {}), ...(p.after?.length ? { after: p.after } : {}),
      });
    };
    /** 那一笔行上的接收快照 (挂起账投影用): 结论收给谁。没有行 = 不知道 (还是记 nobody)。 */
    const receiverOfEvent = (event: string): Receiver | undefined => (event ? router.get(event)?.receiver : undefined);
    /** 挂起账里那一行的 owner = 派活方 = 这一笔的接收方。收给群的根行 (人话 / 定时) 不进账 ——
     *  账记的是 wizard 之间的派活。 */
    const ledgerOwnerOf = (event: EventId): string => {
      const r = router.get(event);
      return r && r.receiver.kind === "wizard" ? r.receiver.to : "";
    };
    /** 一件活的回执去向 (§3.2 / §9.5): `return` 只有四个词; 选定的那一笔 = `for` 指定 / 本轮
     *  服务的那一笔。物化的不再是一条栈, 而是一条 receiver 边 —— 见 openDispatchRow。
     *  `origin` = 续问 (`re`) 沿用的原件: 它的行就是选中那一笔。 */
    type ReturnPlan = { ok: true; op: ReturnOp; serves?: EventId } | { ok: false; status: 400 | 409; reason: string };
    const owedLabel = (r: Route): string =>
      r.receiver.kind === "wizard" ? `${displayName(r.receiver.to)} 派的件` : `${chatNameOf(cfg, r.receiver.channel) || r.receiver.channel} 里人问的那一轮`;
    const owedList = (self: string): string => {
      const xs = router.owedBy(self);
      return xs.length ? xs.map((r) => `\`${r.event}\` (${owedLabel(r)})`).join("; ") : "眼下你没有欠着任何一笔";
    };
    const planReturn = (self: string, body: Record<string, unknown>, origin?: EventId): ReturnPlan => {
      const r = returnOpOf(body);
      if (!r.ok) return { ok: false, status: 400, reason: r.reason };
      const want = typeof body.for === "string" ? body.for.trim() : "";
      if (origin !== undefined && want) return { ok: false, status: 400, reason: "`re` 续问沿用原件的那一笔, 不能再带 `for`" };
      // 续问只沿用原件: 改去向 (交出 / 旁支) 会让原件永远收不到结论 (§3.2)。
      if (origin !== undefined && (r.op === "transfer" || r.op === "detach"))
        return { ok: false, status: 400, reason: "`re` 续问只沿用原件: 不能带 transfer / detach" };
      if (want) {
        // `for` 说的是「为谁」: 派活方的名字 / 群名; 同一方欠着两笔才需要 event id。
        const id = eventRef(want);
        const who = isEventRef(id) ? undefined : resolvePeer(self, want);
        const rows = router.owedBy(self).filter((x) => x.status !== "answered" && (isEventRef(id)
          ? x.event === id
          : x.receiver.kind === "wizard" ? !!who?.ok && x.receiver.to === who.target : [chatNameOf(cfg, x.receiver.channel), x.receiver.channel].includes(want)));
        if (rows.length > 1)
          return { ok: false, status: 400, reason: `for "${want}" 对上你欠着的 ${rows.length} 笔, 用 event id 指明: ${rows.map((x) => `\`${x.event}\``).join(" ")}` };
        if (!rows[0])
          return { ok: false, status: 400, reason: `for "${want}" 不是你此刻欠着、还没交代的一笔 —— 你欠着的: ${owedList(self)}` };
        return { ok: true, op: r.op, serves: rows[0].event };
      }
      const inferred = origin ?? servesOfTurn(self);
      const row = inferred ? router.get(inferred) : undefined;
      // 本轮服务的那一笔已经被自己 transfer 出去了: 它的交代归接手方 (§3.4) —— 静默收口;
      // 真有与它无关的事, 显式 `for` 挂到你欠着的另一笔。
      // 续问 (origin) 的那一行本来就欠在对方手上 —— 只有本轮服务的那笔才谈得上「交出去了」。
      if (origin === undefined && row && row.owner !== self && r.op !== "transfer")
        return { ok: false, status: 409, reason: "这一轮服务的那一笔你已经 transfer 出去了: 它的交代归接手方, 不再由你派活或对人说话 —— 静默收口; 有别的要说, 用 `for` 挂到你欠着的另一笔" };
      return { ok: true, op: r.op, serves: row?.owner === self ? row.event : inferred };
    };
    /** 方向闸的那条链 (§9.5): 沿接收边 (`receiver`) 往上走 (`router.chain`, 带环保护), 收 owner key。
     *  `extra` = `for` 显式选中的那一笔 (本轮服务的那笔之外还要算的一条)。 */
    const chainNow = (self: string, extra?: EventId): { chain: string[]; depth: string[] } => {
      const of = (e?: EventId): string[] => (e ? router.chain(e).slice(1).map((r) => r.owner) : []);
      const inferred = of(servesOfTurn(self));
      const depth = extra ? of(extra) : inferred;
      return { chain: [...new Set([...inferred, ...depth])], depth };
    };
    // ── 新路由表 (T4): 投递层 ──────────────────────────────────────────────
    // 落盘与投递是两件事, 顺序不能反 (§9.3, 不变量 1): 先 `answer` 落盘 (它是投递幂等键的半边),
    // 再按 receiver 投 ——
    //   wizard → 进它的持久化收件箱: 复用 message-events 的注入队列, id = `rcpt:<event>:<rev>`。
    //   chat   → 只落 `hand`: 定论就是那句人话的答复气泡, 放行由 mirror-bridge 的 final 通道
    //            (eventFinalGate 读同一张表) 给出。
    // T7: 投之前先看收方 (§4.3 / §4.4) —— 收方 wizard 已注销 → 沿链升级 (信封正文说明跳过了谁);
    // 一路走到 chat 根 → Dead Letter; 要服务的那一笔已收口 = 孤儿 → 照投, 信封正文标迟到, 并写明
    // 收方这一轮带 `RESULT:` 的终句会作为那一笔的追述投到哪 (一环一环走, 不抄近路)。
    const deliverRoute = (event: EventId, out: { status: ReceiptStatus; body: string; rev: string }): void => {
      const row = router.get(event);
      if (!row) return;
      // 挂起账 / 工单账本跟着定论走 (§9.5 / §9.6): 每一份定论都从这儿过 (onFinal 的 answer、
      // 失败级联的 canceled、boot 的重投), 所以放这里而不是 commitRoute。收给群的根行不进账。
      if (row.receiver.kind === "wizard") {
        ledger.outcome(row.receiver.to, event, out.status, parseClosing(out.body).text || out.body);
        // 带 workflow 追踪的那件活: 执行态/正文/摘要跟着定论走 (计划节点据此推进) ——
        // 这一份原来只挂在旧回执 watcher 的 onOutcome 上, T10b 随它一起在这里重建。
        workflow.outcome(row.receiver.to, event, out.status, out.body);
        advancePlans();
        // 追述 (row.late) 不是工单成员的第二份结局: 账只记第一次落定。
        if (row.job && isTerminal(out.status) && !row.late)
          jobs.settle(row.job, row.owner, out.status, parseClosing(out.body).artifacts, { turn: event });
      }
      const esc = router.escalate(event, (k) => !!wizards.get(k));
      const receiver: Receiver = esc?.receiver ?? row.receiver;
      const via = (esc?.via ?? []).map(displayName);
      // 升级落在 chat 根 = Dead Letter: 退到那个群, 由它的默认 wizard 收下这份结论。
      const dead = receiver.kind === "chat" && !!esc;
      if (receiver.kind !== "wizard" && !dead) {
        router.commit(ops.hand({ event, inbox: `chat:${receiver.message}:${out.rev}` }));
        return;
      }
      // 回执那一轮服务的就是收方自己欠的那一笔 (`receiver.event`) —— 它的终句又一次落到那一笔上,
      // 递归在这里闭合 (§3.2): 叶子交差 → 回执轮 → 父交差 → … → 根交进群。
      const to = receiver.kind === "wizard" ? receiver.to : baseOfKey(receiver.channel);
      const group = receiver.kind === "chat" ? receiver.channel : "";
      const serves = esc ? esc.serves : row.receiver.kind === "wizard" ? row.receiver.event ?? "" : "";
      const servedRow = serves ? router.get(serves) : undefined;
      const served = servedRow?.receiver;
      // 只有要去群里收口时才带频道 (它服务的那一笔的 receiver 就是那句人话, 或 Dead Letter 退到群)。
      const channel = group || (served?.kind === "chat" ? served.channel : "");
      const late = router.isOrphaned(serves);
      // 迟到时收方的追述去向: served 行还在 (未回收)、没被收掉、owner 仍是收方 → 沿它的 receiver 原路;
      // 否则无处可冒, 只进 rolepage。
      const retellTo = late && servedRow && servedRow.owner === to && servedRow.outcome?.status !== "canceled"
        ? servedRow.receiver.kind === "wizard" ? displayName(servedRow.receiver.to) : chatNameOf(cfg, servedRow.receiver.channel) || servedRow.receiver.channel
        : undefined;
      const inbox = `rcpt:${event}:${out.rev}`;
      const job = row.job ? jobs.get(row.job) : undefined;
      const tally = row.job ? jobs.tally(row.job) : undefined;
      events.accept({
        id: inbox, identity: JSON.stringify([to, event, out.status, out.rev]),
        target: to, speaker: row.owner, channel, serves,
        ...(row.asker ? { asker: row.asker } : {}),
        priority: "normal", deadline: Date.now() + 12 * 3600_000,
        // 行首 RESULT:/NEED: 只是判定记号, 语义已由信封的 status 携带 —— 投递时剥掉
        // (ARTIFACT 行保留: 路径对收方 wizard 有实际用途)。
        payload: { text: clipMiddle(stripClosingMark(out.body)), peer: {
          // 回执不是一件新活: `job` 留空 (否则 jobs.account 会把它当成工单的第二份派活数一遍)。
          from: { kind: "peer", from: row.owner, receipt: true, status: out.status, event },
          job: "", kind: "fyi",
          envelope: renderReceiptEnvelope(
            displayName(row.owner),
            channel ? chatNameOf(cfg, channel) : undefined,
            row.job ? { job: row.job, done: tally?.done ?? 0, total: tally?.total ?? 0, closed: job?.status !== "open", ...(job?.kind === "req" ? { req: true } : {}) } : undefined,
            out.status,
            event,
            { ...(row.asker ? { asker: row.asker } : {}),
              ...(served?.kind === "wizard" ? { up: true } : {}),
              ...(audienceName(channel, row.asker) ? { audience: audienceName(channel, row.asker) } : {}),
              ...(via.length ? { via: via.join(", ") } : {}),
              ...(late ? { late: true } : {}),
              ...(retellTo ? { retellTo } : {}),
              ...(row.late ? { retold: true } : {}) },
          ),
        } },
      });
      router.commit(ops.hand({ event, inbox }));
    };
    /** 一条路由 op: 先落盘, 再投该投的 (need / error 带正文入箱; answer 按 receiver 投递)。这里
     *  只管 `re` (`mark open`) 把那一行拉回在飞 —— 账本与工单跟着 deliverRoute 走。 */
    const commitRoute = (op: Op): void => {
      router.commit(op);
      if (op.op === "mark") {
        const by = ledgerOwnerOf(op.event);
        if (by && op.status === "open") ledger.touch(by, op.event);
        if ((op.status === "need" || op.status === "error") && op.body !== undefined && op.rev !== undefined)
          deliverRoute(op.event, { status: op.status, body: op.body, rev: op.rev });
        return;
      }
      if (op.op === "answer") deliverRoute(op.event, op.outcome);
    };
    /** 终句 → 路由 op (§9.4): 一轮结束时把这一笔推进 (定论 / 中途态), 投递在 commitRoute 里做。
     *  工单的**验收打回**也在这一层: 交的活不合规格就不落定论 (need / error 先拉回 open), 以工单
     *  owner 的名义在同一笔上续问一次 —— `bounced` 记住那一笔, 同一笔最多打回一次 (reload 后
     *  也最多再多打回一次)。**这是「轮终 evidence → onFinal」那条主触发链的落点**: 没有它,
     *  answer 就只能靠 sweeper / 级联取消 / boot 重放合成, 谁答完都不会有回执。 */
    deliverFinal = (e, verdict) => {
      // 同一轮的终句会递进来两次: result() 当场递一次, 泵见 complete 未 finalized 再补判一次
      // (message-events)。被打回那一轮的重放不是补交 —— 丢掉; 否则 bounced 已记着这一笔,
      // 第二次就把被打回的原文照收成 done (打回的续问还没注入, 定论先落了)。
      if (e.serves && bounced.get(e.serves) === e.id) return;
      const plans = router.onFinal(e.target, e.serves, verdict);
      const answer = plans.flatMap((op) => (op.op === "answer" && op.outcome.status === "done" ? [op] : []))[0];
      const row = answer ? router.get(answer.event) : undefined;
      const why = answer && row ? acceptanceOf(row, answer.outcome.body) : undefined;
      if (row && why) {
        if (row.status === "need" || row.status === "error") commitRoute(ops.mark({ event: row.event, status: "open" }));
        rebound(row, why, e.id);
        return;
      }
      plans.forEach(commitRoute);
    };
    // ── 新路由表 (T6): 失败级联 ─────────────────────────────────────────────
    /** `target` 欠着的行里这一轮该被收掉的根 (§4.2): 不给 `only` = 全部 (end / close_job);
     *  给了 = 认它欠着的那一笔 (派它的那一方 = 行的 receiver, 那一笔 = event)。 */
    const cancelRoots = (target: string, only?: (x: { from: string; event: string }) => boolean): EventId[] =>
      router.owedBy(target).filter((r) => !only || only({
        from: r.receiver.kind === "wizard" ? r.receiver.to : baseOfKey(r.receiver.channel),
        event: r.event,
      })).map((r) => r.event);
    /** 级联取消 (§4.2 TERMINATE): `subtree` 全部 canceled, 叶子先落; 发起者就是 receiver 的那份
     *  不投 (它自己知道), 但行得落成墓碑 —— 不然一直挂在它的 owedBy 上。 */
    const cancelRoutes = (roots: readonly EventId[], reason: (r: Route) => string, by: string): number => {
      const plans = cancelOps(router.table(), roots, { reason, nameOf: displayName, lastWords: m.lastReply });
      for (const op of plans) {
        router.commit(op);
        if (op.op !== "answer") continue;
        const row = router.get(op.event);
        if (row?.receiver.kind === "wizard" && row.receiver.to === by) {
          router.commit(ops.hand({ event: op.event, inbox: `canceled:${op.event}:${op.outcome.rev}` }));
          continue;
        }
        deliverRoute(op.event, op.outcome);
      }
      return plans.length;
    };
    /** §9.5 boot: fold 之后把表上没有落定的收一收 ——
     *   - `answered` 未 `hand`: 定论在盘上却没进过 receiver 的收件箱 → 重投一次 (replayAnswered)。
     *   - `held`: 前置 (`after`) 重查一次。有一笔是失败 → 这件永远轮不到 (§4.2), 带前置快照整件
     *     取消; 全落定 → release。两道都幂等, 与在途注入的 committed 撞上无害。
     *   - `open` / `need` / `error`: 不动 —— 在途注入的 result 由 message-events resume 送回 onFinal。 */
    const settleHeld = (): void => {
      router.rows().filter((r) => r.status === "held").forEach((r) => {
        const prereqs = (r.after ?? []).map((e) => router.get(e));
        const failed = prereqs.find((a) => a?.outcome && a.outcome.status !== "done");
        if (failed?.outcome) {
          commitRoute(ops.answer({ event: r.event, outcome: makeOutcome("canceled",
            `前置回执 (${failed.event}) 是 ${failed.outcome.status}, 这一件不会轮到了 —— 已取消, 没有投给它。` ) }));
          return;
        }
        if (prereqs.every((a) => a?.outcome?.status === "done")) {
          commitRoute(ops.release({ event: r.event }));
          releaseHeld(r);
        }
      });
    };
    /** §3.5 放行注入的接入点 (.rcptt1 设计「held 放行后要注入什么载荷」后填这里):
     *  前置全落定的那一笔已经从 held 变 open, 但**没有人把它的活投出去** —— 旧机制的注入在
     *  回执槽的 release dep 里, 随 receipts 一起退役了。载荷 (要说什么 / 怎么收口) 还没定,
     *  先留这个调用位。 */
    const releaseHeld = (_row: Route): void => {};
    /** §4.5 boot: fold 之后 `answered` 还没 `hand` 的行重投一次 —— rcpt 的 id 幂等, 重放不双投。 */
    const replayAnswered = (): void => router.rows()
      .filter((r) => r.status === "answered" && r.outcome !== undefined)
      .forEach((r) => deliverRoute(r.event, r.outcome!));
    const currentAsk = (target: string): ((x: { from: string; event: string }) => boolean) => {
      const env = openingAsk(target);
      if (!env) return () => false;
      return (x) => (env.event ? x.event === env.event : displayName(x.from) === env.from);
    };
    /** 打断 `target` 会不会误伤别人的活: 它正忙, 且这一轮不是调用方派的 —— 别的 wizard 派的、
     *  人说的、定时任务放的 → 那一方的称呼。回执轮是它自己那件活的延续, 不算别人的。 */
    const othersTurn = async (target: string, self: string): Promise<{ from: string; event?: string } | undefined> => {
      if (await m.idleNow(target)) return undefined;
      const p = m.sessionInfo(target)?.jsonlPath;
      const env = p ? openingTurn(expandHome(p))?.env : undefined;
      if (env?.receipt) return undefined;
      if (env?.kind === "peer") return env.from === displayName(self) ? undefined : peerAsk(env);
      return { from: env?.kind === "task" ? env.from : env?.from ? `人 (${env.from})` : "人" };
    };
    const openingOfSelf = (self: string) => {
      const p = m.sessionInfo(self)?.jsonlPath;
      return p ? openingTurn(expandHome(p)) : undefined;
    };
    const controlSnapshot = (self: string) => ({ opening: openingOfSelf(self)?.ms });
    const controlValid = (self: string, snapshot: ReturnType<typeof controlSnapshot>): boolean =>
      openingOfSelf(self)?.ms === snapshot.opening;
    /** 名册 / peek / list_jobs / rolepage 的「在等 / 欠着」: 从路由表现算 (§9.5 读侧), 只借 pane
     *  的一次探针判「停在审批卡上」。收给群的那种根行不进这一份 —— 它与任何 wizard 之间没有
     *  「谁欠谁」的边 (旧的 receipts.states() 里也从来没有它们); 定了论的 (answered / handed)
     *  同样不进: 这一份问的是「还在飞 / 还欠着」。`turn` 那一栏放的是 event id (§9.1),
     *  下游只当字符串展示。 */
    const routeInFlight = (): InFlight[] => {
      const probed = new Map<string, boolean>();
      const parked = (t: string): boolean => {
        const hit = probed.get(t);
        if (hit !== undefined) return hit;
        probed.set(t, m.parkedNow(t));
        return probed.get(t)!;
      };
      return router.rows().flatMap((r) =>
        r.receiver.kind !== "wizard" || r.status === "handed" || r.status === "answered" ? []
          : [{
              from: r.receiver.to, to: r.owner, turn: r.event, job: r.job ?? "",
              state: turnState({ status: r.status, waiting: router.waiting(r.event).length > 0 },
                { parked: r.status === "open" && parked(r.owner) }),
              ageMs: Date.now() - r.at,
            } as InFlight]);
    };
    /** `self` 此刻这一轮的链头 (见 Asker), 同样认开头那句的信封: 人在群里说的 → 信封上的
     *  userid 与群; 与人的单聊里没挂信封 → 那个人; 同伴派的活 / 回执 → 登记那件活时记下的;
     *  定时任务、CLI 敲字、认不出 → undefined (如实不知道, 不猜)。 */
    const askerOf = (self: string): Asker | undefined => {
      const env = openingOfSelf(self)?.env;
      const home = baseOfKey(self);
      if (!env) return m.currentAsker(self);
      return askerFromEnvelope(env, (chat) => chat ? chatBaseOf(cfg, chat) : home);
    };
    // A private dispatch keeps its human origin even though its output channel is empty.
    bindCardChannel((key) => askerOf(key)?.chat || m.currentChannel(key));
    // 交接先续做: 它的闸要在回执续守之前立起来, 否则续守的 watcher 会读到换了一半的会话。
    void m.restored.then(() => {
      handoffs.resume();
      // Confirmed injections may outlive the legacy receipt-store write. Rebuild watching,
      // using the original turn and intent; uncertain injections remain manual reconciliation.
      workflow.all().filter((a) => a.tell && ["running", "needs-input", "errored"].includes(a.execution))
        .forEach((a) => { try { recoverWorkflow(a); } catch (e) { log.error({ err: (e as Error).message, attemptId: a.id }, "workflow recovery accounting failed; watcher not restored"); } });
    });
    // 闲置追问 (见 idle-nudge.ts): 对方持续闲着又没交回结论 → 代发话方在同一笔上问一句进展,
    // 它的答复照常作为那一笔的定论回来 (续问不新开行)。
    void m.restored.then(() => startIdleNudge({
      inflight: () => routeInFlight(),
      idleNow: m.idleNow,
      handingOff,
      jobOpen: (id) => jobs.get(id)?.status === "open",
      policy: () => ({ afterMs: cfg.wrc.mirror.idleNudge.afterMin * 60_000, max: cfg.wrc.mirror.idleNudge.max }),
      ask: async ({ from, to, turn, text }) => {
        if (workflow.byTurn(from, turn) || !planStore.allowExternal(to, wizards.get(to)?.name)) return false;
        const row = router.get(turn);
        if (!row) return false;
        return acceptContinuation({ from, to, channel: "", event: turn, deadlineAt: row.deadlineAt,
          ...(row.asker ? { asker: row.asker } : {}), ...(row.job ? { job: row.job } : {}) }, text);
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
      if (!planStore.allowExternal(undefined, name)) return false;
      const gone = await evictStaleName(wizards, name, keep, { lastActivity: m.lastActivity, retire: async (target) => {
        if (!planStore.allowExternal(target, wizards.get(target)?.name)) throw new Error("workflow plan reserves this identity; eviction withheld");
        return m.killPane(target);
      } });
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
      allowed: (target?: string, name?: string) => boolean = (target, name) => planStore.allowExternal(target, name) && planStore.allowExternal(target, target ? wizards.get(target)?.name : undefined),
    ): Promise<{ ok: true; target: string; slot: string } | { ok: false; status: number; body: Record<string, unknown> }> => {
      const asked = normalizeTag(want);
      const denied = { ok: false as const, status: 409, body: { ok: false, reason: "workflow plan reserves this executor" } };
      const candidate = asked || normalizeTag(fallback) || "wizard";
      if (!allowed(keyOf(base, candidate), candidate)) return denied;
      const clash = asked ? wizards.byName(asked) : undefined;
      // 名字全机唯一, 撞上别的机器人的 wizard 照样拒 —— 但不顶掉它、不复用它的槽, 也不报它的死活:
      // 那边的 wizard 在这个机器人眼里不存在, 只剩「名字被占了」这一个事实。
      if (clash && !sameBot(base, clash.target)) {
        return { ok: false, status: 409, body: { ok: false, reason: `名字 '.${clash.name}' 已被占用 (名字全局唯一) —— 换个名字`, name: clash.name } };
      }
      if (clash && !allowed(clash.target, clash.name)) return denied;
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
      if (!allowed(keyOf(base, candidate), candidate) || (clash && !allowed(clash.target, clash.name))) return denied;
      const taken = new Set([
        ...m.chatTargets(base).map(tagOfKey),
        ...wizards.all().filter((w) => baseOfKey(w.target) === base).map((w) => tagOfKey(w.target)),
      ].filter(Boolean));
      const slot = uniqueTag(asked || normalizeTag(fallback) || "wizard", taken);
      const target = keyOf(base, slot);
      return allowed(target, asked || slot) ? { ok: true, target, slot } : denied;
    };

    // ── 给人看的消息 ──────────────────────────────────────────────────
    // send_peer 把话塞进另一个 agent 的输入框 (驱动它干活); 这条把话贴进一个聊天
    // 给**人**看。收件人就是地址 —— 聊天名或裸 principal, 没有「先订阅才收得到」
    // 这一步。头沿用 relay 那一套: 本群退化成寻常的 `emoji #tag`, 外群写成带聊天
    // 名的全称, 于是那边的人一眼看得出是谁、从哪个群说过来的。
    // 顶层模式: 只有顶层 wizard 对人说话。拦的是「这一轮在为同伴干活」的: 同伴私聊派来的活, 或
    // 回执轮但那件活是为上游同伴派的 (k 是 peer)。人说的、定时任务放的、旁支 (chain:false, 无 k)
    // 的回执轮都不拦; 管家只在自己的群里豁免。notify 与 send_file 共用这一道闸。
    // 顶层模式: 只有顶层 wizard 对人说话。「这一轮在为同伴干活」的唯一判据 = 它服务的那一笔
    // 的定论收给谁 (§9.5): 收给同伴的 wizard = 它在链条下面, 不对人说话; 收给群的 = 它自己
    // 就是对人收口的那一层。transfer 出去的那一笔行已 move 给别人, 收方仍是同伴 → 照样拦。
    // 没有行 (CLI 直接敲的轮 / 定时任务) = 不在为谁干活, 不拦。管家只在自己的群里豁免。
    // notify 与 send_file 共用这一道闸。
    const topOnlyMuted = (self: string, dests: readonly string[]): Record<string, unknown> | undefined => {
      const serves = servesOfTurn(self);
      const belowTop = !!serves && !router.speaksToHuman(serves);
      const muted = dests.filter((d) => chatPolicyOf(cfg, d).topOnly && !(!tagOfKey(self) && baseOfKey(self) === d));
      return muted.length && belowTop
        ? { ok: false, topOnly: true, reason: `${muted.map((d) => chatNameOf(cfg, d) || d).join(", ")} 开着顶层模式: 你这一轮是同伴派来的活, 不对人说话 —— 要说的写进终句 (\`RESULT:\` / \`NEED:\`), 由派你的那个代你向人交代` }
        : undefined;
    };
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
      const bad = refs.filter((r) => ((b) => !b || !sameBot(self, b))(chatBaseOf(cfg, r)));
      if (bad.length) {
        json(res, 400, { ok: false, reason: `认不出这些聊天: ${bad.join(", ")} (wizard_roster 每行有 home 聊天名, 人侧 /chats; 没起名的聊天寻址不到)` });
        return;
      }
      const dests = [...new Set(refs.length ? refs.map((r) => chatBaseOf(cfg, r)) : [channelOf(self)])];
      const muted = topOnlyMuted(self, dests);
      if (muted) { json(res, 409, muted); return; }
      const asker = askerOf(self);
      for (const dest of dests) {
        postAs(self, dest, content);
        recordPost({ target: self, channel: dest, body: content, ...(asker ? { asker } : {}) });
      }
      // 微信群聊: 人超过 ctxTtlSec 没说话时微信会静默丢弃, 消息只能压着等他下次开口 —— 如实告诉调用方, 别回「已发送」。
      const wxId = (d: string): string => baseOfKey(d).replace(/^chat:/, "");
      const held = dests.filter((d) => wx.owns(wxId(d)) && !wx.fresh(wxId(d)));
      const name = (d: string): string => chatNameOf(cfg, d) || d;
      json(res, 200, {
        ok: true,
        sent: dests.filter((d) => !held.includes(d)).map(name),
        ...(held.length ? { held: held.map(name), note: `微信群聊 ${held.map(name).join("、")} 那头超过 ${cfg.weixin.ctxTtlSec}s 没说话: 微信会静默丢弃主动推送, 这条已压着, 对方下次在微信里开口时送达 (定时提醒做不到准点)` } : {}),
      });
    });

    // ── 给人看的文件 / 图片 ────────────────────────────────────────────
    // notify 的媒体版: 去向、认名字、顶层模式闸都与它同一套; 投递交给 sendMedia (通道无关,
    // 按 principal 分到 aibot / 微信)。caption 先成一条带头的气泡, 让群里知道是谁发的。
    http.register("POST /send_file", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { path?: string; kind?: MediaKind; to?: string; caption?: string; title?: string; description?: string };
      const path = expandHome((b.path ?? "").trim());
      if (!path) { json(res, 400, { ok: false, reason: "path required" }); return; }
      ensureChatNames(self);
      const ref = (b.to ?? "").trim();
      const dest = ref ? chatBaseOf(cfg, ref) : channelOf(self);
      if (!dest || !sameBot(self, dest)) { json(res, 400, { ok: false, reason: `认不出聊天: ${ref} (wizard_roster 每行有 home 聊天名, 人侧 /chats; 没起名的聊天寻址不到)` }); return; }
      const muted = topOnlyMuted(self, [dest]);
      if (muted) { json(res, 409, muted); return; }
      const plan = media.plan(dest, { path, ...(b.kind ? { kind: b.kind } : {}) });
      if (!plan.ok) { json(res, 400, plan); return; }
      const caption = (b.caption ?? "").trim();
      if (caption) postAs(self, dest, caption);
      const r = await sendMedia(dest, { path, kind: plan.kind, ...(b.title ? { title: b.title } : {}), ...(b.description ? { description: b.description } : {}) });
      if (!r.ok) { json(res, 502, r); return; }
      const asker = askerOf(self);
      recordPost({ target: self, channel: dest, body: [caption, `📎 ${r.name} (${r.kind}) · ${path}`].filter(Boolean).join("\n\n"), ...(asker ? { asker } : {}) });
      json(res, 200, { ok: true, sent: chatNameOf(cfg, dest) || dest, kind: r.kind, name: r.name, bytes: r.bytes });
    });

    http.register("POST /peers/peek", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const r = resolvePeer(self, addrOf(body));
      if (!r.ok) { json(res, r.status, { ok: false, reason: r.reason, candidates: r.candidates }); return; }
      const { target, foreign } = r;
      const turns = Math.min(Math.max(Number((body as { turns?: number }).turns ?? 6) || 6, 1), 40);
      // 对话只从 transcript 读 (正文轮次), 不刮终端: pane 是
      // 截断的视口加一层 TUI 装饰, 而「它卡在哪」transcript 答得更准 —— 不在转圈
      // 却悬着工具调用, 就是停在审批卡 / 本地弹窗上等人点。
      const peek = await m.peekTurns(target, turns);
      const inflight = turnsLine(routeInFlight(), target);
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
      // 别的机器人的聊天与认不出同形 (不说它在)。
      if (chatRef && (!base || !sameBot(self, base))) { json(res, 404, { ok: false, reason: `认不出聊天 '${chatRef}' (wizard_roster 每行有 home 聊天名, 人侧 /chats)` }); return; }
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
      // 只读与调用方同机器人的会话 —— 别的机器人那边的往来连条数都不该露出来。
      const all = m.transcripts().filter((t) => sameBot(self, t.target));
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
    // (与 route_candidates 同一口径)。transcript 里没有分层写入记录时按 5min 兜底。
    const CACHE_TTL_FALLBACK_SEC = 300;
    const touchOf = (p: string): number => { try { return cacheTouchMs(p) || statSync(p).mtimeMs; } catch { return 0; } };
    const ttlOf = (p: string): number => (cacheTtlSec(p) || CACHE_TTL_FALLBACK_SEC) * 1000;
    // 被冷门控退回过的 `self\0target` → 到期时刻: 老 MCP 进程原样重发即视为 force。
    const coldRefused = new Map<string, number>();
    type Reply = { status: number; body: Record<string, unknown> };
    /** 入参 `after` → event 数组: 每项是名字 (= 我派给它的那一笔, 见 pickPair) 或 event id。 */
    const afterTurnsOf = (self: string, body: PeerBody): { ok: true; ids: string[] } | { ok: false; reason: string } => {
      const raw = (body as { after?: unknown }).after;
      const picked = [...new Set((Array.isArray(raw) ? raw : []).map((x) => String(x).trim()).filter(Boolean))].map((x): { id: string } | { bad: string } => {
        const id = eventRef(x);
        if (isEventRef(id)) return { id };
        const who = resolvePeer(self, x);
        if (!who.ok) return { bad: `${x}: ${who.reason}` };
        const p = pickPair(router.table(), self, who.target);
        if (!p.ok) return { bad: `${x} 手上有你 ${p.many.length} 笔没落定 (${p.many.map((r) => r.event).join(" ")}), 用 event id 指明` };
        return p.row ? { id: p.row.event } : { bad: `你没派过活给 ${x}` };
      });
      const bad = picked.flatMap((p) => ("bad" in p ? [p.bad] : []));
      return bad.length ? { ok: false, reason: `after 认不出: ${bad.join("; ")}` } : { ok: true, ids: [...new Set(picked.flatMap((p) => ("id" in p ? [p.id] : [])))] };
    };
    /** 放行时挂在信封后面的前置结论: 谁交的、件号、RESULT 与 ARTIFACT 原样 (只进对方输入框)。 */
    const afterNote = (turns: readonly string[], seen: Readonly<Record<string, HeldSeen>>, owner: string): string =>
      renderReminder({ wezard: "after" }, [
        "这件活排在下面这些前置之后, 它们都已落定; 结论原样附上 (谁交的):",
        ...turns.flatMap((t) => {
          const x = seen[t];
          if (!x) return [];
          const c = parseClosing(x.body, 1500);
          const versions = workflow.list(owner).find((a) => a.turn === t && a.acceptance === "accepted")?.files ?? [];
          const clean = (v: string): string => v.replace(/<\/?system-reminder[^>]*>/g, "");
          return [
            `- ${displayName(x.to)} · ${x.status}: ${c.kind === "result" ? `RESULT: ${clean(c.text)}` : clipLine(clean(x.body), 600) || "(没有正文)"}`,
            ...c.artifacts.map((a) => {
              const f = versions.find((f) => f.path === a.path);
              return f ? `  ARTIFACT: ${f.snapshot} — accepted version sha256 ${f.sha256}; original source ${f.path}` : `  ARTIFACT: ${a.path}${a.note ? ` — ${a.note}` : ""}`;
            }),
            ...versions.map((f) => `  VERIFIED ARTIFACT VERSION: ${f.snapshot} · sha256 ${f.sha256} · source ${f.path}; consume this readonly snapshot, not mutable source`),
          ];
        }),
      ]);
    // One durable key per tracked physical dispatch leg (held release reuses its reservation).
    const accountWorkflow = (a: NodeAttempt, recovery = false): void => {
      if (!a.dispatches?.length) throw new Error("historical tracked attempt lacks dispatch accounting evidence; reconcile stopped before retry (no blind budget import)");
      for (const d of a.dispatches!) {
        jobs.account(a.job, d.key, { target: a.to, task: d.continuation ? "" : d.text, spawned: false, turn: (d.tell ?? a.tell)?.event, ...(d.role ? { role: d.role } : {}) }, d.kind, d.free, recovery, !!d.free && !!d.continuation);
        const t = d.tell ?? a.tell;
        const ev = a.turn;
        const rec = receiverOfEvent(ev);
        ledger.dispatch(d.key, { event: ev, turn: a.turn, owner: a.owner, to: a.to, text: d.text, at: d.at, job: a.job, ...(rec ? { receiver: rec } : {}), ...(t?.asker ? { asker: t.asker } : {}) });
      }
    };
    const recoverWorkflow = (a: NodeAttempt): void => {
      if (a.canceled || jobs.get(a.job)?.status !== "open") return;
      accountWorkflow(a, true);
    };
    const cancelPeerWork = (target: string, self: string, only?: (x: { from: string; event: string }) => boolean): number => {
      const hit = only ?? ((): boolean => true);
      const keys = new Set(
        workflow.all().filter((a) => a.to === target && a.execution !== "terminal" && !a.canceled && hit({ from: a.owner, event: a.turn })).map((a) => `${a.owner}\0${a.turn}`),
      );
      // T6: 路由表上的同一批 (§4.2) —— subtree 级联 canceled, 定论走路由表。
      cancelRoutes(cancelRoots(target, only), (r) => `被 ${displayName(self)} 收掉 / 打断了, 这件活没有结论。`, self);
      events.cancel((e) => e.target === target && !!e.payload.peer && hit({ from: e.speaker, event: e.payload.peer.from.event ?? "" }));
      workflow.cancel(target, undefined, undefined, undefined, only);
      return keys.size;
    };
    /** 逐笔看前置此刻是什么 (§3.4): 都是发话方自己派出去的那几笔 (receiver 指回自己) ——
     *  表上查不到 / 不是自己派的那件 = unknown (过期或写错)。 */
    const prereqsOf = (self: string, turns: readonly string[]): Prereq[] => turns.map((t) => {
      const r = router.get(t);
      if (!r || r.receiver.kind !== "wizard" || r.receiver.to !== self) return { state: "unknown" };
      if (r.outcome?.status === "done") return { state: "done", seen: { to: r.owner, status: "done", body: r.outcome.body } };
      if (r.outcome) return { state: "failed", seen: { to: r.owner, status: r.outcome.status, body: r.outcome.body } };
      return { state: "pending" };
    });
    /** 一笔前置落定后的结论快照 (放行时附在信封后面)。 */
    const seenOf = (t: string): HeldSeen | undefined => {
      const r = router.get(t);
      return r?.outcome ? { to: r.owner, status: r.outcome.status, body: r.outcome.body } : undefined;
    };
    peerEvents = {
      valid: (e) => {
        const p = e.payload.peer!;
        const attempt = p.attemptId ? workflow.byTurn(e.speaker, p.from.event ?? "") : undefined;
        return planStore.healthy() && !e.canceled && (!p.from.receipt || planContinuationAllowed(e.target)) && (!p.job || jobs.get(p.job)?.status === "open") && !attempt?.canceled
          && (!p.after?.length || prereqsOf(e.speaker, p.after).every((r) => r.state === "done" || r.state === "pending"))
      },
      accepted: (e) => {
        if (e.execution !== "queued") return;
        const p = e.payload.peer!;
        // 旧 watcher 的 continuation 代数已退役 (§9.4): 收口由事件自己的 serves 决定。
        if (p.attemptId) accountWorkflow(workflow.byTurn(e.speaker, p.from.event ?? "")!);
        else if (p.job && !p.held) jobs.account(p.job, e.id, { target: e.target, turn: p.from.event, task: (p.tell?.legs ?? 1) > 1 ? "" : e.payload.text, spawned: !!p.spawned, ...(p.role ? { role: p.role } : {}) }, p.kind === "ask" ? "ask" : "task", !!p.free || !!p.held, false, !!p.free);
        // transfer 出去的 / 转给接手方的那不是发话方自己在等的一件: 不进它的挂起账。
        // 账本的键是这一笔的 event (§9.5: 表里已经有那一行了, 账只是投影)。
        if (p.tell && !p.attemptId && !p.relayed && !p.transferred) {
          const ev = e.serves || p.tell.event || "";
          const rec = receiverOfEvent(ev);
          ledger.dispatch(e.id, { event: ev, owner: e.speaker, to: e.target, text: e.payload.text, at: e.at, ...(p.job ? { job: p.job } : {}), ...(rec ? { receiver: rec } : {}), ...(e.asker ? { asker: e.asker } : {}) });
        }
      },
      committed: (e) => {
        const p = e.payload.peer!;
        // 停放放行 (T3): 挂 `after` 的那一行先 held (前置没落定, 还没投给 owner), 注入成功这一刻
        // release —— 行状态是这一笔要不要投的唯一记号 (§9.5)。
        if (p.after?.length && e.serves) router.commit(ops.release({ event: e.serves }));
        if (p.attemptId) {
          const a = workflow.byTurn(e.speaker, p.from.event ?? "");
          if (a?.execution === "dispatch-unknown" && !a.canceled && !a.status && e.exposure === "consumed")
            workflow.verdict(e.speaker, p.attemptId, "sent", undefined, `transcript confirms message event ${e.id}`);
          else workflow.dispatched(p.attemptId, true);
        }
      },
      canceled: (e) => {
        const p = e.payload.peer!;
        if (p.attemptId) workflow.cancel(e.target, e.speaker, p.job, p.from.event);
      },
      ready: async (e) => prereqsOf(e.speaker, e.payload.peer!.after ?? []).every((r) => r.state === "done")
        && (e.priority === "now" || await m.idleNow(e.target) || !(await m.paneLive(e.target)) || (e.priority === "urgent" && !(await othersTurn(e.target, e.speaker)))),
      inject: async (e, boundary) => {
        const p = e.payload.peer!;
        if (e.priority === "urgent" && !(await m.idleNow(e.target))) {
          if (await othersTurn(e.target, e.speaker)) return { ok: false, retryable: true, reason: "urgent target now belongs to another actor" };
          const path = m.sessionInfo(e.target)?.jsonlPath;
          const opening = path ? openingTurn(expandHome(path))?.ms : undefined;
          const r = await m.interruptPane(e.target, { guard: () => peerEvents!.valid(e)
            && m.sessionInfo(e.target)?.jsonlPath === path && (!path || openingTurn(expandHome(path))?.ms === opening) });
          if (!r.ok) return { ok: false, retryable: true, reason: r.reason };
        }
        if (p.attemptId && p.tell) workflow.intent(p.attemptId, p.tell);
        const raw = await m.injectText(e.target, e.payload.text, undefined, {
          from: p.from, channel: e.channel, requireIdle: e.priority === "normal",
          envelope: withMsg(p.envelope + (p.after?.length ? afterNote(p.after, Object.fromEntries(p.after.flatMap((t) => { const x = seenOf(t); return x ? [[t, x] as const] : []; })), e.speaker) : ""), e.id),
          guard: (phase, identity) => peerEvents!.valid(e) && prereqsOf(e.speaker, p.after ?? []).every((r) => r.state === "done") && (!phase || ((!p.attemptId || workflow.boundary(p.attemptId)) && boundary(phase, identity))),
          eventId: e.id,
        });
        const r = !raw.ok && !raw.uncertain && !raw.retryable && events.get(e.id)?.exposure === "none" ? { ...raw, retryable: true } : raw;
        if (p.attemptId && (r.uncertain || (!r.ok && !r.retryable))) workflow.dispatched(p.attemptId, false);
        return r;
      },
    };
    // T4: final 放行只读路由表 (§9.5) —— 这一轮服务的那一笔不再挂着未落定的子行 (`waiting`),
    // 且行不在 held (前置没落定就还没轮到它)。旧的四重推断全由这一条取代。
    // 没有行 (老事件 / 不带 serves 的注入) → 照旧放行。
    // 已落定的那一笔只放追述 (§4.3): 判据与 onFinal 的 retellOps 同源 (router.finalReleased)。
    // 调用方可能拿着 result 落定前的快照, 正文按事件库现读。
    m.setEventFinalGate((e) => {
      if (e.canceled || e.interjected) return false;
      return router.finalReleased(e.target, e.serves, (events.get(e.id) ?? e).result?.body ?? "");
    });
    // boot 的路由表侧恢复 (T8): held 重查前置、answered 重投一次; 二者幂等, 与 events.resume
    // 重放的注入/回执撞上无害。
    void m.restored.then(() => { events.resume(); settleHeld(); replayAnswered(); });
    // ── 新路由表 (T6): 失败合成 (§4.2) ──────────────────────────────────────
    // timeout / silent / dead 是 daemon 合成的定论, 与 done 走同一条投递通路 —— 模型只会
    // 没声, 它不报失败。与 receipts 的 watcher 并行: 那边照旧算账 (T4 起不投递), 定论只由
    // 这里投。held 的前置失败也在这里收口。
    const SWEEP_MS = 15_000;
    const sweepOnce = async (): Promise<number> => {
      if (!events.running()) return 0;
      // 「停下没答几次」= 服务这一笔、已经 finished 却没有 result 的注入事件数 (§9.4): 收件箱
      // 自己就是计数器, 不另落一份。一次 tick 扫一遍收件箱就够 (这一轮不会再产新事件)。
      const fruitless = new Map<EventId, number>();
      events.status().events.forEach((e) => {
        if (!e.serves || e.result || e.canceled || e.execution !== "complete") return;
        fruitless.set(e.serves, (fruitless.get(e.serves) ?? 0) + 1);
      });
      // 前置刚被这一轮判失败时, 挂它的 held 行要下一轮才看得到 —— 多跑几轮直到不再出新 op。
      let n = 0;
      for (let round = 0; round < 4; round++) {
        const plans = await router.sweep({
          paneLive: m.paneLive, lastWords: m.lastReply, nameOf: displayName, handingOff,
          fruitless: (event) => fruitless.get(event) ?? 0,
        });
        if (!plans.length) break;
        plans.forEach(commitRoute);
        n += plans.length;
      }
      return n;
    };
    void m.restored.then(() => {
      const t = setInterval(() => { void sweepOnce().catch((e) => log.warn({ err: errText(e) }, "failure sweep failed")); }, SWEEP_MS);
      t.unref?.();
      stopSweep = () => clearInterval(t);
      // 起手先扫一遍: reload 前就已经超时的那些不该再等一个周期。
      void sweepOnce().catch(() => 0);
    });
    /** tell_peer 的本体: 以 `self` 的名义说一句 —— HTTP 路由与 dispatch 共用。`extra` = 挂在信封后面的
     *  一段 (只进对方输入框, 不进 `text`: 公开时 text 会成群气泡)。 */
    const peerDispatching = new Map<string, { count: number; transfer: boolean }>();
    /** transfer 的前置 (§3.4): 拒的理由; 放行 = undefined。 */
    const transferRefusal = (self: string, f: EventId | undefined, target: string | undefined, x: { job?: string; re?: boolean; node?: boolean; after?: boolean; frozen?: boolean }): string | undefined => {
      if (x.frozen || x.re || x.job || x.node || x.after) return "transfer 不能与 job / re / node / after 并用: 交出了这一笔就没人收工单, 也没有可续的原件";
      const row = f ? router.get(f) : undefined;
      if (!row) return "没有可交出的那一笔";
      if (row.owner !== self) return "这一笔已经不在你手上了 —— 一笔只能交出一次";
      if (row.status === "answered" || row.status === "handed") return `这一笔 (${row.event}) 已不在等你交代, 没有可交出的`;
      if (router.waiting(row.event).some((r) => r.receiver.kind === "wizard" && r.receiver.to === self))
        return "你在这一笔之下还有没落定的子活: 再交出去就说不清谁来交代 —— 等它们回来自己收口, 或别 transfer";
      if (target && router.awaitedBy(self).some((r) => r.owner === target))
        return `你已有一件活在 ${displayName(target)} 手上没落定 (同一对只有一个回执槽) —— 等它交差再 transfer`;
      return undefined;
    };
    const transferNote = (f: EventId, target: string): string =>
      `这一笔 (${f}) 已整件交给 ${displayName(target)}: 它的结论 (含 NEED / 失败) 直接回你服务的上游, 不回你 —— 本轮静默收口, 别再为这件派活或对人说话`;
    /** dispatch 在入口冻结的那一轮: 控制权快照、链头, 与回执去向 (planReturn 算好的)。 */
    type ActorOrigin = { authority: ReturnType<typeof controlSnapshot>; asker?: Asker; plan: { op: ReturnOp; serves?: EventId } };
    const tellPeerAsInner = async (self: string, body: PeerBody, extra = "", planned?: PlanPermit, actor?: ActorOrigin): Promise<Reply> => {
      const authority = actor?.authority ?? (!planned ? controlSnapshot(self) : undefined);
      const text = ((body as { text?: string }).text ?? "").toString();
      if (!text.trim()) { return { status: 400, body: { ok: false, reason: "text required" } }; }
      // 这句话要对方怎么接 (priority 管何时投, receipt 管要不要回执, 这个管它怎么接):
      // task 一件活 (默认) / ask 只答一问 / fyi 知会 —— fyi 不要回执、不进工单、不进群。
      const rawKind = (body as { kind?: string }).kind;
      const kind: "task" | "ask" | "fyi" = rawKind === "ask" || rawKind === "fyi" ? rawKind : "task";
      // `re` 的值是那一笔的**路由 event** (§9.5): 欠它的是谁由表说了算 —— transfer 之后 owner 已经
      // 换人, 按旧件号找反而会投给交出去的那位。表上没有 / 已落定 = 这句按新活发。
      // `re` 只是「续不续」这一位; 续哪一笔由表推断 (pickPair: 本轮在读的那份回执 → 这一对唯一在飞的 →
      // 最近一笔)。event id 照收: 老 MCP 进程、以及一对之间并发两笔时的兜底。省略 = 本轮是它的
      // NEED 回执、又对它说话才默认续 —— 答它的反问; 显式 `re:false` 推翻。
      const rawRe = (body as { re?: unknown }).re;
      const reFlag = rawRe === true || rawRe === "true" ? true : rawRe === false || rawRe === "false" ? false : undefined;
      const reId = reFlag === undefined && typeof rawRe === "string" ? eventRef(rawRe) : "";
      const idRow = reId ? router.get(reId) : undefined;
      const r = resolvePeer(self, addrOf(body) || (idRow ? displayName(idRow.owner) : ""));
      if (!r.ok) { return { status: r.status, body: { ok: false, reason: r.reason, candidates: r.candidates } }; }
      const { target } = r;
      const hint = planned || actor ? undefined : receiptOfTurn(self);
      const hintRow = hint ? router.get(hint) : undefined;
      const wantRe = !!reId || (reFlag ?? (kind !== "fyi" && hintRow?.status === "need" && hintRow.owner === target));
      const pick = wantRe && !reId ? pickPair(router.table(), self, target, hint) : undefined;
      if (pick && !pick.ok)
        return { status: 400, body: { ok: false, reason: `你在 ${displayName(target)} 手上有 ${pick.many.length} 笔没落定, 续哪一笔用 event id 指明 (re: "<event>"): ${pick.many.map((x) => `\`${x.event}\``).join(" ")}` } };
      const reRow = idRow ?? (pick?.ok ? pick.row : undefined);
      const re = reRow?.event ?? reId;
      const reTarget = reRow && ["open", "need", "error"].includes(reRow.status) ? reRow : undefined;
      // 续问必须点到现在欠着它的那位: 点错了收件的不是 owner, 它的终句就落不到那一笔上。
      if (reTarget && reTarget.owner !== target)
        return { status: 409, body: { ok: false, reason: `这一笔现在欠在 ${displayName(reTarget.owner)} 手上 —— 要续问就点名它 (re 按路由表走, 不再按旧件号找人)` } };
      const reUnknown = wantRe && !reTarget;
      const legs = reTarget ? legsOf(reTarget.event) + 1 : 1;
      // Capture the origin before waiting for another pane; our own turn may change meanwhile.
      const asker = planned ? planned.origin.asker : actor?.asker ?? (reTarget ? reTarget.asker : askerOf(self));
      // 回执去向 (§3.2): 冻结入口 (计划节点 / dispatch 入口冻结的那一轮) 原样沿用; 其余按
      // `return` / `for` 算 —— 选中的那一笔就是注入事件要服务的行。
      let plan: { op: ReturnOp; serves?: EventId };
      if (planned) plan = { op: "self", ...(planned.origin.event ? { serves: planned.origin.event } : {}) };
      else if (actor) plan = actor.plan;
      else {
        const p = planReturn(self, body as Record<string, unknown>, reTarget?.event);
        if (!p.ok) return { status: p.status, body: { ok: false, reason: p.reason } };
        plan = { op: p.op, ...(p.serves ? { serves: p.serves } : {}) };
      }
      // 同一对只有一个槽: 那一件还没落定 → 新的一件顶掉它 (工单预算照旧继承)。挂着子行的那份
      // 不算被顶掉 (它自己会按那一笔计数), 所以它不把工单过给新的一件。
      const open = router.awaitedBy(self).find((x) => x.owner === target);
      const isOpen = (id?: string): string => (id && jobs.get(id)?.status === "open" ? id : "");
      const askedJob = ((body as { job?: string }).job ?? "").trim();
      const leadJob = jobs.all().find((j) => j.kind === "req" && j.status === "open" && j.owner === self && j.members.some((x) => x.target === target && x.role === "lead"))?.id ?? "";
      const jobId = kind === "fyi" ? "" : askedJob || isOpen(reTarget?.job) || (open && router.waiting(open.event).length > 0 ? "" : isOpen(open?.job)) || (reUnknown ? isOpen(reRow?.job) || leadJob : "");
      /** 答它的反问不算新的一件 (不花预算、不数成员)。 */
      const freed = open?.status === "need";
      const actorStillValid = (): boolean => {
        if (!authority) return true; // planned work carries its captured permit.
        return openingOfSelf(self)?.ms === authority.opening;
      };
      if (jobId) {
        const jc = checkJob(jobId, target, freed);
        if (!jc.ok) { return { status: jc.status, body: { ok: false, reason: jc.reason } }; }
      }
      const trackedRe = re ? workflow.byTurn(self, re) : undefined;
      if (trackedRe && !trackedRe.accountingVersion && trackedRe.execution !== "terminal") return { status: 409, body: { ok: false, attemptId: trackedRe.id, reason: "historical tracked attempt lacks dispatch accounting evidence; reconcile stopped before retry" } };
      const rawNode = (body as { node?: string }).node;
      if (rawNode !== undefined && (typeof rawNode !== "string" || !rawNode.trim())) return { status: 400, body: { ok: false, reason: "node must not be blank" } };
      if (trackedRe && rawNode !== undefined && rawNode.trim() !== trackedRe.node) return { status: 409, body: { ok: false, reason: "tracked turn cannot change node" } };
      const node = rawNode?.trim() ?? trackedRe?.node ?? "";
      const planAllowed = (): boolean => planStore.allowTell(self, jobId, node, target, re, planned, wizards.get(target)?.name);
      if (!planAllowed()) return { status: 409, body: { ok: false, reason: "dedicated plan job/executor only allows runner dispatch or exact owner re" } };
      if (node && jobId && workflow.list(self, jobId).some((a) => !a.accountingVersion)) return { status: 409, body: { ok: false, reason: "historical job has incomplete dispatch accounting evidence; reconcile stopped, close the old job, and open a new job (no guessed budget migration)" } };
      if (node && (!jobId || jobs.get(jobId)?.owner !== self || kind !== "task" || plan.op === "none")) {
        return { status: 400, body: { ok: false, reason: "node requires owner job, task, and receipt" } };
      }
      if (re && trackedRe && (reUnknown || trackedRe.to !== target)) return { status: 409, body: { ok: false, reason: "tracked re cannot start a new attempt; use node after reconciliation" } };
      // A released hold can survive a crash after confirmed injection but before dropHold.
      // Recover the watcher from the durable intent; never paste that attempt again.
      const heldAttempt = planned && node ? workflow.byTurn(self, planned.turn) : undefined;
      if (heldAttempt?.tell && ["running", "needs-input", "errored"].includes(heldAttempt.execution)) {
        recoverWorkflow(heldAttempt);
        return { status: 200, body: { ok: true, recovered: true, attemptId: heldAttempt.id, event: planned!.turn } };
      }
      if (heldAttempt?.execution === "terminal" && heldAttempt.status === "done") return { status: 200, body: { ok: true, recovered: true, attemptId: heldAttempt.id } };
      // 派活方向闸 (见 direction.ts): 只拒不改投递路径。链读 `serves` 那条接收边 (本轮服务的那笔,
      // 或 `for` 显式选中的那笔) —— 本轮在服务的那位仍在等你, 不能借 for 反过来给它派活。
      const dr = checkDirection({ self, target, kind, re: !!reTarget, jobId, jobs: jobs.all(),
        ...chainNow(self, planned?.origin.event ?? plan.serves), nameOf: displayName });
      if (dr) { return { status: 409, body: { ok: false, gated: "direction", reason: dr } }; }
      // 依赖 (after): 前置必须是自己派出去的那几笔。查不到 → 400; 有失败的 → 409; 都 done → 照常投并附结论; 还有没落定的 → 停放 (先 held)。
      const afterIds = afterTurnsOf(self, body);
      if (!afterIds.ok) return { status: 400, body: { ok: false, reason: afterIds.reason } };
      const afters = afterIds.ids;
      const prereqs = afters.length ? prereqsOf(self, afters) : [];
      if (afters.length) {
        if (kind !== "task" || re) { return { status: 400, body: { ok: false, reason: "`after` 只用于派新活 (kind:\"task\"、不带 re)" } }; }
        const gone = afters.filter((_, i) => prereqs[i]!.state === "unknown");
        if (gone.length) { return { status: 400, body: { ok: false, reason: `after 里的 ${gone.join(" ")} 在你派出去的件里查不到 —— 只能依赖你自己开出来的那一笔 (event id; 过期 / 不是你派的都查不到)` } }; }
        const failed = afters.flatMap((t, i) => { const p = prereqs[i]!; return p.state === "failed" ? [`${t} (${displayName(p.seen.to)}) 以 ${p.seen.status} 收场`] : []; });
        if (failed.length) { return { status: 409, body: { ok: false, reason: `前置 ${failed.join("; ")} —— 这件不投; 前置失败了就先处理它, 再重发` } }; }
        if (open && !afters.includes(open.event)) { return { status: 409, body: { ok: false, reason: `你已有一件活 (${open.event}) 在 ${displayName(target)} 手上没落定, 同一对只有一个槽 —— 等它交差, 或把它也列进 after` } }; }
      }
      const transferNo = plan.op === "transfer" ? transferRefusal(self, plan.serves, target, { job: jobId, re: !!reTarget, node: !!node, after: afters.length > 0, frozen: !!planned }) : undefined;
      if (transferNo) return { status: 409, body: { ok: false, reason: transferNo } };

      // 公开与否由发话方 (LLM) 判断: 公开 = 在它这一轮的公开频道里说, 气泡进群、对方
      // 那一轮的回复也发进这个群; 私聊 (默认) = 只落双方的 rolepage, 回复靠 wait_peer 取。
      // 只有两端都是登记在册的 wizard 才能当着人说 —— 裸 target 冒充的发话方、forget 掉的
      // 分身不是谁, 它们的往来进群只会留下一段人找不到主的对话。工单里的派活一律私聊
      // (人看不懂 fan-out 的过程), 知会不进群, 顶层模式 (chatPolicy.topOnly) 也降为私聊。
      // 续问沿用原件那时的公开与否 (那一笔的 receiver 是那个群)。
      const reuseChannel = reTarget?.receiver.kind === "chat" ? reTarget.receiver.channel : undefined;
      const wantPublic = !jobId && kind !== "fyi" && plan.op !== "transfer"
        && (reTarget ? !!reuseChannel : (body as { public?: boolean }).public === true)
        && !!wizards.get(self) && !!wizards.get(target);
      const topOnly = wantPublic && chatPolicyOf(cfg, reuseChannel || channelOf(self)).topOnly;
      const isPublic = wantPublic && !topOnly;
      // transfer 交出的是人问的那一笔: 接手方的终句就是那句人话的答复, 注入事件得带上那个群 ——
      // chat 行只落 `hand`, 气泡靠 final 通道放行; 频道为空就被当私聊轮扣下, 人永远收不到。
      const handed = plan.op === "transfer" && plan.serves ? router.get(plan.serves)?.receiver : undefined;
      const handedChat = handed?.kind === "chat" ? handed.channel : "";
      const channel = isPublic ? reuseChannel || channelOf(self) : handedChat;
      // Injecting into your own pane would type into the box you're generating
      // from — Claude Code queues it and the caller deadlocks waiting for itself.
      if (target === self) { return { status: 400, body: { ok: false, reason: "refusing to inject into the calling session itself" } }; }
      if (!actorStillValid()) return { status: 409, body: { ok: false, reason: "caller turn/control changed while waiting; dispatch refused" } };
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
      // All caller-dependent facts are frozen here; workers never reread the caller's current turn.
      const at = Date.now();
      const deadlineAt = deadlineOf(at, (body as { deadline?: number }).deadline);
      const wantReceipt = plan.op !== "none";
      // 路由行 (§3.1): 续问不新开行 (沿用那一笔); 其余按 self / detach / transfer 开行或改 owner;
      // `after` 是欠账不是子行 —— 挂 after 的行先 held, 注入成功 (committed) 时才 release。
      const newRow = !reTarget;
      const serves = reTarget
        ? reTarget.event
        : openDispatchRow({ self, target, op: plan.op, deadlineAt, job: jobId, asker,
            ...(afters.length ? { after: afters } : {}), ...(plan.serves ? { serves: plan.serves } : {}) });
      /** 建完行才发现不该派 (计划许可 / 预算在等待期间变了): 把刚开的那一行收掉 —— 不然它一直
       *  挂在 owedBy 上, 名册里也永远「欠着」一件没人干的活。 */
      const dropRow = (): void => { if (newRow && serves) router.commit(ops.gc({ event: serves })); };
      // 注入事件的 id 就是对那一笔的引用 (§9.3): 派活 = `route:<event>`, 续问 = `route:<event>:r<legs>`;
      // 不开行 (none) 时没有行可指, 退回一句一号的合成 id。
      const eventId = serves ? `route:${serves}${legs > 1 ? `:r${legs}` : ""}` : `p:${self}:${target}:${at}:${legs}`;
      let attemptId: string | undefined;
      const beginNode = (queued: boolean): string | undefined => {
        if (!planAllowed() || (planned && !planned.alive())) throw new Error("plan dispatch canceled or job reserved");
        return node ? workflow.begin(self, jobId, node, planned ? planned.turn : serves, target, queued).id : undefined;
      };
      try { attemptId = beginNode(true); } catch (e) { dropRow(); return { status: 409, body: { ok: false, reason: (e as Error).message } }; }
      const canceledBeforeDispatch = (): boolean => !planAllowed() || (!!planned && !planned.alive()) || !!workflow.byTurn(self, planned ? planned.turn : serves)?.canceled || (!!jobId && jobs.get(jobId)?.status !== "open");
      // 「忙」= 这一轮还没结束, 或停在审批上等人 —— 都不是能接新活的时候。
      const wasBusy = !(await m.idleNow(target));
      // urgent 只打断你自己派的那一轮 (或它自己的回执轮): 手上若是别的 wizard / 人 / 定时任务的活,
      // 打断就误伤了那件 —— 降成 normal, 等它这一轮做完再投。
      const others = asked === "urgent" && wasBusy ? await othersTurn(target, self) : undefined;
      const policy = others ? "normal" : asked;
      if (canceledBeforeDispatch() || !actorStillValid()) { dropRow(); return { status: 409, body: { ok: false, reason: "caller authority or dispatch permit changed before acceptance" } }; }
      if (jobId) {
        const budget = checkJob(jobId, target, freed);
        if (!budget.ok) { dropRow(); return { status: budget.status, body: { ok: false, reason: budget.reason } }; }
      }
      let tell: Tell = { from: self, to: target, channel, job: jobId, at, event: serves, legs, deadlineAt, asker, dispatchKey: eventId };
      if (attemptId) {
        const leg = workflow.recordLeg(attemptId, { text, tell, continuation: legs > 1, at, kind: "task", role: roleParam((body as { role?: string }).role), free: freed }, false);
        tell = { ...tell, dispatchKey: leg.key };
      }
      let accepted;
      try { accepted = events.accept({ id: eventId, target, speaker: self, channel, serves, asker, priority: policy, deadline: deadlineAt,
        payload: { text, peer: {
          from: { kind: "peer", from: self, event: serves, ...(jobId ? { job: jobId } : {}), ...(isPublic ? { public: true } : {}), ...(handedChat ? { transferred: true } : {}), ...(asker ? { asker } : {}) },
          envelope: envelopeFor(self, channel, { asker, legs, ...(legs > 1 ? { re: true } : {}),
            ...((body as { deadline?: number }).deadline !== undefined ? { deadline: deadlineAt } : {}), ...(kind !== "task" ? { act: kind } : {}), ...(wantReceipt ? {} : { quiet: true }) }) + extra,
          ...(wantReceipt ? { tell } : {}), job: jobId, kind, attemptId, after: afters,
          role: roleParam((body as { role?: string }).role), free: freed,
          ...(plan.op === "transfer" ? { transferred: true } : {}),
        } } }); } catch (error) { return { status: 409, body: { ok: false, eventId, reason: errText(error) } }; }
      // `re` 把那一笔从 need / error 拉回 open (§3.2 的 need→open / error→open): 行状态是「这份中途态
      // 已经报过了」的去重记号 —— 不拉回去, owner 下一轮交同一个中途态就被静默吞掉 (往返断在这里)。
      if (reTarget && (reTarget.status === "need" || reTarget.status === "error"))
        router.commit(ops.mark({ event: reTarget.event, status: "open" }));
      // `public` 回真实落地的哪一档 (顶层模式 / 工单 / fyi / transfer 都会把入口声明的 public 降级) ——
      // rolepage 的提示行照它判「公开 / 私聊」, 不能凭调用参数推。
      return { status: 200, body: { ...accepted, queued: true, ...(prereqs.some((p) => p.state === "pending") ? { parked: true, after: afters } : {}), event: serves, name: peerAddress(cfg, self, target), priority: policy, wasBusy, public: isPublic,
        ...(jobId ? { job: jobId } : {}), ...(attemptId ? { node, attemptId, acceptance: "pending" } : {}),
        ...(wantReceipt && plan.op !== "transfer" ? { receipt: "已持久化排队；提交后观察那一笔的回执，结论自动返回" } : {}),
        ...(plan.op === "transfer" && serves ? { transfer: transferNote(serves, target) } : {}),
        ...(others ? { urgentDowngraded: "目标正在处理他人的轮次，按 normal 排队" } : {}),
        ...(reUnknown ? { reUnknown: "它手上没有你在飞的那一笔可续 (已落定或从没派过): 这句按新活发出" } : {}) } };
    };
    const tellPeerAs: typeof tellPeerAsInner = async (...args) => {
      const [self, body] = args;
      const transfer = (body as { return?: string }).return === "transfer";
      const current = peerDispatching.get(self);
      if (transfer && current?.count) return { status: 409, body: { ok: false, reason: "another transfer is in flight for this caller; it retains its current ownership" } };
      peerDispatching.set(self, { count: (current?.count ?? 0) + 1, transfer });
      try { return await tellPeerAsInner(...args); }
      finally {
        const n = peerDispatching.get(self);
        if (n && n.count > 1) peerDispatching.set(self, { count: n.count - 1, transfer: n.transfer });
        else peerDispatching.delete(self);
      }
    };
    const tellPeer: Handler = async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const r = await tellPeerAs(self, body);
      json(res, r.status, r.body);
    };
    http.register("POST /peers/inbox", async (req, res) => {
      const { self } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller" }); return; }
      // 收件箱就是持久化队列里还没投出去的那些回执 (§9.3): 一条 `rcpt:` 事件一行。
      const queued = events.status().events
        .filter((x) => x.target === self && x.id.startsWith("rcpt:") && x.execution === "queued")
        .map((x) => ({ id: x.id, from: x.speaker, to: x.target, turn: x.serves ?? "", body: x.payload.text }));
      json(res, 200, { ok: true, events: queued });
    });
    http.register("POST /workflow/nodes", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller" }); return; }
      const attempts = workflow.list(self, (body as { job?: string }).job);
      json(res, 200, { ok: true, nodes: attempts, tally: {
        attempts: attempts.length, nodes: new Set(attempts.map((a) => `${a.job}\0${a.node}`)).size,
        accepted: attempts.filter((a) => workflow.prereq(self, a.turn)?.state === "done").length,
        awaitingAcceptance: attempts.filter((a) => a.execution === "terminal" && a.status === "done" && a.acceptance === "pending").length,
      } });
    });
    http.register("POST /workflow/verdict", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller" }); return; }
      const b = body as { attemptId?: string; as?: string; digest?: string; reason?: string; files?: FileVersion[] };
      if (!["accepted", "rejected", "sent", "stopped"].includes(b.as ?? "")) { json(res, 400, { ok: false, reason: "invalid verdict" }); return; }
      try {
        const old = workflow.list(self).find((a) => a.id === b.attemptId);
        if (!old) throw new Error("attempt not found for owner");
        if (b.as !== "stopped" && (jobs.get(old.job)?.status !== "open" || jobs.get(old.job)?.owner !== self)) throw new Error("owner job must be open for acceptance or sent watching");
        if (b.as === "sent" && !old.dispatches?.length) throw new Error("historical tracked attempt lacks dispatch accounting evidence; reconcile stopped before retry");
        const a = workflow.verdict(self, b.attemptId ?? "", b.as as "accepted" | "rejected" | "sent" | "stopped", b.digest, b.reason ?? "", b.files);
        if (b.as === "sent" && a.tell) recoverWorkflow(a);
        if (b.as === "stopped" && a.to) cancelRoutes([a.turn], () => "被它的发起人标成 stopped, 这件活没有结论。", self);
        if (b.as === "stopped") cancelRoutes(cancelRoots(a.to!, (x) => x.event === a.turn), () => "被它的发起人标成 stopped, 这件活没有结论。", self);
        advancePlans();
        json(res, 200, { ok: true, attempt: workflow.byTurn(self, a.turn) });
      } catch (e) { json(res, 409, { ok: false, reason: (e as Error).message }); }
    });
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
      // 载荷只给一份, 且只给该给的那一份 —— 这段 json 是原样进调用方上下文的。
      // 答案的出处是路由表 + 收件箱 (§9.5): 派给它的那一笔的 `receiver` 边指回自己, 交差时正文
      // 已随 rcpt 事件 (`rcpt:<event>:<rev>`) 排进收件箱, 行上的 `outcome` 是它的全文 —— 不再去
      // transcript 里按信封搜那一句 (旧 awaitReply / claim 那条线)。取走 = 撤单 + `hand`。
      /** 那一份回执在收件箱里的 id 与正文。有定论时 id 由 event + rev 唯一决定 (与 deliverRoute
       *  同一个算式); 停在 need / error 的正文只活在收件箱事件里 (行上不存 body), 按前缀取最新的。 */
      const receiptOf = (r: Route): { id: string; text: string } => {
        if (r.outcome) return { id: `rcpt:${r.event}:${r.outcome.rev}`, text: r.outcome.body };
        const e = events.status().events.filter((x) => x.id.startsWith(`rcpt:${r.event}:`)).sort((a, b) => b.at - a.at)[0];
        return { id: e?.id ?? `rcpt:${r.event}:`, text: e?.payload.text ?? "" };
      };
      const results = uniq.map((h, i) => {
        const wr = wrs[i]!;
        // 同一对并发多笔是允许的 (§4.1): 先取**还在排队**的那份 (那份还没进过你的会话); 都取过了就
        // 报最新那件已交付 —— 绝不把已经 paste 过的那份当成新答案交回来。
        const mine = router.settledTo(self).filter((r) => r.owner === h.target).reverse()   // byAt → 新在前
          .map((row) => { const box = receiptOf(row); return { row, box, ev: events.get(box.id) }; });
        const pick = mine.find((x) => x.ev?.execution === "queued") ?? mine[0];
        if (!pick) return { name: h.address, idle: wr.idle, ...(wr.reason ? { reason: wr.reason } : {}),
          ...(wr.idle ? { stale: true, reason: "它停下了, 但路由表上没有交回给你的定论 —— 多半停在一个等人点的弹窗上, 或那句话没被接住; peek_peer 看一眼" } : {}) };
        // 回执早一步到了: 这段话已经作为新的一轮进过你的会话, 别处理第二遍。
        if (pick.ev && pick.ev.execution !== "queued") return { name: h.address, idle: wr.idle,
          ...(pick.ev.execution === "uncertain"
            ? { delivery: "uncertain", reason: "回执可能已递交，需按 receipt eventId 对账；没有自动重投或再次领取。" }
            : { delivered: true }) };
        // 取走就撤单: 这一笔在收件箱里排着的**全部**回执一起作废 (need 之后又答完时排着两份, 取走
        // 的那一份就是新结论, 旧的那份不再 paste 第二遍); `hand` 确认已交付 (已 handed 的是 no-op)。
        if (pick.ev) {
          events.cancel((x) => x.id.startsWith(`rcpt:${pick.row.event}:`) && x.execution === "queued", "taken by wait_peer");
          router.commit(ops.hand({ event: pick.row.event, inbox: pick.box.id }));
        }
        const closing = parseClosing(pick.box.text);
        const result = closing.kind === "result" ? closing.text : "";
        return {
          name: h.address,
          idle: wr.idle,
          ...(wr.reason ? { reason: wr.reason } : {}),
          ...(closing.kind === "need" ? { need: closing.text } : {}),
          ...(closing.artifacts.length ? { artifacts: closing.artifacts } : {}),
          ...(result
            ? { result, ...(pick.box.text.length > result.length + 200 ? { omitted: pick.box.text.length - result.length } : {}) }
            : pick.box.text
              ? { lastText: clipMiddle(pick.box.text) }
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
    // 还得靠 sid 轮换探测才跟得上。CLI 使用 cfg 的默认 backend; cwd 照旧沿用
    // (排着队的 pendingCwd —— set_workspace 先落的那笔 —— 在这一步被消费, 重开落进新目录)。
    // 同 backend 时模型也沿用, 管家除外 ——
    // 它换上此刻的 router 档 (newSession 里定), 改了 models.router 后交接一次就是让它生效的那一下。
    // `announce` (换工作区) 时那条「📂 当前项目」气泡照发 —— 那是人看得见的回执; 普通交接静默。
    const restartFresh = (target: string, p?: PendingHandoff) => {
      const info = m.sessionInfo(target);
      const cli = cfg.wrc.defaultCli ?? primary.name;
      const model = stewardTierOf(cfg, target) || info?.cli !== cli ? undefined : info?.model || undefined;
      if (!planContinuationAllowed(target)) return Promise.resolve({ ok: false, reason: "workflow continuation withdrawn" });
      return m.newSession(target, displayName(target) || tagOfKey(target) || target, cli, { model, silent: !p?.announce, guard: () => planContinuationAllowed(target) });
    };

    // POST /handoff — 交接一个 pane 的会话给一个全新会话。先让目标会话把当前工作
    // 压成一份"零上下文也能接手"的交接简报,等它写完并抓取,再 restartFresh 换一个
    // 全新的进程(同名、同 cwd),把简报作为新会话的首条消息贴进去。拒绝对调用方
    // 自身操作(会 deadlock,同 /peers/send)。
    /** 交接自己: 简报由调用方给, 排在它这一轮说完之后 (见 handoff.ts)。/handoff 点名点到
     *  自己与老路由 /wizard/handoff-self 共用。 */
    const handoffSelf = (self: string, brief: string): { status: number; body: Record<string, unknown> } => {
      if (!planContinuationAllowed(self)) return { status: 409, body: { ok: false, reason: "workflow continuation withdrawn" } };
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
        // 别的机器人的 pane 与没绑定同形 —— pane 号是另一条绕过 resolvePeer 的寻址。
        if (!target || !sameBot(self, target)) { json(res, 404, { ok: false, reason: `no mirror session bound to pane ${pane}` }); return; }
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
      if (!planStore.allowExternal(target, wizards.get(target)?.name)) { json(res, 409, { ok: false, reason: "workflow executor may only hand off its own live attempt" }); return; }
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
    const liveOfEvents = (): LiveOf => {
      let byEvent: Map<string, InFlight> | undefined;
      return (id) => (byEvent ??= new Map(routeInFlight().map((x) => [x.turn, x]))).get(id);
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
      const text = renderDigest({ ...o, lines: [...o.lines, ...acceptLines] }, o.full ? renderTable(items, liveOfEvents(), pendingNames, now, awaitingRows(t, now), stalledRows(t), shelvedRows(t, now)) : "", rule);
      return { text, keys: text && rule ? ["rule:pending"] : [] };
    };
    const notices = bindNoticeBox(createNoticeBox({
      probe: (t) => [...handoffNudge(t), ...memoryNudge(t)],
      digest: pendingDigest,
      // 群况快照只给长住的 (没有 parent): 分身的协调人是生它的那位, 宪章里的出生快照够用。
      // 表里是这个群的常驻面: 管家、长住有职责的、管家生的 (群里的执行者)、收件人自己生的;
      // 再往下一层的 (分身的分身, 回归测试那批 rr-*) 不进表 —— 同名册变动 hears 的取舍。
      snapshot: (t) => (wizards.get(t)?.parent ? undefined : () => {
        const now = Date.now();
        // activeRows: 超阈值没活动的冷绑定不进表 (见 notices.ts); touch 复用冷门控那一次 stat, 不新增 IO。
        return activeRows(m.chatTargets(t)
          .filter((x) => x !== t && wizards.get(x)?.name)
          .filter((x) => ((p) => !tagOfKey(x) || (!p ? !!wizards.get(x)?.description : p === t || p === baseOfKey(t)))(wizards.get(x)?.parent))
          .map((x): TimedSnapRow => {
            const i = m.sessionInfo(x);
            const state = ((v) => (v === undefined ? "-" : v ? "idle" : m.parkedNow(x) ? "parked" : "busy"))(m.idleVerdict(x));
            const touch = i?.jsonlPath ? touchOf(i.jsonlPath) : 0;
            // 冷热与 route_candidates / tell_peer 冷门控同一口径 (touchOf / ttlOf)。
            const warmth = i?.jsonlPath ? { ctx: i.contextTokens, cold: wakeCostOf(i.contextTokens, touch, now, ttlOf(i.jsonlPath)).cold } : {};
            return { name: displayName(x), state, ...warmth, job: wizards.get(x)?.description || (tagOfKey(x) ? "" : "steward"), touch };
          }), now);
      }),
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
        postAs(owner, chat, text);
        recordPost({ target: owner, channel: chat, body: text });
        xs.forEach(({ job }) => jobs.mark(job.id, { nudge: { n: (job.nudge?.n ?? 0) + 1, lastAt: now } }));
        notices.post([owner], `nudged the human (daemon, in your name) about finished requests; their next line may be the verdict on one: ${xs.map(({ job }) => `${job.id} "${job.title}"`).join(" · ")}`);
      });
      return due.length;
    };
    setInterval(() => { try { nudgeTick(); } catch (e) { log.warn({ err: (e as Error).message }, "accept nudge failed"); } }, NUDGE_TICK_MS).unref();
    /** `who` = 这次变动的当事人 (见 hears): 不给 = 聊天自己的事 (改名), 全群都听。 */
    // 听众只在主角那个聊天里 (同 base ⇒ 同机器人); sameBot 再写一遍是隔离的明文, 不靠 key 的拼法兜着。
    const postRoster = (base: string, except: readonly string[], n: Notice, who?: Subject): void =>
      notices.post(chatAudience(m.chatTargets(base), base, except).filter((t) => sameBot(base, t)).filter(who ? hears(who) : () => true), n);
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
      const inflight = routeInFlight();
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
        // rolepage 的待办托盘: 与名册 / peek 的「在等 / 欠着」同一份 (路由表)。
        inflight: routeInFlight().map(({ ageMs, ...x }) => ({ ...x, at: Date.now() - ageMs })),
        schedules: tasks.list().filter((x) => x.enabled).map((x) => {
          const st = tasks.stateOf(x.id);
          const loadError = tasks.errors()[x.id];
          return {
            id: x.id,
            target: x.target || defaultChatFor(cfg, x.owner || (cfg.defaultChat ?? "")),
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
        // 微信用户的发话人 id 就是它那个群的 chatId: 名字跟着群名走。
        humanNames: Object.fromEntries(wx.list().map((a) => [`human:${a.chatId}`, chatNameOf(cfg, `chat:${a.chatId}`)] as const).filter(([, n]) => n)),
        weixin: wx.list().map((a) => ({
          base: `chat:${a.chatId}`, state: a.state, lastInAt: a.lastInAt ?? 0, held: a.outbox.length,
          budget: a.ctx ? Math.max(0, cfg.weixin.sendCap - a.ctx.used) : 0, pausedUntil: a.pausedUntil ?? 0,
        })),
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
      ...(wizards.get(target)?.expertise ? { expertise: wizards.get(target)!.expertise } : {}),
      cwd: m.getCwd(target).runningCwd,
    });

    /** 自己的地址 = 全局名字, 与住在哪个群无关。 */
    const selfAddress = (target: string): string => settleName(wizards, chatNameOf(cfg, target), target);

    const sharedMemory = (scope: MemoryScope, key: string, bot = ""): string => {
      const path = memoryPath(cfg.daemon.stateDir, scope, key, bot);
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

    type CharterOpts = { parent?: string; forkOf?: string; inherited?: boolean; cwd?: string; cli?: CliBackendName };
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
          // 同 base 即同机器人; 显式再滤一道, 宪章名册的隔离不依赖 key 的拼法。
          .filter((t) => t !== target && sameBot(target, t))
          .map((t) => [t, Math.max(lastTouched(t), wizards.get(t)?.bornAt ?? 0)] as const)
          .filter(([, at]) => Date.now() - at <= ROSTER_FRESH_MS)
          .sort((x, y) => y[1] - x[1])
          .map(([t]) => briefOf(target, t)),
        memory: wizards.get(target)?.memory ?? [],
        tiers: forDiff ? [] : TIERS.map((n) => { const s = tiersForBackend(cfg, o.cli ?? m.sessionInfo(target)?.cli)[n]; return `${n}=${s.model || "默认"}${s.effort ? `·${s.effort}` : ""}`; }),
        chatMemory: sharedMemory("chat", baseOfKey(target)),
        workspaceMemory: (() => {
          const cwd = o.cwd || m.getCwd(target).runningCwd || m.getCwd(target).defaultCwd;
          return cwd ? sharedMemory("workspace", cwd, botOfKey(target)) : "";
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
      return charterFor(target, { ...charterOptsOf(target, ctx?.cwd), cli: ctx?.cli });
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

    // 家谱只列与观察者同机器人的 (跨机器人的分身生不出来, 这是给老数据 / 手改注册表兜的底)。
    const kinOf = (self: string, all: readonly WizardRecord[], target: string) => ({
      parent: ((p) => (p && sameBot(self, p) ? briefOf(self, p) : undefined))(wizards.get(target)?.parent),
      ancestors: ancestorsOf(all, target).filter((t) => sameBot(self, t)).map((t) => briefOf(self, t)),
      clones: childrenOf(all, target).filter((w) => sameBot(self, w.target)).map((w) => briefOf(self, w.target)),
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
      // live 已由 peers (同 base) / foreignPeers (sameBot) 收窄; 冷记录在这里按机器人滤。
      const cold = all
        .filter((w) => !seen.has(w.target) && sameBot(self, w.target))
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
      const b = body as { name?: string; description?: string; expertise?: string };
      const asked = normalizeTag((b.name ?? "").toString());
      const description = (b.description ?? "").toString().trim();
      const expertise = (b.expertise ?? "").toString().trim();
      if ((b.name ?? "").toString().trim() && !asked) { json(res, 400, { ok: false, reason: "名字只能是 1-32 位字母/数字/`_`/`-`" }); return; }
      if (asked && (!planStore.allowExternal(self, wizards.get(self)?.name) || !planStore.allowExternal(undefined, asked))) { json(res, 409, { ok: false, reason: "workflow plan reserves this identity" }); return; }
      const before = settleName(wizards, chatNameOf(cfg, self), self);
      const name = asked ? wizards.rename(self, asked) : before;
      if (description) wizards.upsert(self, { description });
      // 专长: 传 "-" 清掉; 它不进名册变动通知 (只在名册 / 候选行里读)。
      if (expertise) wizards.upsert(self, { expertise: expertise === "-" ? undefined : expertise });
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
      return (w: { name: string; address: string; description: string; expertise?: string; cwd: string; chat: string; target: string; alive: boolean }): boolean =>
        (!q || [w.name, w.address, w.description, w.expertise, w.target].some((f) => (f ?? "").toLowerCase().includes(q))) &&
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
      const inflight = routeInFlight();
      const shown = ranked.slice(0, limit).map((r) => ({
        ...r,
        turns: turnsLine(inflight, r.target),
        duty: dutyLine(jobs.all(), r.target, (t) => `.${displayName(t)}`),
        model: r.model || (r.jsonlPath ? lastModel(r.jsonlPath) : ""),
        summary: r.jsonlPath ? lastExchange(r.jsonlPath, 80) : "",
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
    /** 候选的原料: 除自己之外每个 wizard 的上下文事实 (文件集 / 最近的话 / ctx / 缓存 TTL)。
     *  `keep` 在读 transcript **之前**收窄: 每行要扫几 MB 尾巴, 全机几百个绑定读一遍是秒级 ——
     *  调用方只要活着的那几个时, 别替死掉的 pane 付这笔。 */
    const routeRowsOf = async (self: string, keep: (r: { alive: boolean; target: string }) => boolean = () => true): Promise<(RouteRow & { target: string })[]> => {
      ensureChatNames(self);
      const roster = await rosterOf(self);
      const openJobs = jobs.all();
      const inflight = routeInFlight();
      return roster
        .filter((r) => !r.self && keep(r))
        .map((r) => {
          const live = r.jsonlPath ? r.jsonlPath : "";
          const ttl = live ? cacheTtlSec(live) : 0;
          return {
            ...r,
            lead: wizards.get(r.target)?.lead === true,
            duties: routeDutiesOf(openJobs, r.target, inflight),
            contextTokens: live ? lastContextTokens(live) : 0,
            ...(ttl ? { cacheTtlMs: ttl * 1000 } : {}),
            ...(live ? { cacheAt: cacheTouchMs(live) } : {}),
            files: live ? contextFiles(live) : [],
            asks: live ? talkTurns(live, 12).filter((t) => t.role === "user").map((t) => t.text) : [],
            summary: live ? lastExchange(live, 80) : "",
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
      const cands = rankCandidates(task, (b.cwd ?? "").trim() || m.getCwd(self).runningCwd, await routeRowsOf(self), { now: Date.now(), ttlMs: CACHE_TTL_FALLBACK_SEC * 1000 }).slice(0, limit);
      json(res, 200, { ok: true, text: renderCandidates(task, cands, Date.now(), CACHE_TTL_FALLBACK_SEC * 1000, homedir()) });
    });

    // 派活收成一步 (见 route.decide): 查候选 → 过成本门控 → 转给已有的或按档白板 spawn →
    // tell_peer 投出去, 回决定与理由。默认决定由守护进程算; 管家不同意就 `to` 点名、
    // `force` 越过冷门控、`spawn:true` 硬要新的 —— 推翻要显式说。
    http.register("POST /dispatch", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { task?: string; name?: string; description?: string; tier?: string; to?: string; force?: boolean; lead?: boolean; spawn?: boolean; public?: boolean; deadline?: number; dryRun?: boolean; criteria?: string; return?: string; for?: string };
      const task = (b.task ?? "").toString().trim();
      if (!task) { json(res, 400, { ok: false, reason: "task is required" }); return; }
      // 回执去向在入口冻结 (dispatch 不再永远挂到当前帧: return:"detach" 即旁支, 修 G4)。
      const plan = planReturn(self, b as Record<string, unknown>);
      if (!plan.ok) { json(res, plan.status, { ok: false, reason: plan.reason }); return; }
      const dispatchOrigin: ActorOrigin = {
        authority: controlSnapshot(self), asker: askerOf(self),
        plan: { op: plan.op, ...(plan.serves ? { serves: plan.serves } : {}) },
      };
      const lead = b.lead === true;
      const transfer = plan.op === "transfer";
      if (transfer && lead) { json(res, 409, { ok: false, reason: "transfer hands over the row this turn owes; a lead dispatch cannot transfer" }); return; }
      if (transfer && (!plan.serves || router.get(plan.serves)?.receiver.kind !== "wizard")) { json(res, 409, { ok: false, reason: "这一轮没有欠着的同伴活可以交出去 (transfer 只用于同伴派给你的那一笔)" }); return; }
      const force = b.force === true;
      const to = (b.to ?? "").toString().trim();
      const now = Date.now();
      const ttlMs = CACHE_TTL_FALLBACK_SEC * 1000;
      // 占用保护由 decide 统一判断, 留在候选表里说明为什么不能自动复用。
      // 显式 to 保留人为选定; force 只影响成本门, 不绕 lead/工单/连续性保护。
      const pool = to || b.spawn || lead ? [] : await routeRowsOf(self, (r) => r.alive && !!tagOfKey(r.target));
      if (!controlValid(self, dispatchOrigin.authority)) { json(res, 409, { ok: false, reason: "dispatch source turn/control changed while routing; original task remains with source" }); return; }
      const tierArg = (b.tier ?? "").toString().trim();
      if (tierArg && !TIERS.includes(tierArg as TierName)) { json(res, 400, { ok: false, reason: `unknown tier: ${tierArg}` }); return; }
      const taskTier = (tierArg || tierFor(task, lead)) as TierName;
      const cands = rankCandidates(task, m.getCwd(self).runningCwd, pool, { now, ttlMs });
      let d: { kind: "existing"; why: string; row?: RouteRow } | { kind: "spawn"; why: string } = to ? { kind: "existing" as const, why: `你点名了 ${to}` }
        : b.spawn ? { kind: "spawn" as const, why: "你要了新的" }
          : lead ? { kind: "spawn" as const, why: "复杂活: 白板起一个 hard 档的 lead, 由它组队" }
            : decide(task, cands, now, ttlMs, force, taskTier);
      // 复杂活 (lead:true) 是一件「需求」: 先开需求根单 (账本, 不占 pane), 这一句带它派下去, lead 记成根单成员。
      // 小活不开单。dryRun 不落账, 所以放在它后面开 (见下)。
      const criteria = (b.criteria ?? "").toString().trim();
      let rootId = "";
      const tell = (name: string, text: string, extra = ""): Promise<Reply> => tellPeerAs(self, {
        name, text, public: b.public !== false, force,
        ...(plan.op !== "self" ? { return: plan.op } : {}),
        // lead 的活远超默认的 1h: 不给 deadline 就按 12h (回执的上限)。
        ...(b.deadline !== undefined ? { deadline: b.deadline } : lead ? { deadline: 43200 } : {}),
        ...(rootId ? { job: rootId } : {}),
      } as PeerBody, extra, undefined, dispatchOrigin);
      const shown = cands.slice(0, 3).map((e) => `.${e.row.address || e.row.name}${e.row.busy ? " 忙" : ""}`);
      if (b.dryRun) {
        json(res, 200, { ok: true, dryRun: true, decision: d.kind, reason: d.why, ...(d.kind === "existing" ? { name: to || (d.kind === "existing" && d.row ? d.row.address || d.row.name : "") } : { tier: taskTier }), ...(shown.length ? { candidates: shown } : {}) });
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
        ? { ...body, job: rootId, hint: "需求根单已开, 对人**别提单号**。lead 交付后根单仍开着, 等人验收: 人认可 → close_job(job) 归档; 人说不对 → tell_peer({name, re, job}) 给 lead 返工 (同一张单, 不开新单); 人说不要了 → close_job({job, as:\"cancel\"}); 先放着 → close_job({job, as:\"shelve\"}) (停提醒, 不关单)。" }
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
        // 自动选中的被冷门控 (decide 用名册的活动时刻, 门控用 transcript 的, 口径差一点) 或方向闸 (它归别人管 / 是借来的专家) 退回: 改走 spawn; 点名的不改。
        if (!(!to && (t.body.gated === "cold" || t.body.gated === "direction"))) {
          settleRoot(t.status === 200);
          json(res, t.status, withRoot({ ...t.body, decision: "existing", reason: d.why, ...(shown.length ? { candidates: shown } : {}) }));
          return;
        }
        d = { kind: "spawn", why: `${d.why}; 但它被${t.body.gated === "direction" ? "方向闸" : "冷门控"}退回 (${String(t.body.reason)}) —— 改为白板 spawn` };
      }
      const name = (b.name ?? "").toString().trim();
      const description = (b.description ?? "").toString().trim();
      if (!name || !description) {
        settleRoot(false);
        json(res, 400, { ok: false, decision: "spawn", reason: `${d.why} —— 要新生一个, 带上 name (这件事的短名) 与 description (它的职责) 重发`, ...(shown.length ? { candidates: shown } : {}) });
        return;
      }
      const tier = taskTier;
      const born = await bearAs(self, { inherit: false, name, description, tier, ...(lead ? { lead: true } : {}) } as PeerBody, undefined, dispatchOrigin?.authority);
      if (born.status !== 200) { settleRoot(false); json(res, born.status, { ...born.body, decision: "spawn", reason: d.why }); return; }
      if (!controlValid(self, dispatchOrigin.authority)) { settleRoot(false); json(res, 409, { ok: false, decision: "spawn", reason: "dispatch source turn changed during spawn; task remains with original source turn" }); return; }
      // 宪章里只有层级规矩, 打法随信封带 (宪章每轮都在上下文里, 打法只这一件活用得上)。
      const t = await tell(String(born.body.name), task, lead ? renderReminder({ wezard: "lead" }, renderLeadPlaybook()) : "");
      settleRoot(t.status === 200);
      // 为这张根单生出来的 (tell 记的是 spawned:false, 再 attach 一次补上; lead 角色也在这里记)。
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
        // 工作区记忆按机器人分份 (见 wizard-memory.fileOf); chat 的 key 本身就带机器人。
        const bot = botOfKey(self);
        const path = memoryPath(cfg.daemon.stateDir, scope as MemoryScope, key, bot);
        const queued = proposeMemory(inboxPath(cfg.daemon.stateDir, scope as MemoryScope, key, bot), {
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
    const bearAs = async (self: string, body: PeerBody, planned?: PlanPermit, capturedAuthority?: ReturnType<typeof controlSnapshot>): Promise<Reply> => {
      const authority = planned ? undefined : capturedAuthority ?? controlSnapshot(self);
      if (authority && !controlValid(self, authority)) return { status: 409, body: { ok: false, reason: "this turn no longer owns control; cannot spawn more work" } };
      // Legacy bootstrap can dispatch before attaching its member. An empty job
      // is not available for plan ownership while that birth is still in flight.
      const birthJob = ((body as { job?: string }).job ?? "").trim();
      if (birthJob) pendingBirthJobs.set(birthJob, (pendingBirthJobs.get(birthJob) ?? 0) + 1);
      try {
      const b = body as { name?: string; tag?: string; description?: string; inherit?: boolean; detached?: boolean; from?: string; cwd?: string; chat?: string; cli?: CliBackendName; model?: string; effort?: string; tier?: string; task?: string; job?: string; lead?: boolean };
      const asker = b.task?.trim() ? askerOf(self) : undefined;
      // 带 task 才是派活: 回执去向同 tell_peer (return / for)。
      const plan = b.task?.trim() && !planned ? planReturn(self, body as Record<string, unknown>) : undefined;
      if (plan && !plan.ok) return { status: plan.status, body: { ok: false, reason: plan.reason } };
      // transfer 只对同伴派给你的那一笔有意义 (要交出去的那一行得真的欠在同伴头上)。
      if (plan?.ok && plan.op === "transfer" && (!plan.serves || router.get(plan.serves)?.receiver.kind !== "wizard"))
        return { status: 409, body: { ok: false, reason: "这一轮没有欠着的同伴活可以交出去 (transfer 只用于同伴派给你的那一笔)" } };
      const askedEffort = parseEffort(b.effort);
      if (b.effort !== undefined && !askedEffort) { return { status: 400, body: { ok: false, reason: `effort 只有这几档: ${EFFORTS.join(" / ")}` } }; }
      // 工单先验: 生完分身才发现工单号打错了, 那个分身就成了没人认领的孤儿。
      const jobId = (b.job ?? "").trim();
      if (jobId) {
        const jc = checkJob(jobId, undefined, !(b.task ?? "").toString().trim());
        if (!jc.ok) { return { status: jc.status, body: { ok: false, reason: jc.reason } }; }
      }
      const planBirthAllowed = (target?: string, name = normalizeTag(b.name ?? b.tag) || (b.detached && b.cwd ? tagFromCwd(b.cwd) : "") || normalizeTag(b.description?.split(/\s+/)[0]) || "clone"): boolean => planStore.allowSpawn(self, jobId, planned, name, target) && (!planned || planned.alive());
      if (!planBirthAllowed() || (planned && !!b.task)) return { status: 409, body: { ok: false, reason: "dedicated plan job only permits taskless runner spawn" } };
      // 带 task 派下去 = 派活: 同样过方向闸, 不论带不带 job (新生的目标还不在任何单里, 实际只有 1 / 链深两条会拦)。
      const dr = planned || (b.task ?? "").toString().trim() ? checkDirection({ self, target: "", kind: "task", re: false, jobId, jobs: jobs.all(), ...chainNow(self, planned?.origin.event ?? (plan?.ok ? plan.serves : undefined)), nameOf: displayName }) : undefined;
      if (dr) { return { status: 409, body: { ok: false, gated: "direction", reason: dr } }; }
      const transferNo = plan?.ok && plan.op === "transfer" ? transferRefusal(self, plan.serves, undefined, { job: jobId }) : undefined;
      if (transferNo) return { status: 409, body: { ok: false, reason: transferNo } };
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
      const forkBackend = inherit && sourceInfo && existsSync(sourceInfo.jsonlPath)
        && (!b.cwd?.trim() || expandHome(b.cwd.trim()) === sourceInfo.cwd) ? sourceInfo.cli : undefined;
      const pick = pickTier(cfg, b.tier, { cli: b.cli, model: b.model, effort: askedEffort }, inherit, forkBackend);
      if (!pick.ok) return { status: 400, body: pick };
      const effort = pick.effort;
      // 别人的会话 fork 不出来就是失败, 不能像克隆自己那样悄悄退化成白板 —— 调用方
      // 要的恰恰是它的上下文, 给一张白纸等于答非所问。
      if (source !== self && !sourceInfo?.sessionId) {
        return { status: 409, body: { ok: false, reason: `${displayName(source)} 没有可 fork 的会话 (还没说过话, 或绑定已失效)` } };
      }
      const alivePeers = detached ? [] : await m.peers(self);
      if (authority && !controlValid(self, authority)) return { status: 409, body: { ok: false, reason: "caller turn/control changed while preparing spawn" } };
      // 预算。撞到上限由守护进程腾位, 不叫调用方去收: 最久没动的闲分身只关 pane、绑定留着
      // (同 maxPanes 的 reap), 再找它 `--resume` 带全上下文复活。忙的、停在审批上的、手上
      // 还有没落定的活的不动; 全都动不了才拒。只数**本聊天里**活着的 ——
      // 生到别的聊天去的归那边管, 为了数它们再探一遍 tmux 不值当。
      const aliveKids = alivePeers.filter((pp) => pp.paneAlive && childrenOf(wizards.all(), self).some((k) => k.target === pp.target));
      const over = detached ? 0 : aliveKids.length - cfg.wrc.mirror.cloneMax + 1;
      if (over > 0) {
        const parked = new Set(listPending().map((p) => p.meta.sessionId).filter(Boolean));
        const owing = new Set(routeInFlight().map((x) => x.to));
        const idle = aliveKids
          .filter((pp) => planStore.allowExternal(pp.target, wizards.get(pp.target)?.name) && !pp.busy && !owing.has(pp.target) && !parked.has(m.sessionInfo(pp.target)?.sessionId ?? ""))
          .sort((x, y) => x.lastActivity - y.lastActivity)
          .slice(0, over);
        const slept = (await Promise.all(idle.map((pp) => m.sleepPane(pp.target)))).filter((r) => r.ok).length;
        if (slept < over) {
          return { status: 429, body: {
            ok: false,
            reason: `你名下 ${aliveKids.length} 个活着的分身 (上限 ${cfg.wrc.mirror.cloneMax}) 都在干活, 腾不出位置 —— 等其中一个交回结论再分`,
            clones: aliveKids.map((k) => peerAddress(cfg, self, k.target)),
          } };
        }
        log.info({ self, slept: idle.map((pp) => pp.target) }, "clone cap: idle clones put to sleep");
      }
      const wantChat = (b.chat ?? "").toString().trim();
      const base = ((b) => (b && sameBot(self, b) ? b : ""))(wantChat ? chatBaseOf(cfg, wantChat) : baseOfKey(self));
      if (!base) {
        return { status: 404, body: {
          ok: false,
          reason: `unknown chat '${wantChat}' — 只有起过名字的聊天能被指名; 让那边先 /name`,
          candidates: chatNamesFor(self),
        } };
      }
      const askedName = String(b.name ?? b.tag ?? "");
      // 没起名: 独立长住的按目录名 (同 /new 与 new_claude_session), 分身按职责的首词。
      const fallback = (detached && b.cwd ? tagFromCwd(b.cwd) : "") || normalizeTag(b.description?.split(/\s+/)[0]) || "clone";
      const slotR = await claimSlot(base, askedName, fallback, [self, source], (target, name) => planBirthAllowed(target, name) && (!target || planBirthAllowed(target, wizards.get(target)?.name ?? name)));
      if (!slotR.ok) { return { status: slotR.status, body: slotR.body }; }
      const { target, slot: tag } = slotR;
      // claimSlot 会复用同名的冷记录 (detached 正是「叫回一个老名字」的场景): 生不出来时
      // 只回滚这一次的新记录, 不能把那个老 wizard 的记忆和家谱一起删掉。
      const existed = !!wizards.get(target);
      const forkOf = inherit && source !== self ? source : undefined;
      // 先落身份再 spawn: 宪章是从注册表渲染出来的, 记录不在就渲染出一个无名分身。
      if (!planBirthAllowed(target, normalizeTag(askedName) || tag) || (jobId && jobs.get(jobId)?.status !== "open")) return { status: 409, body: { ok: false, reason: "plan canceled/job reserved during spawn preparation" } };
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
      const charter = charterFor(target, { ...(detached ? {} : { parent: self }), forkOf, inherited: inherit, cli: pick.cli });
      const task = (b.task ?? "").toString().trim();
      // 先盖章再生: 分叉出来的 transcript 里躺着被克隆者的旧回复, 时刻早于这一枚章,
      // wait_peer 才不会把它们当成分身对这件活的答复。
      const taskAt = Date.now();
      const birthGuard = (): boolean => (!authority || controlValid(self, authority)) && planBirthAllowed(target, wizards.get(target)?.name ?? name) && (!jobId || jobs.get(jobId)?.status === "open");
      if (!birthGuard()) return { status: 409, body: { ok: false, reason: "executor reservation changed before spawn" } };
      const r = await m.cloneSession({
        guard: birthGuard,
        parent: source,
        target,
        windowName: name,
        cli: pick.cli,
        model: pick.model,
        effort,
        cwd: b.cwd,
        systemPrompt: charter,
        inherit,
        // Fork initialization carries no task; actual work is durably accepted below.
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
        // 模型不报: 那是生它的那位的事, 旁人要时 wizard_roster 有。
        postRoster(base, [target, self], {
          op: "born", name: `.${name}`, by: displayName(self), clone: !detached,
          ...(r.inherited ? { ctx: forkOf ? displayName(forkOf) : displayName(self) } : {}),
          ...(kid.description ? { job: kid.description } : {}), cwd: r.cwd,
        }, subjectOf(wizards.get(target)));
      }
      const dispatched = !!task && birthGuard();
      let dispatchedEvent = "";
      if (dispatched) {
        const deadlineAt = deadlineOf(taskAt);
        const quiet = !!plan?.ok && plan.op === "none";
        // 路由行 (§3.1): 生出来的那个领活, 结论回生它的这位。
        const serves = plan?.ok
          ? openDispatchRow({ self, target, op: plan.op, deadlineAt, job: jobId, ...(asker ? { asker } : {}), ...(plan.serves ? { serves: plan.serves } : {}) })
          : "";
        dispatchedEvent = serves;
        const eventId = serves ? `route:${serves}` : `p:${self}:${target}:${taskAt}:1`;
        const birthTell: Tell = { from: self, to: target, channel: "", job: jobId, at: taskAt, event: serves, legs: 1, deadlineAt, asker, dispatchKey: eventId };
        events.accept({ id: eventId, target, speaker: self, channel: "", serves, asker, priority: "normal", deadline: deadlineAt,
          payload: { text: task, peer: {
            from: { kind: "peer", from: self, event: serves, ...(jobId ? { job: jobId } : {}), ...(asker ? { asker } : {}) },
            envelope: envelopeFor(self, "", { asker, ...(quiet ? { quiet: true } : {}) }) + (b.lead === true ? renderReminder({ wezard: "lead" }, renderLeadPlaybook()) : ""),
            ...(quiet ? {} : { tell: birthTell }),
            job: jobId, kind: "task", spawned: true, role: roleParam((body as { role?: string }).role),
            ...(plan?.ok && plan.op === "transfer" ? { transferred: true } : {}),
          } } });
      } else if (jobId && birthGuard()) {
        jobs.attach(jobId, { target, task: "", spawned: true, ...(roleParam((body as { role?: string }).role) ? { role: roleParam((body as { role?: string }).role) } : {}) });
      }
      return { status: 200, body: { ok: true, target, name, address: name, inherited: r.inherited, sessionId: r.sessionId, cwd: r.cwd, dispatched, queued: dispatched, ...(dispatched ? { event: dispatchedEvent } : {}), ...(r.model ? { model: r.model } : {}), ...(r.modelWarning ? { modelWarning: r.modelWarning } : {}), ...(r.effort ? { effort: r.effort } : {}), ...(pick.tier ? { tier: pick.tier } : {}), via: pick.via, ...(pick.note ? { tierNote: pick.note } : {}), ...(jobId ? { job: jobId } : {}), ...(detached ? { detached: true } : {}) } };
      } finally {
        if (birthJob) {
          const remaining = (pendingBirthJobs.get(birthJob) ?? 1) - 1;
          if (remaining) pendingBirthJobs.set(birthJob, remaining); else pendingBirthJobs.delete(birthJob);
        }
      }
    };
    const planRunner = createWorkflowPlanRunner(planStore, {
      job: jobs.get, attempt: workflow.byTurn, prereq: workflow.prereq,
      spawn: (run, node, state, permit) => bearAs(run.owner, {
        inherit: false, name: state.name, description: node.criteria || `workflow node ${node.id}`,
        tier: node.tier, cwd: run.plan.cwd, job: run.plan.job,
      } as PeerBody, permit),
      tell: (run, node, state, after, permit) => tellPeerAs(run.owner, {
        name: state.name, text: node.task + (node.criteria ? `\n\n验收标准: ${node.criteria}` : ""),
        node: node.id, job: run.plan.job, ...(after.length ? { after } : {}),
      } as PeerBody, "", permit),
      cancel: (run) => {
        workflow.cancel(undefined, run.owner, run.plan.job);
        cancelRoutes(router.rows().filter((r) => r.job === run.plan.job).map((r) => r.event),
          () => `随计划 ${run.id} 收掉了, 这件活没有结论。`, run.owner);
        events.cancel((e) => e.speaker === run.owner && e.payload.peer?.job === run.plan.job);
      },
      error: (e) => log.error({ err: errText(e) }, "workflow plan advancement paused"),
    });
    advancePlans = planRunner.kick;
    registerWorkflowPlanRoutes(http, {
      read: readPeerBody, store: planStore, runner: planRunner,
      job: jobs.get, attempts: workflow.list,
      occupied: (self, job) => pendingBirthJobs.has(job) || routeInFlight().some((s) => s.from === self && s.job === job),
      origin: (self) => {
        const served = servesOfTurn(self);
        const asker = askerOf(self);
        return { ...(served ? { event: served } : {}), ...(asker ? { asker } : {}) };
      },
      direction: (self, jobId, origin) => checkDirection({ self, target: "", kind: "task", re: false, jobId, jobs: jobs.all(), ...chainNow(self, origin.event), nameOf: displayName }),
    });
    void m.restored.then(planRunner.start);

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
      const authority = controlSnapshot(self);
      if (!controlValid(self, authority)) { json(res, 409, { ok: false, reason: "本轮回答权和控制权已移交或失效；不能打断或结束目标 wizard" }); return; }
      const b = body as { name?: string; tag?: string; mode?: string; forget?: boolean; turn?: string; force?: boolean };
      const r = resolvePeer(self, addrOf(b));
      // 有身份没会话 (冷记录 / 生到一半的僵尸): resolvePeer 够不着它, 但收它不需要
      // 会话 —— end 视为早已结束, forget 删掉记录、腾出名字。interrupt 无从谈起。
      const found = r.ok || r.candidates?.length ? undefined : ((w) => (w && sameBot(self, w.target) ? w : undefined))(wizards.byName(addrOf(b)));
      const cold = found && !m.chatTargets(baseOfKey(found.target)).includes(found.target) ? found : undefined;
      if (cold && (b.mode ?? "end") === "end") {
        if (!controlValid(self, authority)) { json(res, 409, { ok: false, reason: "本轮控制权已变化；拒绝结束目标 wizard" }); return; }
        workflow.cancel(cold.target);
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
      // 不带 turn / force 的打断 = 撤回你派给它、还在飞的那一笔 (唯一时) —— 不必抄 event; 歧义才要指明。
      const own = !end && !b.turn && !b.force ? pickPair(router.table(), self, target) : undefined;
      if (own && !own.ok) { json(res, 400, { ok: false, target, reason: `你在它手上有 ${own.many.length} 笔没落定, 撤回哪一笔用 turn 指明: ${own.many.map((x) => `\`${x.event}\``).join(" ")}` }); return; }
      const ownLive = own?.ok && own.row && ["held", "open", "need", "error"].includes(own.row.status) ? own.row.event : "";
      const turn = eventRef(b.turn) || ownLive;
      if (!end && turn) {
        const mine = router.awaitedBy(self).find((x) => x.owner === target);
        const known = router.get(turn);
        if (mine?.event !== turn && workflow.byTurn(self, turn)?.to !== target
          && !(known && known.receiver.kind === "wizard" && known.receiver.to === self)) { json(res, 404, { ok: false, reason: `你没有在等 ${victim.name ? `.${victim.name}` : target} 答 '${turn}' 这件 (已落定、event 写错, 或不是你派的)` }); return; }
        // 先落 canceled 再按 Esc: 被打断那一轮的半截话不该被 watcher 当成答案投回来。
        const busy = !(await m.idleNow(target));
        if (!controlValid(self, authority)) { json(res, 409, { ok: false, reason: "等待期间本轮控制权已变化；未撤回或打断目标" }); return; }
        const canceled = cancelPeerWork(target, self, (x) => x.from === self && x.event === turn);
        // 按 Esc 之前再认一次手上这一轮: 上面那次 await 期间它可能已经做完这件、接了别人的下一件。
        const current = busy && openingAsk(target)?.event === turn;
        // 还没轮到 / 排在后面: 捎一句给它, 轮到那句话时别再做了 (notices 挂在下一条注入的尾巴上)。
        if (!current) notices.post([target], `${displayName(self)} 撤回了它派给你的 ${turn} —— 那件活不用做了; 读到它时直接略过, 不必回复。`);
        // 只按 Esc, 不 teardown: teardown 会清掉它的注入队列, 别人排着的话一起丢。
        if (current && !controlValid(self, authority)) { json(res, 409, { ok: false, reason: "物理操作前本轮控制权已变化；已登记撤回但未发送 Esc" }); return; }
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
      if (!controlValid(self, authority)) { json(res, 409, { ok: false, reason: "等待期间本轮控制权已变化；未取消或打断目标" }); return; }
      if (others) {
        json(res, 409, { ok: false, target, reason: `它此刻在做 ${others.from} 派的活${others.event ? ` (${others.event})` : ""}, 打断会连那件一起停掉 —— 只想撤回你自己派的那件, 传 turn (那一笔的 event); 确要打断它这一轮, 加 force:true` });
        return;
      }
      // 先落 canceled 再动 pane: pane 一死, 守着的 watcher 会把同一份报成 dead。
      // 打断只停它手上这一轮: 只掐这一轮开头那句派来的活 (人 / 定时 / 回执轮不掐任何一份)。
      const only = end ? undefined : currentAsk(target);
      if (!controlValid(self, authority)) { json(res, 409, { ok: false, reason: "物理操作前本轮控制权已变化；未取消或打断目标" }); return; }
      const canceled = cancelPeerWork(target, self, only);
      if (!controlValid(self, authority)) { json(res, 409, { ok: false, reason: "物理操作前本轮控制权已变化；未打断或结束目标" }); return; }
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
        hint: "把这个 id 传给 spawn_wizard / clone_wizard / tell_peer 的 `job` 参数, 它们就归到这个工单名下 (一律私聊, 不进群); 活干完调 close_job 留档, 给人的结论写在你自己这一轮的最终回复里。",
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
      // 关一张单连它还开着的后代单一起关 (深的先关): 否则账本上挂着没人收的子单。
      // 收工只结账、留档, 不碰成员的 pane: 分身的去留与工单无关, pane 多了由 maxPanes / cloneMax 自己收
      // (只关 pane、绑定留着)。老 MCP 进程还会带 `stop`, 收下不用。
      const openKids = (j: JobRecord): JobRecord[] => jobChildren(jobs.all(), j.id).filter((c) => c.status === "open").flatMap((c) => [...openKids(c), c]);
      const cascade = openKids(job);
      const closeOne = async (j: JobRecord, summary: string, mark?: JobMark): Promise<{ members: number }> => {
        const sids = new Map([j.owner, ...j.members.map((mm) => mm.target)].map((t) => [t, m.sessionInfo(t)?.sessionId ?? ""]));
        // 取消: 还没落定的成员手上这张单派的活记成 canceled, 发起者不会再收到一串回执。
        planRunner.cancelJob(j.owner, j.id);
        workflow.cancel(undefined, j.owner, j.id);
        // 还没落定的成员手上这张单派的活记成 canceled (路由表那一批在下面按 job 级联)。
        // T6: 路由表上这张单名下的行同样级联 canceled (§4.2) —— 行带着 job, 认单不认人。
        if (how === "cancel") cancelRoutes(
          j.members.filter((mm) => !mm.outcome).flatMap((mm) => router.owedBy(mm.target).filter((r) => r.job === j.id).map((r) => r.event)),
          () => `随工单 ${j.id} 收了, 这件活没有结论。`, j.owner);
        // 这张单名下还排着没投的 (held: 等前置 / 没轮上) 也不投了 —— 单都关了, 它再也轮不到
        // (注入的闸要求单还开着)。receipts.cancelHeld 同一条, 那边只做账 (T6)。
        cancelRoutes(router.rows().filter((r) => r.status === "held" && r.job === j.id).map((r) => r.event),
          () => `随工单 ${j.id} 收了, 这件排着的活没投。`, j.owner);
        // 这张单名下还排着没投的 (after 停放) 也不投了。
        events.cancel((e) => e.speaker === j.owner && e.payload.peer?.job === j.id);
        const closed = jobs.close(j.id, summary, mark)!;
        ledger.closeJob(j.id);
        // 收工结论留档到开单者名下 (与交接简报同一份 jsonl); 空工单 (没人、没结论) 不记。
        if (closed.members.length || closed.summary?.trim()) {
          const ep = jobEpisode(closed, { nameOf: episodeName, sidOf: (t) => sids.get(t) ?? "", chat: chatNameOf(cfg, j.base) || j.base });
          if (!appendEpisode(episodePath(cfg.daemon.stateDir, ep.name), ep)) log.warn({ job: j.id, name: ep.name }, "job episode not archived");
        }
        return { members: closed.members.length };
      };
      const rs = await [...cascade.map((c) => [c, `随上级单 ${id} 收工`] as const), [job, how === "cancel" ? `取消: ${(b.summary ?? "").toString()}` : (b.summary ?? "").toString()] as const]
        // 根单收工: accept = G3 验收过闸 (人认可), cancel = 取消; 非根单没有闸。
        .reduce(async (acc, [j, sum]) => [...(await acc), await closeOne(j, sum, j !== job ? undefined : how === "cancel" ? { end: "cancel" } : job.kind === "req" ? { gate: { g3: Date.now() }, end: "accept" } : undefined)], Promise.resolve([] as Array<{ members: number }>));
      json(res, 200, { ok: true, job: id, members: rs[rs.length - 1]!.members, ...(cascade.length ? { cascaded: cascade.map((c) => c.id) } : {}) });
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
      // 消项: 主键是 event, 但老行只记着件号 —— 两种写法都收 (见 pending-items 的 find)。
      // 名字 = 你派给它、还开着的那几项 (同一对再派会顶掉旧项, 通常就一项)。
      const dropKeys = drop.flatMap((v) => {
        const id = eventRef(v);
        if (isEventRef(id)) return [id];
        const who = resolvePeer(self, v.trim());
        const hit = who.ok ? ledger.openOf(self).filter((x) => x.to === who.target).map((x) => x.event) : [];
        return hit.length ? hit : [v.trim()];
      });
      const dropped = dropKeys.length ? ledger.drop(self, dropKeys, (b.why ?? "").toString().trim()) : [];
      const now = Date.now();
      const items = ledger.openOf(owner);
      if (owner === self) {
        const i = m.sessionInfo(self);
        if (i) pendingMarks.set(self, { sid: i.sessionId, ctx: i.contextTokens, ctxAtFull: i.contextTokens, drains: 0 });
      }
      const missed = dropKeys.filter((t) => !dropped.some((x) => x.event === t));
      json(res, 200, {
        ok: true,
        text: [
          ...(dropped.length ? [`已消掉: ${dropped.map((x) => `\`${x.event}\``).join(" ")}`] : []),
          ...(missed.length ? [`没找到 (不是你开着的): ${missed.join(" ")}`] : []),
          renderTable(items, liveOfEvents(), pendingNames, now, awaitingRows(owner, now), stalledRows(owner), shelvedRows(owner, now)),
        ].join("\n"),
      });
    });

    http.register("POST /jobs/list", async (req, res) => {
      const { self } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const inflight = routeInFlight();
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
          members: j.members.filter((mm) => sameBot(self, mm.target)).map((mm) => ({
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
      // owner = self; resolvePeer 已拦住别的机器人的名字, 这一道是给以后别的取 target 的路兜底。
      if (!sameBot(self, target)) { json(res, 404, { ok: false, reason: `no wizard named '.${tag}' — wizard_roster lists every name` }); return; }
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
        .filter((t) => sameBot(self, ownerOf(t)) && (!mineOnly || ownerOf(t) === self))
        .map((t) => ({
          ...renderTask(t, tasks.stateOf(t.id), now, errs[t.id]),
          address: peerAddress(cfg, self, t.target || defaultChatFor(cfg, ownerOf(t))),
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
      // 别的机器人的日程与不存在同形。
      const rec = tasks.get(id);
      if (rec && !sameBot(self, ownerOf(rec))) { json(res, 404, { ok: false, reason: `no schedule with id ${id}` }); return; }
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
      ...tierEvidence(cfg, p, tierUsage, (tier) => wizards.all().filter((w) => w.tier === tier).length, { tokens: fmtTokens, cost: fmtCost }),
      ...chatPolicyEvidence(p),
    ];

    // ── 改配置会不会动到宪章 ─────────────────────────────────────────
    // 宪章是 --append-system-prompt 压进去的, 随进程终身: 改了进宪章的配置, 已在跑的 wizard
    // 看不见, 要 handoff 重开 (重新渲染宪章) 才换上。不按字段清单判 —— 宪章读哪些配置随代码变,
    // 清单迟早漏; 改前改后各渲染一遍有会话的 wizard 的宪章, 变了的就是受影响的。
    const charterSections = (text: string): Map<string, string> =>
      new Map(text.split(/^(?=## )/m).map((sec) => [sec.split("\n", 1)[0]!.replace(/^## /, ""), sec] as const));
    // 「出生时同群的 wizard」是出生快照 (宪章自己声明名册随时可查), 且渲染途中的懒定居
    // (settleName / 自动补名写注册表) 会让前后两次渲染无辜地不同 —— 只它变不触发交接
    // (档位行同此待遇, 见 charterText 的 forDiff)。它一参与比对, 一次无关的 config_set
    // 就会把同群还活着的 wizard 全量交接一遍。
    const VOLATILE_SECTIONS = new Set(["出生时同群的 wizard"]);
    const changedSections = (a: string, b: string): string[] => {
      const x = charterSections(a), y = charterSections(b);
      return [...new Set([...x.keys(), ...y.keys()])].filter((k) => !VOLATILE_SECTIONS.has(k) && x.get(k) !== y.get(k));
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
    /** 宪章改动自动交接的时限 (写简报 + 重开), 与 /handoff 路由同档。 */
    const CHARTER_HANDOFF_MS = 600_000;
    /** 受影响的 wizard 的处理分两档:
     *  - hot: 自动交接 —— 守护进程请它写简报、原地重开 (宪章在重开时重渲染)、简报贴回;
     *    交接不成 (一直忙 / 已在交接中 / 重开失败) 才退回老规矩, 挂一条提醒让它自己 handoff。
     *  - reload: 此刻重开渲染的还是旧宪章, 自动交接无意义 —— 维持挂提醒, reload 之后它自己交。
     * 给调用方的那段话照旧回; 调用方自己受影响就直说。人发起的改动多一句「交接之前还是旧规矩」:
     * 自动交接也要等它这一轮说完才动手, 这句话仍成立。 */
    const announceCharterImpact = (c: CharterChange, hits: CharterHit[]): string => {
      if (!hits.length) return "";
      const ask = `${c.reload ? "等守护进程 reload 之后再" : ""}调 \`handoff({brief})\` 原地重开 (手上这件告一段落就交; 宪章在 handoff 时重新生成)`;
      const lag = (t: string): string => !c.byHuman ? "" : tagOfKey(t)
        ? " —— 这是人发起的改动: 交接之前你仍按旧规矩做事, handoff 之后才按新的"
        : " —— 这是人发起的改动: 交接之前你仍按旧规矩向人汇报, handoff 之后才会按新规矩汇报; 回人时说一句「交接后生效」";
      const mine = hits.find((h) => h.target === c.self);
      // 提醒照旧全机发 (各收各的); 回给调用方的名单与人数只含它看得见的 (sameBot) —— 别的机器人的 wizard
      // 连名字带个数都不报。没有调用方 (人 /name、自动补名) = 主机器人视角, 单机器人时就是全部。
      const shown = hits.filter((h) => sameBot(c.self ?? "", h.target));
      const shownOthers = shown.filter((h) => h.target !== c.self);
      if (!c.reload) {
        hits.forEach((h) => void handoffs.other(h.target, `${c.what} 改动了你的宪章 (变了的段: ${h.sections.join(" / ")}); 简报里点一句手头活在新规矩下怎么接着干`, CHARTER_HANDOFF_MS).then((r) => {
          if (!r.ok) notices.post([h.target], `${c.what} 改动了你的宪章 (系统提示, 变了的段: ${h.sections.join(" / ")}); 自动交接没做成 (${r.reason}) —— 已在跑的你看不见新规矩, 手上这件告一段落后自己${ask}${lag(h.target)}`);
        }));
        return [
          "",
          `⚠ 这次改动进了宪章 (系统提示): 已在跑的 wizard 看不见, 要 handoff 才换上。受影响 ${shown.length} 个: ${shown.map((h) => displayName(h.target)).join(" ")}`,
          ...(shown.length ? ["已自动安排它们交接 (各自写简报 → 原地重开 → 接回简报); 交接不成的会收到提醒, 再自己 handoff"] : []),
          ...(mine ? [`**你自己也在其中** (变了的段: ${mine.sections.join(" / ")}): 这一轮说完就会自动交接${lag(mine.target)}`] : []),
        ].join("\n");
      }
      const others = hits.filter((h) => h.target !== c.self);
      others.forEach((h) => notices.post([h.target], `${c.what} 改动了你的宪章 (系统提示, 变了的段: ${h.sections.join(" / ")}); 已在跑的你看不见新规矩 —— ${ask}${lag(h.target)}`));
      return [
        "",
        `⚠ 这次改动进了宪章 (系统提示): 已在跑的 wizard 看不见, 要 handoff 才换上。受影响 ${shown.length} 个: ${shown.map((h) => displayName(h.target)).join(" ")}`,
        ...(shownOthers.length ? [`已给其余 ${shownOthers.length} 个各挂一条提醒 (随它们下一条消息到), 让它们${ask}`] : []),
        ...(mine ? [`**你自己也在其中** (变了的段: ${mine.sections.join(" / ")}): 这一轮收尾后${ask}${lag(mine.target)}`] : []),
      ].join("\n");
    };
    // 所有会动宪章的写入 (config_set、人 `/name`、name_chat、自动补名) 共用这一个守卫: 写前写后各渲染一遍
    // 挂在 pane 上的 wizard 的宪章, 变了的、pane 还活着的自动交接 (hot) 或挂提醒 (reload, 见 announceCharterImpact)。
    // 快照到写完之间不能有 await —— 别人的写入插进来, 前后就对不上了。已经写了: 比对失败只少一句提醒, 不能让调用方以为没写而重发。
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

    /** 配置的调用方: 只认 sessionId / pane, 不回落 defaultChat (同 config_set 的 caller)。认不出 = "" (主机器人)。 */
    const configCaller = (b: { sessionId?: string; tmuxPane?: string }): string =>
      (b.sessionId?.trim() && m.targetForSession(b.sessionId.trim())) || (b.tmuxPane?.trim() && m.targetForPane(b.tmuxPane.trim())) || "";
    // POST /config/get —— 新 MCP 带 `path` (可空) 拿渲染好的文本; 老 MCP 带 `key` 拿 {key, value}。
    http.register("POST /config/get", async (req, res) => {
      const body = (await readBody(req)) as { key?: string; path?: string; sessionId?: string; tmuxPane?: string };
      const seen = cfgSeenBy(cfg, configCaller(body));
      if (typeof body.key === "string") { const r = legacyGet(seen, body.key); json(res, r.ok ? 200 : 400, r); return; }
      // chatPolicy.<聊天名>… 换成它指向的 principal 再查 (同 config_set 的 pinChatKeys); 认不出的原样查。
      // 名字按调用方看得见的表解析: 别的机器人的聊天名认不出, principal 写法在 seen 里也查无此键。
      const p = parsePath(body.path);
      const base = p[0] === "chatPolicy" && p[1] ? chatBaseOf(seen, p[1]) : "";
      const r = configGet(seen, sourcePath, base ? ["chatPolicy", base, ...p.slice(2)].join(".") : body.path, configEvidence);
      json(res, r.ok ? 200 : 400, r);
    });

    // POST /config/set —— 口令门见 `guarded`。分级在这里而不在 hook: `card` 项由守护进程
    // 自己推确认卡, 所以 danger.skipAll / ⏱窗口 都放不掉它。卡等 CONFIRM_INLINE_MS 还没人点
    // 就先回 pending (fetch 默认 5 分钟收不到头就断), 卡仍有效, 迟到的确认照常落盘并捎一句给调用方。
    http.register("POST /config/set", guarded(async (req, res) => {
      const body = (await readBody(req)) as SetReq & { key?: string; action?: string; sessionId?: string; tmuxPane?: string; target?: string };
      const legacy = typeof body.key === "string";
      const asked = legacy ? fromLegacy(body.key!, body.value, body.action) : body;
      if ("ok" in asked) { json(res, 400, asked); return; }
      const ask = pinChatKeys(cfg, asked, configCaller(body));
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
      const caller = resolveSelf({ sessionId: body.sessionId, tmuxPane: body.tmuxPane }) || undefined;
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
      // 节点是 base 下的 tag, 构造上与调用方同机器人; 这一道防的是 tag 里夹带别的机器人的 key。
      const xnode = spec.nodes.find((n) => !sameBot(self, keyOf(spec.base, n.tag)));
      if (xnode) { json(res, 400, { ok: false, reason: `node.tag \`${xnode.tag}\` 不是一个合法的 tag` }); return; }
      const allowed = (target: string, name?: string): boolean => planStore.allowExternal(target, name) && planStore.allowExternal(target, wizards.get(target)?.name);
      if (spec.nodes.some((n) => !allowed(keyOf(spec.base, n.tag), n.tag))) { json(res, 409, { ok: false, reason: "workflow plan reserves a graph executor" }); return; }
      const graphLog = log.child({ mod: "graph", base: spec.base });
      // 每一步、每条进度都在发起这次 run 的那一轮的频道里: 人在群里叫它发起的才进群,
      // 私聊轮里发起的整场只进 rolepage —— 步骤不带频道就等于在节点的 home 群里开口。
      const channel = m.currentChannel(self);
      const run = startGraph(spec, {
        // Reuse a live tagged pane; only spawn when the node doesn't exist yet
        // (or its pane died). Re-spawning a healthy node would throw away the
        // context that makes a multi-round loop worth running.
        ensureNode: async (target, node) => {
          if (!allowed(target, node.tag)) return { ok: false, reason: "workflow plan reserves this executor" };
          const existing = (await m.peers(target)).find((p) => p.target === target);
          if (!allowed(target, node.tag)) return { ok: false, reason: "workflow plan reserves this executor" };
          if (existing?.paneAlive) return { ok: true };
          // No broadcast plumbing needed: a `base#tag` target strips down to the
          // same WeCom chatid as `base`, so the node's own pushes already land
          // in this chat — mirroring them again was pure duplication.
          const r = await m.newSession(target, node.tag, node.cli, { model: node.model, cwd: node.cwd, silent: true, guard: () => allowed(target, node.tag) });
          return { ok: r.ok, reason: r.reason };
        },
        send: async (target, text, origin) => {
          if (!allowed(target)) return { ok: false, reason: "workflow plan reserves this executor" };
          await handedOff(target);
          if (!allowed(target)) return { ok: false, reason: "workflow plan reserves this executor" };
          return m.injectText(target, text, origin, { channel, guard: () => allowed(target) });
        },
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
      const body = (await readBody(req)) as Partial<{ runId: string; target: string; sessionId: string; tmuxPane: string }>;
      const runId = (body.runId ?? "").trim();
      if (!runId) { json(res, 400, { ok: false, reason: "runId required" }); return; }
      // 别的机器人那边跑的流水线与不存在同形。
      const run = getRun(runId);
      if (run && !sameBot(resolveSelf(body), run.base)) { json(res, 404, { ok: false, reason: `run ${runId} not found or already finished` }); return; }
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
    /** 定时任务开一轮: 它要替这个 target 在群里说话 (非 quiet) → 开一条根行; 私下跑的不开 (§3.1)。
     *  这一枪的注入没有消息事件, 所以件号→行的桥要自己记 (servesOfTurn 的兜底)。 */
    const openTaskRow = (target: string, taskId: string, event: string, quiet: boolean): void => {
      if (quiet) return;
      openRow({ event, owner: target, deadlineAt: deadlineOf(Date.now()),
        receiver: { kind: "chat", channel: baseOfKey(target), message: `task:${taskId}:${event}` } });
    };
    scheduledTaskInject = async (target, text, opts) => {
      const { taskId, fresh, quiet } = opts;
      const owner = ((r) => (r ? ownerOf(r) : target))(tasks.get(taskId));
      if (!sameBot(owner, target)) return { ok: false, reason: `日程 ${taskId} 的目标与排班者归不同的企微机器人, 不跨机器人放枪` };
      const allowed = () => opts.guard() && planStore.allowExternal(target, wizards.get(target)?.name);
      return deliverScheduled({ ...opts, guard: () => opts.guard() && (fresh || allowed()) }, {
        postponeMs: TASK_POSTPONE_MS,
        handedOff: () => handedOff(target),
        idleNow: () => m.idleNow(target),
        untilIdle: (timeoutMs, aborted) => m.untilIdle(target, timeoutMs, { aborted }),
        named: async (live) => {
          const guard = () => live() && allowed();
          if (!guard()) return { ok: false, reason: "scheduled target permission withdrawn" };
          const at = Date.now();
          const turn = newRootEvent();
          // Confirm idle inside the physical pane transaction; a race is unsent
          // and returns to the target consumer, without releasing task dedup.
          if (quiet) quietRelays.set(turn, { target, at, base: baseOfKey(target) });
          openTaskRow(target, taskId, turn, quiet);
          const inj = await m.injectText(target, text, undefined, quiet
            ? { guard, requireIdle: true, from: { kind: "task", taskId }, channel: "", envelope: renderTaskEnvelope(taskId, { event: turn }) }
            : { guard, requireIdle: true, fromChat: true, from: { kind: "task", taskId }, envelope: renderTaskEnvelope(taskId) });
          if (inj.ok && quiet) void relayUnlessQuiet(target, at, turn, baseOfKey(target));
          return inj;
        },
        runner: (busy, live) => !fresh && !allowed()
          ? Promise.resolve({ ok: false, reason: "scheduled target permission withdrawn" })
          : runTaskInRunner(target, text, taskId, quiet, busy, live),
      });
    };
    /** 安静任务那一轮的终句: 它私下跑, 镜像不推; 等它这一轮跑完, 终句不是 `QUIET` 就替它
     *  发进群 (头写它的名字, 人知道是谁说的)。按信封件号定位答句 (同回执): 按时刻取会把紧随
     *  其后的私聊 / 人话那一轮的答案当成它的, 把私下内容发进群。 */
    const relayUnlessQuiet = async (t: string, at: number, turn: string, base: string): Promise<void> => {
      quietRelays.set(turn, { target: t, at, base });
      const end = at + TASK_QUIET_WAIT_MS;
      // 先等它动起来: 刚注入时注册表还报 idle。
      await sleep(5000);
      let firstObservation = true;
      while (firstObservation || Date.now() < end) {
        firstObservation = false;
        if (Date.now() < end) await m.untilIdle(t, end - Date.now());
        const reply = (m.replyToPeer(t, "", at, turn)?.text ?? "").trim();
        if (reply && (await m.idleNow(t))) {
          const text = stripForChat(reply); // 进群的转发不带收口标记 / ARTIFACT 行
          if (text && !isQuiet(reply)) {
            const eventId = `quiet:${t}:${turn}`;
            const revision = finalId(eventId, base, text);
            events.delivery({ id: finalId(eventId, base, revision), eventId, target: t, turn, channel: base,
              revision, body: text, chunks: m.formatFinal(t, turn, base, text) });
          }
          log.info({ target: t, quiet: isQuiet(reply), len: reply.length }, "quiet task: 一轮结束");
          quietRelays.drop(turn);
          return;
        }
        await sleep(5000);
      }
      log.warn({ target: t }, "quiet task: 等满仍没收口, 不转发");
      quietRelays.set(turn, { target: t, at, base, reason: "deadline passed; final not observed, retained for reconciliation" });
    };
    // 落盘: 这个仓库里 reload 是常态, 守在内存里的那一轮一 reload 就既不转发也不说 QUIET 了。
    const quietRelays = loadJsonMap<{ target: string; at: number; base: string; reason?: string }>(
      join(cfg.daemon.stateDir, "quiet-relays.json"), undefined, { strict: true },
    );
    void m.restored.then(() => Object.entries(quietRelays.all()).forEach(([turn, r]) => void relayUnlessQuiet(r.target, r.at, turn, r.base)));
    /** 到点起一个白板 wizard 执行这一枪, 跑完自动收掉。 */
    const runTaskInRunner = async (target: string, text: string, taskId: string, quiet: boolean, busy: boolean, guard: () => boolean): Promise<ScheduledResult> => {
      if (!guard()) return { ok: false, reason: "scheduled runner withdrawn" };

      // 执行体挂在日程的主人名下: 名字 `<主人>-task-xxxx`, parent = 主人 —— 它的
      // rolepage 里看得见这一枪是谁的日程放的。落在执行目标的群/目录里。
      const base = baseOfKey(target);
      const rec = tasks.get(taskId);
      const owner = rec ? ownerOf(rec) : target;
      const ownerName = settleName(wizards, chatNameOf(cfg, owner), owner) || "task";
      const slotR = await claimSlot(base, "", `${ownerName}-task-${taskId.slice(0, 4)}`);
      if (!guard()) return { ok: false, reason: "scheduled runner withdrawn during slot selection" };
      if (!slotR.ok) return { ok: false, reason: "起白板 wizard 失败: 挑不出槽位" };
      const runner = slotR.target;
      const allowed = () => guard() && planStore.allowExternal(runner, wizards.get(runner)?.name);
      if (!allowed()) return { ok: false, reason: "workflow plan reserves task runner" };
      const info = m.sessionInfo(target);
      const why = busy ? ` (起因: ${displayName(target)} 当时正忙)` : "";
      wizards.upsert(runner, {
        description: `定时任务 ${taskId} 的一次性执行体${why}`,
        parent: owner,
        voiceOf: owner,
        bornAt: Date.now(),
      });
      const runnerName = wizards.rename(runner, `${ownerName}-task-${taskId.slice(0, 4)}`);
      const spawned = await m.newSession(runner, runnerName, info?.cli, { cwd: info?.cwd, model: info?.model, silent: true, guard: allowed });
      if (!spawned.ok) {
        wizards.drop(runner);
        return { ok: false, reason: `起白板 wizard 失败: ${spawned.reason ?? "unknown"}` };
      }
      if (!allowed()) {
        if (m.sessionInfo(runner)?.sessionId === spawned.sessionId) { await m.killPane(runner); wizards.drop(runner); }
        return { ok: false, reason: "scheduled runner withdrawn after spawn" };
      }
      if (!quiet) {
        notifyChat(base, withTagHeader(target, busy
          ? `⏰ 定时任务到点时正忙, 已起白板 wizard .${runnerName} 单独执行, 完成后自动收掉`
          : `⏰ 定时任务已起白板 wizard .${runnerName} 执行, 完成后自动收掉`));
      }
      const at = Date.now();
      const turn = newRootEvent();
      if (quiet) quietRelays.set(turn, { target: runner, at, base });
      openTaskRow(runner, taskId, turn, quiet);
      const inj = await m.injectText(runner, text, undefined, quiet
        ? { guard: allowed, from: { kind: "task", taskId }, channel: "", envelope: renderTaskEnvelope(taskId, { event: turn }) }
        : { guard: allowed, fromChat: true, from: { kind: "task", taskId }, envelope: renderTaskEnvelope(taskId) });
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
      const spawned = await m.newSession(target, name, undefined, { cwd: memoryRoot(cfg.daemon.stateDir), silent: true });
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
        const cwd = cwdOfMd(stateDir, md, cwds, ["", ...cfg.bots.map((b) => b.id)]);
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
    // 没写 target 的日程兜底到排班者那个机器人的默认聊天 (副机器人没配就不放枪, 不冒用主机器人)。
    fallbackTarget: (t) => defaultChatFor(cfg, t.owner),
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
          .map((t) => wizardStore()?.get(t.owner)?.target ?? wizardStore()?.byName(t.owner)?.target)
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
    // 定时清扫: 无绑定孤儿 (restore 丢绑定留下的老 window) 不靠 spawn 也会攒, 只在
    // onSpawn 数等于没人收。绑定在 store 里启动即读, 新生 pane 有 ORPHAN_GRACE 宽限,
    // 所以启动后扫一次是安全的。
    const periodSec = cfg.wrc.mirror.paneSweepSec;
    if (periodSec > 0) {
      const timer = setInterval(() => void sweep().catch((e) => log.warn({ err: (e as Error).message }, "pane cap sweep failed")), periodSec * 1000);
      timer.unref();
    }
    setTimeout(() => void sweep().catch((e) => log.warn({ err: (e as Error).message }, "pane cap sweep failed")), 15_000).unref();
  }

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutdown signal");
    events.stop();
    stopSweep();
    scheduler.stop();
    steward?.stop();
    tasks.stop();
    netWatch.stop();
    await wx.stop().catch(() => undefined);
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
  http.register("POST /shutdown", (_req, res) => {
    json(res, 200, { ok: true });
    return shutdown("HTTP");
  });
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
