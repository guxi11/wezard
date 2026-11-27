// 频道框的演示数据 (纯假名, 不含任何真实人名 / 群名 / 票据): 给 room-graph.dom.mjs 断言用, 也给 serve-channel-fixture.mjs 截图用。
//
//   .HostDemo 绑在「Demo 频道」(3 个 topic room + 1 个旧帖子 room + 1 个存档频道 room);
//   「空频道 Demo」没绑 host 也没有任何 room (只剩标题的空框, 标题显示「未绑 host」);
//   帖子名 = 首条人话缩略 firstAsk: a1b2c3 / d4e5f6 同一句 (撞名, 追加「· 帖xxxxxx」消歧), 另两个没有 (退回「帖 xxxxxx」)。
//   外加一个普通群与一个 wizard 两人 dm, 都在框外。
// 多框 / 绑了 host 的空框 / 窗口外 room 等变体由 room-graph.dom.mjs 在这份基础上改。
// 形状与 /api/world 一致 (shared/room-view.ts buildChannelFacts / shared/world.ts)。
const uid = (n) => "w" + String(n).padStart(12, "0");
const who = (kind, id) => ({ kind, id });

export const demoChannelWorld = (now = Date.now()) => {
  const at = now - 5 * 60_000;
  const W = (n, name, host, ord) => ({ who: who("wizard", uid(n)), name, via: "invite", since: ord, ord, host });
  const H = (id, name, ord) => ({ who: who("human", id), name, via: "inbound", since: ord, ord, host: false });
  const room = (id, kind, members, extra = {}) => ({
    id, kind, title: "", bound: kind !== "dm", host: members.find((m) => m.host)?.who, openDuties: 0, unread: 0, members, last: { seq: 1, at }, ...extra,
  });
  const host = { identity: "cls-hostdemo", name: "HostDemo" };
  const ch1 = { id: "DemoC1abcdef", name: "Demo 频道", host };
  const cinfo = (c) => ({ id: c.id, name: c.name, ...(c.host ? { host: c.host } : {}) });
  const rooms = [
    room("topic:DemoC1abcdef/post-a1b2c3", "topic-post", [W(1, ".HostDemo", true, 1), H("demo-u1", "用户甲", 2)], { channel: cinfo(ch1), rootPost: "post-a1b2c3", firstAsk: "帮我看看这个报错" }),
    room("topic:DemoC1abcdef/post-d4e5f6", "topic-post", [W(2, ".HostDemo-2", true, 1)], { channel: cinfo(ch1), rootPost: "post-d4e5f6", openDuties: 1, firstAsk: "帮我看看这个报错" }),
    room("topic:DemoC1abcdef/post-g7h8i9", "topic-post", [W(3, ".HostDemo-3", true, 1), W(5, ".AliceDemo", false, 2)], { channel: cinfo(ch1), rootPost: "post-g7h8i9" }),
    room("chat:opkLegacy01", "topic-post", [W(4, ".HostDemo-4", true, 1)], { channel: cinfo(ch1), rootPost: "post-old001" }),
    room("chat:DemoC1abcdef", "channel", [H("demo-u1", "用户甲", 1)], { channel: cinfo(ch1), last: { seq: 1, at: now - 3 * 3600_000 } }),
    room("chat:wrDemoGroup", "wecom-group", [W(5, ".AliceDemo", true, 1), W(7, ".BobDemo", false, 2), H("demo-u1", "用户甲", 3)]),
    room("dm:" + [uid(5), uid(7)].sort().join("|"), "dm", [W(5, ".AliceDemo", true, 1), W(7, ".BobDemo", false, 2)]),
  ];
  const wiz = (n, name, extra = {}) => ({ target: "chat:demo#w" + n, kind: "wizard", uid: uid(n), name, label: name, base: "chat:demo", tag: "w" + n, chat: "Demo", busy: false, alive: true, lastTs: at, rels: [], smarts: { level: 3, tier: "standard" }, ...extra });
  const nodes = [
    wiz(1, ".HostDemo", { busy: true }), wiz(2, ".HostDemo-2"), wiz(3, ".HostDemo-3"), wiz(4, ".HostDemo-4", { alive: false }), wiz(5, ".AliceDemo"), wiz(7, ".BobDemo"),
    { target: "human:demo-u1", kind: "human", name: "用户甲", label: "👤", base: "", tag: "", chat: "", busy: false, alive: false, lastTs: at, rels: [] },
  ];
  const channels = [
    { ...cinfo(ch1), rooms: rooms.filter((r) => r.channel?.id === ch1.id).map((r) => r.id) },
    { id: "DemoC2mnopqr", name: "空频道 Demo", rooms: [] },
  ];
  return {
    ok: true, at: now, base: "chat:demo", self: nodes[4].target, rooms, nodes, channels,
    uidTargets: Object.fromEntries(nodes.filter((n) => n.uid).map((n) => [n.uid, n.target])),
    plans: [], schedules: [], degraded: false,
    chatNames: { "chat:DemoC1abcdef": "Demo 频道", "chat:DemoC2mnopqr": "空频道 Demo", "chat:wrDemoGroup": "Demo 群" },
    names: Object.fromEntries(nodes.filter((n) => n.uid).map((n) => [n.uid, n.name])), humanNames: { "human:demo-u1": "用户甲" },
  };
};
