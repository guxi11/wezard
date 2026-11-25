// 第 2 步 §2: 外部接待 wizard 的审批收紧 (纯判定 + 名册解析)。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forceCardFor, receptionCallerOf } from "../daemon/approval.js";
import { bindWizardStore, loadWizardStore } from "../daemon/wizard.js";
import { evaluateAllow } from "../shared/allow-rules.js";
import type { Config } from "../shared/config.js";

const recv = { reception: "recv", principals: ["CoC"] };
const chatReply = "mcp__wezard__chat_reply";

// ① 接待 wizard 调 wezard 工具: 不发卡 (否则它连交代都做不了)
assert.equal(forceCardFor(recv, chatReply, { re: "x", text: "y" }), false, "chat_reply 不发卡");
assert.equal(forceCardFor(recv, "mcp_wezard.room_read", { room: "adhoc:1" }), false, "CodeBuddy 写法也认");
assert.equal(forceCardFor(recv, "REPL", { code: "await mcp_wezard.chat_reply({ re: 'x' }); await mcp_wezard.delegate({ task: 't' })" }), false, "REPL 里只调 wezard 工具也不发卡");
assert.equal(forceCardFor(recv, "REPL", { code: "const a = 1 + 2; console.log(a)" }), false, "纯计算不发卡");

// ② 接待 wizard 调真执行面: 发卡
assert.equal(forceCardFor(recv, "Bash", { command: "ls" }), true, "Bash 发卡");
assert.equal(forceCardFor(recv, "REPL", { code: "await Bash({ command: 'ls' })" }), true, "REPL 里调 Bash 发卡");
assert.equal(forceCardFor(recv, "REPL", { code: "await Read({ file_path: '/etc/hosts' })" }), true, "REPL 里调非 wezard 工具发卡");

// ③ 普通 wizard 不受影响: 发卡判据为假, allowRules 照常生效
assert.equal(forceCardFor(undefined, "Bash", { command: "ls" }), false, "非接待 wizard 不进强制发卡");
const allow = evaluateAllow(["Bash(ls)"], "Bash", { command: "ls" });
assert.equal(allow.allowed, true, "同一条 Bash 对普通 wizard 命中 allowRules 时放行 (与 forceCardFor=false 一起 = 不发卡)");

// ④ 名册解析: 名册里叫 recv 的 target 才是接待 wizard
{
  const dir = mkdtempSync(join(tmpdir(), "ext-reception-"));
  const file = join(dir, "wizards.json");
  writeFileSync(file, JSON.stringify({
    "chat:wrRecv#r": { target: "chat:wrRecv#r", uid: "w00000000recv", name: "recv", description: "", bornAt: 1, memory: [] },
    "chat:wrWork#w": { target: "chat:wrWork#w", uid: "w00000000work", name: "worker", description: "", bornAt: 1, memory: [] },
  }));
  bindWizardStore(loadWizardStore(file));
  const cfg = { external: { enabled: false, principals: [{ name: "CoC", reception: "recv", owner: "", enabled: true, perMinute: 10, perDay: 50, maxOpen: 5 }] } } as unknown as Config;
  assert.deepEqual(receptionCallerOf(cfg, "chat:wrRecv#r"), { reception: "recv", principals: ["CoC"] }, "接待 wizard 解析出调用方");
  assert.equal(receptionCallerOf(cfg, "chat:wrWork#w"), undefined, "普通 wizard 不是接待");
  assert.equal(receptionCallerOf(cfg, ""), undefined);
  const off = { external: { enabled: false, principals: [{ name: "CoC", reception: "recv", owner: "", enabled: false, perMinute: 10, perDay: 50, maxOpen: 5 }] } } as unknown as Config;
  assert.equal(receptionCallerOf(off, "chat:wrRecv#r"), undefined, "停用的调用方不算接待 (按启用的那些判)");
}

process.stdout.write("external-reception: ok\n");
