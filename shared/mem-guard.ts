/**
 * 主机内存闸: 再起一个 agent CLI 之前看一眼还剩多少内存。
 *
 * 为什么要有它: 每个 CLI (连 MCP 子进程) 常驻几百 MB, 一个 lead 连着 spawn 几个分身、
 * 每次领用又补一条空白备用, 小内存且无 swap 的主机会在半分钟里被推过线。无 swap 时内核
 * 赶不走匿名页, 只能反复丢代码页再缺页读回 —— 不触发 OOM, 而是整机卡死 (2026-11-20
 * 23:10 那次: 守护进程事件循环停了 6 分钟, spawn_wizard 的 MCP 调用超时, 23:48 整机被重启)。
 * 起不了就早早明说, 比把整台机器拖进抖动强。
 *
 * 只认 Linux 的 MemAvailable —— 它已算上可回收的 page cache。macOS 的 os.freemem()
 * 不计 inactive 页, 常年显得快满, 拿它设防只会误拒, 所以别的平台一律不设防。
 */
import { readFileSync } from "node:fs";

/** /proc/meminfo 正文 → MemAvailable (MB); 没有这一行 = undefined。 */
export const parseMemAvailableMb = (meminfo: string): number | undefined => {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo);
  return m ? Math.floor(Number(m[1]) / 1024) : undefined;
};

/** 此刻的可用内存 (MB); 非 Linux 或读不到 = undefined (不设防)。 */
export const memAvailableMb = (): number | undefined => {
  if (process.platform !== "linux") return undefined;
  try { return parseMemAvailableMb(readFileSync("/proc/meminfo", "utf8")); } catch { return undefined; }
};

/** 可用内存低于 floorMb 时返回缺口描述; floorMb ≤ 0 或量不出 = 放行 (undefined)。 */
export const memShortfall = (floorMb: number, availMb: number | undefined): { availMb: number; floorMb: number } | undefined =>
  floorMb > 0 && availMb !== undefined && availMb < floorMb ? { availMb, floorMb } : undefined;
