// 群消息「艾特了别人」判定 (shared/mention-filter.ts): 有 @ 但没一个冲着本机器人、且剩下的不是资源 → 拦。
import assert from "node:assert/strict";
import { addressesOthers, looksLikeResource, mentionedOthers } from "../shared/mention-filter.js";

const BOT = ["wezard", "weSingapore"];
const others = (t: string): boolean => addressesOthers(BOT, t);

// 无艾特 → 原流程
assert.equal(others("看下这个报错"), false, "无艾特");
assert.equal(others(""), false, "空串");
assert.equal(others("a @ b"), false, "孤立 @ 不是艾特");

// 艾特本机器人 → 原流程 (大小写不敏感 / 紧贴中文 / 行中)
assert.equal(others("@weSingapore 看下"), false, "艾特机器人");
assert.equal(others("@wesingapore 看下"), false, "机器人名大小写不敏感");
assert.equal(others("@wezard请看下"), false, "中文紧贴");
assert.equal(others("请 @wezard 看下"), false, "行中");
assert.equal(others("@wezardx 看下"), true, "名字前缀相同但不是本机器人");

// 艾特别人 → 拦
assert.equal(others("@张三 看下这个"), true, "艾特别人");
assert.equal(others("你好@张三 看下"), true, "CJK 紧贴的 @");
assert.equal(others("(@alice) 在吗"), true, "括号里的 @");
assert.deepEqual(mentionedOthers(BOT, "@alice @bob 看下"), ["alice", "bob"]);
assert.deepEqual(mentionedOthers(BOT, "@alice, 看下"), ["alice"], "尾标点不进名字");

// 艾特别人 + 路径 → 路径不算人, 仍拦; 只有路径 → 放行
assert.equal(others("@张三 帮看下 @src/foo.ts"), true, "别人 + 路径: 仍拦");
assert.equal(others("@src/foo.ts 看下"), false, "只有路径");
assert.equal(others("看下 @foo.ts 和 @a/b"), false, "只有文件 / 路径");
assert.equal(others("@types/node 升级了"), false, "npm scope");
assert.equal(others("@README.md 要改"), false, "裸文件名");
assert.equal(others("@.env 别提交"), false, "点开头的文件");
assert.deepEqual(mentionedOthers(BOT, "@张三 @src/foo.ts"), ["张三"], "只返回人");

// 艾特别人 + 本机器人 → 放行
assert.equal(others("@张三 @weSingapore 一起看下"), false, "别人 + 机器人");
assert.equal(others("@weSingapore @张三 一起看下"), false, "机器人 + 别人 (顺序无关)");
assert.deepEqual(mentionedOthers(BOT, "@张三 @wezard"), [], "放行时不返回");
assert.equal(others("@all 开会"), false, "@all 也冲着机器人");
assert.equal(others("@所有人 开会"), false, "@所有人 也冲着机器人");

// 邮箱 / URL → 不算艾特
assert.equal(others("联系 bob@example.com 吧"), false, "邮箱");
assert.equal(others("git clone git@github.com:foo/bar.git"), false, "scp 式 git 地址");
assert.equal(others("见 https://medium.com/@someone/post"), false, "URL 里的 @user");
assert.equal(others("https://user:pw@host/x"), false, "URL 凭据");
assert.equal(others("发给 bob@example.com 并 @张三"), true, "邮箱不算, 但同句真的艾特了别人");

// 资源判据
assert.equal(looksLikeResource("src/foo.ts"), true);
assert.equal(looksLikeResource("foo.ts"), true);
assert.equal(looksLikeResource("bob.com"), true);
assert.equal(looksLikeResource("john.smith"), true, "边界假设: 带点的人名被当文件, 不拦");
assert.equal(looksLikeResource("张三"), false);
assert.equal(looksLikeResource("alice"), false);

// 机器人名未知 (空表) 时判定本身仍把任何人名当「别人」—— 调用方在 botNames 为空时不得拦 (见 inbound)
assert.equal(addressesOthers([], "@weSingapore 看下"), true);

console.log("mention-filter ok");

// ── 端到端: installInboundRouter 在 dispatch 之前拦 ──────────────────────
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const pino = (await import("pino")).default;
const { ConfigSchema } = await import("../shared/config.js");
const { installInboundRouter } = await import("../daemon/inbound.js");
const { bindWizardStore, loadWizardStore } = await import("../daemon/wizard.js");

const run = async (botNames: string[], bodies: Array<Record<string, unknown>>): Promise<number> => {
  const ROOT = mkdtempSync(join(tmpdir(), "mention-filter-"));
  const cfg = ConfigSchema.parse({
    bot: { botId: "test", secret: "test" },
    daemon: { stateDir: join(ROOT, "state") },
    wrc: { allowFrom: ["user:tester"], botNames, channel: { history: { enabled: false } } },
    chatPolicy: { "chat:G": { steward: "fix" } },
    defaultChat: "user:home",
  });
  const store = bindWizardStore(loadWizardStore(join(ROOT, "wizards.json")));
  store.upsert("user:home", { identity: "user:home", name: "gsw", description: "全局管家", kind: "global-steward", bornAt: 1 });
  store.upsert("chat:G#fix", { identity: "chat:G#fix", name: "fix", description: "工人", bornAt: 2 });
  const handlers = new Map<string, (f: unknown) => Promise<void>>();
  let dispatched = 0;
  const bridge = {
    hasMirrorTarget: () => true, isOpenBubbleQuote: () => false, status: () => ({ mirrors: [] }),
    getCwd: () => ({ runningCwd: "/repo", defaultCwd: "/repo" }), newSession: async () => ({ ok: true }),
    dispatch: async () => { dispatched++; },
    chatRoster: () => [], peers: async () => [], interruptPane: async () => ({ ok: true }),
    killPane: async () => ({ ok: true }), submitPane: async () => ({ ok: true }),
  };
  const client = { on: (e: string, h: (f: unknown) => Promise<void>) => handlers.set(e, h), replyStream: async () => ({}) };
  installInboundRouter(client as never, cfg, pino({ level: "silent" }), bridge as never, join(ROOT, "unused.jsonc"), (() => {}) as never);
  for (const body of bodies) await handlers.get("message.text")!({ headers: {}, body: { msgid: "m" + Math.random(), chattype: "group", chatid: "G", from: { userid: "tester" }, msgtype: "text", ...body } });
  return dispatched;
};
const t = (content: string, over: Record<string, unknown> = {}) => ({ text: { content }, ...over });
assert.equal(await run(["weSingapore"], [t("@张三 看下"), t("@张三 @src/foo.ts")]), 0, "艾特别人: 不 dispatch");
assert.equal(await run(["weSingapore"], [t("@weSingapore 看下"), t("@张三 @weSingapore 看下"), t("@src/foo.ts 看下"), t("看下")]), 4, "机器人 / 机器人+别人 / 只有路径 / 无艾特: 放行");
assert.equal(await run(["weSingapore"], [t("分析一下", { compat_info: { source: "channel" } }), t(".fix 请 @张三 也看下")]), 2, "频道原生帧 / 开头 .name: 放行");
assert.equal(await run([], [t("@weSingapore 看下")]), 1, "botNames 未配: fail-open, 不拦");
assert.equal(await run(["weSingapore"], [t("@张三 看下", { chattype: "single", chatid: undefined })]), 1, "单聊不拦");

console.log("mention-filter e2e ok");
