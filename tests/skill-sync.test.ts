// 内置 skill 的合并规则: 首次装 / 收编 (内容全同) / 用户自己的 (foreign) / 早退 /
// 逐文件合并 (改过的不覆盖, 删过的不复活, 上游新增照装, 上游删掉的不连坐) /
// removed / pinned / --force, 以及落盘一层 (install → current → 删目录 → 复活)。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundleRoot, bundledSkillNames, clearSkillHold, materializeSkill, packageVersion, pinSkill, planSkillMerge, readStamps,
  removeSkill, scanSkillDir, signatureOf, skillDirOf, type SkillFile,
} from "../shared/skill-sync.js";

const f = (rel: string, sha: string): SkillFile => ({ rel, sha });
const bundled = [f("SKILL.md", "a1"), f("references/x.md", "b1")];
const sig = signatureOf(bundled);
const V = "9.9.9";
const base = { version: V, sig, bundled };
const stampOf = (files: Record<string, string>, extra: object = {}) => ({ version: V, sig: "old", files, ...extra });

// 首次: 目录不存在, 无 stamp → 全量写
{
  const p = planSkillMerge({ ...base, installed: undefined, stamp: undefined });
  assert.equal(p.mode, "install");
  assert.deepEqual(p.write, ["SKILL.md", "references/x.md"]);
  assert.equal(p.stamp?.sig, sig);
}

// 收编: 无 stamp 但内容与包内逐文件相同 → 不动盘, 只写 stamp
{
  const p = planSkillMerge({ ...base, installed: [...bundled], stamp: undefined });
  assert.equal(p.mode, "adopt");
  assert.deepEqual(p.write, []);
  assert.equal(p.stamp?.version, V);
}

// 用户自己的: 无 stamp 且内容不同 → 一个字节不动, 也不写 stamp (否则下次就成我们的了)
{
  const p = planSkillMerge({ ...base, installed: [f("SKILL.md", "mine")], stamp: undefined });
  assert.equal(p.mode, "foreign");
  assert.deepEqual(p.write, []);
  assert.equal(p.stamp, undefined);
  const forced = planSkillMerge({ ...base, installed: [f("SKILL.md", "mine")], stamp: undefined, force: true });
  assert.equal(forced.mode, "install");
}

// 早退: version + sig 都没变
{
  const p = planSkillMerge({ ...base, installed: [...bundled], stamp: { version: V, sig, files: {} } });
  assert.equal(p.mode, "current");
  assert.deepEqual(p.write, []);
}

// 逐文件合并
{
  const stamp = stampOf({ "SKILL.md": "a1", "references/x.md": "b1", "old.md": "o1" });
  const installed = [
    f("SKILL.md", "a1"),                     // 我们写的, 用户没动 → 该更新到 a2
    f("references/x.md", "user"),            // 用户改过 → 不覆盖
    f("old.md", "o1"),                       // 上游已删 → 盘上保留, stamp 里忘掉
    f("mine.md", "m1"),                      // 用户自建 → 不管
  ];
  const nextBundled = [f("SKILL.md", "a2"), f("references/x.md", "b2"), f("new.md", "n1")];
  const p = planSkillMerge({
    version: "9.9.10", sig: signatureOf(nextBundled), bundled: nextBundled, installed, stamp,
  });
  assert.equal(p.mode, "update");
  assert.deepEqual(p.write.sort(), ["SKILL.md", "new.md"]);   // 改过的 + 上游新增
  assert.deepEqual(p.skip, ["references/x.md"]);
  assert.deepEqual(p.forget, ["old.md"]);
  assert.equal(p.stamp?.files["references/x.md"], "b2");
}

// 用户删掉的文件不复活; 本地没有 → 只有「我们从没写过」才是新增
{
  const stamp = stampOf({ "SKILL.md": "a1", "references/x.md": "b1" });
  const p = planSkillMerge({
    ...base, sig: "changed", installed: [f("SKILL.md", "zzz")], stamp,
  });
  assert.deepEqual(p.skip.sort(), ["SKILL.md", "references/x.md"]);
  assert.deepEqual(p.write, []);
  assert.equal(p.mode, "noop");
}

// gone / held
{
  const gone = planSkillMerge({ ...base, installed: undefined, stamp: stampOf({ "SKILL.md": "a1" }) });
  assert.equal(gone.mode, "gone");
  assert.equal(gone.stamp?.removed, true);
  assert.equal(planSkillMerge({ ...base, installed: undefined, stamp: stampOf({}, { pinned: true }) }).mode, "held");
  assert.equal(planSkillMerge({ ...base, installed: undefined, stamp: stampOf({}, { removed: true }) }).mode, "held");
  assert.equal(planSkillMerge({ ...base, installed: undefined, stamp: stampOf({}, { pinned: true }), force: true }).mode, "install");
  // revive = 人显式 install (标记已由 clearSkillHold 清掉): 目录被删也装回来, 不记 gone
  assert.equal(planSkillMerge({ ...base, installed: undefined, stamp: stampOf({ "SKILL.md": "a1" }) }).mode, "gone");
  assert.equal(planSkillMerge({ ...base, installed: undefined, stamp: stampOf({ "SKILL.md": "a1" }), revive: true }).mode, "install");
}

// ── 落盘 ────────────────────────────────────────────────────────────────
const walkForTest = (root: string, prefix = ""): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((d) => {
    const rel = prefix ? prefix + "/" + d.name : d.name;
    return d.isDirectory() ? walkForTest(join(root, d.name), rel) : [rel];
  });

const tmp = mkdtempSync(join(tmpdir(), "wezard-skill-sync-"));
const name = bundledSkillNames()[0];
assert.ok(name, "包内应当有至少一份 skill");
const bundleFiles = scanSkillDir(join(bundleRoot(), name))?.length ?? 0;
assert.ok(bundleFiles > 0);

{
  // 首次: 写全部文件 + stamp
  const r = materializeSkill(tmp, name);
  assert.equal(r.mode, "install");
  assert.equal(r.wrote, bundleFiles);
  assert.ok(existsSync(join(skillDirOf(tmp, name), "SKILL.md")));
  assert.equal(readStamps(tmp)[name]?.version, packageVersion());

  // 再跑一次: 早退
  assert.equal(materializeSkill(tmp, name).mode, "current");

  // 用户改了内容: 版本没变 → 不碰 (早退); --force → 覆盖回来
  const skillMd = join(skillDirOf(tmp, name), "SKILL.md");
  writeFileSync(skillMd, "user edit");
  assert.equal(materializeSkill(tmp, name).mode, "current");
  assert.equal(materializeSkill(tmp, name, { force: true }).mode, "install");
  assert.notEqual(readFileSync(skillMd, "utf8"), "user edit");

  // 用户删掉整个目录 → gone, 记 removed; 再跑 → held, 不复活
  rmSync(skillDirOf(tmp, name), { recursive: true, force: true });
  assert.equal(materializeSkill(tmp, name).mode, "gone");
  assert.equal(readStamps(tmp)[name]?.removed, true);
  assert.equal(materializeSkill(tmp, name).mode, "held");
  assert.equal(existsSync(skillDirOf(tmp, name)), false);

  // 人显式 install → 清标记并装回来
  clearSkillHold(tmp, name);
  const back = materializeSkill(tmp, name, { revive: true });
  assert.equal(back.mode, "install");
  assert.ok(existsSync(skillMd));

  // pin 之后不再改; unpin 恢复 (version/sig 未变时早退不看单文件, 所以整目录删)
  pinSkill(tmp, name, true);
  rmSync(skillDirOf(tmp, name), { recursive: true, force: true });
  assert.equal(materializeSkill(tmp, name).mode, "held");
  pinSkill(tmp, name, false);
  assert.equal(materializeSkill(tmp, name, { revive: true }).mode, "install");
  assert.ok(existsSync(skillMd));

  // remove: 目录消失 + 标记 removed
  removeSkill(tmp, name);
  assert.equal(existsSync(skillDirOf(tmp, name)), false);
  assert.equal(readStamps(tmp)[name]?.removed, true);
}

// 收编: 盘上已是同一份 (手拷 / 别的工具装的) 但没有 stamp → 只写 stamp, 不动盘
{
  const tmp2 = mkdtempSync(join(tmpdir(), "wezard-skill-adopt-"));
  const dest = skillDirOf(tmp2, name);
  mkdirSync(dest, { recursive: true });
  for (const rel of walkForTest(join(bundleRoot(), name))) {
    mkdirSync(join(dest, rel, ".."), { recursive: true });
    writeFileSync(join(dest, rel), readFileSync(join(bundleRoot(), name, rel)));
  }
  const r = materializeSkill(tmp2, name);
  assert.equal(r.mode, "adopt", "内容全同应被收编");
  assert.equal(r.wrote, 0);
  assert.equal(readStamps(tmp2)[name]?.version, packageVersion());
  rmSync(tmp2, { recursive: true, force: true });
}

// stamp 损坏 → 当作没有
{
  mkdirSync(join(tmp, "skills"), { recursive: true });
  writeFileSync(join(tmp, "skills", ".wezard-skills.json"), "{ not json");
  assert.deepEqual(readStamps(tmp), {});
}

rmSync(tmp, { recursive: true, force: true });
console.log("skill-sync ok");
