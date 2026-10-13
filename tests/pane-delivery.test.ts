import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock } from "node:test";
import ts from "typescript";
import { withPaneInput } from "../daemon/pane-input.js";

// Exercise the actual transport boundary with controlled physical I/O.
const source = readFileSync(new URL("../daemon/mirror-bridge.ts", import.meta.url), "utf8");
const start = source.indexOf("const inject = async (");
const end = source.indexOf("// ── Per-session injection queue", start);
assert(start >= 0 && end > start);
const code = ts.transpileModule(source.slice(start, end) + "\nreturn inject;", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
type Result = { ok: boolean; reason?: string; retryable?: boolean; uncertain?: boolean };
type Guard = (phase?: "paste" | "submit") => boolean;
type Args = { tmuxTarget: string; text: string; guard?: Guard; requireIdle?: () => boolean; prepareText?: () => string; beforeInput?: () => void };
type Physical = (target: string, text: string, images: string[], log: unknown, fresh: boolean, backend: unknown, path: string, bypass: boolean, guard: Guard) => Promise<Result>;
let physical: Physical = async () => ({ ok: true });
const inject = new Function("withPaneInput", "injectViaTmux", "injectViaSpawn", "backendForPath", code)(
  (pane: string, fn: Parameters<typeof withPaneInput>[1], opts: { guard?: Guard }) => withPaneInput(pane, fn, { ...opts, timeoutMs: 100 }),
  (...args: Parameters<Physical>) => physical(...args),
  async () => ({ ok: false, reason: "spawn exited" }),
  () => ({}),
) as (args: Args) => Promise<Result>;
const args: Args = { tmuxTarget: "%delivery", text: "receipt" };
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};
const drain = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const retryable = (r: Result) => { assert.equal(r.ok, false); assert.equal(r.retryable, true); assert.notEqual(r.uncertain, true); };
const uncertain = (r: Result) => { assert.equal(r.uncertain, true); assert.notEqual(r.retryable, true); };

let prepared = 0, activated = 0;
const delivery: Args = { ...args, prepareText: () => { prepared++; return "rendered"; }, beforeInput: () => { activated++; } };
retryable(await inject({ ...delivery, requireIdle: () => false }));
assert.equal(prepared, 0);
assert.equal(activated, 0);
const lane = deferred();
let idle = true;
const held = withPaneInput(args.tmuxTarget, () => lane.promise);
const queued = inject({ ...delivery, requireIdle: () => idle });
idle = false;
lane.release();
await held;
retryable(await queued);
assert.equal(prepared, 0, "idle must be checked after acquiring the physical pane");

// A pre-paste failure must not leave a seal or unmute the next real turn.
physical = async () => ({ ok: false, reason: "load failed" });
retryable(await inject(delivery));
assert.equal(activated, 0);
physical = async (_p, text, _i, _l, _f, _b, _j, _m, guard) => {
  assert.equal(text, "rendered");
  assert.equal(guard("paste"), true);
  assert.equal(guard("submit"), true);
  return { ok: true };
};
assert.equal((await inject(delivery)).ok, true);
assert.equal(activated, 1, "stamp once before input, not on every Enter");

for (const phase of ["paste", "submit"] as const) {
  physical = async (_p, _t, _i, _l, _f, _b, _j, _m, guard) => {
    assert(guard(phase));
    throw new Error("tmux disconnected after sending");
  };
  uncertain(await inject(args));
}
physical = async () => { throw new Error("preflight failed"); };
retryable(await inject(args));
physical = async () => ({ ok: true, uncertain: true });
uncertain(await inject(args));
physical = async () => ({ ok: false, uncertain: true });
uncertain(await inject(args));

// Permission/idle can change during readiness probes, before the first paste.
idle = true;
physical = async (_p, _t, _i, _l, _f, _b, _j, _m, guard) => {
  idle = false;
  assert.equal(guard("paste"), false);
  return { ok: false, reason: "busy now" };
};
retryable(await inject({ ...args, requireIdle: () => idle }));
// Default `now` remains allowed on a busy pane.
physical = async (_p, _t, _i, _l, _f, _b, _j, _m, guard) => ({ ok: guard("paste") });
assert.equal((await inject(args)).ok, true);

mock.timers.enable({ apis: ["setTimeout"] });
try {
  const late = deferred();
  let lateSubmit = false;
  physical = async (_p, _t, _i, _l, _f, _b, _j, _m, guard) => {
    assert(guard("paste"));
    await late.promise;
    lateSubmit = guard("submit");
    return { ok: lateSubmit };
  };
  const running = inject(args);
  await drain();
  const behind = inject(args);
  mock.timers.tick(100);
  uncertain(await running);
  retryable(await behind);
  late.release();
  await drain();
  assert.equal(lateSubmit, false);
} finally { mock.timers.reset(); }

// Exercise injectText's real attribution callbacks, not just the transport API.
const peerStart = source.indexOf("    injectText: async (");
const peerEnd = source.indexOf("    interruptPane:", peerStart);
const peerCode = ts.transpileModule("return ({" + source.slice(peerStart, peerEnd) + "}).injectText;", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const attachment = { sessionId: "sid", tmuxPane: "%delivery", jsonlPath: "test.jsonl", justSpawned: true, muteUntilInject: true, pendingFromCli: true, activePeerTurn: "old-task" };
const seals: unknown[] = [];
let notices = 0;
idle = false;
const env = {
  byTarget: new Map([["target", attachment]]), paneUsable: async () => true,
  cfg: {}, log: { child: () => ({}) }, noticeSuffixFor: () => { notices++; return " notice"; },
  rememberInject() {}, pushSeal: (_a: unknown, seal: unknown) => seals.push(seal), sealKeys: (s: string) => [s],
  idleVerdict: () => idle, isClearCommand: () => false, armSilentForkRebind() {}, inject,
};
const injectText = new Function(...Object.keys(env), peerCode)(...Object.values(env));
for (let i = 0; i < 3; i++) retryable(await injectText("target", "receipt", undefined, { requireIdle: true }));
assert.equal(notices, 0);
assert.equal(seals.length, 0);
assert.equal(attachment.muteUntilInject, true);
assert.equal(attachment.pendingFromCli, true);
idle = true;
physical = async () => ({ ok: false, reason: "load failed" });
retryable(await injectText("target", "receipt", undefined, { requireIdle: true }));
assert.equal(seals.length, 0);
assert.equal(attachment.muteUntilInject, true);
physical = async (_p, _t, _i, _l, _f, _b, _j, _m, guard) => {
  assert(guard("paste"));
  assert.equal(seals.length, 1, "seal precedes input becoming visible");
  assert.equal(attachment.muteUntilInject, false);
  assert(guard("submit"));
  return { ok: true };
};
assert.equal((await injectText("target", "receipt", undefined, { requireIdle: true })).ok, true);
assert.equal(seals.length, 1);
assert.equal(attachment.activePeerTurn, "old-task", "only transcript activation may replace the active peer turn");
console.log("pane delivery: idle revalidation, attribution boundary, default interjection, retry evidence and timeout fencing passed");
