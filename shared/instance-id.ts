// 一个 daemon 实例的稳定署名 —— 多个 daemon 共用一个 svr 时, svr 按它把快照 / 记录分区。
// 以前用 hostname(): 同机两个 daemon 撞成一个键, 后推的覆盖先推的, 两边的名册来回跳。
// stateDir 在同机上必然各不相同 (控制面 socket 就在里面), 不改它重启后署名就不变;
// 前缀留 hostname 只为日志 / facts.json 里人读得出是哪台。
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { expandHome } from "./paths.js";

/** 目录的规范绝对路径: 有符号链接按真实路径算 (两种写法指同一处不该算两个实例); 还不存在就用 resolve 的结果。 */
export const canonicalDir = (dir: string): string => {
  const abs = resolve(expandHome(dir));
  try { return realpathSync(abs); } catch { return abs; }
};

export const daemonSourceOf = (stateDir: string, host: string = hostname()): string =>
  `${host || "daemon"}:${createHash("sha256").update(canonicalDir(stateDir)).digest("hex").slice(0, 8)}`;
