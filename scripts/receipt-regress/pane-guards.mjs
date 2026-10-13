import { randomUUID } from "node:crypto";
import { join } from "node:path";

export class GuardPrerequisiteError extends Error {}

// Every guard belongs to this run and is tracked before the non-idempotent create.
// close waits for in-flight creates before canceling, so interruption cannot leave
// a late ACK's schedule behind. Local removal is only a fallback for our exact file.
export const createPaneGuards = ({ post, inspect, remove, alive, run, now = Date.now, log = () => {} }) => {
  const entries = new Map();
  const pending = new Set();
  let closing = false, failed;
  const fail = (message) => {
    failed ??= new GuardPrerequisiteError(`保护前提不成立: ${message}`);
    return failed;
  };
  const release = (target) => {
    const e = entries.get(target);
    if (!e) return Promise.resolve();
    return e.releasing ??= Promise.resolve().then(async () => {
      const before = await inspect(e.file);
      if (before && (before.owner !== target || before.note !== e.note)) throw fail(`拒绝取消不属于本轮的 guard ${e.id}`);
      let canceled;
      try { canceled = await post("/tasks/cancel", { target, id: e.id }); } catch { /* verify/remove exact owned file below */ }
      const task = await inspect(e.file);
      if (task) {
        if (task.owner !== target || task.note !== e.note) throw fail(`拒绝删除不属于本轮的 guard ${e.id}`);
        await remove(e.file);
        if (await inspect(e.file)) throw fail(`guard 清理失败 ${e.id} (${canceled?.reason ?? "cancel 未确认"})`);
      }
      entries.delete(target);
      log({ event: "released", target, id: e.id, localFallback: !!task });
    });
  };
  const check = async (e) => {
    if (e.releasing) return; // A concurrent case intentionally stopped this owner.
    try {
      const list = await post("/tasks/list", { target: e.target, mine: true });
      const row = list.ok && list.tasks?.find((t) => t.id === e.id);
      const task = await inspect(e.file);
      const isAlive = await alive(e.target, e.name);
      if (e.releasing) return;
      if (!row || row.loadError || row.lastFired || row.target !== e.target
        || row.owner?.replace(/^\./, "") !== e.name.replace(/^\./, "")
        || !task?.enabled || !task.quiet || task.fresh || task.owner !== e.target || task.note !== e.note
        || task.trigger?.clock?.kind !== "once" || task.trigger.clock.at <= now() + 3_600_000
        || !isAlive) throw fail(`guard 未生效或 pane 已丢失 ${e.name}/${e.id}`);
    } catch (error) {
      if (!e.releasing) throw fail(`${e.name}: ${error.message}`);
    }
  };
  const assertAll = async () => {
    if (closing || failed) throw failed ?? fail("清理已开始，不再 spawn");
    for (const e of entries.values()) await check(e);
  };
  const protect = (target, name) => {
    const work = (async () => {
      if (closing || failed) throw failed ?? fail("清理已开始，不再登记 guard");
      if (entries.has(target)) return check(entries.get(target));
      const list = await post("/tasks/list", { target, mine: true });
      if (closing || !list.ok || !list.dir) throw fail(`无法登记 guard ${name}`);
      const id = `rr-g-${run}-${randomUUID().replaceAll("-", "").slice(0, 12)}`; // /tasks/schedule slugs to 24 chars
      const e = { target, name, id, file: join(list.dir, `${id}.task.mjs`), note: `receipt-regress pane guard ${run}/${id}` };
      entries.set(target, e);
      try {
        const r = await post("/tasks/schedule", { target, id, when: "1天后", fresh: false, quiet: true, note: e.note, prompt: "这是已结束测试的过期保活标记。只回复 QUIET，不调用任何工具。" });
        if (r.ok && typeof r.id === "string" && r.file === join(list.dir, `${r.id}.task.mjs`)) { e.id = r.id; e.file = r.file; }
        if (!r.ok || r.id !== id || r.file !== e.file) throw fail(`guard 创建未确认 ${name}/${id}: ${r.reason ?? "id/file 不符"}`);
        if (closing) throw fail("guard 创建期间开始清理");
        await check(e);
        log({ event: "protected", target, id: e.id, file: e.file });
      } catch (error) {
        await release(target);
        throw fail(`${name}: ${error.message}`);
      }
    })().catch((error) => { throw fail(`${name}: ${error.message}`); });
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => {});
    return work;
  };
  let cleanup;
  const close = () => cleanup ??= (async () => {
    closing = true;
    await Promise.allSettled([...pending]);
    const results = await Promise.allSettled([...entries.keys()].map(release));
    const errors = results.filter((r) => r.status === "rejected");
    if (errors.length) throw new AggregateError(errors.map((r) => r.reason), "保活任务未完全清理");
  })();
  return { protect, release, assertAll, close };
};
