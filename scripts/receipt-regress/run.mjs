#!/usr/bin/env node
// 回执回归: 改 daemon/receipts.ts / jobs.ts / peers.ts 之后跑一遍。
//
//   node scripts/receipt-regress/run.mjs            # 全部
//   node scripts/receipt-regress/run.mjs chain need # 只跑这几条
//
// 必须在一个 wizard 会话里跑 (要 CLAUDE_CODE_SESSION_ID / TMUX_PANE 认出发起者)。它先生一个
// haiku 根 `rr-root` (发起者的分身), 每条用例再由根生 haiku 临时分身、直接 POST daemon 驱动
// —— 不经 MCP, 所以不受「本会话的 MCP 进程是旧代码」影响。判定只读守护进程落的账 (receipts.json /
// jobs.json) 和根的 transcript 里收到的回执信封, 不信分身自己说了什么。跑完 (含失败 / Ctrl-C)
// 把生的分身全部收掉。
//
// 根的开场白是发起者一句 receipt:false 的私聊 —— 它这一轮没有父 k, 测试活的回执只回到根,
// 不会沿发起者手上那件活往上冒。工单用例会在根的 home 聊天里各出一对开 / 收工气泡。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const DAEMON = process.env.WEZARD_DAEMON_BASE ?? "http://127.0.0.1:17890";
// receipts.json / jobs.json 在 ~/.wezard 下 (WEZARD_STATE_DIR 是 hook 的另一处目录, 不是它)。
const STATE = process.env.RR_STATE_DIR ?? join(homedir(), ".wezard");
const ME = { sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? "", tmuxPane: process.env.TMUX_PANE ?? "" };
const MAX_KIDS = 7; // 根名下同时活着的分身 (cloneMax 默认 8, 留一个余量)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nonce = () => randomBytes(3).toString("hex");
// 别的 wizard 随时会 reload daemon: 连不上 / 被断开就等它回来 (最多 2 分钟), 回执登记落盘、会续守。
const post = async (route, body, tries = 60) => {
  const r = await fetch(DAEMON + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .catch((e) => (tries > 1 ? undefined : Promise.reject(e)));
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
    .filter((r) => r.attrs.wezard === "envelope" && r.attrs.receipt === "1" && (!fromName || r.attrs.from === `.${fromName}`));
};

const tmuxPaneOf = (window) =>
  execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_id}\t#{window_name}"], { encoding: "utf8" })
    .split("\n").map((l) => l.split("\t")).find(([, w]) => w === window)?.[0];

// ── 根与分身 ──────────────────────────────────────────────────────────
let root; // { target, name }
const kids = new Map(); // name → target
const SLEEP = (sec) => `先用 Bash **前台**执行 \`python3 -c "import time; time.sleep(${sec})"\` (不要 run_in_background, 不要用 sleep 命令)`;
const TELL = (name, text, extra = "") =>
  `用 wezard 的 tell_peer 工具 (先 ToolSearch 搜 "tell_peer" 加载) 发给 name "${name}"${extra}, text 原样是下面 <<< >>> 之间的内容:\n<<<\n${text}\n>>>`;

// 生分身串行: 同一 cwd 里同时起几个会话, daemon 认新 sid 时会认错 (「sessionId … already bound」)。
let spawning = Promise.resolve();
const spawnOnce = async (name, extra) => {
  const r = await post("/wizard/clone", { target: root.target, name, inherit: false, model: "haiku", keepalive: false, description: "receipt-regress 临时分身", ...extra });
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
  await post("/wizard/stop", { target: root.target, name, mode: "end", forget: true });
  kids.delete(name);
};
const tell = (to, text, extra = {}) => post("/peers/tell", { target: root.target, name: to, text, priority: "now", ...extra });
/** 根 → `to` 那一份落定 (settled) 为止。 */
const settledSlot = (to, ms) => until(() => { const s = slotOf(root.target, kids.get(to)); return s?.settled && s; }, ms);

// ── 用例: 每条返回 { pass, why } ────────────────────────────────────────
const cases = {
  // 三级 root→a→b→c: c 的结论经 b、a 冒泡回根, 根只收到一份, 内容是真结论而不是「已派」。
  chain: { names: ["rr-a", "rr-b", "rr-c"], run: async () => {
    const n = nonce();
    await Promise.all(["rr-a", "rr-b", "rr-c"].map((x) => spawn(x)));
    const c = `直接回复一行: RESULT: chain-${n}`;
    const b = `${TELL("rr-c", c)}\n发完立刻结束这一轮, 只回「已派」。之后收到 rr-c 的回执, 最后一行原样写它的 RESULT 行。`;
    const a = `${TELL("rr-b", b)}\n发完立刻结束这一轮, 只回「已派」。之后收到 rr-b 的回执, 最后一行原样写它的 RESULT 行。`;
    await tell("rr-a", a);
    const s = await settledSlot("rr-a", 8 * 60_000);
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
    const routed = atP.filter((r) => r.attrs["reply-to"] === ".rr-root").length;
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
    const w = await post("/peers/wait", { target: root.target, name: "rr-x", timeoutSec: 180 });
    await sleep(30_000);
    const got = await receiptsIn(root.target, "rr-x");
    const text = `${w.result ?? ""}${w.lastText ?? ""}`;
    return {
      pass: text.includes(`wait-${n}`) && got.length === (w.delivered ? 1 : 0),
      why: `wait 取到=${text.includes(`wait-${n}`)} delivered=${!!w.delivered} 根收到 ${got.length} 份`,
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
    const pane = tmuxPaneOf("rr-z");
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
    await post("/jobs/close", { target: root.target, job: o.job, summary: "receipt-regress", stop: true });
    ["rr-j1", "rr-j2"].forEach((x) => kids.delete(x));
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
    await post("/jobs/close", { target: root.target, job: o.job, summary: "receipt-regress", stop: false });
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
};

const main = async () => {
  if (!ME.sessionId && !ME.tmuxPane) throw new Error("要在 wizard 会话里跑 (缺 CLAUDE_CODE_SESSION_ID / TMUX_PANE)");
  console.log("typecheck…");
  execFileSync("npm", ["run", "-s", "typecheck"], { stdio: "inherit" });
  const pick = process.argv.slice(2);
  const bad = pick.filter((x) => !cases[x]);
  if (bad.length) throw new Error(`没有用例 ${bad.join(" ")} —— 有: ${Object.keys(cases).join(" ")}`);
  const r = await post("/wizard/clone", { ...ME, name: "rr-root", inherit: false, model: "haiku", keepalive: false, description: "receipt-regress 的根" });
  if (!r.ok) throw new Error(`spawn rr-root: ${r.reason}`);
  root = { target: r.target, name: r.name };
  await post("/peers/tell", { ...ME, name: root.name, receipt: false, priority: "now", text: "你是回执回归测试的根。之后进来的每一份回执, 只回一个词 ok, 不调用任何工具。现在回 ok。" });
  await sleep(20_000);
  const slots = pool(MAX_KIDS);
  const results = await Promise.all((pick.length ? pick : Object.keys(cases)).map(async (name) => {
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
  console.log(failed ? `${failed}/${results.length} FAIL` : `全部 ${results.length} 条 PASS`);
  return failed;
};

process.on("SIGINT", () => void cleanup().finally(() => process.exit(130)));
main()
  .then(async (failed) => { await cleanup(); process.exit(failed ? 1 : 0); })
  .catch(async (e) => { console.error(e.message); await cleanup(); process.exit(2); });
