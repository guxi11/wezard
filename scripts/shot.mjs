#!/usr/bin/env node
// 给 wizard 一双眼睛: 用 headless chromium 给 rolepage (或任意 URL) 截一张 png。
//
//   node scripts/shot.mjs --role chat:wr…            # 本机守护进程的 rolepage, 票据自动取
//   node scripts/shot.mjs --role .Iris --mobile       # 窄屏 (390×844)
//   node scripts/shot.mjs --role chat:wr… --selector '.rv-graph' --wait-for '.rv-room'
//   node scripts/shot.mjs --role .Iris --room chat:wr…  # 站在 Iris 的视角、选中那个 room; --room '' = 明确不选 (不带 --room = 走票据落点)
//   node scripts/shot.mjs --url http://127.0.0.1:8080/x.html --full --out /tmp/x.png
//
// 选项: --role <名字|target|chat:…>  --room <roomId|空串> (拼进 URL 的 room=; 缺省不带)  --url <完整 URL> (与 --role 二选一)  --mobile  --full (整页)
//       --scroll <css> (截图前把它滚到视口中间; 如 detail 里某条消息 '.rv-msg[data-id="…"]')  --click <css> (截图前先点它, 可重复; 如切到关系图)  --selector <css> (只截该元素)  --wait-for <css>  --wait <ms, 默认 1500>  --scale <dsf, 默认 1>
//       --base <http://host:port> (默认本机守护进程回环; 想看 svr 就传它)  --out <png 路径>
// 输出: 末行打印 png 的绝对路径 (默认 ~/.wezard/shots/)。送图给人: send_file 发进群。
//
// 票据 (rolepage 的 `?id=`) 现取: 从守护进程自己的 details.jsonl 里取最新一条 turn 的 id —— 任一有效票据都能看任一 role
// (见 shared/chat-http.ts), 所以不硬编码、不进仓库、不进日志 (输出里的 URL 一律把 id 抹成 <ticket>)。
//
// 省内存 (本机 3.7GB): 同一时刻只允许一个实例 (锁文件), 截完立刻关浏览器, 单进程 + 无 GPU / dev-shm。
// playwright 在 devDependencies; 浏览器装在 ~/.cache/ms-playwright (npx playwright install chromium-headless-shell)。
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";

const HOME = homedir();
const expand = (p) => (p.startsWith("~") ? join(HOME, p.slice(1)) : p);
// die 走 process.exit, 绕过 finally —— 锁与浏览器必须在这里收掉, 否则失败一次就卡住下一次。
let cleanup = () => {};
const die = (msg, code = 1) => { console.error(`shot: ${msg}`); cleanup(); process.exit(code); };
const redact = (s) => s.replace(/([?&]id=)[^&#\s]+/g, "$1<ticket>");

const { values: o } = parseArgs({
  options: {
    role: { type: "string" }, room: { type: "string" }, url: { type: "string" }, base: { type: "string" },
    mobile: { type: "boolean", default: false }, full: { type: "boolean", default: false },
    selector: { type: "string" }, click: { type: "string", multiple: true }, "wait-for": { type: "string" }, wait: { type: "string", default: "1500" },
    scale: { type: "string", default: "1" }, scroll: { type: "string" }, out: { type: "string" }, help: { type: "boolean", short: "h", default: false },
  },
});
if (o.help || (!o.role && !o.url)) die("需要 --role <名字|target> 或 --url <URL>; 详见脚本头部注释", o.help ? 0 : 2);

// ── playwright: 仓库 devDependency, 或 WZ_PLAYWRIGHT_DIR 指向的一份 node_modules ───────────
const loadChromium = async () => {
  try { return (await import("playwright")).chromium; } catch { /* 没装 */ }
  const dir = process.env.WZ_PLAYWRIGHT_DIR;
  if (dir) { try { return createRequire(join(dir, "noop.cjs"))("playwright").chromium; } catch { /* 下面报错 */ } }
  return undefined;
};

// ── 守护进程地址 + 票据 ────────────────────────────────────────────────────────────────
const readConfig = () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const path = [process.env.WEZARD_CONFIG, "~/.wezard/config.jsonc", "~/.wezard/config.json"].filter(Boolean).map(expand).find(existsSync);
  const cfg = path ? parseJsonc(readFileSync(path, "utf8")) ?? {} : {};
  const d = cfg.daemon ?? {};
  return { root, host: d.host ?? "127.0.0.1", port: d.port ?? 17890, stateDir: expand(d.stateDir ?? "~/.wezard/state") };
};

/** 最新一条 turn 记录的 id; 文件按追加顺序, 从尾往前找第一条。 */
const latestTicket = (stateDir) => {
  const file = join(stateDir, "details.jsonl");
  if (!existsSync(file)) die(`找不到 ${file} (守护进程没跑过?)`);
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.startsWith('{"kind":"turn"') && !l.startsWith('{"kind":"chat"')) continue;
    try { const r = JSON.parse(l); if (r.id) return r.id; } catch { /* 撕裂行 */ }
  }
  return die("details.jsonl 里没有可用票据 (没有任何 turn / chat 记录)");
};

const cfg = readConfig();
const target = (() => {
  if (o.url) return o.url;
  const base = (o.base ?? `http://${cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host}:${cfg.port}`).replace(/\/$/, "");
  const q = new URLSearchParams({ id: latestTicket(cfg.stateDir), role: o.role.replace(/^\./, "") });
  if (o.room !== undefined) q.set("room", o.room);   // 空串也写: room= 是「明确不选」, 与缺省 (走落点) 不同
  return `${base}/role?${q}`;
})();

const outPath = (() => {
  if (o.out) return resolve(expand(o.out));
  const dir = join(HOME, ".wezard", "shots");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const tag = (o.role ?? "page").replace(/[^\w.-]+/g, "_").slice(0, 40);
  return join(dir, `${stamp}-${tag}-${o.mobile ? "mobile" : "desktop"}.png`);
})();
mkdirSync(dirname(outPath), { recursive: true });

// ── 单实例锁: 3.7GB 的机器上并发两个 chromium 会被 earlyoom 点名 ────────────────────────
const lockFile = join(HOME, ".wezard", "shots", ".lock");
mkdirSync(dirname(lockFile), { recursive: true });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const takeLock = () => {
  for (let i = 0; i < 2; i++) {
    try { closeSync(openSync(lockFile, "wx")); writeFileSync(lockFile, String(process.pid)); return; }
    catch {
      const pid = Number(readFileSync(lockFile, "utf8")) || 0;
      if (pid && alive(pid) && Date.now() - statSync(lockFile).mtimeMs < 120_000) die(`已有一个截图在跑 (pid ${pid}); 并发只允许 1 个, 等它结束`);
      try { unlinkSync(lockFile); } catch { /* 被别人抢先清了 */ }
    }
  }
  die("拿不到截图锁");
};
const dropLock = () => { try { unlinkSync(lockFile); } catch { /* 已无 */ } };

const chromium = await loadChromium();
if (!chromium) die("没有 playwright: 仓库里 npm i (devDependencies), 或 WZ_PLAYWRIGHT_DIR=<装了它的 node_modules>");

takeLock();
cleanup = dropLock;
process.on("SIGINT", () => { dropLock(); process.exit(130); });
process.on("SIGTERM", () => { dropLock(); process.exit(143); });

let browser;
try {
  // 无桌面机器缺的系统库: shot-setup.sh 解在这, 存在就挂上 (没有 sudo 也能跑)。
  const libs = join(HOME, ".cache", "wezard-shot-libs", "root", "usr", "lib", "x86_64-linux-gnu");
  browser = await chromium.launch({
    headless: true,
    ...(existsSync(libs) ? { env: { ...process.env, LD_LIBRARY_PATH: [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") } } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-extensions", "--no-zygote", "--single-process", "--mute-audio"],
  });
  cleanup = () => { dropLock(); try { browser.process()?.kill("SIGKILL"); } catch { /* 已退 */ } };
  const ctx = await browser.newContext({
    viewport: o.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: Number(o.scale) || 1,
    isMobile: o.mobile,
    hasTouch: o.mobile,
    ...(o.mobile ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" } : {}),
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // SSE 常连: 不能等 networkidle, 只等 DOM, 再靠选择器 / 毫秒数等渲染。
  const resp = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (resp && !resp.ok()) die(`${resp.status()} ${redact(target)}`);
  if (o["wait-for"]) await page.waitForSelector(o["wait-for"], { timeout: 20_000 });
  for (const c of o.click ?? []) { await page.locator(c).first().click({ timeout: 10_000 }); await page.waitForTimeout(500); }
  await page.waitForTimeout(Math.max(0, Number(o.wait) || 0));
  if (o.scroll) { await page.locator(o.scroll).first().evaluate((e) => e.scrollIntoView({ block: "center" })); await page.waitForTimeout(400); }
  if (o.selector) await page.locator(o.selector).first().screenshot({ path: outPath });
  else await page.screenshot({ path: outPath, fullPage: o.full });
  if (errors.length) console.error(`shot: 页面有 ${errors.length} 个 JS 报错, 首条: ${errors[0].slice(0, 200)}`);
  console.error(`shot: ${redact(target)}`);
  console.log(outPath);
} catch (e) {
  die(redact(String(e?.message ?? e)).split("\n")[0]);
} finally {
  await browser?.close().catch(() => {});
  dropLock();
}
