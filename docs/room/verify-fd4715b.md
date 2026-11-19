# room-model @ fd4715b 收口验证

- 工作区: `/Users/zyy/develop/Guxi11/cc-wecom-room-verify` (分支 `room-verify`, = room-model @ fd4715b), 只验证不改源码。
- 依赖: worktree 无 node_modules, 用 `ln -s ../cc-wecom-room/node_modules` (两处 package.json 逐字节相同); node v20.19.6。
- `npm run build` 成功 (tsc + chmod, 退出 0); `npx tsc --noEmit -p .` 退出 0、日志 0 行。
- 跑法: `/tmp/room-run-tests.sh <worktree> /tmp/room-verify-tests.out` (HOME/WEZARD_HOME = /tmp/room-test-home, 每例 180s 闹钟, 日志 /tmp/room-test-logs/cc-wecom-room-verify-*.log)。

## ① 全量单测对照基线

```
$ grep -c . /tmp/room-verify-tests.out   → 111 行 (110 例 + DONE)
PASS 72 · FAIL 37 · SKIP 1
```

- 跳过 1 例: `tmux-buffer-live.test.ts` (基线也是这 1 例, 无新增 SKIP)。
- 基线 (`docs/room/test-baseline.md`) 说 16 红, 但表里只点了 15 个名字 (codex 四条合一行); 现跑 37 红。
- **与基线重合的 14 个**: backend-tiers / codex-backend / codex-hooks / codex-session / inbound-default-backend / maintenance-scheduler / model-tier-migration / receipt-inbox / receipt-timing / slash-replies / steward-guard / answer-transfer-format / answer-transfer-mirror / workflow-transport —— 均按基线红因复现, 不算回归。
  - `codex-approval` 基建点为红, 现在 **PASS** (改善, 无需处理)。
- **新增红 23 个**: 20 个是把 room 系列已删模块 import 着 (旧语义被删, 测试本身没删), 3 个是真断言不一致 (下表 II)。按「其余任何 FAIL = 回归」的判据全部计入回归。

### I. 旧语义被删 (import 了已删模块) — 20 个

按缺失模块分组; 每组的「第一处异常」都是同一个 ERR_MODULE_NOT_FOUND, 路径不同。

| 缺失模块 | 测试 | 第一处异常 |
|---|---|---|
| `daemon/router.js` | progress-receipt / receipt-unrecognized / result-input-coverage / router-core-source / strict-final / wizard-names / wizard-identity-migration | `code: 'ERR_MODULE_NOT_FOUND', url: '…/daemon/router.js'` |
| `daemon/message-events.js` | merged-envelope / message-events-recovery / message-reason-cap / strict-outbound | `ERR_MODULE_NOT_FOUND … /daemon/message-events.js` |
| `daemon/idle-nudge.js` | idle-nudge / strict-delivery-nudge / strict-obligation | `ERR_MODULE_NOT_FOUND … /daemon/idle-nudge.js` |
| `daemon/members.js` | class-routing / strict-members | `ERR_MODULE_NOT_FOUND … /daemon/members.js` |
| `daemon/chat-records.js` | chat-record | `ERR_MODULE_NOT_FOUND … /daemon/chat-records.js` |
| `daemon/strict-gate.js` | strict-chat | `ERR_MODULE_NOT_FOUND … /daemon/strict-gate.js` |
| `daemon/strict-switch.js` | strict-switch | `ERR_MODULE_NOT_FOUND … /daemon/strict-switch.js` |
| `daemon/chat-seen.js` 缺导出 | strict-default | `SyntaxError: The requested module '../daemon/chat-seen.js' does not provide an export named 'speechDefaultOf'` |

原因判断: **旧语义被删**。`git diff cf3e0b3..HEAD --stat` 明确删掉了 router / message-events / idle-nudge / members / chat-records / strict-gate / strict-switch, 但这些测试文件仍在树里 (本轮只删了 chat-log-key / handoff-carry-from / role-participants / strict-detail / strict-read / wizard-mark 六个)。三项被改过的 (chat-record 9 行 / result-input-coverage 6 行 / strict-delivery-nudge 4 行) 只改了一半, 仍 import 旧模块。不属于行为回归, 但按判据计红: **切换前应把这 20 个测试一并删除或改写成 room 口径**, 否则 `npx tsx tests/*.test.ts` 恒为 37 红, 之后的真回归会被淹没。

### II. 真断言不一致 — 3 个

**1. `class-migration.test.ts` — 迁移备份不再是原文件原样字节**

```
AssertionError [ERR_ASSERTION]: 备份是原文件的原样字节 (tests/class-migration.test.ts:86)
+ actual - expected
+   '    "workspace": "/tmp/ws/",\n'
+   '    "uid": "wa68507e9d5cb"\n'
-   '    "workspace": "/tmp/ws/"\n'
```

原因: **本次引入 (真问题)**。`daemon/wizard.ts:247` 的 uid 回填 (`12e7ef4` 引入) 在 `loadWizardStore` 里对每条缺 uid 的记录 `db.set()` 写穿, 于是「load → 备份」之间 wizards.json 已经被改写; `migrateClasses` 随后做的 `.pre-classes.bak` 不再是原样字节。这正是人在回退时要拿的那份保险 —— 备份失真比少一个字段更值得修, 建议回填改成延迟到首次显式写盘, 或在迁移时先读原文件字节再 load。

**2. `onboarding.test.ts` — 在途群豁免失效 (旧 speech 键仍有语义)**

```
AssertionError: 在途群按 implicit 出站 (引导要能说话) (tests/onboarding.test.ts:237)
+ 'strict'
- 'implicit'
```

原因: **接线遗留 (真问题)**。`ChatPolicy` 现在是 `.passthrough()` (shared/config.ts:412), 所以 `chatPolicyOf` 会把盘上残留的 `speech: "strict"` 原样带出来; 界定「在途群按 implicit」的那段判定随旧 schema 一起没了。这不是测试过时 —— 老配置没删的情况下, 引导化身仍会被当严格群处理。

**3. `strict-new-ack.test.ts` — /clear 确认少了系统前缀**

```
AssertionError: 严格群 /clear 确认带系统前缀 (tests/strict-new-ack.test.ts:155)
  [ + 'cleared' - '[wezard] cleared' ]
```

原因: **旧语义被删, 但删得只做了一半**。`daemon/mirror-bridge.ts:8324` 已统一成 `sendStandalone(a, "cleared")` (没有门就不需要前缀), 而 `daemon/inbound.ts:845` 的 `/new` 仍按 `isStrictChat(who)` 决定是否加 `[wezard] created` —— 同一件事两条口径。根因与 II-2 同一个残留 `.speech` 读点, 建议一起处理: 要么彻底删掉 isStrictChat, 要么把前缀统一成 room system 行的写法。

### wiring.md §D 必须绿的 10 个

```
PASS room-duty        PASS room-leave-cancel  PASS room-interrupt   PASS room-hub
PASS room-migrate     PASS room-view          PASS room-view-api   PASS charter
PASS tool-hints       PASS room-watchdog
```

10/10 全绿 (listed 9 + room-watchdog)。

## ② 三条 grep 零命中复跑 (仓库根, 原样)

```
$ git grep -nE "from \"\.{1,2}/(daemon/)?(router|message-events|strict-gate|strict-switch|members|chat-records|idle-nudge|pending-items|dispatch)\.js\"" -- daemon shared mcp svr cli
(无输出)  EXIT=1

$ git grep -nE "topOnly|strictSayGate|strictSpeechOf|speech: *\"(strict|implicit)\"" -- daemon shared mcp svr cli
(无输出)  EXIT=1

$ git grep -nE "receipts\.json|obligations\.json|idle-nudges\.json|strict-delivery-notices\.json|message-events\.json|routes\.jsonl" -- daemon shared mcp svr cli | grep -v migrate
(无输出)  EXIT=1
```

去 `grep -v migrate` 之后的原始命中 10 行, 全部落在迁移专用模块 (`cli/migrate-rooms.ts`、`shared/legacy-routes.ts`、`shared/room-migrate.ts`), 行文里都带 "migrate"/"迁移" 字样, 所以过滤器把整块都吃掉了 —— 运行时没有读写这些文件的路径。

**附注 (grep 词表覆盖不到的两类残留)**:

1. `chatPolicyOf(...).speech` 的读点还在: `daemon/inbound.ts:660` (`isStrictChat`)、`daemon/channel.ts:553` (`strictTopicOf`), 三处调用点 `inbound.ts:845` / `channel.ts:615,631,713`。因为 ChatPolicy 是 `.passthrough()`, 旧键留在 config 里就仍然生效 —— 这正是 ①-II 的 2 和 3。grep 词表里的 `speech: "strict"` 抓不到 `.speech === "strict"` 这种读法, 建议下一轮把 `speech` 整词加进 grep。
2. 契约 §7 写的「zod 遇到旧键忽略并 warn」没有落地: 全仓没有针对 retired chatPolicy 键的 warn (只在 shared/config.ts:412 一行注释里承诺)。

## ③ CHANGELOG [Unreleased] → BREAKING

在 `### BREAKING` 现有 `/name 下线` 条目之后追加 4 条 (中文、加粗领句、写清用户可感知变化与迁移路径), 覆盖: room 账本成为唯一沟通事实 (旧工具退役 / 终句零语义 / 必须 /new) · 严格群整体删除 (topOnly / speech 移出 schema, 旧键经 config-strip 删) · 旧状态文件冻结 + migrate-rooms 一次性导入 · 轮终事件驱动 + 全局看门狗 (pane 消失 = 实例结束, 忙只 warn)。version 未动 (2.9.0), 没加版本标题。事实取自 `docs/room/contract.md` §1-§7、`docs/room/cutover.md`、`shared/config.ts` (rooms.watchdog)、`daemon/room-watchdog.ts`、`cli/migrate-rooms.ts`; 拿不准的两处 (旧键 warn 未实现、残留 `.speech` 读点) 以 **TODO (切换前核对)** 标在条目里, 没有编造。

## 附: 顺手看到的、超出三节口径的两处 (未改动, 只记录)

1. **`pending_items` 工具面悬空**: `mcp/tools.ts:965` 仍注册该工具 (POST `/pending`), 而 `daemon/index.ts:1900` 写着「pending_items 已退役 (wiring C)」并且路由已删; `daemon/wizard.ts:1089` 的宪章仍在教 wizard 用它。现状是「模型照着宪章调用 → 404」。
2. **/help 仍在教已退役的命令**: `daemon/inbound.ts:224` 列着 `/owed`、`:225` 列着 `/strict [apply]` (两者的处理分支都随 strict-switch 删除), `:229` 还留着「工单的派活与回执不进群」这句旧口径, 另 `:171` 一行 /owed 的注释。属于 QuinnFord 那份旧引用清单的同类, 记在这里备查。
3. **契约 §7「每个绑定 pane 标为待 /new」依赖一个没人创建的一次性标记** `state/rooms-cutover-new.flag` (`daemon/index.ts:1307-1326`), 而 cutover.md 第 9 步写「不用手动做」。切换时若没人 touch 这个文件, 老会话不会被 /new, 会拿着旧工具面继续跑。
## 复核更正 (LeoAdams, 2026-11-19, 对照 room-model 源码)

- ② 附注 2「契约 §7 旧键 warn 没有落地」**不成立**: warn 在 daemon/index.ts main() 开头 (loadConfig 之后), 键名拆写成 `"top" + "Only"` / `"spe" + "ech"` 以避开 grep, 所以搜不到字面量。
- 附 1「pending_items 工具面悬空 → 404」**不成立**: `POST /pending` 在 daemon/index.ts 按 room open duty 重写过 (约 3056 行), 1900 行那句注释说的是旧台账退役。工具可用。
- 附 3 (rooms-cutover-new.flag 没人创建) **成立**, 已进切换清单 7b; 另查出该段在 pane 忙时 /new 失败也会删标记, 归入修复单。
- 复核额外查出 (报告未覆盖, 归入修复单): 看门狗 `listPanes` 把 tmux 输出按字面 `"\\n"` (反斜杠 + n) 切分 —— 多 pane 时永远匹配不上, 所有 stale 持有者都会被判「pane 消失」并取消 duty; tmux 调用失败返回空表同样会全员误判; activity 初值为 0, 重启后首轮扫描所有持有者都算 stale。单测用假 listPanes 直接给数组, 覆盖不到解析。
