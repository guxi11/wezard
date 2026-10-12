import assert from "node:assert/strict";
import { createTmuxBufferPaster } from "../daemon/tmux-buffer.js";
import type { runTmux } from "../daemon/spawn-tmux.js";

type Result = Awaited<ReturnType<typeof runTmux>>;
const ok = (stdout = ""): Result => ({ ok: true, stdout, stderr: "", code: 0 });
const fail = (stderr: string, code: number | null = 1): Result => ({ ok: false, stdout: "", stderr, code });
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const latch = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

// No fallback for ambiguous completion, other failures or errors after load.
for (const [command, failure] of [
  ["load-buffer", fail("buffer invalid", null)],
  ["load-buffer", fail("buffer invalid", 2)],
  ["load-buffer", fail("tmux timeout after 100ms: load-buffer")],
  ["load-buffer", fail("permission denied")],
  ["load-buffer", fail("no server running")],
  ["load-buffer", fail("buffer invalid\nother diagnostic")],
  ["paste-buffer", fail("buffer invalid")],
  ["paste-buffer", fail("can't find pane: %999")],
] as const) {
  const calls: string[][] = [];
  const paste = createTmuxBufferPaster(async (args) => {
    calls.push(args);
    if (args[0] === "-V") return ok("tmux 3.4");
    return args[0] === command ? failure : ok();
  });
  assert.equal((await paste("%999", "text")).ok, false);
  assert.equal(calls.filter((a) => a[0] === "load-buffer").length, 1);
  assert.ok(calls.filter((a) => a[0] !== "-V").every((a) => a.includes("-b")), `${command}: ${failure.stderr}`);
}

// A delayed successful named transaction overlaps with the rejection. A new
// caller arriving during the transition must wait too, without blocking drain.
{
  const slow = latch();
  const rejected = latch();
  const events: string[] = [];
  const buffers = new Map<string, string>();
  const landed = new Map<string, string>();
  const paste = createTmuxBufferPaster(async (args, opts) => {
    if (args[0] === "-V") return ok("tmux 3.4");
    const named = args.includes("-b");
    const buffer = named ? args[args.indexOf("-b") + 1]! : "default";
    if (args[0] === "load-buffer") {
      events.push(`load:${named ? "named" : "legacy"}:${opts!.stdin}`);
      if (named && opts!.stdin === "B") return fail("buffer invalid\n");
      buffers.set(buffer, opts!.stdin!);
      if (named && opts!.stdin === "A") await slow.promise;
      await tick();
    } else if (args[0] === "delete-buffer") {
      events.push("cleanup:B");
      rejected.release();
      return fail("buffer invalid"); // real 1.8 rejects named cleanup as well
    } else {
      const target = args.at(-1)!;
      events.push(`paste:${named ? "named" : "legacy"}:${target}`);
      landed.set(target, buffers.get(buffer)!);
      buffers.delete(buffer);
    }
    return ok();
  });
  const a = paste("%101", "A");
  const b = paste("%202", "B");
  await rejected.promise;
  const c = paste("%303", "C");
  await tick();
  assert.ok(!events.some((e) => e.startsWith("load:legacy")), "fallback must drain the slow named transaction");
  slow.release();
  assert.deepEqual(await Promise.all([a, b, c]), [{ ok: true }, { ok: true }, { ok: true }]);
  assert.deepEqual(Object.fromEntries(landed), { "%101": "A", "%202": "B", "%303": "C" });
  assert.equal(events.filter((e) => e.startsWith("load:named")).length, 2, "late arrivals cannot start named loads");
  assert.ok(events.findIndex((e) => e.startsWith("load:legacy")) > events.indexOf("paste:named:%101"));
}

// A whole concurrent burst sees an inaccurate/unknown version. All rejected
// attempts retry exactly once, under the same lock, with unchanged target/text.
for (const version of ["tmux 3.4", "tmux next"]) {
  let current = "";
  let active = 0;
  let maxActive = 0;
  let namedLoads = 0;
  let legacyLoads = 0;
  const landed = new Map<string, string>();
  const paste = createTmuxBufferPaster(async (args, opts) => {
    if (args[0] === "-V") return ok(version);
    if (args.includes("-b")) {
      if (args[0] === "load-buffer") namedLoads++;
      await tick();
      return fail("buffer invalid");
    }
    if (args[0] === "load-buffer") {
      legacyLoads++;
      current = opts!.stdin!;
      maxActive = Math.max(maxActive, ++active);
      await tick();
    } else {
      assert.deepEqual(args.slice(0, -1), ["paste-buffer", "-p", "-d", "-t"]);
      const target = args.at(-1)!;
      assert.ok(!landed.has(target), "must not paste twice");
      landed.set(target, current);
      active--;
    }
    return ok();
  });
  const panes = Array.from({ length: 20 }, (_, i) => `%${i + 10}`);
  assert.ok((await Promise.all(panes.map((pane) => paste(pane, `for ${pane}`)))).every((r) => r.ok));
  panes.forEach((pane) => assert.equal(landed.get(pane), `for ${pane}`));
  assert.equal(maxActive, 1);
  assert.equal(legacyLoads, 20);
  const before = namedLoads;
  assert.equal((await paste("%999", "later")).ok, true);
  assert.equal(namedLoads, before, "cache the observed capability for future callers");
}

// An error from the unnamed retry is final; no loop or target fallback.
{
  const calls: string[][] = [];
  const paste = createTmuxBufferPaster(async (args) => {
    calls.push(args);
    if (args[0] === "-V") return ok("tmux 3.4");
    return fail("buffer invalid");
  });
  assert.equal((await paste("%7", "text")).ok, false);
  assert.equal(calls.filter((a) => a[0] === "load-buffer").length, 2);
  assert.equal(calls.filter((a) => a[0] === "paste-buffer").length, 0);
}

console.log("tmux fallback: strict rejection gate, transition drain, 40 concurrent exact routes and no duplicate retry passed");
