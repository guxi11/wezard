// 外部 agent (CoC) 的接入面: 路由 + 口令文件 + 请求索引 + 审计。
// 纯判定全在 shared/external.ts; 这里只做 IO 与接线。设计见 docs/evolve/external-gateway.md。
//
// 每个调用方一间 adhoc room (gateway 以 DAEMON 身份开, 接待 wizard invite 进来 = host),
// 请求 = 一条 ask 行; 状态永远从房间账本现算, 索引只记房间 / 撤过 / 送达过。
// gateway 只写 ask 行与 system 行, 永远不以调用方身份写 reply —— judge 让 daemon 作者
// 能关任何 duty, 那条能力不给外部。
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import {
  applyExtOp, askText, cancelText, checkQuota, deriveOutcome, extAuthor, extIndexFileOf, externalHomeOf, externalTokenOf,
  foldExtIndex, isWaiting, judgeAck, judgeCancel, judgeExtAuth, localDayKey, overdueOwnerRoom, parseExtIndex, quotaAlertSys,
  redactText, roomTitle, secretsInJson, EXT_TEXT_MAX, EXT_WAIT_DEFAULT, EXT_WAIT_MAX,
  type ExtIndex, type ExtIndexOp, type ExtOutcome, type ExtPrincipal, type ExtRequest,
} from "../shared/external.js";
import { isBoundRoom } from "../shared/room.js";
import { DAEMON_TOKEN_FILE } from "../shared/daemon-token.js";
import { SECRETS_PATH } from "../shared/config.js";
import { expandHome } from "../shared/paths.js";
import { adhocRoomId, DAEMON, idList, whoKey, type Draft, type RoomOp, type RoomState, type Verdict, type Who } from "../shared/room.js";
import type { RoomStore } from "./rooms.js";
import type { Handler } from "./http.js";
import { json, readBody } from "./http.js";

export interface ExternalPorts {
  cfg: () => Config;
  log: Logger;
  store: RoomStore;
  /** room-hub 的 append (走 judge / 唤醒泵) —— ask 行走它。 */
  append: (room: string, d: Draft) => Verdict;
  /** room-hub 的 write —— 非 msg op 与我们自己构造的 system 行走它。 */
  write: (room: string, ops: readonly RoomOp[]) => RoomState;
  /** 接待 wizard 按实例名现查 (uid 是账本里的身份)。 */
  findWizard: (name: string) => { uid: string; name: string } | undefined;
  now?: () => number;
}

interface Aud { principal?: string; req?: string; status?: number; reason?: string }
type Reply = (status: number, body: unknown) => void;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

const headerOf = (req: IncomingMessage, name: string): string => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] ?? "" : v ?? "";
};

const clampSec = (v: unknown, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, EXT_WAIT_MAX) : def;
};

const isoOf = (t: number): string => new Date(t).toISOString();

export const createExternal = (p: ExternalPorts) => {
  const now = (): number => p.now?.() ?? Date.now();
  const stateDir = (): string => p.cfg().daemon.stateDir;
  const log = p.log;

  // ── 索引 ──────────────────────────────────────────────────────────────
  const loadIndex = (): ExtIndex => {
    const f = extIndexFileOf(stateDir());
    let raw = "";
    try { raw = readFileSync(f, "utf8"); } catch { return foldExtIndex([]); }
    const { ops, badLines } = parseExtIndex(raw);
    if (badLines.length) log.warn({ file: f, lines: badLines }, "external: 索引坏行已跳过");
    return foldExtIndex(ops);
  };
  let index = loadIndex();

  /** 追加一行索引 (fsync) 后推进内存。写盘失败 = 整个调用失败 (不吞)。 */
  const record = (op: ExtIndexOp): void => {
    const f = extIndexFileOf(stateDir());
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
    const fd = openSync(f, "a");
    try {
      writeSync(fd, JSON.stringify(op) + "\n");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    applyExtOp(index, op);
  };

  // ── 口令 ──────────────────────────────────────────────────────────────
  const readToken = (name: string): string => {
    try { return readFileSync(externalTokenOf(stateDir(), name), "utf8").trim(); } catch { return ""; }
  };
  /** 缺口令就生成 (32 字节随机); rotate 时无条件重写 (旧口令立即失效)。目录 0700 / 文件 0600。 */
  const ensureToken = (name: string, rotate = false): string => {
    const f = externalTokenOf(stateDir(), name);
    if (!rotate) {
      const cur = readToken(name);
      if (cur) return cur;
    }
    const dir = externalHomeOf(stateDir());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const tok = randomBytes(32).toString("hex");
    const tmp = f + ".tmp";
    writeFileSync(tmp, tok + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, f);
    return tok;
  };
  /** boot 与配置热载后各跑一次: 新加的调用方在第一次调用之前就有口令文件可读。 */
  const syncTokens = (): void => {
    for (const pr of p.cfg().external.principals) {
      try { ensureToken(pr.name); }
      catch (e) { log.warn({ principal: pr.name, err: (e as Error).message }, "external: 口令文件生成失败"); }
    }
  };

  // ── room ──────────────────────────────────────────────────────────────
  const tryState = (room: string): RoomState | undefined => {
    try { return p.store.get(room); } catch (e) {
      log.warn({ room, err: (e as Error).message }, "external: 账本读不出");
      return undefined;
    }
  };

  /** 当前那间房还能用 (接待 wizard 仍是成员) 就复用; 否则开一间新的并记索引。 */
  const ensureRoom = (pr: ExtPrincipal, ws: { uid: string; name: string }): string => {
    const cur = index.rooms.get(pr.name);
    if (cur && cur.reception === pr.reception) {
      const st = tryState(cur.room);
      if (st?.members.has(whoKey({ kind: "wizard", id: ws.uid }))) return cur.room;
    }
    let id = adhocRoomId(randomBytes(4).toString("hex"));
    while (tryState(id)) id = adhocRoomId(randomBytes(4).toString("hex"));
    const at = now();
    const who: Who = { kind: "wizard", id: ws.uid };
    p.write(id, [
      { op: "open", at, room: id, kind: "adhoc", title: roomTitle(pr.name, ws.name), by: DAEMON },
      { op: "join", at, room: id, who, ord: 1, via: "invite", by: DAEMON },
    ]);
    record({ op: "room", at, principal: pr.name, room: id, reception: pr.reception });
    log.info({ principal: pr.name, room: id, reception: ws.name }, "external: 开接待 room");
    return id;
  };

  // ── 出口脱敏 (第 2 步 §3): 只作用在 answer, 账本原样 ────────────────────
  // 口令集合按 mtime 缓存: 文件一变 (轮换 / 改 secrets) 下一次调用就重建, 不每次读盘。
  const secretFiles = (): string[] => [
    DAEMON_TOKEN_FILE, p.cfg().svr.tokenFile,
    ...p.cfg().external.principals.map((x) => externalTokenOf(stateDir(), x.name)),
    SECRETS_PATH,
  ];
  let secretCache: { key: string; list: string[] } = { key: "", list: [] };
  const secretsNow = (): string[] => {
    const files = secretFiles();
    const key = files.map((f) => {
      try { const st = statSync(expandHome(f)); return f + ":" + st.mtimeMs + ":" + st.size; } catch { return f + ":-"; }
    }).join("|");
    if (key === secretCache.key) return secretCache.list;
    const set = new Set<string>();
    for (const f of files) {
      let text = "";
      try { text = readFileSync(expandHome(f), "utf8").trim(); } catch { continue; }
      if (!text) continue;
      if (f === SECRETS_PATH) {
        try { for (const s of secretsInJson(JSON.parse(text))) set.add(s); } catch { /* 坏 json 跳过 */ }
      } else if (text.length >= 8) set.add(text);
    }
    secretCache = { key, list: [...set] };
    return secretCache.list;
  };
  const answerOf = (o: ExtOutcome): { answer?: string } => (o.answer === undefined ? {} : { answer: redactText(o.answer, secretsNow()) });

  const outcomeOf = (rec: ExtRequest): ExtOutcome => deriveOutcome(tryState(rec.room), rec);

  /** 额度告警 (第 2 步 §5): 发到 owner room, 每个调用方每天每种额度最多一次 (去重认账本的 sys 键)。 */
  const alertQuota = (pr: ExtPrincipal, kind: "minute" | "day" | "open", reason: string): void => {
    try {
      const owner = overdueOwnerRoom(pr.owner, isBoundRoom);
      if (!owner) { log.info({ principal: pr.name, kind, owner: pr.owner }, "external: 额度告警没有可发的 owner room"); return; }
      const st = tryState(owner);
      if (!st) { log.warn({ principal: pr.name, owner }, "external: owner room 不存在, 额度告警不发"); return; }
      const sys = quotaAlertSys(pr.name, kind, localDayKey(now()));
      if (st.msgs.some((m) => m.sys === sys)) return;
      const v = p.append(owner, {
        author: DAEMON, kind: "system", origin: "daemon", sys,
        text: "⏰ 外部调用方 " + pr.name + " 触发额度: " + reason,
      });
      if (!v.ok) log.warn({ principal: pr.name, owner, reason: v.reason }, "external: 额度告警写入被拒");
    } catch (e) { log.warn({ principal: pr.name, err: (e as Error).message }, "external: 额度告警失败"); }
  };
  const asksOf = (principal: string): ExtRequest[] => [...index.requests.values()].filter((r) => r.principal === principal);

  const snapshot = (rec: ExtRequest): Record<string, unknown> => {
    const o = outcomeOf(rec);
    return { ok: true, req: rec.req, state: o.state, ...answerOf(o), waitedMs: 0 };
  };

  /** 等到状态离开 open 或超时 (每 500ms 重读一次房间状态, 不忙等)。 */
  const waitFor = async (rec: ExtRequest, ms: number): Promise<Record<string, unknown>> => {
    const started = now();
    const deadline = started + ms;
    for (;;) {
      const o = outcomeOf(rec);
      const waitedMs = now() - started;
      if (o.state !== "open" || now() >= deadline)
        return { ok: true, req: rec.req, state: o.state, ...answerOf(o), waitedMs };
      await sleep(Math.min(500, deadline - now()));
    }
  };

  // ── 鉴权 ──────────────────────────────────────────────────────────────
  const auth = (req: IncomingMessage, a: Aud, reply: Reply): ExtPrincipal | undefined => {
    const name = headerOf(req, "x-wezard-ext").trim();
    a.principal = name || undefined;
    const v = judgeExtAuth(p.cfg().external, name, headerOf(req, "x-wezard-ext-token"), name ? readToken(name) : "");
    if (!v.ok) { reply(403, { ok: false, reason: v.reason }); return undefined; }
    return v.principal;
  };

  /** 统一: 审计一行日志 (调用方 / 路由 / req / 结果码 / 耗时 / 被拒原因), 不让异常断成没有落点。 */
  const guard = (label: string, h: (req: IncomingMessage, res: ServerResponse, url: URL, a: Aud, reply: Reply) => Promise<void>): Handler =>
    async (req, res, url) => {
      const t0 = now();
      const a: Aud = {};
      const reply: Reply = (status, body) => {
        a.status = status;
        const reason = body && typeof body === "object" ? (body as { reason?: unknown }).reason : undefined;
        if (typeof reason === "string") a.reason = reason;
        json(res, status, body);
      };
      try {
        await h(req, res, url, a, reply);
      } catch (e) {
        const msg = (e as Error).message;
        if (!res.headersSent) reply(500, { ok: false, reason: "外部接入内部错误: " + msg });
        else a.reason = msg;
      } finally {
        log.info({ mod: "external", route: label, principal: a.principal, req: a.req, status: a.status, ms: now() - t0,
          ...(a.reason ? { reason: a.reason } : {}) }, "external call");
      }
    };

  const bodyOf = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const b = await readBody(req);
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  };

  // ── 路由 ──────────────────────────────────────────────────────────────
  const ask = guard("POST /external/ask", async (req, res, _url, a, reply) => {
    const pr = auth(req, a, reply);
    if (!pr) return;
    const b = await bodyOf(req);
    const text = typeof b.text === "string" ? b.text : "";
    if (!text.trim()) { reply(400, { ok: false, reason: "text required" }); return; }
    const len = [...text].length;
    if (len > EXT_TEXT_MAX) { reply(400, { ok: false, reason: "正文太长 (最多 " + EXT_TEXT_MAX + " 字, 现在 " + len + " 字)" }); return; }
    const re = typeof b.re === "string" ? b.re.trim() : "";
    if (re) {
      const old = index.requests.get(re);
      if (!old || old.principal !== pr.name) { reply(400, { ok: false, reason: "re 认不出 (不是你的请求): " + re }); return; }
    }
    const ws = p.findWizard(pr.reception);
    if (!ws) { reply(409, { ok: false, reason: "接待 wizard " + pr.reception + " 不在名册" }); return; }
    // 额度先判: 超了就不该替它开一间房 (开房是副作用, 且会留下空的接待 room)。
    const q = checkQuota(asksOf(pr.name), (r) => outcomeOf(r).state, pr, now());
    if (!q.ok) {
      alertQuota(pr, q.kind, q.reason);
      reply(429, { ok: false, reason: q.reason, ...(q.retryAt ? { retryAt: isoOf(q.retryAt) } : {}) });
      return;
    }
    const room = ensureRoom(pr, ws);
    if (re && !tryState(room)?.byId.has(re)) {
      reply(409, { ok: false, reason: "re 那条不在当前 room (" + room + "): 接待 wizard 换人后要从新的请求续" });
      return;
    }
    const thread = typeof b.thread === "string" ? b.thread.trim() : "";
    const v = p.append(room, {
      author: extAuthor(pr.name), kind: "ask", origin: "daemon", text: askText(pr.name, text),
      to: [{ kind: "wizard", id: ws.uid }], ...(re ? { re: [re] } : {}),
    });
    if (!v.ok) { reply(v.status, { ok: false, reason: v.reason }); return; }
    a.req = v.row.id;
    if (!index.requests.has(v.row.id))
      record({ op: "ask", at: now(), principal: pr.name, req: v.row.id, room, ...(thread ? { thread } : {}), ...(re ? { re } : {}) });
    const rec = index.requests.get(v.row.id)!;
    const wait = clampSec(b.wait, 0);
    reply(200, wait > 0 ? await waitFor(rec, wait * 1000) : snapshot(rec));
  });

  const wait = guard("POST /external/wait", async (req, res, _url, a, reply) => {
    const pr = auth(req, a, reply);
    if (!pr) return;
    const b = await bodyOf(req);
    const id = typeof b.req === "string" ? b.req.trim() : "";
    a.req = id || undefined;
    const rec = index.requests.get(id);
    if (!rec || rec.principal !== pr.name) { reply(404, { ok: false, reason: "认不出这条请求 (不是你的): " + (id || "<空>") }); return; }
    reply(200, await waitFor(rec, clampSec(b.timeout, EXT_WAIT_DEFAULT) * 1000));
  });

  const inbox = guard("GET /external/inbox", async (req, res, url, a, reply) => {
    const pr = auth(req, a, reply);
    if (!pr) return;
    const all = url.searchParams.get("all") === "1" || url.searchParams.get("all") === "true";
    const rows = asksOf(pr.name)
      .map((rec) => ({ rec, out: outcomeOf(rec) }))
      .filter(({ rec, out }) => (all ? true : out.state !== "open" && !rec.delivered))
      .sort((x, y) => x.rec.at - y.rec.at)
      .slice(-50)
      .map(({ rec, out }) => ({
        req: rec.req, state: out.state, ...answerOf(out),
        askedAt: isoOf(rec.at), ...(out.answeredAt ? { answeredAt: isoOf(out.answeredAt) } : {}),
        ...(rec.re ? { re: rec.re } : {}), ...(rec.delivered ? { delivered: true } : {}),
      }));
    reply(200, rows);
  });

  const ack = guard("POST /external/ack", async (req, res, _url, a, reply) => {
    const pr = auth(req, a, reply);
    if (!pr) return;
    const b = await bodyOf(req);
    const acked: string[] = [];
    for (const id of idList(b.req)) {
      const rec = index.requests.get(id);
      const out = rec ? outcomeOf(rec) : undefined;
      if (!rec || !out || !judgeAck(rec, pr.name, out.state).ok) continue;
      if (!rec.delivered) record({ op: "ack", at: now(), req: id });
      acked.push(id);
    }
    reply(200, { ok: true, acked });
  });

  const cancel = guard("POST /external/cancel", async (req, res, _url, a, reply) => {
    const pr = auth(req, a, reply);
    if (!pr) return;
    const b = await bodyOf(req);
    const id = typeof b.req === "string" ? b.req.trim() : "";
    a.req = id || undefined;
    const rec = index.requests.get(id);
    if (!rec || rec.principal !== pr.name) { reply(404, { ok: false, reason: "认不出这条请求 (不是你的): " + (id || "<空>") }); return; }
    const st = tryState(rec.room);
    const out = deriveOutcome(st, rec);
    const j = judgeCancel(rec, pr.name, out.state);
    if (!j.ok) { reply(409, { ok: false, reason: j.reason }); return; }
    const holder: Who | undefined = out.holderUid ? { kind: "wizard", id: out.holderUid } : undefined;
    // 走 hub.append 让 judge 算 seq / wake: 这一行要真的把接待 wizard 叫醒去停手 (to 是它, re 是那条请求)。
    const v = p.append(rec.room, {
      author: DAEMON, kind: "system", text: cancelText(pr.name, rec.req), origin: "daemon",
      ...(holder ? { to: [holder] } : {}), re: [rec.req], sys: "ext-cancel",
    });
    if (!v.ok) { reply(v.status, { ok: false, reason: v.reason }); return; }
    record({ op: "cancel", at: now(), req: rec.req });
    reply(200, { ok: true, req: rec.req, state: "canceled", woke: v.row.wake });
  });

  /** GET /external/status (过 daemon 口令闸): 每个调用方的启用态 / 今日用量 / 未结 / 接待 wizard。
   *  接待 wizard 的今日 token 用量不在这里 —— usage.ts 按会话扫一周 transcript, 没有「按 wizard 现成取」的口子。 */
  const status = guard("GET /external/status", async (_req, _res, _url, _a, reply) => {
    const s = p.cfg().external;
    const t = now();
    const day = localDayKey(t);
    const rows = s.principals.map((x) => {
      const asks = asksOf(x.name);
      const today = asks.filter((r) => localDayKey(r.at) === day).length;
      const open = asks.filter((r) => isWaiting(outcomeOf(r).state)).length;
      const lastAt = asks.reduce((m, r) => Math.max(m, r.at), 0);
      return { name: x.name, enabled: x.enabled, reception: x.reception, today, perDay: x.perDay,
        perMinute: x.perMinute, open, maxOpen: x.maxOpen, ...(lastAt ? { lastAt: isoOf(lastAt) } : {}) };
    });
    reply(200, { ok: true, enabled: s.enabled, day, principals: rows });
  });

  const rotate = guard("POST /external/rotate", async (req, res, _url, a, reply) => {
    const b = await bodyOf(req);
    const name = typeof b.name === "string" ? b.name.trim() : "";
    a.principal = name || undefined;
    const pr = p.cfg().external.principals.find((x) => x.name === name);
    if (!pr) { reply(404, { ok: false, reason: "没有这个调用方: " + (name || "<空>") }); return; }
    ensureToken(pr.name, true);
    reply(200, { ok: true, name: pr.name, tokenFile: externalTokenOf(stateDir(), pr.name) });
  });

  return {
    // rotate 重写的是调用方的凭据 = 一条能力, 不能只靠 socket 认人: 由 index.ts 套 daemon 口令闸后单独注册。
    routes: (): Record<string, Handler> => ({
      "POST /external/ask": ask,
      "POST /external/wait": wait,
      "GET /external/inbox": inbox,
      "POST /external/ack": ack,
      "POST /external/cancel": cancel,
    }),
    rotateRoute: (): Handler => rotate,
    statusRoute: (): Handler => status,
    syncTokens,
    /** 诊断 / 测试: 当前索引快照。 */
    index: (): ExtIndex => index,
    isWaiting,
  };
};

export type ExternalGateway = ReturnType<typeof createExternal>;
