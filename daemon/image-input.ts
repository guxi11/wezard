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

/** Confirm a ready composer and one new attachment; never blindly repeat C-v. */
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
  const after = await wait((box) => imageCount(box) === imageCount(before) + 1);
  return after && o.valid()
    ? { ok: true }
    : { ok: false, reason: "图片附件未确认，已停止提交文字。请检查 CLI 输入框后重发，避免遗漏或重复附件。" };
};
