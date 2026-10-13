import { sleep } from "../shared/std.js";

type Result = { ok: boolean; reason?: string };
type Composer = { known: boolean; body: string };

// The macOS clipboard is shared by every pane, even when their input locks
// are independent. Hold it until the TUI has consumed the current image.
let clipboardTail: Promise<unknown> = Promise.resolve();
export const withImageClipboard = <T>(run: () => Promise<T>): Promise<T> => {
  const next = clipboardTail.then(run, run);
  clipboardTail = next.catch(() => undefined);
  return next;
};

const imageCount = (box: Composer): number =>
  [...box.body.matchAll(/\[Image #\d+\]/gu)].length;

/** Confirm one new attachment, retrying three times without blindly repeating C-v. */
export const pasteVerifiedImage = async (o: {
  read: () => Promise<Composer>;
  paste: () => Promise<Result>;
  valid: () => boolean;
  timeoutMs?: number;
}): Promise<Result> => {
  const wait = async (accept: (box: Composer) => boolean): Promise<Composer | undefined> => {
    const deadline = Date.now() + (o.timeoutMs ?? 15_000);
    while (o.valid() && Date.now() < deadline) {
      const box = await o.read();
      if (box.known && accept(box)) return box;
      await sleep(100);
    }
    return undefined;
  };
  const before = await wait(() => true);
  if (!before || !o.valid()) return { ok: false, reason: "图片未提交：未确认 CLI 输入框就绪或注入已撤回，请重发。" };
  const pasted = await o.paste();
  if (!pasted.ok) return pasted;
  const attached = (box: Composer): boolean => box.known && imageCount(box) === imageCount(before) + 1;
  const verify = async (retries: number): Promise<Result> => {
    const after = await wait(attached);
    if (after && o.valid()) return { ok: true };
    if (!o.valid()) return { ok: false, reason: "图片未提交：注入已撤回，请检查 CLI 输入框。" };
    if (!retries) return { ok: false, reason: "图片附件经 3 次重试仍未确认，已停止提交文字。请检查 CLI 输入框后重发，避免遗漏或重复附件。" };

    // A late render may have landed after the poll timed out. Recheck before
    // C-v; an unknown or changed composer only permits another confirmation.
    const current = await o.read();
    if (!o.valid()) return { ok: false, reason: "图片未提交：注入已撤回，请检查 CLI 输入框。" };
    if (attached(current)) return { ok: true };
    if (current.known && current.body === before.body) {
      const retry = await o.paste();
      if (!retry.ok) return retry;
    }
    return verify(retries - 1);
  };
  return verify(3);
};
