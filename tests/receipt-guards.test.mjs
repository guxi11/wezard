import assert from "node:assert/strict";
import { createPaneGuards, GuardPrerequisiteError } from "../scripts/receipt-regress/pane-guards.mjs";

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const fixture = (options = {}) => {
  const files = new Map(), requests = [], removed = [];
  const created = deferred();
  let createError = options.createError, lists = 0;
  const post = async (route, b) => {
    requests.push({ route, ...b });
    if (route === "/tasks/list") {
      lists++;
      if (options.listErrorAt === lists) throw new Error("list transport failed");
      if (options.listGateAt === lists) {
        options.listStarted.resolve();
        await options.listGate.promise;
      }
      return { ok: true, dir: "/guards", tasks: [...files].map(([file, t]) => ({ id: file.split("/").at(-1).replace(".task.mjs", ""), owner: t.owner.split("#").at(-1), target: t.owner, lastFired: options.fired ? "fired" : "", file })) };
    }
    if (route === "/tasks/schedule") {
      assert.ok(b.id.length <= 24, "schedule slugification must not change the requested id");
      assert.equal(b.when, "1天后"); assert.equal(b.quiet, true); assert.equal(b.fresh, false);
      const file = `/guards/${b.id}.task.mjs`;
      if (createError === "rejected") return { ok: false, reason: "rejected" };
      files.set(file, { owner: b.target, note: b.note, enabled: !options.disabled, quiet: b.quiet, fresh: b.fresh, trigger: { clock: { kind: "once", at: 86_400_000 } } });
      created.resolve();
      if (options.createGate) await options.createGate.promise;
      if (createError === "lost-ack") { createError = undefined; throw new Error("connection lost after create"); }
      return { ok: true, id: b.id, file };
    }
    if (route === "/tasks/cancel") {
      if (options.cancelError) throw new Error("daemon unavailable");
      files.delete(`/guards/${b.id}.task.mjs`);
      return { ok: true };
    }
    throw new Error(route);
  };
  const guards = createPaneGuards({ post, run: "test", now: () => 0,
    inspect: async (file) => files.get(file),
    remove: async (file) => { removed.push(file); files.delete(file); },
    alive: async (target) => target !== options.dead,
  });
  return { guards, files, requests, removed, created };
};

// Root and each child get an independent owner guard. Case teardown removes
// exactly that child's schedule; final cleanup removes root and remaining kids.
{
  const f = fixture();
  await f.guards.protect("chat#root", "root");
  await f.guards.assertAll();
  await f.guards.protect("chat#child", "child");
  await f.guards.assertAll();
  assert.equal(f.files.size, 2);
  assert.equal(new Set(f.requests.filter((r) => r.route === "/tasks/schedule").map((r) => r.id)).size, 2);
  await f.guards.release("chat#child");
  assert.equal(f.files.size, 1);
  assert.equal([...f.files.values()][0].owner, "chat#root");
  await f.guards.close(); await f.guards.close();
  assert.equal(f.files.size, 0);
  assert.equal(f.requests.filter((r) => r.route === "/tasks/cancel").length, 2);
  await assert.rejects(f.guards.protect("chat#late", "late"), GuardPrerequisiteError);
}

// Registration failure, lost ACK, failed readback and lost pane all fail closed
// and clean the exact scheduled ID; they never allow the next spawn's guard.
for (const options of [{ createError: "rejected" }, { createError: "lost-ack" }, { listErrorAt: 1 }, { listErrorAt: 2 }, { fired: true }, { disabled: true }, { dead: "chat#root" }]) {
  const f = fixture(options);
  await assert.rejects(f.guards.protect("chat#root", "root"), GuardPrerequisiteError);
  await assert.rejects(f.guards.assertAll(), GuardPrerequisiteError);
  await f.guards.close();
  assert.equal(f.files.size, 0);
}

{
  const f = fixture({ listErrorAt: 3 });
  await f.guards.protect("chat#root", "root");
  await assert.rejects(f.guards.assertAll(), GuardPrerequisiteError);
  await assert.rejects(f.guards.protect("chat#late", "late"), GuardPrerequisiteError);
  await f.guards.close();
  assert.equal(f.files.size, 0);
}

// Another case may finish while the serial spawn is checking existing guards.
// Its intentional release is not a failed prerequisite; duplicate stops share it.
{
  const listGate = deferred(), listStarted = deferred();
  const f = fixture({ listGateAt: 3, listGate, listStarted });
  await f.guards.protect("chat#child", "child");
  const checking = f.guards.assertAll();
  await listStarted.promise;
  await Promise.all([f.guards.release("chat#child"), f.guards.release("chat#child")]);
  listGate.resolve();
  await checking;
  await f.guards.protect("chat#next", "next");
  await f.guards.close();
  assert.equal(f.files.size, 0);
  assert.equal(f.requests.filter((r) => r.route === "/tasks/cancel").length, 2);
}

// If the daemon cannot acknowledge cancel, only this guard's verified local
// file may be removed. Other runs' schedules are never enumerated for removal.
{
  const f = fixture({ cancelError: true });
  await f.guards.protect("chat#root", "root");
  f.files.set("/guards/other.task.mjs", { owner: "chat#other", note: "other run" });
  await f.guards.close();
  assert.deepEqual([...f.files.keys()], ["/guards/other.task.mjs"]);
  assert.equal(f.removed.length, 1);
}
{
  const f = fixture();
  await f.guards.protect("chat#root", "root");
  [...f.files.values()][0].note = "someone replaced this file";
  await assert.rejects(f.guards.close(), /未完全清理/);
  assert.equal(f.requests.filter((r) => r.route === "/tasks/cancel").length, 0);
  assert.equal(f.files.size, 1, "foreign replacement must not be removed");
}

// SIGINT/SIGTERM can race an in-flight create: cleanup must wait for the ACK,
// reject further guards and cancel the late-created schedule before resolving.
{
  const gate = deferred(), f = fixture({ createGate: gate });
  const creating = f.guards.protect("chat#root", "root");
  const rejected = assert.rejects(creating, GuardPrerequisiteError);
  await f.created.promise;
  const closing = f.guards.close();
  await assert.rejects(f.guards.protect("chat#late", "late"), GuardPrerequisiteError);
  gate.resolve();
  await rejected; await closing;
  assert.equal(f.files.size, 0);
  assert.equal(f.requests.filter((r) => r.route === "/tasks/schedule").length, 1);
}
console.log("receipt guards: owner isolation, registration/readback failure, exact cleanup fallback, shutdown/create race passed");
