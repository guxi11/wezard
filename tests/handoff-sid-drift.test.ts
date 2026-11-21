import assert from "node:assert/strict";
import pino from "pino";
import { createHandoffs, type Pending } from "../daemon/handoff.js";

// 回归: wezard-1 的 handoff 失败 ——
//  (1) pane 注册表报的原生 sid 会抖, self 交接等了几分钟后 sid 变了, /clear 前的校验永久放弃;
//      现在: 还没提交 /clear、pane 进程身份未变 → 刷新 sid 继续; 进程变了 → 保持原 sid (校验照旧拒绝)。
//  (2) other 交接的简报读取 `summary` 在 room 接线时被写成 `() => undefined`, 必然 "no summary text"。

const mk = (o: { sid: () => string; proc?: () => string | undefined; summary?: (id: string, t: string, since: number) => string | undefined }) => {
  const store = new Map<string, Pending>();
  const restarts: Pending[] = [];
  const injects: string[] = [];
  const summaryArgs: [string, string, number][] = [];
  let polls = 0; // briefing 的 idle 等待带 20s ramp: 先报一次忙, 才不必干等 ramp
  const h = createHandoffs({
    isBusy: async () => polls++ === 0, sessionId: o.sid, sealOf: () => ({ channel: "" }), lastText: () => "",
    summary: (id, t, since) => { summaryArgs.push([id, t, since]); return o.summary?.(id, t, since); },
    process: o.proc ? async () => o.proc!() : undefined,
    restart: async (_t, p, submitted) => {
      restarts.push(p);
      submitted({ pane: "%0", pid: 1, panePid: 2, sid: p.sid, nextSid: "n1", at: Date.now() });
      return { ok: true };
    },
    inject: async (_t, text) => { injects.push(text); return { ok: true }; },
    owed: () => [], resume: async () => ({ ok: true }), notify: () => {}, uncut: () => {}, currentEvents: () => [], suppress: () => {},
    log: pino({ level: "silent" }),
    selfWait: { sliceMs: 200, rampMs: 0, confirm: 1 },
    store: { get: (k: string) => store.get(k), set: (k: string, v: Pending) => void store.set(k, v), drop: (k: string) => void store.delete(k), all: () => Object.fromEntries(store) } as never,
  });
  return { h, store, restarts, injects, summaryArgs };
};
const until = async (pred: () => boolean, tries = 300) => { for (let i = 0; i < tries && !pred(); i++) await new Promise((r) => setTimeout(r, 20)); };

// (1a) sid 抖了、进程未变 → restart 拿到的是刷新后的 sid
{
  const t = mk({ sid: () => "drifted", proc: () => "%0:10:20" });
  t.store.set("w", { target: "w", mode: "self", at: 1, sid: "old", proc: "%0:10:20", stage: "restarting", brief: "b", timeoutMs: 1000 });
  t.h.resume();
  await until(() => t.restarts.length > 0);
  assert.equal(t.restarts[0]?.sid, "drifted", "进程没变: sid 刷新为当前值, index.ts 的校验才放行");
  await until(() => t.injects.length > 0);
  assert.equal(t.injects.length, 1, "刷新后交接做完 (简报贴回)");
}

// (1b) 进程变了 → 不刷新, 仍带旧 sid (index.ts 的校验会拒绝: 别在换了进程的 pane 上清)
{
  const t = mk({ sid: () => "drifted", proc: () => "%0:99:20" });
  t.store.set("w", { target: "w", mode: "self", at: 1, sid: "old", proc: "%0:10:20", stage: "restarting", brief: "b", timeoutMs: 1000 });
  t.h.resume();
  await until(() => t.restarts.length > 0);
  assert.equal(t.restarts[0]?.sid, "old");
}

// (1c) 发起时没记到进程身份 (旧记录 / 认不出) → 保持严格
{
  const t = mk({ sid: () => "drifted", proc: () => "%0:10:20" });
  t.store.set("w", { target: "w", mode: "self", at: 1, sid: "old", stage: "restarting", brief: "b", timeoutMs: 1000 });
  t.h.resume();
  await until(() => t.restarts.length > 0);
  assert.equal(t.restarts[0]?.sid, "old");
}

// (1d) 已提交过 /clear (p.clear 在) → 不动 sid
{
  const t = mk({ sid: () => "drifted", proc: () => "%0:10:20" });
  t.store.set("w", { target: "w", mode: "self", at: 1, sid: "old", proc: "%0:10:20", stage: "restarting", brief: "b", timeoutMs: 1000,
    clear: { pane: "%0", pid: 1, panePid: 2, sid: "old", at: 1 } });
  t.h.resume();
  await until(() => t.restarts.length > 0);
  assert.equal(t.restarts[0]?.sid, "old");
}

// (2) other: 简报读目标会话 summaryAt 之后的 assistant 正文, 带进 restart/贴回
{
  const brief = "这是一份完整的交接简报 ".repeat(400); // > 4000 字, 不能被截
  const t = mk({ sid: () => "s1", summary: () => brief });
  t.store.set("w", { target: "w", mode: "other", at: 5, sid: "s1", stage: "briefing", summaryAt: 123, timeoutMs: 30_000 });
  t.h.resume();
  await until(() => t.injects.length > 0, 1000);
  assert.deepEqual(t.summaryArgs[0], ["handoff:w:5:summary", "w", 123], "按 summaryAt (请它写简报那句之前) 取");
  assert.ok(t.injects[0]!.includes(brief), "简报全文贴回新会话");
}

// (2b) 目标没产出正文 → 明确失败 (不重开, 不丢会话)
{
  const t = mk({ sid: () => "s1", summary: () => undefined });
  t.store.set("w", { target: "w", mode: "other", at: 5, sid: "s1", stage: "briefing", summaryAt: 123, timeoutMs: 30_000 });
  t.h.resume();
  await until(() => !!t.store.get("w")?.failure, 1000);
  assert.equal(t.store.get("w")?.failure?.reason, "target produced no summary text");
  assert.equal(t.restarts.length, 0);
}
console.log("handoff-sid-drift ok");
