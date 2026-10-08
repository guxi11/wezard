#!/usr/bin/env node
// 回执回归: 改 daemon/receipts.ts / jobs.ts / peers.ts 之后跑一遍。
//
//   node scripts/receipt-regress/run.mjs            # 全部
//   node scripts/receipt-regress/run.mjs chain need # 只跑这几条
//
// 必须在一个 wizard 会话里跑 (要 CLAUDE_CODE_SESSION_ID / TMUX_PANE 认出发起者)。它先生一个
// haiku 根 `rr-root-<后缀>` (发起者的分身), 每条用例再由根生 haiku 临时分身、直接 POST daemon 驱动
// —— 不经 MCP, 所以不受「本会话的 MCP 进程是旧代码」影响。判定只读守护进程落的账 (receipts.json /
// jobs.json) 和根的 transcript 里收到的回执信封, 不信分身自己说了什么。跑完 (含失败 / Ctrl-C)
// 把生的分身全部收掉。
//
// 根的开场白是发起者一句 receipt:false 的私聊 —— 它这一轮没有父 k, 测试活的回执只回到根,
// 不会沿发起者手上那件活往上冒。工单用例会在根的 home 聊天里各出一对开 / 收工气泡。
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const DAEMON = process.env.WEZARD_DAEMON_BASE ?? "http://127.0.0.1:17890";
// 写敏感路由 (/tasks/schedule 等) 要出示口令, 同 MCP / CLI (见 shared/daemon-token.ts)。
const TOKEN = (() => { try { return readFileSync(join(homedir(), ".wezard", "daemon-token"), "utf8").trim(); } catch { return ""; } })();
// receipts.json / jobs.json 在 ~/.wezard 下 (WEZARD_STATE_DIR 是 hook 的另一处目录, 不是它)。
const STATE = process.env.RR_STATE_DIR ?? join(homedir(), ".wezard");
const ME = { sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? "", tmuxPane: process.env.TMUX_PANE ?? "" };
const MAX_KIDS = 7;
// 每次运行的名字后缀: 几个 wizard 可能同时在跑这个脚本 (改 receipts 的都要跑), 名字全局唯一,
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
const slotOf = (from, to) => readJson("receipts.json")[`${from}\u0000${to}`];
const jobOf = (id) => readJson("jobs.json")[id];

/** `pred()` 为真就返回它的值; 超时返回 undefined。 */
const until = async (pred, ms, every = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) {
    const v = await pred();
    if (v) return v;
  }
  return undefined;
};

const jsonlOf = async (target) =>
  (await fetch(`${DAEMON}/mirror/status`).then((r) => r.json()).catch(() => ({}))).mirrors?.find((x) => x.target === target)?.jsonlPath;

/** `target` 的 transcript 里收到的回执信封 (属性 + 正文), 可按发话方收窄。 */
const receiptsIn = async (target, fromName) => {
  const p = await jsonlOf(target);
  if (!p) return [];
  const texts = readFileSync(p, "utf8").split("\n").flatMap((l) => {
    try {
      const o = JSON.parse(l);
      if (o.type !== "user") return [];
      const c = o.message?.content;
      return typeof c === "string" ? [c] : Array.isArray(c) ? c.filter((x) => x.type === "text").map((x) => x.text) : [];
    } catch { return []; }
  });
  return texts.flatMap((t) => [...t.matchAll(/<system-reminder ([^>]*)>([\s\S]*?)<\/system-reminder>/g)])
    .map((m) => ({ attrs: Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])), body: m[2] }))
    .filter((r) => r.attrs.wezard === "envelope" && r.attrs.receipt === "1" && (!fromName || r.attrs.from === `.${real(fromName)}`));
};

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

// ── 根与分身 ──────────────────────────────────────────────────────────
let root; // { target, name }
const kids = new Map(); // name → target
const SLEEP = (sec) => `先用 Bash **前台**执行 \`python3 -c "import time; time.sleep(${sec})"\` (不要 run_in_background, 不要用 sleep 命令)`;
const TELL = (name, text, extra = "") =>
  `用 wezard 的 tell_peer 工具 (先 ToolSearch 搜 "tell_peer" 加载) 发给 name "${real(name)}"${extra}, text 原样是下面 <<< >>> 之间的内容:\n<<<\n${text}\n>>>`;

// 生分身串行: 同一 cwd 里同时起几个会话, daemon 认新 sid 时会认错 (「sessionId … already bound」)。
let spawning = Promise.resolve();
const spawnOnce = async (name, extra) => {
  const r = await post("/wizard/clone", { target: root.target, name: real(name), inherit: false, model: "haiku", keepalive: false, description: "receipt-regress 临时分身", ...extra });
  if (r.ok) kids.set(name, r.target);
  return r;
};
const spawn = (name, extra = {}) => {
  const run = spawning.then(async () => {
    const r = await spawnOnce(name, extra);
    const ok = r.ok ? r : /already bound/.test(r.reason ?? "") ? await spawnOnce(name, extra) : r;
    if (!ok.ok) throw new Error(`spawn ${name}: ${ok.reason}`);
    return ok.target;
  });
  spawning = run.catch(() => undefined);
  return run;
};
const stop = async (name) => {
  if (!kids.has(name)) return;
  await post("/wizard/stop", { target: root.target, name: real(name), mode: "end", forget: true });
  kids.delete(name);
};
const tell = (to, text, extra = {}) => post("/peers/tell", { target: root.target, name: real(to), text, priority: "now", ...extra });
/** 根 → `to` 那一份落定 (settled) 为止。 */
const settledSlot = (to, ms) => until(() => { const s = slotOf(root.target, kids.get(to)); return s?.settled && s; }, ms);

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

// ── 纯单元: 直接驱动 dist 里的 createReceipts, 依赖全是假的 —— 不生分身、不碰群 ──
// target 是「忙着」的, 直到给了它这一件的答案; 答案按 (to, 件号) 记, 只认发话之后给的 (同 replyToPeer)。
const fakeReceipts = async (extra = {}) => {
  const { createReceipts } = await import(process.env.RR_RECEIPTS ?? new URL("../../dist/daemon/receipts.js", import.meta.url).href);
  const answers = [];
  const busy = new Set();
  const sent = [];
  const hooks = [];
  const log = { info() {}, warn() {}, debug() {}, child: () => log };
  const r = createReceipts({
    idleNow: async (t) => !busy.has(t),
    untilIdle: async (t, ms, o) => {
      for (const end = Date.now() + ms; busy.has(t) && Date.now() < end && !o?.aborted?.(); ) await sleep(50);
      return { idle: !busy.has(t) };
    },
    paneLive: async () => true,
    replyFor: (to, _from, since, turn) => {
      const a = answers.filter((x) => x.to === to && x.turn === turn && x.at >= since).at(-1);
      return a && { text: a.text };
    },
    deliver: async (to, body, meta) => { sent.push({ to, body, meta }); hooks.forEach((h) => h(to, meta)); return { ok: true }; },
    nameOf: (t) => `.${t}`,
    log,
    ...extra,
  });
  const answer = (to, turn, text) => { answers.push({ to, turn, text, at: Date.now() }); busy.delete(to); };
  const tell = (x) => { busy.add(x.to); return r.register(x); };
  return { r, sent, answer, tell, onDeliver: (h) => hooks.push(h) };
};

// ── 用例: 每条返回 { pass, why } ────────────────────────────────────────
const cases = {
  // 回执轮的频道只由去向定: 续回进群 (chat 父 k, 兄弟落齐) 才有频道, 其余一律私聊 ——
  // 不能因为那件子活是 public:true 派的就沿用它的频道。三种回落: 没有父 k (chain:false)、
  // 中途回执 (NEED)、父 k 指向的上游那一份已不在 (被 wait_peer 取走 / 不要回执)。
  "route-fallback": { names: [], unit: true, run: async () => {
    const f = await fakeReceipts();
    f.tell({ from: "a", to: "b1", channel: "chat:G", turn: "t1" });
    f.tell({ from: "a", to: "b2", channel: "chat:G", turn: "t2", k: { kind: "chat", channel: "chat:G", turn: "1" } });
    f.tell({ from: "a", to: "b3", channel: "chat:G", turn: "t3", k: { kind: "peer", from: "x", turn: "tx" } });
    f.answer("b1", "t1", "RESULT: side");
    f.answer("b2", "t2", "NEED: 口令?");
    f.answer("b3", "t3", "RESULT: orphan");
    await until(() => f.sent.length >= 3, 20_000, 100);
    const leak = f.sent.filter((s) => s.meta.channel !== "");
    // 私聊轮 (频道 "", 例如没挂信封的分身开场白那轮) 派出的活没有 chat 父 k —— 不能回落成 home 群。
    const k = f.r.parentOf("a", undefined, "", "1");
    return {
      pass: f.sent.length === 3 && !leak.length && !k,
      why: `回执 ${f.sent.length}/3 · 带频道的 ${leak.map((s) => `${s.meta.turn}→${s.meta.channel}`).join(",") || "无"} · 私聊轮的父 k=${k ? `${k.kind}:${k.channel}` : "无"}`,
    };
  } },

  // 同一对的第二件活不能顶掉第一件挂起 (等子活) 的那份: x 派 a 件一, a 派 b 后先停下 (挂起);
  // x 又派 a 件二。b 回来时, a 那一轮的终句仍要作为件一的回执回到 x —— 按件号, 不按「这一对最后一件」。
  "same-pair": { names: [], unit: true, run: async () => {
    const f = await fakeReceipts();
    f.onDeliver((to, meta) => { if (to === "a" && meta.turn === "tc") setTimeout(() => f.answer("a", "t1", "RESULT: final-1"), 200); });
    f.tell({ from: "a", to: "b", channel: "", turn: "tc", k: { kind: "peer", from: "x", turn: "t1" } });
    f.tell({ from: "x", to: "a", channel: "", turn: "t1" });
    f.answer("a", "t1", "已派");
    await sleep(500);
    f.tell({ from: "x", to: "a", channel: "", turn: "t2" });
    f.answer("a", "t2", "RESULT: two");
    await until(() => f.sent.some((s) => s.to === "x" && s.meta.turn === "t2"), 10_000, 100);
    f.answer("b", "tc", "RESULT: b");
    const got = await until(() => f.sent.find((s) => s.to === "x" && s.meta.turn === "t1"), 20_000, 100);
    const relay = f.sent.find((s) => s.to === "a" && s.meta.turn === "tc");
    return {
      pass: got?.body === "RESULT: final-1" && relay?.meta.replyTo?.from === "x",
      why: `x 收到 ${f.sent.filter((s) => s.to === "x").map((s) => `${s.meta.turn}:${s.body}`).join(" / ") || "无"} · b 的回执 reply-to=${relay?.meta.replyTo ? `${relay.meta.replyTo.kind}:${relay.meta.replyTo.from ?? relay.meta.replyTo.channel}` : "无"}`,
    };
  } },

  // 同上, 但件二进来时件一还没被认出「已派」(watcher 没读到那句): 它已为件一派了活, 照样停放。
  "same-pair-early": { names: [], unit: true, run: async () => {
    const f = await fakeReceipts();
    f.onDeliver((to, meta) => { if (to === "a" && meta.turn === "tc") setTimeout(() => f.answer("a", "t1", "RESULT: final-1"), 200); });
    f.tell({ from: "a", to: "b", channel: "", turn: "tc", k: { kind: "peer", from: "x", turn: "t1" } });
    f.tell({ from: "x", to: "a", channel: "", turn: "t1" });
    f.tell({ from: "x", to: "a", channel: "", turn: "t2" });
    f.answer("a", "t1", "已派");
    await sleep(500);
    f.answer("a", "t2", "RESULT: two");
    await until(() => f.sent.some((s) => s.to === "x" && s.meta.turn === "t2"), 10_000, 100);
    f.answer("b", "tc", "RESULT: b");
    const got = await until(() => f.sent.find((s) => s.to === "x" && s.meta.turn === "t1"), 20_000, 100);
    return {
      pass: got?.body === "RESULT: final-1",
      why: `x 收到 ${f.sent.filter((s) => s.to === "x").map((s) => `${s.meta.turn}:${s.body}`).join(" / ") || "无"}`,
    };
  } },

  // 派活方向闸 (direction.ts) + k 链取祖先 (receipts.ancestorsOf): 纯单元。
  // 成员横向 task 拒 / ask 放行; 非 owner 带 job 的 task 拒; 防环 task·ask 拒而 fyi 放行; 链深; 越级; 专家; 一人一单。
  "direction-gate": { names: [], unit: true, run: async () => {
    const { checkDirection } = await import(new URL("../../dist/daemon/direction.js", import.meta.url).href);
    const f = await fakeReceipts();
    const m = (target, role, outcome) => ({ target, task: "", spawned: false, at: 1, ...(role ? { role } : {}), ...(outcome ? { outcome } : {}) });
    const job = (id, owner, members, parent) => ({ id, base: "c", owner, title: id, members, status: "open", openedAt: 1, ...(parent ? { parent } : {}) });
    const jobs = [job("R", "boss", [m("lead", "lead")]), job("J", "lead", [m("a"), m("b"), m("x", "expert"), m("d", "exec", "done")], "R"), job("K", "lead", [m("c", "exec")], "R")];
    const g = (o) => checkDirection({ self: "lead", target: "a", kind: "task", re: false, jobId: "", jobs, chain: [], nameOf: (t) => `.${t}`, ...o });
    // k 链: boss → lead → a → b (b 此刻在答 a, a 在答 lead, lead 在答 boss); 槽被同一对新一句顶掉则链截断。
    f.tell({ from: "boss", to: "lead", channel: "", turn: "t1" });
    f.tell({ from: "lead", to: "a", channel: "", turn: "t2", k: { kind: "peer", from: "boss", turn: "t1" } });
    f.tell({ from: "a", to: "b", channel: "", turn: "t3", k: { kind: "peer", from: "lead", turn: "t2" } });
    const chain = f.r.ancestorsOf("b", { kind: "peer", from: "a", turn: "t3" });
    f.tell({ from: "lead", to: "boss", channel: "", turn: "t9", k: { kind: "peer", from: "b", turn: "t3" } }); // 成环的坏数据
    f.r.claim("lead", "a"); // lead→a 那件被 wait_peer 取走: a 已不在答 lead, 链从第二跳截断
    const trunc = f.r.ancestorsOf("b", { kind: "peer", from: "a", turn: "t3" });
    const loop = f.r.ancestorsOf("boss", { kind: "peer", from: "lead", turn: "t1" });
    const cases = {
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
      "ancestorsOf 沿槽走 (精确链)": chain.join() === "a,lead,boss",
      "ancestorsOf 上游已落定则截断": trunc.join() === "a",
      "ancestorsOf 带环保护": loop.length <= 3,
    };
    const bad = Object.entries(cases).filter(([, ok]) => !ok).map(([k]) => k);
    return { pass: !bad.length, why: bad.length ? `没过: ${bad.join(" · ")} (链=${chain.join(">")})` : `${Object.keys(cases).length} 条规则都对` };
  } },

  // 依赖 after (纯单元, 停放 / 放行 / 失败 / reload 都在回执层): 停放不占回执槽、不改 k; 前置落定才放行并带上结论;
  // 前置失败 → 不放行、落成 canceled 回给发话方; 停放登记落盘, 新进程接着判; 同一对有别的在飞件时放行让路; 取消覆盖停放件。
  "after-unit": { names: [], unit: true, run: async () => {
    const mem = () => { const m = new Map(); return { all: () => Object.fromEntries(m), get: (k) => m.get(k), set: (k, v) => (m.set(k, v), v), drop: (k) => m.delete(k) }; };
    const store = mem(), holdStore = mem();
    const released = [];
    let f;
    const mk = async (xs = {}) => {
      f = await fakeReceipts({ store, holdStore, release: async (h, seen) => { released.push({ turn: h.turn, seen: Object.keys(seen).sort().join(), t: Date.now() }); f.tell({ from: h.from, to: h.to, channel: h.channel, turn: h.turn, ...(h.k ? { k: h.k } : {}) }); return { ok: true }; }, ...xs });
      f.r.resume();
      return f;
    };
    await mk();
    const kx = { kind: "peer", from: "up", turn: "tu" };
    const fails = [];
    const ok = (c, why) => { if (!c) fails.push(why); };
    // A 在飞; B after A (到 b); C after B (到 c) —— 都停放, 没有任何一件被放行, 不占槽 (a→b 的槽还是空的)。
    f.tell({ from: "x", to: "a", channel: "", turn: "tA", k: kx });
    f.r.hold({ from: "x", to: "b", turn: "tB", at: Date.now(), after: ["tA"], body: {}, channel: "", job: "", k: kx });
    f.r.hold({ from: "x", to: "c", turn: "tC", at: Date.now(), after: ["tB"], body: {}, channel: "", job: "", k: kx });
    ok(f.r.prereqs("x", ["tB"])[0].state === "pending", "停放着的前置 = pending");
    ok(f.r.pending("x", "b") === undefined, "停放件不占 x→b 的槽");
    ok(f.r.states().filter((s) => s.state === "queued").length === 2, "两件停放显示成 queued");
    await sleep(3500);
    ok(!released.length, "A 没落定前不放行");
    f.answer("a", "tA", "RESULT: a-res\nARTIFACT: /tmp/a.txt — a");
    await until(() => released.some((r) => r.turn === "tB"), 15_000, 100);
    ok(released[0]?.turn === "tB" && released[0].seen === "tA", "A 落定 → 放行 B, 带 A 的结论");
    ok(!released.some((r) => r.turn === "tC"), "B 没落定前 C 不放行");
    f.answer("b", "tB", "RESULT: b-res");
    await until(() => released.some((r) => r.turn === "tC"), 15_000, 100);
    ok(released.map((r) => r.turn).join() === "tB,tC" && released[1].seen === "tB", "投递顺序 B 然后 C, C 带 B 的结论");
    // 父 k 不变: 放行出来的槽 k = 停放时的 k。
    ok(f.sent.length >= 1, "A 的回执送回了 x");
    // 失败: D after E, E 超时被 cancel → D 不放行, x 收到 canceled。
    f.tell({ from: "x", to: "e", channel: "", turn: "tE" });
    f.r.hold({ from: "x", to: "d", turn: "tD", at: Date.now(), after: ["tE"], body: {}, channel: "", job: "", k: kx });
    f.r.cancel("e", "someone");
    const can = await until(() => f.sent.find((s) => s.meta.turn === "tD"), 15_000, 100);
    ok(can?.meta.status === "canceled" && /tE/.test(can.body) && /没投/.test(can.body), `前置失败 → D 收 canceled 且说明哪件 (${can?.body.slice(0, 60)})`);
    ok(!released.some((r) => r.turn === "tD"), "D 从未放行");
    // 查不到的前置 (登记里没有) → 不放行。
    f.r.hold({ from: "x", to: "g", turn: "tG", at: Date.now(), after: ["tNope"], body: {}, channel: "", job: "" });
    const lost = await until(() => f.sent.find((s) => s.meta.turn === "tG"), 15_000, 100);
    ok(lost?.meta.status === "canceled" && !released.some((r) => r.turn === "tG"), "前置查不到 → canceled 不放行");
    // 同一对在飞着别的件: 放行让路, 不顶掉它的回执槽。
    f.tell({ from: "x", to: "h1", channel: "", turn: "tH1" });
    f.answer("h1", "tH1", "RESULT: h1");
    await until(() => f.sent.some((s) => s.meta.turn === "tH1"), 15_000, 100);
    f.tell({ from: "x", to: "p", channel: "", turn: "tBusy" });
    f.r.hold({ from: "x", to: "p", turn: "tP", at: Date.now(), after: ["tH1"], body: {}, channel: "", job: "" });
    await sleep(3500);
    ok(!released.some((r) => r.turn === "tP") && f.r.pending("x", "p")?.turn === "tBusy", "同一对有在飞件: 停放件等它, 不顶它的槽");
    f.answer("p", "tBusy", "RESULT: busy-done");
    await until(() => released.some((r) => r.turn === "tP"), 20_000, 100);
    ok(released.some((r) => r.turn === "tP"), "在飞件落定后放行");
    // 取消覆盖停放件: stop 目标 → 不放行; 发起 stop 的是发话方自己 = 不回执。
    f.tell({ from: "x", to: "s1", channel: "", turn: "tS1" });
    f.r.hold({ from: "x", to: "s2", turn: "tS2", at: Date.now(), after: ["tS1"], body: {}, channel: "", job: "" });
    f.r.cancel("s2", "x");
    f.answer("s1", "tS1", "RESULT: s1");
    await sleep(4000);
    ok(!released.some((r) => r.turn === "tS2") && !f.sent.some((s) => s.meta.turn === "tS2"), "取消 (发话方自己) → 不放行、不回执");
    // reload: 停放登记落盘, 新进程 (共用 store) 接着判 —— 前置在「重启期间」落定的立即放行。
    f.tell({ from: "x", to: "r1", channel: "", turn: "tR1", k: kx });
    f.r.hold({ from: "x", to: "r2", turn: "tR2", at: Date.now(), after: ["tR1"], body: {}, channel: "", job: "", k: kx });
    ok(Object.keys(holdStore.all()).some((k) => k.endsWith("tR2")), "停放登记落盘");
    const before = released.length;
    const f1 = f;
    f1.answer("r1", "tR1", "RESULT: r1-res");
    await until(() => f1.sent.some((s) => s.meta.turn === "tR1"), 15_000, 100);
    // 旧「进程」不再放行 (模拟被 reload 掉): 换个 release 为空, 新进程接手。
    const released2 = [];
    const f2 = await fakeReceipts({ store, holdStore, release: async (h, seen) => { released2.push({ turn: h.turn, seen: Object.keys(seen).join() }); return { ok: true }; } });
    f2.r.resume();
    await until(() => released2.length || released.length > before, 15_000, 100);
    ok(released2.some((r) => r.turn === "tR2" && r.seen === "tR1") || released.length > before, "reload 后前置已落定的停放件照放");
    return { pass: !fails.length, why: fails.length ? fails.join(" · ") : "停放 / 放行顺序 / 带结论 / 前置失败 / 查不到 / 让路 / 取消 / reload 都对" };
  } },

  // 依赖 (真 daemon): 根派 A (睡一会儿), B after A、C after B 都停放; A 落定 → B 带着 A 的结论投出, B 落定 → C 带着 B 的; 根各收一份回执。
  "after-live": { names: ["rr-a1", "rr-b1", "rr-c1"], run: async () => {
    const n = nonce();
    await Promise.all(["rr-a1", "rr-b1", "rr-c1"].map((x) => spawn(x)));
    const a = await tell("rr-a1", `${SLEEP(45)}, 然后回复一行: RESULT: a-${n}`);
    const b = await tell("rr-b1", `不要调用任何工具, 直接回复一行: RESULT: b-${n}`, { after: [a.turn] });
    const c = await tell("rr-c1", `不要调用任何工具, 直接回复一行: RESULT: c-${n}`, { after: [b.turn] });
    if (!b.parked || !c.parked) return { pass: false, why: `没停放: b=${JSON.stringify(b).slice(0, 120)} c=${JSON.stringify(c).slice(0, 120)}` };
    await sleep(3000);
    const early = (await textOf("rr-b1")).includes(`b-${n}`);
    const sc = await settledSlot("rr-c1", 6 * 60_000);
    const sb = slotOf(root.target, kids.get("rr-b1"));
    const tb = await textOf("rr-b1"), tc = await textOf("rr-c1");
    const gb = await receiptsIn(root.target, "rr-b1"), gc = await receiptsIn(root.target, "rr-c1");
    return {
      pass: !early && sc?.outcome?.status === "done" && sb?.outcome?.status === "done" && tb.includes(`a-${n}`) && tc.includes(`b-${n}`) && gb.length === 1 && gc.length === 1,
      why: `A 前 B 已被注入=${early} · B=${sb?.outcome?.status} C=${sc?.outcome?.status ?? "未落定"} · B 带 A 结论=${tb.includes(`a-${n}`)} C 带 B 结论=${tc.includes(`b-${n}`)} · 根收到 B ${gb.length} / C ${gc.length} 份`,
    };
  } },

  // 依赖 + reload (真 daemon, solo): B 停放后 reload 整个 daemon, 之后 A 落定 → B 照投、带 A 的结论。
  "after-reload": { names: ["rr-a3", "rr-b3"], solo: true, run: async () => {
    const n = nonce();
    await Promise.all(["rr-a3", "rr-b3"].map((x) => spawn(x)));
    const a = await tell("rr-a3", `${SLEEP(50)}, 然后回复一行: RESULT: a-${n}`);
    const b = await tell("rr-b3", `不要调用任何工具, 直接回复一行: RESULT: b-${n}`, { after: [a.turn] });
    if (!b.parked) return { pass: false, why: `没停放: ${JSON.stringify(b).slice(0, 160)}` };
    execFileSync("./cli/wezard.sh", ["reload"], { cwd: new URL("../..", import.meta.url).pathname, stdio: "ignore" });
    const sb = await settledSlot("rr-b3", 6 * 60_000);
    const tb = await textOf("rr-b3");
    return {
      pass: sb?.outcome?.status === "done" && tb.includes(`a-${n}`),
      why: `B=${sb?.outcome?.status ?? "未落定"} B 带 A 结论=${tb.includes(`a-${n}`)}`,
    };
  } },

  // 依赖 (真 daemon): 前置超时 → B 从未被注入, 根收到 B 的 canceled 回执。
  "after-fail": { names: ["rr-a2", "rr-b2"], run: async () => {
    const n = nonce();
    await Promise.all(["rr-a2", "rr-b2"].map((x) => spawn(x)));
    const a = await tell("rr-a2", `${SLEEP(150)}, 然后回复一行: RESULT: late`, { deadline: 60 });
    const b = await tell("rr-b2", `回复一行: RESULT: never-${n}`, { after: [a.turn] });
    if (!b.parked) return { pass: false, why: `没停放: ${JSON.stringify(b).slice(0, 160)}` };
    // 不投的那份按件号停放着落盘 (不占 root→B 的位置), 所以按件号找。
    const sb = await until(() => { const s = Object.values(readJson("receipts.json")).find((x) => x.turn === b.turn); return s?.settled && s; }, 4 * 60_000);
    await sleep(3000);
    const injected = (await textOf("rr-b2")).includes(`never-${n}`);
    const gb = await receiptsIn(root.target, "rr-b2");
    return {
      pass: sb?.outcome?.status === "canceled" && !injected && gb.length === 1 && gb[0].attrs.status === "canceled",
      why: `B slot=${sb?.outcome?.status ?? "未落定"} 被注入过=${injected} 根收到 ${gb.map((r) => r.attrs.status).join(",") || "0 份"}`,
    };
  } },

  // graph 的步骤与进度跟着发起那一轮的频道: 根这一轮是私聊 (发起者的 receipt:false 私聊 / 回执),
  // 节点那一轮就不能进它的 home 群。
  "graph-private": { names: ["rr-gn"], run: async () => {
    const n = nonce();
    const tag = real("rr-gn");
    const g = await post("/graph/run", { target: root.target, nodes: [{ tag, model: "haiku" }], steps: [{ to: tag, prompt: `这是回归测试, 不要调用任何工具, 直接回复一行: RESULT: [receipt-regress] graph-${n}` }], rounds: 1, idleTimeoutSec: 180 });
    if (!g.ok) return { pass: false, why: `graph/run: ${g.reason}` };
    kids.set("rr-gn", `${g.base}#${tag}`);
    const run = await until(async () => { const r = await fetch(`${DAEMON}/graph/status?runId=${g.runId}`).then((x) => x.json()).catch(() => ({})); return r.run?.status !== "running" && r.run; }, 4 * 60_000);
    await sleep(5000);
    const pub = turnsOf(kids.get("rr-gn")).filter((t) => t.channel !== "").map((t) => t.channel);
    return {
      pass: run?.status === "done" && !pub.length,
      why: `graph=${run?.status ?? "没跑完"} · 进了群的轮 ${pub.join(",") || "无"}`,
    };
  } },

  // 交接时欠着两份 (根的活在跑, rr-s 的一句插进同一轮): 新会话里每份各开一轮、各带各的信封,
  // 两个上游各收到答给自己那件的交代 —— 不是并成一句、两边拿到同一段。
  "handoff-owe": { names: ["rr-h", "rr-s"], run: async () => {
    const n = nonce();
    await Promise.all(["rr-h", "rr-s"].map((x) => spawn(x)));
    await tell("rr-h", `${SLEEP(40)}, 然后回复一行: RESULT: h-root-${n}`);
    await sleep(6000);
    await post("/peers/tell", { target: kids.get("rr-s"), name: real("rr-h"), priority: "now", text: `回复一行: RESULT: h-s-${n}` });
    await sleep(3000);
    const t0 = Date.now();
    const h = await post("/wizard/handoff-self", { target: kids.get("rr-h"), brief: `（receipt-regress 交接测试）手上没有别的活。你会收到两轮, 一轮一个发话方 (看那一轮信封里的发话人): 每一轮只回复一行 RESULT:, 且只写那个发话人对应的值 —— 欠 ${real("rr-root")} 的是 h-root-${n}, 欠 ${real("rr-s")} 的是 h-s-${n}。收到这份简报的这一轮同样只写它信封发话人的那一个值, 不要复述简报、不要在任何一句里写出另一个值。不要调用任何工具。` });
    if (!h.ok) return { pass: false, why: `handoff-self: ${h.reason}` };
    const both = await until(() => { const a = slotOf(root.target, kids.get("rr-h")), b = slotOf(kids.get("rr-s"), kids.get("rr-h")); return a?.settled && b?.settled && [a, b]; }, 5 * 60_000);
    const p = await jsonlOf(kids.get("rr-h"));
    const lines = p ? readFileSync(p, "utf8").split("\n").filter((l) => l.includes('"type":"user"') && l.includes('wezard=\\"envelope\\"')) : [];
    const mixed = lines.filter((l) => l.includes(`.${real("rr-s")}`) && l.includes(`.${root.name}`)).length;
    const [a, b] = both ?? [];
    // 前提: 交接发起时两份都还欠着 —— 交接把义务转进新会话 (transfer 把槽的发话锚改到交接时刻)。
    // 旧轮在交接前已收口的话, 交接什么也没接到, 值对不对没有意义: 报前提没成立, 别报成值答串了。
    if (both && (a.at < t0 || b.at < t0)) return { pass: false, why: "前提没成立: 旧轮在交接前已收口 (交接没接到欠账), 重跑这一条" };
    return {
      pass: !!both && a.outcome?.body.includes(`h-root-${n}`) && !a.outcome.body.includes(`h-s-${n}`) && b.outcome?.body.includes(`h-s-${n}`) && !b.outcome.body.includes(`h-root-${n}`) && !mixed,
      why: `根收到=${a?.outcome?.status ?? "未落定"}:${a?.outcome?.body.slice(0, 60) ?? ""} · rr-s 收到=${b?.outcome?.status ?? "未落定"}:${b?.outcome?.body.slice(0, 60) ?? ""} · 两份信封并在一句的 ${mixed} 句`,
    };
  } },

  // fork 分身 (继承上下文) 的第一轮: 带 task 的是私聊派活, 不带的是开场白 —— 都不是人在群里
  // 问的, 终句不能进分身的 home 群。实测于 .irisfit-coder (10-03 04:33) / .eff-d (10-02 15:09)。
  "clone-private": { names: ["rr-f", "rr-g"], run: async () => {
    const n = nonce();
    await spawn("rr-f", { inherit: true, task: `这是回归测试, 不要调用任何工具, 直接回复一行: RESULT: [receipt-regress] fork-${n}` });
    await spawn("rr-g", { inherit: true });
    const s = await settledSlot("rr-f", 3 * 60_000);
    await until(() => turnsOf(kids.get("rr-g")).some((t) => t.closed), 90_000);
    await sleep(5000);
    const pub = ["rr-f", "rr-g"].flatMap((x) => turnsOf(kids.get(x)).filter((t) => t.channel !== "").map((t) => `${x}:${t.channel}`));
    return {
      pass: s?.outcome?.status === "done" && !pub.length,
      why: `rr-f 回执=${s?.outcome?.status ?? "未落定"} · 进了群的轮 ${pub.join(",") || "无"}`,
    };
  } },

  // 三级 root→a→b→c: c 的结论经 b、a 冒泡回根, 根只收到一份, 内容是真结论而不是「已派」。
  chain: { names: ["rr-a", "rr-b", "rr-c"], run: async () => {
    const n = nonce();
    await Promise.all(["rr-a", "rr-b", "rr-c"].map((x) => spawn(x)));
    const c = `直接回复一行: RESULT: chain-${n}`;
    const b = `${TELL("rr-c", c)}\n发完立刻结束这一轮, 只回「已派」。之后收到 rr-c 的回执, 最后一行原样写它的 RESULT 行。`;
    const a = `${TELL("rr-b", b)}\n发完立刻结束这一轮, 只回「已派」。之后收到 rr-b 的回执, 最后一行原样写它的 RESULT 行。`;
    await tell("rr-a", a);
    const s = await settledSlot("rr-a", 8 * 60_000);
    // haiku 偶尔先答「已派」收了这一轮、下一轮才真派 —— 那件活就不挂在根的这件下面, 是分身没照做。
    const ab = slotOf(kids.get("rr-a"), kids.get("rr-b"));
    if (s && !s.outcome?.body.includes(`chain-${n}`) && ab?.k?.from !== root.target) return { pass: false, why: "rr-a 没在答根的那一轮里派活 (haiku 没照做), 重跑这一条" };
    const got = await receiptsIn(root.target, "rr-a");
    return {
      pass: !!s && s.outcome?.status === "done" && s.outcome.body.includes(`chain-${n}`) && got.length === 1,
      why: `slot=${s?.outcome?.status ?? "未落定"} 含结论=${!!s?.outcome?.body.includes(`chain-${n}`)} 根收到 ${got.length} 份`,
    };
  } },

  // 并发两子: p 同一轮派 q1、q2; 第一份回执轮不外发, 第二份带 reply-to 回根, 根只收一份且含两份结论。
  fanout: { names: ["rr-p", "rr-q1", "rr-q2"], run: async () => {
    const n = nonce();
    await Promise.all(["rr-p", "rr-q1", "rr-q2"].map((x) => spawn(x)));
    const p = [
      TELL("rr-q1", `直接回复一行: RESULT: q1-${n}`),
      TELL("rr-q2", `直接回复一行: RESULT: q2-${n}`),
      "两个都发完立刻结束这一轮, 只回「已派」。之后每收到一份回执, 记下它的 RESULT; 两份都到了, 最后一行写 `RESULT: ` 加上两份 RESULT 的内容。",
    ].join("\n\n");
    const t0 = Date.now();
    await tell("rr-p", p);
    const s = await settledSlot("rr-p", 8 * 60_000);
    // haiku 偶尔只回「已派」却没真调 tell_peer —— 那是分身没照做, 不是回执的问题, 分开报。
    const sent = ["rr-q1", "rr-q2"].filter((q) => (slotOf(kids.get("rr-p"), kids.get(q))?.at ?? 0) >= t0).length;
    if (sent < 2) return { pass: false, why: `rr-p 只真派出了 ${sent}/2 件 (haiku 没照做), 重跑这一条` };
    const got = await receiptsIn(root.target, "rr-p");
    // 子活偶尔先 NEED 反问一次 (中途回执, 不算定论), 只数定论那两份。
    const atP = [...(await receiptsIn(kids.get("rr-p"), "rr-q1")), ...(await receiptsIn(kids.get("rr-p"), "rr-q2"))].filter((r) => r.attrs.status !== "need");
    const routed = atP.filter((r) => r.attrs["reply-to"] === `.${root.name}`).length;
    const body = s?.outcome?.body ?? "";
    return {
      pass: s?.outcome?.status === "done" && body.includes(`q1-${n}`) && body.includes(`q2-${n}`) && got.length === 1 && atP.length === 2 && routed === 1,
      why: `slot=${s?.outcome?.status ?? "未落定"} 含两份=${body.includes(`q1-${n}`) && body.includes(`q2-${n}`)} 根收到 ${got.length} 份 · p 收到 ${atP.length} 份, 带 reply-to 的 ${routed} 份`,
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
    const got = await receiptsIn(root.target, "rr-x");
    const text = `${w.result ?? ""}${w.lastText ?? ""}`;
    return {
      pass: text.includes(`wait-${n}`) && got.length === (w.delivered ? 1 : 0),
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
    const s = await settledSlot("rr-l", 4 * 60_000);
    const got = await receiptsIn(root.target, "rr-l");
    return {
      pass: s?.outcome?.status === "done" && s.outcome.body.includes(`long-${n}`) && got.length === 1,
      why: `slot=${s?.outcome?.status ?? "未落定"} 含结论=${!!s?.outcome?.body.includes(`long-${n}`)} 根收到 ${got.length} 份`,
    };
  } },

  // deadline: 60s 期限, 对方要睡 150s → 落 timeout, 根收到一份 status=timeout。
  deadline: { names: ["rr-y"], run: async () => {
    await spawn("rr-y");
    const t0 = Date.now();
    await tell("rr-y", `${SLEEP(150)}, 然后回复一行: RESULT: late`, { deadline: 60 });
    const s = await settledSlot("rr-y", 150_000);
    const got = await receiptsIn(root.target, "rr-y");
    return {
      pass: s?.outcome?.status === "timeout" && got.length === 1 && got[0].attrs.status === "timeout",
      why: `slot=${s?.outcome?.status ?? "未落定"} 用时 ${Math.round((Date.now() - t0) / 1000)}s 根收到 ${got.map((r) => r.attrs.status).join(",") || "0 份"}`,
    };
  } },

  // 对方 pane 被直接杀掉 (不经 stop_wizard, 那会落 canceled) → dead。
  dead: { names: ["rr-z"], run: async () => {
    await spawn("rr-z");
    await tell("rr-z", `${SLEEP(120)}, 然后回复一行: RESULT: never`);
    await sleep(10_000);
    const pane = tmuxPaneOf(real("rr-z"));
    if (!pane) return { pass: false, why: "找不到 rr-z 的 tmux pane" };
    execFileSync("tmux", ["kill-pane", "-t", pane]);
    const t0 = Date.now();
    const s = await settledSlot("rr-z", 120_000);
    const got = await receiptsIn(root.target, "rr-z");
    return {
      pass: s?.outcome?.status === "dead" && got.length === 1,
      why: `slot=${s?.outcome?.status ?? "未落定"} 杀 pane 后 ${Math.round((Date.now() - t0) / 1000)}s 根收到 ${got.length} 份`,
    };
  } },

  // NEED → re 答复 → done: 中途那份 status=need 且不算定论, 续问沿用件号 (legs=2), 终态 done。
  need: { names: ["rr-n"], run: async () => {
    const n = nonce();
    await spawn("rr-n");
    await tell("rr-n", "这是一次反问测试。现在只回复一行: `NEED: 请给我口令`, 不做别的。之后收到口令, 回复一行: RESULT: need-<口令>");
    const asked = await until(async () => (await receiptsIn(root.target, "rr-n")).find((r) => r.attrs.status === "need"), 180_000);
    if (!asked) return { pass: false, why: `没收到 NEED 回执 (slot=${slotOf(root.target, kids.get("rr-n"))?.outcome?.status})` };
    const mid = slotOf(root.target, kids.get("rr-n"));
    await tell("rr-n", `口令是 ${n}`, { re: asked.attrs.turn });
    const s = await settledSlot("rr-n", 180_000);
    return {
      pass: !mid?.resolved && s?.outcome?.status === "done" && s.outcome.body.includes(`need-${n}`) && s.legs === 2 && s.turn === asked.attrs.turn,
      why: `NEED 时 resolved=${!!mid?.resolved} · 终态=${s?.outcome?.status ?? "未落定"} legs=${s?.legs} 同件号=${s?.turn === asked.attrs.turn}`,
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

  // chain:false —— a 在答根那一轮里派的旁支活不挂住 a 给根的交代: 根先拿到 a 自己的结论, 且只一份。
  detach: { names: ["rr-e", "rr-d"], run: async () => {
    const n = nonce();
    await Promise.all(["rr-e", "rr-d"].map((x) => spawn(x)));
    await tell("rr-e", `${TELL("rr-d", `${SLEEP(30)}, 然后回复一行: RESULT: side-${n}`, ", 参数 chain 设为 false")}\n发完不必等它, 直接回复一行: RESULT: own-${n}。之后收到 rr-d 的回执只回 ok。`);
    const s = await settledSlot("rr-e", 3 * 60_000);
    const side = await until(() => { const x = slotOf(kids.get("rr-e"), kids.get("rr-d")); return x?.settled && x; }, 3 * 60_000);
    await sleep(30_000);
    const got = await receiptsIn(root.target, "rr-e");
    return {
      pass: s?.outcome?.status === "done" && s.outcome.body.includes(`own-${n}`) && !!side && !side.k && got.length === 1,
      why: `slot=${s?.outcome?.status ?? "未落定"} 是自己的结论=${!!s?.outcome?.body.includes(`own-${n}`)} 旁支 k=${side ? side.k?.kind ?? "无" : "未落定"} 根收到 ${got.length} 份`,
    };
  } },

  // 工单验收 (B4 ⑦): 成员第一次交了没有 RESULT 的答复 → 守护进程同件号打回一次, 那份不投给根;
  // 第二次照收。根只收到一份, 内容是补了 RESULT 的那次。
  accept: { names: ["rr-v"], run: async () => {
    const n = nonce();
    const o = await post("/jobs/open", { target: root.target, title: "[receipt-regress] 工单验收打回", expect: 1 });
    if (!o.ok) return { pass: false, why: `open_job: ${o.reason}` };
    await spawn("rr-v", { job: o.job, task: `这是回归测试, 不要调用任何工具。第一次只回复「好的」两个字, 不写 RESULT。之后若被要求补收口, 就回复一行: RESULT: accept-${n}` });
    const s = await settledSlot("rr-v", 4 * 60_000);
    const got = await receiptsIn(root.target, "rr-v");
    await post("/jobs/close", { target: root.target, job: o.job, summary: "receipt-regress" });
    return {
      pass: s?.outcome?.status === "done" && s.outcome.body.includes(`accept-${n}`) && s.legs === 2 && got.length === 1,
      why: `slot=${s?.outcome?.status ?? "未落定"} legs=${s?.legs} 含补交=${!!s?.outcome?.body.includes(`accept-${n}`)} 根收到 ${got.length} 份`,
    };
  } },

  // 按件号撤回 / 不误伤 (B4 ⑧): rr-k 先做根派的活, rr-o 的活排在后面 (normal 等它闲)。
  // 根按件号撤回自己那件 → 只停这一轮; rr-k 接着做 rr-o 的活时, 根不带件号的打断被拒 (409)、
  // urgent 降成 normal; rr-o 那件最终照常答完。
  "cancel-turn": { names: ["rr-k", "rr-o"], run: async () => {
    const n = nonce();
    await Promise.all(["rr-k", "rr-o"].map((x) => spawn(x)));
    const mine = await tell("rr-k", `${SLEEP(60)}, 然后回复一行: RESULT: root-${n}`);
    await sleep(8000);
    const theirs = post("/peers/tell", { target: kids.get("rr-o"), name: real("rr-k"), priority: "normal", text: `${SLEEP(40)}, 然后回复一行: RESULT: o-${n}` });
    await sleep(3000);
    const byTurn = await post("/wizard/stop", { target: root.target, name: real("rr-k"), mode: "interrupt", turn: mine.turn });
    await theirs;
    await sleep(8000);
    const blunt = await post("/wizard/stop", { target: root.target, name: real("rr-k"), mode: "interrupt" });
    const urgent = await tell("rr-k", "直接回复一行: RESULT: ok", { priority: "urgent" });
    const o = await until(() => { const x = slotOf(kids.get("rr-o"), kids.get("rr-k")); return x?.settled && x; }, 3 * 60_000);
    const m = slotOf(root.target, kids.get("rr-k"));
    return {
      pass: byTurn.interrupted === true && blunt.ok === false && /别的|派的活/.test(blunt.reason ?? "") && !!urgent.urgentDowngraded && o?.outcome?.status === "done" && o.outcome.body.includes(`o-${n}`),
      why: `按件号撤回 interrupted=${byTurn.interrupted} · 不带件号打断=${blunt.ok ? "放行了" : "被拒"} · urgent 降级=${!!urgent.urgentDowngraded} · rr-o 那件=${o?.outcome?.status ?? "未落定"}${o?.outcome?.body.includes(`o-${n}`) ? "(答完)" : ""} · 根最后那件=${m?.outcome?.status ?? "在跑"}`,
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
    const a = await mk("rr-t", `rr-quiet-${n}`, "这一轮没有任何值得报告的事: 不要调用任何工具, 直接按「没事」收口。");
    const b = await mk("rr-t2", `rr-loud-${n}`, `有一件人必须知道的事要报告 (不是 QUIET): 不要调用任何工具, 你的最后一条消息原样写这一行: [receipt-regress] 安静任务有事转发 ${n}`);
    if (!a.ok || !b.ok) return { pass: false, why: `schedule_task: ${a.reason ?? b.reason}` };
    const tq = kids.get("rr-t"), tl = kids.get("rr-t2");
    const postponed = await until(() => logLine(t0, (o) => o.taskId === a.id && /顺延/.test(o.msg ?? "")), 5 * 60_000, 5000);
    const quiet = await until(() => logLine(t0, (o) => o.target === tq && /quiet task/.test(o.msg ?? "")), 4 * 60_000, 5000);
    const loud = await until(() => logLine(t0, (o) => o.target === tl && /quiet task/.test(o.msg ?? "")), 60_000, 5000);
    // 转发确实发生了、且只落在伪群: notifyChat 投向 SINK 的那一次被企微拒收。
    const relayed = loud && await until(() => logLine(t0, (o) => o.chatId === SINK_ID && /chat notify failed/.test(o.msg ?? "")), 30_000, 2000);
    const inSink = [tq, tl].every((t) => t?.startsWith(`${SINK}#`));
    return {
      pass: inSink && !!postponed?.idle && postponed.ok && quiet?.quiet === true && loud?.quiet === false && !!relayed,
      why: `${inSink ? "" : "分身没生在伪群 · "}顺延=${postponed ? `idle:${postponed.idle} ok:${postponed.ok}` : "没发生"} · 安静那轮 quiet=${quiet?.quiet ?? "没收口"} · 有事那轮 quiet=${loud?.quiet ?? "没收口"} · 转发到伪群=${relayed ? "是" : "没看到"}`,
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

const cleanup = async () => {
  await Promise.all([...kids.keys()].map(stop));
  if (root) await post("/wizard/stop", { ...ME, name: root.name, mode: "end", forget: true });
  // 根开过工单, close_job 会把收工结论留档成它的情景记忆 —— 测试的不该留下。
  if (root) rmSync(join(STATE, "memory", "episodes", `${root.name}.jsonl`), { force: true });
};

const main = async () => {
  if (!ME.sessionId && !ME.tmuxPane) throw new Error("要在 wizard 会话里跑 (缺 CLAUDE_CODE_SESSION_ID / TMUX_PANE)");
  console.log("typecheck…");
  execFileSync("npm", ["run", "-s", "typecheck"], { stdio: "inherit" });
  const pick = process.argv.slice(2);
  const bad = pick.filter((x) => !cases[x]);
  if (bad.length) throw new Error(`没有用例 ${bad.join(" ")} —— 有: ${Object.keys(cases).join(" ")}`);
  // solo: 会 reload 整个 daemon, 与别的用例并跑会弄断它们 —— 默认不跑, 点名才跑 (`run.mjs after-reload`)。
  const chosen = pick.length ? pick : Object.keys(cases).filter((x) => !cases[x].solo);
  // 只跑纯单元的不必生根 (它们不碰 daemon)。
  if (chosen.some((x) => !cases[x].unit)) {
    const r = await post("/wizard/clone", { ...ME, name: real("rr-root"), inherit: false, model: "haiku", keepalive: false, description: "receipt-regress 的根" });
    if (!r.ok) throw new Error(`spawn rr-root: ${r.reason}`);
    root = { target: r.target, name: r.name };
    await post("/peers/tell", { ...ME, name: root.name, receipt: false, priority: "now", text: "你是回执回归测试的根。之后进来的每一份回执, 只回一个词 ok, 不调用任何工具。现在回 ok。" });
    await sleep(20_000);
  }
  const slots = pool(MAX_KIDS);
  const results = await Promise.all(chosen.map(async (name) => {
    const c = cases[name];
    await slots.take(c.names.length);
    const t0 = Date.now();
    const out = await c.run().catch((e) => ({ pass: false, why: `抛错: ${e.message}` }));
    console.log(`${out.pass ? "PASS" : "FAIL"} ${name.padEnd(9)} ${Math.round((Date.now() - t0) / 1000)}s · ${out.why}`);
    await Promise.all(c.names.map(stop));
    slots.give(c.names.length);
    return out.pass;
  }));
  const failed = results.filter((x) => !x).length;
  const rootAlive = !root || (!!(await jsonlOf(root.target)) && !!tmuxPaneOf(root.name));
  if (!rootAlive) console.log("⚠ 根 rr-root 中途没了 (多半撞上了别人的 reload) —— 「根收到 N 份」类判定无效, 重跑");
  console.log(failed ? `${failed}/${results.length} FAIL` : `全部 ${results.length} 条 PASS`);
  return failed;
};

process.on("SIGINT", () => void cleanup().finally(() => process.exit(130)));
main()
  .then(async (failed) => { await cleanup(); process.exit(failed ? 1 : 0); })
  .catch(async (e) => { console.error(e.message); await cleanup(); process.exit(2); });
