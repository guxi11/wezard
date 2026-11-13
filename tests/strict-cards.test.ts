import assert from "node:assert/strict";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { makeAskHandler } from "../daemon/ask.js";
import { makeApproveHandler } from "../daemon/approval.js";
import { drainForReload } from "../daemon/pending.js";

// P7-S2 判据⑦: strict 群里非成员的审批卡 / 提问卡 100% 直接进群 ——
// 出站门只拦「模型的发言」(mirror 的流/standalone/终句), 卡片是守护进程发的
// (client.sendMessage 直发), 不查成员资格、不走 mirror 队列。

const STRICT = "chat:wrStrict";
const log = pino({ level: process.env.CARD_DEBUG ? "info" : "silent" });
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const cfg = ConfigSchema.parse({ bot: { botId: "t", secret: "t" }, chatPolicy: { [STRICT]: { speech: "strict" } }, daemon: { stateDir: join(mkdtempSync(join(tmpdir(), "strict-cards-")), "state") } });

// 假 client: 数卡; wsConnected 形状满足 reachable (connFor → isConnected)。
const sentCards: Array<{ chat: string; type: string }> = [];
const client = {
  sendMessage: async (chat: string, body: { msgtype: string }) => {
    sentCards.push({ chat, type: body.msgtype });
    return { errcode: 0 };
  },
  on: () => undefined,
  isConnected: true,
};

// 假 req/res (readBody 走 async iterator; json 落到 captured)。
const mkReq = (body: unknown) => {
  const buf = Buffer.from(JSON.stringify(body));
  return (async function* () { yield buf; })() as unknown as import("node:http").IncomingMessage;
};
const replies: Array<{ status: number; body: unknown }> = [];
const mkRes = () => ({
  writeHead(status: number) { replies.push({ status, body: undefined }); return this; },
  end(body?: string) { const last = replies[replies.length - 1]; if (last) last.body = body; return this; },
  setHeader: () => undefined,
}) as unknown as import("node:http").ServerResponse;

// ── 提问卡 (makeAskHandler): 非成员 (chat 里没有成员表记录也照样) 10/10 直进群 ──
const ask = makeAskHandler(client as never, log);
let asked = 0;
for (let i = 0; i < 10; i++) {
  void ask(mkReq({ chat: STRICT, title: "选一个 " + i, options: [{ label: "A", key: "a" }, { label: "B", key: "b" }] }) as never, mkRes());
  // 卡是同步发出的; 等 promise 一拍。
  await new Promise((r) => setImmediate(r));
  if (sentCards.length > asked) asked = sentCards.length;
}
assert.equal(sentCards.filter((c) => c.chat === "wrStrict" && c.type === "template_card").length, 10,
  "提问卡 10/10 直进 strict 群 (非成员不拦)");

// ── 审批卡 (makeApproveHandler): 非成员会话的工具审批卡直进群 ──
sentCards.length = 0;
const approve = makeApproveHandler({
  cfg, log, client: client as never, sourcePath: "/tmp/nonexistent-config.jsonc",
  getMirrorTarget: () => STRICT + "#nonmember", // 非成员 (成员表里根本没有它) 的会话
  flushBeforeCard: async () => undefined,
  nativeModal: { hasPane: () => false, answer: async () => ({ ok: false }), cancel: async () => ({ ok: false }) },
});
// 逐个投 10 个危险工具调用 (rm 工作区路径 → danger 档 → 必发卡)
const tools = ["Bash", "Bash", "Bash", "Bash", "Bash", "Bash", "Bash", "Bash", "Bash", "Bash"];
const errors: string[] = [];
for (let i = 0; i < tools.length; i++) {
  approve(mkReq({
    session_id: "sess-nonmember-" + i,
    tool_name: "Bash",
    tool_input: { command: "find /Users/zyy/develop/some -name 'wip-" + i + ".log' -delete", description: "批量删除 " + i },
    cwd: "/Users/zyy/develop/some",
  }) as never, mkRes()).catch((e) => errors.push(String(e)));
}
// 卡片路径是异步的 (flushBatch): 轮询等齐 10 张 (上限 10s)。
for (let wait = 0; wait < 200 && sentCards.length < 10; wait++) await new Promise((r) => setTimeout(r, 50));
const approvalCards = sentCards.filter((c) => c.chat === "wrStrict" && c.type === "template_card");
assert.equal(approvalCards.length, 10, "审批卡 10/10 直进 strict 群 (非成员不拦), 实际 " + approvalCards.length + ", replies=" + JSON.stringify(replies) + ", errors=" + JSON.stringify(errors.slice(0, 3)));

// 长轮询的 pending 清干净 (43200s 计时器会拖住测试进程)。
drainForReload();
console.log("strict-cards: 非成员审批卡 10/10 + 提问卡 10/10 直接进 strict 群");
process.exit(0);
