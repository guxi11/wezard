import assert from "node:assert/strict";
import { applyOp, DAEMON, dmRoomId, emptyRoom, judge, type Draft, type JudgeCtx, type MsgRow, type RoomState, type Who } from "../shared/room.js";

export const W = (id: string): Who => ({ kind: "wizard", id });
export const H = (id: string): Who => ({ kind: "human", id });
export const uid = (n: number): string => "w" + n.toString(16).padStart(12, "0");

export const room = (id: string, members: Who[], t0 = 1_000): RoomState => {
  const s = emptyRoom(id);
  applyOp(s, { op: "open", at: t0, room: id, kind: id.startsWith("chat:") ? "wecom-group" : "dm", by: DAEMON });
  members.forEach((who, i) => applyOp(s, { op: "join", at: t0 + i, room: id, who, ord: s.nextOrd, via: "founder", by: DAEMON }));
  return s;
};

/** judge + apply; 失败直接抛 (带原因)。 */
export const say = (s: RoomState, d: Partial<Draft> & { author: Who }, ctx: Partial<JudgeCtx> = {}): MsgRow => {
  const v = judge(s, { kind: "say", text: "x", origin: "tool", ...d }, { now: 2_000 + s.seq, ...ctx });
  if (!v.ok) throw new Error("judge rejected: " + v.status + " " + v.reason);
  if (!v.duplicate) applyOp(s, v.row);
  return v.row;
};
export const rejects = (s: RoomState, d: Partial<Draft> & { author: Who }, status: number, ctx: Partial<JudgeCtx> = {}): string => {
  const v = judge(s, { kind: "say", text: "x", origin: "tool", ...d }, { now: 2_000 + s.seq, ...ctx });
  assert.equal(v.ok, false, "expected rejection");
  if (v.ok) return "";
  assert.equal(v.status, status, v.reason);
  return v.reason;
};
export { dmRoomId };
