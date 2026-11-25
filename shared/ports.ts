// 监听口递增 + 实际口落盘。配置里的端口只是「首选」: 同机第二个 daemon / svr 起来时首选口
// 已被占, 以前 svr 会以无 error 监听的 listen 直接崩, 再被 systemd 每 5s 拉起一次 (崩溃循环),
// daemon 的视图口只告警、但它发出去的链接仍写死配置口 —— 点开是别人的页面或死链。
// 现在: EADDRINUSE 就 +1 再试 (至多 span 次), 成功后把**实际**监听口写进 <stateDir>/run/ports.json,
// 链接 / 外部工具 (shot.mjs、status) 以它为准。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Server } from "node:net";
import { dirname, join } from "node:path";
import { expandHome } from "./paths.js";

/** sysexits EX_CONFIG: 配置决定了起不来 —— 单元用 RestartPreventExitStatus=78 停止重拉。 */
export const EXIT_CONFIG = 78;

/** 首选口之后最多再试几个 (首选口本身不算)。 */
export const DEFAULT_PORT_SPAN = 20;

export type ListenResult =
  | { ok: true; port: number; tried: number }
  | { ok: false; code: string; message: string; tried: number };

/** 一次 listen, 答成没成。错误监听只挂这一次, 成功后摘掉 —— 别吞掉之后的运行期错误。 */
const listenOnce = (server: Server, port: number, host: string): Promise<NodeJS.ErrnoException | undefined> =>
  new Promise((resolve) => {
    const onError = (e: NodeJS.ErrnoException): void => { server.off("listening", onListening); resolve(e); };
    const onListening = (): void => { server.off("error", onError); resolve(undefined); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

/** 从 port 起逐个 +1 试到 port+span; 只有「被占」才往下试, 别的错 (EACCES / EADDRNOTAVAIL) 换口也没用, 立即返回。
 *  上界钳在 65535。成功时 port 是内核真正绑上的口 (port=0 时由内核分配)。 */
export const listenWithFallback = async (server: Server, host: string, port: number, span = DEFAULT_PORT_SPAN): Promise<ListenResult> => {
  const last = Math.min(65535, port + Math.max(0, span));
  let lastErr: NodeJS.ErrnoException | undefined;
  for (let p = port; p <= last; p++) {
    const e = await listenOnce(server, p, host);
    if (!e) {
      const addr = server.address();
      return { ok: true, port: addr && typeof addr === "object" ? addr.port : p, tried: p - port + 1 };
    }
    lastErr = e;
    if (e.code !== "EADDRINUSE") return { ok: false, code: e.code ?? "", message: e.message, tried: p - port + 1 };
  }
  return { ok: false, code: lastErr?.code ?? "EADDRINUSE", message: lastErr?.message ?? "", tried: last - port + 1 };
};

export interface PortEntry { host: string; port: number; pid: number; at: number }
/** daemon 写 `view`, svr 写 `svr`; null = 这个监听没起来 (关掉了 / 全被占), 区别于「从没写过」。 */
export type PortsFile = Partial<Record<"view" | "svr", PortEntry | null>>;

/** 单一推导: <stateDir>/run/ports.json (daemon 的 run 目录已是 0700, svr 的由 writePorts 建成 0700)。 */
export const portsFileOf = (stateDir: string): string => join(expandHome(stateDir), "run", "ports.json");

export const readPorts = (file: string): PortsFile => {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as PortsFile) : {};
  } catch { return {}; }
};

/** 合并写一项: tmp + rename 原子替换, 0600。读者永远看到整份旧的或整份新的。 */
export const writePorts = (file: string, patch: PortsFile): void => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...readPorts(file), ...patch }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
};

