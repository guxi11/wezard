import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { chatPolicyOf } from "../daemon/chat-name.js";
import { makeApproveHandler } from "../daemon/approval.js";
import { answerOf, applyOnboarding, bindSteward, classifyOnboardingInput, GUIDE_DESC, guideHandoffOps, guideOf, guideRefusal, guideTargetOf, isGuideManifestation, judgeOnboarding, loadOnboardingStore, needsOnboarding, planOnboardBind, renderOnboardingDone, validateOnboardingWorkspace, validateWorkspace, WIZARD_NAME_RE, type OnboardingInput, type OnboardingVerdict } from "../daemon/onboarding.js";
import { bindWizardStore, identityWorkspaceOf, loadWizardStore } from "../daemon/wizard.js";
import { loadClassStore } from "../daemon/classes.js";
import { stewardRoute } from "../daemon/steward.js";
import { DAEMON, foldRoom, holderOf, mirrors, msgIdOf, openDuties, roomHost, sameWho, whoKey, type RoomOp } from "../shared/room.js";

type Answer = Exclude<OnboardingInput, { kind: "command" }>;
type Bind = Exclude<OnboardingVerdict, { kind: "retry" }>;

// 测试目录用 $HOME 下的真实目录 (macOS /tmp 的 symlink 语义坑, 见工作区记忆)。
const dir = mkdtempSync(join(homedir(), ".tmp-onboarding-"));
try {
  const cfg = ConfigSchema.parse({ bot: { botId: "b", secret: "s" }, daemon: { stateDir: join(dir, "state") } });
  const empty = loadWizardStore(join(dir, "wizards.json"));

  // ── needsOnboarding: 判定矩阵 ─────────────────────────────────────
  cfg.defaultChat = "user:owner";
  assert.equal(needsOnboarding(cfg, empty, "chat:wrNEW"), true, "新群 (无绑定无记录) 要引导");
  assert.equal(needsOnboarding(cfg, empty, "user:owner"), false, "单聊不引导 (私聊默认接待=全局管家)");
  assert.equal(needsOnboarding(cfg, empty, ""), false, "空 base 不引导");
  cfg.chatPolicy = { "chat:wrNEW": { steward: "fix" } };
  assert.equal(needsOnboarding(cfg, empty, "chat:wrNEW"), false, "已绑管家不引导");
  delete cfg.chatPolicy;
  const withDefault = loadWizardStore(join(dir, "wizards2.json"));
  withDefault.upsert("chat:wrOLD", { description: "存量默认会话" });
  assert.equal(needsOnboarding(cfg, withDefault, "chat:wrOLD"), false, "有 untagged 默认会话的存量群不引导");
  cfg.wrc.channel.steward = { topic1: "fix" };
  assert.equal(needsOnboarding(cfg, empty, "chat:topic1"), false, "频道管家绑定不引导");
  delete cfg.wrc.channel.steward;
  const unclaimed = ConfigSchema.parse({ bot: { botId: "b", secret: "s" }, daemon: { stateDir: join(dir, "state") } });
  assert.equal(needsOnboarding(unclaimed, empty, "chat:wrNEW"), false, "未认领的新装机不引导 (先走 claim)");

  // ── validateWorkspace ─────────────────────────────────────────────
  assert.deepEqual(validateWorkspace(homedir()), { ok: true, abs: homedir() }, "存在的目录通过");
  assert.equal(validateWorkspace("~").ok, true, "裸 ~ 展开为 home");
  assert.equal(validateWorkspace("relative/path").ok, false, "相对路径拒绝");
  assert.equal(validateWorkspace(join(dir, "nope")).ok, false, "不存在的路径拒绝");
  const aFile = join(dir, "file.txt");
  writeFileSync(aFile, "x");
  assert.equal(validateWorkspace(aFile).ok, false, "文件不是工作区");

  // ── onboard_bind 的 workspace 校验: create 只建最后一级 / 必须在 $HOME 下 ──
  const made = join(dir, "made");
  const mk = validateOnboardingWorkspace(made, { create: true });
  assert.equal(mk.ok && mk.created, true, "create 建了目标目录");
  assert.equal(statSync(made).isDirectory(), true);
  assert.deepEqual(validateOnboardingWorkspace(made, { create: true }), { ok: true, abs: made, created: false }, "已存在当普通目录");
  assert.equal(validateOnboardingWorkspace(join(dir, "no", "deep"), { create: true }).ok, false, "父目录不存在 = 拒 (只建一级)");
  assert.equal(validateOnboardingWorkspace("/tmp/wezard-onboard-test", { create: true }).ok, false, "$HOME 外 = 拒");
  assert.equal(validateOnboardingWorkspace(join(dir, "absent"), {}).ok, false, "不带 create 必须已存在");
  assert.equal(validateOnboardingWorkspace("aiservice/agent-team", { create: true }).ok, false, "相对路径 = 拒");
  assert.equal(validateOnboardingWorkspace("~foo", {}).ok, false, "~user 形 = 拒");
  assert.equal(validateOnboardingWorkspace(aFile, { create: true }).ok, false, "目标是文件 = 拒");

  // ── 快路径只收「整句答案」(2026-11-20 重做) ────────────────────────
  // 旧版从长句里抽第一个路径: 实录那句被读成父目录 ~/develop/Tencent, 0.5s 内绑了管家。
  const TODAY = "在 ~/develop/Tencent 下创建一个 dhtpm 的目录，并在里面初始化 codebuddy.md，然后绑定它为 workspace";
  assert.deepEqual(answerOf(TODAY), { kind: "sentence" }, "实录那句不绑 (旧版会抽 ~/develop/Tencent 一步绑走)");
  assert.deepEqual(classifyOnboardingInput(TODAY), { kind: "sentence" });
  assert.equal(classifyOnboardingInput("设置工作区为" + dir).kind, "sentence", "带别的话的路径不再算答案");
  assert.deepEqual(classifyOnboardingInput(dir), { kind: "workspace", path: dir }, "整句就是一个路径 = 答案");
  assert.deepEqual(classifyOnboardingInput("“" + dir + "”。"), { kind: "workspace", path: dir }, "引号 / 尾标点剥掉");
  assert.deepEqual(classifyOnboardingInput("/Users/zzy/org"), { kind: "workspace", path: "/Users/zzy/org" }, "多段路径即使不存在也按路径 (交给校验报不存在)");
  assert.deepEqual(classifyOnboardingInput("~/proj"), { kind: "workspace", path: "~/proj" }, "~ 起头");
  assert.equal(classifyOnboardingInput("放在 " + dir + ", 谢谢").kind, "sentence", "路径之外还有话 = 交引导");
  assert.equal(classifyOnboardingInput("aiservice/agent-team").kind, "sentence", "相对路径交引导 (onboard_bind 会报要绝对路径)");
  assert.equal(classifyOnboardingInput("看 https://a.com/b 吧").kind, "sentence");
  assert.deepEqual(classifyOnboardingInput("/new"), { kind: "command" }, "单段且不存在 = 命令");
  assert.deepEqual(classifyOnboardingInput("/strict apply"), { kind: "command" });
  assert.deepEqual(classifyOnboardingInput("fix"), { kind: "names", names: ["fix"] }, "整句就是一个名字 = 答案");
  assert.equal(classifyOnboardingInput("绑定 fix").kind, "sentence", "名字之外还有话 = 交引导");
  assert.equal(answerOf("   ").kind, "sentence");
  assert.ok(WIZARD_NAME_RE.test("teststrict"));
  assert.ok(!WIZARD_NAME_RE.test("a b"), "名字不含空格");
  assert.ok(!WIZARD_NAME_RE.test("a#b"), "名字不含地址语法字符");

  // ── onboarding store: 断点续传 ────────────────────────────────────
  const ob = loadOnboardingStore(cfg);
  assert.equal(ob.get("chat:wrNEW"), undefined);
  assert.equal(ob.begin("chat:wrNEW"), "workspace");
  assert.equal(ob.begin("chat:wrNEW"), "workspace", "begin 幂等");
  assert.equal(loadOnboardingStore(cfg).get("chat:wrNEW")?.step, "workspace", "状态跨实例 (reload 断点续传)");
  ob.finish("chat:wrNEW");
  assert.equal(loadOnboardingStore(cfg).get("chat:wrNEW"), undefined, "finish 落盘");

  // ── bindSteward: config 热改 + patchJsonc 深路径 ───────────────────
  const src = join(dir, "config.jsonc");
  writeFileSync(src, "{\n  \"bot\": { \"botId\": \"b\" }\n}\n");
  bindSteward(cfg, src, "chat:wrNEW", "fix");
  assert.equal(cfg.chatPolicy?.["chat:wrNEW"]?.steward, "fix", "cfg 热改生效");
  assert.equal(JSON.parse(readFileSync(src, "utf8")).chatPolicy["chat:wrNEW"].steward, "fix", "patchJsonc 写进盘");
  cfg.chatPolicy = { ...(cfg.chatPolicy ?? {}), "chat:wrKEEP": { stewardBudget: 7 } };
  bindSteward(cfg, src, "chat:wrKEEP", "zoo");
  assert.equal(cfg.chatPolicy["chat:wrKEEP"]?.stewardBudget, 7, "内存里的既有策略字段保留");
  delete cfg.chatPolicy;

  // ── 只给 workspace 即完成绑定 + 落盘 + 状态机终结 (11-17 改口径) ──
  const B = "chat:wrWS";
  const ws = join(dir, "proj");
  mkdirSync(ws);
  const store = loadWizardStore(join(dir, "wizards3.json"));
  const obw = loadOnboardingStore(cfg);
  obw.begin(B);
  const input = classifyOnboardingInput(ws) as Answer;
  const verdict = judgeOnboarding(store, B, input);
  assert.deepEqual(verdict, { kind: "bind-new", workspace: ws });
  const binds: string[] = [];
  const bound = applyOnboarding(store, obw, B, verdict as Bind, (n) => { binds.push(n); bindSteward(cfg, src, B, n); }, () => "");
  assert.equal(bound.fresh, true);
  assert.equal(bound.workspace, ws);
  assert.match(bound.name, /^[A-Z][a-z]+([A-Z][a-z]+[0-9A-Z]*)?$/, "新管家领自动中性名 (名字后置给 /name)");
  assert.deepEqual(binds, [bound.name], "绑定恰好写一次");
  const anchor = store.get(B)!;
  assert.equal(anchor.kind, "steward", "untagged 锚点 kind:steward");
  assert.equal(anchor.workspace, ws, "锚点带身份级 workspace");
  assert.equal(anchor.name, bound.name);
  assert.equal(JSON.parse(readFileSync(src, "utf8")).chatPolicy[B].steward, bound.name, "chatPolicy.<base>.steward 落盘");
  assert.equal(obw.get(B), undefined, "状态机终结 (没有第二步)");
  assert.equal(loadOnboardingStore(cfg).get(B), undefined, "终结落盘");
  assert.equal(needsOnboarding(cfg, store, B), false, "绑定后不再引导");
  assert.equal(stewardRoute(cfg, store, B).target, B, "裸消息落管家锚点");
  assert.equal(identityWorkspaceOf(store, B), ws, "管家会话将起在给的目录");
  assert.match(renderOnboardingDone(bound), /^\[wezard\] ✅ 引导完成/, "完成确认是 daemon 系统行 (严格门放行)");

  // 已有管家名入口: 不新建、工作区跟身份走。
  const C = "chat:wrNAME";
  store.upsert("chat:wrHOME", { kind: "steward", name: "fix", workspace: "/Users/x/fixws" });
  const obn = loadOnboardingStore(cfg);
  obn.begin(C);
  const vName = judgeOnboarding(store, C, { kind: "names", names: ["fix"] });
  // 人 2026-11-23: 判定多带一个 identity (绑的是身份), 化身在落定时按本 room 解析。
  assert.deepEqual(vName, { kind: "bind-existing", name: "fix", target: "chat:wrHOME", identity: "chat:wrHOME" });
  const bn = applyOnboarding(store, obn, C, vName as Bind, (n) => bindSteward(cfg, src, C, n), (t) => identityWorkspaceOf(store, t));
  // 人 2026-11-23: 绑的是身份, 化身按本 room 解析 —— 本群新开一条同身份记录 (不再指别的群那条)。
  assert.deepEqual(bn, { name: "fix", target: "chat:wrNAME#fix", workspace: "/Users/x/fixws", fresh: false });
  assert.equal(store.get(C), undefined, "绑已有不占本群 untagged 锚点 (锚点是新建管家才写)");
  assert.equal(store.get("chat:wrNAME#fix")?.identity, "chat:wrHOME", "本群化身的身份归绑定身份");
  assert.equal(store.get("chat:wrHOME")?.target, "chat:wrHOME", "原有化身原样不动 (别的群照旧)");
  assert.equal(obn.get(C), undefined);
  assert.equal(judgeOnboarding(store, C, { kind: "names", names: ["nobody"] }).kind, "retry", "名册里没有 = 重问");
  store.upsert("user:owner#workspace", { kind: "worker", name: "workspace" });
  assert.equal(judgeOnboarding(store, C, { kind: "workspace", path: "aiservice/agent-team" }).kind, "retry",
    "相对路径 = 重问要绝对路径, 不拿句子里的英文词去绑同名身份");
  assert.equal(judgeOnboarding(store, C, { kind: "workspace", path: join(dir, "nope") }).kind, "retry", "不存在的目录 = 重问, 不落盘");
  delete cfg.chatPolicy;

  // ── 目录入口上已有管家: <role, workspace> 唯一确定身份, 绑它而不是再造一个 ──
  const kin = loadWizardStore(join(dir, "wizards-kin.json"));
  const wsOrg = join(dir, "org");
  mkdirSync(wsOrg);
  kin.upsert("chat:wrORG", { kind: "steward", name: "orgsteward", workspace: wsOrg });
  assert.deepEqual(judgeOnboarding(kin, "chat:wrN2", classifyOnboardingInput(wsOrg)),
    { kind: "bind-existing", name: "orgsteward", target: "chat:wrORG", identity: "chat:wrORG" }, "目录上已有的管家 = 绑它 (每群一条化身, 身份复用)");
  kin.upsert("chat:wrORG2", { kind: "steward", name: "orgsteward2", workspace: wsOrg });
  const ambiguous = judgeOnboarding(kin, "chat:wrN2", classifyOnboardingInput(wsOrg));
  assert.equal(ambiguous.kind, "retry", "同一目录两个管家 = 反问, 不猜");
  if (ambiguous.kind === "retry") {
    assert.match(ambiguous.reason, /orgsteward/, "反问里列名字");
    assert.match(ambiguous.reason, /orgsteward2/);
  }
  // 推断层: 没写 workspace 的管家, 按它现在的活目录认。
  const wsLive = join(dir, "live");
  mkdirSync(wsLive);
  const cwdOf = (t: string): string => (t === "chat:wrLIVE" || t === "chat:wrGLOBAL" ? wsLive : "");
  kin.upsert("chat:wrLIVE", { kind: "steward", name: "livesteward" });
  assert.deepEqual(judgeOnboarding(kin, "chat:wrN3", classifyOnboardingInput(wsLive), cwdOf),
    { kind: "bind-existing", name: "livesteward", target: "chat:wrLIVE", identity: "chat:wrLIVE" }, "没写 workspace 时按活目录推断");
  kin.upsert("chat:wrGLOBAL", { kind: "global-steward", name: "globalone" });
  assert.deepEqual(judgeOnboarding(kin, "chat:wrN4", classifyOnboardingInput(wsLive), cwdOf),
    { kind: "bind-existing", name: "globalone", target: "chat:wrGLOBAL", identity: "chat:wrGLOBAL" }, "推断层里全局管家优先");
  const wsWork = join(dir, "work");
  mkdirSync(wsWork);
  kin.upsert("chat:wrW", { kind: "worker", name: "worker1", workspace: wsWork });
  assert.deepEqual(judgeOnboarding(kin, "chat:wrN5", classifyOnboardingInput(wsWork), (t) => (t === "chat:wrW" ? wsWork : "")),
    { kind: "bind-new", workspace: wsWork }, "只有管家 (steward / global-steward) 算这个目录的管家");
  const wsOther = join(dir, "otherbot");
  mkdirSync(wsOther);
  kin.upsert("chat:wrOB~otherbot", { kind: "steward", name: "otherbotsteward", workspace: wsOther });
  assert.deepEqual(judgeOnboarding(kin, "chat:wrN6", classifyOnboardingInput(wsOther), (t) => (t.endsWith("~otherbot") ? wsOther : "")),
    { kind: "bind-new", workspace: wsOther }, "别的机器人的管家不算 (各自一套名册)");

  // ── 引导会话形态: slot、双证、不误杀人手开的 .guide ─────────────────
  const g = loadWizardStore(join(dir, "wizards4.json"));
  assert.equal(guideTargetOf(g, "chat:wrG"), "chat:wrG#guide", "引导化身是 tagged slot, 不占 untagged 管家锚点");
  g.upsert("chat:wrG#guide", { name: "guide" }); // 人手开的 .guide (没有职责标记)
  assert.equal(isGuideManifestation(g.get("chat:wrG#guide")), false, "没有职责标记不认 (人手开的同名 slot 不误杀)");
  assert.equal(guideOf(g, "chat:wrG"), "", "收尸找不到它");
  assert.equal(guideTargetOf(g, "chat:wrG"), "chat:wrG#guide-2", "slot 被占就退到 guide-2, 不借人家的会话");
  g.upsert("chat:wrG#guide-2", { identity: "chat:wrG#guide-2", kind: "worker", description: GUIDE_DESC, name: "guidex" });
  assert.equal(isGuideManifestation(g.get("chat:wrG#guide-2")), true);
  assert.equal(guideOf(g, "chat:wrG"), "chat:wrG#guide-2", "收尸认的是带标记的那个");
  assert.equal(guideTargetOf(g, "chat:wrG"), "chat:wrG#guide-2", "续用同一个引导化身");
  assert.equal(isGuideManifestation(g.upsert("chat:wrG#other", { description: GUIDE_DESC })), false, "slot 不是 guide 系不认");
  assert.equal(judgeOnboarding(g, "chat:wrH", { kind: "names", names: ["guidex"] }).kind, "retry", "引导化身的名字不能被绑成管家");

  // ── 工具面 = 白名单三项 (2026-11-20): chat_reply / chat_say / onboard_bind ──
  const guideRec = g.get("chat:wrG#guide-2");
  for (const t of ["mcp__wezard__chat_reply", "mcp__wezard__chat_say", "mcp__wezard__onboard_bind"]) {
    assert.equal(guideRefusal(guideRec, t), "", t + " 放");
  }
  assert.match(guideRefusal(guideRec, "mcp__wezard__set_workspace"), /只有 chat_reply \/ chat_say \(本群 room\) \/ onboard_bind 三件工具/);
  assert.match(guideRefusal(guideRec, "handoff"), /\(handoff 被拒\)/, "白名单外照旧拒");
  assert.equal(guideRefusal(g.get("chat:wrG#guide"), "mcp__wezard__set_workspace"), "", "人手 .guide 不受限");
  assert.equal(guideRefusal(undefined, "handoff"), "");

  // ── CodeBuddy REPL (PTC) 包装: 白名单看脚本里实际调了什么 (2026-11-23) ──
  // 只按外层工具名判 = 引导的工具面全关 (.guide-3 实录); 只认 REPL 这个名字 = 全开。
  const repl = (code: string) => ({ code, description: "probe" });
  const replRefusal = (code: string) => guideRefusal(guideRec, "REPL", repl(code));
  for (const c of [
    'return await mcp.wezard.chat_reply({ re: "x.1", text: "好的" });',
    'await mcp.wezard.chat_say({ text: "稍等" }); return 1;',
    'const r = await mcp.wezard.onboard_bind({ workspace: "/Users/x/y", create: true }); return JSON.stringify(r);',
    'const tp = mcp.wezard.chat_reply; return await tp({ re: "x.1", text: "ok" });',
    'const { onboard_bind: bind } = mcp.wezard; return await bind({ name: "fix" });',
    'return JSON.stringify(await tools.mcp__wezard__chat_say({ text: "hi" }));',
    'return await mcp_wezard.onboard_bind({ workspace: "/Users/x/y" });',
    "return 1 + 1;",
  ]) assert.equal(replRefusal(c), "", "REPL 放行: " + c.slice(0, 40));
  for (const c of [
    "return await mcp.wezard.handoff({});",
    'await mcp.wezard.chat_reply({ re: "x.1", text: "ok" }); return await mcp.wezard.set_workspace({ cwd: "/x" });',
    'return await Bash({ command: "ls" });',
    'return await Read({ file_path: "/etc/passwd" });',
    'const f = (await import("node:fs")).readFileSync; return f("/x");',
    'return new Function("return 1")();',
    'const nm = "chat_reply"; return await mcp.wezard[nm]({});',
  ]) assert.match(replRefusal(c), /三件工具/, "REPL 拒: " + c.slice(0, 40));
  assert.match(replRefusal("return {"), /三件工具/, "脚本解析不了 = 拒");
  assert.match(guideRefusal(guideRec, "REPL"), /三件工具/, "没有脚本的 REPL = 拒");
  assert.equal(guideRefusal(g.get("chat:wrG#guide"), "REPL", repl('await Bash({ command: "ls" })')), "", "人手 .guide 不受限");

  // ── 绑定后 room 交接 (契约 §4): 管家接手, 引导离开, 人那条 duty 跟着走 ──
  const ROOM = "chat:wrHAND";
  const gw = { kind: "wizard", id: "wGUIDE" } as const;
  const sw = { kind: "wizard", id: "wSTEW" } as const;
  const hw = { kind: "human", id: "zhangsan" } as const;
  const asked = msgIdOf(ROOM, 1);
  const journal: RoomOp[] = [
    { op: "open", at: 1, room: ROOM, kind: "wecom-group", by: DAEMON },
    { op: "join", at: 2, room: ROOM, who: gw, ord: 1, via: "founder", by: DAEMON },
    { op: "msg", at: 3, room: ROOM, id: asked, seq: 1, author: hw, ord: 0, speak: "human", kind: "say",
      text: "在 ~/develop/Tencent 下建一个 dhtpm 并绑定", origin: "inbound", wake: [gw.id] },
  ];
  const before = foldRoom(ROOM, journal);
  assert.equal(sameWho(roomHost(before), gw), true, "引导以 founder 入 room 即 host");
  assert.equal(sameWho(holderOf(before, openDuties(before)[0]!), gw), true, "人这句话此刻在引导手上");
  const hand = guideHandoffOps(before, { guide: gw, steward: sw, text: "✅ 引导完成", now: 10 });
  const after = foldRoom(ROOM, [...journal, ...hand]);
  assert.equal(after.members.has(whoKey(sw)), true, "管家是成员");
  assert.equal(sameWho(roomHost(after), sw), true, "管家成为 host");
  assert.equal(after.members.has(whoKey(gw)), false, "引导已离开");
  const duty = openDuties(after).find((d) => d.msg === asked)!;
  assert.equal(sameWho(holderOf(after, duty), sw), true, "人那条 duty 的 holder 是管家");
  assert.equal(after.msgs.filter((m) => m.status === "canceled").length, 0, "无 canceled 行 (duty 先转走再 leave)");
  const sys = after.msgs[after.msgs.length - 1]!;
  assert.equal(sys.kind, "system", "最后一行是完成确认");
  assert.deepEqual(sys.wake, [sw.id], "系统行唤醒管家");
  assert.equal(mirrors(sys), true, "系统行镜像进企微");
  // 引导先 done 关了人话再绑定: 原话仍随一条 daemon task 交给管家, 并给管家开新 duty
  const closedRow: RoomOp = { op: "msg", at: 4, room: ROOM, id: msgIdOf(ROOM, 2), seq: 2, author: gw, ord: 1, speak: "member", kind: "reply",
    text: "好的", re: [asked], status: "done", closes: [openDuties(foldRoom(ROOM, journal))[0]!.key], wake: [], origin: "tool" };
  const early = foldRoom(ROOM, [...journal, closedRow]);
  assert.equal(openDuties(early).length, 0, "前提: 人那条已被引导关账");
  const hand2 = guideHandoffOps(early, { guide: gw, steward: sw, text: "✅ 引导完成", now: 10 });
  const after2 = foldRoom(ROOM, [...[...journal, closedRow], ...hand2]);
  const fwd = after2.msgs.find((m) => m.sys === "onboard-forward")!;
  assert.ok(fwd, "有转交原话的 daemon 行");
  assert.equal(fwd.kind, "task");
  assert.deepEqual(fwd.wake, [sw.id], "唤醒管家");
  assert.match(fwd.text, /在 ~\/develop\/Tencent 下建一个 dhtpm 并绑定/, "正文带原话");
  assert.deepEqual(fwd.re, [asked]);
  const fduty = openDuties(after2).find((d) => d.msg === fwd.id)!;
  assert.equal(sameWho(holderOf(after2, fduty), sw), true, "管家名下有新 duty, 可 chat_reply 交代");
  assert.deepEqual(after2.msgs.find((m) => m.sys === "onboard-done")!.wake, [], "完成行不重复唤醒");
  assert.deepEqual(guideHandoffOps(foldRoom("chat:wrNONE", []), { guide: gw, steward: sw, text: "x", now: 1 }), [],
    "引导不在 room 里 = 没得交");
  // 交接时顺手起群名 (引导还是 host): name 行在最前, host 照旧交给管家。
  // (fold + applyOp 会就地改状态, 每次都从账本重折一份。)
  const handName = guideHandoffOps(foldRoom(ROOM, journal), { guide: gw, steward: sw, text: "✅", now: 11, roomName: "tpmtest" });
  assert.equal(handName[0]?.op, "name", "name 行在最前 (引导还是 host)");
  const afterName = foldRoom(ROOM, [...journal, ...handName]);
  assert.equal(afterName.title, "tpmtest", "群名落进 room 状态");
  assert.equal(sameWho(roomHost(afterName), sw), true, "起名不影响 host 交接");
  assert.equal(foldRoom(ROOM, [...journal, ...guideHandoffOps(foldRoom(ROOM, journal), { guide: gw, steward: sw, text: "✅", now: 11 })]).title, undefined,
    "没给 roomName = 不加 name 行");

  // ── onboard_bind 的判定 (路由只负责落盘): 谁 / 什么参数 / 建成什么样 ──
  const judgeAt = (base: string) => (input: Exclude<OnboardingInput, { kind: "command" | "sentence" }>) => judgeOnboarding(store, base, input);
  const nonGuide = planOnboardBind({ caller: g.get("chat:wrG"), onboarding: true, workspace: made, judge: judgeAt("chat:wrBIN") });
  assert.equal(nonGuide.ok, false, "人手开的 .guide 不是引导化身");
  if (!nonGuide.ok) { assert.equal(nonGuide.status, 403, "非引导会话调用 403"); assert.match(nonGuide.reason, /只有新群引导会话/); }
  const alreadyBound = planOnboardBind({ caller: guideRec, onboarding: false, name: "fix", judge: judgeAt("chat:wrBIN") });
  assert.equal(alreadyBound.ok, false);
  if (!alreadyBound.ok) assert.equal(alreadyBound.status, 409, "已绑过 = 409 (引导应当结束)");
  const freshWs = join(dir, "fresh");
  const bindOk = planOnboardBind({ caller: guideRec, onboarding: true, workspace: freshWs, create: true, judge: judgeAt("chat:wrBIN") });
  assert.equal(bindOk.ok, true, "create 建出目录后交判定");
  if (bindOk.ok) assert.deepEqual(bindOk.verdict, { kind: "bind-new", workspace: freshWs });
  assert.equal(statSync(freshWs).isDirectory(), true);
  const deep = planOnboardBind({ caller: guideRec, onboarding: true, workspace: join(dir, "nope", "deeper"), create: true, judge: judgeAt("chat:wrBIN") });
  assert.equal(deep.ok, false, "父目录不存在 = 拒 (只建一级)");
  if (!deep.ok) { assert.equal(deep.status, 400); assert.match(deep.reason, /父目录/); }
  const outside = planOnboardBind({ caller: guideRec, onboarding: true, workspace: "/tmp/wezard-onboard-outside", create: true, judge: judgeAt("chat:wrBIN") });
  assert.equal(outside.ok, false, "$HOME 外 = 拒");
  if (!outside.ok) assert.match(outside.reason, /\$HOME/);
  assert.equal(planOnboardBind({ caller: guideRec, onboarding: true, judge: judgeAt("chat:wrBIN") }).ok, false, "两个都不给 = 400");
  const unknownName = planOnboardBind({ caller: guideRec, onboarding: true, name: "nobody", judge: judgeAt("chat:wrBIN") });
  assert.equal(unknownName.ok, false, "名册里没有 = 400 带原因 (引导自己追问)");
  if (!unknownName.ok) assert.match(unknownName.reason, /名册里也没有/);

  // ── 一句话办完三件 (人 2026-11-23): workspace + 新管家名 + 群名同一个调用 ──
  const wsTpm = join(dir, "tpm");
  const named = planOnboardBind({ caller: guideRec, onboarding: true, workspace: wsTpm, create: true, name: "tpm", roomName: "tpmtest", judge: judgeAt("chat:wrNAMED") });
  assert.equal(named.ok, true, "workspace 与 name 同给 = 给新管家起名 (不再是 400)");
  if (named.ok) {
    assert.deepEqual(named.verdict, { kind: "bind-new", workspace: wsTpm });
    assert.equal(named.name, "tpm", "新管家指定的名字");
    assert.equal(named.roomName, "tpmtest", "顺手给的群名");
  }
  const dup = planOnboardBind({ caller: guideRec, onboarding: true, workspace: join(dir, "tpm-dup"), create: true, name: "fix", judge: judgeAt("chat:wrNAMED"), nameTaken: (n) => n === "fix" });
  assert.equal(dup.ok, false, "名字已被占用 = 409");
  if (!dup.ok) { assert.equal(dup.status, 409); assert.match(dup.reason, /已被占用/); }
  const shaped = planOnboardBind({ caller: guideRec, onboarding: true, workspace: join(dir, "tpm9"), create: true, name: "tpm-2", judge: judgeAt("chat:wrNAMED") });
  assert.equal(shaped.ok, false, "类名不能以 -数字 结尾 (那是实例名)");
  if (!shaped.ok) { assert.equal(shaped.status, 400); assert.match(shaped.reason, /不能用作管家名/); }
  // 目录上已有管家: 名字跟身份走, 另起的名字要回绝 (回绝里点名已有的那个)。
  const dupStore = loadWizardStore(join(dir, "wizards-dup.json"));
  const wsDup = join(dir, "dupws");
  mkdirSync(wsDup);
  dupStore.upsert("chat:wrDUP", { kind: "steward", name: "dupone", workspace: wsDup });
  const judgeDup = (input: Exclude<OnboardingInput, { kind: "command" | "sentence" }>) => judgeOnboarding(dupStore, "chat:wrDUP2", input);
  const otherName = planOnboardBind({ caller: guideRec, onboarding: true, workspace: wsDup, name: "someone", judge: judgeDup });
  assert.equal(otherName.ok, false, "目录上已有管家时不能另起名字");
  if (!otherName.ok) { assert.equal(otherName.status, 400); assert.match(otherName.reason, /dupone/); }
  assert.equal(planOnboardBind({ caller: guideRec, onboarding: true, workspace: wsDup, name: "dupone", roomName: "已绑", judge: judgeDup }).ok, true, "给的就是它自己 = 绑已有");
  assert.equal(planOnboardBind({ caller: guideRec, onboarding: true, workspace: wsTpm, roomName: "x".repeat(61), judge: judgeAt("chat:wrNAMED") }).ok, false, "群名太长 = 400");

  // 落定: 新管家用指定的名字 (无类世界 = 自由名; 类世界 = 类名, 实例 <类名>-1)
  const obNamed = loadOnboardingStore(cfg);
  obNamed.begin("chat:wrNAMED");
  const namedBound = applyOnboarding(store, obNamed, "chat:wrNAMED", { kind: "bind-new", workspace: wsTpm }, () => undefined, () => "", "tpm");
  assert.deepEqual(namedBound, { name: "tpm", target: "chat:wrNAMED", workspace: wsTpm, fresh: true }, "新管家用指定的名字");
  assert.equal(store.get("chat:wrNAMED")?.name, "tpm");
  const cstore = loadWizardStore(join(dir, "wizards-class.json"), () => undefined, loadClassStore(join(dir, "classes.json")));
  const obCls = loadOnboardingStore(cfg);
  obCls.begin("chat:wrCLS");
  const clsBound = applyOnboarding(cstore, obCls, "chat:wrCLS", { kind: "bind-new", workspace: wsTpm }, () => undefined, () => "", "tpm");
  assert.equal(clsBound.name, "tpm", "绑定写类名");
  assert.equal(cstore.get("chat:wrCLS")?.name, "tpm-1", "实例名 = 类名-1");
  assert.equal(cstore.byName("tpm")?.target, "chat:wrCLS", "类名解析回本群锚点");

  bindWizardStore(g);
  const replies: Array<{ status: number; body?: string }> = [];
  const mkReq = (body: unknown) => { const buf = Buffer.from(JSON.stringify(body)); return (async function* () { yield buf; })() as unknown as import("node:http").IncomingMessage; };
  const mkRes = () => ({
    statusCode: 0,
    end(body?: string) { replies.push({ status: this.statusCode, body }); return this; },
    setHeader: () => undefined,
  }) as unknown as import("node:http").ServerResponse;
  const owners: Record<string, string> = { "s-guide": "chat:wrG#guide-2", "s-human": "chat:wrG#guide" };
  const acfg = ConfigSchema.parse({ bot: { botId: "b", secret: "s" }, daemon: { stateDir: join(dir, "astate") }, approval: { matcher: "^Bash$" } });
  const approve = makeApproveHandler({
    cfg: acfg, log: pino({ level: "silent" }), client: { sendMessage: async () => ({ errcode: 0 }), on: () => undefined, isConnected: true } as never, sourcePath: join(dir, "none.jsonc"),
    getMirrorTarget: (sid: string) => owners[sid],
    flushBeforeCard: async () => undefined,
    nativeModal: { hasPane: () => false, answer: async () => ({ ok: false }), cancel: async () => ({ ok: false }) },
  });
  const decide = async (sid: string, tool: string, toolInput: unknown = {}) => {
    await approve(mkReq({ session_id: sid, tool_name: tool, tool_input: toolInput, cwd: dir }) as never, mkRes());
    return JSON.parse(replies[replies.length - 1]!.body ?? "{}") as { decision: string; reason?: string };
  };
  for (const tool of ["mcp__wezard__handoff", "mcp__wezard__set_workspace", "mcp__wezard__spawn_wizard", "mcp__wezard__delegate", "mcp__wezard__chat_ask", "Bash", "Read"]) {
    const d = await decide("s-guide", tool, { cwd: "/Users/zzy/org" });
    assert.equal(d.decision, "deny", "引导化身调白名单外的 " + tool + " 一律拒");
    assert.match(d.reason ?? "", /三件工具/);
  }
  for (const tool of ["mcp__wezard__chat_reply", "mcp__wezard__chat_say", "mcp__wezard__onboard_bind"]) {
    const d = await decide("s-guide", tool, { re: "x.1", text: "好的" });
    assert.equal(d.decision, "allow", "白名单放行 " + tool);
  }
  const human = await decide("s-human", "Read", { file_path: "/x" });
  assert.equal(human.decision, "allow", "人手开的 .guide 照常 (matcher 外放行), 不吃引导拒绝");
  const replAllow = await decide("s-guide", "REPL", { code: 'return await mcp.wezard.onboard_bind({ workspace: "/Users/x/y" });' });
  assert.equal(replAllow.decision, "allow", "REPL 里只调白名单工具 = 放行 (2026-11-23 修复)");
  const replDeny = await decide("s-guide", "REPL", { code: "return await mcp.wezard.handoff({});" });
  assert.equal(replDeny.decision, "deny", "REPL 里调白名单外的照旧拒");
  assert.match(replDeny.reason ?? "", /三件工具/);

  // ── 在途豁免 → room 口径 (fix-task §8.2) ──────────────────────────
  // 出站门已废: 引导说话不再需要 speech 豁免, 在途与否同一读数; 盘上残留的旧键在
  // chatPolicyOf 读侧剥掉, 永不生效 (残留键只在 boot warn 里出现)。
  const obx = loadOnboardingStore(cfg);
  obx.begin("chat:wrEXEMPT");
  cfg.chatPolicy = { "chat:wrEXEMPT": { speech: "strict" } };
  assert.equal(chatPolicyOf(cfg, "chat:wrEXEMPT").speech, undefined, "room 口径: 残留 speech 键读侧剥掉 (在途)");
  obx.finish("chat:wrEXEMPT");
  assert.equal(chatPolicyOf(cfg, "chat:wrEXEMPT").speech, undefined, "收尾后同样剥掉, 旧键永不生效");
  delete cfg.chatPolicy;
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("onboarding.test.ts ok");
process.exit(0);
