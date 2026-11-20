// 只读: 列出 after:["undefined"] 的 ask/task 行 (2026-11-20 idList 修复前落下的旧受害行, 当时 wake=[] 没唤醒任何人)。
// 每行: room / id / 作者 / 被点名者 / 时间 / duty 是否仍开 / 当时是否唤醒了它 / 被点名者之后是否 re 过它 / 是否会被补投。
// 「会补投」用的就是 daemon 的同一判定 (shared/room.ts afterWakeDue), 与 POST /room/after-reconcile {fake:true} 的清单一致。
//   npx tsx scripts/after-fake-audit.ts [--since 2026-11-20T11:05+08:00] [--json]
// 不写任何文件 (只读账本 / 名册)。
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../shared/config.js";
import { expandHome } from "../shared/paths.js";
import { openRoomStore } from "../daemon/rooms.js";
import { afterIsFake, afterWakeDue, dutyKey, roomsDirOf, sameWho, uidOf, whoKey, type RoomState, type Who } from "../shared/room.js";

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(k); return i < 0 ? undefined : process.argv[i + 1]; };
const since = arg("--since") ? Date.parse(arg("--since")!) : 0;
const asJson = process.argv.includes("--json");

const { config: cfg } = loadConfig();
const roomsDir = roomsDirOf(cfg.daemon.stateDir);
const wizFile = expandHome(cfg.wrc.mirror.wizardsFile);
const names = new Map<string, string>();
if (existsSync(wizFile)) {
  const raw = JSON.parse(readFileSync(wizFile, "utf8")) as Record<string, { uid?: string; target: string; bornAt?: number; name?: string }>;
  for (const rec of Object.values(raw)) { try { names.set(uidOf(rec), rec.name ?? rec.target); } catch { /* 坏条目跳过 */ } }
}
const nameOf = (w: Who): string => (w.kind === "wizard" ? "." + (names.get(w.id) ?? w.id) : w.kind === "daemon" ? "wezard" : w.id);

const store = openRoomStore(roomsDir);
const closedDone = (msg: string): boolean => {
  const room = store.roomOfMsg(msg);
  let s: RoomState | undefined;
  try { s = room ? store.get(room) : undefined; } catch { return false; }
  if (!s) return false;
  const ds = [...s.duties.values()].filter((d) => d.msg === msg);
  return ds.length > 0 && ds.every((d) => d.closed?.status === "done");
};

interface Row { room: string; id: string; at: string; author: string; to: string; open: boolean; woke: boolean; reBy: string; trigger: boolean; backfill: boolean; text: string }
const out: Row[] = [];
for (const room of store.ids()) {
  let s: RoomState | undefined;
  try { s = store.get(room); } catch (e) { console.error("跳过损坏账本 " + room + ": " + String(e)); continue; }
  if (!s) continue;
  for (const m of s.msgs) {
    if ((m.kind !== "ask" && m.kind !== "task") || !afterIsFake(m.after) || m.at < since) continue;
    for (const t of (m.to ?? []).filter((x) => x.kind === "wizard")) {
      const d = s.duties.get(dutyKey(m.id, whoKey(t))) ?? [...s.duties.values()].find((x) => x.msg === m.id && !x.closed);
      const later = s.msgs.filter((r) => r.seq > m.seq && (r.re ?? []).includes(m.id) && r.author.kind === "wizard");
      out.push({
        room, id: m.id, at: new Date(m.at).toISOString(), author: nameOf(m.author), to: nameOf(t),
        open: !!d && !d.closed,
        woke: m.wake.includes(t.id),
        reBy: [...new Set(later.map((r) => nameOf(r.author) + (r.status ? "[" + r.status + "]" : "")))].join(" "),
        trigger: s.msgs.some((r) => r.kind === "trigger" && (r.re ?? []).includes(m.id) && (r.to ?? []).some((x) => sameWho(x, t))),
        backfill: !!d && !!afterWakeDue(s, d, closedDone),
        text: m.text.replace(/\s+/g, " ").slice(0, 60),
      });
    }
  }
}
out.sort((a, b) => a.at.localeCompare(b.at));
if (asJson) console.log(JSON.stringify(out, null, 1));
else {
  console.log(["at", "room", "id", "author", "to", "dutyOpen", "wokeThen", "reByLater", "triggered", "BACKFILL", "text"].join("\t"));
  for (const r of out) console.log([r.at, r.room, r.id, r.author, r.to, r.open ? "open" : "closed", r.woke ? "yes" : "-", r.reBy || "-", r.trigger ? "yes" : "-", r.backfill ? "YES" : "-", r.text].join("\t"));
  console.log("\n共 " + out.length + " 行, 会补投 " + out.filter((r) => r.backfill).length + " 行");
}
