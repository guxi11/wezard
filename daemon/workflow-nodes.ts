// Opt-in execution history. Receipt completion and acceptance are separate facts.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { MemberRole } from "../shared/world.js";
import type { Tell, Prereq } from "./receipts.js";
import type { ReceiptStatus } from "../shared/reminder.js";
import { parseClosing } from "./peers.js";
import { expandHome } from "../shared/paths.js";

export type Execution = "queued" | "dispatching" | "dispatch-unknown" | "running" | "needs-input" | "errored" | "terminal";
export interface FileVersion { path: string; sha256: string; snapshot?: string }
export interface DispatchLeg { key: string; text: string; at: number; role?: MemberRole; kind: "task" | "ask"; free?: boolean; continuation?: boolean; tell?: Tell }
export interface NodeAttempt {
  id: string; node: string; owner: string; job: string; turn: string; to: string; at: number;
  execution: Execution; acceptance: "pending" | "accepted" | "rejected";
  tell?: Tell; accountingVersion?: 1; dispatches?: DispatchLeg[]; status?: ReceiptStatus; body?: string; digest?: string;
  files?: FileVersion[]; reason?: string; stopped?: boolean; exposed?: boolean; canceled?: boolean;
}
export const resultDigest = (body: string): string => createHash("sha256").update(body).digest("hex");
const fileDigest = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const versionsMatch = (files: FileVersion[]): boolean => files.every((f) => {
  try { return isAbsolute(f.path) && /^[a-f0-9]{64}$/.test(f.sha256) && fileDigest(f.path) === f.sha256 && (!f.snapshot || fileDigest(f.snapshot) === f.sha256); } catch { return false; }
});

export const createWorkflowNodes = (file: string) => {
  const abs = resolve(expandHome(file));
  // Corrupt/unwritable execution history must fail closed, unlike advisory stores.
  let rows: NodeAttempt[] = existsSync(abs) ? JSON.parse(readFileSync(abs, "utf8")) as NodeAttempt[] : [];
  if (!Array.isArray(rows) || rows.some((a) =>
    ![a.id, a.node, a.owner, a.job, a.turn, a.to].every((s) => typeof s === "string" && s.length > 0)
    || !Number.isFinite(a.at)
    || (a.body !== undefined && typeof a.body !== "string")
    || (a.digest !== undefined && (typeof a.digest !== "string" || typeof a.body !== "string" || a.digest !== resultDigest(a.body)))
    || !["queued", "dispatching", "dispatch-unknown", "running", "needs-input", "errored", "terminal"].includes(a.execution)
    || !["pending", "accepted", "rejected"].includes(a.acceptance)
    || [a.stopped, a.exposed, a.canceled].some((v) => v !== undefined && typeof v !== "boolean")
    || (a.status !== undefined && !["done", "need", "error", "timeout", "silent", "dead", "canceled"].includes(a.status))
    || (a.acceptance === "accepted" && (a.execution !== "terminal" || a.status !== "done" || !a.body?.trim() || a.digest !== resultDigest(a.body)))
    || (a.files !== undefined && (!Array.isArray(a.files) || a.files.some((f) => typeof f.path !== "string" || typeof f.sha256 !== "string" || (f.snapshot !== undefined && (typeof f.snapshot !== "string" || !isAbsolute(f.snapshot))))))
    || (a.accountingVersion !== undefined && a.accountingVersion !== 1)
    || (a.dispatches !== undefined && (!Array.isArray(a.dispatches) || a.dispatches.some((d) => typeof d.key !== "string" || !d.key || (d.tell && (d.tell.from !== a.owner || d.tell.to !== a.to || d.tell.turn !== a.turn)) || typeof d.text !== "string" || !Number.isFinite(d.at) || !["task", "ask"].includes(d.kind) || ([d.free, d.continuation].some((v) => v !== undefined && typeof v !== "boolean"))) || new Set(a.dispatches.map((d) => d.key)).size !== a.dispatches.length))
    || (a.tell && (a.tell.from !== a.owner || a.tell.to !== a.to || a.tell.turn !== a.turn))
  )) throw new Error("invalid workflow node history");
  if (new Set(rows.map((a) => a.id)).size !== rows.length || new Set(rows.map((a) => `${a.owner}\0${a.turn}`)).size !== rows.length) throw new Error("duplicate workflow attempt identity");
  const write = (next: NodeAttempt[]): void => {
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    const fd = openSync(tmp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, abs);
    const dir = openSync(dirname(abs), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
    rows = next;
  };
  const update = (id: string, change: Partial<NodeAttempt>): NodeAttempt => {
    const old = rows.find((a) => a.id === id);
    if (!old) throw new Error("attempt not found");
    const next = { ...old, ...change };
    write(rows.map((a) => a.id === id ? next : a));
    return structuredClone(next);
  };
  // A process death anywhere around injection leaves an uncertain attempt, never a retry.
  if (rows.some((a) => a.execution === "dispatching")) write(rows.map((a) => a.execution === "dispatching" ? { ...a, execution: "dispatch-unknown" as const } : a));
  // First-slice records had optional file evidence and no snapshots. Keep their
  // history, but require fresh validation rather than trusting an old accepted bit.
  const legacy = rows.filter((a) => a.acceptance === "accepted" && (
    parseClosing(a.body ?? "").artifacts.some((f) => !(a.files ?? []).some((v) => v.path === f.path && v.snapshot))
    || (a.files ?? []).some((f) => !f.snapshot)
  ));
  if (legacy.length) write(rows.map((a) => legacy.some((b) => b.id === a.id) ? { ...a, acceptance: "pending" as const, reason: "legacy file acceptance needs complete version evidence and snapshots" } : a));
  const byTurn = (owner: string, turn: string) => rows.find((a) => a.owner === owner && a.turn === turn);
  const begin = (owner: string, job: string, node: string, turn: string, to: string, queued: boolean): NodeAttempt => {
    const same = byTurn(owner, turn);
    if (same) {
      if (same.node !== node || same.job !== job || same.to !== to) throw new Error("attempt identity mismatch");
      if (!["queued", "running", "needs-input", "errored"].includes(same.execution)) throw new Error("attempt requires reconciliation before dispatch");
      return structuredClone(same);
    }
    const prev = rows.filter((a) => a.owner === owner && a.job === job && a.node === node).at(-1);
    if (prev && (!prev.stopped || prev.acceptance === "accepted")) throw new Error("previous attempt may still execute; reconcile stopped before retry");
    const busy = rows.find((a) => a.owner === owner && a.to === to && !["terminal", "queued"].includes(a.execution));
    if (busy && !queued) throw new Error("target already has a tracked execution");
    const a: NodeAttempt = { id: `a${randomUUID()}`, node, owner, job, turn, to, at: Date.now(), execution: "queued", acceptance: "pending", accountingVersion: 1 };
    write([...rows, a]);
    return structuredClone(a);
  };
  return {
    all: () => structuredClone(rows),
    list: (owner: string, job?: string) => structuredClone(rows.filter((a) => a.owner === owner && (!job || a.job === job))),
    byTurn: (owner: string, turn: string) => { const a = byTurn(owner, turn); return a && structuredClone(a); },
    begin,
    cancel: (to: string | undefined, owner?: string, job?: string, turn?: string, only: (x: { from: string; turn: string }) => boolean = () => true): number => {
      const hit = rows.filter((a) => (!to || a.to === to) && (!owner || a.owner === owner) && (!job || a.job === job) && (!turn || a.turn === turn) && a.execution !== "terminal" && !a.canceled && only({ from: a.owner, turn: a.turn }));
      if (hit.length) write(rows.map((a) => hit.some((b) => b.id === a.id) ? { ...a, canceled: true, acceptance: "rejected" as const, execution: a.exposed || a.execution === "dispatch-unknown" || ["running", "needs-input", "errored"].includes(a.execution) ? "dispatch-unknown" as const : "terminal" as const, status: "canceled" as const, stopped: !a.exposed && ["queued", "dispatching"].includes(a.execution), reason: "canceled; physical exposure requires stopped reconciliation" } : a));
      return hit.length;
    },
    recordLeg: (id: string, data: Omit<DispatchLeg, "key">, reuse = false): DispatchLeg => {
      const a = rows.find((a) => a.id === id);
      if (!a || a.canceled) throw new Error("attempt not active");
      const old = a.dispatches?.at(-1);
      if (reuse && old) {
        if (a.tell) update(id, { tell: { ...a.tell, dispatchKey: old.key } });
        return structuredClone(old);
      }
      const key = `${id}:${randomUUID()}`;
      const leg = { ...data, key, ...(data.tell ? { tell: { ...data.tell, dispatchKey: key } } : {}) };
      update(id, { accountingVersion: 1, dispatches: [...(a.dispatches ?? []), leg], ...(leg.tell ? { tell: leg.tell } : {}) });
      return leg;
    },
    boundary: (id: string): boolean => {
      const a = rows.find((a) => a.id === id);
      if (!a || a.canceled || a.execution !== "dispatching") return false;
      if (!a.exposed) update(id, { exposed: true });
      return true;
    },
    intent: (id: string, tell: Tell) => update(id, { execution: "dispatching", tell, status: undefined, body: undefined, digest: undefined, acceptance: "pending" }),
    dispatched: (id: string, ok: boolean) => {
      const a = rows.find((a) => a.id === id);
      if (!a) throw new Error("attempt not found");
      return a.execution === "dispatching" ? update(id, { execution: ok ? "running" : "dispatch-unknown" }) : structuredClone(a);
    },
    outcome: (owner: string, turn: string, status: ReceiptStatus, body: string) => {
      const a = byTurn(owner, turn);
      if (!a || a.execution === "terminal" || a.execution === "dispatch-unknown" || (["queued", "dispatching"].includes(a.execution) && status !== "canceled")) return;
      if (status === "canceled") {
        const uncertain = !!a.exposed || ["running", "needs-input", "errored"].includes(a.execution);
        update(a.id, { status, body, digest: resultDigest(body), canceled: true, acceptance: "rejected", execution: uncertain ? "dispatch-unknown" : "terminal", stopped: !uncertain });
        return;
      }
      if (status === "done" && !body.trim()) {
        update(a.id, { execution: "dispatch-unknown", acceptance: "pending", status: undefined, body: undefined, digest: undefined, reason: "receipt claimed without result body; reconcile from transcript" });
        return;
      }
      update(a.id, { status, body, digest: resultDigest(body), acceptance: "pending", execution: status === "need" ? "needs-input" : status === "error" ? "errored" : "terminal" });
    },
    prereq: (owner: string, turn: string): Prereq | undefined => {
      const a = byTurn(owner, turn);
      if (!a) return undefined;
      const seen = { to: a.to, status: a.status ?? "canceled" as ReceiptStatus, body: a.body ?? "" };
      if (a.canceled || a.acceptance === "rejected" || (a.execution === "terminal" && a.status !== "done")) return { state: "failed", seen };
      if (a.acceptance === "accepted") return versionsMatch(a.files ?? []) ? { state: "done", seen } : { state: "failed", seen: { ...seen, status: "canceled", body: "accepted artifact version changed" } };
      return { state: "pending" };
    },
    verdict: (owner: string, id: string, as: "accepted" | "rejected" | "sent" | "stopped", digest: string | undefined, reason: string, files: FileVersion[] = []) => {
      const a = rows.find((a) => a.id === id && a.owner === owner);
      if (!a) throw new Error("attempt not found for owner");
      if (!reason.trim()) throw new Error("evidence/reason required");
      if (as === "sent") {
        if (a.canceled || !["dispatch-unknown", "running"].includes(a.execution) || a.status || !a.tell) throw new Error("only unknown dispatch can reconcile sent");
        return update(id, { execution: "running", reason });
      }
      if (as === "stopped") {
        if (a.acceptance === "accepted") throw new Error("accepted attempt cannot be retried");
        return update(id, { execution: "terminal", status: a.status ?? "canceled", stopped: true, acceptance: "rejected", reason });
      }
      if (a.execution !== "terminal" || a.status !== "done" || !a.digest || digest !== a.digest) throw new Error("verdict requires terminal done and matching result digest");
      if (a.acceptance !== "pending") throw new Error("attempt already validated");
      const declared = parseClosing(a.body ?? "").artifacts.map((f) => f.path);
      if (as === "accepted" && declared.some((p) => !files.some((f) => f.path === p))) throw new Error("every declared ARTIFACT requires files+sha256 evidence");
      if (as === "accepted" && !versionsMatch(files)) throw new Error("artifact missing or sha256 mismatch");
      const versions = as !== "accepted" ? files : files.map((f) => {
        const data = readFileSync(f.path);
        if (createHash("sha256").update(data).digest("hex") !== f.sha256) throw new Error("artifact changed while snapshotting");
        const snapshot = `${abs}.artifacts/${f.sha256}`;
        mkdirSync(dirname(snapshot), { recursive: true });
        if (!existsSync(snapshot)) writeFileSync(snapshot, data, { mode: 0o444, flag: "wx" });
        if (fileDigest(snapshot) !== f.sha256) throw new Error("snapshot corruption");
        const fd = openSync(snapshot, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
        const parent = openSync(dirname(snapshot), "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
        return { path: f.path, sha256: f.sha256, snapshot };
      });
      return update(id, { acceptance: as, reason, files: versions });
    },
  };
};
