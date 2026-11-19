#!/usr/bin/env node
// 迁移入口 (契约 §6): 只读源, 写 <stateDir>/rooms/*.jsonl 与 rooms/_archive/ —— 原文件一个字不改。
//   node dist/cli/migrate-rooms.js [--dry-run] [--home <dir>]       缺省 home = ~/.wezard
//
// 账本目录与 daemon 同一处推导 (shared/room.ts roomsDirOf + loadConfig().daemon.stateDir);
// --home 只挪旧源 (wizards.json / routes.jsonl / state/...), 不挪账本 —— 2026-11-19 切换
// 失败就是迁移写 <home>/rooms 而 daemon 读 <stateDir>/rooms, 新 daemon 起来账本为空。
//
// 幂等: 第二次跑写 0 行 (依据见 shared/room-migrate.ts 顶部两条)。--dry-run 只出报表, 一个文件不碰
// (连 rooms/ 目录都不建 —— 空目录也算写)。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openRoomStore, parseJournal } from "../daemon/rooms.js";
import type { ChatLine } from "../shared/chat-record.js";
import { loadConfig } from "../shared/config.js";
import { unsettledRoutes } from "../shared/legacy-routes.js";
import { expandHome } from "../shared/paths.js";
import { roomsDirOf, type RoomOp } from "../shared/room.js";
import {
  migrateRooms, renderReport,
  type ChatSnap, type MemberSnap, type MigratePlan, type StoredEvent, type TurnSnap, type WizardSnap,
} from "../shared/room-migrate.js";

const readText = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

const readJson = <T>(file: string, fallback: T): T => {
  const raw = readText(file);
  if (!raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

/** append-only jsonl 逐行读; 坏行 (写一半的尾行) 丢掉 —— 源只读, 不修。 */
const readLines = <T>(file: string): T[] =>
  readText(file).split("\n").flatMap((ln) => {
    if (!ln.trim()) return [];
    try {
      return [JSON.parse(ln) as T];
    } catch {
      return [];
    }
  });

const listJsonl = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
};

/** wizards.json: 键 = target, 值 = WizardRecord。键当 target 的兜底。 */
const readWizards = (file: string): WizardSnap[] =>
  Object.entries(readJson<Record<string, WizardSnap>>(file, {})).flatMap(([target, rec]) =>
    rec && typeof rec === "object" ? [{ ...rec, target: rec.target || target }] : []);

/** state/chats/<encodeURIComponent(base)>.jsonl —— 文件名就是聊天键。 */
const readChats = (dir: string): ChatSnap[] =>
  listJsonl(dir).map((f) => ({
    chat: decodeURIComponent(f.slice(0, -6)),
    lines: readLines<ChatLine>(join(dir, f)),
  }));

/** state/members.json: 键 = <chat>|<target>。 */
const readMembers = (file: string): MemberSnap[] =>
  Object.entries(readJson<Record<string, { since?: number; cursor?: number }>>(file, {})).flatMap(([k, row]) => {
    const cut = k.indexOf("|");
    return cut < 0 || !row ? [] : [{ chat: k.slice(0, cut), target: k.slice(cut + 1), since: row.since, cursor: row.cursor }];
  });

/** state/details.jsonl: 只要 turn 行的 (target, channel, 时刻)。 */
const readTurns = (file: string): TurnSnap[] =>
  readLines<{ kind?: string; target?: string; channel?: string; createdAt?: number }>(file)
    .filter((r) => !!r && r.kind === "turn")
    .map((r) => ({ target: r.target, channel: r.channel, at: r.createdAt }));

const readEvents = (file: string): StoredEvent[] =>
  Object.entries(readJson<Record<string, StoredEvent>>(file, {}))
    .filter(([, e]) => !!e && typeof e === "object")
    .map(([id, e]) => ({ ...e, id: e.id || id }));

/** 已经落盘的 room 账本 (只读, 不建目录)。 */
const readRooms = (dir: string): Record<string, RoomOp[]> =>
  Object.fromEntries(listJsonl(dir).map((f) => {
    const id = decodeURIComponent(f.slice(0, -6));
    return [id, parseJournal(id, readFileSync(join(dir, f), "utf8"))] as const;
  }));

const configSteward = (): ((chat: string) => string | undefined) => {
  let policy: Record<string, { steward?: string }> = {};
  try {
    policy = loadConfig().config.chatPolicy;
  } catch {
    // 没配置 / 配坏了: 那就没有管家绑定, founder 退回「本群的默认会话」。
  }
  return (chat) => policy[chat]?.steward;
};

export interface MigrateOptions {
  /** wezard 的 home (缺省 ~/.wezard): 旧源 (wizards.json / routes.jsonl / state/…) 的根。 */
  home: string;
  /** 账本基目录: 迁移写 <stateDir>/rooms。缺省 = loadConfig().daemon.stateDir —— daemon 读哪儿迁移就写哪儿,
   *  两边是同一个 roomsDirOf 推导 (tests/room-ledger-dir.test.ts 钉住)。测试注入指向自己的临时目录。 */
  stateDir?: string;
  dryRun?: boolean;
  now?: number;
  /** 测试注入; 缺省从 loadConfig() 的 chatPolicy 读绑定管家。 */
  stewardOf?: (chat: string) => string | undefined;
}

export interface MigrateOutcome {
  plan: MigratePlan;
  /** 真的写进账本的行数 (dry-run = 0)。 */
  written: number;
  /** uncertain 事件归档文件 (没写也在)。 */
  archivePath: string;
  /** 实际写入的账本目录 (= daemon 读取目录); 第 8 步 O2 闸拿它重放盘上账本。 */
  roomsDir: string;
}

/** 读源 → 算 plan → 写盘。写盘走 daemon/rooms.ts 的 store (append + fsync)。 */
export const runMigrate = (o: MigrateOptions): MigrateOutcome => {
  const home = expandHome(o.home);
  const state = join(home, "state");
  const roomsDir = roomsDirOf(o.stateDir ?? loadConfig().config.daemon.stateDir);
  const plan = migrateRooms({
    now: o.now ?? Date.now(),
    wizards: readWizards(join(home, "wizards.json")),
    stewardOf: o.stewardOf ?? configSteward(),
    chats: readChats(join(state, "chats")),
    members: readMembers(join(state, "members.json")),
    turns: readTurns(join(state, "details.jsonl")),
    routes: unsettledRoutes(readText(join(home, "routes.jsonl"))),
    events: readEvents(join(state, "message-events.json")),
    existing: readRooms(roomsDir),
  });
  const archivePath = join(roomsDir, "_archive", "message-events-uncertain.json");
  let written = 0;
  if (!o.dryRun) {
    if (plan.rooms.length) {
      const store = openRoomStore(roomsDir);
      for (const r of plan.rooms) {
        store.append(r.room, r.ops);
        written += r.ops.length;
      }
    }
    // 归档只在有东西可归 (或上一版已经写过这个文件) 时落盘: 空迁移不建目录。
    if (plan.archive.length || existsSync(archivePath)) {
      mkdirSync(join(roomsDir, "_archive"), { recursive: true });
      writeFileSync(archivePath, JSON.stringify(plan.archive, null, 2) + "\n");
    }
  }
  return { plan, written, archivePath, roomsDir };
};

const flagValue = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

export const main = (argv: readonly string[] = process.argv.slice(2)): void => {
  // 只认 --dry-run / --home <dir>; 其余参数 (含 --help) 一律拒, 免得误敲一个参数就真写账本。
  const bad = argv.filter((a, i) => a !== "--dry-run" && a !== "--home" && argv[i - 1] !== "--home");
  if (bad.length) throw new Error("不认识的参数 " + bad.join(" ") + " —— 用法: migrate-rooms [--dry-run] [--home <dir>] (不带 --dry-run 会真写配置 stateDir 下的 rooms)");
  const home = expandHome(flagValue(argv, "--home") ?? "~/.wezard");
  const dryRun = argv.includes("--dry-run");
  const out = runMigrate({ home, dryRun });
  console.log(renderReport(out.plan.report));
  console.log(dryRun
    ? "(dry-run: 未写任何文件; 真跑会写 → " + out.roomsDir + ")"
    : "写入 " + out.written + " 行 → " + out.roomsDir);
};

const entry = process.argv[1];
if (entry && pathToFileURL(entry).href === import.meta.url) {
  try {
    main();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[wezard] migrate-rooms: " + (e as Error).message);
    process.exit(1);
  }
}
