// 控制面 unix socket 的落地: 目录校验 → 探测旧文件 → listen → 收紧权限 → 只删自己的 inode。
// 为什么这么啰嗦: socket 是整台机器上唯一挡住「别的 uid」的东西, 每一步都不能「顺手修」
// 别人的东西 —— 目录不是自己的就报错退出, 活 daemon 在听就不覆盖, 不是 socket 的文件不删。
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, type Server } from "node:net";
import { dirname } from "node:path";
import { sockPathProblem } from "../shared/daemon-addr.js";

/** 控制面起不来的原因 (人话): index.ts 报出来后 exit 1, systemd / launchd 会重试。 */
export class ControlSocketError extends Error {}

/** 目录: 存在则必须是目录、非 symlink、owner = 自己; 然后无论新旧一律收紧到 0700。 */
export const ensureRunDir = (sockPath: string): void => {
  const dir = dirname(sockPath);
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) {
    throw new ControlSocketError(`无法创建 socket 目录 ${dir}: ${(e as Error).message}`);
  }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new ControlSocketError(`${dir} 不是普通目录 (symlink 或文件), 拒绝在里面放控制面 socket; 请把 daemon.socket 指到自己的目录`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid)
    throw new ControlSocketError(`${dir} 属于 uid ${st.uid} 而不是当前用户 (${uid}), 不去修别人的目录; 请把 daemon.socket 指到自己的目录`);
  chmodSync(dir, 0o700);
};

export type SocketProbe = "absent" | "live" | "stale" | "not-socket" | "unknown";

/** 路径上现在是什么: 连得上 = 活 daemon; ECONNREFUSED = 陈旧; 其余不确定。 */
export const probeSocket = (path: string, timeoutMs = 2000): Promise<SocketProbe> =>
  new Promise((resolve) => {
    let st;
    try { st = lstatSync(path); } catch (e) {
      resolve((e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown");
      return;
    }
    if (!st.isSocket()) { resolve("not-socket"); return; }
    const sock = connect(path);
    const done = (r: SocketProbe): void => { sock.destroy(); resolve(r); };
    sock.setTimeout(timeoutMs, () => done("unknown"));
    sock.once("connect", () => done("live"));
    sock.once("error", (e: NodeJS.ErrnoException) =>
      done(e.code === "ECONNREFUSED" ? "stale" : e.code === "ENOENT" ? "absent" : "unknown"));
  });

export interface BoundSocket {
  path: string;
  ino: number;
  dev: number;
}

const refuse = (path: string, p: SocketProbe): ControlSocketError =>
  new ControlSocketError(
    p === "live" ? `another wezard daemon is listening on ${path} (pid unknown); 等它退出后本进程才能接手`
    : p === "not-socket" ? `${path} 已存在但不是 socket, 拒绝删除; 请人工处理或改 daemon.socket`
    : `无法确定 ${path} 是否有 daemon 在听, 不覆盖; 请人工检查`,
  );

/** 把 server 绑到 path。成功后 socket 是 0600、目录是 0700。 */
export const bindControlSocket = async (server: Server, path: string): Promise<BoundSocket> => {
  const problem = sockPathProblem(path);
  if (problem) throw new ControlSocketError(problem);
  ensureRunDir(path);
  const probe = await probeSocket(path);
  if (probe === "stale") unlinkSync(path);
  else if (probe !== "absent") throw refuse(path, probe);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  // bind 与 chmod 之间的窗口由 0700 目录兜住。
  chmodSync(path, 0o600);
  const st = lstatSync(path);
  return { path, ino: st.ino, dev: st.dev };
};

/** 路径上的 inode 仍是我们 listen 的那个吗 (被接手者替换了就不是)。 */
export const stillOwns = (b: BoundSocket): boolean => {
  try { const st = lstatSync(b.path); return st.ino === b.ino && st.dev === b.dev; } catch { return false; }
};

/** 退出时只删自己的: 别删掉接手者新建的同名 socket。 */
export const unlinkIfOwned = (b: BoundSocket): boolean => {
  if (!stillOwns(b)) return false;
  try { unlinkSync(b.path); return true; } catch { return false; }
};
