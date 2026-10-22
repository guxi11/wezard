// 单元测试: daemon/steward-guard.ts — 运行: npx tsx tests/steward-guard.test.ts
import assert from "node:assert";
import { makeStewardGuard } from "../daemon/steward-guard.js";

let passed = 0;
let failed = 0;
const t = (name: string, fn: () => void): void => {
  try {
    fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${name}: ${(e as Error).message}`);
  }
};

// 每个用例独立 guard + 会话, 互不污染计数。
const probe = (toolName: string, toolInput: unknown, budget = 4): string | undefined => {
  const guard = makeStewardGuard();
  return guard({ sessionId: "s", turn: "t", toolName, toolInput, budget });
};
const repl = (code: string): { code: string } => ({ code });
/** 把同一会话同一轮跑 n 次, 返回每次的判定。 */
const runN = (n: number, toolName: string, toolInput: unknown, budget = 4): (string | undefined)[] => {
  const guard = makeStewardGuard();
  return Array.from({ length: n }, () => guard({ sessionId: "s", turn: "t", toolName, toolInput, budget }));
};

// ── 顶层工具名 (Claude / 非 PTC CodeBuddy): 原语义不变 ───────────────────
t("Bash 只读命令放行不计配额", () => {
  assert.equal(probe("Bash", { command: "cat foo.txt | head" }), undefined);
});
t("Bash 写命令直接拒 (sed -i / 重定向 / tee)", () => {
  assert.ok(probe("Bash", { command: "sed -i 's/a/b/' f" }));
  assert.ok(probe("Bash", { command: "echo x > f" }));
  assert.ok(probe("Bash", { command: "cat a | tee f" }));
});
t("Bash 非读命令吃配额, 超额拒", () => {
  const rs = runN(5, "Bash", { command: "npm test" });
  assert.equal(rs[3], undefined);
  assert.ok(rs[4]);
});
t("Read / wezard MCP 顶层名永远放行", () => {
  assert.equal(probe("Read", { file_path: "/a" }), undefined);
  assert.equal(probe("mcp_wezard_dispatch", { task: "x" }), undefined);
});
t("Write / Agent 顶层名直接拒", () => {
  assert.ok(probe("Write", { file_path: "/a", content: "x" }));
  assert.ok(probe("Agent", { prompt: "x" }));
});

// ── REPL 包装 (CodeBuddy PTC): 本次修的死锁 ─────────────────────────────
t("REPL 只读 (Read / Grep / cat) 放行不计配额", () => {
  for (const code of [
    'const r = await Read({ file_path: "/a" }); return r;',
    'return await Grep({ pattern: "x", path: "/a", output_mode: "content" });',
    'return await Bash({ command: "cat /a | head" });',
    'return await Bash({ command: "git show HEAD:daemon/x.ts" });',
  ]) assert.equal(probe("REPL", repl(code)), undefined, code);
  const rs = runN(9, "REPL", repl('return await Read({ file_path: "/a" });'));
  assert.ok(rs.every((r) => r === undefined));
});
t("REPL 里的 wezard 编排调用永远放行 —— 配额耗尽后依然 (死锁修复点)", () => {
  const guard = makeStewardGuard();
  const look = { sessionId: "s", turn: "t", toolName: "REPL", toolInput: repl('return "查点状态 " + Date.now();'), budget: 4 } as const;
  for (let i = 0; i < 4; i++) assert.equal(guard(look), undefined);
  assert.ok(guard(look), "第 5 条 look 应被配额拒");
  for (const code of [
    'return await mcp_wezard.dispatch({ task: "加 skill 到 prog 模式" });',
    'await mcp_wezard.tell_peer({ name: ".a", text: "hi" }); return 1;',
    'const j = await mcp_wezard.open_job({ title: "x" }); return j;',
    'return await mcp_wezard.wizard_roster({ query: "x" });',
  ]) {
    assert.equal(guard({ ...look, toolInput: repl(code) }), undefined, code);
  }
});
t("REPL 在写文件 → 拒 (Write / Edit / sed -i / 重定向 / tee)", () => {
  for (const code of [
    'await Write({ file_path: "/a", content: "x" }); return 1;',
    'await Edit({ file_path: "/a", old_string: "x", new_string: "y" }); return 1;',
    'return await Bash({ command: "sed -i s/a/b/ /a" });',
    'return await Bash({ command: "echo x > /tmp/f" });',
    'return await Bash({ command: "cat a | tee /tmp/f" });',
  ]) assert.ok(probe("REPL", repl(code)), code);
});
t("REPL 开子代理 → 拒", () => {
  assert.ok(probe("REPL", repl('return await Agent({ prompt: "x", description: "d" });')));
});
t("REPL 又读又写 → 按写拒", () => {
  assert.ok(probe("REPL", repl('await Read({ file_path: "/a" }); await Write({ file_path: "/b", content: "x" }); return 1;')));
});
t("REPL 非读 Bash 吃配额, 超额拒且理由指向 dispatch", () => {
  const rs = runN(5, "REPL", repl('return await Bash({ command: "npm install" });'));
  assert.equal(rs[3], undefined);
  assert.ok(rs[4]?.includes("dispatch"));
});
t("REPL 纯计算 (无可识别调用) 仍按 look 吃配额", () => {
  const rs = runN(5, "REPL", repl("return 1 + 1;"));
  assert.equal(rs[3], undefined);
  assert.ok(rs[4]);
});
t("REPL command 为变量拼接 → 保守吃配额", () => {
  const rs = runN(5, "REPL", repl('const c = "npm " + "test"; return await Bash({ command: c });'));
  assert.equal(rs[3], undefined);
  assert.ok(rs[4]);
});
t("REPL 元调用 (REPL.searchTools / describeTool) 放行", () => {
  assert.equal(probe("REPL", repl('return await REPL.searchTools("read file", { topK: 3 });')), undefined);
  assert.equal(probe("REPL", repl('return await REPL.describeTool("Bash");')), undefined);
});
t("REPL 里普通 JS 调用 (console.log / JSON.parse) 不误判为写", () => {
  assert.equal(probe("REPL", repl('console.log(JSON.parse("{\"a\":1}")); return 1;')), undefined);
});
t("REPL toolInput 无 code 字段 → 保守按 look", () => {
  const rs = runN(5, "REPL", { description: "x" });
  assert.equal(rs[3], undefined);
  assert.ok(rs[4]);
});
t("budget < 0 不设闸", () => {
  assert.equal(probe("REPL", repl('await Write({ file_path: "/a", content: "x" });'), -1), undefined);
  assert.equal(probe("Bash", { command: "rm -rf /" }, -1), undefined);
});

console.log(failed === 0 ? `\n全部 ${passed} 组通过` : `\n${failed} 组失败`);
process.exit(failed === 0 ? 0 : 1);
