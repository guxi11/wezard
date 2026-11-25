// 外部接入 (CoC) 的纯核心: 状态推导 / ack 与 cancel 归属 / 三种额度 / 索引坏行 / 鉴权。
import assert from "node:assert/strict";
import {
  applyExtOp, checkQuota, deriveOutcome, emptyExtIndex, extAuthor, foldExtIndex, judgeAck, judgeCancel, judgeExtAuth,
  localDayStart, nextLocalDayStart, parseExtIndex, type ExtPrincipal, type ExtRequest, type ExtSection,
} from "../shared/external.js";
import { DAEMON, dutyKey, foldRoom, whoKey, type MsgRow, type RoomOp, type Who } from "../shared/room.js";

const ROOM = "adhoc:1234abcd";
const UID = "w0123456789ab";
const W: Who = { kind: "wizard", id: UID };
const EXT = extAuthor("CoC");
const REQ = "1234abcd.1";
const DUTY = dutyKey(REQ, whoKey(W));

const base = (): RoomOp[] => [
  { op: "open", at: 1, room: ROOM, kind: "adhoc", title: "外部 · CoC → .recv", by: DAEMON },
  { op: "join", at: 1, room: ROOM, who: W, ord: 1, via: "invite", by: DAEMON },
  {
    op: "msg", at: 2, room: ROOM, id: REQ, seq: 1, author: EXT, ord: 0, speak: "daemon", kind: "ask",
    text: "【外部请求 · CoC】…\n在吗", to: [W], wake: [UID], origin: "daemon",
  },
];
const row = (over: Partial<MsgRow> & Pick<MsgRow, "id" | "seq" | "author" | "kind" | "text">): MsgRow => ({
  op: "msg", at: 3, room: ROOM, ord: 0, speak: "member", wake: [], origin: "tool", ...over,
} as MsgRow);

const rec = (over: Partial<ExtRequest> = {}): ExtRequest =>
  ({ req: REQ, principal: "CoC", room: ROOM, at: 2, canceled: false, delivered: false, ...over });

// ① 五种状态
{
  const open = foldRoom(ROOM, base());
  assert.deepEqual(deriveOutcome(open, rec()), { state: "open", holderUid: UID });

  const answered = foldRoom(ROOM, [...base(), row({ id: "1234abcd.2", seq: 2, author: W, kind: "reply", status: "done", re: [REQ], closes: [DUTY], text: "在, 说吧" })]);
  assert.deepEqual(deriveOutcome(answered, rec()), { state: "answered", answer: "在, 说吧", answeredAt: 3, holderUid: UID });

  const need = foldRoom(ROOM, [...base(), row({ id: "1234abcd.3", seq: 2, author: W, kind: "reply", status: "need", re: [REQ], text: "哪台机器?" })]);
  assert.deepEqual(deriveOutcome(need, rec()), { state: "need", answer: "哪台机器?", holderUid: UID });

  const byDaemon = foldRoom(ROOM, [...base(), row({ id: "1234abcd.4", seq: 2, author: DAEMON, speak: "daemon", kind: "reply", status: "canceled", re: [REQ], closes: [DUTY], text: "[wezard] recv 已离开, 这条没有答案了" })]);
  assert.equal(deriveOutcome(byDaemon, rec()).state, "failed");

  const byCancel = foldRoom(ROOM, [...base(), row({ id: "1234abcd.5", seq: 2, author: W, kind: "reply", status: "canceled", re: [REQ], closes: [DUTY], text: "做不了" })]);
  assert.equal(deriveOutcome(byCancel, rec()).state, "failed");

  assert.equal(deriveOutcome(undefined, rec()).state, "failed", "房间不在了 = failed");
  assert.equal(deriveOutcome(open, rec({ canceled: true })).state, "canceled", "撤过就是 canceled, 哪怕 wizard 还没关账");

  const passed = foldRoom(ROOM, [...base(), row({ id: "1234abcd.6", seq: 2, author: W, kind: "reply", status: "passed", re: [REQ], closes: [DUTY], text: "不用我做" })]);
  assert.equal(deriveOutcome(passed, rec()).state, "answered", "passed 也算交代");
}

// ② ack / cancel 的归属校验
{
  assert.equal(judgeAck(rec(), "CoC", "answered").ok, true);
  assert.equal(judgeAck(rec(), "CoC", "open").ok, false, "open 不能 ack");
  assert.equal(judgeAck(rec(), "别的", "answered").ok, false, "别人的请求不能 ack");
  assert.equal(judgeAck(undefined, "CoC", "answered").ok, false);
  assert.equal(judgeCancel(rec(), "CoC", "open").ok, true);
  assert.equal(judgeCancel(rec(), "CoC", "need").ok, true);
  assert.equal(judgeCancel(rec(), "CoC", "answered").ok, false, "已交代的不能撤");
  assert.equal(judgeCancel(rec(), "别的", "open").ok, false);
}

// ③ 三种额度边界
{
  const now = localDayStart(Date.now()) + 12 * 3600_000;
  const q = { perMinute: 2, perDay: 50, maxOpen: 2 };
  const all = () => "answered" as const;
  const at = (n: number, ago = 0): ExtRequest => rec({ req: "r" + n, at: now - ago });
  assert.equal(checkQuota([at(1, 70_000)], all, q, now).ok, true, "一分钟窗外的老请求不算");
  const two = [at(1, 10_000), at(2, 5_000)];
  const minute = checkQuota(two, all, q, now);
  assert.equal(minute.ok, false);
  if (!minute.ok) {
    assert.match(minute.reason, /每分钟/);
    assert.equal(minute.retryAt, now - 10_000 + 60_000, "恢复时刻 = 最早那条 + 60s");
  }

  const qd = { perMinute: 1000, perDay: 2, maxOpen: 100 };
  const day = checkQuota([at(1, 3 * 3600_000), at(2, 2 * 3600_000)], all, qd, now);
  assert.equal(day.ok, false);
  if (!day.ok) {
    assert.match(day.reason, /今天/);
    assert.equal(day.retryAt, nextLocalDayStart(now));
  }

  const qo = { perMinute: 1000, perDay: 1000, maxOpen: 2 };
  assert.equal(checkQuota([at(1, 5 * 3600_000), at(2, 4 * 3600_000)], all, qo, now).ok, true);
  const open = checkQuota([at(1, 5 * 3600_000), at(2, 4 * 3600_000)], () => "need", qo, now);
  assert.equal(open.ok, false);
  if (!open.ok) assert.match(open.reason, /未结/);
}

// ④ 索引坏行跳过 (不中止)
{
  const raw = [
    JSON.stringify({ op: "room", at: 1, principal: "CoC", room: ROOM, reception: "recv" }),
    "{ 这不是 json",
    JSON.stringify({ op: "ask", at: 2, principal: "CoC", req: REQ, room: ROOM }),
    "",
    JSON.stringify({ hello: 1 }),
    JSON.stringify({ op: "ack", at: 3, req: REQ }),
  ].join("\n");
  const p = parseExtIndex(raw);
  assert.equal(p.ops.length, 3);
  assert.deepEqual(p.badLines, [2, 5]);
  const idx = foldExtIndex(p.ops);
  assert.equal(idx.rooms.get("CoC")?.room, ROOM);
  assert.equal(idx.requests.get(REQ)?.delivered, true);
  assert.equal(idx.requests.get(REQ)?.canceled, false);
  applyExtOp(idx, { op: "cancel", at: 4, req: REQ });
  assert.equal(idx.requests.get(REQ)?.canceled, true);
  assert.equal(foldExtIndex([]).requests.size, 0);
  assert.equal(emptyExtIndex().rooms.size, 0);
}

// ⑤ 鉴权: 总开关 / 名字 / 禁用 / 口令
{
  const p: ExtPrincipal = { name: "CoC", reception: "recv", owner: "", enabled: true, perMinute: 10, perDay: 50, maxOpen: 5 };
  const on: ExtSection = { enabled: true, principals: [p] };
  assert.equal(judgeExtAuth({ enabled: false, principals: [p] }, "CoC", "t", "t").ok, false, "总开关关");
  assert.equal(judgeExtAuth(on, "nobody", "t", "t").ok, false, "名字不存在");
  assert.equal(judgeExtAuth({ enabled: true, principals: [{ ...p, enabled: false }] }, "CoC", "t", "t").ok, false, "被禁用");
  assert.equal(judgeExtAuth(on, "CoC", "bad", "good").ok, false, "口令错");
  assert.equal(judgeExtAuth(on, "CoC", "good", "good").ok, true);
  assert.equal(judgeExtAuth(on, "CoC", "", "good").ok, false, "没带口令");
  assert.equal(judgeExtAuth(on, "CoC", "good", "").ok, false, "还没生成口令文件");
  const v = judgeExtAuth(on, "CoC", "good", "good");
  assert.equal(v.ok && v.principal.reception, "recv");
}

process.stdout.write("external: ok\n");
