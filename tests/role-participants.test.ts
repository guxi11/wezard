import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { createChatRoutes, HORIZON_MS, type SimpleHandler } from "../shared/chat-http.js";
import type { DetailStore, TurnDetailRecord } from "../shared/detail-store.js";
import { EMPTY_FACTS, type WorldFactWizard } from "../shared/world.js";

const now = Date.now();
const parent = "user:ZhangYuanYuan";
const child = `${parent}#cfg-tiers`;
const wizard = (target: string, name: string, at: number): WorldFactWizard => ({
  target, name, description: "", chat: "wezard-old", cwd: "", model: "", cli: "codex",
  busy: false, alive: false, bornAt: at, lastActivity: at, summary: "",
});
const turn: TurnDetailRecord = {
  kind: "turn", id: "peer-turn", createdAt: now - 1000, updatedAt: now - 500,
  target: child, sessionId: "codex-session", channel: "", closed: true,
  from: { kind: "peer", from: parent }, userQuery: "Check tiers",
  items: [{ t: "text", body: "RESULT: checked", ts: now - 500, final: true }],
};
const records: TurnDetailRecord[] = [turn, {
  ...turn, id: "human-turn", channel: parent, from: undefined, speaker: "ZhangYuanYuan", userQuery: "Human question",
}];
const store = { get: (id: string) => records.find((r) => r.id === id), list: () => records } as DetailStore;
const facts = {
  ...EMPTY_FACTS, absent: undefined,
  wizards: [wizard(parent, "wezard-old", now - 2 * HORIZON_MS),
    { ...wizard(child, "cfg-tiers", now), parent },
    wizard("user:unused", "unused", now - 2 * HORIZON_MS)],
};
const routes = createChatRoutes(store, () => facts);
const request = (handler: SimpleHandler, query: string): Promise<any> => new Promise((resolve, reject) => {
  const res = { setHeader() {}, end: (body: string) => {
    try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
  } } as unknown as ServerResponse;
  handler({ headers: {} } as IncomingMessage, res, new URL(`http://localhost/${query}`));
});
const query = `?id=peer-turn&role=${encodeURIComponent(child)}`;
const role = await request(routes.role, query);
assert.equal(role.ok, true);
assert.equal(role.role.id, child);
assert.equal(role.role.parent.name, "wezard-old");
const dm = role.convs.find((c: any) => c.key === `p:${parent}`);
assert.equal(dm.name, "wezard-old");
assert.equal(dm.count, 2);
assert.ok(dm.status, "the peer remains a wizard even without recent own turns");
const group = role.convs.find((c: any) => c.key === `c:${parent}`);
assert.equal(group.subs[0].role, "human:ZhangYuanYuan");
assert.equal(group.subs[0].name, "ZhangYuanYuan", "a real human speaker must remain separate from the wizard with the same principal");
const world = await request(routes.world, query);
assert.equal(world.nodes.find((n: any) => n.target === parent)?.name, "wezard-old");
assert.equal(world.nodes.some((n: any) => n.target === "user:unused"), false);
const msgs = await request(routes.msgs, `${query}&conv=${encodeURIComponent(`p:${parent}`)}&viewpoint=${encodeURIComponent(parent)}`);
assert.equal(msgs.ok, true);
assert.ok(JSON.stringify(msgs).includes("wezard-old"));
assert.ok(!JSON.stringify(msgs).includes(".user:ZhangYuanYuan"));
console.log("Role participant identity checks passed");
