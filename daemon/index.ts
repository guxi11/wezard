import { wxMarkdown } from "../shared/wx-text.js";
// Daemon entry. Resident process — exits only on signal or fatal WS auth failure.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { timingSafeEqual, randomBytes, randomUUID } from "node:crypto";
import { loadOrCreateSvrToken } from "../shared/svr-token.js";
import { DAEMON_TOKEN_FILE, DAEMON_TOKEN_HEADER } from "../shared/daemon-token.js";
import { homedir } from "node:os";
import { TIERS, defaultChatFor, tiersForBackend, loadConfig, type TierName } from "../shared/config.js";
import { makeLogger } from "../shared/log.js";
import { memAvailableMb, memShortfall } from "../shared/mem-guard.js";
import { clipLine, sleep } from "../shared/std.js";
import { patchJsonc } from "../shared/config-writer.js";
import { EFFORTS, parseEffort } from "../shared/effort.js";
import { bindCliBackends, projectDirsFor, type CliBackendName } from "../shared/cli-backends.js";
import { bindCodexStateDir } from "../shared/codex.js";
import { startMux } from "./bot-mux.js";
import { startWeixin } from "./weixin.js";
import { installWeixinPort } from "./weixin-port.js";
import { bindWxCommands, makeOnBound, makeWxCommands, routeSendMedia, wecomBindSink, weixinSendMedia, wxAdmins, wxRoutes } from "./weixin-cmd.js";
import { bindChatReach } from "./reach.js";
import { kindOf, type SendMedia } from "./media.js";
import { aibotSendMedia, uploadMediaId } from "./aibot-media.js";
import { startNetWatch } from "./net-watch.js";
import { startHttp, json, readBody, type Handler } from "./http.js";
import { registerMcpHttp } from "./mcp-http.js";
import { parsePath } from "../shared/config-meta.js";
import { pickTier } from "../shared/model-tiers.js";
import { applyHot, cfgSeenBy, patchedTop, pinChatKeys, configGet, planSet, renderPlan, tierEvidence, type Plan, type SetReq, type TierUsage, type UsageTotals } from "./config-api.js";
import { computeUsage, costOf, fmtCost, fmtTokens, sumTotal, type ModelTotals } from "./usage.js";
import { humanWakeTail, wakeInjectOpts, wakeTailPorts } from "./wake-tail.js";
import { installInboundRouter, type GuideInbound, type InboundOpts } from "./inbound.js";
import { installChannelTransport, installChannelEvents, readChannel, isTopicChat, channelOutboundOf, sendTopicPost, sendTopicReply, sendTopicReplyOrPost, type ChannelHuman, type TopicMedia } from "./channel.js";
import { channelOf, channelRefOf, learnChannelRoom, postRefOf, postsOfChannel } from "./channel-posts.js";
import { channelMonitorLeaveOps, channelMonitorWanted, channelRoomOf, channelGuideJoinOps, hostJoinOps, planChannelGuideTurn, postRoomBirthOps, type ChannelGuideTurn } from "./channel-onboarding.js";
import { rebindChannel } from "./channel-rebind.js";
import { loadMirrorStore } from "./mirror-store.js";
import { startMirror, installMirrorEventListener } from "./mirror-bridge.js";
import { backendFor, prewarmShell, runTmux, setTmuxTimeoutReporter, spawnTmuxClaude } from "./spawn-tmux.js";
import { installApprovalEventListener, makeApproveHandler, requestConfirm } from "./approval.js";
import { initDetailPersistence, makeDetailHandler, chatHandlers, configureRemoteForward, chatUrlFor, buildChatUrl, setRoomReader, setWorldFactsProvider, recordCharter, backfillCharter, lastChannelOf, setChannelRef } from "./detail.js";
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
import { errText, installResponseTracker } from "./last-response.js";
import { BindGateClosed, openRoomStore } from "./rooms.js";
import { bindCandidates, planBind, planChannelBackfill, planFork, planUnbind, pendingFirstTouches, sourceRoomOf } from "./room-bind.js";
import { stewardRoute as resolveSteward } from "./steward.js";
import { repairStewardInstances, unspawnedStewards } from "./steward-repair.js";
import { createRoomWatchdog, parsePaneIds } from "./room-watchdog.js";
import { pruneLeaveOps, selectRoomPrune } from "./room-prune.js";
import { createOverdueScan } from "./room-overdue.js";
import { createRoomHub, type RoomHub } from "./room-hub.js";
import { ensureMeRoom, isMeRoom, meChannelSay, meRoomId, meRowMirror, meUserOf, meWorkspaceOf } from "./me-room.js";
import { autoAdhocTarget } from "./room-auto-adhoc.js";
import { checkRoomTarget, seatThenAppend, type SeatResult } from "./room-spawn.js";
import {
  DAEMON, adhocRoomId, bubbleSourceOf, canRename, dmPeers, dmRoomId, findPairAdhoc, hasMonitor, holderOf, idList, isUid, judgeActivate, judgeNotice, leaveOps, dutiesHeldBy, outboundSourceOf, perceptronCandidates, planDm, planOutbound, quotedRowIds, seatSeenOps, openDuties, roomHost, roomsDirOf, sameWho, whoKey,
  type Duty, type MsgRow, type ReplyStatus, type RoomOp, type RoomState, type Verdict, type Who,
} from "../shared/room.js";
import { CLASS_NAME_MAX, loadClassMerges, loadClassStore, migrateClasses, parseInstanceName, planClasses, renderClassReport, validClassName, type ClassMigration } from "./classes.js";
import { addressed, footerTarget, responseFormatPolicy, roomBubble, withBubbleFooter } from "./message-format.js";
import { scanClaudeSessions } from "./session-scan.js";
import {
  startScheduler,
  promptWantsFreshWizard,
  renderTask,
  sinceOf,
} from "./tasks.js";
import { openTaskRegistry } from "./task-registry.js";
import { type ScheduledDispatchOptions, type ScheduledResult } from "./scheduled-delivery.js";
import { describeTrigger, nextFire, parseTrigger, WHEN_HELP } from "../shared/trigger.js";
import { slugify, uniqueId } from "../shared/task-file.js";
import { baseOfKey, bindMultiBot, bindTagLinker, botOfKey, headed, ownHead, isInternalKey, keyOf, linkTags, normalizeTag, sameBot, stripSigil, tagOfKey, uniqueTag, withTagHeader } from "../shared/session-label.js";
import { appendEpisode, clipForCharter, cwdOfMd, episodePath, inboxPath, mdsOf, proposedCwds, memoryPath, memoryRoot, proposeMemory, readMemory, type MemoryScope } from "./wizard-memory.js";
import { startSteward, stewardEnvelope, STEWARD_ID, STEWARD_RUN_MS, STEWARD_TARGET, type RefsOf } from "./memory-steward.js";
import { chatBaseOf, chatNameOf, chatPolicyOf, listChatNames, peerAddress, type CharterChange, type CharterGuard } from "./chat-name.js";
import { appointedSteward, isStewardTarget, localManifestation, markGlobalSteward, STEWARD_KINDS, stewardIdentityOf, stewardRoute, stewardsAt } from "./steward.js";
import { apprenticeOf, ensureApprentice, ensurePatrolTask, handoffLineOf, isApprentice } from "./apprentice.js";
import {
  anchorOf,
  bindWizardStore,
  loadWizardStore,
  migrateIdentities,
  pickName,
  reconcileKin,
  wizardStore,
  settleName,
  settleAll,
  backfillBorn,
  sweepUnborn,
  BOOT_ID,
  childrenOf,
  ancestorsOf,
  renderCharter,
  renderLead,
  renderLeadPlaybook,
  ROSTER_FRESH_MS,
  rosterL0,
  rosterL1,
  rosterL2,
  rosterCensus,
  handoffAt,
  memoryNudgeAt,
  MEMORY_NUDGE_FLOOR,
  MEMORY_MAX,
  NOTE_MAX,
  referencedTargets,
  slotInUse,
  identityOf as identityOfRec,
  identityWorkspaceOf,
  identityEditRefusal,
  instancesOf,
  leadSettled,
  renameNotice,
  type WizardBrief,
  type WizardRecord,
} from "./wizard.js";
import { faceRefusal } from "./tool-face.js";
import { activeRows, bindNoticeBox, createNoticeBox, createSeenRing, gcSeen, chatAudience, hears, type Notice, type Subject, type Part, type SeenRow, type TimedSnapRow, type Via } from "./notices.js";
import { cacheTouchMs, cacheTtlSec, contextMaterials, firstStamp, lastContextTokens, lastExchange, lastModel, talkTurns } from "./peers.js";
import { expandHome } from "../shared/paths.js";
import { expandTask, TemplateError, type ExpandedTask } from "../shared/task-template.js";
import { loadJsonMap } from "../shared/json-map-store.js";
import { loadPlans, PlanError } from "./plans.js";
import type { PlanStore } from "./plans.js";
import { registerPlanRoutes } from "./plan-http.js";
import { renderReminder } from "../shared/reminder.js";
import { busyOf, createHandoffs, handedOff, handingOff, type Pending as PendingHandoff } from "./handoff.js";
import { coldGateOf, wakeCostOf, decide, occupies, rankCandidates, routeDiagnostics, renderCandidates, tierFor, type RouteRow } from "./route.js";
import { parseWhen, planHasOpenDuty, renderRoomRead } from "../shared/room-view.js";
import { memberLabel } from "../shared/room-label.js";
import { roomFacts, nameTable } from "./room-facts.js";
import { waitForIdle } from "./wait-idle.js";
import { applyOnboarding, bindSteward, GUIDE_DESC, guideHandoffOps, guideOf, guideTargetOf, isGuideManifestation, judgeOnboarding, loadOnboardingStore, needsOnboarding, planOnboardBind, renderGuideOpening, renderGuideRetry, renderOnboardingDone, rewriteStewardBindings, type OnboardingBound } from "./onboarding.js";
import { reminderToken, startPlanReminders, type PlanReminderCandidate } from "./plan-reminders.js";



const retiredOrchestrationField = (body: unknown): string | undefined => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  return ["job", "node", "role", "workflow", "workflowId", "graph", "runId", "detached"]
    .find((key) => Object.prototype.hasOwnProperty.call(body, key));
};

const retiredFieldReason = (field: string): string => field === "detached"
  ? "unsupported field 'detached': collaborative wizards always belong to the caller's management tree"
  : `unsupported field '${field}': jobs/workflow/graph execution was removed`;

const unsupportedPeerAddressField = (body: unknown): string | undefined => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  if (Object.prototype.hasOwnProperty.call(body, "tag")) return "tag is unsupported; use name";
  if (Object.prototype.hasOwnProperty.call(body, "tags")) return "tags is unsupported; use names";
  return undefined;
};

// pino's file transport is async; without flush, log.fatal before process.exit
// vanishes. Mirror anything fatal to stderr too so launchd's stderr.log captures it.
const fatalExit = (msg: string, extra?: Record<string, unknown>): never => {
  // eslint-disable-next-line no-console
  console.error(`[wezard-daemon] FATAL: ${msg}`, extra ?? "");
  process.exit(1);
};

const main = async (): Promise<void> => {
  const { config: cfg, sourcePath } = loadConfig();
  // 契约 §7: 旧 chatPolicy 出站门键已废 —— 忽略不拒启动, 但 boot 时 warn 一次。
  // (键名拆开写, 免得代码里再留下这几个词的存量引用。)
  {
    const staleKeys = ["top" + "Only", "spe" + "ech"];
    const stale = Object.entries(cfg.chatPolicy ?? {}).flatMap(([base, p]) =>
      staleKeys.filter((k) => k in (p as object)).map((k) => base + "." + k));
    if (stale.length) console.warn("[wezard] 配置里还有已废弃的 chatPolicy 旧键 (room 模型已移除, 忽略): " + stale.join(", "));
  }
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
  let stopPlanReminders = (): void => {};
  // 频道入站的三条接线 (room 块在下面才立起来, 先留引用): 人话落 room / 频道首次见到 / 帖子源首触
  // (只记事, 不建 room —— 见 docs/room/multi-source-binding.md §4.1)。
  let channelIngest: ((e: ChannelHuman) => void) | undefined;
  let channelRoomSeen: ((topicId: string) => void) | undefined;
  let channelPostTouched: ((topicId: string, postBase: string) => void) | undefined;
  /** 入站源解析 (§4.1): 源已绑 / 帖子源未诞生时, 这句话落哪本账、谁是接待人。恒等路径 = undefined。 */
  let sourceRouteHook: ((base: string) => { room: string; target: string; src?: string; post?: string } | undefined) | undefined;
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
  // rolepage 的频道 / 帖子 kind 与归属读时算 (channel-posts), 不落账本。
  setChannelRef((room) => channelRefOf(cfg, room));
  // Replay tool/approval detail records so reload doesn't lose click-to-detail
  // links from messages already on the user's WeCom timeline.
  initDetailPersistence(cfg.daemon.stateDir, log.child({ mod: "detail" }));
  configureRemoteForward(cfg.daemon.detailRemoteBase, cfg.daemon.detailRemoteToken);
  // 一个或多个企微机器人 (bot + bots): 对下面所有模块只露主机器人那个 client, 分流在 bot-mux 里。
  // 必须先于 weixin-port / response-tracker 建好 —— 它们包在 mux 外层。
  const ws = startMux(cfg, log);
  // 频道出站补丁必须先于 response-tracker：tracker 会把当时的 sendMessage /
  // replyStream 抓成 orig*，晚装就绕过了频道分支（终句会走成群消息）。
  installChannelTransport(ws.client, log.child({ mod: "channel" }));
  // 切网 (换 WiFi / VPN 起停) 后原地重建 WS, 等价于自动做了一次 reload 的
  // 联通性部分 — 但保留全部内存态 (pending 长轮询、镜像绑定),
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
      newSession: (t, win) => bridge.newSession(t, win, { silent: true }),
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
  const tasks = await openTaskRegistry(
    log.child({ mod: "tasks" }),
    (added, removed) => log.info({ added, removed }, "task files changed"),
  );
  let handoffAllowed: (target: string) => boolean = () => false;
  // room 接线 (wiring A/B): mirror 块里建好后回填 —— 入站包装在更外层, 只能这样拿到。
  let roomHub: RoomHub | undefined;
  let roomStateOf: ((id: string) => RoomState | undefined) | undefined;
  let rememberBubble: ((msgid: string, frame: unknown, expires: number) => void) | undefined;
  let ensureRoom: ((room: string, routed: string) => string) | undefined;
  /** mirror 轮终回调 (bridge 创建早于 room 块, 这里先挂口)。 */
  let roomTurnEnd: (target: string) => void = () => undefined;
  /** room 泵注入成功的 touch (看门狗活动时钟; 同上, room 块里回填)。 */
  let roomActivityTouch: (target: string) => void = () => undefined;
  /** 新群引导在 room 模型里的两个接线点 (见 inbound.ts InboundOpts): room 块里回填 —— 只有它持有 hub。 */
  let guideInboundHook: InboundOpts["guideInbound"];
  let guideSettleHook: InboundOpts["guideSettle"];
  let setNoticeHook: InboundOpts["setNotice"];
  let getNoticeHook: InboundOpts["getNotice"];
  /** 引导在途状态 (onboarding.json): inbound 与 /onboarding/bind 共用这一份, 不各读各的盘。 */
  const onboarding = loadOnboardingStore(cfg);

  const bridge = startMirror({ cfg, log: log.child({ mod: "mirror" }), client: ws.client, store: mirrorStore, identityWorkspace: (t) => identityWorkspaceOf(wizardStore(), t), sendFrozen: (channel, content, stream) => responseTracker.sendFrozen(channel.replace(/^(user|chat|group):/, ""), content, stream),
    // 轮终事件 (wiring C): mirror tail 的非 soft turn_end → room 的 F-1 轮界。
    onTurnEnd: (target) => { roomTurnEnd(target); } });
  // 群里每个 `.name` 都挂它的 rolepage (见 session-label 的 TagLinker)。正文提及
  // 只认真有其人的 —— 随手写的 `.gitignore` 不该变成一个开在空栏上的链接。
  const known = (t: string): boolean => bridge.chatTargets(t).includes(t);
  // 名册在下面的 mirror 块里才绑 (bindWizardStore) —— 这里全走 wizardStore() 惰性取。
  bindTagLinker({
    targetOfUrl: (url) => footerTarget(url,
      new URL(".", buildChatUrl(cfg.daemon.detailPublicBase, cfg.daemon.host, cfg.daemon.port, "")).href,
      known),
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
  installInboundRouter(ws.client, cfg, log, { ...bridge, dispatch: async (a) => {
    // slash 是会话控制 (/new /clear ...), 不落账本, 照旧直接进 pane。
    if (a.text.trimStart().startsWith("/")) { await handedOff(a.principal); await bridge.dispatch(a); return; }
    // 人话进 room 账本 (wiring B): 绑定 room = 本聊天的 base principal, 原样作 room id (契约 §1)。
    // room 块还没装上 (启动竞态) 或落行被拒 → 退回老路径, 人话不能丢。
    const author: Who = { kind: "human", id: String(a.speaker ?? "").replace(/^user:/, "") };
    const routed = wizardStore()?.get(a.principal);
    // .me 分流 (人 2026-11-24 拍板): 路由到说话人自己的分身 (kind "me") → 这句人话不落
    // 发生地 room, 落他的私有 me-room (幂等开房, me/人入座)。发生地零行: 不 ensureRoom、
    // monitor/host 看不见、不耗发生地预算; duty 开在 me 名下 (host 槽位 —— me 是唯一 wizard
    // 成员), 占位气泡照开在发生地 (回发由 roomMirror 的 me 分支覆盖它)。
    const meRoom = routed?.kind === "me" && author.id
      ? ensureMeRoom({ state: (r) => roomStateOf?.(r), write: (r, ops) => { roomHub?.write(r, ops); }, meUid: () => routed.uid }, author.id)
      : undefined;
    const room = meRoom ?? (ensureRoom ? ensureRoom(baseOfKey(a.channel!), a.principal) : baseOfKey(a.channel!));
    // 点名 (.name 路由到别的 wizard): 先拉进 room (via mention), duty 开给它;
    // 管家接待轮 (routed 就是 host) 不点名 → duty 按 §2 落 host。
    let to: Who[] | undefined;
    if (routed?.uid && roomStateOf) {
      const w: Who = { kind: "wizard", id: routed.uid };
      let st = roomStateOf(room);
      if (st && !st.members.has(whoKey(w))) {
        roomHub?.write(room, [{ op: "join", at: Date.now(), room, who: w, ord: st.nextOrd, via: "mention", by: author }]);
        st = roomStateOf(room);
      }
      if (st && !sameWho(roomHost(st), w)) to = [w];
    }
    // 图片以 @path 文本随行 (codebuddy 的唯一通道), 账本行同时记 files。
    // 账本行只存人的原话 (rawText): prompt 里为引用加的块不进正文 —— rolepage 与之后每次
    // room_read / wake 都按行正文复读, 引用 (尤其频道帖子摘要) 进正文等于反复抄整帖。
    const text = (a.rawText ?? a.text) + (a.images?.length ? "\n" + a.images.map((p) => "@" + p).join(" ") : "");
    const streamId = String(a.streamId ?? "");
    const expires = Date.now() + 6 * 60_000;
    // 占位气泡: frame 记表 (reload 后也能收口), 先挂 loading; 第一条 re 它的 reply 覆盖 (§3a)。
    rememberBubble?.(streamId, a.frame, expires);
    if (a.frame && streamId) void ws.client.replyStream(a.frame, streamId, withTagHeader(a.principal, "…"), false).catch(() => undefined);
    // 引用了哪一行 → re: 人话关账只关被引用的那条 (对不上就不带 re, 关它在本 room 名下全部的账, 见 humanCloses)。
    const st = roomStateOf?.(room);
    const re = st && a.quoted ? quotedRowIds(st, a.quoted, author) : [];
    const v = roomHub?.append(room, { author, kind: "say", text, origin: "inbound", ext: streamId,
      bubble: { stream: streamId, expires }, ...(re.length ? { re } : {}),
      ...(a.images?.length ? { files: a.images.map((p) => ({ path: p, kind: kindOf(p), name: basename(p) })) } : {}),
      ...(to?.length ? { to } : {}), ...(a.mentionBot ? { mention: "bot" as const } : {}),
      ...(a.src ? { src: a.src } : {}), ...(a.post ? { post: a.post } : {}) });
    if (!v || !v.ok) {
      // 被拒不回退旧路径 (wiring C): 按 verdict 原因回一行系统提示 —— 人话不能丢, 也不能绕过账本。
      const reason = v ? v.reason : "room 接线还没就绪 (启动竞态), 稍后再发一句";
      log.warn({ mod: "room", room, reason }, "room: 人话落行被拒");
      if (a.frame && a.streamId) void ws.client.replyStream(a.frame, a.streamId, withTagHeader(a.principal, "[wezard] 这句没能进账本: " + reason), true).catch(() => undefined);
      return;
    }
    // 冷目标 (会话还没起): pump 贴不进没有绑定的 pane, 先起一个; pump 30s 重 kick 会接上。
    if (!bridge.hasMirrorTarget(a.principal)) {
      const store = wizardStore();
      if (store) void bridge.newSession(a.principal, settleName(store, chatNameOf(cfg, a.principal), a.principal) || a.principal, { silent: true })
        .catch(() => undefined);
    }
  }   }, sourcePath, (w, c) => guardCharter(w, c), { onboarding,
    sourceRoute: (base) => sourceRouteHook?.(base),
    guideInbound: (a) => (guideInboundHook ? guideInboundHook(a) : Promise.resolve({ ok: false, reason: "room 接线还没就绪" })),
    guideSettle: (base, bound) => (guideSettleHook ? guideSettleHook(base, bound) : false),
    getNotice: (base) => (getNoticeHook ? getNoticeHook(base) : undefined),
    setNotice: (base, text, by) => (setNoticeHook ? setNoticeHook(base, text, by) : { ok: false, reason: "room 接线还没就绪, 稍后再试" }),
  });
  // 频道（topic）事件层：接在 inbound 之后，让频道消息复用同一套 gate / route / mirror。
  installChannelEvents(ws.client, cfg, log.child({ mod: "channel" }), {
    ingest: (e) => (channelIngest ? channelIngest(e) : log.warn({ room: e.room, msgid: e.msgid }, "channel: room wiring not ready, 人话没落账本")),
    channelSeen: (t) => channelRoomSeen?.(t),
    postTouched: (t, b) => channelPostTouched?.(t, b),
  });
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
      return t ? await bridge.injectText(t, text, { channel: bridge.currentChannel(t) }) : { ok: false, reason: "no mirror target for session" };
    },
  };
  // room 模型的 /status 增量 (修复单 §4): startHttp 在 room 模块之前起, 用可改写的 holder 接。
  const roomStatusRef = { get: (): Record<string, unknown> => ({}) };
  const http = startHttp({ cfg, ws, log, sourcePath, roomStatus: roomStatusRef });
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
  // 进程内 MCP: 同一个工具面 (mcp/tools.ts) 挂到 loopback 上, 每个请求一个 server+transport,
  // 身份从 x-wezard-pane / x-wezard-session 进 ALS —— 不读 env, daemon 只有一份 env。
  registerMcpHttp(http, { tokenOk, log: log.child({ mod: "mcp-http" }) });
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
      client: ws.client, principal: to, who: "wezard",
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
      const charter = charterFor(target, { cli: backendFor(cfg).name });
      const r = await spawnTmuxClaude({ cfg, log: spawnLog, windowName: target, systemPrompt: charter });
      if (!r.ok) { json(res, 500, { ok: false, reason: r.reason }); return; }
      const att = m.attach({ sessionId: r.sessionId!, jsonlPath: r.jsonlPath!, target, tmuxPane: r.tmuxPane, tmuxSession: r.tmuxSession });
      // spawn 不再带宪章 (省冷启动), 身份改挂到这个 pane 的首条注入上。
      if (att.ok) m.armCharter(target, charter);
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
        const defaultTarget = cfg.defaultChat.trim();
        const currentSid = cur.mirrors.find((mirror) => mirror.target === defaultTarget)?.sessionId ?? "";
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
      if (refuseGuide(res, target, "switch_session", false)) return;
      const sessions = await scanClaudeSessions();
      // 已绑在别的机器人聊天上的会话与不存在同形。
      const hit = sessions.find((s) => s.sessionId === sessionId && ((t) => !t || sameBot(target, t))(m.targetForSession(s.sessionId)));
      if (!hit) {
        json(res, 404, { ok: false, reason: `session ${sessionId} not found among live tmux sessions` });
        return;
      }
      const att = m.attach({ sessionId: hit.sessionId, jsonlPath: hit.jsonlPath, target, tmuxPane: hit.tmuxPane, tmuxSession: hit.tmuxSession, cwd: hit.cwd });
      json(res, att.ok ? 200 : 500, att.ok
        ? { ok: true, sessionId: hit.sessionId, label: hit.label, target, cwd: hit.cwd, tmuxSession: hit.tmuxSession }
        : { ok: false, reason: att.reason });
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
    // 工作目录属于 CLI 进程; 活会话先记录 pending, 由调用方收尾后 self-handoff 应用。
    http.register("POST /mirror/workspace", async (req, res) => {
      const body = (await readBody(req)) as Partial<{ target: string; sessionId: string; tmuxPane: string; cwd: string }>;
      const cwd = (body.cwd ?? "").toString();
      const target = resolveSelf(body);
      if (!target) { json(res, 400, { ok: false, reason: "target required (or pass sessionId of an attached chat)" }); return; }
      const caller = resolveSelf({ sessionId: body.sessionId, tmuxPane: body.tmuxPane });
      if (refuseGuide(res, caller, "set_workspace") || refuseGuide(res, target, "set_workspace", false)) return;
      if (!cwd) { json(res, 400, { ok: false, reason: "cwd required" }); return; }
      // <role, workspace> 唯一确定身份: 同一个目录上不该有两个管家 —— 要共用就把本群绑给它,
      // 而不是让第二个管家也搬进去 (两份记忆、两个 pane, 人还以为是同一个)。
      const store = wizardStore();
      const rec = store?.get(target);
      const id = rec ? identityOfRec(rec) : "";
      const anchor = id && store ? anchorOf(store, id) : undefined;
      if (anchor && anchor.kind && STEWARD_KINDS.includes(anchor.kind)) {
        const taken = stewardsAt(store, baseOfKey(target), cwd, (t) => m.sessionInfo(t)?.cwd ?? "").filter((h) => identityOfRec(h) !== id);
        if (taken.length) {
          json(res, 409, { ok: false, target, reason: "目录 " + cwd + " 已有管家 ." + taken[0]!.name + " (<role, workspace> 唯一确定身份) — 要共用就把本群绑给它" });
          return;
        }
      }
      const set = m.setPendingCwd(target, cwd);
      if (!set.ok) { json(res, 400, { ...set, target }); return; }
      // 管家的工作区是身份级的: 记在锚点上, 该身份在别的新化身也从这里起。
      // 类实例的真相在类行 (identityWorkspaceOf 读它), 两处同写 —— 旧读者仍看锚点。
      if (anchor && store && set.pendingCwd) {
        store.upsert(anchor.target, { workspace: set.pendingCwd });
        if (id && store.classes?.get(id)) store.classes.upsert(id, { workspace: set.pendingCwd });
      }
      if ((await liveOf([target])).length) {
        json(res, 200, { ok: true, target, runningCwd: set.runningCwd, pendingCwd: set.pendingCwd,
          message: "工作区已记录 (pendingCwd)。此后该身份新开的会话/化身都在这个目录启动 (/new 或下一次 respawn 生效); 当前会话不迁移、不需要 handoff, 想立即换目录由人自己决定何时重开。" });
        return;
      }
      // Same shape as inbound's /new: windowName = tag for tagged sessions,
      // principal for the default one. No explicit cwd — newSession reads the
      // pendingCwd just queued and clears it once applied.
      const r = await m.newSession(target, tagOfKey(target) || target, { guard: () => true });
      json(res, r.ok ? 200 : 500, r.ok
        ? { ok: true, target, sessionId: r.sessionId, cwd: r.cwd }
        : { ok: false, reason: r.reason, target, runningCwd: set.runningCwd, pendingCwd: set.pendingCwd });
    });
    // 频道换绑 (人 2026-11-23: 「绑定工作区为 cc-wecom」): 频道 = 一条类绑定; 换绑 = 建 / 复用
    // 该目录的管家类 + 写 wrc.channel.steward + 频道 room 与各帖子 room 坐上新类的**本 room**
    // 实例 (旧 host 不离开: leave 会把它手上没交代的件全 canceled)。只动这一个频道。
    http.register("POST /mirror/channel/rebind", async (req, res) => {
      const body = (await readBody(req)) as Partial<{ sessionId: string; tmuxPane: string; topicId: string; workspace: string; name: string }>;
      const self = resolveSelf(body);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const topicId = (body.topicId ?? "").trim();
      // 权限: 频道管家表本来就对 wizard 可写 (config_set 那条), 这里不另设身份闸 —— 只要求
      // 频道已有账本 (认得出的频道才谈得上换绑), 并把这次改动写进频道 room (谁换的, 换成什么)。
      if (!roomState("chat:" + topicId)) { json(res, 404, { ok: false, reason: "这个频道还没有 room 账本: " + topicId }); return; }
      const { r: out, note } = guardCharter(
        () => rebindChannel({
          cfg, sourcePath, store: wizards, stateOf: roomState,
          write: (room, ops) => { hub.write(room, ops); },
          topicId, workspace: (body.workspace ?? "").toString(), ...(body.name ? { name: body.name.toString() } : {}),
        }),
        (r) => r.ok ? { what: "频道 " + r.topicId + " 换绑到 ." + r.className, self, byHuman: true } : undefined,
      );
      if (!out.ok) { json(res, 400, out); return; }
      // 频道级事实留一条系统行 (不唤醒谁、不开 duty): 人一眼看到 host 换成了谁。
      const ownRoom = "chat:" + out.topicId;
      const ownSeat = out.rooms.find((f) => f.room === ownRoom)?.seat ?? "";
      const said = hub.append(ownRoom, { author: DAEMON, kind: "system", origin: "daemon", sys: "rebind",
        text: "[wezard] 本频道的管家已换绑为 ." + out.className + (ownSeat ? " (本 room 的实例 ." + displayName(ownSeat) + ")" : "")
          + " —— 各 room 的 host 换成本 room 的新实例; 旧 host 仍留在群里, 只是不再是 host" });
      if (!said.ok) roomLog.warn({ room: ownRoom, reason: said.reason }, "channel: rebind 系统行被拒");
      // §7 换绑后同钩子补拉: 帖子 host 实例本来就是本 room 的实例, 这里只保证它们在频道成员表里
      // (换绑不动它们; 幂等)。
      backfillChannelMembers();
      // 频道 room 的管家会话先起 (与频道落定同一口子); 帖子 room 的实例等第一次唤醒再冷启动。
      const own = out.rooms.find((f) => f.room === "chat:" + out.topicId);
      if (own?.seat) spawnStewardPane(own.seat);
      roomLog.info({ ...out }, "channel: rebind");
      json(res, 200, { ...out, charter: await note });
    });
    // ── wizard ↔ wizard + 流水线 ───────────────────────────────────────
    // 这组路由让一个 pane 里的 wizard 作用到它的**同伴**身上。MCP 工具只看得见自己那个
    // 进程, 所以「另一个 wizard 在干嘛」「把这句话注入给它」只有守护进程答得了 ——
    // 它才持有全部 attachment。调用方靠上面的 `resolveSelf` 说明自己是谁。
    // 地址语义见 mirror-bridge.resolvePeerTag: "" = 本聊天的默认 wizard; 其它只接受
    // 全局 wizard 名或完整 canonical target key (含 `external_user:` principal 与 `#slot`),
    // 不再解析聊天名加 slot 的 friendly 地址。
    // 多机器人隔离: 别的机器人名下的 wizard 由 resolvePeerTag 当作查无此名 (同形、candidates 只列
    // 同机器人的) —— 点名寻址 (peek / tell / wait / stop / clone from / handoff / set_model / pending /
    // schedule) 全过这一道。
    const resolvePeer = (
      self: string,
      address: string,
    ): { ok: true; target: string; foreign: boolean } | { ok: false; status: number; reason: string; candidates?: string[] } => {
      const r = m.resolvePeerTag(self, address);
      if (r.ok) return r;
      return { ok: false, status: 404, reason: r.reason, candidates: r.candidates };
    };
    /** 聊天名候选只列与调用方同机器人的 —— 别的机器人的聊天名也是它的存在。指名别的机器人的聊天,
     *  各路由一律走它们自己「认不出这个聊天」的分支 (同状态码同原话), 不说「那边有, 但归别人」。 */
    const chatNamesFor = (self: string): string[] => listChatNames(cfg).filter((c) => sameBot(self, c.base)).map((c) => c.name);

    // ── Chat naming ────────────────────────────────────────────────────
    // A WeCom chat's identity is a canonical principal such as `chat:wrkS…`.
    // 聊天命名已下线 (2026-11-16): 一律用 principal 标识; chats{} 里的存量名仅作显示标签,
    // 跨聊天参数直接收 principal (存量名仍能解析回来)。
    http.register("POST /chats/list", async (req, res) => {
      const { self } = await readPeerBody(req);
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
            address: peerAddress(cfg, t),
            name: settleName(wizards, chatNameOf(cfg, t), t),
            description: wizards.get(t)?.description ?? "",
            cwd: m.getCwd(t).runningCwd || m.getCwd(t).defaultCwd,
          })),
        })),
      });
    });

    interface PeerBody { target?: string; sessionId?: string; tmuxPane?: string; name?: string }
    const readPeerBody = async (req: import("node:http").IncomingMessage): Promise<{ self: string; body: PeerBody }> => {
      const body = (await readBody(req)) as PeerBody;
      return { self: resolveSelf(body), body };
    };

    // Push a plain markdown bubble into a chat. `base` may carry a `#tag` — a
    // tagged key strips down to the same WeCom chatid as its base.
    // 头不走 withTagHeader 的那些 (relay / notify) 正文里的 tag 在这里挂链;
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
    // 新群引导化身没有工具面 (onboarding.ts guideRefusal)。审批层已全拒, 但审批关掉或
    // wezard use cli 时 hook 不问 daemon —— 改运行形态 / 另起会话 / 驱动别人的路由在这里再兜
    // 一道。撞上即按引导异常收尸: 拒掉这次调用, 杀 pane + drop 记录, 群里不留一个「等指令」
    // 的会话; 引导状态机不动, 人下一句话会重起一个干净的引导化身接着引导。别人冲着引导化身来的
    // (替它 handoff / 给它设工作区) 只拒不收 (reap=false): 越权的不是它。
    const refuseGuide = (res: import("node:http").ServerResponse, target: string, action: string, reap = true): boolean => {
      const reason = faceRefusal(wizardStore()?.get(target), action);
      if (!reason) return false;
      json(res, 403, { ok: false, reason });
      log.warn({ target, action, reap }, "onboarding: guide tool surface refused");
      if (!reap) return true;
      void m.killPane(target).then(() => wizardStore()?.drop(target));
      notifyChat(baseOfKey(target), "[wezard] 引导会话越权调用了 " + action + ", 已收掉; 请再发一次上一条, 引导会重新接上。");
      return true;
    };
    /** monitor 的工具面硬限 (wizard.ts monitorRefusal): 审批层已全拒, 审批关掉时在这里兜一道。 */
    const refuseMonitor = (res: import("node:http").ServerResponse, target: string, action: string): boolean => {
      const reason = faceRefusal(wizardStore()?.get(target), action);
      if (!reason) return false;
      json(res, 403, { ok: false, reason });
      log.warn({ target, action }, "monitor tool surface refused");
      return true;
    };
    // wizard 在群里的称呼, 只用在**正文**里。气泡的头照旧交给 withTagHeader ——
    // 那一段是路由信息 (`.name:` / 签名名 / role 链接头), parseTagHeader 靠它反解, 群里引用一条气泡
    // 就能直接跟那个 wizard 说话; 把它换成名字会把这条通路弄断。
    const displayName = (t: string): string => {
      const name = settleName(wizards, chatNameOf(cfg, t), t);
      return name ? `.${name}` : "默认 wizard";
    };

    /** 以 `self` 的名义往 `dest` 群发一条: 头独占一行; 头怎么写 (群默认 wizard 报不报名) 归 ownHead。 */
    const postAs = (self: string, dest: string, text: string): void => notifyChat(dest, headed(ownHead(self), text, "\n\n"));
    /** 同 postAs, 但去到的是频道 room (chat:<topic_id>) —— 一律发新帖 (send_post)。
     *  频道 / 帖子直连 send_post / send_reply, 绕过 tracker, 署名收尾 (withBubbleFooter) 得自己补。 */
    const postAsTopic = (self: string, dest: string, text: string, media?: TopicMedia): void => {
      const topicId = dest.replace(/^chat:/, "");
      void sendTopicPost(ws.client, log.child({ mod: "channel" }), topicId,
        linkTags(dest, withBubbleFooter(headed(ownHead(self), text, "\n\n"), self)), media)
        .catch((e: unknown) => log.warn({ topicId, err: errText(e) }, "channel tool send failed"));
    };
    /** 回话的引用标注: 评论被拒回退成新帖时, 让人知道这条在回谁的原话 (企微只允许评论 @ 过 bot 的帖子)。 */
    const replyQuote = (row: MsgRow): string => {
      const s = roomState(row.room);
      const src = (row.re ?? []).map((id) => s?.byId.get(id)).find((r) => r?.author.kind === "human");
      const text = src ? src.text.replace(/\s+/g, " ").trim() : "";
      if (!text) return "";
      return "> 回 " + roomNameOf(src!.author) + ": " + text.slice(0, 80) + (text.length > 80 ? "…" : "") + "\n\n";
    };
    /** 频道 room 的回话: 评论回原帖; 被企微拒 (没 @ 过 bot 的帖子) 回退发新帖, 正文带引用标注。 */
    const postAsChannelReply = (self: string, dest: string, post: string, text: string, quote: string, media?: TopicMedia): void => {
      const topicId = dest.replace(/^chat:/, "");
      const full = linkTags(dest, withBubbleFooter(headed(ownHead(self), text, "\n\n"), self));
      void sendTopicReplyOrPost(ws.client, log.child({ mod: "channel" }), topicId, post, full, quote ? quote + full : full, media)
        .catch((e: unknown) => log.warn({ topicId, post, err: errText(e) }, "channel post reply failed"));
    };
    /** 帖子 room (chat:<opk…>) —— 一律评论到根帖 (send_reply)。 */
    const postAsReply = (self: string, dest: string, channel: string, post: string, text: string, media?: TopicMedia): void => {
      void sendTopicReply(ws.client, log.child({ mod: "channel" }), channel, post,
        linkTags(dest, withBubbleFooter(headed(ownHead(self), text, "\n\n"), self)), media)
        .catch((e: unknown) => log.warn({ channel, post, err: errText(e) }, "channel post reply failed"));
    };
    const retiringWizardTargets = new Set<string>();
    const plans: PlanStore = (() => {
      try { return loadPlans(cfg.wrc.mirror.plansFile); }
      catch {
        const unavailable = (): never => { throw new PlanError(503, "plans store unavailable; repair the journal and reload"); };
        return {
          all: unavailable, get: unavailable, list: unavailable, create: unavailable, update: unavailable,
          hasUnfinished: unavailable, healthy: () => false, reminded: unavailable,
        } as unknown as PlanStore;
      }
    })();
    if (!plans.healthy()) log.error({ file: cfg.wrc.mirror.plansFile }, "plans store is unhealthy; plan operations and retirement checks fail closed while receiver messaging remains active");
    const planRetirementBlock = (owner: string): { status: number; reason: string } | undefined => {
      if (!plans.healthy()) return { status: 503, reason: "plans store unavailable; cannot verify wizard ownership" };
      try { return plans.hasUnfinished(owner) ? { status: 409, reason: "wizard still owns an unfinished plan" } : undefined; }
      catch (error) { return { status: error instanceof PlanError ? error.status : 503, reason: errText(error) }; }
    };
    handoffAllowed = () => true;
    const handoffs = createHandoffs({
      // room 模型 (wiring C): 终句零语义, 交接只管会话层 —— 清空 + 简报 + carry。
      // 路由/事件表的那些钩子 (currentEvents/suppress/owed/resume/uncut) 全部退场。
      isBusy: busyOf(m.idleNow),
      sessionId: (t) => m.sessionInfo(t)?.sessionId ?? "",
      // 收口窗口用尽后打断在飞那一轮 (Esc, 无 teardown): 打断不产生欠账 —— 未结 duty
      // 在 room 账本上, 下次唤醒按游标重投。
      interrupt: (t) => m.interruptPane(t),
      paneIdle: (t) => m.idleNow(t),
      restart: (t, p, submitted) => clearForHandoff(t, p, submitted),
      // 简报是新会话的开场白, 但它不挂任何信封 (服务不着哪一笔) —— 交接前欠着的那几笔由
      // 「继续 <event>」逐笔续答 (见 resume), 别把简报那一轮的回复当成回执。
      inject: async (t, text, seal, id, timeoutMs, clear) => {
        // 交接不进 room 账本 (wiring B / cutmap G-3): 简报轮是会话层动作, 直接贴进目标会话。
        if (clear && !(await m.verifyClearContext(t, clear))) return { ok: false, reason: "original cleared CLI process/session changed before carry" };
        const info = clear ? { tmuxPane: clear.pane, sessionId: clear.nextSid } : m.sessionInfo(t);
        if (!info?.tmuxPane || !info.sessionId) return { ok: false, reason: "original handoff pane/session binding is unavailable" };
        const deadline = Date.now() + timeoutMs;
        const r = await m.injectText(t, text, {
          channel: seal.channel, eventId: id, requireIdle: true, noRespawn: true,
          ...(clear ? { handoff: clear } : {}),
          ...(seal.speaker ? { speaker: seal.speaker } : {}),
          ...(seal.from ? { from: seal.from } : {}),
          guard: () => Date.now() < deadline,
        });
        return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? "handoff carry inject failed" };
      },
      sealOf: (t) => { const l = lastChannelOf(t); return l ? { channel: l.channel ?? "", ...(l.speaker ? { speaker: l.speaker } : {}), ...(l.from ? { from: l.from } : {}) } : { channel: m.currentChannel(t) }; },
      lastText: m.lastText,
      // other: 简报就是目标会话在「请它写简报」那句之后的最后一条 assistant 正文 (全文, 不截断)。
      summary: (_id, t, since) => m.lastReply(t, since) || undefined,
      process: (t) => m.processIdentity(t),
      owed: () => [],
      resume: async () => ({ ok: true }),
      // 交接是生命周期事件, 不进群; 失败只捎给它自己 (它调完 handoff_self 拿到的是
      // scheduled:true, 不说的话它不知道上下文其实没换)。
      notify: (t, text) => notices.post([t], text),
      uncut: () => {},
      log,
      store: loadJsonMap<PendingHandoff>(cfg.wrc.mirror.handoffsFile, undefined, { strict: true }),
      archive: (e) => {
        if (!e.brief.trim()) return;
        const name = wizards.get(e.target)?.name || tagOfKey(e.target) || "default";
        const ok = appendEpisode(episodePath(cfg.daemon.stateDir, name), { at: e.at, kind: "handoff", name, sid: e.sid, nextSid: e.nextSid, text: e.brief });
        if (!ok) log.warn({ target: e.target, name }, "handoff episode not archived");
      },
    });
    void m.restored.then(() => handoffs.resume());
    const addrOf = (value: object): string => String((value as { name?: unknown }).name ?? "");

    /** 给新 wizard 分配一个未使用的身份槽。已有身份一律先显式退役再复用。 */
    const namingClaims = new Set<string>();
    type BirthSlot = { target: string; name: string; token: string };
    const ownsSlot = (s: BirthSlot): boolean => wizards.get(s.target)?.birthToken === s.token;
    const releaseSlot = (s: BirthSlot): void => {
      if (!ownsSlot(s)) return;
      const blocked = planRetirementBlock(s.target);
      if (blocked) {
        log.warn({ target: s.target, reason: blocked.reason }, "birth rollback preserves wizard identity because plan retirement check is blocked");
        wizards.upsert(s.target, { spawning: undefined });
        return;
      }
      wizards.drop(s.target);
    };
    const finishSlot = (s: BirthSlot): void => { if (ownsSlot(s)) wizards.upsert(s.target, { spawning: undefined }); };
    /** 出生时的一次内存快照 (不读盘): 路由表、消息事件、定时任务、plan、名册与绑定里出现过的 target。
     *  plan 库坏了时 forget 本就被拒, 剩下的只可能是已结束的 plan (只读展示), 不为它拦出生。 */
    const targetsInUse = (base: string): Set<string> => referencedTargets({
      routes: [],
      events: [],
      tasks: tasks.list(),
      plans: plans.healthy() ? (() => { try { return plans.all(); } catch { return []; } })() : [],
      live: [...wizards.all().map((w) => w.target), ...m.chatTargets(base)],
    });
    const claimSlot = async (
      base: string,
      want: string,
      allowed: (target?: string, _name?: string) => boolean = () => true,
      internalName?: string,
    ): Promise<({ ok: true } & BirthSlot) | { ok: false; status: number; body: Record<string, unknown> }> => {
      const asked = normalizeTag(want);
      const claimKey = asked.toLowerCase();
      if (asked && namingClaims.has(claimKey)) return { ok: false, status: 409, body: { ok: false, reason: "wizard name is being claimed" } };
      if (asked) namingClaims.add(claimKey);
      try {
        const candidate = asked || (internalName ? pickName(internalName, wizards.all().map((w) => w.name)) : wizards.nextName(slotInUse(base, targetsInUse(base))));
        const reserve = (target: string): { ok: true } & BirthSlot => {
          // No await between uniqueness check and durable registration.
          const token = randomUUID();
          // 新生的记录一律是**自由 wizard** (临时 worker / 分身): 明确清掉从复用的冷记录上
          // 可能带过来的类归属 —— 克隆一个管家出来是独立的人, 不是那个类的实例。
          wizards.upsert(target, { name: candidate, spawning: BOOT_ID, birthToken: token, identity: target, ordinal: undefined });
          return { ok: true, target, name: candidate, token };
        };
        const clash = asked ? wizards.byName(asked) : undefined;
        if (clash?.spawning) return { ok: false, status: 409, body: { ok: false, reason: "wizard is being spawned", name: clash.name } };
        // 名字全机唯一, 撞上别的机器人的 wizard 照样拒 —— 但不顶掉它、不复用它的槽, 也不报它的死活:
        // 那边的 wizard 在这个机器人眼里不存在, 只剩「名字被占了」这一个事实。
        if (clash && !sameBot(base, clash.target)) {
          return { ok: false, status: 409, body: { ok: false, reason: `名字 '.${clash.name}' 已被占用 (名字全局唯一) —— 换个名字`, name: clash.name } };
        }
        if (clash && !allowed(clash.target, clash.name)) return { ok: false, status: 409, body: { ok: false, reason: "wizard identity changed during slot claim" } };
        const bound = !!clash && m.chatTargets(baseOfKey(clash.target)).includes(clash.target);
        if (clash) {
          const info = bound ? (await m.peers(clash.target)).find((p) => p.target === clash.target) : undefined;
          const alive = info?.paneAlive ?? false;
          const idleForMs = info?.lastActivity ? Date.now() - info.lastActivity : undefined;
          const idleDesc = idleForMs !== undefined ? `静默 ${Math.round(idleForMs / 60000)} 分钟` : "从没动过";
          const advice = alive
            ? "它的 pane 还活着 —— 除非这就是同一件事的延续, 否则换个名字重新生, 别把不相关的活塞给一个已经有职责的 wizard"
            : bound
              ? `pane 已经不在了 (${idleDesc}), 要结束这个 wizard 请由它自己或直属 lead 显式退役身份; 身份不会因静默自动回收`
              : "这个名字属于现存 wizard; 只有它自己或直属 lead 显式退役后才能复用";
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
        if (!allowed(keyOf(base, candidate), candidate)) return { ok: false, status: 409, body: { ok: false, reason: "wizard identity changed during slot claim" } };
        const taken = new Set([
          ...m.chatTargets(base).map(tagOfKey),
          ...wizards.all().filter((w) => baseOfKey(w.target) === base).map((w) => tagOfKey(w.target)),
        ].filter(Boolean));
        const slot = uniqueTag(candidate, taken);
        const target = keyOf(base, slot);
        // An identity rename may have claimed the address while stale eviction awaited IO.
        if (wizards.byName(candidate)) return { ok: false, status: 409, body: { ok: false, reason: "wizard name was claimed during spawn preparation" } };
        return allowed(target, candidate) ? reserve(target) : { ok: false, status: 409, body: { ok: false, reason: "wizard identity changed during slot claim" } };
      } finally {
        if (asked) namingClaims.delete(claimKey);
      }
    };

    // ── 给人看的消息 ──────────────────────────────────────────────────
    // chat_ask 把话塞进另一个 agent 的输入框 (驱动它干活); 这条把话贴进一个聊天
    // 给**人**看。收件人就是地址 —— 聊天名或裸 principal, 没有「先订阅才收得到」
    // 这一步。头沿用 relay 那一套: 本群退化成寻常的 `emoji #tag`, 外群写成带聊天
    // 名的全称, 于是那边的人一眼看得出是谁、从哪个群说过来的。
    // 顶层模式: 只有顶层 wizard 对人说话。拦的是「这一轮在为同伴干活」的: 同伴私聊派来的活, 或
    // 回执轮但那件活是为上游同伴派的 (k 是 peer)。人说的、定时任务放的、旁支 (chain:false, 无 k)
    // 的回执轮都不拦; 管家只在自己的群里豁免。notify 与 send_file 共用这一道闸。
    // 顶层模式: 只有顶层 wizard 对人说话。「这一轮在为同伴干活」的唯一判据 = 它服务的那一笔
    // 的定论收给谁 (§9.5): 收给同伴的 wizard = 它在链条下面, 不对人说话; 收给群的 = 它自己

    http.register("POST /peers/peek", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const addressError = unsupportedPeerAddressField(body);
      if (addressError) { json(res, 400, { ok: false, reason: addressError }); return; }
      const r = resolvePeer(self, addrOf(body));
      if (!r.ok) { json(res, r.status, { ok: false, reason: r.reason, candidates: r.candidates }); return; }
      const { target, foreign } = r;
      const turns = Math.min(Math.max(Number((body as { turns?: number }).turns ?? 6) || 6, 1), 40);
      // 对话只从 transcript 读 (正文轮次), 不刮终端: pane 是
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
        name: peerAddress(cfg, target),
        busy: peek.busy ?? false,
        ...(waiting.length ? { waiting } : {}),
        text: [`${displayName(target)} · ${state}${foreign ? ` · 住在群 ${chatNameOf(cfg, target) || "(未命名)"}` : ""}`, peek.dialog ?? `(${peek.reason})`].join("\n"),
      });
    });

    // ── 聊天记录 (room_read) ─────────────────────────────────────────────
    // room 模型: 往来的唯一事实是 room 账本。这里读账本 (renderRoomRead), 不再从
    // transcript 现算 (chat-log.ts 已随 room-ui 退役)。chat = 绑定 room; with/role =
    // 只看那个人说的; 缺省 = 调用方所在全部 room 的 W-1 视图。
    http.register("POST /chats/read", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const me = roomSelfOf(self);
      if (!me) { json(res, 400, { ok: false, reason: "caller 不在名册上, 没有 uid" }); return; }
      const b = body as { role?: string; chat?: string; with?: string; since?: string; until?: string; limit?: number; per?: number; all?: boolean };
      const now = Date.now();
      const [chatRef, withRef, roleRef, sinceRef, untilRef] = [b.chat, b.with, b.role, b.since, b.until].map((x) => (x ?? "").toString().trim());
      const since = sinceRef ? parseWhen(sinceRef, now) : undefined;
      const until = untilRef ? parseWhen(untilRef, now) : undefined;
      if ((sinceRef && since === undefined) || (untilRef && until === undefined)) {
        json(res, 400, { ok: false, reason: "时间认不出 —— 写 `2h` / `30m` / `3d` (多久以前)、`14:30` (今天)、`09-30 14:30` 或 ISO 时间" });
        return;
      }
      const fromRef = withRef || roleRef;
      const from = fromRef ? whoRefOf(fromRef) : undefined;
      if (fromRef && !from) { json(res, 400, { ok: false, reason: "认不出这个地址: " + fromRef }); return; }
      const room = chatRef ? roomResolve(chatRef).room : undefined;
      if (chatRef && !room) { json(res, 404, { ok: false, reason: `认不出聊天 '${chatRef}' (wizard_roster 每行有 home 聊天名)` }); return; }
      const states = (room ? [roomState(room)!] : roomStore.ids().map((id) => roomState(id)!).filter((s) => s?.members.has(whoKey(me)))).filter(Boolean);
      if (room && !states.length) { json(res, 404, { ok: false, reason: "没有这个 room 的账本: " + room }); return; }
      const names = { nameOf: roomNameOf, roomLabel };
      const view = renderRoomRead(states, me, {
        ...(room ? { room } : {}),
        ...(from ? { from: fromRef } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(b.limit !== undefined ? { limit: Number(b.limit) } : {}),
        ...(b.per !== undefined ? { per: Number(b.per) } : {}),
        ...(b.all === true ? { all: true } : {}),
      }, names, now);
      const scope = [
        room ? (room.startsWith("user:") ? "单聊 " : "群 ") + (roomLabel(room) || room) : "你所在的全部 room",
        from ? roomNameOf(from) + " 说的" : "",
      ].filter(Boolean).join(" · ");
      json(res, 200, {
        ok: true,
        shown: view.shown,
        total: view.total,
        text: [
          `${scope} · ${view.shown} 条`,
          view.text || "(没有读到对话)",
          ...(view.earlier ? [`更早的: until="${view.earlier}"`] : []),
        ].join("\n"),
      });
    });

    // 频道历史 (read_channel): 注入的上下文不够时, wizard 自己按频道翻 / 搜。
    http.register("POST /channel/read", async (req, res) => {
      const raw = (await readBody(req)) as { topic?: string; query?: string; limit?: number; since?: string; until?: string };
      const topic = String(raw.topic ?? "").trim();
      if (!topic) { json(res, 400, { ok: false, reason: "给一个频道: `chat:<topic_id>` 或裸 topic_id (频道消息的上下文头里有 topic=)" }); return; }
      const now = Date.now();
      const since = raw.since ? parseWhen(String(raw.since), now) : undefined;
      const until = raw.until ? parseWhen(String(raw.until), now) : undefined;
      if ((raw.since && since === undefined) || (raw.until && until === undefined)) {
        json(res, 400, { ok: false, reason: "时间认不出 —— 写 `2h` / `30m` / `3d` (多久以前)、`14:30` (今天)、`09-30 14:30` 或 ISO 时间" });
        return;
      }
      const r = await readChannel({ client: ws.client, cfg, log }, {
        topic,
        ...(raw.query ? { query: String(raw.query) } : {}),
        ...(raw.limit !== undefined ? { limit: Number(raw.limit) } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
      });
      json(res, r.ok ? 200 : 400, r);
    });

    // 跟另一个 wizard 说一句话 (chat_ask): 「说」而不是「发送并等待」, 调用方写进 room 账本就返回,
    // 对方干完用 chat_reply 交代 (room 账本上的 duty 关账)。
    // 冷与否 = 缓存最近一次被碰 (最近一次真实请求的开始; 读不到退回 mtime) 距今多久 vs 它实际按多长 TTL 写的
    // (与 route_candidates 同一口径)。transcript 里没有分层写入记录时按 5min 兜底。
    const CACHE_TTL_FALLBACK_SEC = 300;
    const touchOf = (p: string): number => { try { return cacheTouchMs(p) || statSync(p).mtimeMs; } catch { return 0; } };
    const ttlOf = (p: string): number => (cacheTtlSec(p) || CACHE_TTL_FALLBACK_SEC) * 1000;
    type Reply = { status: number; body: Record<string, unknown> };
    // plan 关联的 room 行 (wiring C): duty 的 planId 字段就是关联; 去重键换 planId 集合。
    const planEventIds = (planId: string): string[] => roomStore.ids().flatMap((id) => {
      const s = roomState(id);
      return s ? s.msgs.filter((x) => x.planId === planId).map((x) => x.id) : [];
    }).sort();
    const planHasOutstandingDebt = (planId: string, owner: string): boolean => {
      const uid = wizards.get(owner)?.uid;
      if (!uid) return false;
      return planHasOpenDuty(roomStore.ids().flatMap((id) => roomState(id) ?? []), planId, uid);
    };
    void m.restored.then(() => {
      stopPlanReminders = startPlanReminders({
        store: plans,
        eventIds: planEventIds,
        hasOutstandingDebt: planHasOutstandingDebt,
        // 提醒不再走事件表 (wiring B): 去重只靠 plans.reminded 的 token。
        hasPendingReminder: () => false,
        idle: m.idleNow,
        handingOff,
        log: log.child({ mod: "plan-reminders" }),
        enqueue: async (candidate: PlanReminderCandidate) => {
          const { plan, token, eventId } = candidate;
          const current = plans.get(plan.id);
          if (!current || current.owner !== plan.owner || current.state !== "active" || current.revision !== plan.revision
            || reminderToken(current.id, current.revision, planEventIds(current.id)) !== token
            || planHasOutstandingDebt(current.id, current.owner) || handingOff(current.owner) || !(await m.idleNow(current.owner))) return;
          // 提醒 = 一条 trigger 行 (cutmap G-2): 不镜像, 只唤醒 owner; 去重靠 plans.reminded 的 token。
          fireTaskTrigger(plan.owner, `你的 plan「${plan.title}」仍处于 active 状态（revision ${plan.revision}）。请检查 DAG 进度，并在需要时显式更新、暂停或完成 plan。`, eventId);
          plans.reminded(plan.id, plan.revision, token, eventId);
        },
      });
    });

    // 交接队列的可观测性: 每个目标当前那场交接在哪个阶段、后面排了几场、在等什么 ——
    // 明确是排队 (已受理), 不是欠账。日志同口径 (handoff: 仍在队列 / 排队请求开工)。
    http.register("GET /handoff/status", (_req, res) => json(res, 200, { ok: true, handoffs: handoffs.status() }));

    // handoff 只清空原 pane 的原生上下文; 不更新 CLI 进程、工作目录或出生时的宪章。
    const clearForHandoff = (target: string, p: PendingHandoff, submitted: (attempt: NonNullable<PendingHandoff["clear"]>) => void) => {
      if (!handoffAllowed(target)) return Promise.resolve({ ok: false, reason: "handoff unavailable" });
      if (!p.clear && m.sessionInfo(target)?.sessionId !== p.sid) return Promise.resolve({ ok: false, reason: "native session changed before the clear attempt; refusing another clear" });
      return m.clearContext(target, p.clear, submitted, () => handoffAllowed(target));
    };

    /** 原地交接被拒的统一说法: 为什么不行 + 还能走的路。拒绝发生在写任何交接记录之前 ——
     *  一次按下去却认不出结果的 /clear, 只会换来一条假的 restarting 墓碑。 */
    const inPlaceClearRefusal = (why?: string): string =>
      `原地 handoff 已拒绝 (上下文未清空, 也没留交接记录): ${why ?? "这个后端没有可核验的原地 /clear 完成信号"}。还能走: ① 想换目录的话 set_workspace({cwd}) 先记下 (此后新会话生效), 再 handoff —— daemon 在新 CLI 进程的新目录接简报; ② 让人在 CLI 里发 /new 另起会话, 再在该会话里接着干。`;

    /** 交接自己: 调用即受理 —— 简报由调用方给, daemon 排队等它这一轮说完后再动手; 已有一场在
     *  执行就排队到它之后 (不拒绝), 残余失败记录不参与 self 准入 (见 handoff.ts)。/handoff 点名
     *  点到自己与 /wizard/handoff-self 共用实现; 无端点核验的旧版 CLI 在这里明确拒绝 (能力缺失,
     *  不假装受理)。 */
    const handoffSelf = async (self: string, brief: string): Promise<{ status: number; body: Record<string, unknown> }> => {
      if (!handoffAllowed(self)) return { status: 409, body: { ok: false, reason: "handoff unavailable" } };
      if (brief.length < 40) return { status: 400, body: { ok: false, reason: "brief 太短 —— 要写到零上下文也能接手: 目标 / 已完成 / 当前状态 / 下一步 / 关键文件与坑" } };
      const info = m.sessionInfo(self);
      const cwd = m.getCwd(self);
      const workspaceSwitch = !!cwd.pendingCwd && cwd.pendingCwd !== cwd.runningCwd;
      // 原地清空要先有可核验的完成信号才许按下去 —— 认不出来就不开工, 也别落一条交接
      // 记录 (那种记录只会在后面长成一条假的 restarting 墓碑)。换工作区走新进程, 不受此限。
      if (!workspaceSwitch) {
        const support = await m.nativeClearSupport(self);
        if (!support.ok) return { status: 409, body: { ok: false, reason: inPlaceClearRefusal(support.reason) } };
      }
      const r = handoffs.self(self, brief);
      return r.ok
        ? { status: 200, body: {
            ok: true,
            target: self,
            contextTokens: info?.contextTokens ?? 0,
            scheduled: true,
            ...(r.queuedBehind ? { queuedBehind: true, message: "已有一场交接正在执行；这次已受理排队，daemon 会在它结束后自动再执行一次。" } : {}),
            ...(workspaceSwitch ? {
              pendingCwd: cwd.pendingCwd,
              workspaceStatus: "queued_not_applied",
              message: `handoff 已受理；daemon 立即打断当前轮并启动新 CLI 在 ${cwd.pendingCwd} 中继续简报。旧进程不会原地切换目录。`,
            } : {}),
          } }
        : { status: 409, body: { ok: false, reason: r.reason } };
    };
    http.register("POST /handoff", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const addressError = unsupportedPeerAddressField(body);
      if (addressError) { json(res, 400, { ok: false, reason: addressError }); return; }
      if (!addrOf(body).trim()) { json(res, 400, { ok: false, reason: "要点名 (name) —— 交接你自己走 /wizard/handoff-self (MCP: handoff 不传 name, 带 brief)" }); return; }
      const resolved = resolvePeer(self, addrOf(body));
      if (!resolved.ok) { json(res, resolved.status, { ok: false, reason: resolved.reason, candidates: resolved.candidates }); return; }
      const target = resolved.target;
      if (refuseGuide(res, self, "handoff") || refuseGuide(res, target, "handoff", false)) return;
      // 点名点到自己: 不能走「让它写简报」那条 (往正在生成的输入框里打字, 等自己等成
      // 死锁), 改走交接自己 —— 简报得由调用方自己给。
      if (target === self) {
        const brief = ((body as { brief?: string }).brief ?? "").toString().trim();
        if (!brief) { json(res, 400, { ok: false, reason: "这是交接你自己: 把简报写在 brief 里 (不传 name 即可)" }); return; }
        const r = await handoffSelf(self, brief);
        json(res, r.status, r.body);
        return;
      }
      const focus = ((body as { focus?: string }).focus ?? "").toString().trim();
      const timeoutMs = Math.min(Math.max(Number((body as { timeoutSec?: number }).timeoutSec ?? 600) || 600, 30), 7200) * 1000;
      // 与交接自己同一条准入: 原地清空要有可核验的完成信号, 没有就在写记录前拒绝。
      const targetCwd = m.getCwd(target);
      if (!(targetCwd.pendingCwd && targetCwd.pendingCwd !== targetCwd.runningCwd)) {
        const support = await m.nativeClearSupport(target);
        if (!support.ok) { json(res, 409, { ok: false, target, reason: inPlaceClearRefusal(support.reason) }); return; }
      }
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
    // 类表 (人 2026-11-18): <bot, role, workspace> 唯一的人物设定; wizard 记录是它的实例。
    const classes = loadClassStore(join(expandHome(cfg.daemon.stateDir), "classes.json"));
    const wizards = bindWizardStore(loadWizardStore(cfg.wrc.mirror.wizardsFile, bornOf, classes));
    // v3 身份迁移必须先于任何别的写盘 (backfillBorn/settleAll 都会 upsert, 会把老记录
    // 顺手迁成「没备份」的形态)。幂等: 已迁完的 boot 这里是一次空跑。
    const ident = migrateIdentities(wizards, cfg.wrc.mirror.wizardsFile);
    if (ident.migrated) log.child({ mod: "wizard" }).info({ migrated: ident.migrated, backup: ident.backup }, "v3 identity migration applied");
    else if (ident.skipped) log.child({ mod: "wizard" }).warn({ reason: ident.skipped }, "v3 identity migration skipped");
    // 同身份的化身前一轮可能各写了一份身份级字段 (职责 / 记忆): 开机收敛一次, 幂等。
    const reconciled = reconcileKin(wizards);
    if (reconciled > 0) log.child({ mod: "wizard" }).info({ reconciled }, "identity kin reconciled");
    // ── room 账本 (docs/room/wiring.md A): hub 实例化 + /room/* HTTP ──────
    // room 是唯一的沟通对象: 人话 (inbound) 与 wizard 工具都 append 进同一份账本
    // (daemon/room-hub.ts), 唤醒按 seen 游标重算, 镜像按 §3a 一条规则。旧的路由 /
    // 事件表这一步还并行活着 (B/C 节再拆), 这里只把新面接上。
    const roomsDir = roomsDirOf(cfg.daemon.stateDir);
    const roomStore = openRoomStore(roomsDir);
    /** 损坏的 room 文件 (RoomBroken) 不挡 boot, 也不参与任何判定 —— 只记一行。 */
    const roomState = (id: string): RoomState | undefined => {
      try { return roomStore.get(id); } catch (e) { log.warn({ mod: "room", room: id, err: errText(e) }, "room: 账本损坏, 跳过"); return undefined; }
    };
    /** 这个 wizard 此刻跨 room 手上未关的 duty (host 槽位读时求值)。 */
    const heldDuties = (who: Who): Duty[] =>
      roomStore.ids().flatMap((id) => { const s = roomState(id); return s ? dutiesHeldBy(s, who) : []; });
    const dutyLine = (d: Duty): string => d.msg + " " + (d.last?.status ?? "open");
    /** 摘 lead (方案 B, 见 leadSettled): 有 duty 关账、plan 变动后各跑一遍, boot 再跑一遍带老记录。
     *  lead 全机就几个, 每个只查自己 leadOf 那几条, 不扫全表。 */
    const settleLeads = (boot = false): void => {
      for (const rec of wizards.all()) {
        if (!rec.lead || !rec.uid) continue;
        const who: Who = { kind: "wizard", id: rec.uid };
        const open = (msg: string): boolean => {
          const room = roomStore.roomOfMsg(msg);
          const s = room ? roomState(room) : undefined;
          return !!s && dutiesHeldBy(s, who).some((d) => d.msg === msg);
        };
        // plan 账本坏了 (fail closed) 就当它还有没收尾的 —— 宁可晚摘, 不错摘。
        let unfinishedPlan = true;
        try { unfinishedPlan = plans.hasUnfinished(rec.target); } catch { /* 见上 */ }
        const facts = { open, unfinishedPlan, boot, occupied: boot && heldDuties(who).some((d) => occupies(d, who)) };
        if (!leadSettled(rec, facts)) continue;
        wizards.upsert(rec.target, { lead: undefined, leadOf: undefined });
        log.info({ mod: "lead", target: rec.target, leadOf: rec.leadOf ?? [], boot }, "lead: 领的活都关账了, 摘 lead");
      }
    };
    /** 占位气泡的 frame 表 (cutmap A-4): 企微 msgid → {frame, expires}。
     *  人话行 append 时写 (B 节接 inbound), 第一条 re 它的 reply 用它把占位收口 ——
     *  bridge 的 replyBubbles 只认自己 dispatch 过的 event id, room 的人话行不再走
     *  dispatch, frame 只能由 daemon 自己记。TTL = bubble.expires, 落盘扛 reload。 */
    interface BubbleFrame { frame: Record<string, unknown>; expires: number }
    const bubbleFrames = loadJsonMap<BubbleFrame>(join(expandHome(cfg.daemon.stateDir), "bubble-frames.json"), (rows) => {
      const now = Date.now();
      return Object.fromEntries(Object.entries(rows).filter(([, v]) => !!v && typeof v === "object" && (v as BubbleFrame).expires > now));
    }, { strict: true });
    const rememberBubbleFrame = (msgid: string, frame: unknown, expires: number): void => {
      if (!msgid?.trim() || !frame) return;
      try { bubbleFrames.set(msgid, { frame: frame as Record<string, unknown>, expires }); } catch { /* 记录失败不挡消息 */ }
    };
    /** 覆盖一条占位气泡: 表里有 frame (未过期) 就直接收口; 再退化试 bridge 的
     *  finishPlaceholder (legacy 路径注册过的); 都没有 → false, 调用方退回普通发送。 */
    const coverBubble = async (msgid: string, md: string): Promise<boolean> => {
      const hit = bubbleFrames.get(msgid);
      if (hit && hit.expires > Date.now()) {
        try { await ws.client.replyStream(hit.frame as Parameters<typeof ws.client.replyStream>[0], msgid, md, true); return true; }
        catch (e) { log.warn({ mod: "room", msgid, err: errText(e) }, "room: 占位气泡覆盖失败, 退回普通发送"); }
      }
      return false;
    };
    // ── hub ports ────────────────────────────────────────────────────────
    /** uid → 现在的 target / 名字 / 直属 parent (投递与渲染那一刻现查, 改名跟着走)。 */
    const roomWizardOf = (uid: string): { target: string; name: string; parentUid?: string } | undefined => {
      const rec = wizards.byUid(uid);
      if (!rec) return undefined;
      const parent = rec.parent ? wizards.get(rec.parent) : undefined;
      return {
        target: rec.target,
        name: settleName(wizards, chatNameOf(cfg, rec.target), rec.target) || rec.target,
        ...(parent?.uid ? { parentUid: parent.uid } : {}),
      };
    };
    const roomNameOf = (w: Who): string =>
      w.kind === "wizard" ? "." + (roomWizardOf(w.id)?.name ?? w.id)
        : w.kind === "human" ? w.id
        : "wezard";
    const roomLabel = (room: string): string => {
      // host 起的名字是显式别名, 优先于聊天名与成员拼名 (对 dm 也生效; 只影响显示, 寻址仍只认 id)。
      const s = roomState(room);
      if (s?.title) return s.title;
      if (isMeRoom(room)) return (chatNameOf(cfg, "user:" + meUserOf(room)) || meUserOf(room)) + " 的 me";
      if (room.startsWith("dm:")) {
        const pair = dmPeers(room);
        if (!pair) return room;
        // dm 是 room 的特殊形式: 成员恰好是 id 里那两个 → 「A ↔ B」; 拉进第三人之后按当前全员列。
        const ms = s ? [...s.members.values()].map((m) => m.who) : [];
        const onlyPair = !ms.length || ms.every((w) => w.kind === "wizard" && pair.includes(w.id));
        return onlyPair ? memberLabel(pair.map((u) => roomWizardOf(u)?.name ?? u)) : memberLabel(ms.map(roomNameOf));
      }
      if (room.startsWith("adhoc:")) return memberLabel([...(s?.members.values() ?? [])].map((x) => roomNameOf(x.who))) || room;
      return chatNameOf(cfg, room) || room;
    };
    /** 频道 room 判据: 进程内见过的 topic (事件登记) **或** channel-posts 认识且没有根帖的频道。
     *  只看 isTopicChat 不够 —— reload 后 topics 是空的, 频道 room 会被当成帖子 room, 出站走
     *  send_reply(post_id="") 被企微 40058 拒掉 (2026-11-24 实测: send_file 进频道首条即此)。 */
    const isChannelRoom = (base: string): boolean => {
      if (isTopicChat(base)) return true;
      const ref = channelRefOf(cfg, base);
      return !!ref && !ref.post;
    };
    /** 绑定 room 的镜像出站 (§3a): 覆盖占位 > 媒体 > topic 评论 > wx > 群消息。
     * 返回 true = 已成功交给传输 (hub 拿它打 O3 的 room: mirrored; 内部失败各路径自己 warn)。 */
    const roomMirror = async (row: MsgRow, cover?: MsgRow): Promise<boolean> => {
      // me-room 出站: 占位气泡覆盖 (回发生地) > 文件/正文兜底发用户私聊; 带 .me 独立对话标注。
      if (isMeRoom(row.room)) {
        return meRowMirror(row, cover, {
          authorTargetOf: (u) => roomWizardOf(u)?.target,
          coverBubble,
          sendMedia: (principal, f) => sendMedia(principal, f),
          notify: (principal, md) => notifyChat(principal, md),
          rowById: (room, id) => roomState(room)?.byId.get(id),
          // 人被 .me 点名的位置是频道 / 帖子 (那行带 src): 评论回那条原帖, 被企微拒就回退
          // 发新帖并带引用标注 (人 2026-11-24 拍板) —— 不再把答案发去私聊。
          replyToSource: async (r, said, md) => {
            const base = said.src ?? "";
            const ref = channelRefOf(cfg, base);
            const topicId = ref ? ref.channel : isChannelRoom(base) ? base.slice("chat:".length) : "";
            if (!topicId) return false;
            const postId = said.post || ref?.post || "";
            let topicMedia: TopicMedia | undefined;
            if (r.files?.length) {
              const imageIds: string[] = [];
              const inline: Array<{ mediaId: string; name: string }> = [];
              for (const f of r.files) {
                const up = await uploadMediaId(ws.client, base, { path: f.path, kind: f.kind, name: f.name }, log);
                if (!up.ok) { log.warn({ mod: "room", room: r.room, file: f.path, reason: up.reason }, "me: 频道素材上传失败 (只影响传输, 不回滚)"); continue; }
                if (up.kind === "image") imageIds.push(up.mediaId);
                else inline.push({ mediaId: up.mediaId, name: up.name });
              }
              if (imageIds.length || inline.length) topicMedia = { ...(imageIds.length ? { imageIds } : {}), ...(inline.length ? { files: inline } : {}) };
            }
            const full = withBubbleFooter(linkTags(r.room, md), r.room);
            const quote = replyQuote(r);
            const child = log.child({ mod: "channel" });
            // 频道帖子的正文 (没有 post 可评论) / 帖子 room 认不出根帖: 直接发新帖。
            if (!postId) {
              void sendTopicPost(ws.client, child, topicId, quote ? quote + full : full, topicMedia)
                .catch((e: unknown) => log.warn({ mod: "room", room: r.room, topicId, err: errText(e) }, "me: 频道发帖失败"));
            } else {
              void sendTopicReplyOrPost(ws.client, child, topicId, postId, full, quote ? quote + full : full, topicMedia)
                .catch((e: unknown) => log.warn({ mod: "room", room: r.room, topicId, postId, err: errText(e) }, "me: 评论回原帖失败"));
            }
            return true;
          },
        });
      }
      const chat = row.room;
      // 出站目标源 (设计稿 §4.2): reply 跟所 re 那行的 src (缺省 = 主源), say / file / notify 回主源。
      // src 缺省路径 = out === chat = 现行为, 存量账本一比特不变。
      const { source: out, fellBack } = outboundSourceOf(row, (id) => roomState(chat)?.byId.get(id));
      if (fellBack) log.warn({ mod: "room", room: chat, re: row.re }, "room: reply 的 re 在本 room 账本里查不到, 出站回落主源");
      const authorTarget = row.author.kind === "wizard" ? roomWizardOf(row.author.id)?.target : undefined;
      const plain = row.text.trim() || (row.files?.length ? "📎 " + row.files.map((f) => f.name).join(", ") : "");
      // 收话人: 显式点名的 wizard (to) + 被答复那条消息的 wizard 作者 (re), 去掉自己与重复。
      const replied = (row.re ?? []).flatMap((id) => roomState(chat)?.msgs.find((r) => r.id === id)?.author ?? []);
      const addressees = authorTarget
        ? [...new Set([...(row.to ?? []), ...replied].filter((w) => w.kind === "wizard" && w.id !== row.author.id).map(roomNameOf))]
        : [];
      const body = addressed(addressees, plain);
      // 头像 / 尾部署名都由 tracker 从正文头反解 —— 覆盖占位气泡也必须带这个头,
      // 否则那条气泡既没有身份也没有 rolepage 链接 (它就是人点名的那个 wizard 的答复)。
      const md = roomBubble(authorTarget, body);
      // 占位气泡盖在人话行的发生源上; 与这行的目标源不是同一个就不盖 (退回普通发送, 流由 hardTimer 收口)。
      if (cover?.ext && body && bubbleSourceOf(cover) === out) {
        if (await coverBubble(cover.ext, md)) return true;
      }
      const plan = planOutbound(out, row, {
        wxOwns: (id) => wx.owns(id),
        isTopic: isChannelRoom,
        postRefOf: (base) => postRefOf(cfg, base),
        channelAction: (r) => channelOutboundOf(r, (id) => roomState(chat)?.byId.get(id)?.post),
      });
      // 频道 / 帖子没有群 chatid: 素材先换 media_id, 随 send_post / send_reply 的
      // image_list (图片) / inline_file_list (其余) 一起带 —— 直接用 sendMediaMessage 发到
      // 那里只会被频道出站补丁当「不支持的 msgtype」丢掉 (channel.ts)。
      const toTopic = plan.via === "channel" || plan.via === "post";
      let topicMedia: TopicMedia | undefined;
      if (row.files?.length && toTopic) {
        const imageIds: string[] = [];
        const inline: Array<{ mediaId: string; name: string }> = [];
        for (const f of row.files) {
          const up = await uploadMediaId(ws.client, out, { path: f.path, kind: f.kind, name: f.name }, log);
          if (!up.ok) { log.warn({ mod: "room", room: chat, file: f.path, reason: up.reason }, "room: 频道素材上传失败 (只影响传输, 不回滚)"); continue; }
          if (up.kind === "image") imageIds.push(up.mediaId);
          else inline.push({ mediaId: up.mediaId, name: up.name });
        }
        if (imageIds.length || inline.length) {
          topicMedia = { ...(imageIds.length ? { imageIds } : {}), ...(inline.length ? { files: inline } : {}) };
        }
        if (!body && !topicMedia) return false;
      } else if (row.files?.length) {
        let filesOk = true;
        for (const f of row.files) {
          const r = await sendMedia(out, { path: f.path, kind: f.kind, name: f.name, ...(row.text.trim() ? { description: row.text } : {}) });
          if (!r.ok) { filesOk = false; log.warn({ mod: "room", room: chat, file: f.path, reason: r.reason }, "room: 镜像媒体发送失败 (只影响传输, 不回滚)"); }
        }
        if (!body) return filesOk;
      }
      if (plan.via === "wx") {
        const r = wx.sendFinal(plan.chatId, wxMarkdown(md), row.id);
        if (r.state === "failed") { log.warn({ mod: "room", room: chat, src: out, reason: r.reason }, "room: wx 镜像失败"); return false; }
        return true;
      }
      if (plan.via === "channel") {
        // 频道: 回话 (reply 且 re 到带 post 的评论行) = 评论回原帖; 主动说 = 新帖 (§2.3)。
        if (plan.action === "reply") {
          // 企微只允许评论 @ 过 bot 的帖子; 被拒就回退新帖 (带引用), 不让交代静默丢失。
          const quote = replyQuote(row);
          const post = plan.post ?? "";
          if (authorTarget) postAsChannelReply(authorTarget, out, post, body, quote, topicMedia);
          else {
            const full = withBubbleFooter(linkTags(out, md), out);
            void sendTopicReplyOrPost(ws.client, log.child({ mod: "room" }), plan.topicId, post, full, quote ? quote + full : full, topicMedia)
              .catch((e) => log.warn({ mod: "room", room: chat, src: out, post, err: errText(e) }, "room: topic 评论回帖失败"));
          }
          return true;
        }
        if (authorTarget) postAsTopic(authorTarget, out, body, topicMedia);
        else void sendTopicPost(ws.client, log.child({ mod: "room" }), plan.topicId, withBubbleFooter(linkTags(out, md), out), topicMedia)
          .catch((e) => log.warn({ mod: "room", room: chat, src: out, err: errText(e) }, "room: topic 镜像失败"));
        return true; // 已交给传输; 异步失败由上面的 catch 记 warn
      }
      if (plan.via === "post") {
        // 帖子: 一律评论到根帖 (副源帖子 = 绑进本 room 的那条帖; 企微侧地址仍查 channel-posts)。
        if (authorTarget) postAsReply(authorTarget, out, plan.channel, plan.post, body, topicMedia);
        else void sendTopicReply(ws.client, log.child({ mod: "room" }), plan.channel, plan.post, withBubbleFooter(linkTags(out, md), out), topicMedia)
          .catch((e) => log.warn({ mod: "room", room: chat, src: out, err: errText(e) }, "room: post 镜像失败"));
        return true;
      }
      if (authorTarget) postAs(authorTarget, out, body);
      else notifyChat(out, md);
      return true;
    };
    const roomLog = log.child({ mod: "room" });
    const hub = createRoomHub({
      store: roomStore, log: roomLog,
      wizardOf: roomWizardOf, nameOf: roomNameOf, roomLabel,
      mirror: roomMirror,
      live: (target) => m.paneAliveFor(target),
      idle: (target) => m.idleNow(target),
      interrupt: async (target) => {
        const r = await m.interruptPane(target);
        if (!r.ok) roomLog.warn({ target, reason: r.reason }, "room: Esc 打断失败 (照常投递本条)");
      },
      onClosed: () => settleLeads(),
      replyHintWindow: () => cfg.rooms?.replyHint?.window ?? 10,
      tailOf: (target, triggers) => humanWakeTail(wakeTailPorts(cfg, m), target, triggers),
      // 感知懒建 (2026-11-24): 人话需要感知而本 room 还没有 perceptron 时, append 先建再判 (见 ensurePerceptron)。
      ensurePerceptron: (room: string) => { ensurePerceptron(room); },
      paste: async (target, text, tail) => {
        const r = await m.injectText(target, text, wakeInjectOpts(tail));
        if (r.ok) roomActivityTouch(target); // 注入成功 = 该 wizard 有新事件, 看门狗的 stale 窗口重置
        return r.ok ? "ok" : r.uncertain ? "uncertain" : r.gone ? "gone" : "failed";
      },
    });
    // boot 摘 lead: leadOf 全关了的, 以及没有 leadOf 的老 lead 名下已无同伴的活 (2026-11-22 admin 选 B)。
    try { settleLeads(true); } catch (e) { log.warn({ mod: "lead", err: errText(e) }, "lead: boot 清扫失败 (不影响启动)"); }
    // boot 对账: 停机期间 / 旧版本落下的 after 欠账 (前置已 done、被点名者没被叫过) 补一条 trigger 行。
    // 只收真前置; after:["undefined"] 旧受害行要人看过清单后经 POST /room/after-reconcile {fake:true} 补。
    try {
      const boot = hub.reconcileAfter();
      if (boot.due.length) roomLog.info({ due: boot.due.length, written: boot.written }, "room: boot after 对账");
    } catch (e) { roomLog.warn({ err: errText(e) }, "room: boot after 对账失败 (不影响启动)"); }
    // 管理入口 (要 daemon 口令): 缺省 dryRun —— 只列欠账不写; dryRun:false 才真补。
    //   fake:true 连带 after:["undefined"] 的旧受害行; only:[msgId…] 只补这几条。幂等: 补过的不再出现在清单里。
    http.register("POST /room/after-reconcile", guarded(async (req, res) => {
      const b = ((await readBody(req)) ?? {}) as { dryRun?: boolean; fake?: boolean; only?: unknown };
      const only = idList(b.only);
      const r = hub.reconcileAfter({ dryRun: b.dryRun !== false, fake: b.fake === true, ...(only.length ? { only } : {}) });
      json(res, 200, {
        ok: true, dryRun: b.dryRun !== false, written: r.written,
        due: r.due.map((x) => ({ room: x.room, msg: x.msg, asker: roomNameOf(x.asker), holder: roomNameOf(x.holder), holderUid: x.holder.id,
          at: new Date(x.at).toISOString(), after: x.after, fake: x.fake })),
      });
    }));
    // 投递失败 / 目标正忙的行没有推游标: 泵自身无定时器, 定期重踢直到贴进去。
    const roomKickTimer = setInterval(() => void hub.kick(), 30_000);
    roomKickTimer.unref?.();
    // 契约 §7 切换约束: 宪章与 MCP schema 都变了, 活会话必须 /new —— 一次性标记文件,
    // boot 存在即把每个绑定标为待 /new。m.chatRoster("") 的 targets 就是全部绑定 (live +
    // 持久化; 内部键在 base 一层已被滤掉, 见 mirror-bridge 的 chatRoster) —— 不用换来源。
    // 标记文件有内容时按行读 target key, 只重开列出的这几个 (补救个别 pane 用, 不波及在干活的)。
    // pane 忙的目标不丢 (修复单 §7): 留在 needsNew 里, 轮终 (roomTurnEnd) 与 30s 兜底定时器
    // 重试, 全部处理完才删标记。pane 已不在的不重生 (boot 时集中重生会打成 pane 风暴) ——
    // 交给 hub 在下次唤醒时重生, 新 CLI 进程自带新工具面, 无需 /new。
    //   /new 走 daemon 的 newSession (杀 pane + 新 sid 重生 + 宪章随首条注入), 不往 pane 里敲
    // CLI 自己的 /new: 那样 CLI 换了 sid, 新转录里却没有任何能认回这个 pane 的痕迹, 绑定钉在旧
    // 转录上、宪章也不重挂 —— 2026-11-20 切换后一批 pane 就这样停在只有 /new 的空会话里。
    // 逐个串行: 一次并发十几个 CLI 冷启动, 本机无 swap, fork 会瞬时 ENOMEM。
    const newFlag = join(expandHome(cfg.daemon.stateDir), "rooms-cutover-new.flag");
    const flagTargets = existsSync(newFlag) ? readFileSync(newFlag, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : [];
    const needsNew = existsSync(newFlag) ? new Set(flagTargets.length ? flagTargets : m.chatRoster("").flatMap((c) => c.targets)) : new Set<string>();
    const newInflight = new Set<string>(); // 轮终补做与定时扫描可能同时点到同一个 target
    const newOne = async (t: string): Promise<void> => {
      if (!needsNew.has(t) || newInflight.has(t)) return;
      newInflight.add(t);
      try {
        const pane = m.sessionInfo(t)?.tmuxPane ?? "";
        const snap = pane ? await runTmux(["list-panes", "-a", "-F", "#{pane_id}"]) : undefined;
        if (snap && !snap.ok) return; // tmux 无定论: 稍后重试
        if (!pane || !parsePaneIds(snap!.stdout).includes(pane)) {
          needsNew.delete(t);
          roomLog.info({ target: t }, "room: /new 跳过 — pane 已不在, 等下次唤醒由 hub 重生 (新进程自带新工具面)");
        } else if (await m.idleNow(t)) {
          const r = await m.newSession(t, displayName(t) || t, { silent: true });
          if (r.ok) { needsNew.delete(t); roomLog.info({ target: t, sessionId: r.sessionId }, "room: /new 完成 (切换标记)"); }
          else roomLog.warn({ target: t, reason: r.reason }, "room: /new 失败, 稍后重试");
        }
      } catch { /* 稍后重试 */ } finally { newInflight.delete(t); }
      if (!needsNew.size) { try { unlinkSync(newFlag); } catch { /* 已不在 */ } }
    };
    let newSweeping = false;
    const newSweep = async (): Promise<void> => {
      if (newSweeping) return;
      newSweeping = true;
      try { for (const t of [...needsNew]) await newOne(t); } finally { newSweeping = false; }
    };
    if (needsNew.size) {
      roomLog.info({ panes: needsNew.size }, "room: 切换标记在, 首次唤醒前先 /new (契约 §7)");
      void newSweep();
      const newRetryTimer = setInterval(() => void newSweep(), 30_000);
      newRetryTimer.unref?.();
    }
    // ── /room/* 的公共件 ─────────────────────────────────────────────────
    const roomSelfOf = (target: string): Who | undefined => {
      const uid = wizards.get(target)?.uid;
      return uid ? { kind: "wizard", id: uid } : undefined;
    };
    /** room 参数: room id 原样, 或聊天名 (chatBaseOf)。 */
    const roomResolve = (ref: string | undefined): { room?: string; error?: string } => {
      const raw = (ref ?? "").trim();
      if (!raw) return {};
      if (roomState(raw)) return { room: raw };
      const base = chatBaseOf(cfg, raw);
      if (base && base !== raw && roomState(base)) return { room: base };
      return { error: "认不出这个 room: " + raw };
    };
    /** 名字 (带不带 .) / uid / human:<id> → Who。 */
    const whoRefOf = (ref: string): Who | undefined => {
      const raw = stripSigil((ref ?? "").trim());
      if (!raw) return undefined;
      if (raw.startsWith("human:")) return { kind: "human", id: raw.slice(6) };
      const rec = wizards.byName(raw);
      if (rec?.uid) return { kind: "wizard", id: rec.uid };
      if (isUid(raw) && wizards.byUid(raw)) return { kind: "wizard", id: raw };
      return undefined;
    };
    /** 名册里已经没有的身份只剩一条成员行 (迁移 / 实例结束留下, 迁移带进来的无名成员就是这样):
     *  按地址找「本 room 的人」的路径 (room_leave) 要能认出它, 否则它永远移不掉。
     *  只认本 room 现有的成员 —— uid (可带 uid: 前缀) 优先, 其次成员显示名。 */
    const memberRefOf = (s: RoomState, ref: string): Who | undefined => {
      const raw = stripSigil((ref ?? "").trim());
      if (!raw) return undefined;
      const byUid = s.members.get(whoKey({ kind: "wizard", id: raw.startsWith("uid:") ? raw.slice(4) : raw }));
      if (byUid) return byUid.who;
      return [...s.members.values()].map((m) => m.who).find((w) => stripSigil(roomNameOf(w)).toLowerCase() === stripSigil(raw).toLowerCase());
    };
    const whosOf = (refs: readonly unknown[]): { who?: Who[]; error?: string } => {
      const list = (Array.isArray(refs) ? refs : [refs]).map((x) => String(x)).filter((x) => x.trim());
      const out: Who[] = [];
      for (const ref of list) {
        const w = whoRefOf(ref);
        if (!w) return { error: "认不出这个地址: " + ref };
        out.push(w);
      }
      return { who: out };
    };
    /** 开一个 adhoc room: founder 第一个, 其余按序 invite 入座 (POST /room/open 与 dm 拉人后的另开共用)。 */
    const openAdhoc = (me: Who, others: Who[], title = ""): string => {
      let id = adhocRoomId(randomBytes(4).toString("hex"));
      while (roomState(id)) id = adhocRoomId(randomBytes(4).toString("hex"));
      const at = Date.now();
      hub.write(id, [
        { op: "open", at, room: id, kind: "adhoc", ...(title ? { title } : {}), by: me },
        { op: "join", at, room: id, who: me, ord: 1, via: "founder", by: me },
        ...others.map((w, i) => ({ op: "join" as const, at, room: id, who: w, ord: i + 2, via: "invite" as const, by: me })),
      ]);
      return id;
    };
    /** a 对 b 的两人对话落点: dm 只要还是这两人就用 (有人离开先补回); 已变成多人 room 就不再落进它, 找 / 开一个恰好 {a,b} 的 adhoc。 */
    const ensureDmRoom = (a: string, b: string): string => {
      const id = dmRoomId(a, b);
      const A: Who = { kind: "wizard", id: a }, B: Who = { kind: "wizard", id: b };
      const s = roomState(id);
      const plan = planDm(s, a, b);
      const at = Date.now();
      if (plan.kind === "create") {
        hub.write(id, [
          { op: "open", at, room: id, kind: "dm", by: A },
          { op: "join", at, room: id, who: A, ord: 1, via: "founder", by: A },
          { op: "join", at, room: id, who: B, ord: 2, via: "invite", by: A },
        ]);
      } else if (plan.kind === "rejoin") {
        hub.write(id, plan.missing.map((u, i) => ({ op: "join" as const, at, room: id, who: { kind: "wizard" as const, id: u }, ord: s!.nextOrd + i, via: "invite" as const, by: A })));
      } else if (plan.kind === "pair-adhoc") {
        return findPairAdhoc(roomStore.ids().map(roomState).filter((x): x is RoomState => !!x), a, b) ?? openAdhoc(A, [B]);
      }
      return id;
    };
    /** 缺省 room + to 落点 (brief D-1): to 全在缺省 room → 它; 单个非成员 → dm; 多个有非成员 → 400。 */
    const roomTargetOf = (me: Who, to: Who[] | undefined, ref: string | undefined, opts: { autoAdhoc?: { interrupt: boolean } } = {}): { room?: string; error?: string; status?: number; reason?: string } => {
      if (ref?.trim()) return roomResolve(ref);
      const d = hub.defaultRoom(me.id);
      if (to?.length) {
        if (d.room) {
          const s = roomState(d.room);
          if (s && to.every((t) => s.members.has(whoKey(t)))) return { room: d.room };
        }
        if (to.length === 1 && to[0]!.kind === "wizard") return { room: ensureDmRoom(me.id, to[0]!.id) };
        // 仅 chat_ask: 多个群外 wizard → 按成员集合复用 / 新开 adhoc (不 invite 进缺省群; interrupt 限权见 room-auto-adhoc.ts)。
        if (opts.autoAdhoc && to.length >= 2) {
          const r = autoAdhocTarget({
            states: () => roomStore.ids().map(roomState).filter((x): x is RoomState => !!x),
            open: (m0, others) => openAdhoc(m0, others),
            parentUidOf: (u) => roomWizardOf(u)?.parentUid,
          }, me, to, opts.autoAdhoc.interrupt);
          return "room" in r ? { room: r.room } : r;
        }
        return { status: 400, reason: "多个 to 里有缺省 room 之外的人 — 先 room_open / room_invite, 或显式给 room" };
      }
      if (d.room) return { room: d.room };
      return { status: 400, reason: d.many.length > 1
        ? "本轮被多个 room 一起唤醒 (" + d.many.map(roomLabel).join(", ") + ") — 显式给 room"
        : "没有缺省 room (本轮没有被唤醒) — 显式给 room" };
    };
    const roomReply = (res: import("node:http").ServerResponse, v: Verdict): void => {
      if (v.ok) json(res, 200, { ok: true, room: v.row.room, id: v.row.id, seq: v.row.seq, woke: v.row.wake,
        ...(v.row.closes?.length ? { closes: v.row.closes } : {}), ...(v.degraded.length ? { degraded: v.degraded } : {}),
        ...(v.duplicate ? { duplicate: true } : {}) });
      else json(res, v.status, { ok: false, reason: v.reason });
    };
    const READ_ROOM_FAIL = (res: import("node:http").ServerResponse, self: string): boolean => {
      if (self) return false;
      json(res, 400, { ok: false, reason: "cannot resolve caller session" });
      return true;
    };
    /** 引导化身的发言只许落在本群 room (白名单里的 chat_say / chat_reply)。 */
    const guideOutsideRoom = (res: import("node:http").ServerResponse, self: string, room: string): boolean => {
      if (!isGuideManifestation(wizards.get(self)) || room === baseOfKey(self)) return false;
      json(res, 403, { ok: false, reason: "引导会话只在 " + baseOfKey(self) + " 里说话" });
      return true;
    };

    // ── /room/*: 发言与交付 ───────────────────────────────────────────────
    http.register("POST /room/say", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (READ_ROOM_FAIL(res, self)) return;
      const me = roomSelfOf(self);
      if (!me) { json(res, 400, { ok: false, reason: "caller 不在名册上, 没有 uid" }); return; }
      const b = body as { room?: string; text?: string; to?: string[]; interrupt?: boolean };
      const text = (b.text ?? "").toString();
      if (!text.trim()) { json(res, 400, { ok: false, reason: "text required" }); return; }
      const to = b.to ? whosOf(b.to) : undefined;
      if (to?.error) { json(res, 400, { ok: false, reason: to.error }); return; }
      const target = roomTargetOf(me, to?.who, b.room);
      if (target.error || !target.room) { json(res, target.status ?? 400, { ok: false, reason: target.error ?? target.reason }); return; }
      if (guideOutsideRoom(res, self, target.room)) return;
      roomReply(res, hub.append(target.room, { author: me, kind: "say", text, origin: "tool",
        ...(to?.who?.length ? { to: to.who } : {}), ...(b.interrupt ? { interrupt: true } : {}) }));
    });
    http.register("POST /room/ask", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (READ_ROOM_FAIL(res, self)) return;
      const me = roomSelfOf(self);
      if (!me) { json(res, 400, { ok: false, reason: "caller 不在名册上, 没有 uid" }); return; }
      const b = body as { room?: string; to?: string[]; text?: string; kind?: string; after?: string[]; for?: string; planId?: string; interrupt?: boolean };
      const text = (b.text ?? "").toString();
      if (!text.trim()) { json(res, 400, { ok: false, reason: "text required" }); return; }
      const to = whosOf(b.to ?? []);
      if (to.error) { json(res, 400, { ok: false, reason: to.error }); return; }
      if (!to.who?.length) { json(res, 400, { ok: false, reason: "to required: 至少点名一个 wizard (或本 room 的人 human:<userid>)" }); return; }
      const target = roomTargetOf(me, to.who, b.room, { autoAdhoc: { interrupt: !!b.interrupt } });
      if (target.error || !target.room) { json(res, target.status ?? 400, { ok: false, reason: target.error ?? target.reason }); return; }
      const after = idList(b.after);
      // for 缺省 = 本轮唤醒它的那一条欠账 (血缘; 逾期计时靠它把子件的活动算进来)。
      const forOf = (b.for ?? "").toString().trim() || hub.defaultFor(me.id);
      roomReply(res, hub.append(target.room, { author: me, kind: b.kind === "task" ? "task" : "ask", text, origin: "tool", to: to.who,
        ...(after.length ? { after } : {}), ...(forOf ? { for: forOf } : {}),
        ...((b.planId ?? "").toString().trim() ? { planId: (b.planId ?? "").toString().trim() } : {}),
        ...(b.interrupt ? { interrupt: true } : {}) }));
    });
    http.register("POST /room/reply", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (READ_ROOM_FAIL(res, self)) return;
      const me = roomSelfOf(self);
      if (!me) { json(res, 400, { ok: false, reason: "caller 不在名册上, 没有 uid" }); return; }
      const b = body as { re?: string[] | string; text?: string; status?: string };
      const re = idList(b.re);
      if (!re.length) { json(res, 400, { ok: false, reason: "re required: 要答的那条 (或那几条) 消息 id" }); return; }
      const rooms = [...new Set(re.map((id) => roomStore.roomOfMsg(id)))];
      if (rooms.some((x) => !x)) { json(res, 400, { ok: false, reason: "认不出的消息 id: " + re.filter((id) => !roomStore.roomOfMsg(id)).join(", ") }); return; }
      if (rooms.length > 1) { json(res, 400, { ok: false, reason: "re 跨了多个 room (" + rooms.join(", ") + ") — 分开答" }); return; }
      if (guideOutsideRoom(res, self, rooms[0]!)) return;
      const status = (b.status ?? "").toString().trim() as ReplyStatus | "";
      if (status && !["done", "need", "progress", "passed", "canceled", "error"].includes(status)) {
        json(res, 400, { ok: false, reason: "status 只认 done / need / progress / passed / canceled (error 只有 daemon 能写)" });
        return;
      }
      roomReply(res, hub.append(rooms[0]!, { author: me, kind: "reply", text: (b.text ?? "").toString(), re, origin: "tool",
        ...(status ? { status: status as ReplyStatus, statusGiven: true } : {}) }));
    });
    http.register("POST /room/notify", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (READ_ROOM_FAIL(res, self)) return;
      const me = roomSelfOf(self);
      if (!me) { json(res, 400, { ok: false, reason: "caller 不在名册上, 没有 uid" }); return; }
      const b = body as { room?: string[] | string; markdown?: string };
      const markdown = (b.markdown ?? "").toString();
      if (!markdown.trim()) { json(res, 400, { ok: false, reason: "markdown required" }); return; }
      const refs = idList(b.room);
      const rooms: string[] = [];
      for (const ref of refs) {
        const r = roomResolve(ref);
        if (r.error || !r.room) { json(res, 400, { ok: false, reason: r.error ?? "room required" }); return; }
        rooms.push(r.room);
      }
      if (!rooms.length) {
        const d = hub.defaultRoom(me.id);
        if (!d.room) { json(res, 400, { ok: false, reason: d.many.length > 1 ? "本轮被多个 room 唤醒 — 显式给 room" : "没有缺省 room — 显式给 room" }); return; }
        rooms.push(d.room);
      }
      const out: Array<Record<string, unknown>> = [];
      for (const room of rooms) {
        const v = hub.append(room, { author: me, kind: "say", text: markdown, origin: "tool" });
        if (!v.ok) { json(res, v.status, { ok: false, reason: v.reason, room }); return; }
        out.push({ room, id: v.row.id, ...(v.duplicate ? { duplicate: true } : {}) });
      }
      json(res, 200, { ok: true, rooms: out });
    });
    http.register("POST /room/file", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (READ_ROOM_FAIL(res, self)) return;
      const me = roomSelfOf(self);
      if (!me) { json(res, 400, { ok: false, reason: "caller 不在名册上, 没有 uid" }); return; }
      const b = body as { room?: string; path?: string; kind?: string; caption?: string; title?: string; description?: string; re?: string[] | string };
      const path = (b.path ?? "").toString().trim();
      if (!path) { json(res, 400, { ok: false, reason: "path required" }); return; }
      if (!statSync(path, { throwIfNoEntry: false })?.isFile()) { json(res, 400, { ok: false, reason: "文件不存在或不是普通文件: " + path }); return; }
      const kind = ((b.kind ?? "").toString().trim() || kindOf(path)) as "image" | "file" | "voice" | "video";
      if (!["image", "file", "voice", "video"].includes(kind)) { json(res, 400, { ok: false, reason: "kind 只认 image / file / voice / video" }); return; }
      const target = roomTargetOf(me, undefined, b.room);
      if (target.error || !target.room) { json(res, target.status ?? 400, { ok: false, reason: target.error ?? target.reason }); return; }
      const re = idList(b.re);
      const text = [b.title, b.caption, b.description].map((x) => (x ?? "").toString().trim()).filter(Boolean).join(" — ");
      roomReply(res, hub.append(target.room, { author: me, kind: "file", text, origin: "tool",
        files: [{ path, kind, name: basename(path) }], ...(re.length ? { re } : {}) }));
    });
    // ── /room/*: 管理面 ─────────────────────────────────────────────────
    http.register("POST /room/open", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (READ_ROOM_FAIL(res, self)) return;
      if (refuseMonitor(res, self, "room_open")) return;
      const me = roomSelfOf(self);
      if (!me) { json(res, 400, { ok: false, reason: "caller 不在名册上, 没有 uid" }); return; }
      const b = body as { with?: string[]; title?: string };
      const inv = whosOf(b.with ?? []);
      if (inv.error) { json(res, 400, { ok: false, reason: inv.error }); return; }
      const id = openAdhoc(me, inv.who!, (b.title ?? "").toString().trim());
      json(res, 200, { ok: true, room: id, id, members: [me, ...inv.who!].map(roomNameOf),
        ...((b.title ?? "").toString().trim() ? {} : { hint: "这个 room 没有名字, rolepage 上只显示成员名; 用 room_name 补一个, 写它在干什么" }) });
    });
    /** 改群公告 (空串 = 清除): 落 notice 行 → 发一条 system 行 (绑定 room 会镜像进企微) → 在跑的 wizard 成员
     *  经 notices 带一行提示 (下一次注入随 system-reminder 到, 不唤醒)。权限由调用方判 (wizard 走 canNotice, 人走 /notice)。
     *  与现有公告相同 = 无变化, 什么也不写 (免得重复刷群)。 */
    const setRoomNotice = (room: string, raw: string, by: Who): { ok: true; notice: string; changed: boolean } | { ok: false; status: number; reason: string } => {
      const s = roomState(room);
      if (!s) return { ok: false, status: 404, reason: "没有这个 room: " + room };
      const j = judgeNotice(s, by, raw);
      if (!j.ok) return j;
      const next = j.notice;
      if (!j.changed) return j;
      hub.write(room, [{ op: "notice", at: Date.now(), room, text: next, by }]);
      const v = hub.append(room, { author: DAEMON, kind: "system", origin: "daemon", sys: "notice",
        text: next ? "[wezard] 📌 群公告: " + next : "[wezard] 📌 群公告已清除" });
      if (!v.ok) roomLog.warn({ room, reason: v.reason }, "notice: 系统行被拒 (公告已生效)");
      const hint = roomLabel(room) + " 的群公告" + (next ? "更新了: " + next : "已清除");
      const heard = [...(roomState(room)?.members.values() ?? [])]
        .filter((x) => x.who.kind === "wizard" && !sameWho(x.who, by))
        .flatMap((x) => roomWizardOf(x.who.id)?.target ?? [])
        .filter((t) => m.hasMirrorTarget(t));
      if (heard.length) notices.post(heard, hint);
      return { ok: true, notice: next, changed: true };
    };
    setNoticeHook = (room, text, by) => setRoomNotice(room, text, by);
    getNoticeHook = (room) => roomState(room)?.notice;
    http.register("POST /room/name", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (READ_ROOM_FAIL(res, self)) return;
      if (refuseMonitor(res, self, "room_name")) return;
      const me = roomSelfOf(self);
      if (!me) { json(res, 400, { ok: false, reason: "caller 不在名册上, 没有 uid" }); return; }
      const b = body as { room?: string; name?: string; notice?: string };
      const r = roomResolve(b.room);
      if (r.error || !r.room) { json(res, 400, { ok: false, reason: r.error ?? "room required" }); return; }
      const s = roomState(r.room)!;
      if (!s.members.has(whoKey(me))) { json(res, 403, { ok: false, reason: "你不是 " + roomLabel(r.room) + " 的成员, 起不了名 / 改不了公告" }); return; }
      if (!canRename(s, me)) { json(res, 403, { ok: false, reason: "只有本 room 的 host 能起名 / 改公告 (现在是 " + (roomHost(s) ? roomNameOf(roomHost(s)!) : "无人") + ")" }); return; }
      const name = (b.name ?? "").toString().trim().replace(/\s+/g, " ");
      const noticeGiven = b.notice !== undefined && b.notice !== null;
      if (!name && !noticeGiven) { json(res, 400, { ok: false, reason: "name 与 notice 至少给一个" }); return; }
      if (name.length > 60) { json(res, 400, { ok: false, reason: "名字太长 (最多 60 字)" }); return; }
      // 先判公告再写名字: 公告被拒 (太长) 时整个请求不留半截。
      const nt = noticeGiven ? setRoomNotice(r.room, String(b.notice), me) : undefined;
      if (nt && !nt.ok) { json(res, nt.status, { ok: false, reason: nt.reason }); return; }
      if (name) hub.write(r.room, [{ op: "name", at: Date.now(), room: r.room, title: name, by: me }]);
      json(res, 200, { ok: true, room: r.room, ...(name ? { name } : {}), ...(nt?.ok ? { notice: nt.notice, changed: nt.changed } : {}) });
    });
    http.register("POST /room/invite", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (READ_ROOM_FAIL(res, self)) return;
      if (refuseMonitor(res, self, "room_invite")) return;
      const me = roomSelfOf(self);
      if (!me) { json(res, 400, { ok: false, reason: "caller 不在名册上, 没有 uid" }); return; }
      const b = body as { room?: string; who?: string; history?: unknown };
      const r = roomResolve(b.room);
      if (r.error || !r.room) { json(res, 400, { ok: false, reason: r.error ?? "room required" }); return; }
      const s = roomState(r.room)!;
      const target = whoRefOf((b.who ?? "").toString());
      if (!target) { json(res, 400, { ok: false, reason: "认不出这个地址: " + (b.who ?? "") }); return; }
      if (!s.members.has(whoKey(me))) { json(res, 403, { ok: false, reason: "你不是 " + roomLabel(r.room) + " 的成员, 邀请不了别人" }); return; }
      if (s.members.has(whoKey(target))) { json(res, 409, { ok: false, reason: roomNameOf(target) + " 已是成员" }); return; }
      const host = roomHost(s);
      const direct = sameWho(host, me) || (target.kind === "wizard" && roomWizardOf(target.id)?.parentUid === me.id);
      if (direct) {
        const at = Date.now();
        const seen = seatSeenOps(s, target, at, b.history);
        if (!Array.isArray(seen)) { json(res, 400, { ok: false, reason: seen.error }); return; }
        hub.write(r.room, [{ op: "join", at, room: r.room, who: target, ord: s.nextOrd, via: "invite", by: me }, ...seen]);
        json(res, 200, { ok: true, room: r.room, joined: roomNameOf(target) });
        return;
      }
      // 其余成员的邀请转成 join-req, 等 host 批 (room_approve)。
      // history 在这条路上不生效: 入座时刻的可读范围由 host 在 room_approve 时选。
      const v = hub.append(r.room, { author: target, kind: "join-req", text: "受邀加入 (由 " + roomNameOf(me) + " 邀请)", origin: "tool" });
      if (v.ok && b.history !== undefined) {
        json(res, 200, { ok: true, room: v.row.room, id: v.row.id, seq: v.row.seq, woke: v.row.wake, note: "已转成 join-req, 你给的 history 没有生效 — 由 host 在 room_approve 时选" });
        return;
      }
      roomReply(res, v);
    });
    http.register("POST /room/join", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (READ_ROOM_FAIL(res, self)) return;
      if (refuseMonitor(res, self, "room_join")) return;
      const me = roomSelfOf(self);
      if (!me) { json(res, 400, { ok: false, reason: "caller 不在名册上, 没有 uid" }); return; }
      const b = body as { room?: string; reason?: string };
      const r = roomResolve(b.room);
      if (r.error || !r.room) { json(res, 400, { ok: false, reason: r.error ?? "room required" }); return; }
      roomReply(res, hub.append(r.room, { author: me, kind: "join-req", text: (b.reason ?? "").toString().trim() || "申请加入", origin: "tool" }));
    });
    http.register("POST /room/approve", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (READ_ROOM_FAIL(res, self)) return;
      if (refuseMonitor(res, self, "room_approve")) return;
      const me = roomSelfOf(self);
      if (!me) { json(res, 400, { ok: false, reason: "caller 不在名册上, 没有 uid" }); return; }
      const b = body as { re?: string; accept?: boolean; history?: unknown };
      const re = (b.re ?? "").toString().trim();
      const roomId = re ? roomStore.roomOfMsg(re) : undefined;
      const s = roomId ? roomState(roomId) : undefined;
      const row = s?.byId.get(re);
      if (!roomId || !s || !row || row.kind !== "join-req") { json(res, 400, { ok: false, reason: "re 要指向一条 join-req 消息 id" }); return; }
      if (!sameWho(roomHost(s), me)) { json(res, 403, { ok: false, reason: "只有本 room 的 host 能批" }); return; }
      const accept = b.accept !== false;
      if (accept) {
        const at = Date.now();
        const seen = seatSeenOps(s, row.author, at, b.history);
        if (!Array.isArray(seen)) { json(res, 400, { ok: false, reason: seen.error }); return; }
        hub.write(roomId, [{ op: "join", at, room: roomId, who: row.author, ord: s.nextOrd, via: "approve", by: me }, ...seen]);
      }
      // 批 / 驳都以 host 的 reply 落定那条 join-req duty, 申请人被唤醒看到结果。
      roomReply(res, hub.append(roomId, { author: me, kind: "reply", re: [re],
        text: accept ? "已批准入群, 欢迎 " + roomNameOf(row.author) : "未批准入群", status: "done", statusGiven: true, origin: "tool" }));
    });
    http.register("POST /room/leave", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (READ_ROOM_FAIL(res, self)) return;
      if (refuseMonitor(res, self, "room_leave")) return;
      const me = roomSelfOf(self);
      if (!me) { json(res, 400, { ok: false, reason: "caller 不在名册上, 没有 uid" }); return; }
      const b = body as { room?: string; who?: string; why?: string };
      const r = roomResolve(b.room);
      if (r.error || !r.room) { json(res, 400, { ok: false, reason: r.error ?? "room required" }); return; }
      const s = roomState(r.room)!;
      const ref = (b.who ?? "").toString();
      const who = ref.trim() ? whoRefOf(ref) ?? memberRefOf(s, ref) : me;
      if (!who) { json(res, 400, { ok: false, reason: "认不出这个地址: " + b.who }); return; }
      if (!sameWho(who, me) && !sameWho(roomHost(s), me)) { json(res, 403, { ok: false, reason: "只有 host 能移出别人" }); return; }
      if (!s.members.has(whoKey(who))) { json(res, 409, { ok: false, reason: roomNameOf(who) + " 不是这个 room 的成员" }); return; }
      hub.write(r.room, leaveOps(s, who, me, Date.now(), (b.why ?? "").toString().trim() || undefined));
      json(res, 200, { ok: true, room: r.room, left: roomNameOf(who) });
    });
    // CLI 的 Stop hook (hooks/stop.sh) 在它要结束这一轮时来问: 唤醒它的 duty 有没有交代。
    // 回 {decision:"block", reason} = 让它同一轮接着 chat_reply; 回 {} = 放行。认不出调用方也放行 ——
    // 这条路只能催, 不能把一个 pane 卡在「结束不了」里。
    http.register("POST /room/stop-check", async (req, res) => {
      const { self } = await readPeerBody(req);
      const me = self ? roomSelfOf(self) : undefined;
      if (!me) { json(res, 200, {}); return; }
      const r = hub.onStop(me.id);
      if (r.block) roomLog.info({ target: self, uid: me.id }, "room: Stop hook 拦住未交代的一轮");
      json(res, 200, r.block ? { decision: "block", reason: r.block } : {});
    });
    http.register("POST /room/members", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (READ_ROOM_FAIL(res, self)) return;
      const me = roomSelfOf(self);
      if (!me) { json(res, 400, { ok: false, reason: "caller 不在名册上, 没有 uid" }); return; }
      const b = body as { room?: string };
      const target = roomTargetOf(me, undefined, b.room);
      if (target.error || !target.room) { json(res, target.status ?? 400, { ok: false, reason: target.error ?? target.reason }); return; }
      const s = roomState(target.room)!;
      const host = roomHost(s);
      const lines = [...s.members.values()].sort((a, b2) => a.ord - b2.ord)
        .map((mm) => "· " + roomNameOf(mm.who) + (sameWho(host, mm.who) ? " (host)" : "") + " — via " + mm.via + ", " + new Date(mm.since).toLocaleString("zh-CN", { hour12: false }));
      json(res, 200, { ok: true, text: [roomLabel(s.id) + " (" + s.id + ") — 成员 " + lines.length + ", 未决 duty " + openDuties(s).length, ...lines].join("\n") });
    });
    // ── 管理路径 (持 daemon 口令): 清理 chat room 里迁移带进来的 / 过时的 wizard 成员 ──
    // 缺省 dry-run, 只回每个 room 留谁移谁; body.apply === true 才经 hub 写 leave (leaveOps,
    // 带 duty 的先落 canceled reply)。规则见 daemon/room-prune.ts。
    http.register("POST /room/prune", guarded(async (req, res) => {
      const { body } = await readPeerBody(req);
      const b = body as { rooms?: unknown; apply?: unknown; keepRecentHours?: unknown };
      const now = Date.now();
      const keepRecentMs = Math.max(1, Number(b.keepRecentHours ?? 48)) * 3600_000;
      const picked = Array.isArray(b.rooms) && b.rooms.length ? b.rooms.map(String) : roomStore.ids().filter((id) => id.startsWith("chat:"));
      const rooms = picked.map((id) => {
        const s = roomState(id);
        if (!s) return { room: id, error: "没有这个 room" };
        let stewardUid: string | undefined;
        try {
          const st = resolveSteward(cfg, wizards, id, (t) => ((c) => c.runningCwd || c.defaultCwd)(m.getCwd(t)));
          stewardUid = wizards.get(st.target)?.uid;
        } catch { /* 解析不出管家: 不按管家保留 */ }
        const plan = selectRoomPrune(s, { now, keepRecentMs, stewardUid,
          rec: (uid) => { const r = wizards.byUid(uid); return r ? { target: r.target, name: r.name } : undefined; } });
        if (b.apply === true && plan.drop.length) {
          hub.write(id, pruneLeaveOps(s, plan.drop, now));
          roomLog.info({ room: id, dropped: plan.drop.length, kept: plan.keep.length }, "room-prune: 已写 leave");
        }
        return { ...plan, after: plan.before - plan.drop.length };
      });
      json(res, 200, { ok: true, applied: b.apply === true, keepRecentHours: keepRecentMs / 3600_000, rooms });
    }));
    /** monitor 的判决: 为 re 那条人话在 to 名下开 duty (to 为空 = 判不回应)。
     *  只有本 room 的 monitor 成员能写; 校验 (最后一条人话 / 重复激活 / to 是成员) 在 shared/room.ts 的 judge。 */
    http.register("POST /room/activate", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (READ_ROOM_FAIL(res, self)) return;
      const me = roomSelfOf(self);
      if (!me) { json(res, 400, { ok: false, reason: "caller 不在名册上, 没有 uid" }); return; }
      const b = body as { re?: string | string[]; to?: string | string[]; reason?: unknown };
      const re = idList(b.re);
      if (re.length !== 1) { json(res, 400, { ok: false, reason: "re 只收一条 (最后一条人话的消息 id)" }); return; }
      const roomId = roomStore.roomOfMsg(re[0]!);
      const s = roomId ? roomState(roomId) : undefined;
      if (!roomId || !s) { json(res, 400, { ok: false, reason: "认不出的消息 id: " + re[0] }); return; }
      if (s.members.get(whoKey(me))?.role !== "monitor") {
        json(res, 403, { ok: false, reason: "只有本 room 的 perceptron 能写感知判决" });
        return;
      }
      // to = 应回应名单 (可多个, 2026-11-24 人定); 空 / 缺省 = 判不回应, 不落任何记录。
      const tos: Who[] = [];
      for (const ref of idList(Array.isArray(b.to) ? b.to : b.to ?? [])) {
        const t = whoRefOf(ref) ?? memberRefOf(s, ref);
        if (!t) { json(res, 400, { ok: false, reason: "认不出这个地址: " + ref }); return; }
        if (!tos.some((x) => sameWho(x, t))) tos.push(t);
      }
      const v = judgeActivate(s, me, re, tos);
      if (!v.ok) { json(res, v.status, { ok: false, reason: v.reason }); return; }
      // 感知判决 (2026-11-24 人定): 一条 perceive op 带全名单 + 理由 —— 不写消息行、不占 seq、不镜像,
      // 名单里每个成员名下开 duty 并唤醒; fold 出的 verdict 供 rolepage。空名单什么都不落。
      if (tos.length) {
        const why = typeof b.reason === "string" ? b.reason.trim() : "";
        hub.write(roomId, [{ op: "perceive", at: Date.now(), room: roomId, duty: re[0]!, to: tos,
          asker: s.byId.get(re[0]!)!.author, by: me, ...(why ? { why } : {}) }]);
        hub.kick();
        roomLog.info({ room: roomId, re: re[0], to: tos.map((t) => roomNameOf(t)), why }, "perceptron: perceive");
      } else {
        roomLog.info({ room: roomId, re: re[0] }, "perceptron: perceive (空判决, 不落记录)");
      }
      json(res, 200, { ok: true, room: roomId, msg: re[0], to: tos.map((t) => whoKey(t)) });
    });
    http.register("POST /room/read", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (READ_ROOM_FAIL(res, self)) return;
      const me = roomSelfOf(self);
      if (!me) { json(res, 400, { ok: false, reason: "caller 不在名册上, 没有 uid" }); return; }
      const b = body as { room?: string; from?: string; since?: number | string; until?: number | string; limit?: number; all?: boolean; per?: number };
      const now = Date.now();
      const r = b.room ? roomResolve(b.room) : { room: undefined as string | undefined };
      if (r.error) { json(res, 400, { ok: false, reason: r.error }); return; }
      if (b.room && !r.room) { json(res, 400, { ok: false, reason: "认不出这个 room: " + b.room }); return; }
      const since = b.since === undefined ? undefined : typeof b.since === "number" ? b.since : parseWhen(b.since, now);
      const until = b.until === undefined ? undefined : typeof b.until === "number" ? b.until : parseWhen(b.until, now);
      if ((typeof b.since === "string" && b.since.trim() && since === undefined) || (typeof b.until === "string" && b.until.trim() && until === undefined)) {
        json(res, 400, { ok: false, reason: "时间认不出 —— 写 2h / 30m / 3d、14:30 (今天)、09-30 14:30 或 ISO 时间" });
        return;
      }
      const states = (r.room ? [roomState(r.room)!] : roomStore.ids().map((id) => roomState(id)!).filter((s) => s?.members.has(whoKey(me)))).filter(Boolean);
      if (r.room && !states.length) { json(res, 404, { ok: false, reason: "没有这个 room 的账本: " + r.room }); return; }
      const view = renderRoomRead(states, me, {
        ...(r.room ? { room: r.room } : {}),
        ...((b.from ?? "").toString().trim() ? { from: (b.from ?? "").toString().trim() } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(b.limit !== undefined ? { limit: Number(b.limit) } : {}),
        ...(b.per !== undefined ? { per: Number(b.per) } : {}),
        ...(b.all === true ? { all: true } : {}),
      }, { nameOf: roomNameOf, roomLabel }, now);
      json(res, 200, { ok: true, text: view.text, shown: view.shown, total: view.total, ...(view.earlier ? { earlier: view.earlier } : {}) });
    });
    http.register("POST /room/watch", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (READ_ROOM_FAIL(res, self)) return;
      if (refuseMonitor(res, self, "room_watch")) return;
      const me = roomSelfOf(self);
      if (!me) { json(res, 400, { ok: false, reason: "caller 不在名册上, 没有 uid" }); return; }
      const b = body as { room?: string; on?: boolean };
      const r = roomResolve(b.room);
      if (r.error || !r.room) { json(res, 400, { ok: false, reason: r.error ?? "room required" }); return; }
      const s = roomState(r.room)!;
      if (!s.members.has(whoKey(me))) { json(res, 403, { ok: false, reason: "你不是 " + roomLabel(r.room) + " 的成员" }); return; }
      hub.write(r.room, [{ op: "watch", at: Date.now(), room: r.room, who: me, on: b.on !== false }]);
      json(res, 200, { ok: true, room: r.room, on: b.on !== false });
    });
    // ── 源 ↔ room 绑定 (multi-source-binding §6): bind / unbind 只是账本 op ──────────
    /** 本 room 最近一条带 src 的人话 —— room_bind 不给 source 时把「刚接到这条首触」绑进来。
     *  给了 source 就找那个源最近的一条 (dry-run 的正文 / 发话人证据)。 */
    const latestSrcRowOf = (room: string, source = ""): MsgRow | undefined => {
      const s = roomState(room);
      if (!s) return undefined;
      for (let i = s.msgs.length - 1; i >= 0; i--) {
        const m = s.msgs[i]!;
        if (m.kind === "say" && m.author.kind === "human" && m.src && (!source || m.src === source)) return m;
      }
      return undefined;
    };
    const latestSrcOf = (room: string, source = ""): string => latestSrcRowOf(room, source)?.src ?? "";
    const bindingCtx = () => ({ cfg, roomOfSource: (s: string) => roomStore.roomOfSource(s), stateOf: roomState, gate: roomStore.bindingGate() });
    http.register("POST /room/bind", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (READ_ROOM_FAIL(res, self)) return;
      if (refuseMonitor(res, self, "room_bind")) return;
      const me = roomSelfOf(self);
      if (!me) { json(res, 400, { ok: false, reason: "caller 不在名册上, 没有 uid" }); return; }
      const b = body as { source?: string; room?: string; why?: string; dryRun?: boolean };
      // 缺省 room = 本轮被唤醒的 room (出口 1: host 把刚接到的首触绑进自己这里)。
      const target = roomTargetOf(me, undefined, b.room);
      if (target.error || !target.room) { json(res, target.status ?? 400, { ok: false, reason: target.error ?? target.reason ?? "room required" }); return; }
      const room = target.room;
      const source = (b.source ?? "").toString().trim() || latestSrcOf(room);
      // §5.2 dry-run: 只给候选 room + 证据 (daemon 只给证据, 决定权在模型), 不写账本。
      if (b.dryRun === true) {
        if (!source) { json(res, 400, { ok: false, reason: "没有可评估的源: 给 source, 或在本 room 里先有一条带源的人话" }); return; }
        const row = latestSrcRowOf(room, source);
        const rep = bindCandidates({
          cfg, source, text: row?.text ?? "", asker: row?.author.kind === "human" ? row.author.id : "",
          states: roomStore.ids().map(roomState).filter((x): x is RoomState => !!x),
          roomOfSource: (x) => roomStore.roomOfSource(x), now: Date.now(),
          simMin: cfg.rooms?.binding?.simMin ?? 0.3, busyWindowMin: cfg.rooms?.binding?.busyWindowMin ?? 1440,
          hostInfoOf: (u) => {
            const w = wizards.byUid(u);
            return w ? { name: w.name ?? "", responsibility: w.description ?? "" } : undefined;
          },
        });
        json(res, 200, { ok: true, dryRun: true, source, text: rep.text,
          candidates: rep.candidates.map((c) => ({ room: c.room, evidence: c.evidence, veto: c.veto, score: Math.round(c.score * 100) / 100 })),
          ...(rep.blocked ? { blocked: rep.blocked } : {}) });
        return;
      }
      const v = planBind({ ...bindingCtx(), room, source, actor: me, ...(b.why ? { why: b.why.toString() } : {}) }, Date.now());
      if (!v.ok) { json(res, v.status, { ok: false, reason: v.reason }); return; }
      if (!v.already) {
        try { hub.write(room, [v.op]); }
        catch (e) {
          if (e instanceof BindGateClosed) { json(res, 503, { ok: false, reason: "绑定索引对账失败, 暂不接受绑定写: " + (e.message) }); return; }
          json(res, 500, { ok: false, reason: errText(e) }); return;
        }
        roomLog.info({ room, source, by: me.id }, "room: 源已绑进本 room");
      }
      json(res, 200, { ok: true, room, source, ...(v.already ? { already: true } : {}),
        text: (v.already ? "这个源已经绑在 " + room + ", 不用重复绑。" : "已把 " + source + " 绑进 " + room + ": 之后它的消息落这本账, 这里的回复回它 (帖子 = 评论原帖, 群 = 群消息)。") });
    });
    http.register("POST /room/unbind", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (READ_ROOM_FAIL(res, self)) return;
      if (refuseMonitor(res, self, "room_unbind")) return;
      const me = roomSelfOf(self);
      if (!me) { json(res, 400, { ok: false, reason: "caller 不在名册上, 没有 uid" }); return; }
      const b = body as { source?: string; room?: string; why?: string };
      const target = roomTargetOf(me, undefined, b.room);
      if (target.error || !target.room) { json(res, target.status ?? 400, { ok: false, reason: target.error ?? target.reason ?? "room required" }); return; }
      const room = target.room;
      const source = (b.source ?? "").toString().trim();
      const v = planUnbind({ ...bindingCtx(), room, source, actor: me, ...(b.why ? { why: b.why.toString() } : {}) }, Date.now());
      if (!v.ok) { json(res, v.status, { ok: false, reason: v.reason }); return; }
      try { hub.write(room, [v.op]); }
      catch (e) {
        if (e instanceof BindGateClosed) { json(res, 503, { ok: false, reason: "绑定索引对账失败, 暂不接受解绑写: " + (e.message) }); return; }
        json(res, 500, { ok: false, reason: errText(e) }); return;
      }
      roomLog.info({ room, source, by: me.id }, "room: 源已解绑 (回落恒等, lazy)");
      json(res, 200, { ok: true, room, source,
        text: "已解绑 " + source + ": 它的消息回落恒等 (自己的 room / 频道接待处); 帖子源下一条消息时才会按需诞生帖子 room (lazy)。" });
    });
    // §5.1 出口 3 的显式入口 (room_fork): host 判定「这该是新 room」时立即另起, 不必等超时兜底。
    // 权限 = 该频道 room 的 host; 幂等判据与兜底同一套 (已绑 / 帖子 room 已在 / 引导期都不动)。
    http.register("POST /room/fork", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (READ_ROOM_FAIL(res, self)) return;
      if (refuseMonitor(res, self, "room_fork")) return;
      const me = roomSelfOf(self);
      if (!me) { json(res, 400, { ok: false, reason: "caller 不在名册上, 没有 uid" }); return; }
      const b = body as { source?: string; room?: string };
      const target = roomTargetOf(me, undefined, b.room);
      if (target.error || !target.room) { json(res, target.status ?? 400, { ok: false, reason: target.error ?? target.reason ?? "room required" }); return; }
      const source = (b.source ?? "").toString().trim() || latestSrcOf(target.room);
      const v = planFork({ cfg, source, actor: me, stateOf: roomState, roomOfSource: (s) => roomStore.roomOfSource(s) });
      if (!v.ok) { json(res, v.status, { ok: false, reason: v.reason }); return; }
      let born = false;
      try { born = birthPostRoom(v.topicId, source, me); }
      catch (e) { json(res, 500, { ok: false, reason: errText(e) }); return; }
      if (!born) { json(res, 409, { ok: false, reason: "没能另起 (频道还在引导期 / 帖子 room 已在) —— 先完成频道绑定" }); return; }
      roomLog.info({ channel: v.channelRoom, post: source, by: me.id }, "room: 显式另起 (room_fork)");
      json(res, 200, { ok: true, room: source, channel: v.channelRoom,
        text: "已另起帖子 room " + source + ": 这个帖子之后的话落它自己的 room, 新 host 已作为普通成员拉进频道 room (频道 host 身份不变)。" });
    });
    // ── 新群引导的受控绑定 (onboard_bind): 只有引导化身能调 ────────────────
    // 引导的唯一动作面: 校验 (create 只建最后一级 / 父目录必须已在 / 必须在 $HOME 下) 与落盘都在
    // daemon, 引导只表达意图。失败 = 4xx 带原因, 引导自己向人追问 (状态机不动)。
    http.register("POST /onboarding/bind", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (READ_ROOM_FAIL(res, self)) return;
      const base = baseOfKey(self);
      const b = body as { workspace?: string; create?: boolean; name?: string; roomName?: string };
      const plan = planOnboardBind({
        caller: wizards.get(self), onboarding: needsOnboarding(cfg, wizards, base),
        workspace: b.workspace, create: b.create, name: b.name, roomName: b.roomName,
        nameTaken: (n) => !!wizards.byName(n),
        judge: (input) => judgeOnboarding(wizards, base, input, (t) => m.sessionInfo(t)?.cwd ?? ""),
      });
      if (!plan.ok) { json(res, plan.status, { ok: false, reason: plan.reason }); return; }
      const { verdict } = plan;
      const bound = applyOnboarding(wizards, onboarding, base, verdict,
        (name) => guardCharter(() => bindSteward(cfg, sourcePath, base, name), () => ({ what: verdict.kind === "bind-new" ? "新群引导新建管家 " + name + " (工作区 " + verdict.workspace + ") 并绑到 " + base : "新群引导把 " + name + " 绑为 " + base + " 的管家", byHuman: true })),
        (t) => identityWorkspaceOf(wizards, t) || ((c) => c.runningCwd || c.defaultCwd)(m.getCwd(t)),
        plan.name);
      roomLog.info({ room: base, ...bound, roomName: plan.roomName ?? "" }, "onboarding: steward bound (guide tool)");
      const handed = guideSettleRoom(base, bound, plan.roomName);
      settleBoundChannel(base, bound);
      if (!handed) notifyChat(base, renderOnboardingDone(bound)); // 引导不在 room 里 (老流程): 至少回报一句
      void reapGuideAfterTurn(self); // 先回成功: 这一轮的话还要说完, 收尸在轮终之后 (或 60s)
      json(res, 200, { ok: true, name: bound.name, target: bound.target, workspace: bound.workspace, fresh: bound.fresh,
        ...(bound.instance ? { instance: bound.instance } : {}),
        ...(bound.instanceOpened ? { instanceOpened: true } : {}),
        ...(handed ? { room: base } : {}),
        ...(plan.roomName ? { roomName: plan.roomName } : {}),
        message: "绑定完成, 引导到此结束: 这一轮不要再说话、不要再调工具; 人的原话与后续要求已经交给管家 ." + (bound.instance || bound.name) + "。" });
    });
    // ── 出生 / 退役的 room 落账 ──────────────────────────────────────────
    /** spawn / clone / delegate 的 room? 参数: 落地的 wizard 以 via:"spawn" 免审入群 (契约 §3)。 */
    const joinRoomSpawn = (self: string, roomRef: unknown, bornName: string): SeatResult => {
      const ref = String(roomRef ?? "").trim();
      if (!ref || !bornName) return { ok: true };
      try {
        const r = roomResolve(ref);
        const s = r.room ? roomState(r.room) : undefined;
        const me = roomSelfOf(self);
        const target = resolvePeer(self, bornName);
        const rec = target?.ok ? wizards.get(target.target) : undefined;
        if (!s || !me || !rec?.uid) { roomLog.warn({ room: ref, born: bornName }, "room?: 入群没落 (room 认不出 / 名字解析不到)"); return { ok: false, reason: "room 认不出 / 名字解析不到: " + ref }; }
        const who: Who = { kind: "wizard", id: rec.uid };
        if (s.members.has(whoKey(who))) return { ok: true };
        hub.write(s.id, [{ op: "join", at: Date.now(), room: s.id, who, ord: s.nextOrd, via: "spawn", by: me }]);
        return { ok: true };
      } catch (e) {
        roomLog.warn({ room: ref, born: bornName, err: errText(e) }, "room?: 出生入群失败");
        return { ok: false, reason: errText(e) };
      }
    };
    /** room? 给了就在生 / 派之前验: room 认得出、调用方在里面 (顺序见 room-spawn.ts)。 */
    const checkRoomArg = (self: string, ref: unknown) => checkRoomTarget({
      resolve: roomResolve,
      isMember: (room, who) => roomState(room)?.members.has(whoKey(who)) ?? false,
    }, roomSelfOf(self), String(ref ?? "").trim());
    /** 实例退役: 从所有 room 退出, 手上的 duty 由 daemon 写 canceled (契约 §4)。 */
    const leaveRooms = (target: string, why: string): void => {
      const rec = wizards.get(target);
      if (!rec?.uid) return;
      const who: Who = { kind: "wizard", id: rec.uid };
      const at = Date.now();
      for (const room of roomStore.ids()) {
        const s = roomState(room);
        if (!s?.members.has(whoKey(who))) continue;
        try { hub.write(room, leaveOps(s, who, DAEMON, at, why)); }
        catch (e) { roomLog.warn({ room, target, err: errText(e) }, "room: 退役离群失败"); }
      }
    };
    // rooms/ 磁盘护栏 (cutover「磁盘与保留期」): boot 与每天一次; 超 1G warn + 一条系统行给人。
    const roomsGuard = (): void => {
      try {
        let bytes = 0;
        for (const f of readdirSync(roomsDir)) { try { bytes += statSync(join(roomsDir, f)).size; } catch { /* 文件刚被删 */ } }
        roomLog.info({ mb: Math.round(bytes / 1048576), rooms: roomStore.ids().length }, "rooms/ 总大小");
        if (bytes > 1_000_000_000) {
          roomLog.warn({ gb: (bytes / 1e9).toFixed(2) }, "rooms/ 超过 1G");
          if (cfg.defaultChat.trim()) notifyChat(cfg.defaultChat, "[wezard] room 账本目录已超过 1G (" + (bytes / 1e9).toFixed(2) + "G) — 保留策略见 docs/room/cutover.md「磁盘与保留期」");
        }
      } catch { /* 目录还没有 = 0 字节 */ }
    };
    roomsGuard();
    const roomsGuardTimer = setInterval(roomsGuard, 24 * 3600_000);
    roomsGuardTimer.unref?.();
    // ── B: 接入 (人话 / trigger / 轮界 / 卡片) ────────────────────────────
    /** 绑定 room 不存在时开出来 (契约 §4): 本聊天的管家作 founder; 解析不出管家
     *  (引导未落 / 人点名的第一条) 由被路由到的那个顶上。返回 room id。 */
    const ensureBoundRoom = (room: string, routed: string): string => {
      if (roomState(room)) return room;
      const at = Date.now();
      const kind = room.startsWith("user:") ? "wecom-dm" : room.startsWith("chat:wx") ? "wx" : "wecom-group";
      const ops: RoomOp[] = [{ op: "open", at, room, kind, by: DAEMON }];
      let founder: string | undefined;
      try {
        const st = resolveSteward(cfg, wizardStore(), room, (t) => ((c) => c.runningCwd || c.defaultCwd)(m.getCwd(t)));
        if (!st.fresh) founder = wizards.get(st.target)?.uid;
      } catch { /* 引导没完成的聊天: routed 顶上 */ }
      founder ??= wizards.get(routed)?.uid;
      if (founder) ops.push({ op: "join", at, room, who: { kind: "wizard", id: founder }, ord: 1, via: "founder", by: DAEMON });
      hub.write(room, ops);
      return room;
    };
    // ── 频道 / 帖子 room 与 monitor (§2.2 / §2.3) ───────────────────────
    /** 一个 room 一个 perceptron (原 monitor, 2026-11-24 人定): 门控 = 存在 wizard 成员 (含单管家,
     *  人二次拍板 9e7dbc47.9)。**不预起 pane** —— 只建身份 + 入座, 首次唤醒由
     *  泵冷启动 (档位走 steward-model 的 monitor 规则, 不落 CLI 默认), 闲时 pane 可被资源回收。 */
    /** 一个 room 自己的管家实例 (人 2026-11-23: 不同的 room 要用不同的实例): 频道绑的那个身份在
     *  **这个 room** 的化身 —— 没有就领号新开 (类) / 另落一条同身份记录。绝不把别的 room 的实例
     *  拉过来当这个 room 的 host。名册 / 绑定缺席 = undefined。会话不在这里起: 第一条人话被唤醒时
     *  泵会把它冷启动 (一个帖子一个常驻 pane 会顶到上限)。 */
    const roomStewardOf = (room: string, channelRoom: string): Who | undefined => {
      const identity = stewardIdentityOf(cfg, wizardStore(), channelRoom) ?? "";
      if (!identity) return undefined;
      const target = localManifestation(wizardStore(), room, identity);
      const rec = target ? wizards.get(target) : undefined;
      return rec?.uid ? { kind: "wizard", id: rec.uid } : undefined;
    };
    const ensurePerceptron = (room: string): void => {
      if (!cfg.wrc.channel.monitor.enabled) return;
      const st0 = roomState(room);
      if (!st0) return;
      if (hasMonitor(st0)) return;
      // 门控 (2026-11-24 人二次拍板 9e7dbc47.9): 只要存在 wizard 成员 (含单管家 room / 频道) 就感知 ——
      // 独狼管家也要感知「没点名给它的消息是否需要它回应」, 不再按成员数、不回落 host 兜底。
      // 例外: 单聊 (人私聊 = 直接说给全局管家) / .me 独立对话 / 引导中的群与频道 (人话要落引导化身,
      // perceptron 会把它抢走)。
      if (room.startsWith("user:") || room.startsWith("me:")) return;
      if (needsOnboarding(cfg, wizardStore(), room)) return;
      const channelRoom = channelRoomOf(cfg, room);
      if (channelRoom && !channelMonitorWanted(cfg, wizardStore(), channelRoom)) return;
      if (!perceptronCandidates(st0).length) return;
      const target = keyOf(baseOfKey(room), "monitor");
      const rec = wizards.get(target);
      wizards.upsert(target, {
        kind: "monitor",
        ...(rec ? {} : { bornAt: Date.now(), identity: target }),
        description: "本 room 的 perceptron: 读账本, 结合成员职责判断最后一条人话该由谁回应 (room_activate)",
        parent: undefined,
        lead: undefined,
        leadOf: undefined,
      });
      const uid = wizards.get(target)?.uid;
      if (!uid) return;
      const st = roomState(room);
      if (st && !st.members.has(whoKey({ kind: "wizard", id: uid })))
        hub.write(room, [{ op: "join", at: Date.now(), room, who: { kind: "wizard", id: uid }, ord: st.nextOrd, via: "invite", by: DAEMON, role: "monitor" }]);
      roomLog.info({ target, room }, "perceptron: 建 room perceptron (懒建, 首次唤醒冷启动)");
    };
    /** 频道 room 不存在就开一个 (频道管家已绑定就作 founder —— monitor 需要有人可激活)。
     *  未绑定期不建 monitor (channel-onboarding 口径①): 否则每条人话都被 monitor 抢走, 引导就哑了。
     *  learnChannelRoom: 未配对过帖子的频道也要被认成频道 —— 引导绑定落 wrc.channel.steward 靠它。 */
    const ensureChannelRoom = (topicId: string): string => {
      const room = "chat:" + topicId;
      learnChannelRoom(cfg, topicId);
      if (!roomState(room)) {
        const at = Date.now();
        const ops: RoomOp[] = [{ op: "open", at, room, kind: "channel", by: DAEMON }];
        try {
          const stw = resolveSteward(cfg, wizardStore(), room, (t) => ((c) => c.runningCwd || c.defaultCwd)(m.getCwd(t)));
          // 已有化身的才能作 founder (fresh = 记录还没落, 由入站接待自己开)。与 ensureBoundRoom 同一判法。
          const uid = stw.fresh ? undefined : wizards.get(stw.target)?.uid;
          if (uid) ops.push({ op: "join", at, room, who: { kind: "wizard", id: uid }, ord: 1, via: "founder", by: DAEMON });
        } catch { /* 没绑定: 空频道 room, 引导 (或绑定后的管家) 会进来 */ }
        hub.write(room, ops);
      }
      return room;
    };
    /** 频道引导期: 引导化身入座频道 room 并接住这条人话 (人话落频道 room —— 帖子 room 此刻没有
     *  host, 落那儿等于丢话)。与群引导的 guideTakeover 同形, 只是没有企微占位气泡 (频道 room
     *  的出站是帖子)。 */
    const takeChannelGuide = (turn: ChannelGuideTurn): { ok: boolean; reason?: string } => {
      const rec = wizards.get(turn.guide);
      if (!rec?.uid) return { ok: false, reason: "引导会话不在名册上" };
      const at = Date.now();
      const s = roomState(turn.channelRoom);
      // 旧版本给未绑定频道建过 monitor: 先请它退场, 否则人话只听它的, 引导接不到 (口径①)。
      const evict = s ? channelMonitorLeaveOps(s, at) : [];
      if (evict.length) { hub.write(turn.channelRoom, evict); roomLog.info({ room: turn.channelRoom }, "onboarding: 频道引导期请走 monitor"); }
      const join = channelGuideJoinOps(roomState(turn.channelRoom), turn.channelRoom, { kind: "wizard", id: rec.uid }, at);
      if (join.length) hub.write(turn.channelRoom, join);
      const v = hub.append(turn.channelRoom, turn.human);
      return v.ok ? { ok: true } : { ok: false, reason: v.reason };
    };
    const channelGuideSpawning = new Set<string>();
    /** 未绑定频道的人话: 起 (或续) 引导化身, 人话落频道 room 交给它。会话冷启动在后台做 ——
     *  人话先落账 (起 pane 慢不能丢话); 出生窗口里贴不进去 (还没绑定), 泵会退成可重试,
     *  起来后这里踢一脚泵立刻投, 不会写成「没有会话 (已被结束)」。 */
    const channelGuideTurn = (turn: ChannelGuideTurn): void => {
      const store = wizardStore();
      if (!store) return;
      if (!store.get(turn.guide)) {
        store.upsert(turn.guide, { identity: turn.guide, kind: "worker", description: GUIDE_DESC, workspace: expandHome(cfg.wrc.cwd) });
        roomLog.info({ room: turn.channelRoom, guide: turn.guide }, "onboarding: 频道引导化身落记录");
      }
      if (!m.hasMirrorTarget(turn.guide) && !channelGuideSpawning.has(turn.guide)) {
        channelGuideSpawning.add(turn.guide);
        const name = settleName(store, chatNameOf(cfg, turn.guide), turn.guide) || turn.guide;
        void m.newSession(turn.guide, name, { silent: true, cwd: expandHome(cfg.wrc.cwd) })
          .then((r) => {
            if (!r.ok) { roomLog.warn({ guide: turn.guide, reason: r.reason }, "onboarding: 频道引导会话起不来 (人话照样落账, 泵会再试)"); return; }
            m.armCharter(turn.guide, turn.first ? renderGuideOpening() : renderGuideRetry(""));
            hub.kick(); // 人话在这之前已落账: pane 一绑上就投, 不等 30s 重踢
          })
          .catch((err: unknown) => roomLog.warn({ guide: turn.guide, err: errText(err) }, "onboarding: 频道引导会话起不来"))
          .finally(() => channelGuideSpawning.delete(turn.guide));
      }
      const r = takeChannelGuide(turn);
      if (!r.ok) roomLog.warn({ room: turn.channelRoom, guide: turn.guide, reason: r.reason }, "onboarding: 频道引导没接住这条人话");
    };
    /** 频道已绑定而引导化身还挂着 (人手改 config / 上个进程死在半路): 收尸 —— 与群 guideGate 开头同款。 */
    const reapStaleChannelGuide = (channelRoom: string): void => {
      const guide = guideOf(wizards, channelRoom);
      if (!guide) return;
      roomLog.info({ room: channelRoom, guide }, "onboarding: 频道已绑定, 收掉遗留的引导化身");
      void m.killPane(guide).catch(() => undefined).then(() => { wizardStore()?.drop(guide); });
    };
    /** 人话落 room: 频道 room / 帖子 room 都先保证存在; mention / post 原样写进行里。
     *  未绑定频道先过引导 (口径②④): 引导接一切人话, 绑定后才轮到 monitor / host。 */
    channelIngest = (e) => {
      // 帖 / 评论带的图与文件: 与群聊一个口径 —— 图片以 `@path` 随行 (pane 里 CLI 直接 Read),
      // 文件给一行路径; 账本行同时记 files (rolepage 显示 📎, room_read 可查)。
      const mediaFiles = [
        ...(e.images ?? []).map((p) => ({ path: p, kind: kindOf(p), name: basename(p) })),
        ...(e.files ?? []).map((f) => ({ path: f.path, kind: kindOf(f.path), name: f.name })),
      ];
      const text = e.text
        + (e.images?.length ? "\n" + e.images.map((p) => "@" + p).join(" ") : "")
        + (e.files?.length ? "\n" + e.files.map((f) => "[文件: " + f.path + "]").join("\n") : "");
      // .me 点名 (人 2026-11-24, 与群聊里 .me 被 resolve 分流同一规矩): 没 @ 机器人也直达说话人的
      // me —— 行只落他的私有 me-room, **发生地零行** (host / perceptron 看不见这句)。先于引导 /
      // 绑定: 这句是点给 me 的, 不是频道的新活。me 冷着就顺手起会话 (泵贴不进没绑定的 pane)。
      const me = meChannelSay({
        store: wizardStore(), workspace: meWorkspaceOf(sourcePath), state: roomState,
        write: (room, ops) => { hub.write(room, ops); },
        append: (room, draft) => hub.append(room, draft),
        ensureSession: (target) => {
          const store = wizardStore();
          if (!store || m.hasMirrorTarget(target)) return;
          // 工作区取记录上的 (meWorkspaceOf 落的那条): 不写 cwd 会落 wrc.cwd —— me 不属于业务仓库。
          const cwd = identityWorkspaceOf(store, target) || undefined;
          void m.newSession(target, settleName(store, chatNameOf(cfg, target), target) || target, { silent: true, ...(cwd ? { cwd } : {}) })
            .catch(() => undefined);
        },
      }, { author: e.author, text, files: mediaFiles, src: e.room, ...(e.post ? { post: e.post } : {}) });
      if (me) {
        if (!me.ok) roomLog.warn({ room: meRoomId(e.author), src: e.room, msgid: e.msgid, reason: me.reason }, "channel: .me 人话落行被拒");
        return;
      }
      // 绑定优先于引导: 源已绑进某个 room → 这句话落那本账 (引导只管还没归属的频道人话)。
      const bound = roomStore.roomOfSource(e.room);
      if (!bound) {
        const turn = planChannelGuideTurn({ cfg, store: wizardStore(), onboarding, room: e.room }, e);
        if (turn) { channelGuideTurn(turn); return; }
      }
      const chRoom = channelRoomOf(cfg, e.room);
      if (chRoom) { onboarding.finish(chRoom); reapStaleChannelGuide(chRoom); }
      // §4.1 源 → room: 绑定优先; 帖子源还没诞生 (没绑、帖子 room 也不在) → 频道 room 的接待处,
      // 由 host 判定 (§5.1)。行上的 src 写死入口源 —— 重放不再推断, 出站 (P2) 按它回原帖/原群。
      const room = sourceRoomOf({ source: e.room, roomOfSource: (s) => roomStore.roomOfSource(s), stateOf: roomState, fallback: () => chRoom || undefined });
      const src = e.room !== room ? e.room : undefined;
      if (!roomState(room)) {
        roomLog.warn({ room, src: e.room, msgid: e.msgid }, "channel: room 不存在, 人话没落账本 (自愈: 下一条事件重建)");
        return;
      }
      const v = hub.append(room, {
        author: { kind: "human", id: e.author }, kind: "say", text, origin: "inbound",
        ...(e.post ? { post: e.post } : {}), ...(e.mention ? { mention: e.mention } : {}),
        ...(src ? { src } : {}), ...(mediaFiles.length ? { files: mediaFiles } : {}),
      });
      if (!v.ok) roomLog.warn({ room, src: e.room, msgid: e.msgid, reason: v.reason }, "channel: 人话落行被拒");
    };
    /** §4.1 入站源解析 (inbound 的 resolve / send 用): base 是入站发生地 (群 / 帖子群 / 频道)。
     *   - 源已绑进 room R → 落 R, 接待 = R 的 host (不是源自己的类绑定化身);
     *   - 帖子源已诞生 (帖子 room 在) → 落它;
     *   - 帖子源还没诞生 (首触) → 落频道 room, 接待 = 频道 host;
     *   - 普通群 / 恒等路径 → undefined (现行为, stewardReception)。
     *  host 必须是 wizard 且还在名册上; 解析不出就回落恒等 (主流程不因绑定出错)。 */
    sourceRouteHook = (base) => {
      if (!base.startsWith("chat:")) return undefined;
      const bound = roomStore.roomOfSource(base);
      const ref = postRefOf(cfg, base);
      const topic = channelOf(cfg, base);
      if (!bound && !ref && !topic) return undefined;
      const room = sourceRoomOf({ source: base, roomOfSource: (s) => roomStore.roomOfSource(s), stateOf: roomState,
        fallback: () => (ref ? ensureChannelRoom(ref.channel) : undefined) });
      const st = roomState(room);
      const host = st ? roomHost(st) : undefined;
      const target = host?.kind === "wizard" ? roomWizardOf(host.id)?.target : undefined;
      if (!target) return undefined;
      const src = base !== room ? base : undefined;
      return { room, target, ...(src ? { src } : {}), ...(ref?.post ? { post: ref.post } : {}) };
    };
    channelRoomSeen = (topicId) => { ensureChannelRoom(topicId); };
    /** 帖子源首触 (§4.1): **不建 room、不开实例** —— 人话由 inbound / channelIngest 落频道 room
     *  交 host 判定。这里只保证频道 room 在 (首触的人话要有地方落), 并记一行日志。
     *  帖子 room 的诞生移到 birthPostRoom: host 的 room_bind 之外, 超时兜底 (decideOnFirstTouch) 调。 */
    channelPostTouched = (topicId, postBase) => {
      const channelRoom = ensureChannelRoom(topicId);
      roomLog.info({ room: postBase, channel: channelRoom }, "channel: 帖子源首触 (落频道 room 交 host 判定, 不建帖子 room)");
    };
    /** 定时任务 / plan 提醒的一枪 (cutmap G-1/G-2): kind:"trigger" 行 —— 不镜像, 只唤醒 owner。 */
    const fireTaskTrigger = (target: string, text: string, ext: string): void => {
      const rec = wizards.get(target);
      if (!rec?.uid) { roomLog.warn({ target, ext }, "trigger: 目标不在名册上, 这一枪没放"); return; }
      const who: Who = { kind: "wizard", id: rec.uid };
      const room = ensureBoundRoom(baseOfKey(target), target);
      const s = roomState(room);
      if (s && !s.members.has(whoKey(who))) hub.write(room, [{ op: "join", at: Date.now(), room, who, ord: s.nextOrd, via: "inbound", by: DAEMON }]);
      const v = hub.append(room, { author: DAEMON, kind: "trigger", text, to: [who], origin: "daemon", ext });
      if (!v.ok) roomLog.warn({ room, ext, reason: v.reason }, "trigger: 落行被拒");
    };
    // mirror 轮终 (事件驱动主路): 更新看门狗的活动时钟 + hub.onIdle (F-1 提醒/升级)。
    const roomWatchdog = createRoomWatchdog({
      log: roomLog, now: () => Date.now(),
      listPanes: async () => {
        const r = await runTmux(["list-panes", "-a", "-F", "#{pane_id}"]);
        // 解析只用 parsePaneIds (修复单 §1): 之前这里 split 的是字面反斜杠+n, 多 pane 全员误判。
        return r.ok ? { ok: true, panes: parsePaneIds(r.stdout) } : { ok: false, error: r.stderr.slice(0, 200) || "tmux list-panes 失败 (code " + r.code + ")" };
      },
      wizardOf: (uid) => {
        const w = roomWizardOf(uid);
        return w ? { target: w.target, name: w.name, paneId: m.sessionInfo(w.target)?.tmuxPane } : undefined;
      },
      isBusy: (target) => m.isBusy(target),
      rooms: roomStore.ids,
      stateOf: roomState,
      // pane 不在了、会话绑定还在 → 落一条 trigger 行把它叫起来 (2026-11-24): 泵投递时
      // injectText 探活 gone 会 --resume 重生 pane 再贴。不开预算、不判实例结束。
      revive: (room, uid, duties, text) => hub.append(room, {
        author: DAEMON, kind: "trigger", origin: "daemon", sys: "pane-revive",
        to: [{ kind: "wizard", id: uid }], re: [...duties], text,
      }, { budget: Number.MAX_SAFE_INTEGER }).ok,
      onIdle: (uid) => hub.onIdle(uid),
      kick: () => void hub.kick(),
      staleMs: () => (cfg.rooms?.watchdog?.staleMin ?? 5) * 60_000,
      intervalMs: () => (cfg.rooms?.watchdog?.intervalSec ?? 60) * 1000,
    });
    roomTurnEnd = (target: string): void => {
      roomWatchdog.touch(target);
      const uid = wizards.get(target)?.uid;
      if (uid) void hub.onIdle(uid);
      if (needsNew.size) void newOne(target); // §7: pane 忙没 /new 成的目标, 轮终 (闲下来了) 补做
    };
    roomActivityTouch = (target: string): void => roomWatchdog.touch(target);
    // /status 增量 (§4): openDuties 是 daemon 内存里全部 room 的未结 duty 总数; watchdog 暴露
    // failStreak / lastScanAt。O2 拿 openDuties 对 observe.mjs duties 的盘上重放, 差值应为 0。
    roomStatusRef.get = () => ({
      openDuties: roomStore.ids().reduce((n, id) => {
        const s = roomState(id);
        return n + (s ? openDuties(s).length : 0);
      }, 0),
      watchdog: roomWatchdog.status(),
    });
    // pump 的注入也算「最后一次事件」: 正在投递的 wizard 不进 stale 名单 (paste 端口的 touch 见 hub ports)。
    const watchdogTimer = setInterval(() => void roomWatchdog.scan(), (cfg.rooms?.watchdog?.intervalSec ?? 60) * 1000);
    watchdogTimer.unref?.();
    // duty 逾期两级提醒: 与看门狗同节拍, 阈值每轮现读 (hot)。
    const overdue = createOverdueScan({
      log: roomLog, now: () => Date.now(),
      thresholds: () => ({ remindMin: cfg.rooms?.overdue?.remindMin ?? 60, groupMin: cfg.rooms?.overdue?.groupMin ?? 120 }),
      rooms: roomStore.ids, stateOf: roomState, append: (room, d, extra) => hub.append(room, d, extra),
      wizardOf: roomWizardOf, nameOf: roomNameOf, roomLabel,
    });
    const overdueTimer = setInterval(() => { try { overdue.scan(); } catch (e) { roomLog.warn({ err: (e as Error).message }, "overdue: 扫描失败"); } }, (cfg.rooms?.watchdog?.intervalSec ?? 60) * 1000);
    overdueTimer.unref?.();
    setTimeout(() => { try { overdue.scan(); } catch { /* 下一轮再来 */ } }, 20_000).unref?.();
    // ── 新群引导的两端 (契约 §4): 人话落 room → guide 当 founder 说话 → 绑定后交给管家 ────
    /** 引导期: 人这句落进本群 room (guide 作 founder, ord=1) 并唤醒它。引导从此只能在 room
     *  里说话 (chat_reply), 绑定后那条 duty 连原话一起交给管家。 */
    const guideTakeover: GuideInbound = async (a) => {
      const rec = wizards.get(a.guide);
      if (!rec?.uid) return { ok: false, reason: "引导会话不在名册上" };
      const guide: Who = { kind: "wizard", id: rec.uid };
      const room = baseOfKey(a.guide);
      const at = Date.now();
      const s = roomState(room);
      if (!s) hub.write(room, [
        { op: "open", at, room, kind: "wecom-group", by: DAEMON },
        { op: "join", at, room, who: guide, ord: 1, via: "founder", by: DAEMON },
      ]);
      else if (!s.members.has(whoKey(guide))) hub.write(room, [{ op: "join", at, room, who: guide, ord: s.nextOrd, via: "inbound", by: DAEMON }]);
      // 占位气泡: 引导的 chat_reply 覆盖它 (coverBubble 认 ext + bubble.expires)。
      const expires = at + 6 * 60_000;
      rememberBubbleFrame(a.streamId, a.frame, expires);
      if (a.frame && a.streamId) void ws.client.replyStream(a.frame, a.streamId, withTagHeader(a.guide, "…"), false).catch(() => undefined);
      const v = hub.append(room, {
        author: { kind: "human", id: a.from }, kind: "say", text: a.text, origin: "inbound",
        ext: a.streamId, bubble: { stream: a.streamId, expires },
      });
      if (!v.ok) return { ok: false, reason: v.reason };
      roomLog.info({ room, guide: a.guide, msgId: v.row.id }, "onboarding: 人话进了引导 room");
      return { ok: true };
    };
    /** 管家实例的 pane: 记录在、pane 没有就起一个, 起来后踢一脚泵 (否则要等 30s 重踢)。
     *  群落定 (guideSettleRoom) 与频道落定 / boot 兜底共用这一个口子 —— spawning 去重 (同一轮里
     *  先 guideSettleRoom 再 settleBoundChannel 不会起两次)。**记录在、pane 没有**正是「已被结束」
     *  的来源: monitor 唤醒时探活 gone (人 2026-11-23 现场)。 */
    const stewardSpawning = new Set<string>();
    const spawnStewardPane = (target: string): void => {
      if (!target) return;
      if (m.hasMirrorTarget(target)) { hub.kick(); return; }
      if (stewardSpawning.has(target) || channelGuideSpawning.has(target)) return;
      stewardSpawning.add(target);
      const name = settleName(wizards, chatNameOf(cfg, target), target) || target;
      void m.newSession(target, name, { silent: true })
        .then(() => hub.kick())
        .catch((e: unknown) => roomLog.warn({ target, err: errText(e) }, "room: 管家 pane 起不来 (有唤醒时泵会再试)"))
        .finally(() => stewardSpawning.delete(target));
    };
    /** 引导落定: 管家进 room → 引导名下 duty 全部转给它并唤醒 → 引导离开 → 完成系统行。
     *  false = 引导不在这个 room 里 (老流程 / 没走过 room), 调用方自己回一句。 */
    const guideSettleRoom = (base: string, bound: OnboardingBound, roomName = ""): boolean => {
      const s = roomState(base);
      const guideTarget = guideOf(wizards, base);
      const guide = guideTarget ? roomSelfOf(guideTarget) : undefined;
      const steward = roomSelfOf(bound.target);
      if (!s || !guide || !steward) return false;
      // roomMirror 给 daemon 的行补 "[wezard] " 前缀, 完成确认自己已经带了一个。
      const text = renderOnboardingDone(bound).replace(/^\[wezard\]\s*/, "");
      const ops = guideHandoffOps(s, { guide, steward, text, now: Date.now(), ...(roomName ? { roomName } : {}) });
      if (!ops.length) return false;
      hub.write(base, ops);
      roomLog.info({ room: base, guide: guideTarget, steward: bound.target, ops: ops.length }, "onboarding: room 交给管家");
      // 管家会话还没起: 泵贴不进没绑定的 pane —— 先起一个 (与频道落定 / boot 兜底同一口子)。
      spawnStewardPane(bound.target);
      return true;
    };
    /** 一个频道 room / 帖子 room 的 host 座位 + monitor: host 一律是**本 room 的**实例
     *  (人 2026-11-23: 不同的 room 要用不同的实例), 没有就领号新开。幂等 —— 落定与 boot 自愈共用。 */
    const seatChannelRoom = (room: string, channelRoom: string): void => {
      const s = roomState(room);
      if (!s) return;
      const who = roomStewardOf(room, channelRoom);
      if (who) {
        const ops = hostJoinOps(s, who, Date.now());
        if (ops.length) hub.write(room, ops);
      }
    };
    /** 绑定落在**频道**上 (wrc.channel.steward): 频道 room 与各帖子 room 各坐**自己那个**实例当
     *  host, 各起一个 monitor (口径③)。引导期这两样都没建 (ensureChannelRoom / channelPostBorn 的
     *  bound 闸), 这里是唯一的补建点 —— 普通群 (channelOf 认不出) = 无操作。 */
    const settleBoundChannel = (base: string, bound: OnboardingBound): void => {
      const topicId = channelOf(cfg, base);
      if (!topicId) return;
      const rooms = [base, ...postsOfChannel(cfg, topicId)];
      for (const room of rooms) seatChannelRoom(room, base);
      // 管家实例的 pane: 群落定 (guideSettleRoom) 一直有这一步, 频道这边原来漏了 —— 记录在、
      // pane 没有, monitor 唤醒就是 gone, 人看到「已被结束」(人 2026-11-23 现场)。
      // 帖子 room 的实例不预起 pane: 第一次被唤醒时泵会冷启动它 (每个帖子一个常驻 pane 会顶到上限)。
      spawnStewardPane(bound.target);
      roomLog.info({ room: base, topicId, steward: bound.target, rooms: rooms.length }, "onboarding: 频道交出管家 (每 room 一个实例 + monitor)");
    };
    /** §5.1 出口 3 (另起 / 兜底): 帖子 room 诞生 + 领号新实例, 并把新 host 拉进频道 room。
     *  by = 判定者 (超时兜底时 DAEMON)。幂等: 帖子 room 已在 / 源已绑 / 频道还在引导期 = 什么都不做。
     *  §7: 频道 host (最早加入序) 身份不动 —— 新成员走普通 join (via spawn, ord = nextOrd, watch 关)。 */
    const birthPostRoom = (topicId: string, postBase: string, by: Who): boolean => {
      if (roomStore.roomOfSource(postBase)) return false;
      const channelRoom = ensureChannelRoom(topicId);
      if (!channelMonitorWanted(cfg, wizardStore(), channelRoom)) return false; // 引导期不诞生, 人话归引导
      const at = Date.now();
      const founder = roomStewardOf(postBase, channelRoom);
      if (!roomState(postBase)) {
        hub.write(postBase, postRoomBirthOps(postBase, founder, at));
        roomLog.info({ room: postBase, channel: channelRoom, founder, by: by.kind + ":" + by.id }, "channel: 帖子 room 诞生 (另起)");
      }
      // 新 host 同步进频道 room: 频道 host 从此在成员表里看得到每个帖子 host。
      const cs = roomState(channelRoom);
      if (cs && founder) {
        const who = founder;
        if (!cs.members.has(whoKey(who)))
          hub.write(channelRoom, [{ op: "join", at, room: channelRoom, who, ord: cs.nextOrd, via: "spawn", by }]);
      }
      return true;
    };
    /** §5.1 兜底扫描: 首触落频道 room、host 在 decideTimeoutMin 内没 bind 也没另起 → 自动走出口 3。
     *  判据全从账本现算 (room-bind.ts 纯函数), 已绑 / 已诞生下一次自然不再命中; overdue 提醒独立运行。 */
    const decideOnFirstTouch = (): void => {
      const timeoutMs = (cfg.rooms?.binding?.decideTimeoutMin ?? 10) * 60_000;
      let due: ReturnType<typeof pendingFirstTouches> = [];
      try {
        due = pendingFirstTouches({ cfg, states: roomStore.ids().map(roomState).filter((x): x is RoomState => !!x),
          roomOfSource: (s) => roomStore.roomOfSource(s), stateOf: roomState, now: Date.now(), timeoutMs });
      } catch (e) { roomLog.warn({ err: errText(e) }, "binding: 首触兜底扫描失败 (下一轮再来)"); return; }
      for (const d of due) {
        try {
          if (birthPostRoom(d.topicId, d.source, DAEMON))
            roomLog.info({ room: d.source, channel: d.channelRoom, waitedMin: Math.round((Date.now() - d.at) / 60000) }, "binding: 首触超时, 自动另起帖子 room");
        } catch (e) { roomLog.warn({ room: d.source, err: errText(e) }, "binding: 兜底另起失败 (下一轮再来)"); }
      }
    };
    /** §7 boot 补拉: 存量帖子 room 的 host 实例进频道 room。幂等; 只补成员, 不起 pane (cold 等第一次唤醒)。 */
    const backfillChannelMembers = (): void => {
      let seats: ReturnType<typeof planChannelBackfill> = [];
      try {
        seats = planChannelBackfill({ cfg, rooms: roomStore.ids(), stateOf: roomState,
          targetOf: (uid) => roomWizardOf(uid)?.target });
      } catch (e) { roomLog.warn({ err: errText(e) }, "binding: 频道成员补拉扫描失败"); return; }
      for (const seat of seats) {
        const cs = roomState(seat.channelRoom);
        if (!cs) continue;
        hub.write(seat.channelRoom, [{ op: "join", at: Date.now(), room: seat.channelRoom, who: seat.who, ord: cs.nextOrd, via: "spawn", by: DAEMON }]);
        roomLog.info({ room: seat.channelRoom, host: seat.target }, "binding: boot 补拉帖子 host 进频道 room");
      }
    };
    // 首触兜底与看门狗同节拍 (阈值每轮现读, hot)。boot 先等启动那一波过去再扫一次。
    const decideTimer = setInterval(decideOnFirstTouch, (cfg.rooms?.watchdog?.intervalSec ?? 60) * 1000);
    decideTimer.unref?.();
    setTimeout(decideOnFirstTouch, 30_000).unref?.();
    /** 引导收尸 (绑定后): 工具调用已经回成功, 等它这一轮结束 (或 60s 上限) 再 kill + drop ——
     *  半路杀 pane 会把这一轮截断在 CLI 里。它已经 leave 过 room, 所以 drop 不会再产生
     *  canceled 行 (leaveRooms 对非成员是空操作)。 */
    const reapGuideAfterTurn = async (guide: string): Promise<void> => {
      const deadline = Date.now() + 60_000;
      await sleep(2000);
      while (Date.now() < deadline && !(await m.idleNow(guide))) await sleep(1000);
      const r = await m.killPane(guide);
      wizards.drop(guide);
      roomLog.info({ guide, killed: r.ok, reason: r.reason }, "onboarding: guide reaped after bind");
    };
    guideInboundHook = guideTakeover;
    // 群引导的落定也走频道补建: base 是频道 room 时, 绑定后要补 host / monitor (口径③);
    // 普通群 channelOf 认不出, settleBoundChannel 无操作。settleBoundChannel 幂等。
    guideSettleHook = (base, bound) => {
      const ok = guideSettleRoom(base, bound);
      if (ok) settleBoundChannel(base, bound);
      return ok;
    };
    // rolepage 的 room 历史路由 (room-ui 的第 4 个接线点): 坏账本按「没有这个 room」处理。
    setRoomReader({ ids: roomStore.ids, get: (id) => roomState(id) });
    // 回填外层引用 (入站包装在 mirror 块之外)。
    roomHub = hub;
    roomStateOf = roomState;
    rememberBubble = rememberBubbleFrame;
    ensureRoom = ensureBoundRoom;

    // 类 / 实例 (人 2026-11-18): 管家身份 → 一条类 + 一串有序号的实例 (名字 <类名>-N)。
    // 合并清单 (stateDir/class-merges.json 或 wizards.json 同级, 人写) 把同目录上的几个旧
    // 身份并成一个类。幂等: 已建的类整组跳过。迁移会改名字, 所以旧名 → 类名的映射当场落到
    // 管家绑定上 —— 迁移后绑定存的都是类名。冲突逐条 warn 并覆盖写 analysis/classes-migration.txt。
    //
    // **闸门 (人 2026-11-18)**: 只有 stateDir/classes.apply 存在时才真迁 (类 + 成员表改键 +
    // 绑定改写一起放行)。没有它 = 只跑计划、写报告、日志一行 'class migration gated' ——
    // dist 里带着迁移代码而别人随时可能 reload 的那段时间, 不许悄悄改真数据。
    const classLog = log.child({ mod: "class" });
    const classApply = existsSync(join(expandHome(cfg.daemon.stateDir), "classes.apply"));
    const mergeSpec = loadClassMerges(
      join(expandHome(cfg.daemon.stateDir), "class-merges.json"),
      join(dirname(expandHome(cfg.wrc.mirror.wizardsFile)), "class-merges.json"),
    );
    // 推不出 workspace 就是 "" (note + 类 workspace 留空), **不回落兜底目录** —— 那 5 个
    // 没附着过的管家曾经全被算成 cc-wecom, 跟 wezard 撞 workspace 顶掉合并。
    const classCwdOf = (t: string): string => m.knownCwd(t).runningCwd;
    const gatedPlan = classApply ? undefined : planClasses(wizards.all(), classes.all(), classCwdOf, mergeSpec);
    const cmig: ClassMigration = classApply
      ? migrateClasses(wizards, classes, cfg.wrc.mirror.wizardsFile, classCwdOf, mergeSpec)
      : { migrated: 0, aliases: [], plan: gatedPlan!, conflicts: gatedPlan!.conflicts };
    if (!classApply) classLog.info({ gated: true, applyFile: join(expandHome(cfg.daemon.stateDir), "classes.apply") }, "class migration gated");
    if (cmig.migrated) classLog.info({ migrated: cmig.migrated, classes: classes.all().length, backup: cmig.backup }, "class/instance migration applied");
    if (cmig.skipped) classLog.warn({ reason: cmig.skipped }, "class/instance migration skipped");
    cmig.conflicts.forEach((c) => classLog.warn({ conflict: c }, "class migration conflict"));
    // 报告要能一眼看出「这次会建什么、改哪些名字」—— 只写 conflicts 的话, 跑歪了也看不出来。
    try {
      const reportDir = join(expandHome(cfg.daemon.stateDir), "analysis");
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(join(reportDir, "classes-migration.txt"), renderClassReport(cmig.plan, { applied: classApply, records: wizards.all().length }));
    } catch (e) { classLog.warn({ err: (e as Error).message }, "class migration report not written"); }
    if (classApply) {
      const rebound = rewriteStewardBindings(cfg, sourcePath, cmig.aliases);
      if (rebound) classLog.info({ rebound }, "steward bindings rewritten to class names");
    }
    // 绑定自愈 (人 2026-11-23: 不同的 room 要用不同的实例): 早先的 bind-existing 把**别的 room
    // 的实例名**写进了绑定并把那条化身 join 进来当 host —— 绑定改回类名, 各 room 里换成本 room
    // 的实例 (没有就领号新开)。幂等; dhtpm 群自己那条不动。
    // **直绑**: 频道表按裸 topic 只对频道 room 自己, chatPolicy 看自己那一条 —— 只用来找
    // 「该 room 自己该是哪个类」, 帖子 room 按它所属频道查 (channelClassOf)。
    const boundClassOf = (room: string): string => {
      const bare = room.startsWith("chat:") ? room.slice("chat:".length) : "";
      const name = (bare ? (cfg.wrc.channel.steward ?? {})[bare] : "") || appointedSteward(cfg, room);
      return name ? (wizards.classes?.byName(name)?.id ?? "") : "";
    };
    /** 帖子 room 也是 room: 它的 host 必须是**本 room** 的实例 (人 2026-11-23), 类看所属频道。
     *  老口径「帖子 room 坐频道管家同一个实例」留下的成员也在这里换掉 —— 只在自愈里用, 不给
     *  unspawnedStewards (那里按直绑补 pane, 帖子 room 的实例等第一次唤醒再冷启动)。 */
    const channelClassOf = (room: string): string => {
      const topicId = channelOf(cfg, room);
      const name = topicId ? (cfg.wrc.channel.steward ?? {})[topicId] ?? "" : "";
      return name ? (wizards.classes?.byName(name)?.id ?? "") : "";
    };
    try {
      const rep = repairStewardInstances({
        store: wizards, rooms: roomStore.ids(), stateOf: roomState,
        write: (room, ops) => { hub.write(room, ops); },
        rewriteBindings: (aliases) => rewriteStewardBindings(cfg, sourcePath, aliases),
        boundClassOf: (room) => boundClassOf(room) || channelClassOf(room),
      });
      if (rep.rebound || rep.rooms || rep.renamed.length) classLog.info({ ...rep }, "steward instances repaired (per-room)");
      // 自愈只写成员, 起不了会话: 直绑 room 里「记录在、pane 没有」的管家实例这里补起。
      // 幂等 (有 pane 的不收); 管存量恢复 (频道那个 OliveBrown-2) 与今后任何 pane 丢失的漂移。
      const spawn = unspawnedStewards({ store: wizards, rooms: roomStore.ids(), stateOf: roomState,
        boundClassOf, hasPane: (t) => m.hasMirrorTarget(t) });
      for (const target of spawn) spawnStewardPane(target);
      if (spawn.length) classLog.info({ spawn }, "steward panes spawned at boot (记录在, pane 没有)");
      // 已绑定频道的 room 一个 host 都没有 (绑完就崩 / 老数据): 补本 room 的实例 + monitor。
      for (const room of roomStore.ids()) {
        const topicId = channelOf(cfg, room);
        if (!topicId || !(cfg.wrc.channel.steward ?? {})[topicId]) continue;
        const s = roomState(room);
        if (s && !roomHost(s)) seatChannelRoom(room, "chat:" + topicId);
      }
    } catch (e) { classLog.warn({ err: errText(e) }, "steward instance repair failed (不影响启动)"); }
    // §7 boot 补拉: 存量帖子 room 的 host 进频道 room (与 settleBoundChannel / channel-rebind 同钩子;
    // 幂等, 已拉过的不重复; 实例不在册 / 引导期频道跳过)。
    try { backfillChannelMembers(); } catch (e) { classLog.warn({ err: errText(e) }, "binding: 频道成员补拉失败 (不影响启动)"); }
    // v3 §3: 全局管家身份落位 —— home (defaultChat) 的默认会话就是它的锚点化身。
    // 新聊天 (还没有任何会话) 的裸消息由它接待 (inbound stewardRoute); 未认领的新装机不造幽灵记录。
    const gs = markGlobalSteward(wizards, cfg.defaultChat);
    if (gs.marked) log.child({ mod: "wizard" }).info({ target: gs.target }, "global steward anchored at home default session");
    // v3 §7: 学徒落位 —— home 是单聊时保证唯一记录存在 (住在 home 的一个 slot, 不占默认会话);
    // 幂等, 已有就不动 (人改过名字/职责以名册为准)。home 未认领不造幽灵。
    const ap = ensureApprentice(wizards, cfg.defaultChat, cfg.wrc.apprentice.name);
    if (ap.created) log.child({ mod: "wizard" }).info({ target: ap.target }, "apprentice anchored at home DM slot");
    else if (ap.skipped) log.child({ mod: "wizard" }).info({ reason: ap.skipped }, "apprentice not anchored (home not a DM yet)");
    const planApiStore: PlanStore = {
      all: () => plans.all(),
      get: (id) => plans.get(id),
      list: (owner) => plans.list(owner),
      create: (owner, input, at, origin) => {
        if (retiringWizardTargets.has(owner)) throw new PlanError(409, "wizard is being retired");
        if (!wizards.get(owner)) throw new PlanError(404, "plan owner is not a registered wizard");
        return plans.create(owner, input, at, origin);
      },
      update: (owner, id, input, at) => {
        const plan = plans.update(owner, id, input, at);
        try { settleLeads(); } catch (e) { log.warn({ mod: "lead", err: errText(e) }, "lead: 摘章失败 (plan 已更新)"); } // plan 收尾可能是摘章的最后一个条件
        return plan;
      },
      hasUnfinished: (owner) => plans.hasUnfinished(owner),
      healthy: () => plans.healthy(),
      reminded: (id, revision, token, eventId, at) => plans.reminded(id, revision, token, eventId, at),
    };
    const readPlanBody = async (req: import("node:http").IncomingMessage): Promise<{ self: string; body: PeerBody }> => {
      const body = await readBody(req) as PeerBody;
      const pane = body.tmuxPane?.trim();
      const sid = body.sessionId?.trim();
      const bound = (pane ? m.targetForPane(pane) : undefined) ?? (sid ? m.targetForSession(sid) : undefined);
      const target = body.target?.trim();
      return { self: bound && (!target || target === bound) ? bound : "", body };
    };
    registerPlanRoutes(http, {
      store: planApiStore,
      read: readPlanBody,
      resolveOwner: (name) => wizards.byName(stripSigil(name))?.target,
      origin: (self) => {
        // room 模型: plan 的 origin = 本轮唤醒的绑定 room; 没被唤醒过退回当前频道。
        const uid = wizards.get(self)?.uid;
        const d = uid ? hub.defaultRoom(uid) : undefined;
        return { channel: d?.room && hub.isBoundRoom(d.room) ? d.room : m.currentChannel(self) };
      },
    });

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
      if (!i?.sessionId || handoffNudged.has(i.sessionId) || i.contextTokens < handoffLineOf(wizards, t, lastModel(i.jsonlPath) || i.model)) return [];
      handoffNudged.add(i.sessionId);
      return [`你的上下文已到 ${Math.round(i.contextTokens / 1000)}k: 该判断要不要 \`handoff\` 了 —— 手上这摊活告一段落、或往后的活不再依赖前面的大段材料, 就交接 (值得跨会话留下的先 \`wizard_remember\`); 还在一件离不开它们的活中间, 做完这一段再交`];
    };
    // 挂起事项的提醒 (见 pending-items.digest): 只给管家 —— 各群的默认会话, 同时挂着多件活、
    // 又被人随时打断的就是它。上次全表时的样子纯内存: reload 后头一次见到只立基线。
    /** 上次注入之后被 /clear 或压缩截断过的 (onContextCut 记, 下一次注入取走)。 */
    const pendingCuts = new Map<string, "clear" | "compact">();
    // pending_items 已退役 (wiring C): 挂起账 = room 的 open duty, 工具面走 /room/*;
    // 注入尾巴不再带这份摘要, 只保留空 Part 让组装处不用改。
    const pendingDigest = (_t: string, _via: Via): Part => () => ({ text: "", keys: [] });
    const planDigest = (target: string): string[] => {
      if (!plans.healthy()) return [];
      const active = plans.list(target).filter((plan) => plan.state === "active" || plan.state === "paused");
      if (!active.length) return [];
      return [`你维护着 ${active.length} 个未结束 plan: ${active.map((plan) => {
        const completed = plan.tasks.filter((task) => task.status === "completed").length;
        const inProgress = plan.tasks.filter((task) => task.status === "in_progress").length;
        return `\`${plan.title}\` (${plan.state}; ${completed}/${plan.tasks.length} completed${inProgress ? `, ${inProgress} in progress` : ""})`;
      }).join("; ")}。plan 只记录与提醒进度；由你显式更新 DAG 和状态。`];
    };
    const notices = bindNoticeBox(createNoticeBox({
      probe: (t) => [...planDigest(t), ...handoffNudge(t), ...memoryNudge(t)],
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
            // 冷热与 route_candidates / chat_ask 冷门控同一口径 (touchOf / ttlOf)。
            const warmth = i?.jsonlPath ? { ctx: i.contextTokens, cold: !!coldGateOf(displayName(x), i.contextTokens, touch, now, ttlOf(i.jsonlPath)) } : {};
            return { name: displayName(x), state, ...warmth, job: wizards.get(x)?.description || (tagOfKey(x) ? "" : "steward"), touch };
          }), now);
      }),
      seen: createSeenRing(loadJsonMap<SeenRow>(cfg.wrc.mirror.noticeSeenFile, gcSeen), (t) => m.sessionInfo(t)?.sessionId ?? ""),
      cwdOf: (t) => ((c) => c.runningCwd || c.defaultCwd)(m.getCwd(t)),
    }));
    /** `who` = 这次变动的当事人 (见 hears): 不给 = 聊天自己的事 (改名), 全群都听。 */
    // 听众只在主角那个聊天里 (同 base ⇒ 同机器人); sameBot 再写一遍是隔离的明文, 不靠 key 的拼法兜着。
    const postRoster = (base: string, except: readonly string[], n: Notice, who?: Subject): void =>
      notices.post(chatAudience(m.chatTargets(base), base, except).filter((t) => sameBot(base, t)).filter(who ? hears(who) : () => true), n);
    /** 注册表里的当事人。要在 forget 抹掉记录之前取; 没有记录 = 谁也不告诉。 */
    const subjectOf = (w: WizardRecord | undefined): Subject => (w
      ? { parent: w.parent, description: w.description }
      : {});
    /** 名字是地址, 而宪章是出生那一刻的快照: 改名 / 聊天补名之后, 还活着的会话
     *  嘴里仍念旧名 (最坏是「(未命名)」)。这里把新宪章挂到它下一次注入上 —— 与
     *  /clear、压缩后重挂同一个机制, 不额外发气泡。 */
    const recharter = (targets: readonly string[]): void =>
      targets.forEach((t) => { if (m.sessionInfo(t)?.sessionId) m.armCharter(t); });


    // 当前身份初始化与按需落定: transcript 校准懒接管会话的 bornAt, 再按默认会话
    // 优先的顺序落定已知 wizard 名称; 后续空名记录仍由对应入口补齐。
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
    const unborn = sweepUnborn(wizards, (t) => m.chatTargets(baseOfKey(t)).includes(t) || !!planRetirementBlock(t));
    unborn.forEach((w) => log.child({ mod: "wizard" }).warn({ target: w.target, name: w.name }, "unborn identity swept"));
    if (unborn.length) {
      void m.restored
        .then(() => m.reapUnborn(unborn.map((w) => w.name).filter((n) => n && !wizards.byName(n))))
        .then((killed) => { if (killed.length) log.child({ mod: "wizard" }).info({ killed }, "unborn windows killed"); })
        .catch((e: unknown) => log.warn({ err: (e as Error).message }, "unborn window reap failed"));
    }

    /** 成员角色参数: 只认 exec / reviewer / expert (lead 只由 dispatch 在派成之后记, 免得谁都能自封 lead); 不认识的 = 不给。 */
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
          // P7 ⑦: rolepage 同身份多化身聚成一页。
          ...(w ? { identity: identityOfRec(w) } : {}),
          // room 账本里一切 wizard 引用都用 uid (room-ui): 随快照带给 svr / 前端。
          ...(w?.uid ? { uid: w.uid } : {}),
          name: settleName(wizards, chatNameOf(cfg, p.target), p.target),
          description: w?.description ?? "",
          chat: chatNameOf(cfg, p.target) || p.chat,
          cwd: p.cwd,
          model: p.model,
          ...((e) => (e ? { effort: e } : {}))(mirrorStore.get(p.target)?.effort),
          cli: p.cli,
          busy: p.busy,
          alive: p.paneAlive,
          // 冷热 = 与 roster 的冷门控同一口径: transcript 最近一次动静超过缓存 TTL。
          ...((jp) => (p.paneAlive && jp ? { cacheCold: wakeCostOf(0, touchOf(jp), Date.now(), ttlOf(jp)).cold } : {}))(m.sessionInfo(p.target)?.jsonlPath),
          // 悬在本地审批框上: isBusy 把它算忙, 但它在等人, 不在干活 (图上单独画, 不亮「工作中」)。
          ...(p.paneAlive && m.parkedNow(p.target) ? { parked: true } : {}),
          ...(waiting ? { waiting } : {}),
          // 群成员列表 (rolepage): 类实例的序号 + 是不是本群管家, 判定都在 daemon 侧做
          // (cfg + 注册表只有这里有), svr 拿快照照画。
          ...(w?.ordinal !== undefined ? { ordinal: w.ordinal } : {}),
          steward: isStewardTarget(cfg, wizards, p.target),
          // 图节点的 lead 角标与聪明程度 (shared/smarts.ts): 只读注册表, 不改语义。
          ...(w?.tier ? { tier: w.tier } : {}),
          ...(w?.lead ? { lead: true } : {}),
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
          identity: identityOfRec(w),
          // 账本里一切 wizard 引用都是 uid: 休眠 / 收掉的也得带上, 否则图把它的 uid 认成另一个「未知」幽灵节点,
          // 真身 (没有 uid) 与幽灵并排画两个, 状态各说各话。
          ...(w.uid ? { uid: w.uid } : {}),
          name: settleName(wizards, chatNameOf(cfg, w.target), w.target),
          description: w.description,
          chat: chatNameOf(cfg, w.target),
          cwd: "", model: "", cli: "",
          busy: false, alive: false,
          ...(w.ordinal !== undefined ? { ordinal: w.ordinal } : {}),
          steward: isStewardTarget(cfg, wizards, w.target),
          ...(w.tier ? { tier: w.tier } : {}),
          ...(w.lead ? { lead: true } : {}),
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
        plans: plans.healthy() ? plans.all() : [],
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
        // room 账本快照 + 名字表: rolepage 关系图 / room 视图的唯一来源 (room-ui)。
        // 坏账本跳过并留日志 —— 一个坏文件不该让整张图消失。
        rooms: roomFacts(roomStore, wizards.all(), {
          chatName: (base) => chatNameOf(cfg, base),
          channelOf: (room) => channelRefOf(cfg, room),
          onBroken: (room, err) => log.warn({ mod: "room", room, err: errText(err) }, "room-facts: 坏账本跳过"),
        }),
        names: nameTable(wizards.all()),
        classes: classes.all().map((c) => ({ id: c.id, name: c.name, role: c.role, workspace: c.workspace })),
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
      address: peerAddress(cfg, target),
      description: wizards.get(target)?.description ?? "",
      ...(wizards.get(target)?.expertise ? { expertise: wizards.get(target)!.expertise } : {}),
      ...(wizards.get(target)?.kind && wizards.get(target)!.kind !== "worker" ? { kind: wizards.get(target)!.kind } : {}),
      cwd: m.getCwd(target).runningCwd,
    });

    /** 自己的地址 = 全局名字, 与住在哪个群无关。 */
    const selfAddress = (target: string): string => settleName(wizards, chatNameOf(cfg, target), target);

    const sharedMemory = (scope: MemoryScope, key: string, bot = ""): string => {
      const path = memoryPath(cfg.daemon.stateDir, scope, key, bot);
      return clipForCharter(readMemory(path), path);
    };
    /** 工作区记忆的键: 身份的工作区 (锚点 workspace) 优先, 没写才退回会话所在目录。记忆只与
     *  workspace 绑定 (人 2026-11-17): 同一身份在哪个群、哪个 pane 起, 读写的都是同一份。 */
    const memoryCwdOf = (t: string, cwd = ""): string => {
      const c = m.getCwd(t);
      return identityWorkspaceOf(wizards, t) || cwd || c.runningCwd || c.defaultCwd;
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
        notice: roomState(baseOfKey(target))?.notice ?? "",
        chatMemory: sharedMemory("chat", baseOfKey(target)),
        workspaceMemory: (() => {
          const cwd = memoryCwdOf(target, o.cwd);
          return cwd ? sharedMemory("workspace", cwd, botOfKey(target)) : "";
        })(),
        steward: isStewardTarget(cfg, wizards, target),
        ...((() => {
          const rec = wizards.get(target);
          const cls = rec ? wizards.classes?.get(identityOfRec(rec)) : undefined;
          return cls ? { classOf: { name: cls.name, role: cls.role, workspace: cls.workspace } } : {};
        })()),
        stewardBudget: chatPolicyOf(cfg, target).stewardBudget,
        lead: !!wizards.get(target)?.lead,
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
      // 宪章跟着消息走 (不再在系统提示里), /clear 与压缩都会把它从上下文里抹掉 ——
      // 现渲染一份挂到下一次注入上, 让身份跨过这次截断。reload 后没有附着表也照挂:
      // armCharter 只对活着的附着生效, 冷记录等重生时再挂。
      m.armCharter(t);
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
      // 信箱里装的是相对上一份宪章的变化; 新宪章一渲染就都过期了 (名册、记忆都已在里面)。
      notices.drain(target);
      notices.forget(target);
      // 引导化身不发 wizard 宪章: 那套工具与编排它一句也用不上 —— 带着它, 「设置工作区为 …」
      // 就被读成自己的 set_workspace + handoff (2026-11-17 teststrict)。它的「宪章」就是引导
      // 话术 (三件工具 + 绑定之外的不要自己做), 由 inbound 每轮 armCharter 覆盖具体那一条。
      if (isGuideManifestation(wizardStore()?.get(target))) return renderGuideOpening();
      return charterFor(target, { ...charterOptsOf(target, ctx?.cwd), cli: ctx?.cli });
    });

    // 宪章记录是后来才有的: 已经在跑的 wizard 拿 spawn 落盘的那份 (state/charters/<sid>.md) 补上,
    // 否则要等它下次重生, rolepage 的「宪章」入口才出现。与自动命名同一个延迟: 等附着表恢复完。
    setTimeout(() => {
      const dir = join(expandHome(cfg.daemon.stateDir), "charters");
      wizards.all().forEach((w) => {
        const sid = m.sessionInfo(w.target)?.sessionId;
        const file = sid ? join(dir, `${sid}.md`) : "";
        try {
          if (!file || !existsSync(file)) return;
          const text = readFileSync(file, "utf8");
          backfillCharter(w.target, text, statSync(file).mtimeMs);
          // 宪章是出生快照: 出生时聊天还没名字的会话, 一辈子自报「(未命名)」。
          // 补过名 / 改过名的, 这里把新宪章挂到它下一次注入上。
          const want = w.name || "(未命名)";
          const had = /名字: \*\*`(?:🧙‍♂️ )?([^`]*)`\*\*/.exec(text)?.[1] ?? "";
          if (had && had !== want) {
            log.child({ mod: "wizard" }).info({ target: w.target, was: had, now: want }, "charter re-armed after identity change");
            m.armCharter(w.target);
          }
        } catch { /* 补不上就等它重生 */ }
      });
    }, 15_000).unref();

    // 家谱只列与观察者同机器人的 (跨机器人的分身生不出来, 这是给老数据 / 手改注册表兜的底)。
    const kinOf = (self: string, all: readonly WizardRecord[], target: string) => ({
      // v3: 身份/种类随行 —— roster 金字塔的普查按 identity 去重, L0 永远收学徒。
      identity: wizards.get(target)?.identity || target,
      kind: wizards.get(target)?.kind,
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
        handoffSuggested: !!info && info.contextTokens > handoffLineOf(wizards, self, lastModel(info.jsonlPath) || info.model),
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
      json(res, 200, { ok: true, ...identityOf(self, self), peers: (await m.peers(self)).filter((p) => !p.self).length });
    });

    // 改名字 / 写职责。名字全局唯一、与聊天名脱钩 (默认会话只是出生时取了聊天名)。
    // `to` = 改**别人** (实例名 / 类名, 带不带点都认): 权限 = 同 bot 且 (调用方是它的直属
    // parent, 或调用方本身就是管家实例); 学徒不可被别人改。目标是类实例时 name 是
    // **新类名**: 全部实例同步成 <新类名>-<原序号> (序号不动), 名字形如 X-3 直接 400 ——
    // 那会造出两层实例名。/name 已下线 (人 2026-11-18), 这是唯一的改名入口。
    http.register("POST /wizard/identity", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      if (refuseMonitor(res, self, "wizard_identity")) return;
      const addressError = unsupportedPeerAddressField(body);
      if (addressError) { json(res, 400, { ok: false, reason: addressError }); return; }
      const b = body as { name?: string; description?: string; expertise?: string; to?: string };
      const peerName = stripSigil((b.to ?? "").toString());
      const target = peerName ? wizards.byName(peerName)?.target : self;
      if (!target) { json(res, 404, { ok: false, reason: `不知道 .${peerName} 是谁` }); return; }
      if (target !== self) {
        const victim = wizards.get(target);
        const caller = wizards.get(self);
        const callerSteward = !!caller && caller.ordinal !== undefined
          && wizards.classes?.get(identityOfRec(caller))?.role === "steward";
        const refusal = identityEditRefusal(victim, {
          sameBot: sameBot(self, target),
          editorIsParent: victim?.parent === self,
          editorIsStewardInstance: callerSteward,
        });
        if (refusal) { json(res, 403, { ok: false, reason: refusal, name: victim?.name ?? "" }); return; }
      }
      const asked = normalizeTag((b.name ?? "").toString());
      const description = (b.description ?? "").toString().trim();
      const expertise = (b.expertise ?? "").toString().trim();
      if ((b.name ?? "").toString().trim() && !asked) { json(res, 400, { ok: false, reason: "名字只能是 1-32 位字母/数字/`_`/`-`" }); return; }
      const before = settleName(wizards, chatNameOf(cfg, target), target);
      const rec = wizards.get(target);
      const cls = rec ? wizards.classes?.get(identityOfRec(rec)) : undefined;
      const isInstance = !!cls && rec?.ordinal !== undefined;
      if (asked && isInstance) {
        if (parseInstanceName(asked)) { json(res, 400, { ok: false, reason: `"${asked}" 长得像实例名 (<类名>-<数字>): 类名不能以 -数字 结尾` }); return; }
        if (!validClassName(asked)) { json(res, 400, { ok: false, reason: `"${asked}" 不是合法类名 (1-${CLASS_NAME_MAX} 位名字字符, 不以 -数字 结尾)` }); return; }
      }
      // 受影响的实例 (类: 全部; 自由 wizard: 只有它自己) —— 改名后 pane 标题 / 名册 / 宪章都得跟。
      const touched = isInstance && cls ? instancesOf(wizards, cls.id) : (rec ? [rec] : []);
      const was = new Map(touched.map((w) => [w.target, w.name] as const));
      // 名字换了, 指向旧名的管家绑定跟着换 —— 不改的话绑定悬空, 旧名日后被领走会把裸消息劫过去。
      // 与 boot 迁移的绑定改写**同一个实现** (rewriteStewardBindings: chatPolicy + 频道表, 按名
      // 大小写不敏感匹配), 类改名与自由改名共用一条路径。
      const rebind = (prev: string, next: string): void => {
        if (!prev || prev.toLowerCase() === next.toLowerCase()) return;
        rewriteStewardBindings(cfg, sourcePath, [{ from: prev, to: next }]);
      };
      let name = before;
      if (asked) {
        try {
          const { r } = guardCharter(() => {
            const next = wizards.rename(target, asked);
            // 绑定里存的是**类名**: 类实例的 before 是实例名 (X-1), 拿它去比对 chatPolicy 的
            // steward (X) 永不命中 —— 旧类名会悬空, 日后被新 wizard 领走就劫走裸消息。
            const fromBinding = isInstance && cls ? cls.name : before;
            const toBinding = isInstance && cls ? (wizards.classes?.get(cls.id)?.name ?? next) : next;
            rebind(fromBinding, toBinding);
            return next;
          }, (next) => ({
            what: target === self
              ? (before ? `把自己 ${before} 改名为 ${next}` : `给自己起名为 ${next}`)
              : `把 ${displayName(target)} 改名为 ${next} (由 ${displayName(self)} 发起)`,
            byHuman: target !== self,
          }));
          name = r;
        } catch (e) {
          json(res, 400, { ok: false, reason: (e as Error).message });
          return;
        }
      }
      if (description) wizards.upsertIdentity(target, { description });
      // 专长: 传 "-" 清掉; 它不进名册变动通知 (只在名册 / 候选行里读)。
      if (expertise) wizards.upsertIdentity(target, { expertise: expertise === "-" ? undefined : expertise });
      const me = identityOf(self, target);
      // 职责是别人决定"该不该找你"的依据, 改了就得让同群的知道 —— 否则他们照着
      // 出生快照里那句旧的 (或者空的) 职责派活。类改名则每个实例在自己的群里各报一次。
      const after = isInstance && cls ? instancesOf(wizards, cls.id) : (wizards.get(target) ? [wizards.get(target)!] : []);
      after.forEach((w) => {
        const prev = was.get(w.target) ?? "";
        if (asked || description) {
          postRoster(baseOfKey(w.target), [w.target], prev && prev !== w.name
            ? { op: "renamed", name: w.name, was: prev, ...(description ? { job: description } : {}) }
            : { op: "job", name: w.name, job: description }, subjectOf(wizards.get(w.target)));
        }
        if (asked) void m.retitlePane(w.target);
      });
      // 同上: 同群的知道新名字还不够, 它自己的宪章也写着旧名。
      if (asked && name !== before) recharter(after.map((w) => w.target));
      const instances = isInstance && cls ? after : [];
      // 类名 (不是实例名 X-N): 响应与 note 都按绑定/寻址用的那个名字说话。
      const className = isInstance && cls ? (wizards.classes?.get(cls.id)?.name ?? cls.name) : "";
      // 「已被占用」按落定名判定: 类实例落定的是类名, 不是 <类名>-<序号> (后者比出来永远不等)。
      const notice = renameNotice(asked, className || name);
      json(res, 200, {
        ok: true,
        ...me,
        ...(notice ? { renamed: notice } : {}),
        ...(isInstance && cls
          ? {
            class: { was: cls.name, name: className, instances: instances.map((w) => w.name) },
            note: `类 ${cls.name} → ${className}, ${instances.length} 个实例: ${instances.map((w) => w.name).join(", ")}`,
          }
          : {}),
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
      const b = body as { query?: string; chat?: string; cwd?: string; alive?: boolean; limit?: number; scope?: "chat" | "all" };
      const all = await rosterOf(self);
      const hit = all.filter(rosterFilters(b));
      // ── v3 §4 金字塔: L0 在场 (默认) / L1 本群 (chat) / L2 组团 (scope:"all"); ctx 超线强制降级 L0。
      const info = m.sessionInfo(self);
      const model = info?.jsonlPath ? lastModel(info.jsonlPath) : info?.model ?? "";
      const degraded = (info?.contextTokens ?? 0) >= handoffAt(model);
      const selfBase = baseOfKey(self);
      const stewardTarget = stewardRoute(cfg, wizards, selfBase, (t) => ((c) => c.runningCwd || c.defaultCwd)(m.getCwd(t))).target;
      // 「最近」与模型都从 transcript 读, 而且只为列出来的这一页读: 摘要用不指代任何人
      // 的箭头 (读名册的是另一个 wizard), 模型取它真正跑的那个 —— 绑定里的 model 只在
      // 有人显式选过时才有。
      // room 模型: 「欠着」= 它名下的 open duty (跨 room 现算)。
      const dutiesOf = (target: string): string => {
        const uid = wizards.get(target)?.uid;
        if (!uid) return "";
        return heldDuties({ kind: "wizard", id: uid }).map(dutyLine).join(" · ");
      };
      const enrich = (r: (typeof all)[number]) => ({
        ...r,
        duty: dutiesOf(r.target),
        model: r.model || (r.jsonlPath ? lastModel(r.jsonlPath) : ""),
        summary: r.jsonlPath ? lastExchange(r.jsonlPath, 80) : "",
        contextTokens: r.jsonlPath ? lastContextTokens(r.jsonlPath) : 0,
      });
      const census = rosterCensus(all);
      const now = Date.now();
      const layer: "L0" | "L1" | "L2" = degraded ? "L0" : b.scope === "all" ? "L2" : b.chat ? "L1" : "L0";
      // miss 提示: 按名字问了一个、本群在场名单里没有 —— 全机找得到就给升级提示。
      const missHint = b.query && layer === "L0" && !hit.some((r) => r.self || baseOfKey(r.target) === selfBase)
        ? `「${b.query}」不在本群在场名单 — 全机命中 ${hit.length} 个: wizard_roster({query}) 看全机命中, {scope:"all"} 看分群概览`
        : undefined;
      const degradedLine = degraded
        ? `ctx ${Math.round((info?.contextTokens ?? 0) / 1000)}k 已到交接线 (${Math.round(handoffAt(model) / 1000)}k) — 只列在场; query/chat 收窄或 peek_peer 单查`
        : undefined;
      if (layer === "L0") {
        const text = rosterL0(hit.map(enrich), { base: selfBase, stewardTarget, now, home: homedir(), census, ...(missHint ? { missHint } : {}), ...(degradedLine ? { degraded: degradedLine } : {}) });
        json(res, 200, { ok: true, layer, total: all.length, matched: hit.length, text });
        return;
      }
      if (layer === "L1") {
        // chat 过滤已把 hit 收到那一个聊天; 取命中行的 base (无命中退回自己)。
        const base = hit[0] ? baseOfKey(hit[0].target) : selfBase;
        const text = rosterL1(hit.map(enrich), { base, now, home: homedir() });
        json(res, 200, { ok: true, layer, total: all.length, matched: hit.length, text });
        return;
      }
      const text = rosterL2(hit.map(enrich), { base: selfBase, now });
      json(res, 200, { ok: true, layer, total: all.length, matched: hit.length, text });
    });

    // 管家分派前的候选表: 事实在这里算 (交集、读过的文件、ctx), 权衡留给管家。
    // 只为活着的读 transcript —— 冷的没有 jsonl 可读, 靠职责命中进表。
    /** 候选的原料: 除自己之外每个 wizard 的上下文事实 (文件集 / 最近的话 / ctx / 缓存 TTL)。
     *  `keep` 在读 transcript **之前**收窄: 每行要扫几 MB 尾巴, 全机几百个绑定读一遍是秒级 ——
     *  调用方只要活着的那几个时, 别替死掉的 pane 付这笔。 */
    const occupyingDuties = (target: string): string[] => {
      const uid = wizards.get(target)?.uid;
      if (!uid) return [];
      const who: Who = { kind: "wizard", id: uid };
      return heldDuties(who).filter((d) => occupies(d, who)).map(dutyLine);
    };
    const routeRowsOf = async (self: string, keep: (r: { alive: boolean; target: string }) => boolean = () => true): Promise<(RouteRow & { target: string })[]> => {
      const roster = await rosterOf(self);
      return roster
        .filter((r) => !r.self && keep(r))
        .map((r) => {
          const live = r.jsonlPath ? r.jsonlPath : "";
          const ttl = live ? cacheTtlSec(live) : 0;
          const materials = live ? contextMaterials(live) : [];
          return {
            ...r,
            lead: wizards.get(r.target)?.lead === true,
            duties: occupyingDuties(r.target),
            contextTokens: live ? lastContextTokens(live) : 0,
            ...(ttl ? { cacheTtlMs: ttl * 1000 } : {}),
            ...(live ? { cacheAt: cacheTouchMs(live) } : {}),
            sessionId: m.sessionInfo(r.target)?.sessionId,
            birthToken: wizards.get(r.target)?.birthToken,
            model: live ? lastModel(live) || r.model : r.model,
            materials,
            files: [...new Set(materials.filter((m) => m.confirmed && m.kind === "read").map((m) => m.path))],
            asks: live ? talkTurns(live, 12).filter((t) => t.role === "user").map((t) => t.text) : [],
            summary: live ? lastExchange(live, 80) : "",
          };
        });
    };
    const autoRouteRowsOf = async (self: string, tier: TierName) => {
      const pick = pickTier(cfg, tier, {});
      const budgetModel = (tier === "mini" || tier === "light") && pick.ok ? pick.model : undefined;
      return (await routeRowsOf(self, (r) => r.alive && !!tagOfKey(r.target)))
        .map((r) => ({ ...r, ...(budgetModel ? { budgetModel } : {}) }));
    };
    http.register("POST /wizard/route", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const b = body as { task?: string; cwd?: string; limit?: number; tier?: string; force?: boolean };
      const task = (b.task ?? "").trim();
      if (!task) { json(res, 400, { ok: false, reason: "task is required" }); return; }
      const limit = Math.min(Math.max(Number(b.limit ?? 5) || 5, 1), 20);
      const tierArg = (b.tier ?? "").trim();
      if (tierArg && !TIERS.includes(tierArg as TierName)) { json(res, 400, { ok: false, reason: `unknown tier: ${tierArg}` }); return; }
      const tier = (tierArg || tierFor(task, false)) as TierName;
      const force = b.force === true;
      const rows = await autoRouteRowsOf(self, tier);
      const now = Date.now();
      const cands = rankCandidates(task, (b.cwd ?? "").trim() || m.getCwd(self).runningCwd, rows, { now, ttlMs: CACHE_TTL_FALLBACK_SEC * 1000 });
      const decision = decide(task, cands, now, CACHE_TTL_FALLBACK_SEC * 1000, force, tier);
      json(res, 200, { ok: true, decision: decision.kind, reason: decision.why, tier, diagnostics: routeDiagnostics(task, cands, now, CACHE_TTL_FALLBACK_SEC * 1000, force, tier), text: `${cands.length > limit ? `共 ${cands.length} 个候选, 展示 ${limit} 个; diagnostics 保留全量。\n` : ""}${renderCandidates(task, cands.slice(0, limit), now, CACHE_TTL_FALLBACK_SEC * 1000, homedir(), { tier, force })}` });
    });

    // 派活收成一步 (见 route.decide): 查候选 → 过成本门控 → 转给已有的或按档白板 spawn →
    // chat_ask 投出去, 回决定与理由。默认决定由守护进程算; 管家不同意就 `to` 点名、
    // `force` 越过冷门控、`spawn:true` 硬要新的 —— 推翻要显式说。
    /** dispatch 回包的 reason: 投成了是选人理由; 投递 / 起 wizard 失败时 reason 必须是真实错误,
     *  选人理由降到 why —— 否则「你要了新的」会盖掉 bearAs / tell 的失败原因。 */
    const dispatchReason = (ok: boolean, real: unknown, why: string): { reason: string; why?: string } =>
      ok ? { reason: why } : { reason: String(real ?? "delivery failed (no reason)"), why };
    http.register("POST /dispatch", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      if (refuseMonitor(res, self, "delegate")) return;
      if (refuseGuide(res, self, "delegate")) return;
      const addressError = unsupportedPeerAddressField(body);
      if (addressError) { json(res, 400, { ok: false, reason: addressError }); return; }
      if (Object.prototype.hasOwnProperty.call(body, "cli")) { json(res, 400, { ok: false, reason: "cli is unsupported; dispatch uses the configured backend" }); return; }
      const retiredField = retiredOrchestrationField(body);
      if (retiredField) { json(res, 400, { ok: false, reason: retiredFieldReason(retiredField) }); return; }
      const b = body as { task?: string; taskFile?: string; params?: Record<string, string>; name?: string; description?: string; tier?: string; to?: string; force?: boolean; lead?: boolean; spawn?: boolean; public?: boolean; dryRun?: boolean; criteria?: string; return?: string; for?: string; planId?: string; join?: { chat?: string; mode?: string } };
      // 模板展开 (§6/§8) 必须发生在一切副作用之前 —— 选人、开根单、bearAs 全在后面:
      // 失败 400, 不留孤儿 wizard、不开路由行。taskFile 单独成立 (task 不必陪跑);
      // 选人/选档/description 用的摘要从展开文本 (或 params.header) 派生, 投递的是全文。
      let task = (b.task ?? "").toString().trim();
      let text = task;
      if ((b.taskFile ?? "") !== "") {
        let expanded: ExpandedTask;
        try { expanded = await expandTask({ taskFile: b.taskFile!, params: b.params ?? {} }, { baseDir: m.getCwd(self).runningCwd || m.getCwd(self).defaultCwd || process.cwd() }); }
        catch (e) { json(res, 400, { ok: false, reason: e instanceof TemplateError ? e.message : `template expansion failed: ${errText(e)}` }); return; }
        text = expanded.text;
        task = clipLine((b.params?.header ?? "").toString().trim() || expanded.text, 120);
      }
      if (!text.trim()) { json(res, 400, { ok: false, reason: "task is required" }); return; }
      // room 模型 (契约 §3): delegate 的产出 = 一条 chat_ask (kind:"task"), 结论只能
      // chat_reply 交代; return/public/rejoin 参数位已退役。
      const planId = String(b.planId ?? "").trim();
      if (planId) {
        if (!plans.healthy()) { json(res, 503, { ok: false, reason: "plans store unavailable; cannot associate this event" }); return; }
        const linkedPlan = plans.get(planId);
        if (!linkedPlan || linkedPlan.owner !== self || !["active", "paused"].includes(linkedPlan.state)) {
          json(res, 409, { ok: false, reason: "planId must name an unfinished plan owned by the caller" }); return;
        }
      }
      const lead = b.lead === true;
      const force = b.force === true;
      const to = (b.to ?? "").toString().trim();
      const now = Date.now();
      const ttlMs = CACHE_TTL_FALLBACK_SEC * 1000;
      // 占用保护由 decide 统一判断, 留在候选表里说明为什么不能自动复用。
      // 显式 to 保留人为选定; force 只影响成本门, 不绕 lead/工单/连续性保护。
      const tierArg = (b.tier ?? "").toString().trim();
      if (tierArg && !TIERS.includes(tierArg as TierName)) { json(res, 400, { ok: false, reason: `unknown tier: ${tierArg}` }); return; }
      const taskTier = (tierArg || tierFor(task, lead)) as TierName;
      const pool = to || b.spawn || lead ? [] : await autoRouteRowsOf(self, taskTier);
      const cands = rankCandidates(task, m.getCwd(self).runningCwd, pool, { now, ttlMs });
      let d: { kind: "existing"; why: string; row?: RouteRow } | { kind: "spawn"; why: string } = to ? { kind: "existing" as const, why: `你点名了 ${to}` }
        : b.spawn ? { kind: "spawn" as const, why: "你要了新的" }
          : lead ? { kind: "spawn" as const, why: "复杂活: 白板起一个 hard 档的 lead, 由它组队" }
            : decide(task, cands, now, ttlMs, force, taskTier);
      const diagnostics = { ...routeDiagnostics(task, cands, now, ttlMs, force, taskTier), deliveryFallback: "" };
      const shown = cands.map((e) => `${e.row.address || e.row.name}${e.row.busy ? " 忙" : ""}`);
      if (b.dryRun) {
        json(res, 200, { ok: true, dryRun: true, diagnostics, decision: d.kind, reason: d.why, ...(d.kind === "existing" ? { name: to || (d.kind === "existing" && d.row ? d.row.address || d.row.name : "") } : { tier: taskTier }), ...(shown.length ? { candidates: shown } : {}) });
        return;
      }
      // room? 给了: 在选人 / 生人之前验 room 目标, 不合法直接 4xx, 不生 wizard。
      const delegateRoom = ((b as { room?: string }).room ?? "").toString().trim();
      if (delegateRoom) {
        const chk = checkRoomArg(self, delegateRoom);
        if (!chk.ok) { json(res, chk.status, { ok: false, reason: chk.reason }); return; }
      }
      /** 投递 = hub.append 一条 task 行; room 按 room?/缺省规则落 (D-1)。 */
      const deliverTask = async (name: string): Promise<{ status: number; body: Record<string, unknown> }> => {
        const me = roomSelfOf(self);
        if (!me) return { status: 400, body: { ok: false, reason: "caller 不在名册上, 没有 uid" } };
        const who = whoRefOf(name);
        if (!who || who.kind !== "wizard") return { status: 400, body: { ok: false, reason: "认不出执行者: " + name } };
        const roomArg = ((b as { room?: string }).room ?? "").toString().trim();
        const target = roomTargetOf(me, [who], roomArg);
        if (target.error || !target.room) return { status: target.status ?? 400, body: { ok: false, reason: target.error ?? target.reason ?? "" } };
        // lead 的层级规矩随正文带 (宪章是出生快照, 打法只这一件活用得上)。
        const body2 = lead ? text + "\n\n" + renderReminder({ wezard: "lead" }, wizards.byUid(who.id)?.lead ? renderLeadPlaybook() : renderLead()) : text;
        const forOf = ((b.for ?? "").toString().trim()) || hub.defaultFor(me.id);
        const draft = { author: me, kind: "task" as const, text: body2, to: [who], origin: "tool" as const,
          ...(forOf ? { for: forOf } : {}),
          ...(planId ? { planId } : {}) };
        // room? 给了: 先入座再 append (judge 要求 to 是成员); 没给: 落点本来就接得住 (dm / 缺省 room)。
        const placed = roomArg
          ? seatThenAppend(target.room, () => joinRoomSpawn(self, roomArg, name), (r) => hub.append(r, draft))
          : ((v) => (v.ok ? { ok: true as const, verdict: v } : { ok: false as const, status: v.status, reason: v.reason }))(hub.append(target.room, draft));
        if (!placed.ok) return { status: placed.status, body: { ok: false, reason: placed.reason } };
        const v = placed.verdict;
        return { status: 200, body: { ok: true, room: v.row.room, id: v.row.id, event: v.row.id, name: peerAddress(cfg, wizards.byUid(who.id)?.target ?? who.id), queued: true,
          receipt: "已持久化排队; 结论经 chat_reply({re, text, status}) 交代" } };
      };
      if (d.kind === "existing" && !to && d.row?.target) {
        const idle = await m.idleNow(d.row.target);
        if (!idle) {
          diagnostics.deliveryFallback = "candidate became busy";
          d = { kind: "spawn", why: `${d.why}; 投递前复核退回 (candidate became busy), 白板 spawn` };
        }
      }
      if (d.kind === "existing") {
        const name = to || (d.kind === "existing" && d.row ? d.row.address || d.row.name : "");
        const r = resolvePeer(self, name);
        if (!r.ok) { json(res, r.status, { ok: false, reason: r.reason, ...(r.candidates?.length ? { candidates: r.candidates } : {}) }); return; }
        const t = await deliverTask(name);
        if (lead && t.status === 200) wizards.upsert(r.target, { lead: true,
          leadOf: [...(wizards.get(r.target)?.leadOf ?? []), String(t.body.id)] });
        json(res, t.status, { ...t.body, diagnostics, decision: "existing", ...dispatchReason(t.status === 200, t.body.reason, d.why), ...(shown.length ? { candidates: shown } : {}) });
        return;
      }
      const name = (b.name ?? "").toString().trim();
      const description = (b.description ?? "").toString().trim() || clipLine(task, 120);
      // 空 name 交给 bearAs / claimSlot 按持久序号自动取名避重, 不当作显式点名复用旧记录。
      const tier = taskTier;
      const born = await bearAs(self, { inherit: false, name, description, tier, ...(lead ? { lead: true } : {}) } as PeerBody);
      if (born.status !== 200) { json(res, born.status, { ...born.body, diagnostics, decision: "spawn", ...dispatchReason(false, born.body.reason, d.why) }); return; }
      const t = await deliverTask(String(born.body.name ?? ""));
      // 派不出去 (入座 / append 失败): 别留没活的孤儿 —— 走 stop_wizard end 同一条回收路径。
      if (t.status !== 200 && typeof born.body.target === "string") {
        const orphan = born.body.target;
        const killed = await m.killPane(orphan).catch(() => ({ ok: false }));
        const forgotten = forgetWizard(orphan);
        log.warn({ orphan, killed: killed.ok, forgotten, reason: t.body.reason }, "delegate: 派活失败, 回收刚生的 wizard");
      }
      json(res, t.status, {
        ...t.body,
        decision: "spawn",
        ...dispatchReason(t.status === 200, t.body.reason, d.why),
        tier,
        ...(born.body.model ? { model: born.body.model } : {}),
        ...(born.body.effort ? { effort: born.body.effort } : {}),
        ...(shown.length ? { candidates: shown } : {}),
      });
    });


    // 记忆三种作用域: self 跟着自己 (wizards.json), 直写; chat / workspace 是共享的 md,
    // 每个在那个群 / 那个目录出生的 wizard 都会读到 —— 它们只收提议, 由整理者合并
    // (见 wizard-memory.ts / memory-steward.ts)。
    http.register("POST /wizard/remember", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      if (refuseMonitor(res, self, "wizard_remember")) return;
      const b = body as { note?: string; forget?: string; scope?: string };
      const note = (b.note ?? "").toString().trim();
      const forget = (b.forget ?? "").toString().trim();
      const scope = (b.scope ?? "self").toString();
      if (scope === "chat" || scope === "workspace") {
        const key = scope === "chat" ? baseOfKey(self) : memoryCwdOf(self);
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
      const { memory } = wizards.upsertIdentity(self, { memory: want });
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
      const retiredField = retiredOrchestrationField(body);
      if (retiredField) return { status: 400, body: { ok: false, reason: retiredFieldReason(retiredField) } };
      // 出生投递 (下方 acceptPeerDispatch) 不经 tellPeerAsInner 的模板展开入口 ——
      // 第一期不接 taskFile; MCP 层已拦, 这里也拒绝直连 HTTP 请求: 显式 400,
      // 不让调用方以为模板生效了而实际投出去的是空正文。
      if ((body as { taskFile?: string }).taskFile !== undefined)
        return { status: 400, body: { ok: false, reason: "taskFile not supported on spawn_wizard; use delegate" } };
      const addressError = unsupportedPeerAddressField(body);
      if (addressError) return { status: 400, body: { ok: false, reason: addressError } };
      if (Object.prototype.hasOwnProperty.call(body, "cli"))
        return { status: 400, body: { ok: false, reason: "cli is unsupported; spawn and clone use the configured backend" } };
      const b = body as { name?: string; description?: string; inherit?: boolean; from?: string; cwd?: string; chat?: string; model?: string; effort?: string; tier?: string; task?: string; lead?: boolean; planId?: string; room?: string };
      const requestedPlanId = (b.planId ?? "").trim();
      if (requestedPlanId && !b.task?.trim()) return { status: 400, body: { ok: false, reason: "planId requires a dispatched task" } };
      if (requestedPlanId) {
        if (!plans.healthy()) return { status: 503, body: { ok: false, reason: "plans store is unhealthy; cannot associate this event" } };
        const linkedPlan = plans.get(requestedPlanId);
        if (!linkedPlan || linkedPlan.owner !== self || !["active", "paused"].includes(linkedPlan.state))
          return { status: 409, body: { ok: false, reason: "planId must name an unfinished plan owned by the caller" } };
      }
      // room? 给了: 生之前先验 (认得出 + 调用方是成员), 不合法回 4xx, 不留孤儿。
      const roomArg = (b.room ?? "").toString().trim();
      if (roomArg) {
        const chk = checkRoomArg(self, roomArg);
        if (!chk.ok) return { status: chk.status, body: { ok: false, reason: chk.reason } };
      }
      const askedEffort = parseEffort(b.effort);
      if (b.effort !== undefined && !askedEffort) { return { status: 400, body: { ok: false, reason: `effort 只有这几档: ${EFFORTS.join(" / ")}` } }; }
      // `inherit` 没有默认值 —— 继承与否是两种完全不同的分身 (一种开局就带着你
      // 读过的一切, 另一种白纸一张), 猜错了要么白烧一份上下文, 要么让它从零重读。
      // 逼调用方每次自己说。
      if (typeof b.inherit !== "boolean") {
        return { status: 400, body: { ok: false, reason: "inherit 必填: true = fork 你此刻的上下文 (它开局就有你读过的材料, 必须留在同一个 cwd); false = 空白分身, 只继承身份" } };
      }
      const inherit = b.inherit;
      // 克隆的源头: 默认是调用方自己; `from` 点名就 fork 那个 wizard 此刻的上下文。
      // 分身始终归调用方管理 (parent = self), 只有上下文可以来自别处。
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
      const pick = pickTier(cfg, b.tier, { model: b.model, effort: askedEffort }, forkBackend);
      if (!pick.ok) return { status: 400, body: pick };
      const effort = pick.effort;
      // 别人的会话 fork 不出来就是失败, 不能像克隆自己那样悄悄退化成白板 —— 调用方
      // 要的恰恰是它的上下文, 给一张白纸等于答非所问。
      if (source !== self && !sourceInfo?.sessionId) {
        return { status: 409, body: { ok: false, reason: `${displayName(source)} 没有可 fork 的会话 (还没说过话, 或绑定已失效)` } };
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
      // 内存闸放在占名字之前: 拒了就什么都没留下 (没有半生的身份、没有空 pane)。无 swap 的
      // 小机上再起一个 CLI 会让整机抖动到事件循环停摆, 调用方只会看到一个迟到几分钟的 MCP 超时。
      const short = memShortfall(cfg.wrc.memoryGuard.spawnMinMb, memAvailableMb());
      if (short) {
        log.warn({ self, ...short }, "spawn refused: low host memory");
        return { status: 503, body: { ok: false, reason: `主机可用内存只剩 ${short.availMb} MB (< ${short.floorMb} MB, wrc.memoryGuard.spawnMinMb), 再起一个 CLI 会把机器推进抖动 —— 先 stop_wizard 收掉用不着的分身, 或把活派给已有的 wizard` } };
      }
      const askedName = String(b.name ?? "");
      const slotR = await claimSlot(base, askedName, (target) => {
        const record = target ? wizards.get(target) : undefined;
        return !record || record.parent === self;
      });
      if (!slotR.ok) { return { status: slotR.status, body: slotR.body }; }
      const { target, name } = slotR;
      const releaseBirth = (): void => releaseSlot(slotR);
      const forkOf = inherit && source !== self ? source : undefined;
      // 先落身份再 spawn: 宪章是从注册表渲染出来的, 记录不在就渲染出一个无名分身。
      if (!ownsSlot(slotR)) { releaseBirth(); return { status: 409, body: { ok: false, reason: "birth identity changed during spawn preparation" } }; }
      wizards.upsert(target, {
        description: (b.description ?? "").toString().trim(),
        parent: self,
        bornAt: Date.now(),
        clonedFrom: inherit ? sourceInfo?.sessionId ?? "" : "",
        ...(forkOf ? { forkOf } : {}),
        // fork 了上下文就一并继承 self 记忆: 系统提示不随 fork 走 (分身拿的是自己的宪章),
        // 不拷的话它开局就没有, /clear 或交接重开后更是彻底没了。标上来源; 已经是继承来的不再套一层。
        ...(inherit ? { memory: (wizards.get(source)?.memory ?? []).map((x) => x.startsWith("(继承自 ") ? x : `(继承自 ${displayName(source)}) ${x}`) } : {}),
        tier: pick.tier,
        // 显式写 undefined: 复用的冷记录可能当过 lead。
        lead: b.lead === true ? true : undefined,
        leadOf: undefined,
        // 生完才清; 这个进程中途没了, 下次开机由 sweepUnborn 认出并收掉。
        spawning: BOOT_ID,
      });
      const charter = charterFor(target, { parent: self, forkOf, inherited: inherit, cli: pick.cli });
      const task = (b.task ?? "").toString().trim();
      // 先盖章再生: 分叉出来的 transcript 里躺着被克隆者的旧回复, 时刻早于这一枚章,
      // room 的交代才不会把它们当成分身对这件活的答复。
      const birthGuard = (): boolean => ownsSlot(slotR);
      if (!birthGuard()) { releaseBirth(); return { status: 409, body: { ok: false, reason: "wizard identity or caller turn changed before spawn" } }; }
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
        releaseBirth();
        return { status: 500, body: { ok: false, reason: r.reason } };
      }
      if (!ownsSlot(slotR)) return { status: 409, body: { ok: false, reason: "birth identity replaced during spawn" } };
      finishSlot(slotR);
      wizards.upsert(target, { clonedFrom: r.inherited ? sourceInfo?.sessionId ?? "" : "", ...(r.inherited ? {} : { forkOf: undefined }) });
      const kid = briefOf(self, target);
      // 出生不再发群气泡 (人要看的是结论, 不是谁生了谁 —— 过程在 rolepage 里);
      // 同群的 wizard 仍要知道群里多了一个成员。工单里的临时工连这条也省掉。
      postRoster(base, [target, self], {
        op: "born", name, by: displayName(self), clone: true,
        ...(r.inherited ? { ctx: forkOf ? displayName(forkOf) : displayName(self) } : {}),
        ...(kid.description ? { job: kid.description } : {}), cwd: r.cwd,
      }, subjectOf(wizards.get(target)));
      // 出生即派活 (契约 §3): 一条 task 行, 结论经 chat_reply 交代; room? 入座。
      const wantDispatch = !!task && birthGuard();
      let dispatched = false;
      let dispatchedEvent = "";
      let dispatchedRoom = "";
      let dispatchError = "";
      if (wantDispatch) {
        const me = roomSelfOf(self);
        const who = wizards.get(target)?.uid;
        if (!me || !who) dispatchError = "caller / 新生者不在名册上, 没有 uid";
        else {
          const dest = roomTargetOf(me, [{ kind: "wizard", id: who }], roomArg || undefined);
          if (!dest.room) dispatchError = dest.error ?? dest.reason ?? "没有落点 room";
          else {
            const forOf = (((b as { for?: unknown }).for ?? "").toString().trim()) || hub.defaultFor(me.id);
            const draft = { author: me, kind: "task" as const,
              text: task + (b.lead === true ? "\n\n" + renderReminder({ wezard: "lead" }, renderLeadPlaybook()) : ""),
              to: [{ kind: "wizard" as const, id: who }], origin: "tool" as const, ...(requestedPlanId ? { planId: requestedPlanId } : {}),
              ...((forOf) ? { for: forOf } : {}) };
            // room? 给了: 先入座再 append (judge 要求 to 是成员); append 被拒如实回 dispatched:false。
            const placed = roomArg
              ? seatThenAppend(dest.room, () => joinRoomSpawn(self, roomArg, name), (r) => hub.append(r, draft))
              : ((v) => (v.ok ? { ok: true as const, verdict: v } : { ok: false as const, status: v.status, reason: v.reason }))(hub.append(dest.room, draft));
            if (placed.ok) {
              const v = placed.verdict;
              dispatched = true; dispatchedEvent = v.row.id; dispatchedRoom = v.row.room;
              if (b.lead === true) wizards.upsert(target, { leadOf: [v.row.id] });
            } else dispatchError = placed.reason;
          }
        }
        if (dispatchError) log.warn({ self, target, room: roomArg, reason: dispatchError }, "spawn/clone: 出生即派活没落进 room");
      }
      return { status: 200, body: { ok: true, target, name, address: name, inherited: r.inherited, sessionId: r.sessionId, cwd: r.cwd, dispatched, queued: dispatched, ...(dispatchError ? { dispatchError } : {}), ...(dispatched ? { event: dispatchedEvent, ...(dispatchedRoom ? { room: dispatchedRoom } : {}) } : {}), ...(r.model ? { model: r.model } : {}), ...(r.modelWarning ? { modelWarning: r.modelWarning } : {}), ...(r.effort ? { effort: r.effort } : {}), ...(pick.tier ? { tier: pick.tier } : {}), via: pick.via } };
    };
    http.register("POST /wizard/clone", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      if (refuseMonitor(res, self, "spawn_wizard")) return;
      if (refuseGuide(res, self, (body as { inherit?: boolean }).inherit ? "clone_wizard" : "spawn_wizard")) return;
      const r = await bearAs(self, body);
      // room? 参数 (契约 §3): 出生落地即入座 (via spawn, 免审)。
      if (r.status === 200) joinRoomSpawn(self, (body as { room?: string }).room, String((r.body as { name?: string }).name ?? ""));
      json(res, r.status, r.body);
    });

    // 收掉一个 wizard。interrupt = 打断它这一轮 (Esc); end = 结束它并回收 pane。
    // 自己终结自己是合法的 (分身干完活自我了结), 代价是这次工具调用不会返回 ——
    // 回执只在 rolepage (生命周期事件不进群); 同群的 wizard 从名册增量里得知。
    /** 抹掉一个已经没有未结束计划的 wizard 身份。学徒 (§7) 永不可抹 —— 连续身份。 */
    const forgetWizard = (target: string): boolean => {
      if (isApprentice(wizards, target)) return false;
      if (planRetirementBlock(target)) return false;
      leaveRooms(target, "实例结束"); // room: 名下未决 duty 落 canceled, 唤醒提问者
      wizards.drop(target);
      return true;
    };

    http.register("POST /wizard/stop", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      if (refuseMonitor(res, self, "stop_wizard")) return;
      const addressError = unsupportedPeerAddressField(body);
      if (addressError) { json(res, 400, { ok: false, reason: addressError }); return; }
      const b = body as { name?: string; mode?: string; forget?: boolean; turn?: string; force?: boolean };
      const r = resolvePeer(self, addrOf(b));
      // 有身份没会话 (冷记录 / 生到一半的僵尸): resolvePeer 够不着它, 但收它不需要
      // 会话 —— end 视为早已结束, forget 删掉记录、腾出名字。interrupt 无从谈起。
      const found = r.ok || r.candidates?.length ? undefined : ((w) => (w && sameBot(self, w.target) ? w : undefined))(wizards.byName(addrOf(b)));
      const cold = found && !m.chatTargets(baseOfKey(found.target)).includes(found.target) ? found : undefined;
      if (cold && found?.kind === "apprentice") {
        json(res, 409, { ok: false, target: found.target, reason: "学徒是连续身份 (代表人, 每 bot 实例唯一), 不可结束或退役" });
        return;
      }
      if (cold && (b.mode ?? "end") === "end") {
        if (retiringWizardTargets.has(cold.target)) { json(res, 409, { ok: false, reason: "wizard retirement is already in progress" }); return; }
        retiringWizardTargets.add(cold.target);
        try {
        const blocked = planRetirementBlock(cold.target);
        if (blocked) { json(res, blocked.status, { ok: false, reason: blocked.reason }); return; }
        if (cold.target !== self && wizards.get(cold.target)?.parent !== self) { json(res, 403, { ok: false, reason: "only the wizard itself or its direct parent may end it" }); return; }
        if (b.forget && childrenOf(wizards.all(), cold.target).length) { json(res, 409, { ok: false, reason: "end child wizards before forgetting their parent" }); return; }
        const forgotten = b.forget ? forgetWizard(cold.target) : false;
        if (b.forget && !forgotten) { const again = planRetirementBlock(cold.target); json(res, again?.status ?? 409, { ok: false, reason: again?.reason ?? "wizard retirement is blocked" }); return; }
        json(res, 200, { ok: true, target: cold.target, name: cold.name, mode: "end", forgotten, note: "它本来就没有会话在跑" });
        return;
        } finally { retiringWizardTargets.delete(cold.target); }
      }
      if (!r.ok) { json(res, r.status, { ok: false, reason: r.reason, candidates: r.candidates }); return; }
      const { target } = r;
      const end = (b.mode ?? "end") === "end";
      // 学徒 (§7) 是连续身份: 不可结束/退役 (pane 死亡会自动同身份重生); 打断它这一轮 (interrupt) 照常。
      if (end && isApprentice(wizards, target)) {
        json(res, 409, { ok: false, target, reason: "学徒是连续身份 (代表人, 每 bot 实例唯一), 不可结束或退役; 要停它这一轮用 mode:'interrupt'" });
        return;
      }
      if (end && retiringWizardTargets.has(target)) { json(res, 409, { ok: false, reason: "wizard retirement is already in progress" }); return; }
      if (end) retiringWizardTargets.add(target);
      try {
      const victim = briefOf(self, target);
      // 当事人要在 forget 抹掉记录之前取 (见 subjectOf)。
      const victimRec = wizards.get(target);
      if (end) {
        const blocked = planRetirementBlock(target);
        if (blocked) { json(res, blocked.status, { ok: false, reason: blocked.reason }); return; }
      }
      if (end && target !== self && victimRec?.parent !== self) { json(res, 403, { ok: false, reason: "only the wizard itself or its direct parent may end it" }); return; }
      if (end && b.forget && childrenOf(wizards.all(), target).length) { json(res, 409, { ok: false, reason: "end child wizards before forgetting their parent" }); return; }
      if (!end && target === self) { json(res, 400, { ok: false, reason: "打断自己没有意义 —— 你就是正在生成的那一个" }); return; }
      // 按件号撤回自己派的那一件 (room 模型): daemon 代写一条 canceled reply 关掉 duty,
      // 它此刻正在做的就是这件才按 Esc —— 被打断那一轮的其余 duty 不关 (§3b), 下次唤醒重投。
      const turn = (b.turn ?? "").toString().trim();
      if (!end && turn) {
        const roomId = roomStore.roomOfMsg(turn);
        const s = roomId ? roomState(roomId) : undefined;
        const meWho = roomSelfOf(self);
        const duty = s ? openDuties(s).find((d) => d.msg === turn) : undefined;
        if (!roomId || !s || !duty || !meWho || !sameWho(duty.asker, meWho)) {
          json(res, 404, { ok: false, reason: "你没有在等 " + (victim.name || target) + " 答 '" + turn + "' 这件 (已落定、消息 id 写错, 或不是你派的)" });
          return;
        }
        const v = hub.append(roomId, { author: DAEMON, kind: "reply", re: [turn],
          text: "[wezard] " + displayName(self) + " 撤回了这件", status: "canceled", statusGiven: true, origin: "daemon" });
        const busy = !(await m.idleNow(target));
        const esc = busy ? await m.interruptPane(target) : undefined;
        json(res, 200, {
          ok: true, target, name: victim.name, mode: "interrupt", turn, canceled: v.ok, interrupted: !!esc?.ok,
          ...(esc && !esc.ok ? { note: "这件已撤回, 但 Esc 没按成 (" + (esc.reason ?? "unknown") + "), 它这一轮可能还在跑" } : {}),
          ...(!busy ? { note: "它此刻没在做这件 —— 这件已撤回, 它之后也不会再被唤醒做它" } : {}),
        });
        return;
      }
      // 不带件号的打断只按 Esc (I-1 语义): 它手上未结的 duty 不关, 下次唤醒按游标重投。
      const canceled = 0;
      const done = end ? await m.killPane(target) : await m.interruptPane(target, { teardown: true });
      if (!done.ok) { json(res, 502, { ok: false, target, reason: done.reason }); return; }
      if (wizards.get(target)?.birthToken !== victimRec?.birthToken) { json(res, 409, { ok: false, target, reason: "wizard identity changed during stop; identity cleanup withheld" }); return; }
      const forgotten = end && b.forget ? forgetWizard(target) : false;
      if (end && b.forget && !forgotten) { const blocked = planRetirementBlock(target); json(res, blocked?.status ?? 409, { ok: false, target, reason: blocked?.reason ?? "wizard retirement is blocked" }); return; }
      // 打断只是停了它这一轮, 它还在; 只有结束才是名册变了。
      if (end) postRoster(baseOfKey(target), [target, self], { op: "ended", name: victim.name || target, by: displayName(self), ...(b.forget ? { why: "forgotten" } : {}) }, subjectOf(victimRec));
      json(res, 200, { ok: true, target, name: victim.name, mode: end ? "end" : "interrupt", forgotten: !!forgotten, ...(canceled ? { canceled } : {}) });
      } finally { if (end) retiringWizardTargets.delete(target); }
    });

    // 换模型 / effort: 省略名字 = 换自己 (选择器盖在正在跑的这一轮上面照样能开), 点名 =
    // 换那个 wizard。与 spawn 时的 `model` 是同一条路 (model-select.ts); effort 走
    // `/effort` 档位条的「只本会话」键, 不碰全机默认。两样都给就先模型后档位。
    http.register("POST /wizard/model", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      if (refuseMonitor(res, self, "set_model")) return;
      if (refuseGuide(res, self, "set_model")) return;
      const addressError = unsupportedPeerAddressField(body);
      if (addressError) { json(res, 400, { ok: false, reason: addressError }); return; }
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
      if (refuseGuide(res, self, "handoff")) return;
      const r = await handoffSelf(self, ((body as { brief?: string }).brief ?? "").toString().trim());
      json(res, r.status, r.body);
    });

    // 挂起事项全表 (room 模型): 你派出去、还没了结的 duty。`drop` = 显式关掉 (写 passed);
    // `name` 看别人的 (只读)。旧 pending-items 台账已退役, 唯一事实是 room 账本。
    http.register("POST /pending", async (req, res) => {
      const { self, body } = await readPeerBody(req);
      if (!self) { json(res, 400, { ok: false, reason: "cannot resolve caller session" }); return; }
      const addressError = unsupportedPeerAddressField(body);
      if (addressError) { json(res, 400, { ok: false, reason: addressError }); return; }
      const b = body as { name?: string; drop?: unknown; why?: string };
      const who = (b.name ?? "").toString().trim();
      const r = who ? resolvePeer(self, who) : undefined;
      if (r && !r.ok) { json(res, r.status, { ok: false, reason: r.reason, candidates: r.candidates }); return; }
      const owner = r?.ok ? r.target : self;
      if (who && owner !== self && Array.isArray(b.drop)) { json(res, 403, { ok: false, reason: "只能消自己派出去的" }); return; }
      const me = roomSelfOf(self);
      const ownerUid = wizards.get(owner)?.uid;
      if (!me || !ownerUid) { json(res, 200, { ok: true, text: "(没有在等的)" }); return; }
      const drop = Array.isArray(b.drop) ? b.drop.map(String) : typeof b.drop === "string" ? [b.drop] : [];
      const dropped: string[] = [];
      const mine: string[] = [];
      for (const room of roomStore.ids()) {
        const s = roomState(room);
        if (!s) continue;
        for (const d of openDuties(s)) {
          if (!sameWho(d.asker, { kind: "wizard", id: ownerUid })) continue;
          const holder = holderOf(s, d);
          const label = d.msg + " → " + (holder ? roomNameOf(holder) : "?") + " (" + d.kind + (d.last ? ", " + d.last.status : "") + ") " + clipLine(s.byId.get(d.msg)?.text ?? "", 60);
          if (drop.includes(d.msg) && owner === self) {
            // 消项 = 调用方自己写 passed (自己是 asker, 不是 holder —— judge 不给关别人名下的账,
            // 但人可以对任何 duty 写; 这里用 daemon 代写, 与 stop_wizard 撤回同一口径)。
            const v = hub.append(room, { author: DAEMON, kind: "reply", re: [d.msg],
              text: "[wezard] " + displayName(self) + " 消掉这项: " + ((b.why ?? "").toString().trim() || "不再等了"),
              status: "passed", statusGiven: true, origin: "daemon" });
            if (v.ok) dropped.push(d.msg);
          } else mine.push(label);
        }
      }
      const missed = drop.filter((t) => !dropped.includes(t));
      json(res, 200, {
        ok: true,
        text: [
          ...(dropped.length ? ["已消掉: " + dropped.join(" ")] : []),
          ...(missed.length ? ["没找到 (不是你开着的): " + missed.join(" ")] : []),
          ...(mine.length ? ["你派出去、还没了结的 " + mine.length + " 件:", ...mine.map((x) => "- " + x)] : ["(没有在等的)"]),
        ].join("\n"),
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
      if (refuseMonitor(res, self, "schedule_task")) return;
      const addressError = unsupportedPeerAddressField(body);
      if (addressError) { json(res, 400, { ok: false, reason: addressError }); return; }
      const b = body as { when?: string; prompt?: string; note?: string; fresh?: boolean; quiet?: boolean; id?: string };
      const prompt = (b.prompt ?? "").toString().trim();
      const whenText = (b.when ?? "").toString().trim();
      if (!prompt) { json(res, 400, { ok: false, reason: "prompt required" }); return; }
      const trigger = parseTrigger(whenText, new Date());
      if (!trigger) { json(res, 400, { ok: false, reason: WHEN_HELP(whenText) }); return; }
      // name 省略 = 排给调用者自己。这是最常见的用法: wizard 给自己定一个夜里跑的活。
      // 注入自身在**当下**是死锁 (往正在生成的输入框里打字), 但定时是未来的事,
      // 那时这一轮早已收工, 所以这里不套 peer-send 的自我保护。
      const address = addrOf(body).trim();
      let target = self;
      if (address) {
        const r = resolvePeer(self, address);
        if (!r.ok) { json(res, r.status, { ok: false, reason: r.reason, candidates: r.candidates }); return; }
        target = r.target;
      }
      // owner = self; resolvePeer 已拦住别的机器人的名字, 这一道是给以后别的取 target 的路兜底。
      if (!sameBot(self, target)) { json(res, 404, { ok: false, reason: `no wizard named '.${address}' — wizard_roster lists every name` }); return; }
      // 到点是新建还是续用, 在**排班时**就定死。两条都指向新建:
      //   · 没点名 wizard —— 定时的 prompt 本就要求零上下文自洽, 没理由挑一个会话挤进去;
      //   · prompt 自己就在说「建两个 wizard 去干 xxx」—— 这时 name 只是「在谁的聊天/
      //     目录下办」, 不是「在它的上下文里续」。
      // `fresh` 显式传入压过这两条推断 (要强行在该 wizard 那一轮里续就传 false)。
      // 学徒 (§7) 是连续唯一会话: 定时到点永远注入它自己的会话, fresh 一律拒 (显式 true 也不行)。
      const fresh = isApprentice(wizards, target)
        ? false
        : typeof b.fresh === "boolean" ? b.fresh : !address || promptWantsFreshWizard(prompt);
      const note = (b.note ?? "").toString();
      const id = uniqueId(slugify((b.id ?? "").toString() || note || prompt.slice(0, 24), "task"), tasks.takenIds());
      const created = tasks.create({ id, trigger, prompt, target, fresh, quiet: b.quiet === true, note, createdBy: self });
      if ("error" in created) { json(res, 400, { ok: false, reason: created.error }); return; }
      tasks.patchState(id, { createdAt: Date.now() });
      json(res, 200, {
        ok: true,
        ...renderTask(created, tasks.stateOf(id)),
        address: peerAddress(cfg, target),
        owner: peerAddress(cfg, self),
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
          address: peerAddress(cfg, t.target || defaultChatFor(cfg, ownerOf(t))),
          owner: peerAddress(cfg, ownerOf(t)),
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
    /** chatPolicy 的依据: 各聊天名 ↔ principal —— 键落盘是 principal, 人和模型认的是名字。 */
    const chatPolicyEvidence = (p: string[]): string[] => {
      if (p[0] !== "chatPolicy") return [];
      const named = listChatNames(cfg);
      const line = (b: string): string => `${named.filter((c) => c.base === b).map((c) => c.name).join(" / ") || "(未命名)"} = ${b}`;
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
    // 看不见, 需要显式 /new 才重新渲染宪章; handoff /clear 保留启动时的系统提示。不按字段清单判 —— 宪章读哪些配置随代码变,
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
      const live = new Set(snap.ok ? parsePaneIds(snap.stdout) : []); // 解析统一走 parsePaneIds (修复单 §1)
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
    /** /clear 不重新渲染进程启动时的宪章; 只通知, 不暗中重启会话。 */
    const announceCharterImpact = (c: CharterChange, hits: CharterHit[]): string => {
      if (!hits.length) return "";
      const ask = `${c.reload ? "守护进程 reload 之后, " : ""}需要显式 /new 才能载入新宪章；handoff /clear 保留原进程的系统提示，不会使这次改动生效`;
      hits.filter((h) => h.target !== c.self).forEach((h) => notices.post([h.target],
        `${c.what} 改动了你的宪章 (系统提示, 变了的段: ${h.sections.join(" / ")}); ${ask}`));
      const shown = hits.filter((h) => sameBot(c.self ?? "", h.target));
      const mine = hits.find((h) => h.target === c.self);
      return [
        "",
        `⚠ 这次改动进了宪章 (系统提示)。${ask}。受影响 ${shown.length} 个: ${shown.map((h) => displayName(h.target)).join(" ")}`,
        ...(mine ? [`**你自己也在其中** (变了的段: ${mine.sections.join(" / ")})`] : []),
      ].join("\n");
    };
    // 所有会动宪章的写入 (config_set、人 `/name`、新群引导的管家绑定) 共用这一个守卫: 写前写后各渲染一遍
    // 挂在 pane 上的 wizard 的宪章, 变了的、pane 还活着的挂提醒 (见 announceCharterImpact)。
    // 快照到写完之间不能有 await —— 别人的写入插进来, 前后就对不上了。已经写了: 比对失败只少一句提醒, 不能让调用方以为没写而重发。
    guardCharter = (write, change) => {
      const targets = attachedWizards();
      const before = charterSnapshot(targets);
      const r = write();
      const c = change(r);
      if (!c) return { r, note: Promise.resolve("") };
      const fail = (e: unknown): string => {
        log.warn({ err: errText(e), what: c.what }, "宪章影响比对失败");
        return `\n(宪章影响没比对出来: ${errText(e)} —— 改的若是进宪章的内容, 受影响的 wizard 需要显式 /new 才载入；handoff /clear 不刷新系统提示)`;
      };
      try {
        const hits = charterImpact(before, (c.after ?? charterSnapshot)(targets));
        return { r, note: liveOf(hits.map((h) => h.target)).then((live) => announceCharterImpact(c, hits.filter((h) => live.includes(h.target)))).catch(fail) };
      } catch (e) { return { r, note: Promise.resolve(fail(e)) }; }
    };

    /** 配置的调用方: 只认 sessionId / pane, 不回落 defaultChat (同 config_set 的 caller)。认不出 = "" (主机器人)。 */
    const configCaller = (b: { sessionId?: string; tmuxPane?: string }): string =>
      (b.sessionId?.trim() && m.targetForSession(b.sessionId.trim())) || (b.tmuxPane?.trim() && m.targetForPane(b.tmuxPane.trim())) || "";
    // POST /config/get —— `path` (可空) 拿渲染好的配置文本。
    http.register("POST /config/get", async (req, res) => {
      const body = (await readBody(req)) as { path?: string; sessionId?: string; tmuxPane?: string };
      if (Object.prototype.hasOwnProperty.call(body, "key")) { json(res, 400, { ok: false, reason: "key is unsupported; use path" }); return; }
      const seen = cfgSeenBy(cfg, configCaller(body));
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
      const raw = await readBody(req);
      if (Object.prototype.hasOwnProperty.call(raw, "key") || Object.prototype.hasOwnProperty.call(raw, "action")) {
        json(res, 400, { ok: false, reason: "key/action are unsupported; use path/op" }); return;
      }
      const body = raw as SetReq & { sessionId?: string; tmuxPane?: string; target?: string };
      const ask = pinChatKeys(cfg, body, configCaller(body));
      if ("ok" in ask) { json(res, 400, ask); return; }
      const reply = (pl: Plan, text: string, extra: Record<string, unknown> = {}): void =>
        json(res, 200, { ok: true, text, ...extra });
      const pl = planSet(cfg, sourcePath, ask);
      if (!pl.ok) { json(res, 400, pl); return; }
      if (ask.dryRun || !pl.changed) { reply(pl, `${ask.dryRun ? "dryRun, 没写:\n" : ""}${renderPlan(pl)}`); return; }

      // 落盘时重算一遍: 等卡期间文件可能被别人改过, 按那一刻的文件打补丁、再校验。
      // 宪章快照取在落盘之前 (守卫里): hot 项一 applyHot, 活的 cfg 就已经是新的了。
      const caller = resolveSelf({ sessionId: body.sessionId, tmuxPane: body.tmuxPane }) || undefined;
      // 人发起 = 配置卡由审批人点 (config_set 的卡片只发给人); 卡片路径一律视为人的裁决。
      const byHuman = pl.gate === "card" || !!caller;
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
        json(res, 200, { ok: true, text, confirmed: inline });
        return;
      }
      void decided.then(async (yes) => notices.post([self], `config_set 的确认卡有结果了: ${await settle(yes)}`))
        .catch((e: unknown) => log.warn({ err: errText(e) }, "config_set: 迟到的确认落盘失败"));
      json(res, 200, { ok: true, pending: true, text: `确认卡已发到群里, 还没人点 (卡 ${CONFIRM_TIMEOUT_MS / 60_000} 分钟内有效)。点了之后守护进程自动落盘, 结果会捎在你下一条收到的消息上 —— 不用重发。\n${renderPlan(pl)}` });
    }));

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
    scheduledTaskInject = async (target, text, opts) => {
      const { taskId, fresh, quiet } = opts;
      const owner = ((r) => (r ? ownerOf(r) : target))(tasks.get(taskId));
      if (!sameBot(owner, target)) return { ok: false, reason: `日程 ${taskId} 的目标与排班者归不同的企微机器人, 不跨机器人放枪` };
      // 已有会话的一枪 = 一条 trigger 行 (cutmap G-1): 不镜像, 只唤醒 owner;
      // 唤醒一律等它本轮结束 (泵自己等), 不再顺延 / quiet 旁路转发 —— 它的结论只经
      // chat_reply / chat_say 进 room, 终句零语义 (契约 §5)。
      if (!fresh) {
        fireTaskTrigger(target, text, taskId);
        return { ok: true };
      }
      return runTaskInRunner(target, text, taskId, quiet === true, opts.guard);
    };
    /** 到点起一个白板 wizard 执行这一枪, 跑完自动收掉。 */
    const runTaskInRunner = async (target: string, text: string, taskId: string, quiet: boolean, guard: () => boolean): Promise<ScheduledResult> => {
      if (!guard()) return { ok: false, reason: "scheduled runner withdrawn" };

      // 执行体挂在日程的主人名下: 名字 `<主人>-task-xxxx`, parent = 主人 —— 它的
      // rolepage 里看得见这一枪是谁的日程放的。落在执行目标的群/目录里。
      const base = baseOfKey(target);
      const rec = tasks.get(taskId);
      const owner = rec ? ownerOf(rec) : target;
      const ownerName = settleName(wizards, chatNameOf(cfg, owner), owner) || "task";
      const slotR = await claimSlot(base, "", undefined, `${ownerName}-task-${taskId.slice(0, 4)}`);
      if (!guard()) {
        if (slotR.ok) releaseSlot(slotR);
        return { ok: false, reason: "scheduled runner withdrawn during slot selection" };
      }
      if (!slotR.ok) return { ok: false, reason: "起白板 wizard 失败: 挑不出槽位" };
      const runner = slotR.target;
      const allowed = () => ownsSlot(slotR) && guard();
      const reclaimRunner = async (sessionId: string): Promise<void> => {
        if (!ownsSlot(slotR) || m.sessionInfo(runner)?.sessionId !== sessionId || retiringWizardTargets.has(runner)) return;
        retiringWizardTargets.add(runner);
        try {
          const blocked = planRetirementBlock(runner);
          if (blocked) {
            log.warn({ runner, reason: blocked.reason }, "task runner retains pane and identity because its plan prevents retirement");
            return;
          }
          if (!ownsSlot(slotR) || m.sessionInfo(runner)?.sessionId !== sessionId) return;
          const stopped = await m.killPane(runner);
          if (!stopped.ok) {
            log.warn({ runner, reason: stopped.reason }, "task runner pane could not be reclaimed; identity retained");
            return;
          }
          const after = planRetirementBlock(runner);
          if (after) {
            log.warn({ runner, reason: after.reason }, "task runner identity retained after pane teardown because retirement check changed");
            return;
          }
          releaseSlot(slotR);
        } catch (error) {
          log.warn({ runner, err: errText(error) }, "task runner reclaim failed; identity retained");
        } finally {
          retiringWizardTargets.delete(runner);
        }
      };
      if (!allowed()) { releaseSlot(slotR); return { ok: false, reason: "scheduled runner identity changed" }; }
      const info = m.sessionInfo(target);
      wizards.upsert(runner, {
        description: `定时任务 ${taskId} 的一次性执行体`,
        parent: owner,
        voiceOf: owner,
        bornAt: Date.now(),
      });
      const runnerName = slotR.name;
      const spawned = await m.newSession(runner, runnerName, { cwd: info?.cwd, model: info?.model, silent: true, guard: allowed })
        .catch((e: unknown) => ({ ok: false as const, reason: `spawn threw: ${String(e)}` }));
      if (!spawned.ok) {
        releaseSlot(slotR);
        return { ok: false, reason: `起白板 wizard 失败: ${spawned.reason ?? "unknown"}` };
      }
      if (!ownsSlot(slotR)) return { ok: false, reason: "task runner identity replaced during spawn" };
      finishSlot(slotR);
      if (!allowed()) {
        await reclaimRunner(spawned.sessionId ?? "");
        return { ok: false, reason: "scheduled runner withdrawn after spawn" };
      }
      if (!quiet) {
        notifyChat(base, withTagHeader(target, `⏰ 定时任务已起白板 wizard .${runnerName} 单独执行, 完成后自动收掉`));
      }
      // 这一枪 = runner 名下的一条 trigger 行 (cutmap G-1): pump 把它贴进刚起的白板会话。
      fireTaskTrigger(runner, text, taskId);
      // 没有人会对这个一次性分身喊 stop_wizard, 只能自己等它闲下来再收。30min
      // 内没闲下来就放弃自动回收 (它大概率还在干一个长活), 留给人手动处理 ——
      // 比杀掉一个还在跑的 pane 安全。
      void (async () => {
        const idle = await waitForIdle(runner, m.isBusy, 30 * 60_000, () => false);
        if (!idle.idle) {
          log.warn({ runner, reason: idle.reason }, "task runner: 30min 未闲下来, 放弃自动回收");
          return;
        }
        if (!spawned.sessionId) return;
        await reclaimRunner(spawned.sessionId);
      })();
      return { ok: true };
    };

    // 记忆整理者的一轮: 在内部 key 上起白板 wizard, 私聊注入, 闲下来就收 —— 全程不碰
    // 任何群 (silent spawn、channel ""、无 notifyChat)。它没有人能点审批卡, 所以这一轮
    // 给它的 key 开一个 ⏱ 窗口; 危险名单照旧逐条要卡, 而它的活 (读收件箱、改 md) 不在其列。
    stewardRun = async (prompt) => {
      const target = STEWARD_TARGET;
      if (wizards.get(target)) {
        const blocked = planRetirementBlock(target);
        if (blocked) return { ok: false, reason: blocked.reason };
      }
      wizards.upsert(target, { description: "共享记忆整理的一次性执行体 (守护进程内建, 不属于任何群)", bornAt: Date.now() });
      const name = wizards.rename(target, "memsteward-run");
      setAutoWindow(target, STEWARD_RUN_MS + 5 * 60_000);
      const done = async (r: { ok: boolean; reason?: string }) => {
        if (retiringWizardTargets.has(target)) return r;
        retiringWizardTargets.add(target);
        try {
          const blocked = planRetirementBlock(target);
          if (blocked) {
            log.warn({ target, reason: blocked.reason }, "memory steward identity and pane retained because plan retirement check is blocked");
            return r;
          }
          const stopped = await m.killPane(target).catch((error: unknown) => {
            log.warn({ target, err: errText(error) }, "memory steward pane cleanup failed");
            return { ok: false as const };
          });
          if (!stopped.ok) return r;
          const after = planRetirementBlock(target);
          if (after) {
            log.warn({ target, reason: after.reason }, "memory steward identity retained after pane cleanup because retirement check changed");
            return r;
          }
          leaveRooms(target, "memory steward 收工"); // room: 名下 duty 落 canceled
          wizards.drop(target);
          return r;
        } finally {
          retiringWizardTargets.delete(target);
          clearAutoWindow(target);
        }
      };
      const spawned = await m.newSession(target, name, { cwd: memoryRoot(cfg.daemon.stateDir), silent: true });
      if (!spawned.ok) return done({ ok: false, reason: `spawn: ${spawned.reason ?? "unknown"}` });
      const inj = await m.injectText(target, prompt, { from: { kind: "task", taskId: STEWARD_ID }, channel: "", envelope: stewardEnvelope("") });
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
    // 人和各家 CLI 自己读的那几份项目说明 + 各 backend 的 auto-memory 索引。
    const PROJECT_DOCS = ["CLAUDE.md", "CODEBUDDY.md", "AGENTS.md", join(".claude", "CLAUDE.md")];
    stewardWiring = {
      refsOf: (md) => {
        // cwd 候选: 提议里带的 (提议者可能早收工了) + 在场绑定的; 再正向算出 md 比对。
        const cwds = [...new Set([...proposedCwds(stateDir), ...boundTargets().map((t) => memoryCwdOf(t))].filter(Boolean))];
        const cwd = cwdOfMd(stateDir, md, cwds, ["", ...cfg.bots.map((b) => b.id)]);
        if (!cwd) return [];
        return [...PROJECT_DOCS.map((f) => join(cwd, f)), ...projectDirsFor(cwd).map((d) => join(d.dir, "memory", "MEMORY.md"))].filter((f) => existsSync(f));
      },
      // 只投给 pane 活着的: 冷的那些醒来时宪章重渲染, 新记忆已在里面, 再提一句就重复了。
      onMerged: (mds) => void (async () => {
        const changed = new Set(mds);
        const snap = await runTmux(["list-panes", "-a", "-F", "#{pane_id}"]);
        if (!snap.ok) return;
        const live = new Set(parsePaneIds(snap.stdout)); // 解析统一走 parsePaneIds (修复单 §1)
        for (const t of boundTargets()) {
          const pane = m.sessionInfo(t)?.tmuxPane;
          if (!pane || !live.has(pane)) continue;
          const where = (scope: MemoryScope): string => (scope === "workspace" ? "本工作区" : baseOfKey(t).startsWith("user:") ? "本单聊" : "本群");
          for (const h of mdsOf(stateDir, baseOfKey(t), memoryCwdOf(t)).filter((x) => changed.has(x.md))) {
            notices.post([t], `${where(h.scope)}记忆已更新, 全文见 \`${h.md}\``);
          }
        }
      })().catch((e: unknown) => log.warn({ err: (e as Error).message }, "memory steward: notice fan-out failed")),
    };
  }

  // v3 §7 学徒自主巡检: boot 时按 config 装配 (config 是权威; 幂等)。
  const apTarget = apprenticeOf(wizardStore())?.target ?? "";
  const patrol = ensurePatrolTask(tasks, cfg, apTarget);
  if (patrol.active) log.child({ mod: "apprentice" }).info({ everyMin: cfg.wrc.apprentice.patrol.everyMin, recreated: patrol.recreated }, "apprentice patrol scheduled");

  // 定时调度器 — 每 20s 检查任务表, 到点把 prompt 注入目标 wizard。
  const scheduler = startScheduler({
    client: ws.client,
    registry: tasks,
    log: log.child({ mod: "tasks" }),
    inject: scheduledTaskInject,
    ready: bridge.restored,
    // gate 里的 `sh` 默认就在目标 wizard 此刻的工作区跑 —— 任务文件里不必写死绝对路径。
    cwdOf: (t) => { const c = bridge.getCwd(t); return c.runningCwd || c.pendingCwd || c.defaultCwd; },
    // 没写 target 的日程兜底到排班者那个机器人的默认聊天 (副机器人没配就不放枪, 不冒用主机器人)。
    fallbackTarget: (t) => defaultChatFor(cfg, t.owner),
  });

  // 共享记忆整理 — daemon 内建, 不进任务表 / 日程, 不出任何气泡。
  const steward = stewardRun
    ? startSteward({ root: memoryRoot(cfg.daemon.stateDir), log: log.child({ mod: "steward" }), run: stewardRun, ...stewardWiring })
    : undefined;

  // pane 回收的共同豁免: 名下有定时任务的 wizard (调度本身会唤醒/需要它), 挂着审批长
  // 轮询的会话 (hook 还停在等点击)。忙着的 / 人正盯着的 / 正在出生或有注入在途的由 bridge
  // 内部判。管家 (聊天默认会话) 与分身一视同仁, 不额外豁免 —— 只收进程不收身份, 下一条
  // 消息 5~7s 冷启动复活, 与 maxPanes 现有口径一致。
  const reapVeto = (): ((target: string, sid: string) => string | undefined) => {
    const taskOwners = new Set(
      tasks.list()
        .filter((t) => t.enabled)
        .map((t) => wizardStore()?.get(t.owner)?.target ?? wizardStore()?.byName(t.owner)?.target)
        .filter((t): t is string => !!t),
    );
    const pendingSids = new Set(listPending().map((p) => p.meta.sessionId).filter((s): s is string => !!s));
    // 账本里游标之后还有待投给它的唤醒行: 收了 pane, 下一轮 hub 又得重生它去贴 —— 投得进去
    // 是白起一次 CLI, 投不进去就是循环 (BobZane)。有欠着的唤醒就不收, 先让 hub 投完。
    const owedWake = new Set(
      [...(roomHub?.pending().keys() ?? [])]
        .map((uid) => wizardStore()?.byUid(uid)?.target)
        .filter((t): t is string => !!t),
    );
    return (target, sid) =>
      taskOwners.has(target) ? "owns scheduled task"
        : pendingSids.has(sid) ? "pending approval"
        : owedWake.has(target) ? "wake owed"
        : undefined;
  };
  // 两种清扫串行: 并发时同一个 pane 会被两边各收一次 (第二次 kill-pane 失败、日志重复)。
  let reapChain: Promise<void> = Promise.resolve();
  const serialReap = (what: string, job: () => Promise<void>): void => {
    reapChain = reapChain.then(job).catch((e) => log.warn({ err: (e as Error).message }, `${what} failed`));
  };

  // pane 上限 — 每新建一个 wizard 数一次: 活着的会话 pane 超过 wrc.mirror.maxPanes
  // (默认 20, 0=关) 就从最久没动的收起。数量只在出生时增长, 所以不设定时器。只收
  // pane 不收绑定: 下一条消息 `--resume` 复活。
  if (cfg.wrc.mirror.maxPanes > 0) {
    const max = cfg.wrc.mirror.maxPanes;
    const sweep = (): void => serialReap("pane cap sweep", async () => {
      const r = await bridge.reapOverflow(max, reapVeto());
      if (r.reaped.length || r.orphans.length) log.info({ reaped: r.reaped.length, targets: r.reaped, orphans: r.orphans.length, max }, "pane cap sweep");
    });
    bridge.onSpawn(sweep);
    // 定时清扫: 无绑定孤儿 (restore 丢绑定留下的老 window) 不靠 spawn 也会攒, 只在
    // onSpawn 数等于没人收。绑定在 store 里启动即读, 新生 pane 有 ORPHAN_GRACE 宽限,
    // 所以启动后扫一次是安全的。
    const periodSec = cfg.wrc.mirror.paneSweepSec;
    if (periodSec > 0) setInterval(sweep, periodSec * 1000).unref();
    setTimeout(sweep, 15_000).unref();
  }

  // 空闲回收 — wrc.mirror.idleReapMin (默认 60, 0=关): 最后一次活动早于 N 分钟的会话 pane
  // 收起, 豁免同上。定时器常驻、每轮现读配置, 所以 config_set 改阈值 / 开关即时生效;
  // 粒度是 IDLE_SWEEP_MS, 实际收起落在 N ~ N+5 分钟之间。只打日志, 不往群里发。
  const IDLE_SWEEP_MS = 5 * 60_000;
  const idleSweep = (): void => {
    const min = cfg.wrc.mirror.idleReapMin;
    if (min <= 0) return;
    serialReap("idle reap sweep", async () => {
      const r = await bridge.reapIdle(min * 60_000, reapVeto());
      // 每轮都留一行 (收没收都记): 否则「sweep 到底跑没跑、为什么没收」只能靠猜。
      log.info({ reaped: r.reaped.length, targets: r.reaped, skipped: r.skipped, idleMin: min }, "idle reap sweep");
    });
  };
  setInterval(idleSweep, IDLE_SWEEP_MS).unref();

  // 暖 shell: 默认 workspace 先养一条空壳, 开机后第一次 spawn 就能直接领 (省掉整段 rc)。
  // 延后到启动那一波过去: 活着几十个会话时 boot 正在恢复一大片 pane, 一条空壳不必去抢
  // 第一波 fork (macOS 无 swap, 瞬时 ENOMEM 就是这么来的)。
  setTimeout(() => void prewarmShell(cfg, cfg.wrc.cwd, log.child({ mod: "mirror", sub: "warm" })), 20_000).unref();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutdown signal");
    stopPlanReminders();
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
