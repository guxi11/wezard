// CLI 本地状态消息 —— CLI 自己改了会话/账号状态后的那句确认, 以及它自己的重试提示。
// 这些是 CLI 的操作痕迹, 不是聊天内容: 镜像层见到它们整条丢弃 (不进聊天, 也不进详情页)。
//
// 各家各版本的原文 (均取自真机转录):
//   claude 2.1   "Set model to Opus 4.6" / "Kept model as X" / "Set effort level to X"
//   codebuddy    "Switched this session to Claude-Sonnet-5." /
//                "Switched model to Claude-Opus-5.5. Model reasoning effort set to \`high\`." /
//                "Model reasoning effort set to \`low\`."
//   /login       "Login successful"
//   codebuddy    "Model returned no valid response. Retrying automatically..."
// 认的是句子开头的谓语, 不是某一条完整文案 —— 新版本换个说法还落在同一类里。
const RECEIPT_HEADS: readonly RegExp[] = [
  /^(?:Set|Kept|Switch(?:ed)?) model\b/iu,
  /^Switched (?:this session )?to \S/iu,
  /^(?:Set|Kept) effort\b/iu,
  /^Model reasoning effort set to \S/iu,
  /^Login successful\b/iu,
];

// 重试提示: 重试成功时它是纯噪声, 重试失败时 CLI 会再写一句真失败 ("Retry later…")。
const RETRY_NOTICE_RE = /^Model returned no valid response\. Retrying automatically/u;

/** 一段本地命令回执是不是纯状态确认 (整段都是这类句子)。 */
export const isCliStateReceipt = (text: string): boolean => {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => RECEIPT_HEADS.some((re) => re.test(l)));
};

/** CLI 自己的自动重试提示 (不是模型的发言)。 */
export const isCliRetryNotice = (text: string): boolean => RETRY_NOTICE_RE.test(text.trim());
