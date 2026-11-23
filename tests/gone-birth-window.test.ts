// 单测: 没有绑定时 injectText 的判词 —— 出生窗口 (newSession / cloneSession 还没 attach) 里
// 不能报 gone。现场 (2026-11-23 新建频道): guide 先落人话再起 pane, 泵在这几百毫秒里探到
// "no mirror attached" 并把它当 gone, 于是给提问者写了一条「没有会话 (已被结束)」系统行,
// 还进群了; guide 随后正常起来并提问 —— 纯误报。
// 运行: npx tsx tests/gone-birth-window.test.ts
import assert from "node:assert/strict";
import { unattachedVerdict } from "../daemon/mirror-bridge.js";

// 真没绑定、也不在出生: gone (stop_wizard end / /kill 之后要有人重生或改派)。
assert.deepEqual(unattachedVerdict(false, false), {
  ok: false, retryable: true, reason: "no mirror attached for target", gone: true,
});

// 出生窗口: 只是还没 attach, 稍后就能投 —— 可重试, 不是 gone。
const birth = unattachedVerdict(false, true);
assert.equal(birth.ok, false);
assert.equal(birth.retryable, true);
assert.equal("gone" in birth, false, "出生窗口里不许报 gone");

// 绑定只剩在 store 里 (restore 没成): 可重试, 也不是 gone (老行为, 不能被这刀改掉)。
assert.equal("gone" in unattachedVerdict(true, false), false, "有持久绑定 → 不报 gone");

console.log("gone-birth-window: ok");
