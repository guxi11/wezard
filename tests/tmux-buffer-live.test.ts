// Uses an isolated server (never the wizard server). To exercise real tmux 1.8:
// PATH=/path/to/tmux-1.8:$PATH npx tsx tests/tmux-buffer-live.test.ts
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
const paste = createTmuxBufferPaster(run);
const session = "buffer-test";
try {
  await checked(["new-session", "-d", "-s", session, "-n", "decoy", "exec cat"]);
  const paneOf = (name: string): Promise<string> => checked(["list-panes", "-t", `${session}:${name}`, "-F", "#{pane_id}"]);
  const decoy = await paneOf("decoy");
  const panes: string[] = [];
  for (const name of ["peer", "mirror"]) {
    await checked(["new-window", "-d", "-t", session, "-n", name, "exec cat"]);
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
  console.log(`${version}: 12 concurrent messages hit exact panes ${panes.join(", ")}; selected decoy ${decoy} untouched; dead target rejected`);
} finally {
  await run(["kill-server"]);
}
