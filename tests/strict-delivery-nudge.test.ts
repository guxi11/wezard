// 单测: strict 群「答了没出站」的补发追问 — 运行: npx tsx tests/strict-delivery-nudge.test.ts
//
// 现场 (2026-11-16 ~ 17): sanitizer 群三次「模型生成了答复、却只写成 prose 终句」—— 出站门记
// `brief: strict conclusion (no outbound, obligation open)` 后静默丢弃, 人看到彻底静默。
// 这里钉 daemon 侧的补发追问: 真的下发、话术是「用 chat_reply 补发」、上限 1 次、补了就收账。
import assert from "node:assert";
import { createIdleNudgeTick, step, strictDeliveryNudge, strictDeliveryStewardNote, strictDeliveryHumanLine, strictUndeliveredNotice,
  type NudgeDeps, type NudgeTarget, type Policy, type Watch } from "../daemon/idle-nudge.js";

let passed = 0;
let failed = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try {
    await fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${name}: ${(e as Error).message}`);
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000;
/** strict 群「答了没出站」的追问口径: 问 1 次、不开冷却轮次。 */
const STRICT: Policy = { afterMs: 5 * MIN, max: 1, cycles: 1 };

// ─── 话术: 说的是「结论没进群、用 chat_reply 补发」, 不是「进展如何」
await t("补发追问说清楚结论没交付销账、要 chat_reply 发出去", () => {
  const s = strictDeliveryNudge({ chat: "sanitizer", re: "e4622be.1" });
  assert.ok(s.includes("还没用 chat_reply 交代"), "说的是「没交代」不是「没发言」(说别的话不等于交代)");
  assert.ok(s.includes("chat_reply"));
  assert.ok(s.includes('re: "e4622be.1"'), "带上义务的 re");
  assert.ok(!s.includes("进展如何"), "通用追问话术是错题");
});

// ─── 上报分流 (2026-11-18 aiconfig 群实录改版): 运维动作给管家, 人只看「坏了什么」
await t("管家段直投 wizard: 带行号 / re / 补发出路 / 最后一句摘要 (截 300)", () => {
  const s = strictDeliveryStewardNote({ chat: "aiconfig", who: "w", event: "e172afa", re: "m1", asks: 1, last: "L".repeat(400) });
  assert.ok(s.includes("aiconfig"));
  assert.ok(s.includes("e172afa"));
  assert.ok(s.includes('re: "m1"'));
  assert.ok(s.includes("chat_reply"), "给管家的可以是运维语言");
  assert.ok(s.includes("转述"), "交付不了时给管家的是转述/收掉出路, 不是死等");
  assert.ok(s.includes("L".repeat(300)));
  assert.ok(!s.includes("L".repeat(301)), "摘要截到 300");
});

await t("人话行只说坏了什么、人怎么办 — 不出现工具名与运维步骤", () => {
  const s = strictDeliveryHumanLine({ who: "w", asks: 1 });
  assert.ok(s.includes("没有送达"), "说清这条提问没人收到");
  assert.ok(s.includes("重新问"), "给的是人能做的动作");
  for (const tool of ["chat_reply", "chat_say", "stop_wizard", "re:", "义务账", "成员表"])
    assert.ok(!s.includes(tool), "人话行不出现 wizard 词汇: " + tool);
});

await t("终句当轮即时提醒: 说的是「那句终句没发进群」, 带补发指引", () => {
  const s = strictUndeliveredNotice({ chat: "aiconfig", re: "m1" });
  assert.ok(s.includes("没有进 aiconfig"), "点破终句哪儿都没去 (不是进展追问)");
  assert.ok(s.includes('re: "m1"'));
  assert.ok(s.includes("chat_reply"), "给可执行的补发路径");
  assert.ok(s.includes("只提醒这一次"), "有界");
  assert.ok(!s.includes("进展如何"), "不是通用追问话术");
});

// ─── 有界 (纯状态机): 16 天里只问 1 次、上报 1 次
await t("cycles:1 —— 问满这一组就闭嘴, 不重开一轮", () => {
  let w: Watch | undefined;
  let asks = 0;
  let reports = 0;
  for (let m = 0; m <= 16 * 24 * 60; m++) {
    const r = step(w, { state: "working", anchor: 0, idle: true }, m * MIN, STRICT);
    w = r.next;
    if (r.ask) asks++;
    if (r.escalate) reports++;
  }
  assert.equal(asks, 1, "只问 1 次");
  assert.equal(reports, 1, "只上报 1 次 (用尽的最后一轮不再报)");
});

// ─── 巡检层: 追问真的投出去、只投一次、补了就收账
const mkStore = () => {
  const m = new Map<string, { asks: number; cycles?: number; escalatedCycle?: number }>();
  return {
    get: (k: string) => m.get(k),
    set: (k: string, v: { asks: number; cycles?: number; escalatedCycle?: number }): unknown => m.set(k, v),
    drop: (k: string): void => { m.delete(k); },
    all: () => Object.fromEntries(m),
  };
};

const strictItem = (): NudgeTarget => ({
  from: "chat:sanitizer", to: "w1", turn: "e172afa", state: "working", ageMs: 0,
  nudge: { policy: { afterMs: 1, max: 1, cycles: 1 }, text: strictDeliveryNudge({ chat: "sanitizer", re: "m1" }) },
});

const harness = (items: NudgeTarget[], global: Policy) => {
  const store = mkStore();
  const asked: { from: string; to: string; turn: string; text: string }[] = [];
  const reports: { turn: string; asks: number }[] = [];
  const deps: NudgeDeps = {
    inflight: () => items,
    idleNow: async () => true,
    handingOff: () => false,
    policy: () => global,
    ask: async (x) => { asked.push(x); return true; },
    nameOf: (x) => x,
    escalate: (x) => { reports.push({ turn: x.turn, asks: x.asks }); },
    store,
    log: { info: () => undefined, warn: () => undefined },
  };
  return { tick: createIdleNudgeTick(deps), asked, reports, store };
};

await t("出站门判 no outbound 后: 追问真的下发了, 且只下发一次", async () => {
  const items = [strictItem()];
  const h = harness(items, { afterMs: 1, max: 3 });
  await h.tick();            // 第一次见: 开始计闲置
  assert.equal(h.asked.length, 0);
  await sleep(5);
  await h.tick();            // 闲满阈值 → 问
  assert.equal(h.asked.length, 1, "下发了一条追问");
  assert.equal(h.asked[0].to, "w1");
  assert.ok(h.asked[0].text.includes("chat_reply"), "问的是补发, 不是进展");
  for (let i = 0; i < 20; i++) { await sleep(2); await h.tick(); }
  assert.equal(h.asked.length, 1, "同一件不重复追问");
  assert.equal(h.reports.length, 1, "上报恰好一次");
  assert.equal(h.reports[0].asks, 1);
});

await t("追问后补了 chat_reply 就收账: 行一落定不再追问, 记录一并清掉", async () => {
  const items = [strictItem()];
  const h = harness(items, { afterMs: 1, max: 3 });
  await h.tick();
  await sleep(5);
  await h.tick();
  assert.equal(h.asked.length, 1);
  assert.ok(Object.keys(h.store.all()).length === 1, "追问次数已落盘");
  items.length = 0;          // chat_reply 交付 → 义务关账, 行离开在飞名单
  for (let i = 0; i < 10; i++) { await sleep(2); await h.tick(); }
  assert.equal(h.asked.length, 1, "不再追问");
  assert.equal(h.reports.length, 0, "也没上报");
  assert.deepEqual(h.store.all(), {}, "落盘的追问记录一并清掉");
});

await t("同一轮重复触发不刷屏: 全局口径关着, 这一件的口径仍然只问一次", async () => {
  const items = [strictItem()];
  const h = harness(items, { afterMs: 0, max: 5 });
  await h.tick();
  for (let i = 0; i < 30; i++) { await sleep(2); await h.tick(); }
  assert.equal(h.asked.length, 1);
  assert.equal(h.reports.length, 1);
});

await t("没有专用口径的件照旧用通用话术 (回归)", async () => {
  const items: NudgeTarget[] = [{ from: "chat:x", to: "w2", turn: "e9", state: "working", ageMs: 0 }];
  const h = harness(items, { afterMs: 1, max: 1 });
  await h.tick();
  await sleep(5);
  await h.tick();
  assert.equal(h.asked.length, 1);
  assert.ok(h.asked[0].text.includes("进展如何"), "通用追问口径不变");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);