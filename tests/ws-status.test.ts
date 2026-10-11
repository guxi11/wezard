import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import pino from "pino";
import { ConfigSchema } from "../shared/config.js";
import { startWs } from "../daemon/ws.js";
import { startHttp } from "../daemon/http.js";

const log = pino({ level: "silent" });
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(server, "listening");
const port = (server.address() as { port: number }).port;
let connections = 0;
let socket: WebSocket;
let beforeAuth: { connected: boolean; authenticated: boolean } | undefined;
const cfg = ConfigSchema.parse({ bot: { botId: "test", secret: "test", websocketUrl: `ws://127.0.0.1:${port}` }, wrc: { defaultCli: "codex" } });
const ws = startWs(cfg, log);
server.on("connection", (s) => {
  socket = s;
  connections++;
  s.on("message", (b) => {
    const frame = JSON.parse(b.toString());
    if (frame.cmd === "aibot_subscribe") {
      beforeAuth = { connected: ws.client.isConnected, authenticated: ws.status().authenticated };
      s.send(JSON.stringify({ headers: frame.headers, errcode: 0, errmsg: "ok" }));
    }
  });
});
await ws.ready;
assert.deepEqual(beforeAuth, { connected: true, authenticated: false }, "transport open does not mean authenticated");
assert.equal(ws.status().phase, "authenticated");
assert.equal(ws.status().authenticated, true);
const reserve = createServer();
await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
const httpPort = (reserve.address() as { port: number }).port;
await new Promise<void>((resolve) => reserve.close(() => resolve()));
cfg.daemon.port = httpPort;
const http = startHttp({ cfg, ws, log, sourcePath: "/test/config.jsonc" });
try {
  const status = await (await fetch(`http://127.0.0.1:${httpPort}/status`)).json() as any;
  assert.equal(status.backend, "codex");
  assert.equal(status.wsConnected, true);
  assert.equal(status.ws.authenticated, true);
  const ready = once(ws.client as any, "authenticated");
  const reconnect = await fetch(`http://127.0.0.1:${httpPort}/reconnect`, { method: "POST" });
  assert.equal(reconnect.status, 200);
  await ready;
  assert.equal(connections, 2, "reconnect uses the existing daemon, not a second process");
  socket!.send(JSON.stringify({ cmd: "aibot_event_callback", headers: { req_id: "kick" }, body: { msgtype: "event", event: { eventtype: "disconnected_event" } } }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(ws.status().phase, "kicked");
  assert.equal(ws.status().authenticated, false);
  assert.equal(ws.client.isConnected, false);
  assert.match(ws.status().lastError ?? "", /Another client/);
} finally {
  await http.close(); await ws.shutdown();
  for (const s of server.clients) s.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
assert.equal(ws.status().phase, "stopped");
console.log("WS transport/auth/status/reconnect/kick checks passed");
