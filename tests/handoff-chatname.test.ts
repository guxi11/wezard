import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { clearChatName, nextAutoName, planChatNames, retiredChatNames, setChatName } from "../daemon/chat-name.js";
import { createHandoffs, FAILED_STALE_MS, handoffAdmission, resumeText, SELF_GRACE_MS, SELF_SETTLE_MS, settlesCut, type Pending } from "../daemon/handoff.js";

// 2026-11-13 人拍板: 收尾窗口不要了 —— 默认不等, 调用即 Esc; settle 只取证明静置的最小量。
assert.equal(SELF_GRACE_MS, 0, "self handoff 默认无收尾窗口 (要短窗的部署配 selfWait.graceMs>0)");
assert.equal(SELF_SETTLE_MS, 10_000, "Esc 后只等能证明静置的最小量; 量不出来走排队兜底");

// ── chat 自动名: 墓碑 + 只递增 ────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "chatname-"));
try {
  const src = join(dir, "config.jsonc");
  writeFileSync(src, "{}\n");
  const cfg = ConfigSchema.parse({ bot: { botId: "b", secret: "s" }, daemon: { stateDir: join(dir, "state") },
    chats: { "cc-wecom-2": "chat:a", "cc-wecom-9": "chat:b", wezard: "user:x" } });

  // 空号 (3..8) 不回填, 取最大序号 +1
  assert.equal(nextAutoName("cc-wecom", new Set(["cc-wecom-2", "cc-wecom-9"])), "cc-wecom-10");
  assert.equal(nextAutoName("lisct", new Set()), "lisct");
  assert.equal(nextAutoName("lisct", new Set(["lisct"])), "lisct-2");
  assert.equal(nextAutoName("Lisct", new Set(["lisct-4"])), "Lisct-5");
  assert.equal(nextAutoName("x".repeat(32), new Set(["x".repeat(32)])).length, 32);

  // 首个自动名: 当前 chats 已占到 -9 → -10; 批内递增
  const plan = planChatNames(cfg, [{ base: "chat:n1", cwd: "/r/cc-wecom" }, { base: "chat:n2", cwd: "/r/cc-wecom" }]);
  assert.deepEqual(plan, { "chat:n1": "cc-wecom-10", "chat:n2": "cc-wecom-11" });

  // 人 rename 释放的名字不回流: cc-wecom-9 被改名, 新聊天仍拿 -10 而不是 -9
  assert.ok(setChatName(cfg, src, "chat:b", "modeck").ok);
  assert.ok(retiredChatNames(cfg).has("cc-wecom-9"), "rename 释放的旧名进墓碑");
  assert.equal(planChatNames(cfg, [{ base: "chat:n3", cwd: "/r/cc-wecom" }])["chat:n3"], "cc-wecom-10");

  // 墓碑跨进程 (读盘): 清掉全部 cc-wecom-* 之后仍不回落
  clearChatName(cfg, src, "chat:a");
  assert.equal(Object.keys(cfg.chats).some((n) => n.startsWith("cc-wecom")), false);
  assert.equal(planChatNames(cfg, [{ base: "chat:n4", cwd: "/r/cc-wecom" }])["chat:n4"], "cc-wecom-10");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "state", "chat-names-retired.json"), "utf8")), ["cc-wecom-2", "cc-wecom-9", "modeck", "wezard"]);

  // 手动命名不受墓碑限制 (只针对自动名)
  assert.ok(setChatName(cfg, src, "chat:c", "cc-wecom-9").ok);
} finally { rmSync(dir, { recursive: true, force: true }); }

// ── handoff: 切断那一轮的终句算不算交代 ───────────────────────────────
assert.equal(settlesCut("chat", undefined), true, "回群里的: 收尾照常落定");
assert.equal(settlesCut("wizard", undefined), false, "回 wizard 的未标记收尾: 可能是抢答, 扣下");
assert.equal(settlesCut("wizard", "result"), true);
assert.equal(settlesCut("wizard", "need"), true);
assert.equal(settlesCut(undefined, "result"), false, "不服务任何行: 维持旧行为");

const text = resumeText("e4515c1", { asker: "user:T1 (在 bias)", ask: "set workspace to /x", closing: "已排入切换\n下一轮生效" });
assert.match(text, /^继续 e4515c1/);
assert.match(text, /问的是: user:T1 \(在 bias\)/);
assert.match(text, /原话:\n> set workspace to \/x/);
assert.match(text, /> 已排入切换\n> 下一轮生效/);
assert.match(text, /RESULT:/);
assert.equal(resumeText("e1", {}), "继续 e1 —— 这是你还没交代的同一项任务。核对已有结果后续办，不要重复已完成或交付未知的操作。");

// keep: 被摘掉的终句不进失败补投 (uncut), 其余照旧
{
  const store = new Map<string, Pending>();
  const uncut: string[][] = [];
  const h = createHandoffs({
    isBusy: async () => false, sessionId: () => "s1", sealOf: () => ({ channel: "" }), lastText: () => "", summary: () => undefined,
    restart: async () => ({ ok: false, reason: "boom" }), inject: async () => ({ ok: true }),
    owed: () => [], resume: async () => ({ ok: true }), notify: () => {}, uncut: (_t, ids) => void uncut.push([...ids]),
    currentEvents: () => [], suppress: () => {},
    log: pino({ level: "silent" }),
    store: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v), drop: (k) => void store.delete(k), all: () => Object.fromEntries(store) } as never,
  });
  // 落盘里一场停在 restarting 的自我交接 (reload 接着做), 扣着两句终句
  store.set("w", { target: "w", mode: "self", at: 1, sid: "s1", stage: "restarting", brief: "b", timeoutMs: 1000, cut: ["ev-chat", "ev-peer"] });
  h.keep("w", "ev-chat");
  assert.deepEqual(store.get("w")?.cut, ["ev-peer"]);
  assert.equal(h.resume(), 1);
  for (let i = 0; i < 50 && !uncut.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(uncut, [["ev-peer"]], "交接失败只补投仍被扣下的那句");
}

// ── 失败记录的释放 (交接别人); self 调用即受理: 顶掉旧记录 / 排队, 不再被拒 ──
{
  const store = new Map<string, Pending>();
  const logs: string[] = [];
  const mapStore = { get: (k: string) => store.get(k), set: (k: string, v: Pending) => void store.set(k, v), drop: (k: string) => void store.delete(k), all: () => Object.fromEntries(store) } as never;
  const failed = (extra: Partial<Pending> = {}): Pending => ({
    target: "w", mode: "self", at: Date.now(), sid: "old", stage: "restarting", brief: "b", timeoutMs: 1000,
    failure: { status: 502, reason: "codebuddy native /clear completion is not verified", compensated: true }, ...extra,
  });
  const clear = { pane: "p", pid: 1, panePid: 2, sid: "old", nextSid: "next", at: Date.now() };
  const now = Date.now();
  const mk = (mocks: {
    isBusy?: () => boolean;
    sessionId?: () => string;
    restart?: (t: string, p: Pending, submitted: (a: NonNullable<Pending["clear"]>) => void) => Promise<{ ok: boolean; reason?: string }>;
  }) => {
    const injects: string[] = [];
    const h = createHandoffs({
      isBusy: async () => mocks.isBusy?.() ?? false, sessionId: () => mocks.sessionId?.() ?? "new", sealOf: () => ({ channel: "" }),
      lastText: () => "", summary: () => undefined,
      restart: mocks.restart ?? (async (_t, _p, submitted) => { submitted({ pane: "p", pid: 1, panePid: 2, sid: "s1", nextSid: "n1", at: Date.now() }); return { ok: true }; }),
      inject: async (_t, text) => { injects.push(text); return { ok: true }; },
      owed: () => [], resume: async () => ({ ok: true }), notify: () => {}, uncut: () => {}, currentEvents: () => [], suppress: () => {},
      log: pino({ level: "info" }, { write: (s: string) => void logs.push(s) }),
      selfWait: { sliceMs: 200, rampMs: 0, confirm: 1 },
      store: mapStore,
    });
    return { h, injects };
  };
  const wait = async (pred: () => boolean, tries = 400) => { for (let i = 0; i < tries && !pred(); i++) await new Promise((r) => setTimeout(r, 50)); };

  // 在飞: restarting 但没有失败终态 → 一律拒
  assert.equal(handoffAdmission({ ...failed(), failure: undefined }, now, "old").admit, false);
  // 失败终态还没补偿落盘 → reload 还会接着做, 拒
  assert.equal(handoffAdmission(failed({ failure: { status: 502, reason: "x" } }), now, "new").admit, false);
  // 失败 + 值守会话已不是当前绑定 → 放, 理由写清
  const gone = handoffAdmission(failed(), now, "new");
  assert.equal(gone.admit, true);
  assert.match(gone.admit && gone.release, /值守会话 old 已不是当前绑定 \(new\)/);
  // 失败 + 该 target 没有活会话 → 放 (没提交过重启, 没有破坏在飞)
  assert.equal(handoffAdmission(failed(), now, "").admit, true);
  // 失败 + 没有活会话 + 重启凭证还在 → 拒 (可能只是镜像还没恢复绑定), 老过阈值才放
  assert.equal(handoffAdmission(failed({ clear }), now, "").admit, false);
  assert.equal(handoffAdmission(failed({ clear, at: now - FAILED_STALE_MS - 1 }), now, "").admit, true);
  // 失败 + 值守会话仍是当前绑定 → 拒
  assert.equal(handoffAdmission(failed(), now, "old").admit, false);
  // 重启已提交: clear 的 nextSid 也是值守对象
  assert.equal(handoffAdmission(failed({ clear }), now, "next").admit, false);
  assert.equal(handoffAdmission(failed({ clear }), now, "third").admit, true);
  // 超时兜底: 值守会话还在, 但没人会再核查这条记录 → 放
  assert.equal(handoffAdmission(failed({ at: now - FAILED_STALE_MS - 1 }), now, "old").admit, true);

  // 集成 (交接别人): 值守会话已不是当前绑定 → 新交接开工, 失效记录释放留痕
  {
    store.set("w", failed({ sid: "old" }));
    const before = store.get("w")!.at;
    const admitted = await mk({ sessionId: () => "new" }).h.other("w", "", 1);
    assert.equal(admitted.ok, false);
    assert.match(String(admitted.reason), /一直没能闲下来/, "失效失败记录不再挡住新交接 (进了状态机, 而不是 409)");
    assert.ok((store.get("w")?.at ?? 0) > before, "旧记录被释放, 新一场交接落盘");
    assert.ok(logs.some((l) => l.includes("释放已失效的失败记录") && l.includes("值守会话 old 已不是当前绑定")), "释放留痕");
  }

  // 集成 (交接自己): 失败记录不再挡路 —— 调用即受理, 旧记录被顶掉, 新简报走完全程
  {
    store.clear(); logs.length = 0;
    store.set("w", failed({ sid: "old" }));
    const failedAt = store.get("w")!.at;
    let busy = true;
    const s = mk({ isBusy: () => busy, sessionId: () => "old" });
    const accepted = s.h.self("w", "brief-2");
    assert.equal(accepted.ok, true, "失败记录 + 值守会话仍是当前绑定也不再拒绝 self");
    assert.ok((store.get("w")?.at ?? 0) > failedAt, "旧记录被新请求顶掉");
    busy = false;
    await wait(() => s.injects.some((t) => t.includes("brief-2")));
    assert.ok(s.injects.some((t) => t.includes("brief-2")), "排队等轮终 → 重开 → 新简报贴回");
  }

  // 集成 (排队语义): 等待中被新简报就地接替; 执行中来的请求排队, 前一场了结后自动开工
  {
    store.clear(); logs.length = 0;
    let restartHold!: () => void;
    const held = new Promise<void>((r) => (restartHold = r));
    let restarts = 0;
    let busy = true;
    const s = mk({
      isBusy: () => busy, sessionId: () => "s1",
      restart: async (_t, _p, submitted) => {
        restarts += 1;
        if (restarts === 1) await held;
        submitted({ pane: "p", pid: 1, panePid: 2, sid: "s1", nextSid: `n${restarts}`, at: Date.now() });
        return { ok: true };
      },
    });
    assert.equal(s.h.self("w", "brief-1").ok, true);
    const takeover = s.h.self("w", "brief-2");
    assert.equal(takeover.ok, true);
    assert.equal(takeover.queuedBehind, undefined, "等待中: 新简报就地接替, 不另起一场");
    assert.equal(store.get("w")?.brief, "brief-2");
    busy = false;
    await wait(() => restarts >= 1);
    assert.equal(restarts, 1, "第一场已动手 (restarting)");
    const queued = s.h.self("w", "brief-3");
    assert.equal(queued.ok, true);
    assert.equal(queued.queuedBehind, true, "执行中不报错, 排队到它之后");
    assert.equal(store.get("w")?.queued?.[0]?.brief, "brief-3");
    restartHold();
    await wait(() => s.injects.some((t) => t.includes("brief-3")));
    assert.ok(s.injects.some((t) => t.includes("brief-2")), "第一场贴回 brief-2");
    assert.ok(s.injects.some((t) => t.includes("brief-3")), "排队的 brief-3 在前一场了结后自动执行");
    assert.ok(logs.some((l) => l.includes("排队请求开工")), "排队开工留痕");
    await wait(() => !store.get("w"));
    assert.equal(store.get("w"), undefined, "两场都了结后记录清干净");
  }
}

console.log("handoff/chat-name: retired names never reused, cut finals that settle are kept, resume carries the ask; self handoff accepts-then-queues (takeover while waiting, queued behind executing), other keeps admission");
