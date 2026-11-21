import assert from "node:assert/strict";
import pino from "pino";
import { busyOf, createHandoffs, type Pending } from "../daemon/handoff.js";

// 回归: 「handoff 排上后被打断, 上下文还在」——
//  daemon 的 `idleNow` 是 true=闲, waitForIdle 的探针是 isBusy 极性 (true=忙); 接线时没翻:
//   (1) Esc 之后的静置等待: pane 闲了反被当成忙 → 10s 后 "打断后仍未静下来, 退回排队";
//   (2) 排队/briefing 的 idle 等待: pane 忙着反被当成已闲 → 在飞的一轮上硬 /clear → "submission unconfirmed"。
//  现在: 两处都过 busyOf; 闲着 → 静置成立, 立刻重开; 忙着 → 老实排队, 不碰输入框。

const mk = (o: { idleNow: () => boolean; settleMs: number }) => {
  const store = new Map<string, Pending>();
  const restarts: number[] = [];
  const escs: number[] = [];
  const idle = async (): Promise<boolean> => o.idleNow();
  const h = createHandoffs({
    isBusy: busyOf(idle), paneIdle: idle,
    interrupt: async () => { escs.push(Date.now()); return { ok: true }; },
    sessionId: () => "s1", sealOf: () => ({ channel: "" }), lastText: () => "", summary: () => undefined,
    restart: async (_t, p, submitted) => {
      restarts.push(Date.now());
      submitted({ pane: "%0", pid: 1, panePid: 2, sid: p.sid, nextSid: "n1", at: Date.now() });
      return { ok: true };
    },
    inject: async () => ({ ok: true }),
    owed: () => [], resume: async () => ({ ok: true }), notify: () => {}, uncut: () => {}, currentEvents: () => [], suppress: () => {},
    log: pino({ level: "silent" }),
    selfWait: { sliceMs: 200, rampMs: 0, confirm: 1, settleMs: o.settleMs },
    store: { get: (k: string) => store.get(k), set: (k: string, v: Pending) => void store.set(k, v), drop: (k: string) => void store.delete(k), all: () => Object.fromEntries(store) } as never,
  });
  return { h, store, restarts, escs };
};
const until = async (pred: () => boolean, ms: number) => { for (const end = Date.now() + ms; Date.now() < end && !pred(); ) await new Promise((r) => setTimeout(r, 50)); };
const BRIEF = "x".repeat(60);

// busyOf 只翻极性
assert.equal(await busyOf(async () => true)("w"), false);
assert.equal(await busyOf(async () => false)("w"), true);

// (1) Esc 后 pane 闲了 → 静置成立 → 直接重开 (修之前: 闲 = 忙, settle 超时, 退回排队, 永不 restart)
{
  const t = mk({ idleNow: () => true, settleMs: 12_000 });
  assert.equal(t.h.self("w", BRIEF).ok, true);
  await until(() => t.restarts.length > 0, 9_000);
  assert.equal(t.escs.length, 1, "调用即 Esc");
  assert.equal(t.restarts.length, 1, "Esc 后 pane 闲着: 静置成立, 立刻重开");
  assert.equal(t.store.get("w")?.failure, undefined);
}

// (2) Esc 后 pane 仍忙: settle 超时退回排队, 排队期间一次 /clear 都不许按; 闲下来才重开
{
  let idle = false;
  const t = mk({ idleNow: () => idle, settleMs: 3_000 });
  assert.equal(t.h.self("w", BRIEF).ok, true);
  await new Promise((r) => setTimeout(r, 9_000)); // settle (≈5s) 超时 + 至少一轮排队探测
  assert.equal(t.restarts.length, 0, "pane 还在忙: 不得在飞的一轮上 /clear");
  assert.equal(t.store.get("w")?.stage, "waiting", "仍在排队, 不是失败");
  assert.equal(t.store.get("w")?.failure, undefined);
  idle = true;
  await until(() => t.restarts.length > 0, 9_000);
  assert.equal(t.restarts.length, 1, "闲下来之后才重开");
}
console.log("handoff-polarity ok");
