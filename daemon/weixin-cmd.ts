// `/wx` 命令、`/wx/*` 路由、绑定落定后的那几件事、微信侧的 SendMedia。
//
// 门槛: 二维码就是授权凭据 —— 谁扫了谁就能驱动本机。所以只有审批人 (wxAdmins) 能在**企微单聊**
// 里发起; 本机终端 (`wezard wx bind`) 发起的要先给审批人推一张确认卡, 点了才出码 —— 口令
// 每个 wizard 都读得到, 光凭口令等于任何 wizard 都能给本机多开一个微信入口。群里发起直接拒绝:
// 群里谁都看得见码。
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import QRCode from "qrcode";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import { appendUnique, patchJsonc } from "../shared/config-writer.js";
import { baseOfKey } from "../shared/session-label.js";
import { shortNameOf } from "../shared/wx-text.js";
import { applyChatNames, chatNameOf, listChatNames, normChatName, uniqueChatName } from "./chat-name.js";
import { json, readBody, type Handler } from "./http.js";
import { planMedia, kindOf, type SendMedia, type MediaKind } from "./media.js";
import { settleName, wizardStore } from "./wizard.js";
import { WX_MEDIA_MAX, type BindView, type Weixin, type WxAccount, type WxMediaKind } from "./weixin.js";

// ── 命令解析 (纯) ────────────────────────────────────────────────────
export type WxCommand = { verb: "list" } | { verb: "bind"; name: string } | { verb: "code"; code: string } | { verb: "unbind"; arg: string } | { verb: "help" };
export const parseWxCommand = (text: string): WxCommand | undefined => {
  const m = /^\/wx(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i.exec((text ?? "").trim());
  if (!m) return undefined;
  const verb = (m[1] ?? "").toLowerCase();
  const arg = (m[2] ?? "").trim();
  return verb === "" || verb === "list" ? { verb: "list" }
    : verb === "bind" ? { verb: "bind", name: arg }
    : verb === "code" ? { verb: "code", code: arg }
    : verb === "unbind" ? { verb: "unbind", arg }
    : { verb: "help" };
};

/** 能发起绑定的人: 审批人名单; 名单空 → defaultChat (是个人的话); 再不然 → allowFrom 里的人
 *  (defaultChat 是群时, 认领那一步把认领人写进了 allowFrom)。 */
export const wxAdmins = (cfg: Config): string[] =>
  cfg.approval.approvers.length ? cfg.approval.approvers
    : cfg.defaultChat?.startsWith("user:") ? [cfg.defaultChat]
    : cfg.wrc.allowFrom.filter((p) => p.startsWith("user:"));
export const isWxAdmin = (cfg: Config, userPrincipal: string): boolean => wxAdmins(cfg).includes(userPrincipal);

const ago = (t?: number): string => {
  if (!t) return "—";
  const s = Math.round((Date.now() - t) / 1000);
  return s < 90 ? `${s}s 前` : s < 5400 ? `${Math.round(s / 60)} 分钟前` : s < 172800 ? `${Math.round(s / 3600)} 小时前` : `${Math.round(s / 86400)} 天前`;
};

export const renderAccounts = (cfg: Config, xs: readonly WxAccount[]): string =>
  xs.length === 0
    ? "[wezard] 还没有绑定微信。企微单聊里发 `/wx bind [群名]` 扫码绑定。"
    : [
      `*微信 ClawBot* (${xs.length}/${cfg.weixin.maxAccounts}${cfg.weixin.enabled ? "" : " · ⚠️ 通道未开启"})`,
      ...xs.map((a, i) => {
        const name = chatNameOf(cfg, `chat:${a.chatId}`) || a.chatId;
        const ctx = a.ctx ? `额度 ${Math.max(0, cfg.weixin.sendCap - a.ctx.used)}/${cfg.weixin.sendCap}` : "无 token";
        return `${i + 1}. \`${name}\` ${a.state === "live" ? "🟢" : "🔴 掉线"} · 上次说话 ${ago(a.lastInAt)} · ${ctx}${a.outbox.length ? ` · 📬 压着 ${a.outbox.length}` : ""} · 发 ${a.sent ?? 0} / 败 ${a.failed ?? 0}`;
      }),
      "",
      "`/wx bind [群名]` 绑新号 · `/wx unbind <序号|群名>` 解绑",
    ].join("\n");

const HELP = [
  "*/wx* 微信 ClawBot (仅审批人, 企微单聊)",
  "`/wx` 列出已绑定的微信",
  "`/wx bind [群名]` 出二维码, 用要绑定的那个微信扫 (约 2 分钟有效)",
  "`/wx code <配对码>` 微信上显示配对码时回填",
  "`/wx unbind <序号|群名>` 解绑 (群聊与 wizard 保留)",
].join("\n");

const viewLine = (v: BindView): string =>
  v.status === "qr" ? `📱 ${v.message}`
    : v.status === "scaned" ? "👀 已扫码, 请在微信里点「确认」"
    : v.status === "need_code" ? `🔢 ${v.message}: 发 \`/wx code <配对码>\``
    : v.status === "done" ? `✅ 微信已绑定为群聊 \`${v.name}\` —— 去微信里先给「微信 ClawBot」发一句话 (机器人在你开口前不能说话); 之后像企微群一样用, \`.名字\` 点名 wizard`
    : v.status === "already" ? `ℹ️ ${v.message}`
    : `❌ 绑定失败: ${v.message}`;

// ── 绑定落定 ─────────────────────────────────────────────────────────
export interface BoundDeps {
  cfg: Config;
  sourcePath: string;
  log: Logger;
  hasSession: (target: string) => boolean;
  newSession: (target: string, windowName: string) => Promise<{ ok: boolean; reason?: string }>;
}

/** 起群名 (只填空)、进 allowFrom、生默认 wizard —— 与企微群聊首条消息走的是同一套。 */
export const makeOnBound = ({ cfg, sourcePath, log, hasSession, newSession }: BoundDeps) =>
  async (acct: WxAccount, wantName: string): Promise<string> => {
    const base = `chat:${acct.chatId}`;
    const have = chatNameOf(cfg, base);
    const name = have || (() => {
      const want = normChatName(wantName).replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 32) || shortNameOf(acct.userId);
      const taken = new Set(listChatNames(cfg).map((c) => c.name.toLowerCase()));
      const picked = uniqueChatName(want, taken);
      applyChatNames(cfg, sourcePath, { [base]: picked });
      return picked;
    })();
    if (!cfg.wrc.allowFrom.includes(base)) {
      cfg.wrc.allowFrom.push(base);
      try { appendUnique(sourcePath, ["wrc", "allowFrom"], base); } catch (e) { log.error({ err: (e as Error).message }, "weixin allowFrom write failed"); }
    }
    if (!hasSession(base)) {
      const wiz = settleName(wizardStore(), name, base);
      const r = await newSession(base, wiz || name);
      if (!r.ok) log.warn({ base, reason: r.reason }, "weixin default wizard spawn failed (首条消息时会再开)");
    }
    return name;
  };

/** 解绑时撤销授权 (群名与 wizard 留着 —— 历史还在 rolepage 上)。 */
export const revokeAllow = (cfg: Config, sourcePath: string, chatId: string): void => {
  const base = `chat:${chatId}`;
  if (!cfg.wrc.allowFrom.includes(base)) return;
  cfg.wrc.allowFrom = cfg.wrc.allowFrom.filter((x) => x !== base);
  patchJsonc(sourcePath, [{ path: ["wrc", "allowFrom"], value: cfg.wrc.allowFrom }]);
};

// ── 二维码 ───────────────────────────────────────────────────────────
export const qrPng = async (content: string): Promise<string> => {
  const dir = join(tmpdir(), "wezard-wx");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `qr-${Date.now().toString(36)}.png`);
  writeFileSync(path, await QRCode.toBuffer(content, { type: "png", width: 420, margin: 2 }));
  return path;
};

// ── 命令 ─────────────────────────────────────────────────────────────
export interface CmdDeps {
  cfg: Config;
  sourcePath: string;
  log: Logger;
  wx: Weixin;
  /** 原生企微出口 (不经微信分流)。 */
  sendWecom: (principal: string, markdown: string) => void;
  sendWecomMedia: SendMedia;
}

/** 解绑参数: 序号 / 群名 / chat:wx_… / wx_… → chatId。 */
const pickAccount = (cfg: Config, xs: readonly WxAccount[], arg: string): WxAccount | undefined => {
  const n = Number(arg);
  if (Number.isInteger(n) && n >= 1) return xs[n - 1];
  const a = arg.replace(/^chat:/, "").toLowerCase();
  return xs.find((x) => x.chatId.toLowerCase() === a || chatNameOf(cfg, `chat:${x.chatId}`).toLowerCase() === a);
};

/** 企微侧一次绑定的进度推送: 新码发图, 关键状态各一句。 */
const wecomBindSink = (d: CmdDeps, to: string): ((v: BindView) => void) => {
  let lastQr = "";
  let last = "";
  return (v) => {
    if (v.status === "qr" && v.qrUrl && v.qrUrl !== lastQr) {
      lastQr = v.qrUrl;
      void (async () => {
        try {
          const r = await d.sendWecomMedia(to, { path: await qrPng(v.qrUrl), kind: "image", name: "weixin-bind.png" });
          if (!r.ok) d.log.warn({ reason: r.reason }, "weixin qr image failed");
        } catch (e) { d.log.warn({ err: (e as Error).message }, "weixin qr render failed"); }
        d.sendWecom(to, `📱 ${v.refresh ? `二维码已换新 (${v.refresh}/3)。` : ""}用**要绑定的那个人的微信**扫上图 (约 2 分钟有效)。手机上只有这一台时: 长按图片存到相册, 微信「扫一扫」右上角选相册。\n\n扫不了也可以在微信里打开: ${v.qrUrl}`);
      })();
      return;
    }
    const line = v.status === "qr" ? "" : viewLine(v);
    if (line && line !== last) { last = line; d.sendWecom(to, line); }
  };
};

export interface WxCmdCtx {
  /** 发话人 `user:…`。 */
  sender: string;
  /** 本聊天 base principal。 */
  chat: string;
  reply: (text: string) => Promise<void>;
}

export const makeWxCommands = (d: CmdDeps) => async (ctx: WxCmdCtx, cmd: WxCommand): Promise<void> => {
  const { cfg, wx } = d;
  const dm = ctx.chat.startsWith("user:");
  if (!isWxAdmin(cfg, ctx.sender)) return ctx.reply("[wezard] `/wx` 只有审批人能用 (approval.approvers; 空则 defaultChat / allowFrom 里的人)");
  if (cmd.verb === "help") return ctx.reply(HELP);
  if (cmd.verb === "list") return ctx.reply(renderAccounts(cfg, wx.list()));
  if (!dm && cmd.verb !== "unbind") return ctx.reply("[wezard] 绑定只能在和机器人的**单聊**里发起 —— 二维码就是授权凭据, 群里谁都能扫");
  if (cmd.verb === "bind") {
    if (!cfg.weixin.enabled) return ctx.reply("[wezard] 微信通道未开启: 先 `config_set weixin.enabled=true` (放权项, 会推卡确认), reload 后再 `/wx bind`");
    const r = wx.startBind(ctx.sender, cmd.name, wecomBindSink(d, ctx.chat));
    return r.ok ? undefined : ctx.reply(`[wezard] ${r.reason}`);
  }
  if (cmd.verb === "code") {
    const r = wx.submitCode(ctx.sender, cmd.code);
    return ctx.reply(r.ok ? "🔢 配对码已提交, 校验中…" : `[wezard] ${r.reason}`);
  }
  const a = pickAccount(cfg, wx.list(), cmd.arg);
  if (!a) return ctx.reply(`[wezard] 认不出要解绑哪个: \`${cmd.arg || "(空)"}\`\n\n${renderAccounts(cfg, wx.list())}`);
  const r = wx.unbind(a.chatId);
  if (r.ok) revokeAllow(cfg, d.sourcePath, a.chatId);
  return ctx.reply(r.ok ? `🗑️ 已解绑 \`${chatNameOf(cfg, `chat:${a.chatId}`) || a.chatId}\` (群聊、wizard 与记录保留; 微信客户端里那个对话可能还在, 但已无人应答)` : `[wezard] ${r.reason}`);
};

// inbound 的 gate 只认这一个钩子, 不改 installInboundRouter 的签名。
let handler: ((ctx: WxCmdCtx, cmd: WxCommand) => Promise<void>) | undefined;
export const bindWxCommands = (fn: typeof handler): void => { handler = fn; };
export const wxCommandHandler = (): typeof handler => handler;

// ── 路由 (CLI / rolepage) ────────────────────────────────────────────
export interface RouteDeps extends Pick<CmdDeps, "cfg" | "wx" | "sourcePath"> {
  /** 推确认卡给审批人, 等人点; 发不出去就抛。 */
  confirmBind: (name: string) => Promise<boolean>;
}

/** 全部要出示 daemon 口令 (index.ts 套 guarded); rolepage 读的是推送的 facts, 不走这里。 */
export const wxRoutes = (d: RouteDeps): Record<string, Handler> => ({
  "GET /wx/list": (_req, res) => json(res, 200, {
    ok: true,
    enabled: d.cfg.weixin.enabled,
    max: d.cfg.weixin.maxAccounts,
    accounts: d.wx.list().map((a) => ({
      chatId: a.chatId, name: chatNameOf(d.cfg, `chat:${a.chatId}`), state: a.state, boundBy: a.boundBy, boundAt: a.boundAt,
      lastInAt: a.lastInAt ?? 0, lastOutAt: a.lastOutAt ?? 0, held: a.outbox.length,
      budget: a.ctx ? Math.max(0, d.cfg.weixin.sendCap - a.ctx.used) : 0, sent: a.sent ?? 0, failed: a.failed ?? 0,
      pausedUntil: a.pausedUntil ?? 0,
    })),
  }),
  "POST /wx/bind": async (req, res) => {
    const b = (await readBody(req)) as { name?: string };
    const name = (b.name ?? "").trim();
    if (!d.cfg.weixin.enabled) { json(res, 400, { ok: false, reason: "微信通道未开启 (weixin.enabled=false)" }); return; }
    const yes = await d.confirmBind(name).catch((e: Error) => { json(res, 503, { ok: false, reason: `确认卡发不出去: ${e.message}` }); return undefined; });
    if (yes === undefined) return;
    if (!yes) { json(res, 403, { ok: false, reason: "审批人没有同意 (拒绝或超时)" }); return; }
    const r = d.wx.startBind("cli", name, () => undefined);
    json(res, r.ok ? 200 : 400, r);
  },
  "GET /wx/bind/status": (_req, res, url) => {
    const v = d.wx.bindOf(url.searchParams.get("id") || "cli");
    json(res, v ? 200 : 404, v ? { ok: true, view: v } : { ok: false, reason: "no such bind" });
  },
  "POST /wx/bind/code": async (req, res) => {
    const b = (await readBody(req)) as { code?: string };
    const r = d.wx.submitCode("cli", (b.code ?? "").trim());
    json(res, r.ok ? 200 : 400, r);
  },
  "POST /wx/unbind": async (req, res) => {
    const b = (await readBody(req)) as { chat?: string };
    const a = pickAccount(d.cfg, d.wx.list(), (b.chat ?? "").trim());
    if (!a) { json(res, 404, { ok: false, reason: "no such account" }); return; }
    const r = d.wx.unbind(a.chatId);
    if (r.ok) revokeAllow(d.cfg, d.sourcePath, a.chatId);
    json(res, r.ok ? 200 : 400, r);
  },
});

// ── 微信侧 SendMedia ─────────────────────────────────────────────────
const WX_KIND: Record<MediaKind, WxMediaKind> = { image: "image", video: "video", file: "file", voice: "file" };

/** 微信不发语音条 (官方插件也不发, 社区: 发出后客户端不显示) → 当文件; 上限 WX_MEDIA_MAX。 */
export const planWxMedia = (spec: Parameters<SendMedia>[1]): ReturnType<typeof planMedia> => {
  if (!spec.path.startsWith("/")) return { ok: false, reason: `path 要写绝对路径: ${spec.path}` };
  const st = ((): ReturnType<typeof statSync> | undefined => { try { return statSync(spec.path); } catch { return undefined; } })();
  if (!st?.isFile()) return { ok: false, reason: `文件不存在或不是普通文件: ${spec.path}` };
  const name = spec.name?.trim() || basename(spec.path);
  const bytes = Number(st.size);
  if (bytes > WX_MEDIA_MAX) return { ok: false, reason: `微信侧单文件上限 ${WX_MEDIA_MAX / 1024 / 1024}MB, 「${name}」有 ${(bytes / 1024 / 1024).toFixed(1)}MB` };
  const kind = spec.kind ?? kindOf(name);
  return { ok: true, kind: kind === "voice" ? "file" : kind, name, bytes };
};

export const weixinSendMedia = (wx: Weixin): SendMedia => async (target, spec) => {
  const chatId = baseOfKey(target).replace(/^chat:/, "");
  const plan = planWxMedia(spec);
  if (!plan.ok) return plan;
  const r = await wx.sendMedia(chatId, { path: spec.path, kind: WX_KIND[plan.kind], name: plan.name });
  return r.ok ? plan : r;
};

/** 按收件聊天分流: 绑定过的微信群聊走微信, 其余企微。 */
export const routeSendMedia = (wx: Weixin, wxSend: SendMedia, aibot: SendMedia): { send: SendMedia; plan: (target: string, spec: Parameters<SendMedia>[1]) => ReturnType<typeof planMedia> } => {
  const isWx = (t: string): boolean => wx.owns(baseOfKey(t).replace(/^chat:/, ""));
  return {
    send: (t, s) => (isWx(t) ? wxSend(t, s) : aibot(t, s)),
    plan: (t, s) => (isWx(t) ? planWxMedia(s) : planMedia(s)),
  };
};
