// 危险名单的「命令文本预处理」(人 2026-11-25: 近 24h 82 张 danger 卡里真有必要的约 4 张,
// 根因是名单对**整段命令文本**做匹配 —— heredoc 里写给 cat 的正文、grep 的检索词、echo 的
// 字样都被当成要执行的命令)。纯函数, 只做文本变换, 不做判定; 判定留在 danger.ts。
//
// 取舍原则 = 宁可多发卡也不漏报: 认不出消费者的 heredoc 体保留、没找到结束行的保留、
// 管道把内容转给别的命令的保留 —— 只有「明确只是数据」的文本才被抹掉。

// 包装器 (自己不干事, 只把后面的命令包一层跑): danger.ts 的命令词位置前缀与这里的首词判定共用一份。
export const WRAPPER_NAMES = String.raw`sudo|doas|nohup|exec|xargs|env|time|command|builtin|timeout|nice|ionice|stdbuf|setsid|watch|caffeinate|do|then|else`;
const COMMAND_WRAPPERS = new Set(WRAPPER_NAMES.split("|"));

const MAX_LEN = 200_000; // 超长文本不做词法 (原样返回 = 回到老口径, 方向安全)

const baseName = (w: string): string => w.replace(/^\\/, "").replace(/^.*\//, "");
const unquoteHead = (w: string): string => w.replace(/^["'`($]+/, "");

/** 一段命令 (到分隔符为止) 的首词序列: 跳过 `K=V` 赋值与包装器 (及其选项)。 */
export const leadWords = (seg: string): string[] => {
  const toks = seg.trim().split(/\s+/).filter(Boolean).map(unquoteHead);
  let i = 0;
  while (i < toks.length) {
    const w = toks[i]!;
    if (/^\w+=/.test(w)) { i++; continue; }
    if (COMMAND_WRAPPERS.has(baseName(w))) {
      i++;
      while (i < toks.length && /^(?:-\S*|\d+(?:\.\d+)?[smhd]?|\w+=\S*)$/.test(toks[i]!)) i++;
      continue;
    }
    break;
  }
  const rest = toks.slice(i);
  return rest.length ? [baseName(rest[0]!), ...rest.slice(1)] : [];
};

// git 的子命令: 跳过 `-C dir` / `-c k=v` 与其它选项后的第一个词。
const gitSub = (words: string[]): string | undefined => {
  const args = words.slice(1);
  const at = args.findIndex((w, i) => !w.startsWith("-") && !(i > 0 && /^-[Cc]$/.test(args[i - 1]!)));
  return at < 0 ? undefined : args[at];
};

// ── heredoc 消费者 ─────────────────────────────────────────────────────
// 只有「把正文当数据」的消费者才抹体; 把正文当脚本执行的 (shell / ssh / 数据库客户端 /
// 容器 exec …) 与认不出的一律保留。cat / tee 只是搬运工: 管道再往下送就保留。
type Consumer = { strip: boolean; relay: boolean };
const DATA_ONLY = /^(?:python[\d.]*|node|nodejs|tsx|deno|bun)$/;
const EXEC_SINK = new Set([
  "eval", "bash", "sh", "zsh", "dash", "ksh", "source", ".", "ssh", "su", "xargs", "psql", "mysql",
  "sqlite3", "mx", "docker", "kubectl", "podman", "nsenter", "chroot", "watch", "screen", "tmux",
]);

const consumerOf = (seg: string): Consumer => {
  const w = leadWords(seg);
  const w0 = w[0] ?? "";
  if (w0 === "cat" || w0 === "tee") return { strip: true, relay: true };
  if (DATA_ONLY.test(w0)) return { strip: true, relay: false };
  if (w0 === "gh") return { strip: true, relay: false };
  if (w0 === "git" && ["commit", "tag", "notes"].includes(gitSub(w) ?? "")) return { strip: true, relay: false };
  return { strip: false, relay: false };
};

// ── 「只是模式 / 字样」的命令 ───────────────────────────────────────────
// grep 族的引号参数是检索词, echo / printf 的是要打印的字; 两者里的危险词不是动作。
// 例外 (保留, 不抹):
//   · 引号串像文件操作数 (含 `/` 或以 ~ $ . 开头): `grep KEY "$HOME/app/.env"` 的文件名要继续被看见;
//   · 重定向目标 (`echo x > "~/.ssh/authorized_keys"`);
//   · echo / printf 把内容送进管道 (`echo "DROP DATABASE x" | psql`) —— 内容就是命令;
//   · `rg --pre cmd` 这类让检索工具去执行外部命令的开关;
//   · `$(…)` / 反引号 —— 命令替换会执行, 不抹。
type Quiet = "grep" | "echo" | undefined;
const GREP_FAMILY = new Set(["grep", "egrep", "fgrep", "zgrep", "rg", "ag", "ack"]);
const quietKind = (seg: string): Quiet => {
  const w = leadWords(seg);
  const w0 = w[0] ?? "";
  if (GREP_FAMILY.has(w0)) return "grep";
  if (w0 === "echo" || w0 === "printf") return "echo";
  if (w0 === "git" && gitSub(w) === "grep") return "grep";
  return undefined;
};
const looksLikeOperand = (s: string): boolean => /\/|^[~$.]/.test(s);

interface Frame {
  kind: "cmd" | "dq" | "arith";
  close: string;
  segStart: number;
  quiet: boolean;
  sink: boolean; // 祖先里有「把输出当脚本跑」的命令: 里面的 heredoc 体不能抹
  lead: string;
}
interface Pending { tag: string; dash: boolean; strip: boolean; relay: boolean; piped: boolean }

const HEREDOC = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([\w.-]+))/;

/**
 * 抹掉明确只是数据的文本, 其余原样保留:
 *   1. heredoc 体 (消费者是 cat / tee / python / node / git commit …);
 *   2. grep 族 / echo / printf 的引号参数 (模式 / 字样)。
 * 抹掉后命令骨架 (`cat > f <<'EOF'`、`grep -n ""`) 仍在, 其中的真命令照常被名单看见。
 */
export const scrubCommand = (src: string): string => {
  if (src.length > MAX_LEN) return src;
  let out = "";
  const stack: Frame[] = [{ kind: "cmd", close: "", segStart: 0, quiet: false, sink: false, lead: "" }];
  let pending: Pending[] = [];
  let i = 0;
  const top = (): Frame => stack[stack.length - 1]!;
  const segOf = (f: Frame): string => out.slice(f.segStart);

  const push = (kind: Frame["kind"], close: string, from: Frame): void => {
    const lead = from.kind === "cmd" ? (leadWords(segOf(from))[0] ?? "") : from.lead;
    stack.push({ kind, close, segStart: out.length, quiet: false, sink: from.sink || EXEC_SINK.has(lead), lead });
  };
  const restOfSegment = (at: number): string => src.slice(at, at + 4000).split(/\n|;/, 1)[0] ?? "";
  // 要不要把这个引号串抹成空 (content = 引号里的字面内容)。
  const blank = (f: Frame, content: string, at: number): boolean => {
    const kind = quietKind(segOf(f));
    if (!kind) return false;
    if (/[<>]\s*$/.test(out.slice(-32))) return false; // 重定向目标 (只看尾巴: 整串扫是 O(n²))
    const rest = restOfSegment(at);
    if (kind === "echo") return !/\|(?!\|)/.test(rest);
    return !looksLikeOperand(content) && !/--pre\b/.test(segOf(f) + rest);
  };

  const readHeredocs = (): void => {
    for (const p of pending) {
      const start = i;
      let closed = false;
      while (i < src.length && !closed) {
        const nl = src.indexOf("\n", i);
        const end = nl < 0 ? src.length : nl;
        const probe = (p.dash ? src.slice(i, end).replace(/^\t+/, "") : src.slice(i, end)).replace(/\r$/, "");
        i = nl < 0 ? src.length : nl + 1;
        closed = probe === p.tag;
      }
      // 没找到结束行 = 可能是屏面截断 / 误判, 保留; 管道往下送的 cat / tee 保留。
      const drop = closed && p.strip && !(p.relay && p.piped);
      if (!drop) out += src.slice(start, i);
    }
    pending = [];
  };

  while (i < src.length) {
    const c = src[i]!;
    const t = top();

    if (t.kind === "dq") {
      if (c === "\\") { if (!t.quiet) out += src.slice(i, i + 2); i += 2; continue; }
      if (c === '"') { out += c; stack.pop(); i++; continue; }
      if (c === "$" && src.startsWith("$((", i)) { out += "$(("; push("arith", "))", t); i += 3; continue; }
      if (c === "$" && src[i + 1] === "(") { out += "$("; push("cmd", ")", t); i += 2; continue; }
      if (c === "`") { out += c; push("cmd", "`", t); i++; continue; }
      // 只是字样的引号串里, `$VAR` 展开后仍是内容: 名字留着 (`echo "$U"` 的 $U 会把读到的值回显), 其余字样照抹。
      const ref = t.quiet && c === "$" ? /^\$(?:\{[A-Za-z_]\w*\}|[A-Za-z_]\w*)/.exec(src.slice(i, i + 80)) : null;
      if (ref) { out += ref[0]; i += ref[0].length; continue; }
      if (!t.quiet) out += c;
      i++;
      continue;
    }

    if (t.kind === "arith") {
      if (src.startsWith("))", i)) { out += "))"; stack.pop(); i += 2; continue; }
      out += c;
      i++;
      continue;
    }

    // cmd 帧
    if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) { out += src.slice(i); i = src.length; continue; }
      const content = src.slice(i + 1, j);
      out += blank(t, content, j + 1) ? "''" : src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const j = src.indexOf('"', i + 1);
      const content = j < 0 ? src.slice(i + 1) : src.slice(i + 1, j);
      const quiet = blank(t, content, j < 0 ? src.length : j + 1); // 先判再写: 判据要看引号之前的文本
      out += c;
      push("dq", '"', t);
      top().quiet = quiet;
      i++;
      continue;
    }
    if (c === "`") {
      if (t.close === "`") { out += c; stack.pop(); } else { out += c; push("cmd", "`", t); }
      i++;
      continue;
    }
    if (c === "$" && src.startsWith("$((", i)) { out += "$(("; push("arith", "))", t); i += 3; continue; }
    if (c === "$" && src[i + 1] === "(") { out += "$("; push("cmd", ")", t); i += 2; continue; }
    if (c === "(") { out += c; push("cmd", ")", t); i++; continue; }
    if (c === ")") {
      out += c;
      if (t.close === ")" && stack.length > 1) stack.pop();
      i++;
      continue;
    }
    if (c === "#" && (out === "" || /[\s;&|(]/.test(out.slice(-1)))) { // 注释到行尾 (不吞换行)
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? src.length : nl;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
      const m = HEREDOC.exec(src.slice(i, i + 200));
      if (m) {
        const tag = m[2] ?? m[3] ?? m[4] ?? "";
        const who = consumerOf(segOf(t));
        pending.push({ tag, dash: m[1] === "-", strip: who.strip && !t.sink, relay: who.relay, piped: false });
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (c === "\n") {
      out += c;
      i++;
      if (pending.length) readHeredocs();
      t.segStart = out.length;
      continue;
    }
    if (c === "|" || c === ";" || (c === "&" && !/[<>]/.test(src[i - 1] ?? "") && src[i + 1] !== ">")) {
      if (c === "|" && src[i + 1] !== "|" && src[i - 1] !== "|") pending.forEach((p) => { p.piped = true; });
      out += c;
      i++;
      t.segStart = out.length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
};

/** shell 词切分 (去引号, 引号未闭合吞到末尾) —— 给 pkill 这类要看清「参数是哪几个词」的规则用。 */
export const shellWords = (s: string): string[] => {
  const words: string[] = [];
  let cur = "";
  let has = false;
  let q = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === q) q = "";
      else if (c === "\\" && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') { q = c; has = true; }
    else if (c === "\\" && i + 1 < s.length) { cur += s[++i]; has = true; }
    else if (/\s/.test(c)) { if (has) words.push(cur); cur = ""; has = false; }
    else { cur += c; has = true; }
  }
  if (has) words.push(cur);
  return words;
};
