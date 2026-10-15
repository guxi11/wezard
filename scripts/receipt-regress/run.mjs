#!/usr/bin/env node
// 回执回归: 改 daemon/router.ts / dispatch.ts / direction.ts / jobs.ts / peers.ts 之后跑一遍。
//
// T11 重写 (T10b 之后): 旧的两个回执模块 (`daemon/receipts.ts` / `daemon/receiver-stack.ts`) 已退役,
// 判定一律改读**路由表** —— `GET /routes` 的 `rows[]` (完整 Route 对象) 取代 `receipts.json`
// 的 `from\u0000to` 槽。行主键就是 event, 一件活一行: `<event, owner, receiver>`。
//   * 「我派给 X 的那一笔」= `owner === X.target && receiver.to === 我` —— 与旧槽 (from\0to) 同义;
//   * 「落定」= `row.outcome !== undefined`; 「还在飞」= status ∈ held/open/need/error;
//   * 递 `after` / `re` / `stop` 一律给**行 id** (T10a 的 `re` 走 router.get、`after` 两者都认),
//     唯独 `/wizard/stop` 的 `turn` 值在旧世界要**件号**、新世界要**行 id** —— 见下面的词汇探测。
//
// 词汇探测 (本脚本跑在 resident daemon 上, 它可能**没 reload**): reload 前是 T10a —— peer 信封写
// `turn="<件号>"`, 注入事件 id 是 `p:<self>:<target>:<turn>:<legs>`; reload 后是 T10b —— 信封写
// `event="<行 id>"`, 注入事件 id 是 `route:<serves>`。两条分支各自断言, 输出里明说探测到哪一套;
// 全仓唯一必须分支的参数是 `/wizard/stop` 的 `turn` 值, 以及信封里「轮次 id」该比哪个属性。
// 需要 reload 才能表达的用例 (reload 落在 answered 与 hand 之间) 标 `pending-reload`, 不计通过。
//
//   node scripts/receipt-regress/run.mjs            # 全部
//   node scripts/receipt-regress/run.mjs chain need # 只跑这几条
//   RR_ALLOW_RELOAD=1 node scripts/receipt-regress/run.mjs reload-answered-hand   # 会真的 reload, 单独跑
//
// 旧版里的两个纯单元用例随模块一起下线: `receipt-timing` (跑 tests/receipt-timing.test.ts, 它 import 的是
// 已删的 daemon/receipts.js —— 那个文件现在也是死代码, 该删) 与一批 `fakeReceipts` 驱动的槽/栈语义用例
// (route-fallback / same-pair / transfer-* / for-owed / legacy-resume / after-unit), 它们表达的是
// receiver-stack 的冻结栈与件号, 目标态里没有对应物; 覆盖由 `router-core` 接手。
//
// 必须在一个 wizard 会话里跑 (要会话 id / TMUX_PANE 认出发起者; 只跑纯 unit 用例时不必)。它先生一个
// mini 档根 `rr-root-<后缀>` (发起者的分身), 每条用例再由根生同档临时分身、直接 POST daemon 驱动
// —— 不经 MCP, 所以不受「本会话的 MCP 进程是旧代码」影响。判定只读守护进程落的账 (routes.jsonl /
// jobs.json) 和会话 transcript 里收到的信封, 不信分身自己说了什么。跑完 (含失败 / Ctrl-C) 把生的
// 分身全部收掉。
//
// 跑前看一眼 `GET /routes` 有没有 `deadlineAt` 已过的在飞行 (T6/T7 探针故意推后, 别动它们);
// 别在 reload 后 30s 内起 —— daemon 的孤儿 pane 清扫在 macOS 上会误杀新生的分身。
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createPaneGuards, GuardPrerequisiteError } from "./pane-guards.mjs";
import { normalizeTask } from "../../dist/shared/task-file.js";
import { loadConfig } from "../../dist/shared/config.js";
import { bindCliBackends, backendForPath } from "../../dist/shared/cli-backends.js";
// 信封 / 属性只用守护进程自己那一份解析器读 —— 契约只有一份 (反转义、LEGACY、`msg` 新旧两形都在里面)。
import { parseEnvelope, parseReminders } from "../../dist/shared/reminder.js";

const { config } = loadConfig();
bindCliBackends({ ...config.wrc, projectsDirOverride: config.wrc.mirror.projectsDir });

const DAEMON = process.env.WEZARD_DAEMON_BASE ?? "http://127.0.0.1:17890";
// 写敏感路由 (/tasks/schedule 等) 要出示口令, 同 MCP / CLI (见 shared/daemon-token.ts)。
const TOKEN = (() => { try { return readFileSync(join(homedir(), ".wezard", "daemon-token"), "utf8").trim(); } catch { return ""; } })();
// routes.jsonl / jobs.json 在 ~/.wezard 下 (WEZARD_STATE_DIR 是 hook 的另一处目录, 不是它)。
const STATE = process.env.RR_STATE_DIR ?? join(homedir(), ".wezard");
const ME = {
  sessionId: process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || process.env.CODEBUDDY_SESSION_ID || "",
  tmuxPane: process.env.TMUX_PANE ?? "",
};
const MAX_KIDS = 7;
const gates = new Set();
// 每次运行的名字后缀: 几个 wizard 可能同时在跑这个脚本 (改 router 的都要跑), 名字全局唯一,
// 不带后缀就互相撞名、甚至收掉对方的分身。用例里写的是逻辑名 (`rr-a`), 在边界上换成真名。
const RUN = randomBytes(2).toString("hex");
const real = (x) => `${x}-${RUN}`; // 根名下同时活着的分身 (cloneMax 默认 8, 留一个余量)
// 伪群: 不在 allowFrom / chats 里的 chat id, 企微拒收。会把私下的话转进 home 群的用例 (quiet 任务
// 有事时) 把分身生在这里, 转发照常走 notifyChat, 只是谁也收不到 —— 回归不打扰真实群里的人。
// 固定不带后缀: daemon 会给无名聊天自动起名写进配置, 固定 id 只占一条。
const SINK_ID = "wezard-receipt-regress-sink";
const SINK = `chat:${SINK_ID}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nonce = () => randomBytes(3).toString("hex");
// 别的 wizard 随时会 reload daemon: 连不上就等它回来 (最多 2 分钟), 回执登记落盘、会续守。只在
// 连接被拒 (请求没送到) 时重试 —— 送到了再断的不重发: spawn / tell 不是幂等的, 重发会生出第二个分身。
const post = async (route, body, tries = 60) => {
  const r = await fetch(DAEMON + route, { method: "POST", headers: { "content-type": "application/json", "x-wezard-token": TOKEN }, body: JSON.stringify(body) })
    .catch((e) => (tries > 1 && e.cause?.code === "ECONNREFUSED" ? undefined : Promise.reject(e)));
  if (!r) return sleep(2000).then(() => post(route, body, tries - 1));
  return r.json().catch(() => ({ ok: false, reason: `HTTP ${r.status}` }));
};
const readJson = (f) => { try { return JSON.parse(readFileSync(join(STATE, f), "utf8")); } catch { return {}; } };
const jobOf = (id) => readJson("jobs.json")[id];

/** `pred()` 为真就返回它的值; 超时返回 undefined。 */
const until = async (pred, ms, every = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) {
    const v = await pred();
    if (v) return v;
  }
  return undefined;
};

// ── 路由表 (§9): 全部判定都从这儿来, 不再有 receipts.json ────────────────
const LIVE = new Set(["held", "open", "need", "error"]);
const settled = (r) => !!r?.outcome;
/** `/routes` 的 rows (已按 at 定序, 新的在后)。 */
const routeRows = async () =>
  (await fetch(`${DAEMON}/routes`).then((r) => r.json()).catch(() => ({}))).rows ?? [];
/** 「`from` 排给 `to` 的那一笔」= 旧的 `slotOf(from, to)` 槽: owner = 领活的人, receiver.to = 交代回给谁。 */
const rowsOfPair = async (from, to) =>
  (await routeRows()).filter((r) => r.owner === to && r.receiver?.kind === "wizard" && r.receiver.to === from);
const rowOf = async (from, to) => (await rowsOfPair(from, to)).at(-1);
const liveRowOf = async (from, to) => (await rowsOfPair(from, to)).filter((r) => LIVE.has(r.status)).at(-1);
/** 刚派出的那一轮对应的行 (表在同一请求里就落了盘, 立刻读得到)。 */
const dispatchRow = async (from, to, at, resp) => {
  const rs = (await rowsOfPair(from, to)).filter((r) => r.at >= at - 5000);
  if (VOCAB?.new && resp?.event) { const hit = rs.find((r) => r.event === resp.event); if (hit) return hit; }
  return rs.at(-1);
};

const jsonlOf = async (target) =>
  (await fetch(`${DAEMON}/mirror/status`).then((r) => r.json()).catch(() => ({}))).mirrors?.find((x) => x.target === target)?.jsonlPath;

const userTexts = (path) => readFileSync(path, "utf8").split("\n").flatMap((line) => {
  try {
    const o = backendForPath(path).normalizeTranscriptLine(JSON.parse(line));
    if (o?.type !== "user" || o.isMeta) return [];
    const c = o.message?.content;
    return typeof c === "string" ? [c] : Array.isArray(c) ? c.filter((x) => x.type === "text").map((x) => x.text) : [];
  } catch { return []; }
});

/** transcript 的 user / assistant 文本行, 带时刻 (codebuddy 是 epoch-ms 数字, claude 是 ISO)。 */
const rawLines = (path) => {
  if (!path) return [];
  try {
    return readFileSync(path, "utf8").split("\n").flatMap((line) => {
      try {
        const raw = JSON.parse(line);
        const o = backendForPath(path).normalizeTranscriptLine(raw);
        if (!o || o.isMeta || !["user", "assistant"].includes(o.type)) return [];
        const c = o.message?.content;
        const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x.type === "text").map((x) => x.text).join("\n") : "";
        const ts = raw.timestamp ?? o.timestamp;
        return text ? [{ role: o.type, text, ms: typeof ts === "number" ? ts : Date.parse(ts ?? "") }] : [];
      } catch { return []; }
    });
  } catch { return []; }
};
/** 注入事件现在的执行 / 暴露态 (`GET /message-events/status`)。 */
const eventOf = async (id) =>
  (await fetch(`${DAEMON}/message-events/status`).then((r) => r.json()).catch(() => ({}))).events?.find((e) => e.id === id);

const attrsIn = (text) => parseReminders(text).map((r) => r.attrs);

/** `target` 的 transcript 里收到的回执信封 (属性 + 正文), 可按发话方收窄。 */
const receiptsIn = async (target, fromName) => {
  const p = await jsonlOf(target);
  if (!p) return [];
  return userTexts(p).flatMap(parseReminders)
    .filter((r) => r.attrs.wezard === "envelope" && r.attrs.receipt === "1" && (!fromName || r.attrs.from === `.${real(fromName)}`));
};
/** 注入事件 id → 它挂的那一行: `route:<行>` / `route:<行>:r<n>` / `route:<行>:resume…` / `rcpt:<行>:<rev>`。 */
const rowOfMsg = (id = "") => id.match(/^(?:route|rcpt):([^:]+)/)?.[1] ?? "";
/** 一句注入挂在哪一行上: 回执 (与 T10b 初期的派活信封) 写在 `event`, T10a 写 `turn`; 现在的派活 /
 *  续问信封都不写, 从注入事件 id (信封 `msg`, 老形状是 message-event 块) 剥出来。 */
const roundOf = (text) => {
  const env = parseEnvelope(text);
  if (!env) return "";
  return env.event || parseReminders(text).filter((r) => r.attrs.wezard === "envelope").at(-1)?.attrs.turn || rowOfMsg(env.eventId);
};
/** 回执信封上这一轮的行 id: 旧世界写 `turn`, 新世界写 `event` —— 两边的值都是路由行 id。 */
const roundId = (r) => r.attrs.event ?? r.attrs.turn ?? "";
/** 等 `n` 份回执落到 `target` 的 transcript 里 (投递是注入, 要等它排到那一轮)。 */
const waitReceipts = async (target, fromName, n = 1, ms = 90_000) =>
  (await until(async () => { const xs = await receiptsIn(target, fromName); return xs.length >= n && xs; }, ms, 2000)) ?? [];

/** 分身 transcript 全文; 还没有 (从没收到过话) = ""。 */
const textOf = async (name) => { try { const p = await jsonlOf(kids.get(name)); return p ? readFileSync(p, "utf8") : ""; } catch { return ""; } };

/** daemon.log 里 `since` 之后满足 `pred` 的那一行 (json)。 */
const logLine = (since, pred) =>
  readFileSync(join(STATE, "daemon.log"), "utf8").split("\n").slice(-4000).flatMap((l) => {
    try { const o = JSON.parse(l); return o.time >= since && pred(o) ? [o] : []; } catch { return []; }
  })[0];

const tmuxPaneOf = (window) =>
  execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_id}\t#{window_name}"], { encoding: "utf8" })
    .split("\n").map((l) => l.split("\t")).find(([, w]) => w === window)?.[0];

// A foreground tool owns the gate until the driver releases it. A session_id is still
// running even when the outer functions.exec cell says "Script completed".
const foregroundGate = () => {
  const dir = mkdtempSync(join(tmpdir(), "receipt-gate-"));
  gates.add(dir);
  const program = join(dir, "wait.py");
  writeFileSync(program, `import pathlib, time
p = pathlib.Path(__file__).parent
(p / "ready").touch()
end = time.monotonic() + 600
while not (p / "release").exists():
    if time.monotonic() >= end:
        (p / "expired").touch()
        raise SystemExit("gate expired")
    time.sleep(0.1)
(p / "exited").touch()
print("GATE_RELEASED")
`);
  const quote = (x) => "'" + x.replaceAll("'", "'\"'\"'") + "'";
  return {
    prompt: `用 shell 工具前台执行 python3 ${quote(program)}，不要 run_in_background。若返回 session_id，必须继续 write_stdin 等到 exit_code；外层 Script completed 不代表子进程退出。只有看到 GATE_RELEASED 才能结束这一轮。期间插话也不许提前收口。`,
    ready: () => existsSync(join(dir, "ready")),
    intact: () => existsSync(join(dir, "ready")) && !existsSync(join(dir, "exited")) && !existsSync(join(dir, "expired")),
    release: () => writeFileSync(join(dir, "release"), ""),
  };
};

// ── 根与分身 ──────────────────────────────────────────────────────────
let root; // { target, name, model }
const kids = new Map(); // name → target
let shuttingDown = false;
const paneGuards = createPaneGuards({
  post, run: RUN,
  log: (event) => console.log(`[guard] ${JSON.stringify(event)}`),
  alive: async (_target, name) => !!(tmuxPaneOf(name) || tmuxPaneOf(`.${name}`)),
  inspect: async (file) => {
    if (!existsSync(file)) return undefined;
    const mod = await import(`${pathToFileURL(file).href}?check=${nonce()}`);
    const r = normalizeTask(mod.default, "guard", file);
    if (!r.ok) throw new GuardPrerequisiteError(`保活任务无法读取: ${file}: ${r.reason}`);
    return r.task;
  },
  remove: (file) => rmSync(file, { force: true }),
});
const SLEEP = (sec) => `先用你的 shell 工具 **前台**执行 \`python3 -c "import time; time.sleep(${sec})"\`, 必须等待进程退出再回复 (不要 run_in_background, 不要用 sleep 命令)`;
const TELL = (name, text, extra = "") =>
  `用 wezard 的 tell_peer 工具 (若工具未加载, 使用你可用的工具发现机制加载) 发给 name "${real(name)}"${extra}, text 原样是下面 <<< >>> 之间的内容:\n<<<\n${text}\n>>>`;

// 生分身串行: 同一 cwd 里同时起几个会话, daemon 认新 sid 时会认错 (「sessionId … already bound」)。
let spawning = Promise.resolve();
const spawnOnce = async (name, extra) => {
  const r = await post("/wizard/clone", { target: root.target, name: real(name), inherit: false, tier: "mini", description: "receipt-regress 临时分身", ...extra });
  if (r.ok) {
    kids.set(name, r.target);
    await paneGuards.protect(r.target, r.name ?? real(name));
  }
  return r;
};
const spawn = (name, extra = {}) => {
  const run = spawning.then(async () => {
    if (shuttingDown) throw new GuardPrerequisiteError("保护前提不成立: 正在清理，不再 spawn");
    await paneGuards.assertAll();
    const r = await spawnOnce(name, extra);
    const ok = r.ok ? r : /already bound/.test(r.reason ?? "") ? await spawnOnce(name, extra) : r;
    if (!ok.ok) throw new Error(`spawn ${name}: ${ok.reason}`);
    await paneGuards.assertAll();
    return ok.target;
  });
  spawning = run.catch(() => undefined);
  return run;
};
const stop = async (name) => {
  if (!kids.has(name)) return;
  try { await paneGuards.release(kids.get(name)); }
  finally {
    const r = await post("/wizard/stop", { target: root.target, name: real(name), mode: "end", forget: true });
    if (r.ok) kids.delete(name);
    else throw new Error(`stop ${name}: ${r.reason}`);
  }
};
const tell = (to, text, extra = {}) => post("/peers/tell", { target: root.target, name: real(to), text, priority: "now", ...extra });
/** 派一件活, 连 `at` 一起带回来 (定位它的路由行要这个下界)。 */
const tellAt = async (to, text, extra = {}) => {
  const at = Date.now();
  return { ...(await tell(to, text, extra)), at };
};
/** 根派给 `to` 那一笔的行 (tell 之后立刻读; 不用等)。 */
const tellRow = async (to, r) => dispatchRow(root.target, kids.get(to), r.at, r);
/** 根 → `to` 那一份落定 (settled) 为止。 */
const settledRow = (to, ms) => until(async () => { const r = await rowOf(root.target, kids.get(to)); return settled(r) && r; }, ms);

/** 那个 target 落在轮次记录里的每一轮 (同 id 后写覆盖前写): 频道、出处。只读尾巴。 */
const turnsOf = (target) => {
  const p = join(STATE, "state", "details.jsonl");
  const raw = readFileSync(p, "utf8");
  const rows = raw.slice(Math.max(0, raw.length - 16 * 1024 * 1024)).split("\n").flatMap((l) => {
    if (!l.includes('"kind":"turn"') || !l.includes(target)) return [];
    try { const o = JSON.parse(l); return o.kind === "turn" && o.target === target ? [o] : []; } catch { return []; }
  });
  return [...rows.reduce((m, o) => m.set(o.id, { ...(m.get(o.id) ?? {}), ...o }), new Map()).values()];
};

// ── 词汇探测: 旧世界 (resident 没 reload) 还是新世界 (T10b) ────────────────
// 判据取自**目标会话里那句注入的 peer 信封**: 写 `turn=` = 旧世界; 否则 (写 `event=`, 或注入事件 id
// 是 `route:…`) = 新世界 —— 现在的派活信封不再写 event, 只剩 msg / message-event 上的 `route:` 认得出。
// 拿不到样例 (root 还没收到过话) 时退回 tell 响应的字段名, 再退不回就按新世界走并说明。
let VOCAB;
const probeVocab = async (hint) => {
  if (VOCAB) return VOCAB;
  const p = root ? await jsonlOf(root.target) : undefined;
  const envs = p ? userTexts(p).flatMap((t) => {
    const a = attrsIn(t).filter((x) => x.wezard === "envelope").at(-1);
    return a && a.kind === "peer" && a.receipt !== "1" ? [{ ...a, msg: parseEnvelope(t)?.eventId }] : [];
  }) : [];
  const last = envs.at(-1);
  const fromEnv = last ? (last.turn !== undefined ? "turn" : last.event !== undefined || last.msg?.startsWith("route:") ? "event" : undefined) : undefined;
  const attr = fromEnv ?? (hint?.event !== undefined ? "event" : "turn");
  VOCAB = { attr, new: attr === "event", sample: last?.[attr] ?? last?.msg ?? hint?.[attr] ?? "", samples: envs.length, src: fromEnv ? "transcript" : "tell 响应" };
  console.log(`[vocab] ${VOCAB.new ? "T10b 新世界" : "T10a 旧世界 (resident 未 reload)"} · 轮次 id 属性=${attr} · 据=${VOCAB.src} · 样例=${VOCAB.sample} · peer 信封 ${VOCAB.samples} 份`);
  return VOCAB;
};
/** 一轮的**对外的句柄**: 旧世界 = 件号 (`t...`, 回执登记 / `after` / 信封 turn 都认它),
 *  新世界 = 行 id (T10b 里件号那套桥全退役)。`after` / `/wizard/stop` 的 `turn` / 信封属性
 *  三处都比它 —— 只有 `re` 例外: 两套世界都按行 id 认 (`router.get(re)`)。 */
const handleOf = (resp, row) => (VOCAB?.new ? (row?.event ?? resp?.event ?? "") : (resp?.turn ?? ""));

// ── 纯 unit: 路由表核心 (不发分身、不碰群) ──────────────────────────────
// 覆盖 T11 要求的可离线表达的场景: 扇出全回/部分失败、同一对并发两件、W 欠三笔交错、
// 同笔回执合并、NEED 往返、transfer 两连跳 + 叶子 NEED 直达、RESULT 提前收口后 late、
// stop 中层级联、receiver 被 stop 后升级、撕裂尾行、失败合成与期限夹取。
const routerCore = async () => {
  const R = await import(new URL("../../dist/daemon/router.js", import.meta.url).href);
  const { step, ops, EMPTY, foldJournal } = R;
  const fails = [];
  let n = 0;
  const ok = (c, why) => { n++; if (!c) fails.push(why); };
  const add = (t, ...xs) => xs.reduce(step, t);
  const T0 = 1_700_000_000_000;
  const DL = T0 + 3_600_000;
  const chat = { kind: "chat", channel: "chat:G", message: "m1" };
  const wiz = (to, event) => (event ? { kind: "wizard", to, event } : { kind: "wizard", to });
  const open = (event, owner, receiver, at, extra = {}) => ops.open({ event, owner, receiver, at, deadlineAt: DL, ...extra });

  // ── 1 扇出: 全回 / 部分失败 / 提前收口后 late ──
  {
    const rootE = "e1";
    let t = T0 && add(EMPTY, open(rootE, "me", chat, T0));
    t = add(t, open("e1.1", "a", wiz("me", rootE), T0 + 1), open("e1.2", "b", wiz("me", rootE), T0 + 2), open("e1.3", "c", wiz("me", rootE), T0 + 3));
    ok(R.waiting(t, rootE).length === 3, "扇出三件 → waiting(e1)=3");
    ok(R.finalKind(t, rootE, "已派") === "progress", "子行未落定、无标记 → 终句算进展 (不落定)");
    ok(R.onFinal(t, "me", rootE, { text: "已派" }).length === 0, "进展不产 op");
    ok(R.onFinal(t, "me", rootE, { text: "RESULT: premature" }).length === 1, "显式 RESULT 不等子行, 立刻收口");
    t = add(t, ops.answer({ at: T0 + 4, event: rootE, outcome: R.makeOutcome("done", "RESULT: premature") }));
    ok(R.isOrphaned(t, rootE) === true, "根行已定论 → 之后交差的子行是孤儿 (标 late)");
    t = add(t,
      ops.answer({ at: T0 + 5, event: "e1.1", outcome: R.makeOutcome("done", "RESULT: a") }),
      ops.answer({ at: T0 + 6, event: "e1.2", outcome: R.makeOutcome("timeout", "（守护进程: .b 没有给出结论 —— 等了 60 分钟它还没答完。）") }));
    ok(R.settledTo(t, "me").length === 2, "已交回 me 两份 (a done + b 部分失败 timeout)");
    ok(R.waiting(t, rootE).length === 3 && t["e1.3"].status === "open" && R.owedBy(t, "c")[0].event === "e1.3", "c 还在飞; a/b 落定但没入箱, 仍挡着父行的终句");
    t = add(t, ops.answer({ at: T0 + 7, event: "e1.3", outcome: R.makeOutcome("done", "RESULT: c"), late: true }));
    ok(t["e1.3"].late === true, "迟到的结论标 late");
  }

  // ── 2 同一对并发两件: 互不顶掉 ──
  {
    let t = add(EMPTY, open("f1", "me", chat, T0), open("f1.1", "a", wiz("me", "f1"), T0 + 1), open("f1.2", "a", wiz("me", "f1"), T0 + 2));
    t = add(t, ops.answer({ at: T0 + 3, event: "f1.2", outcome: R.makeOutcome("done", "RESULT: two") }));
    ok(t["f1.1"].status === "open" && !t["f1.1"].outcome, "答第二件不顶掉第一件挂着的状态");
    ok(t["f1.2"].outcome.body === "RESULT: two", "第二件自有结论");
    t = add(t, ops.answer({ at: T0 + 4, event: "f1.1", outcome: R.makeOutcome("done", "RESULT: one") }));
    ok(R.settledTo(t, "me").map((r) => r.event).join() === "f1.1,f1.2", "两笔各留各的定论 (按件, 不按对)");
  }

  // ── 3 W 同时欠三笔 (owner = W, 交代各回 x / y / z), 交错回来 ──
  {
    let t = add(EMPTY,
      ops.open({ event: "g1", owner: "W", receiver: wiz("x"), at: T0, deadlineAt: DL }),
      ops.open({ event: "g2", owner: "W", receiver: wiz("y"), at: T0 + 1, deadlineAt: DL }),
      ops.open({ event: "g3", owner: "W", receiver: wiz("z"), at: T0 + 2, deadlineAt: DL }));
    ok(R.owedBy(t, "W").length === 3 && R.awaitedBy(t, "x").length === 1, "W 欠三笔 (欠账与「派出去的」是同一张表的两面)");
    const need = R.onFinal(t, "W", "g1", { text: "NEED: 口令?" });
    ok(need.length === 1 && need[0].op === "mark" && need[0].status === "need", "第一笔反问 → mark need");
    t = add(t, ...need);
    ok(R.owedBy(t, "W").length === 3 && R.settledTo(t, "x")[0].status === "need", "NEED 只是中途态, 债还在、正文也交回 x");
    t = add(t, ops.answer({ at: T0 + 5, event: "g3", outcome: R.makeOutcome("done", "RESULT: z") }));
    ok(R.settledTo(t, "z").length === 1 && R.settledTo(t, "y").length === 0, "z 那笔先落定, 不串到 y");
    t = add(t, ops.mark({ at: T0 + 6, event: "g1", status: "open" }), ops.answer({ at: T0 + 7, event: "g1", outcome: R.makeOutcome("done", "RESULT: x") }));
    t = add(t, ops.answer({ at: T0 + 8, event: "g2", outcome: R.makeOutcome("done", "RESULT: y") }));
    ok(R.settledTo(t, "x")[0].outcome.body === "RESULT: x" && R.settledTo(t, "y")[0].outcome.body === "RESULT: y", "三笔交错各回各家");
    ok(R.owedBy(t, "W").length === 3, "还没入箱 (answered 未 hand) —— 账上仍挂着");
  }

  // ── 4 同笔回执合并 / 落定只写一次 / rev 与内容绑定 ──
  {
    const body = "RESULT: same";
    let t = add(EMPTY, open("h1", "A", wiz("W"), T0));
    t = add(t, ops.answer({ at: T0 + 1, event: "h1", outcome: R.makeOutcome("done", body) }));
    const rev = t["h1"].outcome.rev;
    ok(rev === R.contentRev(body) && rev.length === 12, "rev = sha256(body).slice(0,12)");
    t = add(t, ops.hand({ at: T0 + 2, event: "h1", inbox: `rcpt:h1:${rev}` }));
    const t2 = add(t, ops.hand({ at: T0 + 3, event: "h1", inbox: `rcpt:h1:${rev}` }));
    ok(t2["h1"].status === "handed" && t2["h1"].outcome.body === body, "重复 hand 不改行 (入箱幂等)");
    const t3 = add(t2, ops.answer({ at: T0 + 4, event: "h1", outcome: R.makeOutcome("done", "RESULT: again") }));
    ok(t3["h1"].outcome.body === body, "已 handed 的行不被第二次 answer 改写 (定论写一次)");
    ok(R.contentRev(body) === R.contentRev(body) && R.contentRev(body) !== R.contentRev(body + "!"), "同内容同 rev / 改内容换 rev");
    // 合成失败交差之后 owner 真答 → late 补投一次
    let u = add(EMPTY, open("h2", "A", wiz("W"), T0));
    u = add(u,
      ops.answer({ at: T0 + 1, event: "h2", outcome: R.makeOutcome("timeout", "（守护进程: .A 没有给出结论 —— 等了 1 分钟它还没答完。）") }),
      ops.hand({ at: T0 + 2, event: "h2", inbox: "rcpt:h2:x" }));
    const late = R.onFinal(u, "A", "h2", { text: "RESULT: real" });
    ok(late.length === 1 && late[0].late === true && late[0].outcome.status === "done", "失败交差后 owner 真答 → late 补投");
    const u2 = add(u, ...late, ops.hand({ at: T0 + 4, event: "h2", inbox: "rcpt:h2:y" }));
    ok(u2["h2"].settledAs === "timeout" && u2["h2"].settledAt === late[0].at, "追述推后 settledAt, settledAs 只认第一次");
    ok(R.onFinal(u2, "A", "h2", { text: "又补一句" }).length === 1, "起初是合成失败: 未标记的追述可收多次");
    ok(R.onFinal(u2, "A", "h2", { text: "RESULT: real" }).length === 0, "同内容重放不再产 op");
    // canceled 不收迟答
    let c = add(EMPTY, open("h3", "A", wiz("W"), T0));
    c = add(c,
      ops.answer({ at: T0 + 1, event: "h3", outcome: R.makeOutcome("canceled", "（守护进程: 被收掉了, 这件活没有结论。）") }),
      ops.hand({ at: T0 + 2, event: "h3", inbox: "rcpt:h3:x" }));
    ok(R.onFinal(c, "A", "h3", { text: "RESULT: real" }).length === 0, "被收掉的件收迟答 = 静默丢掉, 不收");
    // 自己答过的 done 不再收第二遍
    let d = add(EMPTY, open("h4", "A", wiz("W"), T0));
    d = add(d, ops.answer({ at: T0 + 1, event: "h4", outcome: R.makeOutcome("done", "RESULT: own") }), ops.hand({ at: T0 + 2, event: "h4", inbox: "rcpt:h4:x" }));
    ok(R.onFinal(d, "A", "h4", { text: "收到" }).length === 0, "自己答过的 done: 未标记的不收");
    const re4 = R.onFinal(d, "A", "h4", { text: "RESULT: again" });
    ok(re4.length === 1 && re4[0].late === true, "自己答过的 done: 显式 RESULT 作为追述收下");
    ok(R.onFinal(d, "B", "h4", { text: "RESULT: again" }).length === 0, "追述只认 owner");
    ok(R.finalReleased(d, "A", "h4", "收到") === false && R.finalReleased(d, "A", "h4", "RESULT: x") === true
      && R.finalReleased(d, "A", "h4", "RESULT: own") === true, "已落定的那一笔: 终句只放追述 (或就是表上那份)");
    ok(R.finalReleased(c, "A", "h3", "RESULT: x") === false, "被收掉的那一笔不放追述");
    // 墓碑回收: 满 TTL + 子树闭合 + 无 held 等它
    const H = R.TOMBSTONE_TTL_MS;
    let g = add(EMPTY, open("g1", "A", chat, T0), open("g1.1", "B", wiz("A", "g1"), T0 + 1), open("g2", "C", wiz("W"), T0 + 2));
    g = add(g,
      ops.answer({ at: T0 + 3, event: "g1.1", outcome: R.makeOutcome("done", "RESULT: b") }), ops.hand({ at: T0 + 3, event: "g1.1", inbox: "x" }),
      ops.answer({ at: T0 + H, event: "g1", outcome: R.makeOutcome("done", "RESULT: a") }), ops.hand({ at: T0 + H, event: "g1", inbox: "y" }),
      ops.answer({ at: T0 + 4, event: "g2", outcome: R.makeOutcome("done", "RESULT: c") }), ops.hand({ at: T0 + 4, event: "g2", inbox: "z" }),
      open("g3", "D", wiz("W"), T0 + 5, { after: ["g2"] }));
    const gone = R.collectable(g, T0 + H + 10);
    ok(gone.has("g1.1") && !gone.has("g1"), "满 TTL 的叶子收, 未满的父留着");
    ok(!gone.has("g2"), "held 行的 after 还引用 → 不收");
    ok(!R.collectable(g, T0 + H - 10).has("g1.1"), "未满 TTL 不收");
    ok(Object.keys(R.collect(g, T0 + 2 * H + 10)).sort().join() === "g2,g3", "父子都满 TTL → 整支回收");
  }

  // ── 5 NEED 往返 (上冒 + re 拉回) ──
  {
    let t = add(EMPTY, open("k1", "A", wiz("W", "k0"), T0));
    const need = R.onFinal(t, "A", "k1", { text: "NEED: 口令?" });
    ok(need.length === 1 && need[0].status === "need", "NEED → mark need");
    t = add(t, ...need);
    ok(t["k1"].status === "need" && R.onFinal(t, "A", "k1", { text: "NEED: 还是口令?" }).length === 0, "同一中途态只报一次 (行状态就是去重记号)");
    t = add(t, ops.mark({ at: T0 + 2, event: "k1", status: "open" })); // `re`
    const fin = R.onFinal(t, "A", "k1", { text: "RESULT: 口令对" });
    ok(fin.length === 1 && fin[0].op === "answer", "re 拉回 open 后再答 → 定论");
    // CLI 报错 = 中途态, 同构
    let e = add(EMPTY, open("k2", "A", wiz("W"), T0));
    const err = R.onFinal(e, "A", "k2", { text: "API Error", error: true });
    ok(err.length === 1 && err[0].status === "error" && !err[0].outcome, "error 是中途态 (不改写定论)");
    e = add(e, ...err);
    ok(R.onFinal(e, "A", "k2", { text: "API Error", error: true }).length === 0, "同一 error 不重复报");
  }

  // ── 6 transfer = move (两连跳) + 叶子 NEED 直达 ──
  {
    let t = add(EMPTY, open("p1", "A", chat, T0));
    t = add(t, ops.move({ at: T0 + 1, event: "p1", owner: "B" }), ops.move({ at: T0 + 2, event: "p1", owner: "C" }));
    ok(t["p1"].owner === "C" && t["p1"].receiver.kind === "chat", "transfer 只改 owner, receiver 边不动");
    ok(R.chain(t, "p1").length === 1, "transfer 两连跳不留中间行 (链上只有自己)");
    ok(R.waiting(t, "p1").length === 0, "transfer 过的行没有子行挂着");
    const nd = R.onFinal(t, "C", "p1", { text: "NEED: 口令?" });
    ok(nd.length === 1 && nd[0].status === "need", "叶子 NEED 直接落原行 (直达发话方)");
    ok(R.onFinal(t, "B", "p1", { text: "RESULT: 旧 owner" }).length === 0, "交出去的那位再答不算数");
  }

  // ── 7 stop 中层级联: 叶子先落 ──
  {
    let t = add(EMPTY, open("q1", "me", chat, T0), open("q1.1", "A", wiz("me", "q1"), T0 + 1), open("q1.1.1", "B", wiz("A", "q1.1"), T0 + 2));
    ok(R.subtree(t, "q1.1").map((r) => r.event).join() === "q1.1.1", "subtree 叶子先出");
    const cs = R.cancelOps(t, ["q1.1"], { at: T0 + 3, reason: () => "被收掉了, 这件活没有结论。" });
    ok(cs.map((o) => o.event).join() === "q1.1.1,q1.1", "级联顺序: 叶子先落, 中层最后");
    ok(cs.every((o) => o.outcome.status === "canceled"), "整支落 canceled");
    ok(!add(t, ...cs)["q1"].outcome, "根行不受波及");
  }

  // ── 8 receiver 被 stop 后升级 ──
  {
    let t = add(EMPTY, open("r1", "me", wiz("up"), T0), open("r1.1", "A", wiz("dead", "r1"), T0 + 1));
    const esc = R.escalate(t, "r1.1", (k) => k !== "dead");
    ok(!!esc && esc.receiver.to === "up" && esc.via.join() === "dead", "收方已不在 → 沿 receiver 边升到上一层 (信封带 via)");
    ok(R.escalate(t, "r1.1", () => true) === undefined, "收方还在 → 原样投 (不升级)");
    let t2 = add(EMPTY, open("s1", "me", chat, T0), open("s1.1", "A", wiz("dead", "s1"), T0 + 1));
    const dl = R.escalate(t2, "s1.1", (k) => k !== "dead");
    ok(!!dl && dl.receiver.kind === "chat" && dl.serves === "", "一路升到群 = Dead Letter");
  }

  // ── 9 撕裂尾行 / 中间坏行 ──
  {
    const good = JSON.stringify(open("z1", "A", wiz("W"), T0));
    const f1 = foldJournal(`${good}\n{"op":"open","event":"z2","owner":"B"`);
    ok(f1.dropped === 1 && Object.keys(f1.table).length === 1 && f1.table.z1, "撕裂的尾行丢掉, 其余 fold 正确");
    let threw = false;
    try { foldJournal(`${good}\n坏行\n${good}`); } catch { threw = true; }
    ok(threw, "中间行坏 → 拒绝启动 (丢表 = 丢回执)");
    ok(foldJournal("")  .table && Object.keys(foldJournal("").table).length === 0, "空日志 fold 成空表");
  }

  // ── 10 失败合成 (sweeper) + 期限夹取 ──
  {
    const t = add(EMPTY, ops.open({ event: "y1", owner: "A", receiver: wiz("W"), at: T0, deadlineAt: T0 + 60_000 }));
    const sig = (o = {}) => ({ now: T0 + 1_000, paneDeadForMs: () => undefined, fruitless: () => 0, nameOf: (w) => `.${w}`, ...o });
    const sw = R.sweepOps(t, sig({ now: T0 + 61_000 }));
    ok(sw.length === 1 && sw[0].outcome.status === "timeout" && /没有给出结论/.test(sw[0].outcome.body), "超期 → 合成 timeout (正文带守护进程说明)");
    const sw2 = R.sweepOps(t, sig({ paneDeadForMs: () => R.DEAD_GRACE_MS }));
    ok(sw2.length === 1 && sw2[0].outcome.status === "dead", "pane 死过宽限 → dead");
    const sw3 = R.sweepOps(t, sig({ fruitless: () => R.MAX_FRUITLESS }));
    ok(sw3.length === 1 && sw3[0].outcome.status === "silent", "停下 N 次没答 → silent");
    ok(R.sweepOps(t, sig()).length === 0, "没到期没死没静默 → 不产 op");
    // held 前置失败 → canceled 且说明哪件
    let h = add(EMPTY, open("u1", "A", wiz("W"), T0), ops.open({ event: "u2", owner: "B", receiver: chat, at: T0 + 1, deadlineAt: DL, after: ["u1"] }));
    ok(h["u2"].status === "held", "带 after 的行先 held (没投给 owner)");
    ok(R.onFinal(h, "B", "u2", { text: "RESULT: 不该收" }).length === 0, "held 的行不收终句");
    h = add(h, ops.answer({ at: T0 + 2, event: "u1", outcome: R.makeOutcome("timeout", "（守护进程: .A 没有给出结论。）") }));
    const sw4 = R.sweepOps(h, sig({ now: T0 + 3 }));
    ok(sw4.length === 1 && sw4[0].event === "u2" && sw4[0].outcome.status === "canceled" && /u1/.test(sw4[0].outcome.body), "前置非 done → held 件 canceled 并说明哪件没投");
    // 前置 done → 不放失败, release 后可投
    let h2 = add(EMPTY, open("v1", "A", wiz("W"), T0), ops.open({ event: "v2", owner: "B", receiver: chat, at: T0 + 1, deadlineAt: DL, after: ["v1"] }));
    h2 = add(h2, ops.answer({ at: T0 + 2, event: "v1", outcome: R.makeOutcome("done", "RESULT: 前置") }));
    ok(R.sweepOps(h2, sig({ now: T0 + 3 })).length === 0, "前置 done → held 件不放失败");
    h2 = add(h2, ops.release({ at: T0 + 3, event: "v2" }));
    ok(h2["v2"].status === "open", "release → held 转 open");
    // 子行期限不超过父行剩余
    const c = add(EMPTY, ops.open({ event: "w1", owner: "A", receiver: chat, at: T0, deadlineAt: T0 + 1_000 }), ops.open({ event: "w1.1", owner: "B", receiver: wiz("A", "w1"), at: T0 + 1, deadlineAt: T0 + 999_000 }));
    ok(c["w1.1"].deadlineAt === T0 + 1_000, "子行期限夹到父行剩余 (不因转手延长)");
    ok(R.deadlineOf(T0, 30) === T0 + 60_000 && R.deadlineOf(T0) === T0 + 3_600_000, "期限默认 1h / 下限 60s");
  }

  // ── 11 派生: chain / speaksToHuman (方向闸读的那两样) ──
  {
    const t = add(EMPTY, open("x1", "W", chat, T0), open("x1.1", "A", wiz("W", "x1"), T0 + 1), open("x1.1.1", "B", wiz("A", "x1.1"), T0 + 2));
    ok(R.chain(t, "x1.1.1").map((r) => r.event).join() === "x1.1.1,x1.1,x1", "chain 沿 receiver 边往上走到 chat");
    ok(R.speaksToHuman(t, "x1") === true && R.speaksToHuman(t, "x1.1") === false, "只有收给群的那一笔对人可见");
    ok(R.routesOf(t, "A").length === 1 && R.allRows(t).length === 3, "routesOf / allRows 现算");
    ok(R.renderRoute(t["x1"]).includes("x1") && R.renderRoute(t["x1"]).includes("chat chat:G"), "renderRoute 给人看的一行");
  }

  return { pass: !fails.length, why: fails.length ? `${fails.length}/${n} 条没过: ${fails.join(" · ")}` : `${n} 条路由表断言全过` };
};

// ── 用例: 每条返回 { pass, why } (跳过返回 { pending, why }) ──────────────
const cases = {
  // 保活任务闸 (pane-guards) 的纯单元 —— 与回执无关, 但同一批守护改动会同撞。
  "receipt-guards": { names: [], unit: true, run: async () => {
    execFileSync("node", ["tests/receipt-guards.test.mjs"], { stdio: "pipe" });
    return { pass: true, why: "保活任务的清理 / 前提门控 全过" };
  } },

  "router-core": { names: [], unit: true, run: routerCore },

  // reminder 的形状契约: 注册表 (只写登记过的属性) / 尾巴顺序 / `msg` 并进信封 / 老形状照认 / rolepage 标签。
  "reminder-shape": { names: [], unit: true, run: async () => {
    const R = await import(new URL("../../dist/shared/reminder.js", import.meta.url).href);
    const P = await import(new URL("../../dist/daemon/peers.js", import.meta.url).href);
    const fails = [];
    const check = (ok, what) => { if (!ok) fails.push(what); };
    const asker = { who: "user:u1", chat: "chat:c1" };
    const blocks = [
      P.renderHumanEnvelope("u1", "群", "chat:c1"),
      P.renderPeerEnvelope(".a", undefined, { asker, re: true, legs: 5, deadline: Date.now(), act: "fyi", quiet: true }),
      P.renderPeerEnvelope(".a", "群", { act: "ask" }),
      P.renderReceiptEnvelope(".b", "群", { job: "j1", done: 2, total: 2 }, "need", "e1.2", { asker, audience: "u1", via: ".c", late: true, retellTo: "群", retold: true, up: true }),
      P.renderTaskEnvelope("t1", { event: "e9" }),
      P.renderStewardHint(),
    ];
    blocks.flatMap(R.parseReminders).forEach((r) => check(R.unregisteredAttrs(r.attrs).length === 0, `未登记属性 ${R.unregisteredAttrs(r.attrs)} @${r.attrs.wezard}`));
    check(!R.parseReminders(blocks[1])[0].attrs.event, "派活信封不该写 event");
    check(R.parseReminders(blocks[3])[0].attrs.event === "e1.2", "回执信封的 event = 路由行 id");
    check(R.renderReminder({ wezard: "roster", mode: "full" }, []).includes("mode") === false, "未登记属性 (mode) 渲染时丢掉");
    // 尾巴顺序: 信封打头, 旁注按 TAIL_ORDER, 表外的 (codebuddy 的块) 垫底。
    const note = (w) => R.renderReminder({ wezard: w }, [w]);
    const foreign = '\n<system-reminder data-role="memory">m</system-reminder>';
    const tail = R.renderTail(note("pending") + foreign, note("roster"), blocks[1], note("mention"), note("hint"), note("lead"), note("after"));
    const order = R.parseReminders(tail).map((r) => r.attrs.wezard ?? r.attrs["data-role"]).join(",");
    check(order === "envelope,hint,lead,after,mention,roster,pending,memory", `尾巴顺序 ${order}`);
    check(R.renderTail("正文", note("roster")) === note("roster"), "renderTail 只收块");
    // msg 并进信封: 取最后一个信封 (正文里引用的老信封不动); 提交见证与 parseEnvelope 都认。
    const quoted = `引用 ${P.renderPeerEnvelope(".old")}\n正文`;
    const injected = R.withMsg(quoted + R.renderTail(blocks[1], note("roster")), "route:e5.1:r2");
    const envs = R.parseReminders(injected).filter((r) => r.attrs.wezard === "envelope");
    check(envs.length === 2 && !envs[0].attrs.msg && envs[1].attrs.msg === "route:e5.1:r2", "msg 落在最后一个信封上");
    check(R.parseEnvelope(injected)?.eventId === "route:e5.1:r2" && R.carriesMsg(injected, "route:e5.1:r2"), "新形状: parseEnvelope / carriesMsg");
    check(!injected.includes('wezard="message-event"'), "有信封就不再挂 message-event 块");
    check(R.withMsg(R.withMsg(blocks[1], "x"), "y").match(/msg="/g)?.length === 1 && R.parseEnvelope(R.withMsg(R.withMsg(blocks[1], "x"), "y"))?.eventId === "y", "withMsg 幂等改写");
    const bare = R.withMsg("没信封", "p:a:b:1:1");
    check(R.carriesMsg(bare, "p:a:b:1:1") && bare.includes('wezard="message-event"'), "没信封: 兜底挂 message-event");
    // 老形状 (投递时信封外挂块) 照认; LEGACY 措辞信封照认。
    const old = "x" + blocks[1] + R.renderReminder({ wezard: "message-event", event: "route:e7" }, []);
    check(R.parseEnvelope(old)?.eventId === "route:e7" && R.carriesMsg(old, "route:e7"), "老形状 message-event");
    const oldRcpt = "x" + '\n<system-reminder wezard="envelope" kind="peer" from=".b" scope="private" event="e7" receipt="1" status="done">\n</system-reminder>\n<system-reminder wezard="receipt-delivery" event="rcpt:e7:r1">\n</system-reminder>';
    check(R.parseEnvelope(oldRcpt)?.eventId === "rcpt:e7:r1", "老形状 receipt-delivery");
    const legacy = "x\n<system-reminder>\n这一轮是 wizard `.z` 发来的**私聊**\n</system-reminder>";
    check(R.parseEnvelope(legacy)?.from === ".z", "LEGACY 措辞信封");
    // 正文里行中提及 `<system-reminder>` 字面量不得吞掉后面的真信封 (e3c34b4.1: 信封被吞 →
    // 轮次绑不回路由行 → RESULT 终句永不落定, sweeper 误判闲置)。
    const mention = R.withMsg(`讨论 <system-reminder> 与 </system-reminder> 这两个 tag\n正文`, "route:e8") + R.renderTail(blocks[1]);
    check(R.parseEnvelope(mention)?.eventId === "route:e8" && R.parseEnvelope(mention)?.from === ".a", "行中字面量不吞信封");
    // rolepage 标签。
    const label = (t) => R.parseReminders(t).map((r) => R.reminderLabel(r).label).join("|");
    check(label(blocks[1]) === "envelope · .a", `标签 ${label(blocks[1])}`);
    check(label(blocks[3]) === "回执 · .b · need", `标签 ${label(blocks[3])}`);
    check(label(note("roster") + foreign + legacy) === "roster|memory|envelope · .z", `标签 ${label(note("roster") + foreign + legacy)}`);
    check(R.reminderLabel(R.parseReminders(bare)[0]).machine === true, "message-event 标成机器块");
    return { pass: fails.length === 0, why: fails.length ? fails.join("; ") : "注册表 / 尾巴顺序 / msg 并进信封 / 老形状 / 标签 全过" };
  } },

  // 回执去向只有四个词; 旧写法 (`chain`/`receipt`/`answer`) 自 T10b 起不再映射 (旧世界仍映射, 见词汇探测)。
  "return-op": { names: [], unit: true, run: async () => {
    const { returnOpOf, RETURN_OPS } = await import(new URL("../../dist/daemon/dispatch.js", import.meta.url).href);
    const four = RETURN_OPS.map((x) => returnOpOf({ return: x }));
    const dflt = returnOpOf({});
    const bad = returnOpOf({ return: "sideways" });
    const legacy = { chain: false, receipt: false, answer: "transfer" };
    const legacyOps = Object.entries(legacy).map(([k, v]) => [k, returnOpOf({ [k]: v })]);
    const pass = four.every((x, i) => x.ok && x.op === RETURN_OPS[i]) && dflt.ok && dflt.op === "self" && !bad.ok;
    return {
      pass,
      why: `四个词=${four.map((x) => x.op).join("/")} · 缺省=${dflt.op} · 坏值=${bad.ok ? "放行" : "400"}`
        + ` · 旧写法 (T10b 起不映射, 旧世界仍映射)=${legacyOps.map(([k, x]) => `${k}→${x.ok ? x.op : "400"}`).join(" ")}`,
    };
  } },

  // 派活方向闸 (direction.ts): 纯单元, 链 / 深度由调用方算好传进来 (旧版从 receipts.ancestorsOf 取)。
  "direction-gate": { names: [], unit: true, run: async () => {
    const { checkDirection } = await import(new URL("../../dist/daemon/direction.js", import.meta.url).href);
    const m = (target, role, outcome) => ({ target, task: "", spawned: false, at: 1, ...(role ? { role } : {}), ...(outcome ? { outcome } : {}) });
    const job = (id, owner, members, parent) => ({ id, base: "c", owner, title: id, members, status: "open", openedAt: 1, ...(parent ? { parent } : {}) });
    const jobs = [job("R", "boss", [m("lead", "lead")]), job("J", "lead", [m("a"), m("b"), m("x", "expert"), m("d", "exec", "done")], "R"), job("K", "lead", [m("c", "exec")], "R")];
    const g = (o) => checkDirection({ self: "lead", target: "a", kind: "task", re: false, jobId: "", jobs, chain: [], nameOf: (t) => `.${t}`, ...o });
    const table = {
      "非 owner 带 job 的 task 拒": !!g({ self: "a", target: "b", jobId: "J" }),
      "owner 带 job 的 task 放行": !g({ jobId: "J" }),
      "成员横向 task 拒": !!g({ self: "a", target: "b" }),
      "成员横向 re 续问放行 (ask 兄弟、兄弟 NEED 回来)": !g({ self: "a", target: "b", re: true }),
      "非 owner 带 job 的 re 仍拒 (规则 1)": !!g({ self: "a", target: "b", jobId: "J", re: true }),
      "越级只数未落定的 exec/lead: 已落定的成员 / 专家不拦": !g({ self: "boss", target: "d" }) && !g({ self: "boss", target: "x" }),
      "成员横向 ask 放行": !g({ self: "a", target: "b", kind: "ask" }),
      "成员横向 fyi 放行": !g({ self: "a", target: "b", kind: "fyi" }),
      "防环: task 拒": !!g({ self: "a", target: "lead", chain: ["lead", "boss"] }),
      "防环: ask 拒": !!g({ self: "a", target: "boss", kind: "ask", chain: ["lead", "boss"] }),
      "防环: fyi 放行": !g({ self: "a", target: "lead", kind: "fyi", chain: ["lead", "boss"] }),
      "链深 ≥3 task 拒 / ask 放行": !!g({ self: "x1", target: "z", chain: ["a", "b", "c"] }) && !g({ self: "x1", target: "z", kind: "ask", chain: ["a", "b", "c"] }),
      "越级: 上级单 owner 直派下层成员拒": !!g({ self: "boss", target: "a" }),
      "越级: re 也拒, 经 lead 派的放行": !!g({ self: "boss", target: "a", re: true }) && !g({ self: "lead", target: "a", re: true }),
      "越级: 只读式 ask 放行": !g({ self: "boss", target: "a", kind: "ask" }),
      "owner 派借来的专家 task 拒 / ask 放行": !!g({ target: "x" }) && !g({ target: "x", kind: "ask" }),
      "已在别单当未落定 exec 的再带 job 领活拒": !!g({ target: "c", jobId: "J" }) && !g({ target: "c", jobId: "K" }),
    };
    const bad = Object.entries(table).filter(([, ok]) => !ok).map(([k]) => k);
    return { pass: !bad.length, why: bad.length ? `没过: ${bad.join(" · ")}` : `${Object.keys(table).length} 条规则都对` };
  } },

  // 链深闸看**实际挂的那一帧**, 不看并集; 防环仍看并集 —— chain / depth 都由调用方算好。
  "direction-depth-for": { names: [], unit: true, run: async () => {
    const { checkDirection } = await import(new URL("../../dist/daemon/direction.js", import.meta.url).href);
    const chain = ["u", "v", "y", "z"]; // 两帧各 2 层, 并集 4
    const depth = ["y", "z"];           // 本轮实际服务那一帧的链深 2
    const g = (target, o = {}) => checkDirection({ self: "a", target, kind: "task", re: false, jobId: "", jobs: [], chain, depth, nameOf: (t) => `.${t}`, ...o });
    const down = g("w"), loop = g("u"), deep = g("w", { depth: undefined });
    return {
      pass: !down && !!loop && !!deep,
      why: `并集链=${chain.join(",")} 链深=${depth.join(",")} · 向下派=${down ? "拦" : "放行"} · 反派 u=${loop ? "拦" : "放行"} · 按并集算深度=${deep ? "拦" : "放行"}`,
    };
  } },

  // 待 reload: 往 routes.jsonl 追一条 answer 行再 reload, 验「answered 未 hand 的件重入箱一次且只一次」。
  // 默认就在名单里, 但不带 RR_ALLOW_RELOAD 时**只报 pending-reload 不 spawn**, 于是它永远出现在
  // 汇总的 SKIP 行上 —— reload 由人按收尾顺序批, 用 RR_ALLOW_RELOAD=1 单独跑才真做。
  "reload-answered-hand": { names: ["rr-rh"], run: async () => {
    if (!process.env.RR_ALLOW_RELOAD) {
      return { pending: "需 reload: 造一条 answered 未 hand 的行 → reload → 验重入箱一次", why: "本轮不 reload (由人批), 用 RR_ALLOW_RELOAD=1 单独跑" };
    }
    const n = nonce();
    await spawn("rr-rh");
    const t0 = Date.now();
    const r = await tellAt("rr-rh", `${SLEEP(300)}, 然后回复一行: RESULT: 绝不会到`);
    const row = await tellRow("rr-rh", r);
    if (!row) return { pass: false, why: "没找到刚开的行" };
    const rev = "t11reload01";
    appendFileSync(join(STATE, "routes.jsonl"), `${JSON.stringify({
      op: "answer", at: Date.now(), event: row.event,
      outcome: { status: "done", body: `RESULT: reload-${n}`, rev },
    })}\n`);
    execFileSync("./cli/wezard.sh", ["reload"], { cwd: new URL("../..", import.meta.url).pathname, stdio: "ignore" });
    const got = await until(async () => { const xs = (await receiptsIn(root.target, "rr-rh")); return xs.length && xs; }, 2 * 60_000, 2000) ?? [];
    await sleep(5000);
    const again = await receiptsIn(root.target, "rr-rh");
    const after = await rowOf(root.target, kids.get("rr-rh"));
    return {
      pass: got.length >= 1 && again.length === got.length && after?.status === "handed",
      why: `reload 后收到 ${got.length} 份 (reload 前后共 ${again.length} 份, 不重投) · 行=${after?.status ?? "查不到"} · 用时 ${Math.round((Date.now() - t0) / 1000)}s`,
    };
  } },

  // ── 依赖 (真 daemon): 根派 A (睡一会儿), B after A、C after B 都停放; A 落定 → B 带着 A 的结论投出,
  // B 落定 → C 带着 B 的; 根各收一份回执。after 递的是**行 id** (两套词汇都认)。 ──────────────
  "after-live": { names: ["rr-a1", "rr-b1", "rr-c1"], run: async () => {
    const n = nonce();
    await Promise.all(["rr-a1", "rr-b1", "rr-c1"].map((x) => spawn(x)));
    await probeVocab();
    const a = await tellAt("rr-a1", `${SLEEP(45)}, 然后回复一行: RESULT: a-${n}`);
    const ra = await tellRow("rr-a1", a);
    if (!ra) return { pass: false, why: `找不到 A 的路由行: tell=${JSON.stringify({ ok: a.ok, turn: a.turn, reason: a.reason })} 行=${JSON.stringify((await rowsOfPair(root.target, kids.get("rr-a1"))).map((r) => [r.event, r.status, r.at]))}` };
    const b = await tellAt("rr-b1", `不要调用任何工具, 直接回复一行: RESULT: b-${n}`, { after: [handleOf(a, ra)] });
    const rb = await tellRow("rr-b1", b);
    if (!rb) return { pass: false, why: `找不到 B 的路由行: tell=${JSON.stringify({ ok: b.ok, turn: b.turn, parked: b.parked, reason: b.reason })} 行=${JSON.stringify((await rowsOfPair(root.target, kids.get("rr-b1"))).map((r) => [r.event, r.status, r.at, r.after]))}` };
    const c = await tellAt("rr-c1", `不要调用任何工具, 直接回复一行: RESULT: c-${n}`, { after: [handleOf(b, rb)] });
    if (!b.parked || !c.parked) return { pass: false, why: `没停放: b=${JSON.stringify(b).slice(0, 140)} c=${JSON.stringify(c).slice(0, 140)}` };
    await sleep(3000);
    const early = (await textOf("rr-b1")).includes(`b-${n}`);
    const sc = await settledRow("rr-c1", 6 * 60_000);
    const sb = await rowOf(root.target, kids.get("rr-b1"));
    const tb = await textOf("rr-b1"), tc = await textOf("rr-c1");
    const gb = await waitReceipts(root.target, "rr-b1"), gc = await waitReceipts(root.target, "rr-c1");
    return {
      pass: !early && settled(sc) && sc.outcome.status === "done" && settled(sb) && sb.outcome.status === "done" && tb.includes(`a-${n}`) && tc.includes(`b-${n}`) && gb.length === 1 && gc.length === 1,
      why: `A 前 B 已被注入=${early} · B=${sb?.outcome?.status} C=${sc?.outcome?.status ?? "未落定"} · B 带 A 结论=${tb.includes(`a-${n}`)} C 带 B 结论=${tc.includes(`b-${n}`)} · 根收到 B ${gb.length} / C ${gc.length} 份`,
    };
  } },

  // 依赖 + reload (真 daemon, solo): B 停放后 reload 整个 daemon, 之后 A 落定 → B 照投、带 A 的结论。
  "after-reload": { names: ["rr-a3", "rr-b3"], solo: true, run: async () => {
    const n = nonce();
    await Promise.all(["rr-a3", "rr-b3"].map((x) => spawn(x)));
    await probeVocab();
    const a = await tellAt("rr-a3", `${SLEEP(50)}, 然后回复一行: RESULT: a-${n}`);
    const ra = await tellRow("rr-a3", a);
    const b = await tellAt("rr-b3", `不要调用任何工具, 直接回复一行: RESULT: b-${n}`, { after: [handleOf(a, ra)] });
    if (!b.parked) return { pass: false, why: `没停放: ${JSON.stringify(b).slice(0, 160)}` };
    execFileSync("./cli/wezard.sh", ["reload"], { cwd: new URL("../..", import.meta.url).pathname, stdio: "ignore" });
    const sb = await settledRow("rr-b3", 6 * 60_000);
    const tb = await textOf("rr-b3");
    return {
      pass: settled(sb) && sb.outcome.status === "done" && tb.includes(`a-${n}`),
      why: `B=${sb?.outcome?.status ?? "未落定"} B 带 A 结论=${tb.includes(`a-${n}`)}`,
    };
  } },

  // 依赖 (真 daemon): 前置超时 → B 从未被注入, 根收到 B 的 canceled 回执。
  "after-fail": { names: ["rr-a2", "rr-b2"], run: async () => {
    const n = nonce();
    await Promise.all(["rr-a2", "rr-b2"].map((x) => spawn(x)));
    await probeVocab();
    const a = await tellAt("rr-a2", `${SLEEP(150)}, 然后回复一行: RESULT: late`, { deadline: 60 });
    const ra = await tellRow("rr-a2", a);
    const b = await tellAt("rr-b2", `回复一行: RESULT: never-${n}`, { after: [handleOf(a, ra)] });
    if (!b.parked) return { pass: false, why: `没停放: ${JSON.stringify(b).slice(0, 160)}` };
    // 不投的那份停放着落盘 (不占 root→B 的位置), 所以按对找它的行。
    const sb = await until(async () => { const x = await rowOf(root.target, kids.get("rr-b2")); return settled(x) && x; }, 4 * 60_000);
    await sleep(3000);
    const injected = (await textOf("rr-b2")).includes(`never-${n}`);
    const gb = await waitReceipts(root.target, "rr-b2");
    return {
      pass: sb?.outcome?.status === "canceled" && !injected && gb.length === 1 && gb[0].attrs.status === "canceled",
      why: `B 行=${sb?.outcome?.status ?? "未落定"} 被注入过=${injected} 根收到 ${gb.map((r) => r.attrs.status).join(",") || "0 份"}`,
    };
  } },

  // graph 的步骤与进度跟着发起那一轮的频道: 根这一轮是私聊 (发起者的 return:none 私聊 / 回执),
  // 节点那一轮就不能进它的 home 群。
  "graph-private": { names: ["rr-gn"], run: async () => {
    const n = nonce();
    const tag = real("rr-gn");
    await spawn("rr-gn"); // Graph reuses this already-protected node.
    const g = await post("/graph/run", { target: root.target, nodes: [{ tag, model: root.model }], steps: [{ to: tag, prompt: `这是回归测试, 不要调用任何工具, 直接回复一行: RESULT: [receipt-regress] graph-${n}` }], rounds: 1, idleTimeoutSec: 180 });
    if (!g.ok) return { pass: false, why: `graph/run: ${g.reason}` };
    kids.set("rr-gn", `${g.base}#${tag}`);
    const run = await until(async () => { const r = await fetch(`${DAEMON}/graph/status?runId=${g.runId}`).then((x) => x.json()).catch(() => ({})); return r.run?.status !== "running" && r.run; }, 4 * 60_000);
    await sleep(5000);
    const pub = turnsOf(kids.get("rr-gn")).filter((t) => t.channel !== "").map((t) => t.channel);
    return {
      pass: run?.status === "done" && run.history?.some((h) => h.reply.includes(`graph-${n}`)) && !pub.length,
      why: `graph=${run?.status ?? "没跑完"} · 进了群的轮 ${pub.join(",") || "无"}`,
    };
  } },

  // 交接时欠着两份 (根的活在跑, rr-s 的一句插进同一轮): 新会话里每份各开一轮、各带各的信封,
  // 两个上游各收到答给自己那件的交代 —— 不是并成一句、两边拿到同一段。
  "handoff-owe": { names: ["rr-h", "rr-s"], run: async () => {
    const n = nonce();
    await Promise.all(["rr-h", "rr-s"].map((x) => spawn(x)));
    await probeVocab();
    const gate = foregroundGate();
    try {
      // Start the blocking tool before either obligation: commentary before the second
      // user envelope would otherwise close the first ask in replyClosedBefore.
      const warm = await tell("rr-h", `${gate.prompt} 退出后只回 ok。`, { return: "none" });
      if (!warm.ok || !await until(gate.ready, 120_000, 250)) return { pass: false, why: "前提没成立: 前台条件闸未启动" };
      const firstAt = Date.now();
      const first = await tell("rr-h", "继续等前台条件闸，不输出文字；这件活交接后再答。", { return: "detach" });
      const secondAt = Date.now();
      const second = await post("/peers/tell", { target: kids.get("rr-s"), name: real("rr-h"), priority: "now", return: "detach", text: "继续等前台条件闸，不输出文字；这件活交接后再答。" });
      if (!first.ok || !second.ok) return { pass: false, why: `前提没成立: 派活失败 ${JSON.stringify([first, second].map((x) => ({ ok: x.ok, reason: x.reason })))}` };
      const r1 = await until(() => dispatchRow(root.target, kids.get("rr-h"), firstAt, first), 10_000, 500);
      const r2 = await until(() => dispatchRow(kids.get("rr-s"), kids.get("rr-h"), secondAt, second), 10_000, 500);
      if (!r1 || !r2) return { pass: false, why: `前提没成立: 找不到那两笔的路由行 (r1=${!!r1} r2=${!!r2} tell=${JSON.stringify([first, second].map((x) => ({ event: x.event, queued: x.queued, delivered: x.delivered })))} 表上 rr-h 的行=${JSON.stringify((await routeRows()).filter((r) => r.owner === kids.get("rr-h")).map((r) => [r.event, r.status, r.at - firstAt, r.receiver?.to]))})` };
      const oldPath = await jsonlOf(kids.get("rr-h"));
      const { replyClosedBefore } = await import("../../dist/daemon/peers.js");
      const asks = [[root.target, `.${root.name}`, handleOf(first, r1), r1], [kids.get("rr-s"), `.${real("rr-s")}`, handleOf(second, r2), r2]];
      // 「已读入」: claude 把运行中吃进的排队消息当场写进 transcript; codebuddy 要等手上这次工具调用
      // 返回才落盘 (闸关着就一直不落) —— 那边以注入事件已提交进输入框 (exposure=submitted) 为准。
      const inBox = async (row) => ["submitted", "consumed"].includes((await eventOf(`route:${row.event}`))?.exposure);
      // 两句同 pane 串行注入, 每句在忙 pane 上要等提交证据 (codebuddy 最长 LATE_LAND_MS 15s 宽限),
      // tmux 慢时一句就十几秒 —— 60s 不够两句都进框 (实测 rr-h-4b09: 第二句 +57s 才贴)。
      const seen = await until(async () => oldPath && (await Promise.all(asks.map(async ([, , ref, row]) =>
        userTexts(oldPath).some((t) => roundOf(t) === ref) || await inBox(row)))).every(Boolean), 180_000, 250);
      const busy = await until(async () => (await post("/peers/peek", { target: root.target, name: real("rr-h"), turns: 1 })).busy, 15_000, 500);
      const t0 = Date.now();
      const now = await routeRows();
      // 没收口 = 行仍在飞、仍欠在 rr-h 头上, 且旧 transcript 里那一轮没被关上 (还没落盘的问话关不上)。
      const owes = await Promise.all(asks.map(async ([, name, handle, row]) => {
        const cur = now.find((x) => x.event === row.event);
        const closed = replyClosedBefore(oldPath, name, row.at, t0, handle);
        return { event: row.event, status: cur?.status, owner: cur?.owner === kids.get("rr-h"), closed: closed ?? (await inBox(row) ? "(未落盘)" : undefined) };
      }));
      const owed = owes.every((x) => LIVE.has(x.status) && x.owner && (x.closed === "" || x.closed === "(未落盘)"));
      if (!seen || !busy || !gate.intact() || !owed) return { pass: false, why: `前提没成立: 必须目标正忙、闸仍关闭、两件已读入且旧 transcript 都未收口 (seen=${!!seen} busy=${!!busy} gate=${gate.intact()} owed=${JSON.stringify(owes)})` };
      const h = await post("/wizard/handoff-self", { target: kids.get("rr-h"), brief: `（receipt-regress 交接测试）你会收到两轮，一轮一个发话方（只看信封 from 属性）。每轮只回复对应的一行 RESULT:。${real("rr-root")} 对应 h-root-${n}；${real("rr-s")} 对应 h-s-${n}。每轮不许提另一个值。不要调用任何工具。` });
      if (!h.ok) return { pass: false, why: `handoff-self: ${h.reason}` };
      gate.release();
      // 交接把两笔欠账各续答一轮: 旧世界由 receipts.transfer 清点 (answered=0 / carried), 新世界走
      // handoff 自己的「欠账续答 (继续)」, 一笔一行。两边都当**前提**核。
      const carried = [`.${real("rr-h")}`];
      const expected = asks.map(([, name]) => name).sort();
      const oldLog = await until(() => logLine(t0, (o) => o.to === `.${real("rr-h")}` && o.msg === "receipt: 交接时转交"), 180_000);
      const newLog = VOCAB.new
        ? await until(() => {
          const lines = readFileSync(join(STATE, "daemon.log"), "utf8").split("\n").slice(-4000).flatMap((l) => { try { const o = JSON.parse(l); return o.time >= t0 && o.msg === "handoff: 欠账续答 (继续)" ? [o] : []; } catch { return []; } });
          return lines.length >= 2 && lines;
        }, 180_000)
        : undefined;
      if (VOCAB.new ? !newLog : (oldLog?.answered !== 0 || JSON.stringify((oldLog?.carried ?? []).slice().sort()) !== JSON.stringify(carried))) {
        return { pass: false, why: `前提没成立: 交接续答计数 (旧 ${JSON.stringify(oldLog && { answered: oldLog.answered, carried: oldLog.carried })} / 新 ${newLog?.length ?? 0} 行)` };
      }
      const both = await until(async () => {
        const rs = await Promise.all(asks.map(([from]) => rowOf(from, kids.get("rr-h"))));
        return rs.every((r, i) => r?.event === asks[i][3].event && settled(r)) && rs;
      }, 5 * 60_000);
      const p = await jsonlOf(kids.get("rr-h"));
      const lines = p ? userTexts(p).filter((l) => l.includes('wezard="envelope"')) : [];
      const separate = p !== oldPath && asks.every(([, name]) => lines.filter((l) => l.includes(`from="${name}"`)).length === 1)
        && !lines.some((l) => asks.every(([, name]) => l.includes(`from="${name}"`)));
      const got = await until(async () => {
        const xs = await Promise.all(asks.map(async ([from, , , row]) => (await receiptsIn(from, "rr-h")).filter((r) => roundId(r) === row.event)));
        return xs.every((rs) => rs.length) && xs;
      }, 60_000) ?? [];
      const [a, b] = both ?? [];
      return {
        pass: !!both && a.at >= t0 && b.at >= t0 && a.outcome?.status === "done" && b.outcome?.status === "done"
          && a.outcome.body.includes(`h-root-${n}`) && !a.outcome.body.includes(`h-s-${n}`)
          && b.outcome.body.includes(`h-s-${n}`) && !b.outcome.body.includes(`h-root-${n}`)
          && separate && got.length === 2 && got.every((rs) => rs.length === 1 && rs[0].attrs.status === "done"),
        why: `交接续答计数=${VOCAB.new ? `${newLog?.length ?? 0} 行` : `answered=${oldLog?.answered} carried=${(oldLog?.carried ?? []).join(",")}`} · 新会话独立信封=${separate} · 根=${a?.outcome?.status ?? "未落定"}:${a?.outcome?.body.slice(0, 60) ?? ""} · rr-s=${b?.outcome?.status ?? "未落定"}:${b?.outcome?.body.slice(0, 60) ?? ""} · 回执数=${got.map((rs) => rs.length).join(",")}`,
      };
    } finally { gate.release(); }
  } },

  // fork 分身 (继承上下文) 的第一轮: 带 task 的是私聊派活, 不带的是开场白 —— 都不是人在群里
  // 问的, 终句不能进分身的 home 群。实测于 .irisfit-coder (10-03 04:33) / .eff-d (10-02 15:09)。
  "clone-private": { names: ["rr-f", "rr-g"], run: async () => {
    const n = nonce();
    await spawn("rr-f", { inherit: true, task: `这是回归测试, 不要调用任何工具, 直接回复一行: RESULT: [receipt-regress] fork-${n}` });
    await spawn("rr-g", { inherit: true });
    const s = await settledRow("rr-f", 3 * 60_000);
    await until(() => turnsOf(kids.get("rr-g")).some((t) => t.closed), 90_000);
    await sleep(5000);
    const pub = ["rr-f", "rr-g"].flatMap((x) => turnsOf(kids.get(x)).filter((t) => t.channel !== "").map((t) => `${x}:${t.channel}`));
    return {
      pass: settled(s) && s.outcome.status === "done" && !pub.length,
      why: `rr-f 回执=${s?.outcome?.status ?? "未落定"} · 进了群的轮 ${pub.join(",") || "无"}`,
    };
  } },

  // 三级 root→a→b→c: c 的结论经 b、a 冒泡回根, 根只收到一份, 内容是真结论而不是「已派」。
  chain: { names: ["rr-a", "rr-b", "rr-c"], run: async () => {
    const n = nonce();
    await Promise.all(["rr-a", "rr-b", "rr-c"].map((x) => spawn(x)));
    await probeVocab();
    const c = `直接回复一行: RESULT: chain-${n}`;
    const b = `${TELL("rr-c", c)}\n发完立刻结束这一轮, 只回「已派」。之后收到 rr-c 的回执, 最后一行原样写它的 RESULT 行。`;
    const a = `${TELL("rr-b", b)}\n发完立刻结束这一轮, 只回「已派」。之后收到 rr-b 的回执, 最后一行原样写它的 RESULT 行。`;
    await tell("rr-a", a);
    const s = await settledRow("rr-a", 8 * 60_000);
    // haiku 偶尔先答「已派」收了这一轮、下一轮才真派 —— 那件活就不挂在根的这件下面, 是分身没照做。
    const ab = await rowOf(kids.get("rr-a"), kids.get("rr-b"));
    const rootedUp = ab?.receiver?.event === (await rowOf(root.target, kids.get("rr-a")))?.event;
    if (s && !s.outcome?.body.includes(`chain-${n}`) && !rootedUp) return { pass: false, why: "rr-a 没在答根的那一轮里派活 (haiku 没照做), 重跑这一条" };
    const got = await waitReceipts(root.target, "rr-a");
    const all = await receiptsIn(root.target);
    return {
      pass: !!s && s.outcome?.status === "done" && s.outcome.body.includes(`chain-${n}`) && got.length === 1,
      why: `行=${s?.outcome?.status ?? "未落定"} 含结论=${!!s?.outcome?.body.includes(`chain-${n}`)} 根收到 ${got.length} 份 (transcript 里回执 ${all.length} 份, 根 jsonl=${!!(await jsonlOf(root.target))})`,
    };
  } },

  // 并发两子: p 同一轮派 q1、q2; 第一份回执轮不外发, 第二份把结论带上去, 根只收一份且含两份结论。
  fanout: { names: ["rr-p", "rr-q1", "rr-q2"], run: async () => {
    const n = nonce();
    await Promise.all(["rr-p", "rr-q1", "rr-q2"].map((x) => spawn(x, x === "rr-p" ? { tier: "standard" } : {})));
    await probeVocab();
    const p = [
      TELL("rr-q1", `直接回复一行: RESULT: q1-${n}`),
      TELL("rr-q2", `直接回复一行: RESULT: q2-${n}`),
      "这是异步回执测试: 每个对象只派一次, 收到回执后绝不重新派活。不要调用 wait_peer / peek_peer, 只等守护进程自动送来回执。两个都发完立刻结束这一轮, 只回「已派」。之后每收到一份回执, 记下它的 RESULT; 两份都到了, 最后一行写 `RESULT: ` 加上两份 RESULT 的内容。",
    ].join("\n\n");
    const t0 = Date.now();
    await tell("rr-p", p);
    const s = await settledRow("rr-p", 8 * 60_000);
    // haiku 偶尔只回「已派」却没真调 tell_peer —— 那是分身没照做, 不是回执的问题, 分开报。
    const sent = (await Promise.all(["rr-q1", "rr-q2"].map((q) => rowOf(kids.get("rr-p"), kids.get(q))))).filter((r) => (r?.at ?? 0) >= t0).length;
    if (sent < 2) return { pass: false, why: `rr-p 只真派出了 ${sent}/2 件 (haiku 没照做), 重跑这一条` };
    const got = await waitReceipts(root.target, "rr-p");
    // 子活偶尔先 NEED 反问一次 (中途回执, 不算定论), 只数定论那两份。
    const atP = [...(await waitReceipts(kids.get("rr-p"), "rr-q1")), ...(await waitReceipts(kids.get("rr-p"), "rr-q2"))].filter((r) => r.attrs.status !== "need");
    // 去向不写进属性 (reminder 不是路由真相): 新世界看路由表 —— 两件子行的 receiver 都挂在 p 那一行上,
    // p 的回执轮才会把结论接着交给根。旧世界仍数信封上的 reply-to。
    const kidRows = await Promise.all(["rr-q1", "rr-q2"].map((q) => rowOf(kids.get("rr-p"), kids.get(q))));
    const routed = VOCAB.new
      ? kidRows.filter((r) => !!s?.event && r?.receiver?.event === s.event).length
      : atP.filter((r) => r.attrs["reply-to"] === `.${root.name}`).length;
    const body = s?.outcome?.body ?? "";
    return {
      pass: settled(s) && s.outcome.status === "done" && body.includes(`q1-${n}`) && body.includes(`q2-${n}`) && got.length === 1 && atP.length === 2 && routed === (VOCAB.new ? 2 : 1),
      why: `行=${s?.outcome?.status ?? "未落定"} 含两份=${body.includes(`q1-${n}`) && body.includes(`q2-${n}`)} 根收到 ${got.length} 份 · p 收到 ${atP.length} 份${VOCAB.new ? ` · 挂在 p 那一行下的子行 ${routed}/2` : `, 带 reply-to 的 ${routed} 份`}`,
    };
  } },

  // wait_peer 同步取走: 回执不再投第二遍 (取走前已投 → delivered:true 且只有那一份)。
  wait: { names: ["rr-x"], run: async () => {
    const n = nonce();
    await spawn("rr-x");
    await tell("rr-x", `${SLEEP(20)}, 然后回复一行: RESULT: wait-${n}`);
    await sleep(6000);
    const w = await post("/peers/wait", { target: root.target, name: real("rr-x"), timeoutSec: 180 });
    await sleep(30_000);
    const got = await waitReceipts(root.target, "rr-x");
    const text = `${w.result ?? ""}${w.lastText ?? ""}`;
    // 两种结局都算对: 取走前那份已排进我方收件箱 → `delivered:true` 且不回正文 (我方只收到那一份);
    // 还没排到 → wait 把正文交给我 (`result`), 撤单后我方收件箱里不该再出现第二份。
    const pass = w.delivered ? got.length === 1 : text.includes(`wait-${n}`) && got.length === 0;
    return {
      pass,
      why: `wait 取到=${text.includes(`wait-${n}`)} delivered=${!!w.delivered} 根收到 ${got.length} 份`,
    };
  } },

  // 长轮: 问话之后那一轮的 transcript 涨过 2MB (大段工具输出), 问话被推出尾巴的读窗 —— 答完了
  // 也要定位得到, 不能报 silent。对方睡着时往它的 jsonl 尾巴追加 2.5MB 解析器不认的填充行来模拟。
  "long-turn": { names: ["rr-l"], run: async () => {
    const n = nonce();
    await spawn("rr-l");
    await tell("rr-l", `${SLEEP(40)}, 然后回复一行: RESULT: long-${n}`);
    await sleep(12_000);
    const p = await jsonlOf(kids.get("rr-l"));
    if (!p) return { pass: false, why: "找不到 rr-l 的 transcript" };
    const pad = "x".repeat(50 * 1024);
    for (let i = 0; i < 50; i++) appendFileSync(p, JSON.stringify({ type: "rr-filler", timestamp: new Date().toISOString(), pad }) + "\n");
    const s = await settledRow("rr-l", 4 * 60_000);
    const got = await waitReceipts(root.target, "rr-l");
    return {
      pass: settled(s) && s.outcome.status === "done" && s.outcome.body.includes(`long-${n}`) && got.length === 1,
      why: `行=${s?.outcome?.status ?? "未落定"} 含结论=${!!s?.outcome?.body.includes(`long-${n}`)} 根收到 ${got.length} 份`,
    };
  } },

  // deadline: 60s 期限, 对方要睡 150s → 落 timeout, 根收到一份 status=timeout。
  deadline: { names: ["rr-y"], run: async () => {
    await spawn("rr-y");
    const t0 = Date.now();
    await tell("rr-y", `${SLEEP(150)}, 然后回复一行: RESULT: late`, { deadline: 60 });
    const s = await settledRow("rr-y", 150_000);
    const got = await waitReceipts(root.target, "rr-y");
    return {
      pass: s?.outcome?.status === "timeout" && got.length === 1 && got[0].attrs.status === "timeout",
      why: `行=${s?.outcome?.status ?? "未落定"} 用时 ${Math.round((Date.now() - t0) / 1000)}s 根收到 ${got.map((r) => r.attrs.status).join(",") || "0 份"}`,
    };
  } },

  // 对方 pane 被直接杀掉 (不经 stop_wizard, 那会落 canceled) → dead。
  dead: { names: ["rr-z"], run: async () => {
    await spawn("rr-z");
    await tell("rr-z", `${SLEEP(120)}, 然后回复一行: RESULT: never`);
    await sleep(10_000);
    const pane = tmuxPaneOf(real("rr-z"));
    if (!pane) return { pass: false, why: "找不到 rr-z 的 tmux pane" };
    await paneGuards.release(kids.get("rr-z")); // Deliberate death is no longer a protected receiver.
    execFileSync("tmux", ["kill-pane", "-t", pane]);
    const t0 = Date.now();
    const s = await settledRow("rr-z", 120_000);
    const got = await waitReceipts(root.target, "rr-z");
    return {
      pass: s?.outcome?.status === "dead" && got.length === 1,
      why: `行=${s?.outcome?.status ?? "未落定"} 杀 pane 后 ${Math.round((Date.now() - t0) / 1000)}s 根收到 ${got.length} 份`,
    };
  } },

  // NEED → re 答复 → done: 中途那份 status=need 且不算定论, 续问沿用**同一行** (两轮都服务它), 终态 done。
  need: { names: ["rr-n", "rr-ns"], run: async () => {
    const n = nonce();
    await Promise.all(["rr-n", "rr-ns"].map((x) => spawn(x)));
    await probeVocab();
    const sender = kids.get("rr-ns");
    const setup = `你是自动测试的被动收件箱 ${n}。所有 NEED 由外部脚本答复；收到 NEED 也只回 ok，不调用工具，不发 tell_peer，不提供口令。现在只回 ok。`;
    const warm = await tell("rr-ns", setup, { return: "none" });
    const ready = warm.ok && await until(() => turnsOf(sender).some((t) => t.closed && t.userQuery?.includes(setup)), 120_000);
    if (!ready) return { pass: false, why: "前提没成立: 被动收件箱未就绪" };
    const send = async (text, extra = {}) => {
      const at = Date.now();
      return { ...(await post("/peers/tell", { target: sender, name: real("rr-n"), text, priority: "now", return: "detach", ...extra })), at };
    };
    const first = await send("这是一次反问测试。现在只回复一行: NEED: 请给我口令（自动测试，由外部脚本答复，收件箱只回 ok，禁止调用工具）。之后收到口令，回复一行: RESULT: need-<口令>");
    if (!first.ok) return { pass: false, why: `tell: ${first.reason}` };
    const row = await dispatchRow(sender, kids.get("rr-n"), first.at, first);
    if (!row) return { pass: false, why: "找不到这一笔的路由行" };
    const asked = await until(async () => (await receiptsIn(sender, "rr-n")).find((r) => r.attrs.status === "need" && roundId(r) === row.event), 180_000);
    if (!asked) return { pass: false, why: `没收到 NEED 回执 (行=${(await rowOf(sender, kids.get("rr-n")))?.outcome?.status ?? "未落定"})` };
    const read = await until(() => turnsOf(sender).some((t) => t.closed && t.from?.receipt && t.from.from === kids.get("rr-n") && (t.from.turn ?? t.from.event) === row.event && t.from.status === "need"), 120_000);
    const mid = await rowOf(sender, kids.get("rr-n"));
    if (!read || mid?.event !== row.event || mid.status !== "need") return { pass: false, why: `前提没成立: NEED 收件轮未结束或状态不对 (status=${mid?.status})` };
    // 续问只沿用原件, 不能带 detach (send 默认带); `re: true` = 续哪一笔由路由表推断 (本轮读的那份 NEED 回执)。
    const re = await send(`口令是 ${n}`, { re: true, return: "self" });
    if (!re.ok) return { pass: false, why: `re: ${re.reason}` };
    const s = await until(async () => { const x = await rowOf(sender, kids.get("rr-n")); return settled(x) && x; }, 180_000);
    const got = (await waitReceipts(sender, "rr-n", 2)).filter((r) => roundId(r) === row.event);
    const path = await jsonlOf(kids.get("rr-n"));
    const ref = handleOf(first, row);
    const fromHere = path ? userTexts(path).filter((t) => t.includes(`from=".${real("rr-ns")}"`)) : [];
    const dispatches = fromHere.filter((t) => roundOf(t) === ref);
    const attrs = fromHere.map((t) => roundOf(t) || "-");
    // 真判据是「续问沿用同一笔」—— 行 id 没变 + 两份回执挂在同一个 roundId 上 (上面已断言)。
    // 信封那层只再核一句: 旧世界这一轮注入了两次 (件号每次新发), 新世界两轮都挂在同一行上
    // (注入事件 `route:<行>` 与 `route:<行>:r2`)。
    const reconf = VOCAB.new ? dispatches.length === 2 : fromHere.length === 2;
    return {
      pass: settled(s) && s.outcome.status === "done" && s.outcome.body.includes(`need-${n}`) && s.event === row.event && got.map((r) => r.attrs.status).join(",") === "need,done" && reconf,
      why: `NEED 前提成立 status=${mid.status} · 终态=${s?.outcome?.status ?? "未落定"} 同一行=${s?.event === row.event} · 注入=${dispatches.length}/${fromHere.length} 轮 (句柄 ${ref}; rr-n 收到的轮次=[${attrs.join(", ")}]) · 信封=${got.map((r) => r.attrs.status).join(",")}`,
    };
  } },

  // 工单 expect=2: 两份回执的信封依次写 1/2、2/2 (complete), 账本两名成员都落 done。
  job: { names: ["rr-j1", "rr-j2"], run: async () => {
    const n = nonce();
    const o = await post("/jobs/open", { target: root.target, title: "[receipt-regress] 工单 expect 计数", expect: 2 });
    if (!o.ok) return { pass: false, why: `open_job: ${o.reason}` };
    await Promise.all(["rr-j1", "rr-j2"].map((x) => spawn(x, { job: o.job, task: `直接回复一行: RESULT: ${x}-${n}` })));
    const done = await until(() => { const j = jobOf(o.job); return j?.members?.length === 2 && j.members.every((mm) => mm.outcome) && j; }, 4 * 60_000);
    const got = await until(async () => { const xs = (await receiptsIn(root.target)).filter((r) => r.attrs.job === o.job); return xs.length >= 2 && xs; }, 60_000) ?? [];
    await post("/jobs/close", { target: root.target, job: o.job, summary: "receipt-regress" });
    const tallies = got.map((r) => `${r.attrs.done}/${r.attrs.total}${r.attrs.complete === "1" ? "✓" : ""}`).sort();
    return {
      pass: !!done && done.members.every((mm) => mm.outcome === "done") && tallies.join(",") === "1/2,2/2✓",
      why: `成员=${done?.members.map((mm) => mm.outcome).join(",") ?? "未落定"} 信封=${tallies.join(",") || "无"}`,
    };
  } },

  // 工单收工之后才到的回执: 信封说明工单已收, 不再催 close_job。
  "job-late": { names: ["rr-j3"], run: async () => {
    const o = await post("/jobs/open", { target: root.target, title: "[receipt-regress] 收工后迟到的回执", expect: 1 });
    if (!o.ok) return { pass: false, why: `open_job: ${o.reason}` };
    await spawn("rr-j3", { job: o.job, task: `${SLEEP(20)}, 然后回复一行: RESULT: late` });
    await post("/jobs/close", { target: root.target, job: o.job, summary: "receipt-regress" });
    const got = await until(async () => (await receiptsIn(root.target, "rr-j3"))[0], 3 * 60_000);
    return {
      pass: !!got && !got.body.includes("全部到齐") && got.body.includes("已经收工"),
      why: got ? `信封含「全部到齐」=${got.body.includes("全部到齐")} 含「已经收工」=${got.body.includes("已经收工")}` : "没收到回执",
    };
  } },

  // return:detach —— a 在答根那一轮里派的旁支活不挂住 a 给根的交代: 根先拿到 a 自己的结论, 且只一份。
  detach: { names: ["rr-e", "rr-d"], run: async () => {
    const n = nonce();
    await Promise.all(["rr-e", "rr-d"].map((x) => spawn(x)));
    await probeVocab();
    await tell("rr-e", `${TELL("rr-d", `${SLEEP(30)}, 然后回复一行: RESULT: side-${n}`, ', 参数 return 设为 "detach"')}\n发完不必等它, 直接回复一行: RESULT: own-${n}。之后收到 rr-d 的回执只回 ok。`);
    const s = await settledRow("rr-e", 3 * 60_000);
    const side = await until(async () => { const x = await rowOf(kids.get("rr-e"), kids.get("rr-d")); return settled(x) && x; }, 3 * 60_000);
    await sleep(30_000);
    const got = await waitReceipts(root.target, "rr-e");
    const detached = side ? side.receiver.event === undefined : false;
    return {
      pass: settled(s) && s.outcome.status === "done" && s.outcome.body.includes(`own-${n}`) && !!side && detached && got.length === 1,
      why: `行=${s?.outcome?.status ?? "未落定"} 是自己的结论=${!!s?.outcome?.body.includes(`own-${n}`)} 旁支 detach=${side ? detached : "未落定"} 根收到 ${got.length} 份`,
    };
  } },

  // 工单验收 (B4 ⑦): 成员第一次交了没有 RESULT 的答复 → 守护进程同件打回一次, 那份不投给根;
  // 第二次照收。根只收到一份, 内容是补了 RESULT 的那次。
  accept: { names: ["rr-v"], run: async () => {
    const n = nonce();
    const t0 = Date.now();
    const o = await post("/jobs/open", { target: root.target, title: "[receipt-regress] 工单验收打回", expect: 1, accept: "result" });
    if (!o.ok) return { pass: false, why: `open_job: ${o.reason}` };
    await spawn("rr-v", { job: o.job, task: `这是回归测试, 不要调用任何工具。第一次只回复「好的」两个字, 不写 RESULT。之后若被要求补收口, 就回复一行: RESULT: accept-${n}` });
    const s = await settledRow("rr-v", 4 * 60_000);
    const got = await waitReceipts(root.target, "rr-v");
    const bounced = await until(() => logLine(t0, (lo) => /不合工单验收/.test(lo.msg ?? "")), 60_000);
    await post("/jobs/close", { target: root.target, job: o.job, summary: "receipt-regress" });
    return {
      pass: settled(s) && s.outcome.status === "done" && s.outcome.body.includes(`accept-${n}`) && got.length === 1 && !!bounced,
      why: `行=${s?.outcome?.status ?? "未落定"} 含补交=${!!s?.outcome?.body.includes(`accept-${n}`)} 打回过=${!!bounced} 根收到 ${got.length} 份`,
    };
  } },

  // 按行撤回 / 不误伤 (B4 ⑧): rr-k 先做根派的活, rr-o 的活排在后面 (normal 等它闲)。
  // 根按件撤回自己那件 → 只停这一轮; rr-k 接着做 rr-o 的活时, 根不带件号的打断被拒、
  // urgent 降成 normal; rr-o 那件最终照常答完。
  "cancel-turn": { names: ["rr-k", "rr-o"], run: async () => {
    const n = nonce();
    await Promise.all(["rr-k", "rr-o"].map((x) => spawn(x)));
    await probeVocab();
    const mineAt = Date.now();
    const mine = await tell("rr-k", `${SLEEP(60)}, 然后回复一行: RESULT: root-${n}`);
    const mineRow = await dispatchRow(root.target, kids.get("rr-k"), mineAt, mine);
    if (!mineRow) return { pass: false, why: "找不到根派给 rr-k 的那一行" };
    await sleep(8000);
    const theirs = post("/peers/tell", { target: kids.get("rr-o"), name: real("rr-k"), priority: "normal", text: `${SLEEP(40)}, 然后回复一行: RESULT: o-${n}` });
    await sleep(3000);
    const byTurn = await post("/wizard/stop", { target: root.target, name: real("rr-k"), mode: "interrupt", turn: handleOf(mine, mineRow) });
    await theirs;
    await sleep(8000);
    const blunt = await post("/wizard/stop", { target: root.target, name: real("rr-k"), mode: "interrupt" });
    const urgent = await tell("rr-k", "直接回复一行: RESULT: ok", { priority: "urgent" });
    const o = await until(async () => { const x = await rowOf(kids.get("rr-o"), kids.get("rr-k")); return settled(x) && x; }, 3 * 60_000);
    const m = await rowOf(root.target, kids.get("rr-k"));
    return {
      pass: byTurn.interrupted === true && blunt.ok === false && /别的|派的活/.test(blunt.reason ?? "") && !!urgent.urgentDowngraded && o?.outcome?.status === "done" && o.outcome.body.includes(`o-${n}`),
      why: `按件撤回 interrupted=${byTurn.interrupted} (值=${VOCAB.new ? mineRow.event : `件号 ${mine.turn}`}) · 不带件号打断=${blunt.ok ? "放行了" : "被拒"} · urgent 降级=${!!urgent.urgentDowngraded} · rr-o 那件=${o?.outcome?.status ?? "未落定"}${o?.outcome?.body.includes(`o-${n}`) ? "(答完)" : ""} · 根最后那件=${m?.outcome?.status ?? (LIVE.has(m?.status) ? "在跑" : "无")}`,
    };
  } },

  // 定时任务 (B4 ⑤): 点名目标到点正忙 → 顺延到它闲下来再投; quiet 任务终句是 QUIET 就不进群,
  // 不是就由守护进程转进「它的 home 群」。两个分身都生在伪群 SINK 里, 转发落在那儿 (企微拒收,
  // daemon.log 记一行 chat notify failed) —— 人所在的真实群里什么也不出现。
  "task-quiet": { names: ["rr-t", "rr-t2"], run: async () => {
    const n = nonce();
    await Promise.all(["rr-t", "rr-t2"].map((x) => spawn(x, { chat: SINK })));
    const t0 = Date.now();
    await tell("rr-t", `${SLEEP(90)}, 然后回复一行: RESULT: busy-done`);
    const mk = (name, id, prompt) => post("/tasks/schedule", { target: root.target, name: real(name), when: "1分钟后", fresh: false, quiet: true, id, prompt });
    const a = await mk("rr-t", `rr-quiet-${n}`, "这一轮没有任何值得报告的事: 不要调用任何工具, 最后一条消息只写 QUIET, 不加引号或其他文字。");
    const b = await mk("rr-t2", `rr-loud-${n}`, `有一件人必须知道的事要报告 (不是 QUIET): 不要调用任何工具, 你的最后一条消息原样写这一行: [receipt-regress] 安静任务有事转发 ${n}`);
    if (!a.ok || !b.ok) return { pass: false, why: `schedule_task: ${a.reason ?? b.reason}` };
    const tq = kids.get("rr-t"), tl = kids.get("rr-t2");
    const quiet = await until(() => logLine(t0, (o) => o.target === tq && /quiet task/.test(o.msg ?? "")), 6 * 60_000, 5000);
    const loud = await until(() => logLine(t0, (o) => o.target === tl && /quiet task/.test(o.msg ?? "")), 60_000, 5000);
    // 顺延 (scheduled-delivery 起不再打「顺延」日志): 读 rr-t 自己的 transcript —— 到点 (排班 +60s) 时
    // 它那句 busy-done 还没说完 = 到点正忙; 任务那句排在 busy-done 之后、且进的就是 rr-t (不是白板
    // runner) = 等到它闲下来才投 (idle) 并投成了 (ok)。
    const lines = rawLines(await jsonlOf(tq));
    const busyAt = lines.findIndex((l) => l.role === "assistant" && l.text.includes("busy-done"));
    const taskAt = lines.findIndex((l) => l.role === "user" && attrsIn(l.text).some((x) => x.wezard === "envelope" && x.kind === "task" && x.from === a.id));
    const postponed = busyAt >= 0 && taskAt >= 0 && { idle: taskAt > busyAt, ok: true, busyAtFire: lines[busyAt].ms > t0 + 60_000 };
    // 转发确实发生了、且只落在伪群: quiet 转发走终句投递 (outbox), 那一份的频道是 SINK (企微拒收 93006)。
    const deliveries = async () => (await fetch(`${DAEMON}/message-events/status`).then((r) => r.json()).catch(() => ({}))).deliveries ?? [];
    const relayed = loud && await until(async () => (await deliveries()).find((d) => d.eventId?.startsWith(`quiet:${tl}:`) && d.channel === SINK && d.body?.includes(n)), 30_000, 2000);
    const quietRelayed = (await deliveries()).some((d) => d.eventId?.startsWith(`quiet:${tq}:`));
    const inSink = [tq, tl].every((t) => t?.startsWith(`${SINK}#`));
    return {
      pass: inSink && !!postponed?.idle && postponed.ok && postponed.busyAtFire && quiet?.quiet === true && loud?.quiet === false && !!relayed && !quietRelayed,
      why: `${inSink ? "" : "分身没生在伪群 · "}顺延=${postponed ? `idle:${postponed.idle} ok:${postponed.ok} 到点正忙:${postponed.busyAtFire}` : "没发生"} · 安静那轮 quiet=${quiet?.quiet ?? "没收口"}${quietRelayed ? " (却被转发了)" : ""} · 有事那轮 quiet=${loud?.quiet ?? "没收口"} · 转发到伪群=${relayed ? "是" : "没看到"}`,
    };
  } },
};

// ── 调度: 按分身数并发, 根名下不超过 MAX_KIDS ────────────────────────────
const pool = (limit) => {
  let used = 0;
  const waiters = [];
  const flush = () => { for (let i = 0; i < waiters.length; ) waiters[i]() ? waiters.splice(i, 1) : i++; };
  return {
    take: (n) => new Promise((ok) => { const go = () => (used + n <= limit ? ((used += n), ok(), true) : false); go() || waiters.push(go); }),
    give: (n) => { used -= n; flush(); },
  };
};

let cleaning;
const cleanup = () => cleaning ??= (async () => {
  shuttingDown = true;
  for (const dir of gates) writeFileSync(join(dir, "release"), "");
  await spawning.catch(() => undefined);
  const errors = [];
  const stopped = await Promise.allSettled([...kids.keys()].map(stop));
  errors.push(...stopped.filter((r) => r.status === "rejected").map((r) => r.reason));
  // Keep root protected until it has finished stopping its children.
  try { await paneGuards.close(); } catch (e) { errors.push(e); }
  for (const dir of gates) rmSync(dir, { recursive: true, force: true });
  gates.clear();
  if (root) {
    const r = await post("/wizard/stop", { ...ME, name: root.name, mode: "end", forget: true });
    if (!r.ok) errors.push(new Error(`stop root: ${r.reason}`));
    rmSync(join(STATE, "memory", "episodes", `${root.name}.jsonl`), { force: true });
  }
  if (errors.length) throw new AggregateError(errors, "receipt-regress cleanup failed");
  console.log("CLEANUP done: 本轮 guards/children/root 已清理");
})();

const main = async () => {
  console.log("typecheck…");
  execFileSync("npm", ["run", "-s", "typecheck"], { stdio: "inherit" });
  // `unit` = 全部纯 unit 用例 (不生分身、不碰 daemon)。
  const pick = process.argv.slice(2).flatMap((x) => (x === "unit" ? Object.keys(cases).filter((k) => cases[k].unit) : [x]));
  const bad = pick.filter((x) => !cases[x]);
  if (bad.length) throw new Error(`没有用例 ${bad.join(" ")} —— 有: ${Object.keys(cases).join(" ")}`);
  // solo: 会 reload 整个 daemon, 与别的用例并跑会弄断它们 —— 默认不跑, 点名才跑 (`run.mjs after-reload`)。
  const chosen = pick.length ? pick : Object.keys(cases).filter((x) => !cases[x].solo);
  // 只跑纯 unit 的不必生根 (它们不碰 daemon)。
  if (chosen.some((x) => !cases[x].unit)) {
    if (!ME.sessionId && !ME.tmuxPane) throw new Error("要在 wizard 会话里跑 (缺会话 id / TMUX_PANE)");
    const birth = spawning.then(async () => {
      const r = await post("/wizard/clone", { ...ME, name: real("rr-root"), inherit: false, tier: "mini", description: "receipt-regress 的根" });
      if (!r.ok) throw new Error(`spawn rr-root: ${r.reason}`);
      root = { target: r.target, name: r.name, model: r.model };
      if (shuttingDown) throw new GuardPrerequisiteError("根创建期间开始清理");
      await paneGuards.protect(root.target, root.name);
    });
    spawning = birth.catch(() => undefined);
    await birth;
    if (shuttingDown) throw new GuardPrerequisiteError("根创建期间开始清理");
    const open = await post("/peers/tell", { ...ME, name: root.name, return: "none", priority: "now", text: "你是回执回归测试的根。之后进来的每一份回执, 只回一个词 ok, 不调用任何工具。现在回 ok。" });
    await probeVocab(open);
    await sleep(20_000);
  }
  const slots = pool(MAX_KIDS);
  const results = await Promise.all(chosen.map(async (name) => {
    const c = cases[name];
    await slots.take(c.names.length);
    const t0 = Date.now();
    const out = await c.run().catch((e) => {
      if (e instanceof GuardPrerequisiteError) throw e;
      return { pass: false, why: `抛错: ${e.message}` };
    });
    const tag = out.pending ? "SKIP" : out.pass ? "PASS" : "FAIL";
    console.log(`${tag} ${name.padEnd(21)} ${Math.round((Date.now() - t0) / 1000)}s · ${out.why}`);
    await Promise.all(c.names.map(stop));
    slots.give(c.names.length);
    return { name, ...out };
  }));
  const failed = results.filter((x) => !x.pending && !x.pass).length;
  const skipped = results.filter((x) => !!x.pending);
  const rootAlive = !root || (!!(await jsonlOf(root.target)) && !!tmuxPaneOf(root.name));
  if (!rootAlive) console.log("FAIL 根 rr-root 中途没了 —— 「根收到 N 份」类判定无效, 重跑");
  console.log(`${results.length - failed - skipped.length}/${results.length - skipped.length} PASS · ${failed}/${results.length - skipped.length} FAIL · ${skipped.length} pending-reload`);
  skipped.forEach((x) => console.log(`  SKIP ${x.name} (${x.pending}): ${x.why}`));
  return rootAlive ? failed : Math.max(1, failed);
};

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) process.on(signal, () => {
  void cleanup().catch((e) => console.error(e)).finally(() => process.exit(code));
});
main()
  .then(async (failed) => { await cleanup(); process.exit(failed ? 1 : 0); })
  .catch(async (e) => { console.error(e); await cleanup().catch((e) => console.error(e)); process.exit(2); });
