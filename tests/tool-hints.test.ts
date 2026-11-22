import assert from "node:assert/strict";
import { callsInExec, execHintCalls, toolReplies } from "../shared/tool-hints.js";
import { hintOf, hintsOf, renderTurnGroup } from "../shared/detail-render.js";
import { renderTurnBox } from "../shared/role-render.js";
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
// chat_ask 是唯一的派活口子: 回包只认 room / id (旧回执字段不在了)。
const askReply = { ok: true, room: "dm:wa|wb", id: "h1.2", name: "router-check" };
const direct = { ...use, toolName: "mcp__wezard__chat_ask", toolInput: { to: "router-check", text: "check" } };
assert.equal(hintOf(direct, { ...result, body: JSON.stringify(askReply) })?.state, "ok");
assert.equal(hintOf(direct, { ...result, body: "[]" })?.state, "lost");
assert.equal(hintOf(direct, { ...result, body: '{"content":[]}' })?.state, "lost");
assert.equal(hintOf(direct, { ...result, body: wrap({ ok: false, reason: "refused" }) })?.state, "failed");
assert.equal(hintsOf(use, undefined).length, 0);
assert.deepEqual(toolReplies(wrap(reply)), [reply]);
assert.deepEqual(toolReplies({ text: JSON.stringify(reply) }), []);

// Completion order differs from source order; names, not positions, own the receipts.
const multi = 'await Promise.all([tools.mcp__wezard__chat_ask({to:"a",text:"A"}), tools.mcp__wezard__chat_ask({to:"b",text:"B"})]);';
const a = { ok: true, room: "dm:wa|wz", id: "aaa.1", name: "a" };
const b = { ...a, id: "aaa.2", name: "b" };
assert.deepEqual(execHintCalls(multi, wrap([b, a])).map((c) => c.reply.id), ["aaa.1", "aaa.2"]);
assert.equal(execHintCalls(multi.replace('to:"b"', 'to:"a"'), wrap([a, { ...a, id: "aaa.3" }])).length, 0);
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
// room 模型之后, 一条 room 消息点开的是**那一轮的过程框** (子 agent 内联在父轮里)。
const html = renderTurnBox(parent, records, 10);
assert.match(html, /class="handoff/);
assert.match(html, /router-check/);
assert.match(html, /check model/);
// 子 agent 的轮 (agent.parentTurnId) 内联在父轮里; peer 派出来的那一轮是它自己的
// room 消息, 不在父轮的过程框里 —— 这里没有 agent 标记, 所以只有父轮自己。
assert.ok(!html.includes("t:child"), "peer 轮不并进父轮");
const multiHtml = renderTurnGroup({ ...parent, items: [{ ...use, toolInput: multi }, { ...result, body: wrap([b, a]) }] }, 10).html;
assert.equal((multiHtml.match(/class="handoff/g) ?? []).length, 2);

// room 模型: delegate 回包不带 public, 只带落地的 room —— 进没进群由 room 判 (dm / adhoc = 不进群)。
// 只标「进群」这一种; 落在 dm 的派活不再挂「公开」(曾经 delegate 无 public 回包一律被当成公开) 也不挂「私聊」。
const dlg = { ...use, toolName: "mcp__wezard__delegate", toolInput: { task: "check model" } };
const dlgReply = (room: string) => ({ ok: true, room, id: "e0.1", event: "e0.1", name: "router-check", queued: true, decision: "spawn", reason: "无合适候选" });
const dmHint = hintOf(dlg, { ...result, body: JSON.stringify(dlgReply("dm:wa|wb")) });
assert.equal(dmHint?.k === "handoff" && dmHint.public, false);
const grpHint = hintOf(dlg, { ...result, body: JSON.stringify(dlgReply("chat:wrX")) });
assert.equal(grpHint?.k === "handoff" && grpHint.public, true);
assert.equal((h => h?.k === "handoff" && h.public)(hintOf(dlg, undefined)), false, "还没回包时不预判成进群");
const tagsOf = (room: string) => renderTurnGroup({ ...parent, items: [dlg, { ...result, body: JSON.stringify(dlgReply(room)) }] }, 10).html;
const dmHtml = tagsOf("adhoc:ab12");
assert.ok(!/公开|私聊|进群/.test(dmHtml), "dm / adhoc 派活不挂公开 / 私聊 标签");
assert.match(dmHtml, /ho-tag pri" title="无合适候选">新生/);
assert.match(dmHtml, /ho-text/, "私下派的原文收在 chevron 下");
assert.match(tagsOf("chat:wrX"), /ho-tag pub"[^>]*>进群</);
// chat_ask 同一口径 (回包 room 判)。
assert.equal((h => h?.k === "handoff" && h.public)(hintOf(direct, { ...result, body: JSON.stringify({ ...askReply, room: "chat:wrX" }) })), true);

// CodeBuddy PTC/REPL 形态: 一切调用包进 REPL 的 code, 内层写 mcp_wezard.x(…),
// 回包是 {result, stdout, stderr} 壳 —— 三层都得认, hint 才回得来。
const tellReply = { ok: true, room: "dm:wa|wb", id: "h1.2", name: "router-check" };
const replSource = 'const r = await mcp_wezard.chat_ask({to:".router-check", text:"check model"});\nreturn typeof r === "string" ? r : JSON.stringify(r);';
const envelope = JSON.stringify({ result: JSON.stringify(tellReply), stdout: "", stderr: "" });
assert.deepEqual(toolReplies(envelope), [tellReply]);
assert.deepEqual(toolReplies(JSON.stringify({ stdout: "ls output", stderr: "" })), []);
assert.deepEqual(execHintCalls(replSource, envelope), [{ toolName: "mcp__wezard__chat_ask", toolInput: { to: ".router-check", text: "check model" }, reply: tellReply }]);
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
const dotted = 'const r = await mcp.wezard.chat_ask({ to: ".router-check", text: "check model" }); return r;';
assert.deepEqual(callsInExec(dotted), [{ toolName: "mcp__wezard__chat_ask",
  toolInput: { to: ".router-check", text: "check model" } }]);
assert.equal(callsInExec('const { chat_ask: tp } = mcp.wezard; await tp({ to: ".a", text: "x" });').length, 1);
assert.equal(callsInExec('const { chat_ask } = mcp.wezard; await chat_ask({ to: ".a", text: "x" });')[0]?.toolName, "mcp__wezard__chat_ask");
assert.equal(callsInExec('const tp = mcp.wezard.chat_ask; await tp({ to: ".a", text: "x" });').length, 1);
assert.equal(callsInExec('const ns = mcp.wezard; await ns.chat_ask({ to: ".a", text: "x" });').length, 1);
assert.equal(callsInExec('await mcp["wezard"].chat_ask?.({ to: ".a", text: "x" });').length, 1);
// 换成别的成员链就不是 wezard 的调用, 不能跟着认。
assert.equal(callsInExec('const tp = other.tool; await tp({ to: ".a", text: "x" });').length, 0);
// 一次 chat_ask 出一行移交提示 (room 口子没有「整件交出」这个参数了)。
const dottedUse: Extract<TurnItem, { t: "tool_use" }> = { t: "tool_use", toolUseId: "dot", toolName: "REPL", toolInput: { code: dotted }, ts: 1 };
const asked = hintsOf(dottedUse, { t: "tool_result", toolUseId: "dot", body: envelope, ts: 2 });
assert.equal(asked.length, 1);
assert.equal(asked[0]?.k, "handoff");
assert.equal(asked[0]?.k === "handoff" && asked[0].name, "router-check");
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
// 调成了的回复: 「谁 → 群 → 谁」搬到气泡头上了, 过程框里连摘要行都不留 (去处不再重复, 也不泄 base)
assert.ok(!replyHtml.includes('class="handoff') && !replyHtml.includes("未命名群") && !replyHtml.includes("chat:wrX"), "成功的回复在过程框里不再有发送摘要行");
assert.ok(!replyHtml.includes("在，我是这个群的管家 study。"), "回复正文就是下面的气泡, 过程里不再重复");
// 状态不明 (没回包) 的回复: 仍可见, 不能因为隐藏成功行把「不确定」也藏了
const lostHtml = turnOfCalls([replyUse]);
assert.ok(lostHtml.includes("handoff") && lostHtml.includes("回复"), "调用中 / 无回包仍留摘要行");
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