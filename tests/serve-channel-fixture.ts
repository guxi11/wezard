// 起一个本地服务, 带频道框演示数据 (tests/fixture-channel-world.mjs) + 真实的页面壳 / 样式 / web/chat.js (shared/chat-render.ts),
// 给 scripts/shot.mjs --url 截图用。不连任何 daemon / svr, 数据全是假名。
// 用法 (一条命令只跑一件事, 截完 kill): npx tsx tests/serve-channel-fixture.ts [端口, 缺省 0 = 随机]
//   启动后第一行打印 http://127.0.0.1:<port>/role?id=demo —— 把它交给 `node scripts/shot.mjs --url …`。
import { createServer } from "node:http";
import { chatScript, chatStyles, chatVendor, renderChatPage } from "../shared/chat-render.js";
import { demoChannelWorld } from "./fixture-channel-world.mjs";

const server = createServer((req, res) => {
  const u = new URL(req.url || "/", "http://x");
  const send = (type: string, body: string): void => { res.statusCode = 200; res.setHeader("content-type", type); res.end(body); };
  const asset = (a: { body: string; type: string }): void => send(a.type, a.body);
  const world = demoChannelWorld();
  if (u.pathname === "/role") return send("text/html; charset=utf-8", renderChatPage());
  if (u.pathname === "/chat/app.css") return asset(chatStyles());
  if (u.pathname === "/chat/app.js") return asset(chatScript());
  if (u.pathname === "/chat/vendor.js") return asset(chatVendor());
  if (u.pathname === "/api/world") return send("application/json", JSON.stringify(world));
  if (u.pathname === "/api/wizard") {
    const n = world.nodes.find((x) => x.target === world.self)!;
    return send("application/json", JSON.stringify({ ok: true, at: world.at, role: { id: n.target, kind: "wizard", name: n.name, label: n.name, description: "演示", cwd: "/demo", model: "m", bornAt: 1, chat: "Demo", clones: [], spawns: [], forkedFrom: "", alive: true, busy: false, runningUntil: 0 }, uid: n.uid, ledger: true, sessions: [], session: "all", plans: [], schedules: [], charter: null }));
  }
  res.statusCode = 404; res.end("no");
});
await new Promise<void>((r) => server.listen(Number(process.argv[2]) || 0, "127.0.0.1", r));
console.log("http://127.0.0.1:" + (server.address() as { port: number }).port + "/role?id=demo");
