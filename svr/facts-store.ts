// svr 的名册快照落盘: factsBySource 的投影 (source → {at, facts}) 存成一份 json,
// 重启后按 TTL 读回。纯读写函数, 不碰 svr 的运行时状态。
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { WorldFacts } from "../shared/world.js";

/** roomsDir: 推送方 daemon 的账本目录 —— svr 据此判本地账本归哪个来源 (见 svr/index.ts ledgerServes)。 */
export type FactsEntry = { at: number; facts: WorldFacts; roomsDir?: string };

const isEntry = (v: unknown): v is FactsEntry =>
  !!v && typeof v === "object"
  && typeof (v as FactsEntry).at === "number"
  && !!(v as FactsEntry).facts && typeof (v as FactsEntry).facts === "object"
  && Array.isArray((v as FactsEntry).facts.wizards);

// 只保留 at 仍在 ttl 内的条目 (严格大于 now-ttl, 与 currentFacts 同口径); 缺失 / 损坏 = 空。
export const loadFacts = (path: string, now: number, ttl: number): Map<string, FactsEntry> => {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new Map();
    return new Map(Object.entries(raw).filter((kv): kv is [string, FactsEntry] => isEntry(kv[1]) && kv[1].at > now - ttl));
  } catch {
    return new Map();
  }
};

// 先写临时文件再 rename: 读者永远看不到写了一半的文件。抛错交给调用方打 warn。
export const saveFacts = (path: string, map: ReadonlyMap<string, FactsEntry>): void => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)));
  renameSync(tmp, path);
};
