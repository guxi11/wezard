#!/usr/bin/env node
// `wezard wx …` —— 在本机终端绑定 / 查看 / 解绑微信 ClawBot。路由都要出示 daemon 口令 (guarded);
// 绑定另要审批人在企微点一张确认卡 —— 口令每个 wizard 都读得到, 光凭它不够。
import QRCode from "qrcode";
import { createInterface } from "node:readline/promises";
import { DAEMON_TOKEN_HEADER, readDaemonToken } from "../shared/daemon-token.js";

const DAEMON = process.env.WEZARD_DAEMON_BASE ?? "http://127.0.0.1:17890";
type Json = Record<string, unknown>;
const call = async (method: "GET" | "POST", p: string, body?: unknown): Promise<Json> => {
  const r = await fetch(`${DAEMON}${p}`, {
    method,
    headers: { "content-type": "application/json", [DAEMON_TOKEN_HEADER]: readDaemonToken() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await r.json().catch(() => ({ ok: false, reason: `HTTP ${r.status}` }))) as Json;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ago = (t: number): string => (t ? `${Math.round((Date.now() - t) / 60_000)} 分钟前` : "—");

interface Account { chatId: string; name: string; state: string; lastInAt: number; held: number; budget: number; sent: number; failed: number }

const list = async (): Promise<void> => {
  const r = await call("GET", "/wx/list") as { enabled?: boolean; max?: number; accounts?: Account[] };
  if (!r.accounts) return void console.error("daemon 没回账号表 —— `wezard status` 看看它在不在");
  console.log(`微信 ClawBot ${r.accounts.length}/${r.max}${r.enabled ? "" : "  (⚠️ weixin.enabled=false, 通道未开启)"}`);
  r.accounts.forEach((a, i) =>
    console.log(`  ${i + 1}. ${a.name || a.chatId}  ${a.state === "live" ? "🟢" : "🔴 掉线"}  上次说话 ${ago(a.lastInAt)}  额度 ${a.budget}  压着 ${a.held}  发 ${a.sent}/败 ${a.failed}`));
};

const bind = async (name: string): Promise<void> => {
  console.log("· 已往企微给审批人推了一张确认卡, 点「同意」后这里出二维码 (3 分钟内有效)…");
  const r = await call("POST", "/wx/bind", { name });
  if (!r.ok) return void console.error(`❌ ${String(r.reason ?? "bind failed")}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let shownQr = "";
  let last = "";
  try {
    for (;;) {
      const s = await call("GET", "/wx/bind/status?id=cli") as { view?: { status: string; qrUrl: string; message: string; name: string } };
      const v = s.view;
      if (!v) return void console.error("❌ 绑定会话丢了 (daemon 重启?), 重新 `wezard wx bind`");
      if (v.qrUrl && v.qrUrl !== shownQr) {
        shownQr = v.qrUrl;
        console.log(await QRCode.toString(v.qrUrl, { type: "terminal", small: true }));
        console.log(`用要绑定的那个人的微信「扫一扫」扫上面的码 (约 2 分钟有效)。扫不出来就在微信里打开: ${v.qrUrl}\n`);
      }
      if (v.message !== last) { last = v.message; console.log(`· ${v.message}`); }
      if (v.status === "need_code" && !/校验中/.test(v.message)) {
        const code = (await rl.question("配对码: ")).trim();
        if (code) {
          const c = await call("POST", "/wx/bind/code", { code });
          if (!c.ok) console.error(`❌ ${String(c.reason)}`);
        }
        continue;
      }
      if (v.status === "done") return void console.log(`✅ 已绑定为群聊「${v.name}」—— 去微信里先给「微信 ClawBot」发一句话, 之后就像企微群一样用`);
      if (v.status === "already" || v.status === "failed") return void console.log(v.status === "already" ? `ℹ️ ${v.message}` : `❌ ${v.message}`);
      await sleep(1_500);
    }
  } finally {
    rl.close();
  }
};

const unbind = async (arg: string): Promise<void> => {
  if (!arg) return void console.error("用法: wezard wx unbind <序号|群名>");
  const r = await call("POST", "/wx/unbind", { chat: arg });
  console.log(r.ok ? "🗑️ 已解绑 (群聊、wizard 与记录保留)" : `❌ ${String(r.reason)}`);
};

const [verb = "list", ...rest] = process.argv.slice(2);
const arg = rest.join(" ").trim();
const run = verb === "bind" ? bind(arg) : verb === "unbind" ? unbind(arg) : verb === "list" ? list() : Promise.resolve(void console.log("用法: wezard wx [list | bind [群名] | unbind <序号|群名>]"));
run.catch((e: Error) => { console.error(`❌ ${e.message}`); process.exit(1); });
