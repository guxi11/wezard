// 包内 skills/<name>/ 是随 npm 走的权威副本, <stateDir>/skills/<name>/ 才是 CLI 真正读到的
// 落地 (挂载见 session-skills.ts)。物化不是 rsync: 一份 stamp
// (<stateDir>/skills/.wezard-skills.json) 记着我们上次写下的每个文件的 sha, 于是
// 「用户改过的」「用户删过的」「上游删掉的」都能区分开 —— 覆盖用户自己的东西是这里
// 唯一不可接受的错, 比拿不到新版严重。合并规则见 planSkillMerge。
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STAMP_FILE = ".wezard-skills.json";

export interface SkillFile { rel: string; sha: string }

export interface SkillStamp {
  /** 上次物化时的 wezard 版本 + 包内内容签名 —— 两者都没变就完全不做盘上比较。 */
  version: string;
  sig: string;
  /** 上次由我们写下的每个文件 (rel → sha)。 */
  files: Record<string, string>;
  /** 用户移除 / 删掉整个目录: 不再自动装, 直到 install --force。 */
  removed?: true;
  /** 用户宣布自己管这份 skill: 之后一个字节不动。 */
  pinned?: true;
}

export type SkillStamps = Record<string, SkillStamp>;

export type SkillMode =
  | "install"  // 全量写 (首次 / --force)
  | "adopt"    // 盘上内容与包内逐文件相同: 只写 stamp, 不动盘 (手拷过的老用户)
  | "update"   // 按 stamp 合并, 有文件要写
  | "noop"     // 版本/内容变了, 但没有文件该由我们写 (全是用户改过/删过的)
  | "current"  // version + sig 未变, 早退
  | "held"     // pinned / removed
  | "foreign"  // 无 stamp 且内容不同: 当作用户自己的, 一个字节不动
  | "gone";    // 目录被用户删了: 记 removed, 不复活

export interface SkillMerge {
  mode: SkillMode;
  /** 要由我们写入的文件 (相对路径)。 */
  write: string[];
  /** 我们不动、但值得报告的文件: 用户改过的 / 用户删掉的。 */
  skip: string[];
  /** 上游已删: 从 stamp 里摘掉, 盘上保留。 */
  forget: string[];
  /** undefined = 不写 stamp (foreign: 那份不是我们的, 不该被收编)。 */
  stamp?: SkillStamp;
}

const sha256 = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

/** 包内目录的内容签名: 文件集合 + 每个文件的 sha, 与遍历顺序无关。 */
export const signatureOf = (files: SkillFile[]): string =>
  sha256([...files].map((f) => f.rel + "\0" + f.sha + "\n").sort().join(""));

const shaMap = (files: SkillFile[]): Record<string, string> =>
  Object.fromEntries(files.map((f) => [f.rel, f.sha]));

const sameTree = (a: SkillFile[], b: SkillFile[]): boolean => {
  const left = shaMap(a);
  const right = shaMap(b);
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((k) => left[k] === right[k]);
};

/**
 * 合并规则 (纯):
 *   pinned / removed                → held  (除非 force)
 *   目标不存在 + 无 stamp            → install 全量
 *   目标不存在 + 有 stamp            → gone, 记 removed (用户删的, 不复活)
 *   目标存在 + 无 stamp + 内容全同    → adopt 只写 stamp
 *   目标存在 + 无 stamp + 内容不同    → foreign 不动 (除非 force)
 *   目标存在 + 有 stamp              → 逐文件: 盘上 == 我们上次写的才覆盖;
 *                                      用户改过 / 用户删过 / 同名但非我们所写 → skip;
 *                                      上游已删 → forget (盘上保留)
 */
export const planSkillMerge = (args: {
  version: string;
  sig: string;
  bundled: SkillFile[];
  installed: SkillFile[] | undefined;
  stamp: SkillStamp | undefined;
  force?: boolean;
  /** 人显式 install: 目录被删过也照样装回来 (自动路径不复活)。 */
  revive?: boolean;
}): SkillMerge => {
  const { version, sig, bundled, installed, stamp, force, revive } = args;
  const fresh: SkillStamp = { version, sig, files: shaMap(bundled) };
  const hold = (mode: SkillMode, next: SkillStamp | undefined): SkillMerge =>
    ({ mode, write: [], skip: [], forget: [], stamp: next });
  if (!force && (stamp?.pinned || stamp?.removed)) return hold("held", stamp);
  if (installed === undefined) {
    if (stamp && !force && !revive) return hold("gone", { ...stamp, removed: true });
    return { mode: "install", write: bundled.map((f) => f.rel), skip: [], forget: [], stamp: fresh };
  }
  if (!stamp || force) {
    if (force) return { mode: "install", write: bundled.map((f) => f.rel), skip: [], forget: [], stamp: fresh };
    return sameTree(bundled, installed)
      ? hold("adopt", fresh)
      : hold("foreign", undefined);
  }
  if (stamp.sig === sig && stamp.version === version) return hold("current", stamp);

  const now = new Map(installed.map((f) => [f.rel, f.sha]));
  const write: string[] = [];
  const skip: string[] = [];
  for (const f of bundled) {
    const cur = now.get(f.rel);
    const prev = stamp.files[f.rel];
    if (cur === f.sha) continue;                             // 盘上已是这版
    if (prev === undefined) {
      // 我们从没写过这个文件: 本地也没有 → 上游新增, 写; 本地已有同名 → 用户自建, 不碰
      if (cur === undefined) write.push(f.rel); else skip.push(f.rel);
      continue;
    }
    if (cur === undefined) { skip.push(f.rel); continue; }    // 我们写过, 用户删了 —— 不复活
    if (cur !== prev) { skip.push(f.rel); continue; }         // 我们写过, 用户后来改了
    write.push(f.rel);
  }
  const forget = Object.keys(stamp.files).filter((rel) => !bundled.some((f) => f.rel === rel));
  return { mode: write.length ? "update" : "noop", write, skip, forget, stamp: fresh };
};

// ── IO ──────────────────────────────────────────────────────────────────

const SKIP = new Set([".DS_Store"]);

const walk = (root: string, prefix = ""): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((e) => {
    if (SKIP.has(e.name) || e.name.startsWith("._")) return [];
    const rel = prefix ? prefix + "/" + e.name : e.name;
    if (e.isDirectory()) return walk(join(root, e.name), rel);
    return e.isFile() || e.isSymbolicLink() ? [rel] : [];
  });

/** 目录 → 文件清单; 目录不存在返回 undefined (与「空目录」区分: 前者 = 用户删了)。 */
export const scanSkillDir = (root: string): SkillFile[] | undefined => {
  if (!existsSync(root)) return undefined;
  return walk(root).sort().map((rel) => ({ rel, sha: sha256(readFileSync(join(root, rel))) }));
};

const stampsPath = (stateDir: string): string => join(stateDir, "skills", STAMP_FILE);
export const skillDirOf = (stateDir: string, name: string): string => join(stateDir, "skills", name);

/** stamp 损坏 / 半写 → 当作没有 (最坏结果是重新收编或跳过, 不会误覆盖)。 */
export const readStamps = (stateDir: string): SkillStamps => {
  try {
    const parsed = JSON.parse(readFileSync(stampsPath(stateDir), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as SkillStamps) : {};
  } catch { return {}; }
};

const writeStamps = (stateDir: string, stamps: SkillStamps): void => {
  const p = stampsPath(stateDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(stamps, null, 2) + "\n");
};

const applyMerge = (stateDir: string, name: string, bundleDir: string, plan: SkillMerge, stamps: SkillStamps): void => {
  const dest = skillDirOf(stateDir, name);
  for (const rel of plan.write) {
    const src = join(bundleDir, rel);
    const out = join(dest, rel);
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(src, out);
    // scripts/*.py 之类要保持可执行位; 显式一次, 不依赖 umask。
    try { chmodSync(out, statSync(src).mode & 0o777); } catch { /* 权限位失败不影响内容 */ }
  }
  if (!plan.stamp) return;
  if (JSON.stringify(stamps[name]) !== JSON.stringify(plan.stamp)) {
    stamps[name] = plan.stamp;
    writeStamps(stateDir, stamps);
  }
};

// ── 包内 skill 的发现 ───────────────────────────────────────────────────

/** 编译后 <root>/dist/shared/…, tsx 下 <root>/shared/… —— 取带 package.json 的那层。 */
const pkgRoot = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const cand of [resolve(here, ".."), resolve(here, "..", "..")]) {
    if (existsSync(join(cand, "package.json"))) return cand;
  }
  return resolve(here, "..", "..");
};

export const bundleRoot = (): string => join(pkgRoot(), "skills");

let versionCache: string | undefined;
export const packageVersion = (): string => {
  if (versionCache) return versionCache;
  try {
    versionCache = String(JSON.parse(readFileSync(join(pkgRoot(), "package.json"), "utf8")).version ?? "0.0.0");
  } catch { versionCache = "0.0.0"; }
  return versionCache;
};

/** 包内带 SKILL.md 的目录 (与 session-skills.ts 的判据一致)。 */
export const bundledSkillNames = (): string[] => {
  const root = bundleRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => existsSync(join(root, name, "SKILL.md")))
    .sort();
};

export interface SkillSyncReport {
  name: string;
  mode: SkillMode;
  wrote: number;
  skipped: string[];
  forgot: string[];
  error?: string;
}

/** 物化一份内置 skill 到 <stateDir>/skills/<name>; 任何异常都只影响它自己。 */
export const materializeSkill = (
  stateDir: string,
  name: string,
  opts: { force?: boolean; revive?: boolean } = {},
): SkillSyncReport => {
  const bundleDir = join(bundleRoot(), name);
  const bundled = scanSkillDir(bundleDir);
  if (!bundled || !bundled.length) return { name, mode: "noop", wrote: 0, skipped: [], forgot: [] };
  const version = packageVersion();
  const sig = signatureOf(bundled);
  const stamps = readStamps(stateDir);
  const stamp = stamps[name];
  // 早退: 包没换版、内容也没变 —— 一个盘都不用读 (spawn 路径上就是这个代价)。
  if (!opts.force && !opts.revive && stamp && !stamp.removed && !stamp.pinned
    && stamp.version === version && stamp.sig === sig
    && existsSync(skillDirOf(stateDir, name))) {
    return { name, mode: "current", wrote: 0, skipped: [], forgot: [] };
  }
  const plan = planSkillMerge({
    version, sig, bundled, installed: scanSkillDir(skillDirOf(stateDir, name)), stamp,
    force: opts.force, revive: opts.revive,
  });
  applyMerge(stateDir, name, bundleDir, plan, stamps);
  return { name, mode: plan.mode, wrote: plan.write.length, skipped: plan.skip, forgot: plan.forget };
};

/** spawn 前调一次: 包里有几份就管几份。写不出来只跳过, 绝不让 pane 起不来。 */
export const ensureBundledSkills = (stateDir: string, opts: { force?: boolean } = {}): SkillSyncReport[] =>
  bundledSkillNames().map((name) => {
    try { return materializeSkill(stateDir, name, opts); }
    catch (e) { return { name, mode: "noop" as const, wrote: 0, skipped: [], forgot: [], error: (e as Error).message }; }
  });

// ── 用户命令用: remove / pin ────────────────────────────────────────────

const patchStamp = (stateDir: string, name: string, patch: (s: SkillStamp) => SkillStamp | undefined): void => {
  const stamps = readStamps(stateDir);
  const cur = stamps[name] ?? { version: "", sig: "", files: {} };
  const next = patch(cur);
  const out = { ...stamps };
  if (next) out[name] = next; else delete out[name];
  writeStamps(stateDir, out);
};

export const removeSkill = (stateDir: string, name: string): void => {
  rmSync(skillDirOf(stateDir, name), { recursive: true, force: true });
  patchStamp(stateDir, name, (s) => ({ version: s.version, sig: s.sig, files: s.files, removed: true }));
};

/** 清掉 pinned / removed 两个「别管我」标记 (人显式 install 时)。 */
export const clearSkillHold = (stateDir: string, name: string): void => {
  // 没有 stamp 就别造一个: 造了会让首见的「收编」变成 noop, 也凭空宣称所有权。
  if (!readStamps(stateDir)[name]) return;
  patchStamp(stateDir, name, (s) => ({ version: s.version, sig: s.sig, files: s.files }));
};

export const pinSkill = (stateDir: string, name: string, on: boolean): void => {
  patchStamp(stateDir, name, (s) => {
    const { pinned: _drop, ...rest } = s;
    return on ? { ...rest, pinned: true } : rest;
  });
};
