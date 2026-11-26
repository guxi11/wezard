// `wezard audit <arg>`: 名字 (.name) 优先, 其次旧的 #slot 形式。运行: npx tsx tests/audit-pick.test.ts
import assert from "node:assert/strict";
import { pickMirror } from "../daemon/audit.js";

const mirrors = [
  { sessionId: "a", jsonlPath: "a", target: "chat:wr1" },
  { sessionId: "b", jsonlPath: "b", target: "chat:wr1#fix" },
  { sessionId: "c", jsonlPath: "c", target: "chat:wr2#fix" },
];
const mt: Record<string, number> = { a: 1, b: 2, c: 3 };
const mtimeOf = (m: { sessionId: string }) => mt[m.sessionId]!;
const names: Record<string, string> = { uma: "chat:wr1#fix" };
const byName = (n: string) => names[n.replace(/^[.@]+/, "").toLowerCase()];

assert.equal(pickMirror(mirrors, ".Uma", byName, mtimeOf)?.sessionId, "b", ".name → that wizard's exact target (not the newer #fix slot of another chat)");
assert.equal(pickMirror(mirrors, "uma", byName, mtimeOf)?.sessionId, "b", "bare name works too");
assert.equal(pickMirror(mirrors, "fix", byName, mtimeOf)?.sessionId, "c", "no such name → legacy slot, newest mtime wins");
assert.equal(pickMirror(mirrors, "#fix", byName, mtimeOf)?.sessionId, "c", "#slot still accepted");
assert.equal(pickMirror(mirrors, "nobody", byName, mtimeOf), null);
assert.equal(pickMirror(mirrors.slice(0, 1), ".uma", byName, mtimeOf), null, "named wizard has no live mirror → null, no slot guess");
console.log("audit pick checks passed");
