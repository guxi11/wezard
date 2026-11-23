# 修复: 同一个管家类在不同 room 里要用不同实例

> 人的原话 (2026-11-23, wezard dev): 「检查下，为什么在channel room里绑定的host也是 OliveBrown-1 ？
> 按理说不同的room要用不同的实例」
> 上级: .AliceLane。任务文件以本文件为准, 做完勾选文末进度并逐文件提交。

## 现场 (已核实)

- 频道 room `chat:CiBoUO2pR77WWMsfRHOqEzQG1GvEzM46f5+rbC3tIFzfWhAB` 走完 guide 绑定后:
  - config `wrc.channel.steward["CiBoUO2p…"] = "OliveBrown-1"` —— 绑的是**实例名**;
  - 频道 room 里被 join 进来当 host 的就是 OliveBrown-1 本尊
    (uid `wf5a7f2b4b8ce`, target = `chat:wrkSFfCgAAfLILAIdQoQ8kmvJbb3PIvw` = dhtpm 群)。
- 对照正确形态: dhtpm 群自己的绑定存的是**类名** `chatPolicy[...fLILA...].steward = "OliveBrown"`;
  OliveBrown-1 是这个类在 dhtpm 群里的化身 (identity = 类 id, ordinal 1)。
- 类表: `~/.wezard/state/classes.json` 有 OliveBrown (role steward, workspace dhtpm)。

## 根因

- `daemon/steward.ts` `stewardsAt` 的类分支: 目录命中类时返回 `anchorOf(store, cls.id)`
  —— **锚点实例** (OliveBrown-1), 不是类。
- `daemon/onboarding.ts` `judgeOnboarding` 的 bind-existing 就取 `hits[0].name` / `hits[0].target`
  —— 绑了实例名, target 还是**别的 room 的化身 target**。
- `applyOnboarding` 原样落 `OnboardingBound`, `settleBoundChannel` (daemon/index.ts) 直接
  `hostJoinOps` 把这个跨 room target 拉进频道 room 当 host。
- 绑定语义本该是类名: `applyOnboarding` 新建分支注释明写「绑定写**类名**」,
  `rewriteStewardBindings` 迁移也是把绑定全改类名。这次是 bind-existing 类命中漏了。
- 该 bug 群引导同样存在 (新群给 dhtpm 目录也会绑 OliveBrown-1 并把 dhtpm 的化身拉进来), 不是频道独有。

## 修法

1. **judgeOnboarding (onboarding.ts)**: 目录命中是**类**时, bind-existing 绑**类名**
   (`cls.name`), 不再绑锚点实例名; verdict / OnboardingBound 要能表达「这是个类」
   (classId), target 不再指别的 room 的化身 —— 本 room 化身在落定时解析。
   `names` 分支同修: 人给类名 → 绑类名; 人给实例名且它是别的 room 的化身 → 落到它的类名
   (符合人「不同 room 不同实例」的意思, 不要绑跨 room 实例)。
2. **落定解析 (daemon/index.ts guideSettleRoom / settleBoundChannel, 或其上游统一做)**:
   绑定是类时, host / 交接目标是**本 room 的化身**:
   - 已有 (identityOf(rec) == classId 且 baseOfKey(rec.target) == 本 room base) → 用它;
   - 没有 → fresh spawn `<类名>-<allocOrdinal>`:
     target = keyOf(本 room base, tag), upsert (kind steward, identity classId, ordinal, workspace = cls.workspace),
     newSession, 再 hostJoin / handover。群路径与频道路径都必须走这条解析;
     任何 room 不许再把别的 room 的 target join 进来。
   - stewardRoute 的 open() 已是这个语义 (fresh.classId + instanceName + allocOrdinal),
     尽量复用, 不要另写一套。
3. **既有错误绑定纠正 (幂等, 过 daemon 机制, 不许 daemon 活着时手改 room JSONL)**:
   - config: `wrc.channel.steward["CiBoUO2p…"]: "OliveBrown-1" → "OliveBrown"`;
   - 频道 room: OliveBrown-1 请出 (leave op); 建 OliveBrown-2
     (target = 频道 base, ordinal 2, identity = OliveBrown 类 id) 并作为 host 入座;
   - dhtpm 群保持 OliveBrown-1 原样不动。
   - 一次性迁移脚本 (闸门文件模式, 参照 classes.apply) 或 boot/settle 自愈均可, 你选;
     必须幂等、可复跑、有日志。
4. **单测**:
   - 目录命中类 → 绑类名 (不是实例名);
   - 第二个 room 绑同一个类 → 出**不同**实例序号 (不重复 spawn 本 room 已有的);
   - 人给实例名 → 落类名;
   - 纠正逻辑幂等 (跑两遍 = 第二遍无操作)。

## 规矩 (同前)

- typecheck + build + 相关单测全绿; 逐文件 pathspec commit; 共享工作树只 stage 自己的文件。
- 完成后 build → reload daemon → kickstart com.wezard.svr → chat_reply 交代
  (commits / 测试 / 取舍遗留)。
- 验收 (上级亲验): rolepage 核频道 room host = OliveBrown-2、成员无 OliveBrown-1;
  dhtpm 群 host 仍 OliveBrown-1; 之后人继续三条消息真机验收。

## 进度 (执行者自维护)

- [ ] ① judgeOnboarding 类命中绑类名 (names 分支同修)
- [ ] ② 落定解析: 本 room 化身, 无则 fresh spawn (群 + 频道两路)
- [ ] ③ 既有错误绑定纠正 (幂等)
- [ ] ④ 单测四组
- [ ] ⑤ typecheck + build + reload + kickstart + 交代
