// 外部 agent (CoC) 的 CLI: wezard ext <ask|wait|inbox|ack|cancel|rotate>。
// 走 daemon 控制面 unix socket (shared/daemon-client), 身份 = x-wezard-ext + 口令头。
// 输出: 每次一行 JSON 到 stdout (给 agent 读); 非 0 退出 = 鉴权 / 额度 / 连不上, 原因写 stderr。
// 连不上 socket 时退避重试至多 15 秒 (覆盖 daemon reload 的空窗), wait 中途断开同样重试。
import { readFileSync } from "node:fs";
import { loadConfig, type Config } from "../shared/config.js";
import { clientSocketPath } from "../shared/daemon-addr.js";
import { daemonRequest } from "../shared/daemon-client.js";
import { DAEMON_TOKEN_HEADER, readDaemonToken } from "../shared/daemon-token.js";
import { externalTokenOf, EXT_WAIT_MAX } from "../shared/external.js";

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

/** --as → env → 配置里唯一启用的调用方。 */
const resolveName = (p: Parsed): string => {
  const explicit = flagStr(p, "as") || process.env.WEZARD_EXT_NAME?.trim() || "";
  if (explicit) return explicit;
  const on = (cfg?.external.principals ?? []).filter((x) => x.enabled);
  if (on.length === 1) return on[0]!.name;
  die(on.length ? "有多个启用的调用方, 用 --as <名字> 指定: " + on.map((x) => x.name).join(", ") : "没有启用的调用方 (external.principals 为空或都关了)", 2);
};

const tokenOf = (name: string): string => {
  const f = externalTokenOf(STATE_DIR, name);
  try {
    const t = readFileSync(f, "utf8").trim();
    if (t) return t;
    die("口令文件是空的: " + f + " (用 wezard ext rotate " + name + " 重写)", 1);
  } catch {
    die("读不到口令文件: " + f + " (daemon 会在启动 / 配置热载时生成; 也可用 wezard ext rotate " + name + ")", 1);
  }
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
      "  ask [--re <id>] [--wait <秒<=60>] [--thread <t>] <正文 | ->   发一条请求, 有 re = 接着那条续问",
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

  const name = resolveName(p);
  const headers = { "x-wezard-ext": name, "x-wezard-ext-token": tokenOf(name) };

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
