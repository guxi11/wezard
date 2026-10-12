import assert from "node:assert/strict";
import { createTmuxBufferPaster } from "../daemon/tmux-buffer.js";
import { parseTmuxVersion, type runTmux } from "../daemon/spawn-tmux.js";

type Result = Awaited<ReturnType<typeof runTmux>>;
const ok = (stdout = ""): Result => ({ ok: true, stdout, stderr: "", code: 0 });
const fail = (stderr: string): Result => ({ ok: false, stdout: "", stderr, code: 1 });

// Use the same parser as spawning, including suffixes, next builds and the
// existing unknown-version policy (modern unless named load explicitly rejects it).
for (const [version, named] of [
  ["tmux 1.8", false], ["tmux 1.9a\n", false], ["tmux 2.9a", false],
  ["tmux 2.10", false], ["tmux 3.0", true], ["tmux 3.0a", true],
  ["tmux 3.4\n", true], ["tmux 3.10", true], ["tmux next-3.4", true],
  ["tmux 10.0", true], ["tmux next", true], ["", true],
] as const) {
  assert.equal(parseTmuxVersion(version) >= 3, named, version);
  const calls: string[][] = [];
  const paste = createTmuxBufferPaster(async (args, opts) => {
    calls.push(args);
    if (args[0] === "-V") return ok(version);
    if (args[0] === "load-buffer") assert.equal(opts?.stdin, "hello 中文\nsecond line");
    return ok();
  });
  assert.deepEqual(await paste("%12345", "hello 中文\nsecond line"), { ok: true });
  const buffer = named ? calls[1]!.slice(1, 3) : [];
  if (named) assert.match(buffer[1]!, /^wezard-\d+-\d+$/);
  assert.deepEqual(calls, [
    ["-V"], ["load-buffer", ...buffer, "-"],
    ["paste-buffer", ...buffer, "-p", "-d", "-t", "%12345"],
  ]);
}

for (const version of ["tmux 1.8", "tmux 3.4"]) {
  const named = version === "tmux 3.4";
  const buffers = new Map<string, string>();
  const landed = new Map<string, string>();
  const names: string[] = [];
  let probes = 0;
  let loadsInFlight = 0;
  let maxLoads = 0;
  const paste = createTmuxBufferPaster(async (args, opts) => {
    if (args[0] === "-V") { probes++; return ok(version); }
    const buffer = args.includes("-b") ? args[args.indexOf("-b") + 1]! : "default";
    if (args[0] === "load-buffer") {
      names.push(buffer);
      buffers.set(buffer, opts!.stdin!);
      maxLoads = Math.max(maxLoads, ++loadsInFlight);
      // Force different panes' loads to overlap when the implementation permits it.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    } else {
      const target = args[args.indexOf("-t") + 1]!;
      assert.ok(buffers.has(buffer), `missing buffer for ${target}`);
      landed.set(target, buffers.get(buffer)!);
      buffers.delete(buffer);
      loadsInFlight--;
    }
    return ok();
  });
  const panes = Array.from({ length: 20 }, (_, i) => `%${100 + i}`);
  assert.ok((await Promise.all(panes.map((pane) => paste(pane, `message for ${pane}`)))).every((r) => r.ok));
  panes.forEach((pane) => assert.equal(landed.get(pane), `message for ${pane}`));
  assert.equal(probes, 1, "concurrent messages share one version probe");
  assert.equal(buffers.size, 0);
  assert.equal(new Set(names).size, named ? panes.length : 1);
  assert.equal(maxLoads, named ? panes.length : 1, "modern stays concurrent; legacy serializes load through paste");
}

for (const version of ["tmux 1.8", "tmux 3.4"]) {
  for (const failedCommand of ["load-buffer", "paste-buffer"]) {
    const calls: string[][] = [];
    let failures = 1;
    const paste = createTmuxBufferPaster(async (args) => {
      calls.push(args);
      if (args[0] === "-V") return ok(version);
      return args[0] === failedCommand && failures-- > 0 ? fail("missing pane or buffer") : ok();
    });
    const [first, second] = await Promise.all([paste("%9001", "first"), paste("%9002", "second")]);
    assert.equal(first.ok, false);
    assert.equal(second.ok, true, "legacy lock must release after failure");
    const pastes = calls.filter((a) => a[0] === "paste-buffer");
    assert.deepEqual(pastes.map((a) => a.at(-1)), failedCommand === "load-buffer" ? ["%9002"] : ["%9001", "%9002"]);
    assert.equal(calls.filter((a) => a[0] === "load-buffer").length, 2, "no retry/fallback on command failure");
    assert.deepEqual(calls.filter((a) => a[0] === "delete-buffer"), version === "tmux 3.4"
      ? [["delete-buffer", ...calls.find((a) => a[0] === "load-buffer")!.slice(1, 3)]] : [], "cleanup addresses only the failed named buffer");
  }
}

{
  let probes = 0;
  const calls: string[][] = [];
  const paste = createTmuxBufferPaster(async (args) => {
    calls.push(args);
    return args[0] === "-V" ? (++probes === 1 ? fail("unavailable") : ok("tmux 1.8")) : ok();
  });
  assert.equal((await paste("", "bad")).ok, false);
  assert.equal((await paste("  ", "bad")).ok, false);
  assert.equal(calls.length, 0, "missing pane cannot use current pane");
  assert.equal((await paste("%1", "probe fails")).ok, false);
  assert.deepEqual(calls, [["-V"]], "failed probe must not guess legacy");
  assert.equal((await paste("%2", "retry probe")).ok, true);
  assert.equal(probes, 2);
}

{
  const paste = createTmuxBufferPaster(async (args) => {
    if (args[0] === "-V") return ok("tmux 3.4");
    if (args[0] === "delete-buffer") throw new Error("cleanup failed");
    return args[0] === "paste-buffer" ? fail("original paste error") : ok();
  });
  assert.deepEqual(await paste("%1", "text"), { ok: false, reason: "tmux paste-buffer failed: original paste error" });
}

console.log("tmux buffer: version/argv, 40 concurrent routes, isolation, failures and probe recovery passed");
