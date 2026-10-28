import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { WSClient } from "@wecom/aibot-node-sdk";
import { ConfigSchema } from "../shared/config.js";
import { bindCardChannel, installApprovalEventListener } from "../daemon/approval.js";
import { createPending, resolvePending } from "../daemon/pending.js";
import { initDetailPersistence, recordApproval } from "../daemon/detail.js";

// 「📄 展开完整命令」的回送目标 = 卡片自己的会话身份 (pending → resolved 快照 →
// 24h detail 记录), 不能回落 defaultChat。覆盖: 1:1 单聊 / 群 / slot 子会话 /
// 跨群接管 (cardChannel 换频道) / daemon 重启后只剩 detail 记录 / 全 miss 兜底。
const log = pino({ level: "silent" });
const cfg = ConfigSchema.parse({ bot: { botId: "test", secret: "test" }, defaultChat: "user:tester" });

class Client extends EventEmitter {
  sent: Array<{ target: string; content: string }> = [];
  async sendMessage(target: string, message: any): Promise<any> {
    this.sent.push({ target, content: String(message?.markdown?.content ?? "") });
    return {};
  }
  async updateTemplateCard(): Promise<void> {}
}
const client = new Client();
installApprovalEventListener(client as unknown as WSClient, log, cfg);

const root = mkdtempSync(join(tmpdir(), "wezard-fullcmd-"));
initDetailPersistence(root, log);

let seq = 0;
// 建一张审批卡的完整身份: pending (待决时展开用) + detail 记录 (过期后展开用)。
// 返回 reqId; 结尾统一 resolve, 免得悬着的 timeout rejection 打爆进程。
const pendingPromises: Array<{ reqId: string; promise: Promise<unknown> }> = [];
const seedApproval = (chatKey: string, withPending = true): string => {
  const reqId = `fc-${++seq}-${Date.now().toString(36)}`;
  const meta = {
    kind: "approval" as const,
    createdAt: Date.now(),
    toolName: "Bash",
    toolInput: { command: "echo full-command-body" },
    cwd: "/w",
    sessionId: "sid-" + reqId,
    chatKey,
    transcriptTail: "",
  };
  if (withPending) {
    const { promise } = createPending({ meta, timeoutMs: 60_000, reqId });
    pendingPromises.push({ reqId, promise });
    promise.catch(() => {});
  }
  recordApproval({ id: reqId, toolName: meta.toolName, toolInput: meta.toolInput, cwd: meta.cwd, sessionId: meta.sessionId, chatKey, transcriptTail: "" });
  return reqId;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const clickExpand = async (reqId: string): Promise<Array<{ target: string; content: string }>> => {
  client.sent.length = 0;
  client.emit("event.template_card_event", {
    body: { from: { userid: "tester" }, event: { template_card_event: { event_key: "FULLCMD|" + reqId, task_id: reqId } } },
  });
  await sleep(100);
  return [...client.sent];
};

const assertLandsIn = async (chatId: string, reqId: string, note: string): Promise<void> => {
  const sent = await clickExpand(reqId);
  assert.ok(sent.length >= 1, note + ": expansion sends at least one message");
  for (const s of sent) {
    assert.equal(s.target, chatId, note + ": every chunk lands in the card's own chat");
    assert.notEqual(s.target, "tester", note + ": never the defaultChat DM");
  }
  assert.match(sent[0]!.content, /完整命令/, note + ": carries the full command header");
};

try {
  // 1) 1:1 单聊: 卡在 alice 的 DM 里, 展开回 alice, 不回 defaultChat (tester)。
  await assertLandsIn("alice", seedApproval("user:alice"), "1:1 DM");

  // 2) 群聊: 卡在群里, 展开回群。
  await assertLandsIn("wcgroup", seedApproval("chat:wcgroup"), "group chat");

  // 3) slot 子会话: chatKey 带 #slot, 展开回落到该 key 的 base chat。
  await assertLandsIn("wcgroup", seedApproval("chat:wcgroup#slot2"), "slot sub-session");

  // 4) 跨群接管: 卡片跟着频道走 (principal 是 wizard 的 home, cardChannel 换算到
  //    点它的那个群) —— 展开必须跟着换算, 不是 home 也不是 defaultChat。
  bindCardChannel((key) => (key === "user:wiz-home" ? "chat:wcgroup-b" : key));
  await assertLandsIn("wcgroup-b", seedApproval("user:wiz-home"), "cross-chat takeover");

  // 5) 点过 ✅ 之后 (pending 已删, 只剩 5min resolved 快照) 再展开 —— 修复前的
  //    主症状: 这条路径以前落 defaultChat。
  const resolved = seedApproval("chat:wcgroup");
  resolvePending(resolved, "allow");
  await assertLandsIn("wcgroup", resolved, "after decision click");

  // 6) daemon 重启后: pending / 快照都没了, 24h detail 记录里的 chatKey 兜住。
  await assertLandsIn("wcgroup", seedApproval("chat:wcgroup", false), "detail record only (post-restart)");

  // 7) 全 miss (真鬼卡): 最后一档才兑 defaultChat —— 记录这一既有兜底行为。
  const ghost = "fc-ghost-" + Date.now().toString(36);
  const sent = await clickExpand(ghost);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.target, "tester", "fully-expired card still falls back to defaultChat");
  assert.match(sent[0]!.content, /已过期/, "expired card explains itself");
} finally {
  // 收掉自己种的 pending (含 timer), 进程才能干净退出。
  for (const p of pendingPromises) resolvePending(p.reqId, "deny");
  rmSync(root, { recursive: true, force: true });
}
console.log("fullcmd target routing checks passed (DM / group / slot / takeover / resolved / detail-only / fallback)");
