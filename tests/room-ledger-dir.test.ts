// 钉住 2026-11-19 切换失败的根因: 账本目录只有一个推导 (shared/room.ts roomsDirOf),
// 从配置 stateDir 派生。迁移写入目录必须 == daemon 读取目录, observe.mjs 的缺省目录同源,
// 三个入口都不许再各自硬编码一个 rooms 路径出来。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrate } from "../cli/migrate-rooms.js";
import { loadConfig } from "../shared/config.js";
import { roomsDirOf } from "../shared/room.js";

// ① 推导本身: <stateDir>/rooms, ~ 展开按进程 HOME。
assert.equal(roomsDirOf("~/.wezard/state"), join(homedir(), ".wezard", "state", "rooms"));
assert.equal(roomsDirOf("/tmp/x/state"), "/tmp/x/state/rooms", "绝对路径原样接, 不再展开");

// ② 端到端钉: 迁移缺省写入目录 == daemon 读取目录 (两边都是 roomsDirOf(loadConfig().daemon.stateDir))。
//    dry-run 一个字不写, 但 outcome 里的 roomsDir 就是真跑会写、daemon 会读的那个目录。
const home = mkdtempSync(join(tmpdir(), "room-dir-"));
const dry = runMigrate({ home, dryRun: true });
assert.equal(dry.roomsDir, roomsDirOf(loadConfig().config.daemon.stateDir), "迁移写入目录 == daemon 读取目录");
const injected = runMigrate({ home, stateDir: join(home, "state"), dryRun: true });
assert.equal(injected.roomsDir, join(home, "state", "rooms"), "注入 stateDir 时账本跟着 stateDir 走");

// ③ 源码钉: 三个入口都从 roomsDirOf 推导, 不许再出现本地拼的 rooms 路径。
const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");
const daemonSrc = src("../daemon/index.ts");
assert.ok(daemonSrc.includes("roomsDirOf(cfg.daemon.stateDir)"), "daemon 用 roomsDirOf(cfg.daemon.stateDir)");
assert.ok(!daemonSrc.includes('join(expandHome(cfg.daemon.stateDir), "rooms")'), "daemon 不许本地拼账本路径");
const migrateSrc = src("../cli/migrate-rooms.ts");
assert.ok(migrateSrc.includes("roomsDirOf("), "迁移用 roomsDirOf");
assert.ok(!migrateSrc.includes('join(home, "rooms")'), "迁移不许从 home 拼 <home>/rooms");
const observeSrc = src("../scripts/room-cutover/observe.mjs");
assert.ok(observeSrc.includes("roomsDirOf"), "observe 缺省目录走 roomsDirOf");
assert.ok(!observeSrc.includes('join(homedir(), ".wezard", "rooms")'), "observe 不许硬编码 ~/.wezard/rooms");

// ④ 切换说明里不再留旧路径。
const cutoverSrc = src("../docs/room/cutover.md");
assert.ok(!cutoverSrc.includes("~/.wezard/rooms"), "cutover.md 不许再写 ~/.wezard/rooms (统一为 ~/.wezard/state/rooms)");

console.log("room-ledger-dir: 账本目录单一推导, 迁移==daemon==observe, rc=0");
