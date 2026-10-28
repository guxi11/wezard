import assert from "node:assert/strict";
import { handoffRound, roundPending, type RoundEvent } from "../daemon/handoff.js";

// 交接只等「这一轮」: 当轮开场那条注入事件 (+ 绑在同一个 turn 上的兄弟), 不等整个会话台账。
const ev = (id: string, extra: Partial<RoundEvent> = {}): RoundEvent => ({
  id, target: "chat:a", exposure: "consumed", execution: "awaiting-result", ...extra,
});

// ── 真实失败形状 (2026-10-27 #WendyEvans): 53 分钟前注入的一条 uncertain 旧事件, 本轮的开场
// 事件早就 complete+finalized。旧判据 (台账里所有未落定事件) → 忙到 SELF_IDLE_MS 超时;
// 新判据 → 只看本轮, 立刻放行。
const stuck = ev("route:e1a47cd.1.2:input:03fd", { execution: "uncertain", turn: "tmvqqiqbye1ijrm" });
const opener = ev("route:e253518:input:now", { execution: "complete", finalized: true, turn: "tmvcur1" });
const rows = [stuck, opener];
const round = handoffRound("chat:a", "route:e253518:input:now", rows);
assert.deepEqual(round.map((e) => e.id), ["route:e253518:input:now"], "只留本轮开场那条");
assert.equal(roundPending(round), false, "本轮已收口 → 交接可以开工 (旧判据会一直等到超时)");
const legacyBusy = rows.some((e) => !e.finalized && e.execution !== "canceled");
assert.equal(legacyBusy, true, "旧判据在同一批事件上仍是忙 —— 这就是被收窄掉的那一半");

// 本轮还没落定 → 忙 (这一条是不能放宽的: 切断会把终句吞掉)
assert.equal(roundPending(handoffRound("chat:a", "op", [ev("op"), stuck])), true);

// 开场那条还没贴进 pane (交接闸 handingOff 把 peer 注入 held 住) / 已释放 → 这一轮没有可切的终句
assert.deepEqual(handoffRound("chat:a", "op", [ev("op", { exposure: "none" }), stuck]), []);
assert.deepEqual(handoffRound("chat:a", "op", [ev("op", { releasedAt: 1 }), stuck]), []);
assert.deepEqual(handoffRound("chat:a", undefined, [stuck]), [], "人自己敲开的一轮: 没有信封, 不等");

// 同一个 turn 上的兄弟事件要一起等 (它们会被同一次切断误伤)
const sibling = ev("rcpt:e1.2:abc", { turn: "tmvcur1" });
assert.deepEqual(handoffRound("chat:a", "op", [ev("op", { finalized: true, execution: "complete", turn: "tmvcur1" }), sibling]).map((e) => e.id),
  ["op", "rcpt:e1.2:abc"], "同 turn 的兄弟留着");
assert.equal(roundPending(handoffRound("chat:a", "op", [ev("op", { finalized: true, execution: "complete", turn: "tmvcur1" }), sibling])), true,
  "兄弟没落定 → 仍算忙");

// 内部事件、别的 target、正在贴的那一条
assert.deepEqual(handoffRound("chat:a", "op", [ev("op", { turn: "t1" }), ev("handoff:chat:a:1:carry", { turn: "t1" })]).map((e) => e.id), ["op"]);
assert.deepEqual(handoffRound("chat:a", "op", [ev("op", { turn: "t1" }), ev("other", { target: "chat:b", turn: "t1" })]).map((e) => e.id), ["op"]);
assert.deepEqual(handoffRound("chat:a", "op", [ev("op", { finalized: true, execution: "complete", turn: "t1" }),
  ev("dispatching", { execution: "dispatching", turn: "t0" })]).map((e) => e.id), ["op", "dispatching"], "正在往 pane 里写的那条不是历史");

// 被撤的事件不算等; 被释放的不进集合
assert.equal(roundPending([{ execution: "canceled" }]), false);
assert.equal(roundPending([{ execution: "complete", finalized: true }, { execution: "uncertain" }]), true);

console.log("handoff round: 只等当前这一轮的终句, 台账里 never-settling 的旧事件不再拖住交接");