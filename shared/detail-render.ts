// Pure HTML rendering for detail records — no IO, no state. Consumed by daemon's
// local /detail handler and the standalone svr binary. Any UI change here 自动
// 让两端保持同款外观。
import { structuredPatch, parsePatch, type StructuredPatchHunk } from "diff";
import { highlightCode, langFromPath } from "./highlight.js";
import { ansiToHtml } from "./ansi.js";
import { staleAt, turnDone } from "./chat-view.js";
import { isKeepaliveTurn } from "./keepalive.js";
import { backendLabel } from "./cli-backends.js";
import { modelLabel } from "./pricing.js";
import type {
  ApprovalDecision,
  ApprovalDetailRecord,
  CtxCut,
  DetailRecord,
  MarkDetailRecord,
  ToolDetailRecord,
  TurnDetailRecord,
  TurnItem,
} from "./detail-store.js";
import { truncate, clipLine } from "./std.js";
import { parseReminders, stripReminders, type Reminder } from "./reminder.js";
import { stripSigil } from "./session-label.js";

const escHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );

const fmtTs = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** 一行里的时刻: 只报 `HH:MM:SS`, 完整日期收进 title —— 日期由消息行自己交代。 */
const clock = (ms: number): string => {
  const ts = fmtTs(ms);
  return `<time class="ts" title="${ts}">${ts.slice(11)}</time>`;
};

const fmtDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return `${m}m${rs}s`;
};

// 42431 → "42.4k"; 999 → "999"; 12345678 → "12.35M"
const fmtTok = (n: number): string => {
  if (n < 1000) return String(n);
  if (n < 1e6) {
    const v = n / 1000;
    return (v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "")) + "k";
  }
  return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
};

const decisionBadge = (d?: ApprovalDecision): { label: string; cls: string } => {
  if (!d) return { label: "待审批", cls: "pending" };
  if (d === "deny") return { label: "拒绝", cls: "deny" };
  if (d === "timeout") return { label: "超时", cls: "warn" };
  if (d === "allow_window") return { label: "通过 · 窗口", cls: "allow" };
  if (d === "allow_session") return { label: "通过 · 会话", cls: "allow" };
  if (d === "allow_always") return { label: "通过 · 已存规则", cls: "allow" };
  if (d === "swept") return { label: "通过 · 批量", cls: "allow" };
  if (d === "allow") return { label: "通过", cls: "allow" };
  return { label: String(d), cls: "pending" };
};

const highlightJson = (json: string): string => {
  const escaped = escHtml(json);
  return escaped.replace(
    /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (_m, key, str, kw, num) => {
      if (key) return `<span class="jk">${key}</span>`;
      if (str) return `<span class="js">${str}</span>`;
      if (kw) return `<span class="jb">${kw}</span>`;
      if (num) return `<span class="jn">${num}</span>`;
      return _m;
    },
  );
};

const toJson = (v: unknown): string => {
  try { return JSON.stringify(v, null, 2) ?? "null"; } catch { return String(v); }
};

/** 整段结果是一个 JSON 容器 (对象 / 数组) → 重排缩进并高亮; 否则 ""。标量不算 ——
 *  `42` / `"ok"` 排了版也还是它自己。重排会抹平大整数与键的重复, 所以原文始终另留一份 raw。 */
const prettyJsonHtml = (raw: string): string => {
  const t = raw.trim();
  if (!/^[{[]/.test(t)) return "";
  try { return highlightJson(JSON.stringify(JSON.parse(t), null, 2)); } catch { return ""; }
};

export const SHARED_CSS = `
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:#f6f8fa;color:#1f2328;
    font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif}
  .wrap{max-width:980px;margin:0 auto;padding:24px 20px 60px}
  header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:8px}
  h1{margin:0;font-size:18px;font-weight:600}
  h1 .accent{color:#0969da}
  .meta{color:#656d76;font-size:12px;margin-bottom:20px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
  .meta .sep{margin:0 6px;opacity:.5}
  .badge{font-size:12px;padding:2px 8px;border-radius:4px;border:1px solid #d0d7de}
  .badge.allow{color:#1a7f37;border-color:#1a7f3733;background:#1a7f3714}
  .badge.deny{color:#cf222e;border-color:#cf222e33;background:#cf222e14}
  .badge.warn{color:#9a6700;border-color:#9a670033;background:#9a670014}
  .badge.pending{color:#8250df;border-color:#8250df33;background:#8250df14}
  section{background:#fff;border:1px solid #d0d7de;border-radius:6px;
    margin-bottom:12px;overflow:hidden}
  section>h2{margin:0;padding:6px 12px;font-size:11px;font-weight:600;
    color:#656d76;text-transform:uppercase;letter-spacing:.5px;
    background:#f1f3f6;border-bottom:1px solid #d0d7de}
  pre{margin:0;padding:12px;font-size:12.5px;line-height:1.5;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
  .jk{color:#953800}.js{color:#0a3069}.jb{color:#9a6700}.jn{color:#8250df}
  .hc{color:#6e7781;font-style:italic}.hs{color:#0a3069}.hk{color:#cf222e}
  .hl{color:#8250df}.hn{color:#0550ae}.hv{color:#953800}
  .codeview{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:12.5px;line-height:1.5;padding:8px 0}
  .codeview .row{display:grid;grid-template-columns:56px 1fr;min-width:0}
  .codeview .ln{color:#8c959f;text-align:right;padding:0 8px;
    user-select:none;font-variant-numeric:tabular-nums}
  .codeview .txt{padding:0 8px;white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}
  .diff{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:12.5px;line-height:1.5}
  .diff .row{display:grid;grid-template-columns:44px 44px 14px 1fr;min-width:0}
  .diff .row.add{background:#dafbe1}
  .diff .row.del{background:#ffebe9}
  .diff .row.hunk{background:#ddf4ff;color:#0969da;
    grid-template-columns:1fr;padding:1px 12px}
  .diff .ln{color:#8c959f;text-align:right;padding:0 6px;
    user-select:none;font-variant-numeric:tabular-nums}
  .diff .sign{text-align:center;color:#656d76;user-select:none}
  .diff .row.add .sign{color:#1a7f37}
  .diff .row.del .sign{color:#cf222e}
  .diff .txt{padding:0 8px;white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}
  .diff-meta{padding:4px 12px;font-size:12px;color:#656d76;
    background:#f1f3f6;border-bottom:1px solid #d0d7de;
    font-family:ui-monospace,monospace}
  details summary{cursor:pointer;color:#656d76;padding:6px 12px;font-size:11px;
    text-transform:uppercase;letter-spacing:.5px;font-weight:600;
    background:#f1f3f6;border-bottom:1px solid #d0d7de;
    list-style:none;user-select:none}
  details summary::-webkit-details-marker{display:none}
  details summary::before{content:"▶ ";font-size:9px}
  details[open] summary::before{content:"▼ "}
`;

interface DiffBlock { path: string; oldStr: string; newStr: string; label?: string }

const renderHunks = (hunks: readonly StructuredPatchHunk[], label: string | undefined, path: string, lang?: string): string => {
  let adds = 0, dels = 0;
  const renderText = (t: string): string =>
    t === "" ? "&nbsp;" : (lang ? highlightCode(t, lang) : escHtml(t));
  const rowsHtml = hunks.flatMap((h) => {
    const header = `<div class="row hunk">@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@</div>`;
    let oa = h.oldStart, nb = h.newStart;
    const body = h.lines
      .filter((ln) => !ln.startsWith("\\"))
      .map((ln) => {
        const sign = ln[0] ?? " ";
        const text = ln.slice(1);
        const tag = sign === "+" ? "add" : sign === "-" ? "del" : "eq";
        const oldLn = tag === "add" ? "" : oa++;
        const newLn = tag === "del" ? "" : nb++;
        if (tag === "add") adds++;
        else if (tag === "del") dels++;
        return `<div class="row ${tag}"><div class="ln">${oldLn}</div><div class="ln">${newLn}</div><div class="sign">${sign}</div><div class="txt">${renderText(text)}</div></div>`;
      })
      .join("");
    return [header, body];
  }).join("");
  const head = label ? `${escHtml(label)} · ` : "";
  return `<section>
    <h2>${head}<span style="color:#1a7f37">+${adds}</span> <span style="color:#cf222e">-${dels}</span>${path ? ` · <span style="color:#1f2328;text-transform:none;letter-spacing:0">${escHtml(path)}</span>` : ""}</h2>
    <div class="diff">${rowsHtml}</div>
  </section>`;
};

const renderDiffBlock = (b: DiffBlock): string => {
  const norm = (s: string): string => (s === "" || s.endsWith("\n") ? s : `${s}\n`);
  const patch = structuredPatch("a", "b", norm(b.oldStr), norm(b.newStr), "", "", { context: 3 });
  return renderHunks(patch.hunks, b.label, b.path, langFromPath(b.path));
};

const tryRenderUnifiedDiff = (text: string): string => {
  if (!/(^|\n)(diff --git |@@ -\d)/.test(text)) return "";
  let patches: ReturnType<typeof parsePatch>;
  try { patches = parsePatch(text); } catch { return ""; }
  const sections = patches
    .filter((p) => p.hunks && p.hunks.length > 0)
    .map((p, idx, arr) => {
      const path = p.newFileName || p.oldFileName || "";
      const label = arr.length > 1 ? `file ${idx + 1}/${arr.length}` : undefined;
      return renderHunks(p.hunks, label, path, langFromPath(path));
    })
    .join("");
  return sections;
};

const extractDiffBlocks = (toolName: string, input: unknown): DiffBlock[] => {
  if (!input || typeof input !== "object") return [];
  const i = input as Record<string, unknown>;
  const path = typeof i.file_path === "string" ? i.file_path : "";
  if (toolName === "Edit") {
    const oldStr = typeof i.old_string === "string" ? i.old_string : "";
    const newStr = typeof i.new_string === "string" ? i.new_string : "";
    if (!oldStr && !newStr) return [];
    return [{ path, oldStr, newStr }];
  }
  if (toolName === "MultiEdit") {
    const edits = Array.isArray(i.edits) ? (i.edits as Array<Record<string, unknown>>) : [];
    return edits.flatMap((e, idx) => {
      const oldStr = typeof e.old_string === "string" ? e.old_string : "";
      const newStr = typeof e.new_string === "string" ? e.new_string : "";
      if (!oldStr && !newStr) return [];
      return [{ path, oldStr, newStr, label: `edit ${idx + 1}/${edits.length}` }];
    });
  }
  if (toolName === "Write") {
    const content = typeof i.content === "string" ? i.content : "";
    return [{ path, oldStr: "", newStr: content, label: "create / overwrite" }];
  }
  return [];
};

const renderBashCommand = (input: unknown): string => {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const cmd = typeof i.command === "string" ? i.command : "";
  if (!cmd) return "";
  const desc = typeof i.description === "string" ? i.description : "";
  const subtitle = desc ? ` · <span style="color:#1f2328;text-transform:none;letter-spacing:0;font-weight:400">${escHtml(desc)}</span>` : "";
  return `<section><h2>command${subtitle}</h2><pre><code>${highlightCode(cmd, "bash")}</code></pre></section>`;
};

const CAT_N_RE = /^\s*(\d+)\t(.*)$/;
const renderReadContent = (text: string, filePath: string): string => {
  const lang = langFromPath(filePath);
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const rows = lines
    .map((line) => {
      const m = CAT_N_RE.exec(line);
      const num = m ? m[1]! : "";
      const content = m ? m[2]! : line;
      const txt = content === "" ? "&nbsp;" : highlightCode(content, lang);
      return `<div class="row"><div class="ln">${num}</div><div class="txt">${txt}</div></div>`;
    })
    .join("");
  const langLabel = lang ? ` · <span style="color:#1f2328;text-transform:none;letter-spacing:0;font-weight:400">${escHtml(lang)}</span>` : "";
  const head = filePath ? `<span style="color:#1f2328;text-transform:none;letter-spacing:0;font-weight:400">${escHtml(filePath)}</span>${langLabel}` : `content${langLabel}`;
  return `<section><h2>${head}</h2><div class="codeview">${rows}</div></section>`;
};

const renderToolPage = (r: ToolDetailRecord): string => {
  const inputJson = highlightJson(toJson(r.toolInput));
  const hasResult = typeof r.toolResult === "string" && r.toolResult.length > 0;
  const isBash = r.toolName === "Bash";
  const isRead = r.toolName === "Read";
  const diffResultHtml = hasResult && !isRead ? tryRenderUnifiedDiff(r.toolResult!) : "";
  const filePath = isRead && r.toolInput && typeof r.toolInput === "object"
    ? String((r.toolInput as Record<string, unknown>).file_path ?? "")
    : "";
  const readResultHtml = isRead && hasResult ? renderReadContent(r.toolResult!, filePath) : "";
  const jsonResultHtml = hasResult && !isRead && !diffResultHtml ? prettyJsonHtml(r.toolResult!) : "";
  const resultBlock = jsonResultHtml
    ? `<section><h2>result</h2><pre><code>${jsonResultHtml}</code></pre></section><section><details><summary>result (raw)</summary><pre><code>${ansiToHtml(r.toolResult!)}</code></pre></details></section>`
    : readResultHtml
    ? `${readResultHtml}<section><details><summary>result (raw)</summary><pre><code>${ansiToHtml(r.toolResult!)}</code></pre></details></section>`
    : hasResult
      ? (diffResultHtml
        ? `${diffResultHtml}<section><details><summary>result (raw)</summary><pre><code>${ansiToHtml(r.toolResult!)}</code></pre></details></section>`
        : `<section><h2>result</h2><pre><code>${ansiToHtml(r.toolResult!)}</code></pre></section>`)
    : `<section><h2>result</h2><pre style="color:#656d76;font-style:italic"><code>(尚未捕获)</code></pre></section>`;
  const status = hasResult
    ? `<span class="badge allow">完成${r.resultAt ? ` · ${fmtDuration(r.resultAt - r.createdAt)}` : ""}</span>`
    : `<span class="badge pending">运行中</span>`;
  const diffBlocks = extractDiffBlocks(r.toolName, r.toolInput);
  const diffSection = diffBlocks.map(renderDiffBlock).join("");
  const bashCommandHtml = isBash ? renderBashCommand(r.toolInput) : "";
  const hasPrimary = diffBlocks.length > 0 || bashCommandHtml || readResultHtml;
  const inputSection = hasPrimary
    ? `<section><details><summary>input</summary><pre><code>${inputJson}</code></pre></details></section>`
    : `<section><h2>input</h2><pre><code>${inputJson}</code></pre></section>`;
  const metaParts = [
    fmtTs(r.createdAt),
    r.sessionId ? r.sessionId.slice(0, 8) : null,
    r.target || null,
  ].filter(Boolean) as string[];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(r.toolName)}</title>
<style>${SHARED_CSS}</style></head><body><div class="wrap">
<header><h1><span class="accent">${escHtml(r.toolName)}</span></h1>${status}</header>
<div class="meta">${metaParts.map(escHtml).join('<span class="sep">·</span>')}</div>
${bashCommandHtml}
${diffSection}
${inputSection}
${resultBlock}
</div></body></html>`;
};

const renderApprovalPage = (r: ApprovalDetailRecord): string => {
  const badge = decisionBadge(r.decision);
  const inputJson = highlightJson(toJson(r.toolInput));
  const ageMs = (r.decidedAt ?? Date.now()) - r.createdAt;
  const transcript = r.transcriptTail.trim();
  const metaParts = [
    fmtTs(r.createdAt),
    r.decidedAt ? `用时 ${fmtDuration(ageMs)}` : null,
    r.decidedBy || null,
    r.cwd || null,
  ].filter(Boolean) as string[];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(r.toolName)}</title>
<style>${SHARED_CSS}</style></head><body><div class="wrap">
<header><h1><span class="accent">${escHtml(r.toolName)}</span></h1>
<span class="badge ${badge.cls}">${badge.label}</span></header>
<div class="meta">${metaParts.map(escHtml).join('<span class="sep">·</span>')}</div>
<section><h2>input</h2><pre><code>${inputJson}</code></pre></section>
${transcript
    ? `<section><details><summary>transcript (${transcript.split("\n").length} 行)</summary><pre><code>${ansiToHtml(transcript)}</code></pre></details></section>`
    : ""}
</div></body></html>`;
};

// ── Turn (brief-mode) 聚合页 ────────────────────────────────────────────
// 一个 turn 内的所有 item 按 ts 序渲染成 claude.ai 风格气泡时间线。
// tool_use 与其配对的 tool_result 合并为一个可折叠 section (按 toolUseId 匹配)。
// assistant text 用客户端 markdown-it + highlight.js 富文本渲染 —— 服务端只输出
// 转义后的原文放到 data-md, 页尾脚本一次性 render 到 .md-body。未 closed 时页面
// 每 2s meta-refresh, closed 后移除 refresh + 状态徽章切「已完成 · 用时Xs」。
const TURN_CSS = `
  .bubbles{display:flex;flex-direction:column;gap:8px}
  .bubbles>*{margin-bottom:0}
  .bubble{background:#fff;border:1px solid #d0d7de;border-radius:12px;overflow:hidden}
  /* ── 回复正文: 不带工具调用的那次应答才是一颗实线气泡, 贴着内容的宽度。
     它前面隔着过程框时头上带一行自己的时刻与本轮的账 (.say-cap)。 ── */
  .say{display:flex;flex-direction:column;align-items:flex-start;gap:4px;
    align-self:flex-start;max-width:100%}
  .say>.bubble{max-width:100%;border-radius:14px}
  .say-cap{display:flex;align-items:center;gap:4px 10px;flex-wrap:wrap;padding:0 2px}
  /* 带着工具调用的那次应答里的话: 是过程的一部分, 留在框里, 没有自己的框。 */
  .bubble.note{background:transparent;border:0;border-radius:0}
  .bubble.note .md-body{padding:2px 6px;font-size:13.5px}
  .tool-summary .ts{flex:none;color:#9aa3af;font-size:10.5px;font-variant-numeric:tabular-nums;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  /* ── 过程框: 终句之前的那些 API 应答 —— 途中的话、工具调用、审批、子 agent ——
     连着的收进一个虚线框。框头与框内空白是开关 (chat.js), 框里的每一行照旧各管各的展开。 ── */
  .steps{min-width:0;padding:4px 6px 6px;border:1px dashed #d0d7de;border-radius:10px;cursor:pointer}
  .steps>.bubbles{gap:2px}
  .steps .bubble,.steps .turn-group{cursor:auto}
  .steps-head{display:flex;align-items:baseline;gap:8px;width:100%;padding:2px 6px;
    border:0;background:none;cursor:pointer;text-align:left;font-size:11.5px;color:#8c959f;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .steps-head:hover{color:#57606a}
  .steps-head::after{content:"›";margin-left:auto;font-size:14px;color:#b1bac4;
    transform:rotate(90deg);transition:transform .12s}
  .steps.folded{padding-bottom:4px}
  .steps.folded>.bubbles{display:none}
  .steps.folded>.steps-head::after{transform:none}
  .bubble.approval{background:transparent;border:0;border-radius:0}
  .bubble.approval .bubble-head{padding:3px 6px}
  .bubble-head{display:flex;align-items:center;gap:8px;padding:10px 14px;
    font-size:13px;color:#1f2328;flex-wrap:wrap}
  .bubble-head .role{font-weight:600}
  .bubble-head .ts{margin-left:auto;color:#8c959f;font-size:11px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .bubble-head .compact{color:#656d76;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:12.5px;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  .md-body{padding:10px 14px;color:#1f2328;line-height:1.65;font-size:14px}
  .md-body p{margin:.6em 0}
  .md-body>:first-child{margin-top:0}
  .md-body>:last-child{margin-bottom:0}
  .md-body h1,.md-body h2,.md-body h3{margin:1em 0 .4em;font-weight:600}
  .md-body h1{font-size:1.4em}.md-body h2{font-size:1.2em}.md-body h3{font-size:1.05em}
  .md-body ul,.md-body ol{margin:.6em 0;padding-left:1.6em}
  .md-body li{margin:.2em 0}
  .md-body code{background:#f6f8fa;border-radius:4px;padding:1px 5px;font-size:.9em;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .md-body pre{background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;
    margin:.7em 0;padding:12px;white-space:pre-wrap;overflow-wrap:anywhere}
  .md-body pre code{background:transparent;padding:0;font-size:12.5px;line-height:1.5}
  .md-body pre code.hljs{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
  .md-body blockquote{margin:.6em 0;padding:.2em 1em;border-left:3px solid #d0d7de;color:#656d76}
  .md-body table{border-collapse:collapse;margin:.7em 0}
  .md-body th,.md-body td{border:1px solid #d0d7de;padding:6px 10px}
  .md-body a{color:#0969da;text-decoration:none}
  .md-body a:hover{text-decoration:underline}
  .bubble details{border-top:1px solid #eaeef2}
  .bubble details summary{background:#f6f8fa;border-bottom:0}
  .typing{color:#8c959f;font-style:italic;font-size:12.5px;padding:0 2px}
  .typing::after{content:"";display:inline-block;width:6px;height:6px;
    background:#8c959f;border-radius:50%;margin-left:6px;
    animation:blink 1.2s infinite}
  @keyframes blink{0%,60%,100%{opacity:.2}30%{opacity:1}}
  .chip.model{font-size:12px;padding:3px 10px;border-radius:12px;color:#0969da;
    background:#0969da10;border:1px solid #0969da33;font-weight:600;
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif}
  .chip.model .alt{opacity:.6;font-weight:400}
  .chip.tier{font-size:11px;padding:2px 8px;border-radius:10px;color:#9a6700;
    background:#9a670010;border:1px solid #9a670033;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  /* ── 用户提问气泡 ── */
  .bubble.user{background:#0969da0a;border-color:#0969da33}
  .bubble.user .bubble-head{color:#0969da}
  .bubble.user .q-body{padding:2px 16px 14px;color:#1f2328;line-height:1.6;
    font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
  /* ── 工具调用 (Claude CLI 风): 去卡片, 默认折叠, ⎿ 结果预览 ── */
  .bubble.tool{background:transparent;border:0;border-radius:0;overflow:visible}
  .bubble .tool-call{border:0}
  .bubble .tool-call>summary{list-style:none;cursor:pointer;display:flex;
    align-items:baseline;gap:7px;padding:3px 6px;border-radius:6px;border:0;
    background:transparent;color:#1f2328;font-size:13.5px;font-weight:400;
    text-transform:none;letter-spacing:0}
  .bubble .tool-call>summary::-webkit-details-marker{display:none}
  .bubble .tool-call>summary::before{content:none}
  .bubble .tool-call>summary:hover{background:#f0f3f6}
  .tool-dot{color:#1a7f37;font-size:11px;align-self:center;flex:none}
  .tool-call[open]>summary .tool-dot{color:#0969da}
  .tool-name{font-weight:600;flex:none;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .tool-arg{color:#656d76;min-width:0;flex:0 1 auto;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tool-dur{color:#8c959f;font-size:11px;flex:none;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .tool-summary .ts{margin-left:auto}
  .tool-body{padding:8px 0 4px 16px;margin:2px 0 0 9px;
    border-left:2px solid #eaeef2}
  .tool-body>section{margin-bottom:8px}
  .tool-body>section:last-child,.tool-body>details:last-child{margin-bottom:0}
  .tool-result-line{padding:1px 6px 2px 24px;color:#57606a;font-size:12.5px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tool-call[open] ~ .tool-result-line{display:none}
  .tool-result-line .corner{color:#b1bac4;margin-right:6px}
  .tool-result-line .add{color:#1a7f37;font-weight:600}
  .tool-result-line .del{color:#cf222e;font-weight:600}
  .tool-result-line .more{color:#8c959f}
  .tool-result-line .run{color:#9a6700}
  /* ── 移交提示: 系统行, 不是消息 —— 没有底色与边框, 小一号 ── */
  .handoff{font-size:11.5px;line-height:18px;color:#656d76}
  .handoff .ho-line{display:flex;align-items:center;flex-wrap:wrap;gap:4px 6px;padding:2px 6px 3px 24px;
    list-style:none}
  details.handoff>.ho-line{cursor:pointer;background:none;border:0;font:inherit;color:inherit;
    text-transform:none;letter-spacing:0;user-select:auto}
  details.handoff>.ho-line::before{content:none}
  .handoff .ho-line::-webkit-details-marker{display:none}
  details.handoff>.ho-line::after{content:"▸";color:#8c959f;font-size:10px}
  .handoff[open] .ho-line::after{content:"▾"}
  /* 展开 = 交过去的那段原文 (tell_peer 的 text), 按 markdown 分行。 */
  .handoff .ho-text{margin:0 6px 4px 24px;padding:4px 10px;border-left:2px solid #8250df40;color:#1f2328}
  .handoff .ho-text .md-body{font-size:12.5px}
  .handoff .ho-arrow{color:#8250df;font-weight:600;margin-right:-2px}
  .handoff .ho-nm{color:#1f2328;font-weight:500}
  .handoff .ho-turn{border:0;background:none;padding:0;font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:10.5px;color:#8c959f}
  .handoff button.ho-turn{cursor:pointer}
  .handoff button.ho-turn:hover{color:#0969da;text-decoration:underline}
  .handoff .ho-tag{border-radius:4px;padding:0 5px;font-size:10.5px;line-height:16px;background:#f1f3f6;color:#656d76}
  .handoff .ho-tag.pub{color:#0969da;background:#0969da12}
  .handoff .ho-tag.priv{color:#9a5b10;background:#9a5b1014}
  .handoff .ho-tag.pri.idle{opacity:.55}
  .handoff .ho-st{border-radius:4px;padding:0 5px;font-size:10.5px;line-height:16px;color:#1a7f37;background:#1a7f3712}
  .handoff .ho-st.run,.handoff .ho-st.wait{color:#8c959f;background:none;padding:0}
  .handoff .ho-st:is(.st-need,.st-error){color:#9a6700;background:#9a670014}
  .handoff .ho-st:is(.st-timeout,.st-silent,.st-dead,.st-canceled){color:#cf222e;background:#cf222e10}
  .handoff .ho-why{color:#9a6700}
  .handoff.fail .ho-arrow,.handoff.fail .ho-why{color:#cf222e}
  .handoff .ho-why{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* ── 上下文断点条 ── */
  .tg-cut{display:flex;align-items:center;gap:8px;font-size:11px;color:#9a6700;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.3px}
  .tg-cut::before,.tg-cut::after{content:"";border-top:1px dashed #d4a72c99}
  .tg-cut::before{flex:0 0 14px}
  .tg-cut::after{flex:1}
  .tg-cut .s{opacity:.6}
  .tg-cut.switch{color:#8c959f}
  .tg-cut.switch::before,.tg-cut.switch::after{border-top-color:#d0d7de}
  /* ── graph 归因条 ── 与断点条同一视觉语法 (贯穿细线), 换成紫色: 断点讲"上下文",
     归因讲"谁派的", 两者可以同时出现在一张卡片上, 必须一眼分得开。 */
  .tg-graph{display:flex;align-items:center;gap:8px;font-size:11px;color:#6639ba;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.3px}
  .tg-graph::after{content:"";flex:1;border-top:1px dashed #8250df66}
  .tg-graph code{background:#8250df14;border-radius:4px;padding:0 4px}
  .tg-graph .s{color:#8250df;opacity:.85}
  .tg-graph .f{color:#8c959f}
  /* ── subagent 归属条 ── 绿色贯穿线 (断点=黄/graph=紫/子 agent=绿); 卡片整体
     缩进+左边框, 让时间轴上"父 turn 内嵌套的子 turn"一眼可辨。 */
  .tg-agent{display:flex;align-items:center;gap:8px;font-size:11px;color:#1a7f37;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.3px}
  .tg-agent::after{content:"";flex:1;border-top:1px dashed #1a7f3766}
  .tg-agent .s{color:#57606a;opacity:.9;overflow:hidden;text-overflow:ellipsis;
    white-space:nowrap;max-width:60%}
  .turn-group.subagent{margin-left:20px;border-left:2px solid #1a7f3733;
    padding-left:10px}
  /* ── 独立断点行 ── 不依附卡片的那一道分隔 (/clear、/new、会话轮换)。 */
  .tg-mark{display:flex;align-items:center;gap:8px;font-size:11px;color:#9a6700;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.3px;
    padding:2px 0}
  .tg-mark::before,.tg-mark::after{content:"";flex:1;border-top:1px dashed #d4a72c99}
  .tg-mark .s{opacity:.55}
  .tg-mark.cut-switch{color:#8c959f}
  .tg-mark.cut-switch::before,.tg-mark.cut-switch::after{border-top-color:#d0d7de}
`;

const renderJsonSection = (input: unknown): string =>
  `<details><summary>input</summary><pre><code>${highlightJson(toJson(input))}</code></pre></details>`;

// 结果行数 (末尾换行不计)。
const countLines = (s: string): number => {
  if (!s) return 0;
  const n = s.split("\n").length;
  return s.endsWith("\n") ? n - 1 : n;
};

// Edit/Write/MultiEdit 的 +增 -删 汇总, 供折叠态 ⎿ 预览行用 (context:0 只数改动行)。
const diffStat = (blocks: readonly DiffBlock[]): { adds: number; dels: number } => {
  const norm = (s: string): string => (s === "" || s.endsWith("\n") ? s : `${s}\n`);
  return blocks.reduce(
    (acc, b) => {
      const p = structuredPatch("a", "b", norm(b.oldStr), norm(b.newStr), "", "", { context: 0 });
      for (const h of p.hunks)
        for (const ln of h.lines) {
          if (ln.startsWith("+")) acc.adds++;
          else if (ln.startsWith("-")) acc.dels++;
        }
      return acc;
    },
    { adds: 0, dels: 0 },
  );
};

// Claude CLI 的 ⎿ 结果摘要: diff 工具→增删数, Read→行数, 其余→首行 + 行数。
const toolResultPreview = (
  use: ToolUse,
  diffBlocks: readonly DiffBlock[],
  rawResult: string,
  hasResult: boolean,
  done: boolean,
): string => {
  // 轮已结束而结果没回来 = 被打断 (Esc / 新消息顶掉), 不会再有结果, 别一直挂着「运行中」。
  if (!hasResult)
    return done
      ? `<span class="corner">⎿</span><span class="more">已中断 · 无结果</span>`
      : `<span class="corner">⎿</span><span class="run">运行中…</span>`;
  if (diffBlocks.length > 0) {
    const { adds, dels } = diffStat(diffBlocks);
    return `<span class="corner">⎿</span>更新 <span class="add">+${adds}</span> <span class="del">-${dels}</span>`;
  }
  if (use.toolName === "Read")
    return `<span class="corner">⎿</span>读取 ${countLines(rawResult)} 行`;
  const lines = countLines(rawResult);
  const first = rawResult.split("\n").find((l) => l.trim() !== "") ?? "";
  const head = escHtml(clipLine(first, 88));
  const more = lines > 1 ? ` <span class="more">+${lines - 1} 行</span>` : "";
  return `<span class="corner">⎿</span>${head || "(空)"}${more}`;
};

type ToolUse = Extract<TurnItem, { t: "tool_use" }>;
type ToolResult = Extract<TurnItem, { t: "tool_result" }>;

// 展开后才看得见的那部分: 命令 / diff / 文件内容的高亮, input, 原始 result。
// 一张气泡的重量几乎全在这里 (语法高亮、ANSI、几十 KB 的结果) —— 所以单独成函数:
// 整页详情直接内联, rolepage 只在展开那一刻按需取 (见 renderToolBody)。
const toolBody = (use: ToolUse, result: ToolResult | undefined): string => {
  const isRead = use.toolName === "Read";
  const bashHtml = use.toolName === "Bash" ? renderBashCommand(use.toolInput) : "";
  const diffHtml = extractDiffBlocks(use.toolName, use.toolInput).map(renderDiffBlock).join("");
  const rawResult = result?.body ?? "";
  const readResultHtml = isRead && rawResult ? renderReadContent(rawResult, extractFilePath(use.toolInput)) : "";
  const diffResultHtml = rawResult && !isRead ? tryRenderUnifiedDiff(rawResult) : "";
  const primary = [bashHtml, diffHtml, readResultHtml, diffResultHtml].filter(Boolean).join("");
  const inputSection = primary
    ? renderJsonSection(use.toolInput)
    : `<details open><summary>input</summary><pre><code>${highlightJson(toJson(use.toolInput))}</code></pre></details>`;
  const jsonHtml = rawResult && !isRead && !diffResultHtml ? prettyJsonHtml(rawResult) : "";
  const resultJson = jsonHtml ? `<details open><summary>result</summary><pre><code>${jsonHtml}</code></pre></details>` : "";
  const resultRaw = rawResult
    ? `<details><summary>result (raw)</summary><pre><code>${ansiToHtml(rawResult)}</code></pre></details>`
    : `<details><summary>result</summary><pre style="color:#656d76;font-style:italic;margin:0;padding:12px"><code>(尚未捕获)</code></pre></details>`;
  return `${primary}${inputSection}${resultJson}${resultRaw}`;
};

// ── 移交: tell_peer (旧名 send_peer) 把一件活交给了谁 ──
// 它不是一次普通的工具调用 —— 这一刻起活在对方手里, 结论会作为回执回来。所以在调用框下面
// 另起一行系统提示, 事实全从这次调用自己的 input / result 读: 回包有就信回包 (落地的名字、
// 实际的投递方式), 没回来 (运行中 / 失败) 才退回 input。
export interface Handoff {
  /** 对方的名字, 不带点。 */
  name: string;
  /** 活号; 投递失败 / 回包还没回来时没有。 */
  turn?: string;
  public: boolean;
  /** 实际的投递方式 —— urgent 被降级时回包写的是 normal。 */
  priority: "normal" | "urgent" | "now";
  /** 投的那一刻对方在忙 —— priority 只在这时才真起作用。undefined = 回包没说。 */
  busy?: boolean;
  kind?: "ask" | "fyi";
  /** 交过去的那段原文 (tell_peer 的 text)。 */
  text: string;
  /** 带 `re` = 续问同一件活, 不是新活。 */
  re: boolean;
  /** 守护进程会送回执 (fyi / receipt:false 不送)。 */
  receipt: boolean;
  /** undefined = 回包还没回来; lost = 回来的不是回包 (调用被挪去后台等), 交没交出去不知道。 */
  state?: "ok" | "failed" | "lost";
  reason?: string;
}

const HANDOFF_TOOL = /(?:^|__)(?:tell|send)_peer$/;

const objOf = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const parseObj = (s: string): Record<string, unknown> | undefined => {
  try { const v: unknown = JSON.parse(s); return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined; } catch { return undefined; }
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const PRIORITIES = ["normal", "urgent", "now"] as const;
const priorityOf = (v: unknown): Handoff["priority"] | undefined => PRIORITIES.find((p) => p === v);

/** 这次调用是不是一次移交; 是就读出它的事实。 */
export const handoffOf = (use: ToolUse, result: ToolResult | undefined): Handoff | undefined => {
  if (!HANDOFF_TOOL.test(use.toolName)) return undefined;
  const a = objOf(use.toolInput);
  const j = result ? parseObj(result.body) : undefined;
  const ok = j?.ok !== false && j !== undefined;
  const failed = j?.ok === false || (!!result && /^\w+ failed: /.test(result.body));
  const kind = str(j?.kind) ?? str(a.kind);
  return {
    name: stripSigil(str(j?.name) ?? str(a.name) ?? str(a.tag) ?? ""),
    turn: str(j?.turn),
    public: typeof j?.public === "boolean" ? j.public : a.public === true,
    priority: priorityOf(j?.priority) ?? priorityOf(a.priority) ?? (a.re ? "now" : "normal"),
    busy: typeof j?.wasBusy === "boolean" ? j.wasBusy : undefined,
    kind: kind === "ask" || kind === "fyi" ? kind : undefined,
    text: str(a.text) ?? "",
    re: !!str(a.re),
    receipt: ok && !!j?.receipt,
    state: !result ? undefined : ok ? "ok" : failed ? "failed" : "lost",
    reason: result && !ok ? clipLine(str(j?.reason) ?? result.body.replace(/^\w+ failed: /, ""), 120) : undefined,
  };
};

/** rolepage 给移交行补的三样: 对方的头像 + 名字 (点了切到它的视角), 活号 (点了跳到它接手的那一轮),
 *  回执落定成什么。整页详情没有名录也不看别的轮次, 只写名字与活号。 */
export interface HandoffDeco {
  who: (h: Handoff) => string;
  turn: (h: Handoff & { turn: string }) => string;
  status: (h: Handoff) => string;
}

// 排队 / 插话 / 打断只在对方正忙时才真发生; 对方闲着就是立刻投, 标签淡下去。
const PRIORITY_TAG: Readonly<Record<Handoff["priority"], [string, string]>> = {
  normal: ["排队", "等它这一轮结束再投"],
  now: ["插话", "落进它正在跑的这一轮"],
  urgent: ["打断", "先打断它这一轮再投"],
};

const hoTag = (cls: string, text: string, tip: string): string =>
  `<span class="ho-tag ${cls}" title="${escHtml(tip)}">${escHtml(text)}</span>`;

/** 移交行默认收起, 点开看交过去的原文; 没有原文就只是一行。 */
const hoBox = (cls: string, line: string, text: string): string =>
  text
    ? `<details class="handoff${cls}"><summary class="ho-line">${line}</summary><div class="ho-text">${mdBody(text)}</div></details>`
    : `<div class="handoff${cls}"><div class="ho-line">${line}</div></div>`;

const renderHandoff = (h: Handoff, deco?: HandoffDeco): string => {
  const who = deco ? deco.who(h) : `<span class="ho-nm">.${escHtml(h.name)}</span>`;
  if (h.state === "failed")
    return hoBox(" fail", `<span class="ho-arrow">↪</span>没交出去 ${who}<span class="ho-why">${escHtml(h.reason ?? "")}</span>`, h.text);
  const [pt, tip] = PRIORITY_TAG[h.priority];
  const idle = h.busy === false;
  const tags = [
    h.public ? hoTag("pub", "公开", "在群里说的, 回复也进群") : hoTag("priv", "私聊", "只在双方的 rolepage"),
    hoTag(`pri${idle ? " idle" : ""}`, pt, idle ? `${tip} —— 投的时候它闲着, 立刻就投了` : tip),
    h.kind === "ask" ? hoTag("kind", "只问", "只问一句") : h.kind === "fyi" ? hoTag("kind", "知会", "只是知会, 不要回话") : "",
  ].join("");
  const turn = !h.turn ? "" : deco ? deco.turn({ ...h, turn: h.turn }) : `<span class="ho-turn">${escHtml(h.turn)}</span>`;
  const st = h.state === undefined
    ? `<span class="ho-st run">投递中…</span>`
    : h.state === "lost" ? `<span class="ho-why" title="${escHtml(h.reason ?? "")}">没等到回包, 交没交出去不确定</span>`
    : deco ? deco.status(h) : "";
  return hoBox("", `<span class="ho-arrow">↪</span>${h.re ? "续问" : h.state === "lost" ? "移交给" : "已移交给"} ${who}${turn}${tags}${st}`, h.text);
};

/** `lazyTurn`: 正文不随气泡下发, 只留一个指回 (turn, toolUseId) 的空壳, 客户端展开时再取。
 *  摘要行与 ⎿ 预览照常渲染 —— 折叠态看到的东西一样不少。 */
const renderToolBubble = (
  use: ToolUse,
  result: ToolResult | undefined,
  key: string,
  done: boolean,
  lazyTurn?: string,
  deco?: HandoffDeco,
): string => {
  const rawResult = result?.body ?? "";
  const ho = handoffOf(use, result);
  // 头部一行: ⏺ 工具名(参数) — 参数取命令/路径等主字段, 与 Claude CLI 同款。
  const arg = oneLineCompact(use.toolInput, 72);
  const dur = result ? `<span class="tool-dur">${escHtml(fmtDuration(result.ts - use.ts))}</span>` : "";
  const preview = toolResultPreview(use, extractDiffBlocks(use.toolName, use.toolInput), rawResult, Boolean(result), done);
  const body = lazyTurn === undefined
    ? `<div class="tool-body">${toolBody(use, result)}</div>`
    : `<div class="tool-body" data-lazy-turn="${escHtml(lazyTurn)}" data-lazy-use="${escHtml(use.toolUseId)}"></div>`;
  // 整个工具调用折叠进 <details> (默认收起); ⎿ 预览行是它的兄弟, 展开时 CSS 隐藏。
  return `<section class="bubble tool" data-key="${key}">
    <details class="tool-call">
      <summary class="tool-summary"><span class="tool-dot">⏺</span><span class="tool-name">${escHtml(use.toolName)}</span>${arg ? `<span class="tool-arg">(${escHtml(arg)})</span>` : ""}${dur}${clock(use.ts)}</summary>
      ${body}
    </details>
    <div class="tool-result-line">${preview}</div>${ho ? renderHandoff(ho, deco) : ""}
  </section>`;
};

/** 懒气泡的另一半: 一轮里某次工具调用的展开正文。不认识这次调用 → undefined。 */
export const renderToolBody = (r: TurnDetailRecord, toolUseId: string): string | undefined => {
  const of = <T extends "tool_use" | "tool_result">(t: T) =>
    r.items.find((it): it is Extract<TurnItem, { t: T }> => it.t === t && it.toolUseId === toolUseId);
  const use = of("tool_use");
  return use && toolBody(use, of("tool_result"));
};

const oneLineCompact = (input: unknown, max = 100): string => {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.query ?? o.prompt;
    if (typeof pick === "string") return clipLine(pick, max);
  }
  try { return truncate(JSON.stringify(input) ?? "", max); } catch { return ""; }
};


const extractFilePath = (input: unknown): string => {
  if (!input || typeof input !== "object") return "";
  const v = (input as Record<string, unknown>).file_path;
  return typeof v === "string" ? v : "";
};

// 原文用 <script type="text/plain"> 承载 —— 免转义歧义, JS 端 textContent 读回原样。
const mdBody = (body: string): string =>
  `<div class="md-body"></div><script type="text/plain" class="md-src">${escHtml(body)}</script>`;

type TextItem = Extract<TurnItem, { t: "text" }>;

/** 终句: 一颗实线气泡。没有标题行 —— 谁说的由消息行的 .mwho 交代。`cap` = 气泡头上
 *  那一行的账 (undefined = 不要这一行: 气泡紧跟在 .mwho 下面, 那里已经写过了)。 */
const renderSay = (item: TextItem, key: string, cap?: string): string => {
  const ts = fmtTs(item.ts);
  const head = cap === undefined
    ? ""
    : `<div class="say-cap"><time class="mt" title="${ts}">${ts.slice(11, 16)}</time>${cap}</div>`;
  return `<div class="say" data-key="${key}">${head}<div class="bubble">${mdBody(item.body)}</div></div>`;
};

/** 途中的话: 和它带出来的工具调用同属一次应答, 留在过程框里。 */
const renderNote = (item: TextItem, key: string): string =>
  `<div class="bubble note" data-key="${key}">${mdBody(item.body)}</div>`;

// 本轮的账: 模型 / 上下文 / 耗时。
const usageChips = (r: TurnDetailRecord, done: boolean, ageMs: number): string => {
  const u = r.usage;
  const ctxPeak = u ? (u.ctxPeak ?? u.input + u.cacheRead + u.cacheWrite) : 0;
  return [
    r.model ? `<span class="chip model" title="${escHtml(r.model)}">${escHtml(modelLabel(r.model))}${r.modelAlt ? `<span class="alt"> +${r.modelAlt}</span>` : ""}</span>` : "",
    u?.serviceTier && u.serviceTier !== "standard" ? `<span class="chip tier">${escHtml(u.serviceTier)}</span>` : "",
    ctxPeak ? `<span class="tg-tok" title="上下文峰值">ctx ${fmtTok(ctxPeak)}</span>` : "",
    // 耗时只在收口后写死 —— 进行中的 turn 每次渲染都会得到不同的 ageMs, 会把 sig 打乱,
    // 让 SSE 的"内容没变就不重发"彻底失效。进行中只给开始时刻 (不变), rolepage 按它走表。
    // 单独一个 .tg-dur: rolepage 两人对话里与模型 / ctx 一起藏掉 (.mrow.two), 只留时刻。
    done
      ? `<span class="tg-dur">${escHtml(fmtDuration(ageMs))}</span>`
      : `<span class="tg-dur live" data-since="${r.createdAt}"></span>`,
  ].filter(Boolean).join("");
};

const renderApprovalItem = (item: Extract<TurnItem, { t: "approval" }>, key: string): string => {
  const b = decisionBadge(item.decision);
  return `<section class="bubble approval" data-key="${key}">
    <div class="bubble-head">🔐 <span class="role">${escHtml(item.toolName)}</span>
      <span class="badge ${b.cls}">${b.label}</span>
      ${clock(item.ts)}</div>
  </section>`;
};

const pairItems = (items: readonly TurnItem[]): Array<{ kind: "solo"; item: TurnItem } | { kind: "pair"; use: Extract<TurnItem, { t: "tool_use" }>; result?: Extract<TurnItem, { t: "tool_result" }> }> => {
  const results = new Map<string, Extract<TurnItem, { t: "tool_result" }>>();
  for (const it of items) if (it.t === "tool_result") results.set(it.toolUseId, it);
  const paired: ReturnType<typeof pairItems> = [];
  const consumed = new Set<string>();
  for (const it of items) {
    if (it.t === "tool_use") {
      const r = results.get(it.toolUseId);
      if (r) consumed.add(it.toolUseId);
      paired.push({ kind: "pair", use: it, result: r });
    } else if (it.t === "tool_result") {
      if (consumed.has(it.toolUseId)) continue; // 已附在 tool_use bubble 里
      paired.push({ kind: "solo", item: it });
    } else {
      paired.push({ kind: "solo", item: it });
    }
  }
  return paired;
};

// djb2 → base36. reconcile 用它做「气泡内容变没变」的判据 —— 不用 outerHTML, 因为客户端
// 会往 text 气泡的 .md-body 里填渲染结果, 污染 outerHTML; data-sig 是服务端算的纯内容指纹。
const hashStr = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

// 在气泡根 tag 的 data-key 后补一个 data-sig=内容指纹 (指纹基于未含 sig 的原 html)。
const tagSig = (html: string): string =>
  html ? html.replace(/(data-key="[^"]*")/, `$1 data-sig="${hashStr(html)}"`) : "";

// 一个 turn 的切片: 渲染好的气泡、完成态与耗时。
// keyPrefix 让线程页里多个 turn 的 data-key 不互撞。`lazy`: 工具正文留空壳 (见 renderToolBubble)。
/** 气泡序列里的一段。`step` = 过程 (途中的话 / 工具 / 审批 / 子 agent) 而不是终句 ——
 *  连着的几段收进同一个虚线框; `call` = 这一段是一次工具调用, 给框头计数。 */
interface Part { key: string; html: string; step: boolean; call?: boolean }

/** `capped`: 隔着过程框的终句气泡头上带一行时刻 + 本轮的账 (rolepage 的消息要,
 *  自带 .tg-head 的独立片段不要)。 */
const turnParts = (r: TurnDetailRecord, keyPrefix = "", now = Date.now(), lazy = false, capped = false, deco?: HandoffDeco): {
  parts: Part[];
  /** parts[i] 对应的时刻 —— 子 agent 卡片按它插回父轮时间轴。 */
  stamps: number[];
  done: boolean;
  chips: string;
} => {
  const items = [...r.items].sort((a, b) => a.ts - b.ts);
  const paired = pairItems(items);
  // data-key = 稳定项键 (items 只追加、按 ts 单调, 位置永不前移 → 索引稳定唯一)。
  // 客户端 reconcile 按此键复用未变气泡的 DOM 节点, 从而保住用户手动展开/折叠的 <details>。
  // 结束判定统一收在 chat-view.turnDone (closed / final text / 静默超时), 详情页
  // 与聊天视图必须给出同一个答案 —— 否则一个显示「进行中」另一个显示「已完成」。
  const done = turnDone(r, now);
  const chips = usageChips(r, done, (done ? r.updatedAt : now) - r.createdAt);
  // 终句 = 不带工具调用的那次应答 (end_turn → final)。说不清 final 的后端 (软收口)
  // 退一步: 一轮结束后, 最后一个动作之后的话就是终句。
  const lastAct = paired.reduce((n, p, i) => (p.kind === "solo" && p.item.t === "text" ? n : i), -1);
  const isSay = (p: (typeof paired)[number], i: number): boolean =>
    p.kind === "solo" && p.item.t === "text" && (p.item.final === true || (done && i > lastAct));
  const body = (p: (typeof paired)[number], key: string, i: number): string => {
    if (p.kind === "pair") return renderToolBubble(p.use, p.result, key, done, lazy ? r.id : undefined, deco);
    const it = p.item;
    if (it.t === "text") return isSay(p, i) ? renderSay(it, key, capped && i > 0 ? chips : undefined) : renderNote(it, key);
    if (it.t === "approval") return renderApprovalItem(it, key);
    if (it.t === "tool_result") {
      return `<section class="bubble tool" data-key="${key}">
        <div class="bubble-head">↩ <span class="role">tool_result</span>
          <span class="compact">${escHtml(it.toolUseId)}</span>
          <span class="ts">${fmtTs(it.ts)}</span></div>
        <details open><summary>result</summary><pre><code>${prettyJsonHtml(it.body) || escHtml(it.body)}</code></pre></details>
      </section>`;
    }
    return "";
  };
  const parts = paired.map((p, i): Part => {
    const key = `${keyPrefix}b${i}`;
    return {
      key, html: tagSig(body(p, key, i)),
      step: !isSay(p, i),
      call: p.kind === "pair",
    };
  });
  const stamps = paired.map((p) => (p.kind === "pair" ? p.use.ts : p.item.ts));
  return { parts, stamps, done, chips };
};

const CUT_TEXT: Record<CtxCut, string> = {
  clear: "上下文已清空 · /clear",
  new: "新会话 · /new",
  switch: "会话已轮换",
};

// 断点条挂在 turn 卡片顶部而不是两卡之间 —— 片段必须始终只有一个根节点, chat.js 的
// upsertTurn/reconcile 是按 data-key 认领整个 turn-group 的, 多根会让它取错节点。
const renderCut = (r: TurnDetailRecord): string =>
  r.cut
    ? `<div class="tg-cut ${r.cut}"><span class="l">${escHtml(CUT_TEXT[r.cut])}</span>${
        r.sessionId ? `<span class="s">${escHtml(r.sessionId.slice(0, 8))}</span>` : ""
      }</div>`
    : "";

// 归因条: 这一轮不是人打的字。userQuery 长得和真人消息一模一样, 没有这一条就分不出
// 「有人在跟 #fix 说话」和「graph 第 3 轮把 #review 的回复喂了过来」。
const renderOrigin = (r: TurnDetailRecord): string => {
  const o = r.origin;
  if (!o) return "";
  const from = o.fromTag ? ` <span class="f">← ${escHtml(`#${o.fromTag}`)}</span>` : "";
  return `<div class="tg-graph"><span class="l">🕸 graph <code>${escHtml(o.runId)}</code></span>` +
    `<span class="s">轮 ${o.round}/${o.rounds} · 步 ${o.step}/${o.steps}</span>${from}</div>`;
};

// subagent 归属条: 这一轮是 Task/Agent 工具派出的子 agent 跑的。与断点/归因条同一
// 视觉语法, 用绿色 —— 三种横条各讲一件事 (上下文断点/谁派的/谁执行的), 必须一眼分得开。
const renderAgent = (r: TurnDetailRecord): string => {
  const g = r.agent;
  if (!g) return "";
  const type = g.type ? ` · ${escHtml(g.type)}` : "";
  const desc = g.description ? `<span class="s">${escHtml(g.description.slice(0, 80))}</span>` : "";
  return `<div class="tg-agent"><span class="l">🤖 subagent${type}</span>${desc}</div>`;
};

// 一句话尾巴上的 `<system-reminder>`: 默认收成一个 `<reminder>` 标签, 点一下展开原文。
// 两面都在 HTML 里, 切换只是节点上的一个 class —— 同过程框的收起态, reconcile 留节点就留住它。
const renderReminder = (r: Reminder): string =>
  `<div class="rem" title="点击展开 / 收起"><span class="rem-tag">&lt;reminder&gt;</span>` +
  `<pre class="rem-raw">${escHtml(r.raw.trim())}</pre></div>`;

/** 把一句输入拆成正文与它挂着的 reminder 块 (没有就是 "")。 */
export const splitReminders = (text: string): { body: string; html: string } => {
  const rs = parseReminders(text);
  return rs.length
    ? { body: stripReminders(text), html: `<div class="rems">${rs.map(renderReminder).join("")}</div>` }
    : { body: text, html: "" };
};

// ── Chat 线程视图用的单 turn 片段 ──────────────────────────────────────
// 线程里一个 turn 只留一条分隔头 (时间 / model / 状态 / 本轮 token), 总账走页脚 status bar。
// 返回 html + sig, 让客户端按 sig 判断"这条 turn 变没变", 不用 diff 整段 DOM。
//
// 数据分两级下发: 片段里的工具调用只有摘要行 + ⎿ 预览, 展开正文由客户端在展开那一刻
// 向 /api/tool 取。窗口一次要上屏几十轮, 而正文占了片段体积的绝大部分却默认收着 ——
// 先给骨架, 上屏就不必等它们渲染和传输。
export interface TurnFragment {
  id: string;
  html: string;
  /** 本轮的账: 进行中的呼吸点 + 模型 / token / 耗时。独立片段把它画在自己头上,
   *  rolepage 的消息把它交给消息行 (见 renderTurnGroup 的 `standalone`)。 */
  meta: string;
  sig: string;
  createdAt: number;
  updatedAt: number;
  done: boolean;
  /** 见 chat-view.staleAt: 无新写入时本轮到点自动算结束。0 = 已结束。
   *  SSE 只在有写入时推送, 靠它客户端才能自行把「正在思考」熄掉。 */
  staleAt: number;
}

// 子 agent 卡片按 createdAt 插回父轮的气泡序列: 派发那一刻之后、下一条父轮动作
// 之前。子卡片挂在时间轴中间而不是整轮末尾 —— 否则父 agent 在 Task 返回后继续
// 调的工具会排在子卡片上面, 整段读起来就是倒序 (最新的反而不在最下面)。
const spliceChildren = (
  parts: readonly Part[],
  stamps: readonly number[],
  children: readonly TurnFragment[],
): Part[] => {
  const between = (lo: number, hi: number): Part[] =>
    children.filter((c) => c.createdAt >= lo && c.createdAt < hi)
      .map((c) => ({ key: `t:${escHtml(c.id)}`, html: c.html, step: true }));
  return parts.reduce<Part[]>(
    (acc, p, i) => [...acc, p, ...between(stamps[i] ?? 0, stamps[i + 1] ?? Infinity)],
    // stamps 之前就开跑的子 agent (父轮第一条 item 尚未落盘) 排在最前。
    between(-Infinity, stamps[0] ?? Infinity),
  );
};

// 过程框。键取首段的键 —— items 只追加, 一段过程的开头不会变, 往里添调用时框还是
// 同一个节点 (客户端的收起态挂在它身上)。头 + .bubbles 的骨架与 turn-group 同构,
// reconcile 才能只换头、逐条对内层, 而不是整框重建。
//
// `settled`: 这段过程下面已经有东西了 (终句), 或这一轮已经结束 —— 只有最末尾、还在
// 进行中的那一段默认展开, 其余一律收起。`data-fold` 是给
// 客户端的一次性信号: 已在屏上的框在它出现的那一刻收起一次, 之后用户再点开就不再管。
const renderSteps = (run: readonly Part[], key: string, settled: boolean): string => {
  const calls = run.filter((p) => p.call).length;
  return tagSig(`<div class="steps${settled ? " folded" : ""}" data-key="${key}:g"${settled ? " data-fold" : ""}><button type="button" class="steps-head">` +
    `${calls ? `${calls} 次工具调用` : "过程"}</button>` +
    `<div class="bubbles">${run.map((p) => p.html).join("")}</div></div>`);
};

/** 连着的过程段合成一个框, 终句一段一颗气泡。 */
const foldSteps = (parts: readonly Part[], done: boolean): string[] =>
  parts.reduce<Part[][]>((runs, p) => {
    const last = runs[runs.length - 1];
    return last?.[0]?.step && p.step ? [...runs.slice(0, -1), [...last, p]] : [...runs, [p]];
  }, []).flatMap((run, i, runs) => {
    const [head] = run;
    // 过程段之间必隔着终句, 所以「后面还有一段」= 后面跟了终句。
    return head ? [head.step ? renderSteps(run, head.key, done || i < runs.length - 1) : head.html] : [];
  });

/** `standalone=false`: 这一轮是 rolepage 的一条消息, 不是自成一体的一段 —— 问的那句
 *  由发话方那条气泡承载, 本轮的账 (`meta`) 由消息行的 .mwho 承载, 片段里都不再带。 */
export const renderTurnGroup = (
  r: TurnDetailRecord,
  now = Date.now(),
  children: readonly TurnFragment[] = [],
  standalone = true,
  deco?: HandoffDeco,
): TurnFragment => {
  const { parts, stamps, done, chips } = turnParts(r, `${r.id}:`, now, true, !standalone, deco);
  const q = splitReminders(r.userQuery ?? "");
  const queryBubble = r.userQuery && standalone
    ? `<section class="bubble user" data-key="${r.id}:user">
        <div class="bubble-head">💬 <span class="role">User</span></div>
        <div class="q-body">${escHtml(q.body)}</div>${q.html}
      </section>`
    : "";
  const typing = done ? "" : `<div class="typing" data-key="${r.id}:typing">${escHtml(backendLabel(r.cli))} 正在思考</div>`;
  // 子卡片已是完整片段 (自带 data-key/data-sig), 不再过 tagSig。
  const inner = [tagSig(queryBubble), ...foldSteps(spliceChildren(parts, stamps, children), done), tagSig(typing)].join("");
  const meta = `<span class="tg-dot${done ? "" : " live"}"></span>${chips}`;
  const head = standalone ? `<div class="tg-head">${meta}</div>` : "";
  // staleAt 只走 JSON, 绝不进 HTML —— 它跟着 updatedAt 变, 一旦计入 sig, SSE 的
  // "内容没变就不重发" 会彻底失效 (一个 turn 的 HTML 可以是几十 KB)。
  // `ping` 只是个标记 —— 连续几轮折成一行由客户端做 (它才知道相邻是谁)。
  const body = `<section class="turn-group${r.cut ? ` cut cut-${r.cut}` : ""}${r.origin ? " graph" : ""}${r.agent ? " subagent" : ""}${isKeepaliveTurn(r) ? " ping" : ""}" data-key="t:${escHtml(r.id)}">${renderCut(r)}${renderOrigin(r)}${renderAgent(r)}${head}<div class="bubbles">${inner}</div></section>`;
  return {
    id: r.id, html: tagSig(body), meta, sig: hashStr(body + meta),
    createdAt: r.createdAt, updatedAt: r.updatedAt,
    done, staleAt: done ? 0 : staleAt(r),
  };
};

// 独立断点行 —— 与卡片头上的 tg-cut 同一视觉语法, 只是不依附任何一轮:
// 清空发生在两轮之间, 它就该画在两张卡片之间。
export const renderCutMark = (m: MarkDetailRecord): TurnFragment => {
  const body = `<div class="tg-mark cut-${m.cut}" data-key="m:${escHtml(m.id)}"><span class="l">${
    escHtml(CUT_TEXT[m.cut])
  }</span><span class="s">${escHtml(fmtTs(m.createdAt))}</span></div>`;
  return {
    id: m.id, html: tagSig(body), meta: "", sig: hashStr(body),
    createdAt: m.createdAt, updatedAt: m.createdAt, done: true, staleAt: 0,
  };
};

/** 一轮的账 (模型 / ctx / 耗时) —— 与这一轮出消息名字行上的同一份。 */
export const turnUsageChips = (r: TurnDetailRecord, now = Date.now()): string => {
  const done = turnDone(r, now);
  return usageChips(r, done, (done ? r.updatedAt : now) - r.createdAt);
};

export { escHtml, fmtTs, fmtDuration, fmtTok, hashStr, tagSig, TURN_CSS };

export const renderDetailPage = (r: DetailRecord): string => {
  if (r.kind === "tool") return renderToolPage(r);
  // turn / 断点标记 / 聊天票据都没有自己的页面 —— 前两者只是 rolepage 线程里的
  // 一张卡片 / 一行, 票据只出现在 /role 的 `?id=` 上。
  if (r.kind === "turn" || r.kind === "mark" || r.kind === "post" || r.kind === "chat" || r.kind === "charter") return renderNotFound(r.id);
  return renderApprovalPage(r);
};

export const renderNotFound = (id: string): string =>
  `<!doctype html><meta charset="utf-8"><body style="font:14px -apple-system,sans-serif;background:#f6f8fa;color:#1f2328;padding:60px 20px;text-align:center"><p style="color:#656d76">未找到 <code style="background:#fff;border:1px solid #d0d7de;border-radius:4px;padding:2px 6px;font-family:ui-monospace,monospace">${escHtml(id)}</code></p></body>`;
