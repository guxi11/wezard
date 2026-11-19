# 单测基线 (cf3e0b3 = origin/v3, room 分出点)

跑法: `/tmp/room-run-tests.sh <worktree> <out>` —— 先 `npm run build`, 每个 tests/*.test.{ts,mjs} 用 `npx tsx` 单独跑 (180s 闹钟), HOME/WEZARD_HOME 指向 /tmp/room-test-home, 跳过 *regress* 与 tmux-buffer-live (live, 要真 pane)。
结果 (2026-11-19): 108 个里 91 绿, 16 红, 1 跳过。下列 16 个在**分出点就红**, room-model 上它们仍红不算回归; 其余任何红都算本次引入。

| 测试 | 分出点上的红因 |
|---|---|
| backend-tiers | config-api 无 pickTier 导出 (测试漂移) |
| codex-approval / codex-backend / codex-hooks / codex-session | 本机无 codex 可执行 (环境) |
| inbound-default-backend | bridge.getCwd 不存在 (闭包抽取漂移) |
| maintenance-scheduler | client 未定义 (闭包抽取漂移) |
| model-tier-migration | shared/model-tier-migration.js 已删 |
| receipt-inbox / receipt-timing | daemon/receipts.js 已删 |
| slash-replies | bridge.dispatch 不存在 (闭包抽取漂移) |
| steward-guard | REPL 非读 Bash 配额断言 (rs[4] 不含 dispatch) |
| answer-transfer-format / answer-transfer-mirror | 源码切片锚点找不到 (start/end) |
| workflow-transport | queuedCopies 未定义 (闭包抽取漂移) |

核对: `backend-tiers.test.ts codex-approval.test.ts codex-backend.test.ts codex-hooks.test.ts codex-session.test.ts inbound-default-backend.test.ts maintenance-scheduler.test.ts model-tier-migration.test.ts receipt-inbox.test.ts receipt-timing.test.ts slash-replies.test.ts steward-guard.test.ts answer-transfer-format.test.mjs answer-transfer-mirror.test.mjs workflow-transport.test.mjs`
