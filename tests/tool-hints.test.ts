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
  event: "td75fb5", eventId: "route:td75fb5:input:93206de4", queued: true, receipt: "will reply", decision: "spawn" };
const source = 'text(await tools.mcp__wezard__delegate({name:"router-check", task:"check model"}));';
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
const a = { ok: true, name: "a", public: false, event: "ta", eventId: "route:ta:input:1", queued: true, receipt: "yes" };
const b = { ...a, name: "b", event: "tb", eventId: "route:tb:input:1" };
assert.deepEqual(execHintCalls(multi, wrap([b, a])).map((c) => c.reply.event), ["ta", "tb"]);
assert.equal(execHintCalls(multi.replace('name:"b"', 'name:"a"'), wrap([a, { ...a, event: "tc", eventId: "route:tc:input:1" }])).length, 0);
assert.equal(execHintCalls(source, wrap({ ...reply, dryRun: true })).length, 0);
assert.equal(execHintCalls(source.replace('task:', 'dryRun:true,task:'), wrap(reply)).length, 0);
assert.equal(callsInExec('// tools.mcp__wezard__delegate({})\nconst text="tools.mcp__wezard__delegate({})";').length, 0);
assert.equal(callsInExec('if(false) tools.mcp__wezard__delegate({}); function f(){tools.mcp__wezard__delegate({})}').length, 0);
assert.equal(callsInExec('tools.mcp__wezard__delegate({task:process.exit()})').length, 0);
assert.equal(callsInExec('const task="literal"; tools.mcp__wezard__delegate({task});').length, 1);
assert.equal(callsInExec('const a={task:"old"}; a.task="new"; tools.mcp__wezard__delegate(a);').length, 0);
assert.equal(callsInExec('const task="outer"; {const task="inner";} tools.mcp__wezard__delegate({task});')[0]?.toolInput.task, "outer");
assert.equal(callsInExec('not valid {{{').length, 0);

const parent: TurnDetailRecord = { kind: "turn", id: "parent", target: "user:admin", sessionId: "s", createdAt: 1,
  channel: "user:admin", items: [use, result], userQuery: "check", closed: true };
const child: TurnDetailRecord = { ...parent, id: "child", target: "user:admin#router-check", createdAt: 3, channel: "",
  from: { kind: "peer", from: "user:admin", event: "td75fb5" }, userQuery: "check model", items: [{ t: "text", body: "RESULT: checked", ts: 4, final: true }] };
const receipt: TurnDetailRecord = { ...parent, id: "receipt", createdAt: 5,
  from: { kind: "peer", from: child.target, event: "td75fb5", receipt: true, status: "done" }, userQuery: "RESULT: checked", items: [] };
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

// CodeBuddy PTC/REPL 形态: 一切调用包进 REPL 的 code, 内层写 mcp_wezard.x(…),
// 回包是 {result, stdout, stderr} 壳 —— 三层都得认, hint 才回得来。
const tellReply = { ok: true, name: "router-check", public: false, priority: "normal", wasBusy: false,
  event: "td75fb5", eventId: "route:td75fb5:input:93206de4", queued: true, receipt: "will reply" };
const replSource = 'const r = await mcp_wezard.tell_peer({name:".router-check", text:"check model"});\nreturn typeof r === "string" ? r : JSON.stringify(r);';
const envelope = JSON.stringify({ result: JSON.stringify(tellReply), stdout: "", stderr: "" });
assert.deepEqual(toolReplies(envelope), [tellReply]);
assert.deepEqual(toolReplies(JSON.stringify({ stdout: "ls output", stderr: "" })), []);
assert.deepEqual(execHintCalls(replSource, envelope), [{ toolName: "mcp__wezard__tell_peer", toolInput: { name: ".router-check", text: "check model" }, reply: tellReply }]);
const replUse: Extract<TurnItem, { t: "tool_use" }> = { t: "tool_use", toolUseId: "rc", toolName: "REPL", toolInput: { code: replSource }, ts: 1 };
assert.equal(hintsOf(replUse, { t: "tool_result", toolUseId: "rc", body: envelope, ts: 2 })[0]?.name, "router-check");
assert.equal(hintsOf(replUse, undefined).length, 0);

// console.log(回包) 而不 return: 壳里只有 stdout (没有 result, 也没有 Bash 的 exitCode)。
// 逐行整行解析才认得出这次调用, 提示行才回来。
const printed = JSON.stringify({ stdout: JSON.stringify(tellReply) + "\n", stderr: "" });
assert.deepEqual(toolReplies(printed), [tellReply]);
assert.equal(hintsOf(replUse, { t: "tool_result", toolUseId: "rc", body: printed, ts: 2 }).length, 1);
// 只认整行: 行内夹着 JSON 的普通输出不是回执。
assert.deepEqual(toolReplies(JSON.stringify({ stdout: "note " + JSON.stringify(tellReply), stderr: "" })), []);
// Bash 自己的返回带 exitCode, 它的 stdout 是命令输出, 不是回包壳。
assert.deepEqual(toolReplies(JSON.stringify({ stdout: JSON.stringify(tellReply) + "\n", stderr: "", exitCode: 0, signal: null })), []);
// 同一个调用还有别的静态写法: 沙箱把命名空间拆成两段 (`mcp.wezard.x`), 也有人先把工具或
// 命名空间存进一个名字再调 (`const tp = mcp.wezard.tell_peer` / 解构)。认不出就等于 hint 丢了。
const dotted = 'const r = await mcp.wezard.tell_peer({ name: ".router-check", text: "check model", return: "transfer" }); return r;';
assert.deepEqual(callsInExec(dotted), [{ toolName: "mcp__wezard__tell_peer",
  toolInput: { name: ".router-check", text: "check model", return: "transfer" } }]);
assert.equal(callsInExec('const { tell_peer: tp } = mcp.wezard; await tp({ name: ".a", text: "x" });').length, 1);
assert.equal(callsInExec('const { tell_peer } = mcp.wezard; await tell_peer({ name: ".a", text: "x" });')[0]?.toolName, "mcp__wezard__tell_peer");
assert.equal(callsInExec('const tp = mcp.wezard.tell_peer; await tp({ name: ".a", text: "x" });').length, 1);
assert.equal(callsInExec('const ns = mcp.wezard; await ns.tell_peer({ name: ".a", text: "x" });').length, 1);
assert.equal(callsInExec('await mcp["wezard"].tell_peer?.({ name: ".a", text: "x" });').length, 1);
// 换成别的成员链就不是 wezard 的调用, 不能跟着认。
assert.equal(callsInExec('const tp = other.tool; await tp({ name: ".a", text: "x" });').length, 0);
// 整件交出 (return:"transfer") 的标记也随入参一起来。
const dottedUse: Extract<TurnItem, { t: "tool_use" }> = { t: "tool_use", toolUseId: "dot", toolName: "REPL", toolInput: { code: dotted }, ts: 1 };
const transferred = hintsOf(dottedUse, { t: "tool_result", toolUseId: "dot", body: envelope, ts: 2 });
assert.equal(transferred.length, 1);
assert.equal(transferred[0]?.k === "handoff" && transferred[0].handed, true);
assert.equal(transferred[0]?.k === "handoff" && transferred[0].receipt, false);
// 出站工具 (chat_reply / chat_say / notify / send_file): 直调与 REPL 外壳都出一行「发到哪、发了什么」,
// 标题不摆源码, 调成了就不再摆回包 JSON; 交付细节 (覆盖占位) 只进悬停说明, 不上界面。
const replyUse: Extract<TurnItem, { t: "tool_use" }> = { t: "tool_use", toolUseId: "cr", toolName: "mcp__wezard__chat_reply", toolInput: { re: "h1", text: "看过了, 是配置问题" }, ts: 1 };
const replyRes = { t: "tool_result" as const, toolUseId: "cr", body: JSON.stringify({ ok: true, delivered: "placeholder", event: "e1", chat: "sanitizer" }), ts: 2 };
const rh = hintsOf(replyUse, replyRes);
assert.deepEqual(rh.map((h) => h.k === "post" && [h.via, h.chats, h.delivered, h.state, h.text, h.re]), [["reply", ["sanitizer"], "placeholder", "ok", "看过了, 是配置问题", "h1"]]);
// 真实形态 (2026-11-17 study 答 hi): REPL 里 const r = await mcp.wezard.chat_reply(...); return JSON.stringify(r) —— 回包被包了三层
const code = 'const r = await mcp.wezard.chat_reply({ re: "hf00", text: "在，我是这个群的管家 study。" });\nreturn JSON.stringify(r);';
const replRepl: Extract<TurnItem, { t: "tool_use" }> = { t: "tool_use", toolUseId: "cr2", toolName: "REPL", toolInput: { code, description: "回复 hi" }, ts: 1 };
const realRes = { t: "tool_result" as const, toolUseId: "cr2", body: JSON.stringify({ result: JSON.stringify(JSON.stringify({ ok: true, delivered: "placeholder", event: "edf2f44", chat: "chat:wrX" })), stdout: "", stderr: "" }), ts: 2 };
const ph = hintsOf(replRepl, realRes);
assert.equal(ph.length === 1 && ph[0]!.k === "post" && ph[0]!.via, "reply", "REPL 外壳里的 chat_reply 认得出");
const turnOfCalls = (items: TurnItem[]) => renderTurnGroup({ kind: "turn", id: "tr", createdAt: 0, updatedAt: 3, closed: true, items } as TurnDetailRecord).html;
const replyHtml = turnOfCalls([replRepl, realRes]);
const summary = replyHtml.match(/<summary class="tool-summary">([\s\S]*?)<\/summary>/)?.[1] ?? "";
assert.ok(summary.includes("回复 hi · chat_reply") && !summary.includes("const r") && !summary.includes("await"), "标题 = 说明 + 调了哪个工具, 不摆源码: " + summary);
assert.ok(!replyHtml.includes('class="tool-result-line"'), "调成了不再摆回包 JSON 预览行");
assert.ok(replyHtml.includes("回复") && replyHtml.includes("未命名群") && !replyHtml.includes(">chat:wrX<"), "去处翻成群名, 不摆 base");
assert.ok(!/>覆盖占位</.test(replyHtml) && replyHtml.includes("替换了群里那条「处理中」的气泡"), "交付细节只进悬停说明");
assert.ok(replyHtml.includes("在，我是这个群的管家 study。"), "发了什么在行内");
// chat_reply 不带 text = 不答 (passed)
const passUse: Extract<TurnItem, { t: "tool_use" }> = { t: "tool_use", toolUseId: "cp", toolName: "mcp__wezard__chat_reply", toolInput: { re: "h3" }, ts: 1 };
const passHtml = turnOfCalls([passUse, { t: "tool_result", toolUseId: "cp", body: JSON.stringify({ ok: true, delivered: "passed", event: "e3", chat: "wezard" }), ts: 2 }]);
assert.ok(passHtml.includes("不答") && passHtml.includes("未发言"));
// chat_say / notify / send_file
const sayH = hintsOf({ t: "tool_use", toolUseId: "cs", toolName: "mcp__wezard__chat_say", toolInput: { text: "我先去看日志" }, ts: 1 }, { t: "tool_result", toolUseId: "cs", body: JSON.stringify({ ok: true, chat: "sanitizer", sent: 6 }), ts: 2 });
assert.deepEqual(sayH.map((h) => h.k === "post" && [h.via, h.chats, h.text]), [["say", ["sanitizer"], "我先去看日志"]]);
const ntH = hintsOf({ t: "tool_use", toolUseId: "nt", toolName: "mcp__wezard__notify", toolInput: { markdown: "**进展**: 已定位" }, ts: 1 }, { t: "tool_result", toolUseId: "nt", body: JSON.stringify({ ok: true, sent: ["wezard"], held: ["微信群"] }), ts: 2 });
assert.deepEqual(ntH.map((h) => h.k === "post" && [h.via, h.chats, h.held]), [["notify", ["wezard", "微信群"], ["微信群"]]]);
const fileCode = 'await mcp.wezard.send_file({ path: "/tmp/a/shot.png", kind: "image" })';
const fH = hintsOf({ t: "tool_use", toolUseId: "sf", toolName: "REPL", toolInput: { code: fileCode }, ts: 1 }, { t: "tool_result", toolUseId: "sf", body: JSON.stringify({ result: JSON.stringify({ ok: true, sent: "wezard", kind: "image", name: "shot.png", bytes: 10 }), stdout: "", stderr: "" }), ts: 2 });
assert.deepEqual(fH.map((h) => h.k === "post" && [h.via, h.chats, h.file]), [["file", ["wezard"], "shot.png · image"]]);
// 失败的调用: 照旧保留结果预览, 提示行写没成
const failHtml = turnOfCalls([replyUse, { t: "tool_result", toolUseId: "cr", body: "chat_reply failed: 认不出这条义务", ts: 2 }]);
assert.ok(failHtml.includes('class="tool-result-line"') && failHtml.includes("没成"));
// peers.ts 靠 tools.* 这一段读 exec 里的命令, 别把 code-mode 的容器形态弄丢。
assert.equal(callsInExec('tools.exec_command({cmd:"ls"})', () => true)[0]?.toolName, "exec_command");
console.log("Tool hint wrapping, pairing, rendering and receipt association checks passed");