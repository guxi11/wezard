import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createKeyedScheduler } from "../shared/keyed-scheduler.js";

// Execute the production maintenance closures with controlled pane probes. This
// keeps tmux/WeCom out of the test while exercising the actual tick wiring.
const source = readFileSync(new URL("../daemon/mirror-bridge.ts", import.meta.url), "utf8");
const start = source.indexOf("  const maintenance = createKeyedScheduler(4);");
const end = source.indexOf("  const pickerTimer =", start);
assert(start >= 0 && end > start);
const code = ts.transpileModule(source.slice(start, end) + "\nglobalThis.harness={pickerTick,stop:()=>maintenance.stop()};", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};
const flush = () => new Promise<void>((r) => setImmediate(r));
const slow = deferred();
const panes = new Map(["slow", "fast", "bad"].map((target) => [target, {
  target, tmuxPane: `%${target}`, sessionId: target, jsonlPath: `${target}.jsonl`, injectGen: 0,
}]));
const calls = new Map<string, number>(), active = new Map<string, number>();
const scanned: string[] = [], errors: string[] = [];
let fail = true, maximum = 0;
const ctx = vm.createContext({
  createKeyedScheduler, byTarget: panes, cfg: { wrc: { mirror: {} }, approval: { enabled: true } },
  process: { env: {} }, Date, setInterval: () => 0,
  normAssistant: (text: string) => text, statSync: () => ({ mtimeMs: 0 }), cliOf: () => "codebuddy",
  log: { warn: (e: { target: string }) => errors.push(e.target), info() {} },
  mootMirrorPicker() {}, looksLikePicker: () => false,
  withPaneInput: async (_pane: string, action: (live: () => boolean) => Promise<void>, opts: { guard: () => boolean }) => {
    if (opts.guard()) await action(opts.guard);
  },
  tmuxPaneAlive: async (pane: string) => {
    calls.set(pane, (calls.get(pane) ?? 0) + 1);
    active.set(pane, (active.get(pane) ?? 0) + 1);
    maximum = Math.max(maximum, [...active.values()].reduce((a, b) => a + b, 0));
    assert.equal(active.get(pane), 1, "overlapping ticks must not probe the same pane concurrently");
    try {
      if (pane === "%slow") await slow.promise;
      if (pane === "%bad" && fail) throw new Error("probe failed");
      return true;
    } finally { active.set(pane, active.get(pane)! - 1); }
  },
  detectModalPicker: async (pane: string) => { scanned.push(pane); return { modal: false, screen: "" }; },
});
vm.runInContext(code, ctx);
const harness = ctx.harness as { pickerTick: () => void; stop: () => void };
harness.pickerTick(); harness.pickerTick();
await flush(); await flush();
assert(scanned.includes("%fast"), "slow A must not block B's picker scan");
assert.equal(calls.get("%slow"), 1);
assert(errors.includes("bad"), "single probe failure is reported without aborting the other panes");
harness.pickerTick(); harness.pickerTick();
await flush();
assert.equal(calls.get("%slow"), 1, "overlapping ticks must coalesce the running key and pending picker");
fail = false;
harness.pickerTick();
await flush(); await flush();
assert(scanned.includes("%bad"), "failed pane is eligible on a later tick");
assert(maximum <= 4);
harness.stop();
slow.resolve();
await flush(); await flush();
assert.equal(scanned.includes("%slow"), false, "stop cancels queued scans and invalidates a late probe");
const count = calls.get("%fast");
harness.pickerTick(); harness.pickerTick();
await flush();
assert.equal(calls.get("%fast"), count);

// Exercise the production multi-key picker helper: cancellation during a read
// or settle must fence the next numeric/arrow/Enter side effect.
const pressStart = source.indexOf("const pressModalIndex = async (");
const pressEnd = source.indexOf("\n// 「聊聊这个」", pressStart);
assert(pressStart >= 0 && pressEnd > pressStart);
const pressCode = ts.transpileModule(source.slice(pressStart, pressEnd) + "\nglobalThis.press=pressModalIndex;", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
for (const cancelAt of ["read", "settle", "arrow"] as const) {
  let live = true;
  const keys: string[] = [];
  const verdict = { modal: true, screen: "same" };
  const pressContext = vm.createContext({
    modalFingerprint: () => "same", highlightedIndex: () => 2,
    MODAL_PRESS_SETTLE_MS: 0, MODAL_ARROW_SETTLE_MS: 0,
    detectModalPicker: async () => { if (cancelAt === "read") live = false; return verdict; },
    sleep: async () => { if (cancelAt === "settle") live = false; },
    runTmux: async (args: string[]) => {
      keys.push(args.at(-1)!);
      if (cancelAt === "arrow" && args.at(-1) === "Up") live = false;
      return { ok: true };
    },
  });
  vm.runInContext(pressCode, pressContext);
  await pressContext.press("%pane", verdict, 1, () => live);
  assert.deepEqual(keys, cancelAt === "read" ? [] : cancelAt === "settle" ? ["1"] : ["1", "Up"]);
  assert.equal(keys.includes("Enter"), false, "no confirmation after the transaction loses liveness");
}
console.log("maintenance scheduler: independent probes, shared pane serialization, dedup, errors and stop passed");
