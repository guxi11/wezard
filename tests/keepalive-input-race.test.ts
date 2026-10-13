import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { withPaneInput } from "../daemon/pane-input.js";

const source = readFileSync(new URL("../daemon/mirror-bridge.ts", import.meta.url), "utf8");
const injectStart = source.indexOf("const inject = async (args:");
const injectEnd = source.indexOf("// ── Per-session injection queue", injectStart);
const fireStart = source.indexOf("  const fireKeepalive = async (");
const fireEnd = source.indexOf("  // One pool for both maintenance paths:", fireStart);
assert(injectStart >= 0 && injectEnd > injectStart && fireStart >= 0 && fireEnd > fireStart);
const code = ts.transpileModule(source.slice(injectStart, injectEnd) + source.slice(fireStart, fireEnd)
  + "\nglobalThis.fire=fireKeepalive;", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};
const flush = () => new Promise<void>((r) => setImmediate(r));

for (const winner of ["peer", "stop", "heartbeat"] as const) {
  const barrier = deferred(), entered = deferred();
  const pane = `%heartbeat-${winner}`;
  const holder = withPaneInput(pane, async () => { entered.resolve(); await barrier.promise; });
  await entered.promise;
  let idle = true, permitted = true, inputs = 0, remembered = 0, drained = 0;
  const a = { target: "target", sessionId: "sid", tmuxPane: pane, jsonlPath: "path",
    keepalive: { pinging: true, round: 0 }, keepaliveQuiet: undefined as ReturnType<typeof setTimeout> | undefined,
    keepaliveTurnId: undefined as string | undefined,
    tail: { drain: () => { assert.equal(a.keepaliveQuiet, undefined); drained++; } },
  };
  const log = { child() { return this; }, info() {}, warn() {} };
  const ctx = vm.createContext({
    withPaneInput, cfg: { wrc: { mirror: { keepalive: { ping: "ping", rounds: 1 } } } }, log,
    idleVerdict: () => idle, backendForPath: () => ({ name: "claude" }),
    setTimeout, clearTimeout, rememberInject: () => { remembered++; },
    endKeepaliveSwallow: (row: typeof a) => { if (row.keepaliveQuiet) clearTimeout(row.keepaliveQuiet); row.keepaliveQuiet = undefined; },
    lastContextTokens: () => 1, newTurnId: () => "heartbeat", cliOf: () => "claude",
    recordTurnStart() {}, recordTurnClose() {},
    injectViaTmux: async (_pane: string, _text: string, _images: unknown, _log: unknown, _fresh: unknown,
      _backend: unknown, _path: unknown, _bypass: unknown, guard: (phase: string) => boolean) => {
      if (!guard("paste")) return { ok: false };
      assert.equal(a.keepaliveQuiet !== undefined, true, "swallow starts at actual input, not while waiting");
      inputs++; return { ok: true };
    },
  });
  vm.runInContext(code, ctx);
  const heartbeat = ctx.fire(a, () => permitted);
  await flush();
  assert.equal(inputs, 0);
  assert.equal(a.keepaliveQuiet, undefined, "waiting heartbeat must not mute the peer that owns the lane");
  assert.equal(remembered, 0);
  if (winner === "peer") idle = false;
  if (winner === "stop") permitted = false;
  barrier.resolve(); await holder; await heartbeat;
  assert.equal(inputs, winner === "heartbeat" ? 1 : 0);
  assert.equal(remembered, inputs);
  assert.equal(drained, inputs);
  if (winner !== "heartbeat") {
    assert.equal(a.keepalive.pinging, false);
    assert.equal(a.keepaliveQuiet, undefined);
  }
  if (a.keepaliveQuiet) clearTimeout(a.keepaliveQuiet);
}
console.log("keepalive input race: lock-time idle, cancellation and input-time swallow passed");
