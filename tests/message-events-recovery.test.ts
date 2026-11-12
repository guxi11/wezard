// 单元测试: 续办载体可回收 + 探测失败终态 — 运行: npx tsx tests/message-events-recovery.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_DEADLINE } from "../shared/turn-state.js";
import { PROBE_LIMIT, createMessageEvents, gcEvents, isRecoveryCarrier,
  type MessageAdapters, type MessageEvent } from "../daemon/message-events.js";

let passed = 0;
let failed = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  try {
    await fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${name}: ${(e as Error).message}`);
  }
};

const row = (id: string, serves: string | undefined, endedAt: number): MessageEvent => ({
  id, target: "worker", speaker: "lead", channel: "", priority: "normal", deadline: NO_DEADLINE,
  payload: { text: "t", peer: { from: { kind: "peer", from: "lead" }, envelope: "e", kind: "task" } },
  fingerprint: id, at: endedAt - 1000, execution: "complete", exposure: "consumed", attempts: 0,
  finalized: true, endedAt, ...(serves ? { serves } : {}),
});

await t("续办载体 (resume / idle-question) 才算", () => {
  assert.equal(isRecoveryCarrier(row("route:r1.1:resume:1750000000000", "r1.1", 1)), true);
  assert.equal(isRecoveryCarrier(row("idle-question:r1.1:uuid", "r1.1", 1)), true);
  assert.equal(isRecoveryCarrier(row("route:r1.1:input:abc", "r1.1", 1)), false);
  assert.equal(isRecoveryCarrier(row("resume:r1.1", undefined, 1)), false);
});

await t("已了结的载体出墓碑, 原始任务输入仍保留", () => {
  const now = Date.now();
  const old = now - 48 * 3600_000;
  const rows = {
    "route:r1.1:input:abc": row("route:r1.1:input:abc", "r1.1", old),
    "route:r1.1:resume:1750000000000": row("route:r1.1:resume:1750000000000", "r1.1", old),
    "idle-question:r1.1:uuid": row("idle-question:r1.1:uuid", "r1.1", old),
  };
  const retained = gcEvents(now, (e) => !isRecoveryCarrier(e))(rows);
  assert.equal((retained["route:r1.1:input:abc"] as { tomb?: true }).tomb, undefined, "任务输入不该被裁");
  assert.equal((retained["route:r1.1:resume:1750000000000"] as { tomb?: true }).tomb, true, "续办载体应成墓碑");
  assert.equal((retained["idle-question:r1.1:uuid"] as { tomb?: true }).tomb, true, "闲置追问载体应成墓碑");
});

const RECEIPT = {
  event: "route:t2", batch: "b1", version: "v1", status: "done",
  receiver: { kind: "wizard" as const, to: "worker" },
  body: "answer", speaker: "worker", envelope: "env",
};

/** 造一条「探针永远失败、重试次数已到上限前一步」的排队事件, 看 pump 收不收得住。 */
const exhaust = async (kind: "task" | "receipt"): Promise<{ execution?: string; reason?: string; deliveryHold?: string }> => {
  const dir = mkdtempSync(join(tmpdir(), `wezard-probe-${kind}-`));
  try {
    const file = join(dir, "events.json");
    const id = kind === "task" ? "route:t1:input:1" : "rcpt:route:t2:v1";
    const payload = kind === "task"
      ? { text: "do it", peer: { from: { kind: "peer" as const, from: "lead" }, envelope: "e", kind: "task" as const, tell: {} as never } }
      : { text: "answer", receipts: [RECEIPT], peer: { from: { kind: "peer" as const, from: "worker", receipt: true as const }, envelope: "e", kind: "fyi" as const } };
    writeFileSync(file, JSON.stringify({ [id]: {
      id, target: "worker", speaker: kind === "task" ? "lead" : "daemon", channel: "", priority: "normal",
      deadline: NO_DEADLINE, serves: kind === "task" ? "route:t1" : undefined, payload,
      fingerprint: "f", at: Date.now() - 10_000, execution: "queued", exposure: "none", attempts: 0,
      probeAttempts: PROBE_LIMIT - 1, retryAt: 0,
    } }));
    const io = {
      resource: () => "worker-pane", transcript: () => "worker.jsonl", sessionId: () => "worker-session",
      ready: async () => { throw new Error("pane probe exceeded 5s; no transport attempted"); },
      valid: () => true, accepted: () => {}, committed: () => {}, canceled: () => {},
      inject: async () => ({ ok: true }), evidence: async () => ({ consumed: false }),
      recovered: () => {}, send: async () => ({}), error: () => {}, retain: () => false,
    } as unknown as MessageAdapters;
    const events = createMessageEvents(file, io);
    events.resume();
    await events.pump();
    // 终态是在 pump 返回后的微任务里落的 (bounded 的 catch), 等它落定再取样。
    for (let i = 0; i < 100 && events.get(id)?.execution === "queued"; i++) await new Promise((r) => setTimeout(r, 10));
    const after = events.get(id)!;
    // 之后不该再落盘: 冷却中的定时泵也只能空转。
    const mtime = statSync(file, { bigint: true }).mtimeNs;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await events.pump();
    const same = statSync(file, { bigint: true }).mtimeNs === mtime;
    events.stop();
    assert.ok(same, "收成终态后不应继续重写事件库");
    return { execution: after.execution, reason: after.reason, deliveryHold: after.deliveryHold };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

await t(`探针连续失败 ${PROBE_LIMIT} 次: 普通事件收成 canceled`, async () => {
  const out = await exhaust("task");
  assert.equal(out.execution, "canceled");
  assert.match(String(out.reason), /undeliverable: pane probe failed 30 times/);
});

await t(`探针连续失败 ${PROBE_LIMIT} 次: 回执事件扣成 transport-exhausted`, async () => {
  const out = await exhaust("receipt");
  assert.equal(out.execution, "queued");
  assert.equal(out.deliveryHold, "transport-exhausted");
  assert.match(String(out.reason), /undeliverable: pane probe failed 30×/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
