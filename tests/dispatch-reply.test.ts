import assert from "node:assert/strict";
import { present } from "../mcp/output.js";
import { scrubUndefinedName, withMessageFooter } from "../shared/message-footer.js";

// 派活回包必须自带一句可直接复述的人话, 且任何字段都不能是 "undefined" / "null" 拼出来的句子 ——
// 群里「已经交给 .undefined」的实录就是从这里漏出去的 (模型在 REPL 拿到的是字符串, 取 .name 得 undefined)。

const artifact = (value: unknown): string | undefined => /undefined|null/.exec(JSON.stringify(value))?.[0];

const check = (label: string, out: unknown, said: string): void => {
  const bad = artifact(out);
  assert.equal(bad, undefined, `${label}: 回包里有 ${bad} — ${JSON.stringify(out)}`);
  assert.equal((out as { said?: unknown }).said, said, `${label}: said`);
};

check("chat_ask 单人", present("chat_ask", { ok: true, room: "dm:a|b", id: "x.1", seq: 1, name: "TessDavis", names: ["TessDavis"], woke: [] }),
  "已交给 .TessDavis");
check("chat_ask 多人", present("chat_ask", { ok: true, id: "x.1", seq: 1, names: ["AliceJones", "UmaEvans"], woke: [] }),
  "已交给 .AliceJones, .UmaEvans");
check("chat_ask 点人", present("chat_ask", { ok: true, id: "x.1", seq: 1, names: ["human:T03880027A"], woke: [] }),
  "已交给 人 T03880027A");
// 名字没落定时的人话, 不是「已经交给 .undefined」。
check("chat_ask 无名", present("chat_ask", { ok: true, id: "x.1", seq: 1, woke: [] }),
  "已交给一个刚起的执行者 (名字稍后出现在名册里)");
// daemon 说成功、名字确实缺席 (旧回包 / 别的分支): 同样不能拼出 undefined。
check("chat_ask undefined", present("chat_ask", { ok: true, id: "x.1", seq: 1, name: undefined, woke: [] }),
  "已交给一个刚起的执行者 (名字稍后出现在名册里)");

check("delegate", present("delegate", { ok: true, name: "UmaEvans", event: "e.1", queued: true, decision: "spawn", tier: "standard" }),
  "已交给 .UmaEvans");
check("delegate 无名", present("delegate", { ok: true, event: "e.1", queued: true, decision: "spawn" }),
  "已交给一个刚起的执行者 (名字稍后出现在名册里)");
check("spawn_wizard", present("spawn_wizard", { ok: true, name: "UmaEvans" }), "已起了 .UmaEvans");
check("spawn_wizard 无名", present("spawn_wizard", { ok: true }), "已起了一个新的执行者 (名字稍后出现在名册里)");
check("clone_wizard", present("clone_wizard", { ok: true, name: "UmaEvans" }), "已起了 .UmaEvans");

// dryRun 没派活, 不给 said; 有名字时字段照旧是落定名。
const dry = present("delegate", { ok: true, dryRun: true, decision: "existing", name: "AliceJones", reason: "你点名了 AliceJones" }) as Record<string, unknown>;
assert.equal(dry.said, undefined);
assert.equal(dry.name, "AliceJones");
assert.equal(artifact(dry), undefined);

// 非派活工具不受影响。
assert.deepEqual(present("chat_say", { ok: true, room: "r", id: "x.1", seq: 1, name: "ignored" }),
  { ok: true, room: "r", id: "x.1", seq: 1 });

// 出站兜底: 把拼坏的 .undefined 换成一句人话 (变量名 / 代码里的 `.undefined` 不动)。
assert.equal(scrubUndefinedName("已经交给 .undefined 评估，它还没交回。"), "已经交给 一个执行者 评估，它还没交回。");
assert.equal(scrubUndefinedName("已交给 .TessDavis 深入思考"), "已交给 .TessDavis 深入思考");
assert.equal(scrubUndefinedName("d.undefinedFlag 是代码"), "d.undefinedFlag 是代码");
assert.ok(!withMessageFooter("已经交给 .undefined 评估").includes(".undefined"));

console.log("Dispatch reply text passed");
