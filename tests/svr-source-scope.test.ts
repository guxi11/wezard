// 多 daemon 共 svr 的隔离: 票据只看同一来源 (src) 的记录 / 快照 / 本地账本。
// 运行: npx tsx tests/svr-source-scope.test.ts
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { createChatRoutes, type SimpleHandler } from "../shared/chat-http.js";
import type { DetailRecord, DetailStore, TurnDetailRecord } from "../shared/detail-store.js";
import type { WorldFacts } from "../shared/world.js";
import { H, W, room, say, uid } from "./room-fixture.js";

const now = Date.now();
// 两个 daemon 接同一个群: target 与 room id 都一样, 只有 src 不同 —— 正是合并视图会互相覆盖的情形。
const T = "chat:wrG";
const turnOf = (id: string, src: string | undefined, text: string): TurnDetailRecord => ({
  kind: "turn", id, createdAt: now - 4000, updatedAt: now - 1000, closed: true,
  target: T, sessionId: "s-" + id, channel: T, userQuery: "问 " + text,
  items: [{ t: "text", body: text, ts: now - 1000, final: true }],
  ...(src ? { src } : {}),
} as TurnDetailRecord);
const recs: DetailRecord[] = [turnOf("tA", "A", "来自A"), turnOf("tB", "B", "来自B"), turnOf("tL", undefined, "旧记录")];
const store = { get: (id: string) => recs.find((r) => r.id === id), list: () => recs } as unknown as DetailStore;

const wiz = (name: string, u: string) => ({ target: T, name, uid: u, description: "", chat: "群G", cwd: "/w", model: "x", cli: "claude", busy: false, alive: true, bornAt: now - 9000, lastActivity: now, summary: "" });
const factsOf = (name: string, u: string): WorldFacts => ({ wizards: [wiz(name, u)], plans: [], schedules: [], chatNames: { [T]: "群G" }, names: { [u]: name } } as WorldFacts);
const asked: (string | undefined)[] = [];
const facts = (src?: string): WorldFacts => {
  asked.push(src);
  return src === "A" ? factsOf("aliceA", uid(1)) : src === "B" ? factsOf("aliceB", uid(2)) : factsOf("merged", uid(3));
};

// 本地账本只属于 A。
const G = room(T, [W(uid(1)), H("U1")], now - 9000);
say(G, { author: H("U1"), kind: "say", text: "账本里A的话", origin: "inbound" }, { now: now - 5000 });
const ledger = { ids: () => [G.id], get: (id: string) => (id === G.id ? G : undefined), serves: (src: string | undefined) => !src || src === "A" };

const get = (handler: SimpleHandler, query: string): Promise<any> => new Promise((resolve) => {
  const res = { statusCode: 200, setHeader() {}, end: (body: string) => resolve({ status: res.statusCode, ...JSON.parse(body) }) } as unknown as ServerResponse & { statusCode: number };
  handler({ headers: {} } as IncomingMessage, res, new URL("http://x/?" + query));
});

const run = async (): Promise<void> => {
  const routes = createChatRoutes(store, facts, undefined, ledger);

  const wa = JSON.stringify(await get(routes.world, "id=tA"));
  assert.equal(asked.at(-1), "A", "快照按票据来源取");
  assert.ok(wa.includes("aliceA") && !wa.includes("aliceB") && !wa.includes("merged"), "A 的票据只看 A 的名册");
  const wb = JSON.stringify(await get(routes.world, "id=tB"));
  assert.ok(wb.includes("aliceB") && !wb.includes("aliceA"), "B 的票据只看 B 的名册");
  await get(routes.world, "id=tL");
  assert.equal(asked.at(-1), undefined, "旧票据 (没署名) 看合并视图");

  assert.equal((await get(routes.turn, "id=tA&turn=tB")).status, 404, "A 的票据打不开 B 的那一轮");
  assert.equal((await get(routes.tool, "id=tA&turn=tB&use=x")).status, 404, "工具体同样");
  assert.equal((await get(routes.turn, "id=tA&turn=tA")).ok, true, "自己的那一轮照常");
  assert.equal((await get(routes.turn, "id=tA&turn=tL")).ok, true, "没署名的旧记录不分区 (兼容)");

  const ca = await get(routes.wizard, `id=tA&role=${encodeURIComponent(T)}&card=1`);
  assert.equal(ca.ledger, true, "账本归 A: A 的票据读本地账本");
  const cb = await get(routes.wizard, `id=tB&role=${encodeURIComponent(T)}&card=1`);
  assert.equal(cb.ledger, false, "B 的票据不读 A 的账本");
  assert.equal((await get(routes.room, `id=tB&room=${encodeURIComponent(T)}`)).status, 503, "B 打不开 A 账本里的 room 历史");
  assert.equal((await get(routes.room, `id=tA&room=${encodeURIComponent(T)}`)).ok, true, "A 打得开");

  const sa = await get(routes.wizard, `id=tA&role=${encodeURIComponent(T)}`);
  const text = JSON.stringify(sa.stream);
  assert.ok(text.includes("来自A") && !text.includes("来自B"), "时间轴只有同来源的轮次");
};

run().then(() => console.log("ok svr-source-scope")).catch((e) => { console.error(e); process.exitCode = 1; });
