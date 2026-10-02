#!/usr/bin/env node
// 只提交自己的改动 —— 给多个 wizard 共用一棵工作树、一份 .git/index 的仓库用。
// 共享 index 随时被别人 add / commit, 工作树里混着别人的 hunk, 所以这里从不碰它们:
// 在私有 index 上从 HEAD 拼出提交, 用 update-ref 对 HEAD 做 CAS (别人中途提交 → 重放到新 HEAD),
// 落地后只把共享 index 里仍等于旧 HEAD 的那几项同步成新 blob, 工作树一字不动。
//
// 用法:
//   node scripts/commit-own.mjs -m <msg> [-m <段>…] <path>…        这些文件的工作树全文 = 我的改动 (含新建 / 删除)
//   node scripts/commit-own.mjs -m <msg> --patch <file|->            文件里混着别人的 hunk: 交一份只含自己 hunk 的补丁
//   -F <file> 从文件读提交信息 · --no-check 跳过 tsc · --dry-run 只拼树、跑检查, 不落 HEAD
//
// 补丁要对 HEAD、带上下文 (`git diff HEAD -- f` 剪掉别人的 hunk; 别用 -U0: 纯插入会落错位置且不报错)。
// 同一个 hunk 里混着别人的行就手拆 —— 这一步脚本替不了你。
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const TRIES = 5;

// ── 参数 ──────────────────────────────────────────────────────────
const parse = ([a, ...rest], o = { msg: [], paths: [], check: true, dry: false }) => {
  if (a === undefined) return o;
  const [v, ...after] = rest;
  return a === "-m" ? parse(after, { ...o, msg: [...o.msg, v] })
    : a === "-F" ? parse(after, { ...o, msg: [...o.msg, readFileSync(v, "utf8").trimEnd()] })
    : a === "--patch" ? parse(after, { ...o, patch: readFileSync(v === "-" ? 0 : v, "utf8") })
    : a === "--no-check" ? parse(rest, { ...o, check: false })
    : a === "--dry-run" ? parse(rest, { ...o, dry: true })
    : parse(rest, { ...o, paths: [...o.paths, a] });
};

// ── git ───────────────────────────────────────────────────────────
const git = (args, { index, input } = {}) =>
  execFileSync("git", args, {
    cwd: ROOT, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    env: index ? { ...process.env, GIT_INDEX_FILE: index } : process.env,
  }).trim();
const tryGit = (args, opts) => { try { return git(args, opts); } catch { return null; } };

/** `<mode> <blob>` of a path in a tree-ish, or null when absent. */
const entryAt = (rev, p) => tryGit(["ls-tree", rev, "--", p])?.split(/\s+/).slice(0, 3).filter((_, i) => i !== 1).join(" ") || null;
/** `<mode> <blob>` of a path in the shared index (stage 0), or null when absent. */
const entryInIndex = (p) => tryGit(["ls-files", "-s", "--", p])?.split(/\s+/).slice(0, 2).join(" ") || null;

// ── 在私有 index 上拼树 ────────────────────────────────────────────
const stagePath = (index) => (p) => {
  if (!existsSync(join(ROOT, p))) return git(["update-index", "--force-remove", "--", p], { index });
  const blob = git(["hash-object", "-w", "--", p]);
  const mode = statSync(join(ROOT, p)).mode & 0o111 ? "100755" : "100644";
  return git(["update-index", "--add", "--cacheinfo", `${mode},${blob},${p}`], { index });
};

const buildTree = (old, opts) => {
  const index = join(mkdtempSync(join(tmpdir(), "commit-own-")), "index");
  git(["read-tree", old], { index });
  if (opts.patch) git(["apply", "--cached", "--whitespace=nowarn", "-"], { index, input: opts.patch });
  opts.paths.forEach(stagePath(index));
  return git(["write-tree"], { index });
};

// ── 检查: 提交出去的树自己能过 tsc (不是工作树能过) ───────────────────
const typecheck = (tree) => {
  if (!existsSync(join(ROOT, "tsconfig.json"))) return;
  const dir = mkdtempSync(join(tmpdir(), "commit-own-tree-"));
  try {
    execFileSync("sh", ["-c", `git archive ${tree} | tar -x -C "${dir}"`], { cwd: ROOT });
    if (existsSync(join(ROOT, "node_modules"))) symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    execFileSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"], { cwd: dir, stdio: "inherit" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

// ── 落地 ──────────────────────────────────────────────────────────
const changed = (old, neu) => git(["diff-tree", "-r", "--name-only", "--no-renames", old, neu]).split("\n").filter(Boolean);

/** 共享 index 里还停在旧 HEAD 的项 → 新 blob; 别人已经暂存了别的内容的, 不动。 */
const syncSharedIndex = (old, neu, paths) => paths
  .filter((p) => entryInIndex(p) === entryAt(old, p))
  .forEach((p) => {
    const e = entryAt(neu, p);
    e ? git(["update-index", "--add", "--cacheinfo", `${e.replace(" ", ",")},${p}`])
      : git(["update-index", "--force-remove", "--", p]);
  });

/** 提交里有、工作树里却没有的改动 —— 不同步回去, 下一个人一提交就把它抹掉。 */
const missingInWorktree = (old, neu) => changed(old, neu).filter((p) => {
  const d = git(["diff", "--binary", old, neu, "--", p]);
  return d && tryGit(["apply", "--check", "-R", "-"], { input: d + "\n" }) === null;
});

const commit = (opts, attempt = 1) => {
  const old = git(["rev-parse", "HEAD"]);
  const tree = buildTree(old, opts);
  if (tree === git(["rev-parse", `${old}^{tree}`])) return console.log("没有可提交的改动"), 0;
  if (opts.check) typecheck(tree);
  const neu = git(["commit-tree", tree, "-p", old, "-F", "-"], { input: opts.msg.join("\n\n") + "\n" });
  if (opts.dry) return console.log(`dry-run: ${neu.slice(0, 7)} (未落 HEAD)\n${git(["diff", "--stat", old, neu])}`), 0;
  if (tryGit(["update-ref", "HEAD", neu, old]) === null) {
    if (attempt >= TRIES) throw new Error(`HEAD 一直在动, ${TRIES} 次都没落下`);
    console.log(`HEAD 被别人推进了, 重放到新 HEAD (${attempt}/${TRIES})`);
    return commit(opts, attempt + 1);
  }
  syncSharedIndex(old, neu, changed(old, neu));
  console.log(git(["log", "--oneline", "-1", neu]));
  console.log(git(["diff", "--stat", old, neu]));
  const miss = missingInWorktree(old, neu);
  if (miss.length) console.log(`⚠ 工作树不含这次提交的部分内容, 确认后 \`git checkout -- <f>\` 同步回 HEAD: ${miss.join(" ")}`);
  return 0;
};

const opts = parse(process.argv.slice(2));
if (!opts.msg.length || (!opts.patch && !opts.paths.length)) {
  console.error("用法: commit-own.mjs -m <msg> (<path>… | --patch <file|->) [--no-check] [--dry-run]");
  process.exit(2);
}
try { process.exit(commit(opts)); }
catch (e) { console.error(e.stderr?.toString() || e.message); process.exit(1); }
