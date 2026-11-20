// 群名兜底 + 会话下拉 key + world 不再输出 edges。
import assert from "node:assert/strict";
import { buildWorld, withChatNameFallback, EMPTY_FACTS, type WorldFacts } from "../shared/world.js";
import { spanKey } from "../shared/role-view.js";

const w = (target: string, name: string, cwd: string) => ({ target, name, cwd }) as WorldFacts["wizards"][number];
const f: WorldFacts = {
  ...EMPTY_FACTS, absent: false,
  chatNames: { "chat:named": "已有名" },
  wizards: [
    w("chat:named", "x", "/a/ignored"),
    w("chat:g1", "Iris", "/home/u/proj"),          // 默认会话: 用它的名字
    w("chat:g1#s2", "Henry", "/home/u/other"),
    w("chat:g2#s1", "Frank", "/home/u/wezard/"),   // 只有 slot: 退到工作区 basename
  ],
};
const g = withChatNameFallback(f).chatNames;
assert.equal(g["chat:named"], "已有名", "已有名字不动");
assert.equal(g["chat:g1"], "Iris", "默认 wizard 名");
assert.equal(g["chat:g2"], "wezard", "工作区 basename");

assert.equal(spanKey({ sessionId: "", start: 1234 }), "start:1234", "空 sid 段用起始时刻");
assert.equal(spanKey({ sessionId: "s1", start: 1 }), "s1");

assert.ok(!("edges" in buildWorld([], EMPTY_FACTS, { base: "chat:x", self: "chat:x" }, Date.now())), "world 不再带 edges");
console.log("world-chat-name-fallback: ok");
