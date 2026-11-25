// 外部 agent (CoC) 的 CLI: wezard ext <ask|wait|inbox|ack|cancel|rotate>。
// 走 daemon 控制面 unix socket (shared/daemon-client), 身份 = x-wezard-ext + 口令头。
// 输出: 每次一行 JSON 到 stdout (给 agent 读); 非 0 退出 = 鉴权 / 额度 / 连不上, 原因写 stderr。
// 连不上 socket 时退避重试至多 15 秒 (覆盖 daemon reload 的空窗), wait 中途断开同样重试。
import { readFileSync } from "node:fs";
import { loadConfig, type Config } from "../shared/config.js";
import { clientSocketPath } from "../shared/daemon-addr.js";
import { daemonRequest } from "../shared/daemon-client.js";
import { DAEMON_TOKEN_HEADER, readDaemonToken } from "../shared/daemon-token.js";
import {
  extRegistryFileOf, externalTokenOf, mergePrincipals, parseExtRegistry, EXT_WAIT_MAX,
  type ExtPrincipal,
} from "../shared/external.js";

const RETRY_MS = 15_000;
const CONN_CODES = new Set(["ECONNREFUSED", "ENOENT", "ECONNRESET", "EPIPE", "ETIMEDOUT", "EAGAIN", "ENETUNREACH", "EHOSTUNREACH"]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const connErr = (e: unknown): boolean => CONN_CODES.has(String((e as NodeJS.ErrnoException)?.code ?? ""));

const cfg: Config | undefined = ((): Config | undefined => {
  try { return loadConfig().config; } catch { return undefined; }
})();
const SOCK = clientSocketPath(cfg);
const STATE_DIR = cfg?.daemon.stateDir ?? (process.env.WEZARD_STATE_DIR?.trim() || "~/.wezard/state");

function die(reason: string, code = 1): never {
  process.stderr.write(reason.endsWith("\n") ? reason : reason + "\n");
  process.exit(code);
}

const out = (v: unknown): void => { process.stdout.write(JSON.stringify(v) + "\n"); };

interface Parsed { flags: Map<string, string | true>; rest: string[] }
const parseArgs = (argv: string[]): Parsed => {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { rest.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 0) { flags.set(a.slice(2, eq), a.slice(eq + 1)); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags.set(key, next); i++; }
    else flags.set(key, true);
  }
  return { flags, rest };
};

const flagStr = (p: Parsed, key: string): string => {
  const v = p.flags.get(key);
  return typeof v === "string" ? v : "";
};

/** 首连审批登记表 (<stateDir>/external/principals.json): 读不出来就当空。 */
const registry = (): ExtPrincipal[] => {
  try { return parseExtRegistry(readFileSync(extRegistryFileOf(STATE_DIR), "utf8")).entries; }
  catch { return []; }
};
/** 生效名单 = 配置 ∪ 登记表 (同名以配置为准); CLI 只看启用着的。 */
const merged = (): ExtPrincipal[] => mergePrincipals(cfg?.external.principals ?? [], registry());
const enabledNow = (): ExtPrincipal[] => merged().filter((x) => x.enabled);

/** 名字来源: --as / $WEZARD_EXT_NAME 是「明确指定」(可自动发登记卡), 其余是从名单推的。 */
const explicitNameOf = (p: Parsed): string => flagStr(p, "as") || process.env.WEZARD_EXT_NAME?.trim() || "";

/** --as → env → 生效名单里唯一启用的调用方。 */
const resolveName = (p: Parsed): string => {
  const explicit = explicitNameOf(p);
  if (explicit) return explicit;
  const on = enabledNow();
  if (on.length === 1) return on[0]!.name;
  die(on.length ? "有多个启用的调用方, 用 --as <名字> 指定: " + on.map((x) => x.name).join(", ") : "还没有登记或启用的调用方: 用 wezard ext enroll --as <名字> 发登记卡", 2);
};

const tokenOpt = (name: string): string => {
  try { return readFileSync(externalTokenOf(STATE_DIR, name), "utf8").trim(); } catch { return ""; }
};

const stateOf = (r: Resp): string =>
  r.json && typeof r.json === "object" ? String((r.json as { state?: unknown }).state ?? "") : "";

/** 登记 (不等待): 首连审批卡由 daemon 发给审批人私聊。 */
const enrollOnce = async (name: string): Promise<Resp> =>
  withRetry(() => once("POST", "/external/enroll", { name }, {}, 20_000));

/** 读不到口令 = 还没登记: 名字是 --as / env 明确给的, 就顺手发一次登记卡并退 3 (告诉 agent 等人点)。 */
const ensureRegistered = async (name: string, explicit: boolean): Promise<void> => {
  if (tokenOpt(name)) return;
  if (!explicit) {
    const f = externalTokenOf(STATE_DIR, name);
    die("读不到口令文件: " + f + " (daemon 会在启动 / 配置热载时生成; 也可用 wezard ext rotate " + name + ")", 1);
  }
  const r = await enrollOnce(name);
  const st = stateOf(r);
  if (r.status >= 200 && r.status < 300 && st === "enrolled") {
    if (tokenOpt(name)) return;
    die("已登记, 但口令文件还没出现 (再试一次; 仍没有就用 wezard ext rotate " + name + ")", 1);
  }
  if (r.status >= 200 && r.status < 300 && st === "pending") {
    const why = "已向本机主人发登记审批卡, 批准后再试";
    out({ ok: false, state: "pending", reason: why });
    process.stderr.write(why + "\n");
    process.exit(3);
  }
  report(r);
};

interface Resp { status: number; json: unknown; text: string }

const once = (method: string, path: string, body: unknown, headers: Record<string, string>, timeoutMs?: number): Promise<Resp> =>
  daemonRequest(method, path, { ...(body === undefined ? {} : { body }), headers, socketPath: SOCK, ...(timeoutMs ? { timeoutMs } : {}) });

/** 连不上就退避重试, 直到 15 秒预算用完。 */
const withRetry = async (fn: () => Promise<Resp>): Promise<Resp> => {
  const end = Date.now() + RETRY_MS;
  let delay = 200;
  for (;;) {
    try { return await fn(); } catch (e) {
      if (!connErr(e) || Date.now() + delay > end) throw e;
      await sleep(delay);
      delay = Math.min(delay * 2, 2500);
    }
  }
};

const report = (r: Resp): never | void => {
  if (r.status >= 200 && r.status < 300) { out(r.json ?? { ok: true }); return; }
  const reason = (r.json && typeof r.json === "object" ? String((r.json as { reason?: unknown }).reason ?? "") : "") || r.text;
  out(r.json ?? { ok: false, status: r.status });
  die("HTTP " + r.status + ": " + reason);
};

const main = async (): Promise<void> => {
  const [cmd, ...tail] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write([
      "wezard ext <子命令>",
      "  enroll [--as <名字>] [--wait <秒<=60>]                        首发登记: 本机主人会在私聊收到一张审批卡, 点了才启用",
      "  ask [--re <id>] [--wait <秒<=60>] [--thread <t>] <正文 | ->   发一条请求, 有 re = 接着那条续问 (还没登记时会自动发登记卡并退 3)",
      "  wait <req> [--timeout <秒<=60>]                               等它离开 open",
      "  inbox [--all]                                                 取未送达的结果 (--all 含 open / 已送达)",
      "  ack <req...>                                                  确认收到",
      "  cancel <req>                                                  撤回还没交代的请求",
      "  rotate <名字>                                                 重写口令 (旧口令立即失效)",
      "  status                                                        每个调用方的启用态 / 今日用量 / 未结 / 接待 wizard (要 daemon 口令)",
      "  --as <名字> / $WEZARD_EXT_NAME                                指定调用方 (缺省 = 唯一启用的那个)",
      "",
    ].join("\n"));
    return;
  }
  const p = parseArgs(tail);

  if (cmd === "rotate") {
    const name = p.rest[0] ?? flagStr(p, "as") ?? "";
    if (!name) die("rotate 要 <名字>", 2);
    // rotate 要 daemon 口令 (重写口令是一条能力, socket 本身不算凭据); 口令文件按生产路径现读。
    const headers = { [DAEMON_TOKEN_HEADER]: readDaemonToken() };
    report(await withRetry(() => once("POST", "/external/rotate", { name }, headers, 10_000)));
    return;
  }

  if (cmd === "enroll") {
    const want = explicitNameOf(p) || ((): string => {
      const on = enabledNow();
      if (on.length === 1) return on[0]!.name;
      die(on.length ? "有多个已启用的调用方, 用 --as <名字> 指定: " + on.map((x) => x.name).join(", ")
        : "要 --as <名字> 说明是哪个调用方 (还没有已登记 / 启用的)", 2);
    })();
    const waitSec = Math.min(Number(flagStr(p, "wait") || 0) || 0, EXT_WAIT_MAX);
    const end = Date.now() + waitSec * 1000;
    for (;;) {
      const r = await enrollOnce(want);
      const st = stateOf(r);
      if (r.status >= 200 && r.status < 300 && st === "enrolled") { out(r.json ?? { ok: true, state: "enrolled" }); return; }
      if (r.status >= 200 && r.status < 300 && st === "pending" && Date.now() < end) { await sleep(2000); continue; }
      if (r.status >= 200 && r.status < 300 && st === "pending") {
        out(r.json ?? { ok: true, state: "pending" });
        die("已发登记卡, 等本机主人在私聊里点确认 (带 --wait 60 可以等到结果)", 3);
      }
      report(r);
    }
  }
  const name = resolveName(p);
  await ensureRegistered(name, !!explicitNameOf(p));
  const headers = { "x-wezard-ext": name, "x-wezard-ext-token": tokenOpt(name) };

  if (cmd === "ask") {
    let text = p.rest.join(" ");
    if (text === "-" || (text === "" && !process.stdin.isTTY)) text = readFileSync(0, "utf8");
    if (!text.trim()) die("ask 要正文 (或 - 读 stdin)", 2);
    const waitSec = Math.min(Number(flagStr(p, "wait") || 0) || 0, EXT_WAIT_MAX);
    const re = flagStr(p, "re");
    // thread 缺省 = 本次会话 id (第 0 步实测: codebuddy 给 Bash 子进程注入 CODEBUDDY_SESSION_ID,
    // 等于 ACP sessionId, session/load 续接后不变); 再回落 Claude 的。只记录, v1 不按它过滤。
    const thread = flagStr(p, "thread") || process.env.CODEBUDDY_SESSION_ID?.trim() || process.env.CLAUDE_SESSION_ID?.trim() || "";
    const body = {
      text, ...(re ? { re } : {}), ...(thread ? { thread } : {}), ...(waitSec > 0 ? { wait: waitSec } : {}),
    };
    const r = await withRetry(() => once("POST", "/external/ask", body, headers, waitSec > 0 ? waitSec * 1000 + 10_000 : 20_000));
    report(r);
    return;
  }

  if (cmd === "wait") {
    const id = p.rest[0] ?? "";
    if (!id) die("wait 要 <req>", 2);
    const timeoutSec = Math.min(Math.max(Number(flagStr(p, "timeout") || 0) || 30, 0), EXT_WAIT_MAX);
    const end = Date.now() + timeoutSec * 1000;
    for (;;) {
      const remain = Math.max(1, Math.ceil((end - Date.now()) / 1000));
      try {
        const r = await once("POST", "/external/wait", { req: id, timeout: remain }, headers, remain * 1000 + 10_000);
        report(r);
        return;
      } catch (e) {
        // 中途断开: 不把断开报成失败, 按剩余时间重试 (预算用尽才真报)。
        if (!connErr(e) || Date.now() > end + RETRY_MS) throw e;
        await sleep(300);
      }
    }
  }

  if (cmd === "status") {
    // 诊断面要 daemon 口令 (同 rotate); 不需要调用方口令 —— 它看的是全部调用方。
    const headers = { [DAEMON_TOKEN_HEADER]: readDaemonToken() };
    report(await withRetry(() => once("GET", "/external/status", undefined, headers, 20_000)));
    return;
  }

  if (cmd === "inbox") {
    const q = p.flags.has("all") ? "?all=1" : "";
    report(await withRetry(() => once("GET", "/external/inbox" + q, undefined, headers, 20_000)));
    return;
  }

  if (cmd === "ack") {
    if (!p.rest.length) die("ack 要 <req...>", 2);
    report(await withRetry(() => once("POST", "/external/ack", { req: p.rest }, headers, 20_000)));
    return;
  }

  if (cmd === "cancel") {
    const id = p.rest[0] ?? "";
    if (!id) die("cancel 要 <req>", 2);
    report(await withRetry(() => once("POST", "/external/cancel", { req: id }, headers, 20_000)));
    return;
  }

  die("未知子命令: " + cmd + " (wezard ext help)", 2);
};

main().catch((e: unknown) => {
  const err = e as NodeJS.ErrnoException;
  die("连不上 daemon (" + SOCK + "): " + (err?.code ? err.code + " " : "") + (err?.message ?? String(e)));
});
