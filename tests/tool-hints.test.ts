import assert from "node:assert/strict";
import { callsInExec, execHintCalls, toolReplies } from "../shared/tool-hints.js";
import { hintOf, hintsOf, renderTurnGroup } from "../shared/detail-render.js";
import { renderMsg, dependentsOf } from "../shared/role-render.js";
import { makeDirectory } from "../shared/role-view.js";
import { EMPTY_FACTS } from "../shared/world.js";
import type { TurnDetailRecord, TurnItem } from "../shared/detail-store.js";

const wrap = (value: unknown) => JSON.stringify([{ type: "input_text", text: "Script completed" },
  { type: "input_text", text: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(value) }] }) }]);
const reply = { ok: true, name: "router-check", public: false, priority: "normal", wasBusy: false,
  turn: "td75fb5", receipt: "will reply", decision: "spawn" };
const source = 'text(await tools.mcp__wezard__dispatch({name:"router-check", task:"check model"}));';
const use: Extract<TurnItem, { t: "tool_use" }> = { t: "tool_use", toolUseId: "call", toolName: "exec", toolInput: source, ts: 1 };
const result: Extract<TurnItem, { t: "tool_result" }> = { t: "tool_result", toolUseId: "call", body: wrap(reply), ts: 2 };
const hints = hintsOf(use, result);
assert.equal(hints.length, 1);
assert.deepEqual(hints[0], { k: "handoff", via: "dispatch", state: "ok", decision: { kind: "spawn", why: "" },
  name: "router-check", turn: "td75fb5", public: false, priority: "normal", busy: false,
  kind: undefined, text: "check model", re: false, receipt: true });
const direct = { ...use, toolName: "mcp__wezard__tell_peer", toolInput: { name: "router-check", text: "check", re: "td75fb5" } };
assert.equal(hintOf(direct, { ...result, body: JSON.stringify(reply) })?.state, "ok");
assert.equal(hintOf(direct, { ...result, body: "[]" })?.state, "lost");
assert.equal(hintOf(direct, { ...result, body: '{"content":[]}' })?.state, "lost");
assert.equal(hintOf(direct, { ...result, body: wrap({ ok: false, reason: "refused" }) })?.state, "failed");
assert.equal(hintsOf(use, undefined).length, 0);
assert.deepEqual(toolReplies(wrap(reply)), [reply]);
assert.deepEqual(toolReplies({ text: JSON.stringify(reply) }), []);

// Completion order differs from source order; names, not positions, own the receipts.
const multi = 'await Promise.all([tools.mcp__wezard__tell_peer({name:"a",text:"A"}), tools.mcp__wezard__tell_peer({name:"b",text:"B"})]);';
const a = { ok: true, name: "a", public: false, turn: "ta", receipt: "yes" };
const b = { ...a, name: "b", turn: "tb" };
assert.deepEqual(execHintCalls(multi, wrap([b, a])).map((c) => c.reply.turn), ["ta", "tb"]);
assert.equal(execHintCalls(multi.replace('name:"b"', 'name:"a"'), wrap([a, { ...a, turn: "tc" }])).length, 0);
assert.equal(execHintCalls(source, wrap({ ...reply, dryRun: true })).length, 0);
assert.equal(execHintCalls(source.replace('task:', 'dryRun:true,task:'), wrap(reply)).length, 0);
assert.equal(callsInExec('// tools.mcp__wezard__dispatch({})\nconst text="tools.mcp__wezard__dispatch({})";').length, 0);
assert.equal(callsInExec('if(false) tools.mcp__wezard__dispatch({}); function f(){tools.mcp__wezard__dispatch({})}').length, 0);
assert.equal(callsInExec('tools.mcp__wezard__dispatch({task:process.exit()})').length, 0);
assert.equal(callsInExec('const task="literal"; tools.mcp__wezard__dispatch({task});').length, 1);
assert.equal(callsInExec('const a={task:"old"}; a.task="new"; tools.mcp__wezard__dispatch(a);').length, 0);
assert.equal(callsInExec('const task="outer"; {const task="inner";} tools.mcp__wezard__dispatch({task});')[0]?.toolInput.task, "outer");
assert.equal(callsInExec('not valid {{{').length, 0);

const parent: TurnDetailRecord = { kind: "turn", id: "parent", target: "user:admin", sessionId: "s", createdAt: 1,
  channel: "user:admin", items: [use, result], userQuery: "check", closed: true };
const child: TurnDetailRecord = { ...parent, id: "child", target: "user:admin#router-check", createdAt: 3, channel: "",
  from: { kind: "peer", from: "user:admin", turn: "td75fb5" }, userQuery: "check model", items: [{ t: "text", body: "RESULT: checked", ts: 4, final: true }] };
const receipt: TurnDetailRecord = { ...parent, id: "receipt", createdAt: 5,
  from: { kind: "peer", from: child.target, turn: "td75fb5", receipt: true, status: "done" }, userQuery: "RESULT: checked", items: [] };
const records = [parent, child, receipt];
const dir = makeDirectory(records, EMPTY_FACTS);
const fragment = renderMsg({ turn: parent, dir: "out", from: parent.target!, to: "human:admin", channel: "user:admin", ts: 2 } as Parameters<typeof renderMsg>[0], records, dir, 10);
assert.match(fragment.html, /class="handoff/);
assert.match(fragment.html, /data-hto="user:admin#router-check"/);
assert.match(fragment.html, /data-hch=""/);
assert.match(fragment.html, /data-gid="child:in"/);
assert.match(fragment.html, /st-done/);
assert.ok(dependentsOf(child, records).includes(parent.id));
assert.ok(dependentsOf(receipt, records).includes(parent.id));
const multiHtml = renderTurnGroup({ ...parent, items: [{ ...use, toolInput: multi }, { ...result, body: wrap([b, a]) }] }, 10).html;
assert.equal((multiHtml.match(/class="handoff/g) ?? []).length, 2);
console.log("Tool hint wrapping, pairing, rendering and receipt association checks passed");
