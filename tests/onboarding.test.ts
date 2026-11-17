import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { chatPolicyOf } from "../daemon/chat-name.js";
import { makeApproveHandler } from "../daemon/approval.js";
import { applyOnboarding, bindSteward, classifyOnboardingInput, GUIDE_DESC, guideOf, guideRefusal, guideTargetOf, isGuideManifestation, isOnboardingActive, judgeOnboarding, loadOnboardingStore, needsOnboarding, renderOnboardingDone, stewardNameCandidates, validateWorkspace, WIZARD_NAME_RE, workspaceInput, type OnboardingInput, type OnboardingVerdict } from "../daemon/onboarding.js";
import { bindWizardStore, identityWorkspaceOf, loadWizardStore } from "../daemon/wizard.js";
import { autoOrdinalOf } from "../daemon/wizard-names.js";
import { stewardRoute } from "../daemon/steward.js";

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

  // ── workspaceInput / classify: 人话里的目录 (teststrict 实录句式) ──
  assert.equal(workspaceInput("设置工作区为/Users/zzy/org"), "/Users/zzy/org", "粘着中文的路径认 (11-17 实录)");
  assert.equal(workspaceInput("/Users/x/proj"), "/Users/x/proj");
  assert.equal(workspaceInput("工作区 ~/proj。"), "~/proj", "~ 起头 + 中文句号截断");
  assert.equal(workspaceInput("放在 /Users/x/proj, 谢谢"), "/Users/x/proj", "ASCII 尾标点剥掉");
  assert.equal(workspaceInput("看 https://a.com/b"), "", "URL 里的 / 不认");
  assert.equal(workspaceInput("a/b"), "", "相对片段不认");
  assert.equal(workspaceInput("~foo"), "", "~user 形不认");
  assert.equal(workspaceInput("你好"), "");
  assert.deepEqual(classifyOnboardingInput("设置工作区为" + dir), { kind: "workspace", path: dir });
  assert.deepEqual(classifyOnboardingInput(dir), { kind: "workspace", path: dir }, "行首绝对路径不当命令 (旧版会回「命令引导完成后可用」)");
  assert.deepEqual(classifyOnboardingInput("/Users/zzy/org"), { kind: "workspace", path: "/Users/zzy/org" }, "多段路径即使不存在也按路径 (交给校验报不存在)");
  assert.deepEqual(classifyOnboardingInput("/new"), { kind: "command" }, "单段且不存在 = 命令");
  assert.deepEqual(classifyOnboardingInput("/strict apply"), { kind: "command" });
  assert.deepEqual(classifyOnboardingInput("fix"), { kind: "names", names: ["fix"] });

  // ── stewardNameCandidates: @mention 粘连与记号 ─────────────────────
  assert.deepEqual(stewardNameCandidates(".fix"), ["fix"]);
  assert.deepEqual(stewardNameCandidates("🧙‍♂️ fix"), ["fix"]);
  assert.deepEqual(stewardNameCandidates("teststrict@wezard"), ["teststrict"], "粘连 mention 截断 (@ 后的 bot 名不当候选)");
  assert.deepEqual(stewardNameCandidates("绑定fix"), ["绑定fix", "fix"], "中文里嵌的 ASCII 名字");
  assert.deepEqual(stewardNameCandidates(""), []);
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
  cfg.chatPolicy = { ...(cfg.chatPolicy ?? {}), "chat:wrKEEP": { topOnly: false } };
  bindSteward(cfg, src, "chat:wrKEEP", "zoo");
  assert.equal(cfg.chatPolicy["chat:wrKEEP"]?.topOnly, false, "内存里的既有策略字段保留");
  delete cfg.chatPolicy;

  // ── 只给 workspace 即完成绑定 + 落盘 + 状态机终结 (11-17 改口径) ──
  const B = "chat:wrWS";
  const ws = join(dir, "proj");
  mkdirSync(ws);
  const store = loadWizardStore(join(dir, "wizards3.json"));
  const obw = loadOnboardingStore(cfg);
  obw.begin(B);
  assert.equal(isOnboardingActive(B), true, "在途豁免已开");
  const input = classifyOnboardingInput("设置工作区为" + ws) as Answer;
  const verdict = judgeOnboarding(store, B, input);
  assert.deepEqual(verdict, { kind: "bind-new", workspace: ws });
  const binds: string[] = [];
  const bound = applyOnboarding(store, obw, B, verdict as Bind, (n) => { binds.push(n); bindSteward(cfg, src, B, n); }, () => "");
  assert.equal(bound.fresh, true);
  assert.equal(bound.workspace, ws);
  assert.notEqual(autoOrdinalOf(bound.name), undefined, "新管家领自动中性名 (名字后置给 /name)");
  assert.deepEqual(binds, [bound.name], "绑定恰好写一次");
  const anchor = store.get(B)!;
  assert.equal(anchor.kind, "steward", "untagged 锚点 kind:steward");
  assert.equal(anchor.workspace, ws, "锚点带身份级 workspace");
  assert.equal(anchor.name, bound.name);
  assert.equal(JSON.parse(readFileSync(src, "utf8")).chatPolicy[B].steward, bound.name, "chatPolicy.<base>.steward 落盘");
  assert.equal(obw.get(B), undefined, "状态机终结 (没有第二步)");
  assert.equal(loadOnboardingStore(cfg).get(B), undefined, "终结落盘");
  assert.equal(isOnboardingActive(B), false, "绑定即关出站豁免 (不再留告别窗口)");
  assert.equal(needsOnboarding(cfg, store, B), false, "绑定后不再引导");
  assert.equal(stewardRoute(cfg, store, B).target, B, "裸消息落管家锚点");
  assert.equal(identityWorkspaceOf(store, B), ws, "管家会话将起在给的目录");
  assert.match(renderOnboardingDone(bound), /^\[wezard\] ✅ 引导完成/, "完成确认是 daemon 系统行 (严格门放行)");

  // 已有管家名入口: 不新建、工作区跟身份走。
  const C = "chat:wrNAME";
  store.upsert("chat:wrHOME", { kind: "steward", name: "fix", workspace: "/Users/x/fixws" });
  const obn = loadOnboardingStore(cfg);
  obn.begin(C);
  const vName = judgeOnboarding(store, C, { kind: "names", names: stewardNameCandidates("绑定 fix") });
  assert.deepEqual(vName, { kind: "bind-existing", name: "fix", target: "chat:wrHOME" });
  const bn = applyOnboarding(store, obn, C, vName as Bind, (n) => bindSteward(cfg, src, C, n), (t) => identityWorkspaceOf(store, t));
  assert.deepEqual(bn, { name: "fix", workspace: "/Users/x/fixws", fresh: false });
  assert.equal(store.get(C), undefined, "绑已有不在本群新建锚点");
  assert.equal(obn.get(C), undefined);
  assert.equal(judgeOnboarding(store, C, { kind: "names", names: ["nobody"] }).kind, "retry", "名册里没有 = 重问");
  assert.equal(judgeOnboarding(store, C, { kind: "workspace", path: join(dir, "nope") }).kind, "retry", "不存在的目录 = 重问, 不落盘");
  delete cfg.chatPolicy;

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

  // ── 工具面收窄: guideRefusal + 审批层全拒 ───────────────────────────
  assert.match(guideRefusal(g.get("chat:wrG#guide-2"), "handoff"), /没有工具面 \(handoff 被拒\)/);
  assert.equal(guideRefusal(g.get("chat:wrG#guide"), "handoff"), "", "人手 .guide 不受限");
  assert.equal(guideRefusal(undefined, "handoff"), "");

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
  for (const tool of ["mcp__wezard__handoff", "mcp__wezard__set_workspace", "mcp__wezard__spawn_wizard", "mcp__wezard__delegate", "Bash", "Read"]) {
    const d = await decide("s-guide", tool, { cwd: "/Users/zzy/org" });
    assert.equal(d.decision, "deny", "引导化身调 " + tool + " 一律拒");
    assert.match(d.reason ?? "", /引导会话没有工具面/);
  }
  const human = await decide("s-human", "Read", { file_path: "/x" });
  assert.equal(human.decision, "allow", "人手开的 .guide 照常 (matcher 外放行), 不吃引导拒绝");

  // ── 在途豁免 (chatPolicyOf) ───────────────────────────────────────
  const obx = loadOnboardingStore(cfg);
  obx.begin("chat:wrEXEMPT");
  cfg.chatPolicy = { "chat:wrEXEMPT": { speech: "strict" } };
  assert.equal(chatPolicyOf(cfg, "chat:wrEXEMPT").speech, "implicit", "在途群按 implicit 出站 (引导要能说话)");
  obx.finish("chat:wrEXEMPT");
  assert.equal(isOnboardingActive("chat:wrEXEMPT"), false, "绑定即关窗");
  assert.equal(chatPolicyOf(cfg, "chat:wrEXEMPT").speech, "strict", "收尾后显式 strict 恢复");
  delete cfg.chatPolicy;
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("onboarding.test.ts ok");
process.exit(0);
