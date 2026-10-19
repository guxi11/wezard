// spawn 读屏撞上「认不出的启动确认框」(startupConfirmation 命中、但既不是可代按的
// 目录信任框、也判不出别的) 时, 发给人的企微通知的正文与去重指纹。
// 纯函数: 时机、频控、发送都在 spawn-tmux / daemon 侧, 这里只负责「说什么」——
// 收件人 (wizard / pane / cwd) 必须一眼可认, 屏上原文进摘要, 行动指令明确到可以照抄。

export interface StartupNoticeInput {
  /** 人认识的窗口名 (tmux 窗口 label, 与 /sessions 里看到的一致)。 */
  who: string;
  /** tmux pane id, 如 `%12`。 */
  pane: string;
  /** tmux session 名 (tmuxPrefix), attach 指引用。 */
  tmuxSession: string;
  cwd: string;
  /** capture-pane 原始屏 (带 ANSI)。 */
  screen: string;
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, "");

const stripBorders = (l: string): string => l.replace(/^\s*[│┃|]/u, "").replace(/\s*[│┃|]\s*$/u, "");

export interface StartupNotice {
  /** 屏幕指纹: 调用方按「同一 pane 同一指纹只发一次」去重, 形状变了才发新的一条。 */
  fp: string;
  text: string;
}

export const unknownStartupNotice = ({ who, pane, tmuxSession, cwd, screen }: StartupNoticeInput): StartupNotice => {
  const plain = stripAnsi(screen);
  const tail = plain.split("\n").map(stripBorders).filter((l) => l.trim()).slice(-8)
    .map((l) => `> ${l.trim().slice(0, 120)}`).join("\n");
  return {
    fp: plain.replace(/\s+/gu, " ").trim(),
    text:
      `[wezard] ⚠️ ${who} 启动时停在一个无法远程处理的 CLI 确认框上，需要本地手动确认。\n\n` +
      "- 面板: tmux 会话 `" + tmuxSession + "` 的 pane `" + pane +
      "`（本机执行 `tmux attach -t " + tmuxSession + "` 找到它）\n" +
      "- 工作目录: `" + cwd + "`\n\n" +
      "屏上内容（原文摘要）:\n" + tail + "\n\n" +
      "wezard 认不出这个框，不会替你按任何键；到该面板手动选择后它会继续启动。本条仅通知，无需点击。",
  };
};
