// Uses an isolated server (never the wizard server). To exercise real tmux 1.8:
// PATH=/path/to/tmux-1.8:$PATH npx tsx tests/tmux-buffer-live.test.ts
// Add WEZARD_TEST_TMUX_VERSION='tmux 3.4' to exercise real 1.8 after a wrong probe.
import assert from "node:assert/strict";
import { createTmuxBufferPaster } from "../daemon/tmux-buffer.js";
import { parseTmuxVersion, runTmux } from "../daemon/spawn-tmux.js";
import { sleep } from "../shared/std.js";

// tmux 1.8 puts sockets under macOS's long $TMPDIR; keep sun_path under 104 bytes.
const socket = `wzb-${process.pid}`;
const run: typeof runTmux = (args, opts) => runTmux(["-L", socket, "-f", "/dev/null", ...args], opts);
const checked = async (args: string[]): Promise<string> => {
  const result = await run(args);
  assert.ok(result.ok, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
const version = await checked(["-V"]);
const reportedVersion = process.env.WEZARD_TEST_TMUX_VERSION;
let rejectedNames = 0;
const pasteTargets: string[] = [];
const paste = createTmuxBufferPaster(async (args, opts) => {
  const result = await run(args, opts);
  if (args[0] === "-V" && result.ok && reportedVersion) return { ...result, stdout: reportedVersion };
  if (args[0] === "load-buffer" && args.includes("-b") && result.stderr.trim() === "buffer invalid") rejectedNames++;
  if (args[0] === "paste-buffer") pasteTargets.push(args.at(-1)!);
  return result;
});
const session = "buffer-test";
try {
  // Avoid the terminal's canonical input-line limit when testing large pastes.
  const reader = "stty -icanon -echo; exec cat";
  await checked(["new-session", "-d", "-s", session, "-n", "decoy", reader]);
  const paneOf = (name: string): Promise<string> => checked(["list-panes", "-t", `${session}:${name}`, "-F", "#{pane_id}"]);
  const decoy = await paneOf("decoy");
  const panes: string[] = [];
  for (const name of ["peer", "mirror"]) {
    await checked(["new-window", "-d", "-t", session, "-n", name, reader]);
    panes.push(await paneOf(name));
  }
  for (const pane of [decoy, ...panes]) {
    assert.match(pane, /^%\d+$/);
    for (let i = 0; i < 50; i++) {
      if (await checked(["display-message", "-p", "-t", pane, "#{pane_current_command}"]) === "cat") break;
      await sleep(50);
    }
    assert.equal(await checked(["display-message", "-p", "-t", pane, "#{pane_current_command}"]), "cat");
  }
  await checked(["select-window", "-t", `${session}:decoy`]);
  const sentinel = "existing-user-clipboard";
  assert.ok((await run(["load-buffer", "-"], { stdin: sentinel })).ok);

  // Peer/receipt and mirror payloads overlap, with a third pane selected.
  const messages = Array.from({ length: 12 }, (_, i) => ({
    pane: panes[i % 2]!, text: `${i % 2 ? "mirror" : "peer"}-${i}-中文\n`,
  }));
  assert.ok((await Promise.all(messages.map(({ pane, text }) => paste(pane, text)))).every((r) => r.ok));
  panes.forEach((pane) => assert.equal(pasteTargets.filter((target) => target === pane).length, 6, "each message pasted only once"));
  if (reportedVersion && parseTmuxVersion(reportedVersion) >= 3 && parseTmuxVersion(version) < 3) {
    assert.ok(rejectedNames > 0, "real old tmux must reject a named load before fallback is exercised");
  }
  const capture = (pane: string): Promise<string> => checked(["capture-pane", "-p", "-t", pane, "-S", "-200"]);
  for (let i = 0; i < 50; i++) {
    const screens = await Promise.all(panes.map(capture));
    if (messages.every(({ pane, text }) => screens[panes.indexOf(pane)]!.includes(text.trim()))) break;
    await sleep(50);
  }
  for (const pane of [decoy, ...panes]) {
    const screen = await capture(pane);
    for (const message of messages) {
      assert.equal(screen.includes(message.text.trim()), message.pane === pane, `route ${message.text.trim()} → ${pane}`);
    }
  }
  if (parseTmuxVersion(version) >= 3) {
    assert.equal(await checked(["show-buffer"]), sentinel, "named pastes preserve the user's default clipboard");
    assert.ok(!(await checked(["list-buffers"])).includes("wezard-"), "successful pastes delete their named buffers");
  }
  const decoyBefore = await capture(decoy);
  assert.equal((await paste("%999999999", "must-not-reach-current-pane\n")).ok, false);
  assert.equal(await capture(decoy), decoyBefore, "missing target must never fall back to active pane");
  if (parseTmuxVersion(version) >= 3) {
    assert.ok(!(await checked(["list-buffers"])).includes("wezard-"), "failed pastes also clean their named buffers");
    assert.equal(await checked(["show-buffer"]), sentinel, "failure cleanup preserves unrelated clipboard");
  }
  // A rejected named load can close stdin while Node is still writing. This
  // used to crash the process with unhandled EPIPE before fallback could run.
  let largeRejection = false;
  const largePaste = createTmuxBufferPaster(async (args, opts) => {
    const result = await run(args, opts);
    if (args[0] === "-V" && result.ok) return { ...result, stdout: "tmux 3.4" };
    if (args[0] === "load-buffer" && args.includes("-b") && result.stderr.trim() === "buffer invalid") largeRejection = true;
    return result;
  });
  const endMarker = "large-payload-reached-intended-pane";
  assert.equal((await largePaste(panes[0]!, "x".repeat(1024 * 1024) + `\n${endMarker}\n`)).ok, true);
  if (parseTmuxVersion(version) < 2) assert.ok(largeRejection, "exercise actual early stdin rejection on 1.8");
  for (let i = 0; i < 100 && !(await capture(panes[0]!)).includes(endMarker); i++) await sleep(50);
  assert.ok((await capture(panes[0]!)).includes(endMarker));
  assert.ok(!(await capture(panes[1]!)).includes(endMarker));
  assert.equal(await capture(decoy), decoyBefore);
  console.log(`${version}${reportedVersion ? ` (probe reported ${reportedVersion}; ${rejectedNames} named rejections)` : ""}: 12 concurrent messages hit exact panes ${panes.join(", ")}; selected decoy ${decoy} untouched; dead target rejected`);
  console.log("1 MiB stdin survived early rejection/normal load and reached only the intended pane");
} finally {
  await run(["kill-server"]);
}
