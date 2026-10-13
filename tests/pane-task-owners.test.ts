import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { loadWizardStore } from "../daemon/wizard.js";

// Use the actual sweep's owner selection with the real persisted wizard store.
// Task files keep target keys, which must continue to work after a rename.
const source = readFileSync("daemon/index.ts", "utf8");
const start = source.indexOf("      const taskOwners = new Set(");
const end = source.indexOf("      const pendingSids", start);
assert.ok(start > 0 && end > start);
const select = new Function("tasks", "wizardStore", ts.transpileModule(
  source.slice(start, end) + "\nreturn taskOwners;",
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText);
const dir = mkdtempSync(join(tmpdir(), "pane-task-owners-"));
try {
  const store = loadWizardStore(join(dir, "wizards.json"));
  const root = "user:test#root", worker = "user:test#worker", otherBot = "user:test~other#worker";
  store.upsert(root, { name: "root-renamed" });
  store.upsert(worker, { name: "worker" });
  store.upsert(otherBot, { name: "other-worker" });
  const owners = (rows: { owner: string; enabled: boolean }[]): Set<string> => select({ list: () => rows }, () => store);
  assert.deepEqual([...owners([{ owner: root, enabled: true }, { owner: worker, enabled: true }])], [root, worker]);
  store.rename(root, "root-renamed-again");
  assert.ok(owners([{ owner: root, enabled: true }]).has(root), "target-key tasks survive wizard rename");
  assert.deepEqual([...owners([{ owner: ".root-renamed-again", enabled: true }])], [root], "legacy names remain supported");
  assert.deepEqual([...owners([{ owner: otherBot, enabled: true }])], [otherBot], "bot suffix remains part of the owner identity");
  assert.equal(owners([{ owner: root, enabled: false }, { owner: "unknown", enabled: true }]).size, 0);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("pane task owners: target keys, renamed owners, legacy names, bot isolation and disabled tasks passed");
