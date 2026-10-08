// Interactive, ground-truth model selection for a live pane — the path a
// running wizard switches through (`set_model`), and a spawn's fallback.
//
// A spawn passes whatever it was asked with `--model` first; the CLI doesn't
// reject an unknown slug at launch — it comes up echoing it raw and only fails
// on the first real turn ("400 model [...] service info not found") — so
// spawn-tmux reads that echo, relaunches bare and lands here. `/model <name>` is validated but only
// takes the CLI's own aliases / ids: the labels its picker shows ("Opus 4.7",
// "Sonnet 5") are NOT names it accepts, so a name rebuilt from a label is a
// guess. The picker itself is the only thing that is both complete and
// guaranteed selectable — so we drive it the way a human does:
//
//   bare `/model` → read every row (scrolling the window) → pick the row
//   closest to what was asked → arrow onto it → select → read the receipt.
//
// A caller's model string is colloquial ("最新的 opus", "sonnet 5",
// "claude-haiku-4-5"); it is matched against the LIVE rows, never a table in
// this file — a brand-new family works the day it ships.
//
// The picker has two select keys, and they are the two scopes a caller can ask
// for: `s` = this session only, Enter = also the user's default for every new
// session (the CLI writes `model` into its settings.json). "session" is the
// default scope — one wizard going to haiku must not drag every later spawn
// with it. A picker that offers no `s` only has Enter; the receipt says which
// one actually happened.
import type { Logger } from "pino";
import { isModalPane } from "../shared/modal-pane.js";
import { sleep } from "../shared/std.js";
import { EFFORTS, parseEffort, type Effort } from "../shared/effort.js";
import { runTmux } from "./spawn-tmux.js";

const POLL_MS = 200;
const OPEN_TIMEOUT_MS = 6000;
const SETTLE_TIMEOUT_MS = 8000;
const CLOSE_TIMEOUT_MS = 3000;
const ARROW_STEP_MS = 350; // faster repeats get dropped/coalesced by the TUI — this is the empirically-verified floor
const MAX_STEPS = 60; // > any plausible catalog size, even with a few dropped arrows

// Two renders of the same picker have to be read: the older one titles itself
// with a bare "Select model" and numbers its rows; the current one carries the
// scope tabs in the title ("Select Model   Global   Session  (Tab/←→ to switch)")
// and prints each row's id with no numbers:
//   "   ❯ Hy4 preview            【hy4-preview-ioa】            (x0.00 credits) ✔"
// A render we can't parse is a render we never select from — and the caller is
// told nothing changed while the pane silently keeps the wrong model.
const HEADER_RE = /^\s*Select Model\b/iu;
const FOOTER_RE = /Esc to (?:cancel|exit)/u;
const SESSION_ONLY_RE = /\bs to use this session only/u;
// "   ❯ 2.  Opus 5.5 ✔             For complex work and everyday tasks" and its
// scrolled-window siblings ("↑ 3. …" / "↓ 10. …"): mark, number, label,
// current-model tick, description.
const ROW_RE = /^\s*([❯>↑↓])?\s*(\d+)\.\s+(.+?)(?:\s+(✔))?(?:\s{2,}(.*))?$/u;
// The current render: mark, label, 【id】, credits, current-model tick.
const ID_ROW_RE = /^\s*([❯>↑↓])?\s*(.+?)\s+【([^】]+)】(?:[ \t]*\([^)]*\))?[ \t]*(✔)?\s*$/u;
// The line under the title says which tab the picker is on: "Switch model for
// this session only (won't persist)." / "Select a model for all future sessions."
// Enter applies to THAT tab — applying the wrong one rewrites the machine-wide
// default, so a caller asking for "session" must never Enter on "Global".
const SCOPE_SESSION_RE = /for this session only/u;
const SCOPE_GLOBAL_RE = /for all future sessions/u;
const MORE_RE = /^\s*…\s*\+\d+\s+models?\b/u;
// Switching away from a model the conversation is cached on asks once more:
// "Switch model? … ❯ 1. Yes, switch to X / 2. No, go back".
const CONFIRM_RE = /^\s*Switch model\?\s*$/u;
const CONFIRM_LAST_RE = /^\s*[❯>]?\s*2\.\s+No\b/u;
// Receipts seen so far: "Set model to X" / "Kept model as X" (numbered render),
// "Switch model to X (this session only)" and "Switched this session to X."
// (2.143, the latter right after a fresh launch).
const READBACK_RE = /(?:Set model to|Kept model as|Switch model to|Switched (?:this session )?to) .+/u;
const APPLIED_RE = /^(?:Set model to|Switch model to|Switched\b)/u;
// "… (this session only)" / "… for this session only" / "Switched this session to …".
const SESSION_RECEIPT_RE = /\bthis session\b/u;

export type ModelScope = "session" | "default";

export interface ModelRow {
  n: number;
  label: string;
  desc: string;
  /** The id the current render prints in 【】; absent on the numbered render. */
  id?: string;
  /** Carries the picker's ✔ — the model the pane is on right now. */
  current: boolean;
}

interface Frame {
  rows: ModelRow[];
  /** Row number under the cursor; 0 = not visible in this frame. */
  cursor: number;
  /** The window shows the catalog's last row (no "↓" edge, no "… +N models"). */
  bottom: boolean;
  sessionOnly: boolean;
  /** Rows were read off 【id】 — they carry no catalog numbers, so navigation
   *  walks the cursor instead of jumping to a number. */
  byId: boolean;
  /** Which tab the picker is on. Undefined when the render says nothing about
   *  scope — then Enter is the only key and its scope is whatever it is. */
  scope?: ModelScope;
}

const linesOf = (screen: string): string[] => screen.split("\n").map((l) => l.trimEnd()).filter(Boolean);

/** The picker as it stands on screen, or undefined when it isn't open. A real
 *  picker always hugs the bottom of the screen — its footer is the last line.
 *  The same text merely printed into the transcript (a tool result quoting a
 *  pane) is always followed by the input box, and must never be mistaken for
 *  one: we'd arrow through the input history and Esc a running turn. */
export const parseFrame = (screen: string): Frame | undefined => {
  const lines = linesOf(screen);
  const head = lines.map((l) => HEADER_RE.test(l)).lastIndexOf(true);
  const foot = lines.at(-1) ?? "";
  if (head < 0 || !FOOTER_RE.test(foot)) return undefined;
  const body = lines.slice(head + 1);
  const idHits = body.map((l) => ID_ROW_RE.exec(l)).filter((m): m is RegExpExecArray => !!m);
  if (idHits.length) {
    const at = idHits.findIndex((m) => m[1] === "❯" || m[1] === ">");
    return {
      rows: idHits.map((m, i) => ({ n: i + 1, label: m[2]!.trim(), id: m[3]!.trim(), desc: "", current: !!m[4] })),
      cursor: at < 0 ? 0 : at + 1,
      // No "… +N models" marker and no ↓ edge on this render, so there is no
      // "last row" to read — navigation doesn't need one.
      bottom: true,
      sessionOnly: false,
      byId: true,
      scope: body.some((l) => SCOPE_SESSION_RE.test(l))
        ? "session"
        : body.some((l) => SCOPE_GLOBAL_RE.test(l)) ? "default" : undefined,
    };
  }
  const hits = body.map((l) => ROW_RE.exec(l)).filter((m): m is RegExpExecArray => !!m);
  return {
    rows: hits.map((m) => ({ n: Number(m[2]), label: m[3]!.trim(), desc: (m[5] ?? "").trim(), current: !!m[4] })),
    cursor: Number(hits.find((m) => m[1] === "❯" || m[1] === ">")?.[2] ?? 0),
    bottom: !body.some((l) => MORE_RE.test(l)) && !hits.some((m) => m[1] === "↓"),
    sessionOnly: SESSION_ONLY_RE.test(foot),
    byId: false,
    scope: SESSION_ONLY_RE.test(foot) ? "session" : undefined,
  };
};

const isConfirm = (screen: string): boolean => {
  const lines = linesOf(screen);
  return CONFIRM_LAST_RE.test(lines.at(-1) ?? "") && lines.some((l) => CONFIRM_RE.test(l));
};

const readbacks = (screen: string): string[] =>
  linesOf(screen).flatMap((l) => READBACK_RE.exec(l)?.[0].trim() ?? []);

const familyOf = (s: string): string => (/[a-z]+/iu.exec(s)?.[0] ?? "").toLowerCase();

// "claude-haiku-4-5-20251001" → "4.5", "Opus 5.5" → "5.5", "opus[1m]" → "".
const versionOf = (s: string): string =>
  (/\d+(?:[.-]\d+)*/u.exec(s.replace(/-\d{8}\b/u, "").replace(/\[?1m\]?/giu, ""))?.[0] ?? "").replace(/-/gu, ".");

// exact > same line ("5" ↔ "5.5") > no version asked > the numerically nearest.
const versionFit = (want: string, have: string): number => {
  if (!want) return 1;
  if (want === have) return 3;
  if (have.startsWith(`${want}.`) || (have && want.startsWith(`${have}.`))) return 2;
  const d = Math.abs(Number.parseFloat(want) - Number.parseFloat(have));
  return Number.isNaN(d) ? 0 : -d;
};

/** The row closest to a colloquial request: the family word has to be there
 *  ("opus" / "haiku" / "default" / "默认"), the version only ranks. Ties go to
 *  the earlier row — the picker lists each family newest first, which is what
 *  makes a bare "opus" (or "最新的 opus") land on the latest one. */
export const closestModel = (rows: readonly ModelRow[], wanted: string): ModelRow | undefined => {
  const want = wanted.toLowerCase();
  const words = new Set([...(want.match(/[a-z]+/gu) ?? []), ...(/默认/u.test(want) ? ["default"] : [])]);
  const ver = versionOf(want);
  // An id is the strongest evidence there is: "deepseek-v4.1-flash" names one
  // row outright. Anything else is a family word ("sonnet") that only narrows
  // the field — the id is part of what it is matched against, since a bare
  // family name is often nowhere in the label ("claude-sonnet-5.5").
  const fit = (r: ModelRow): number => (r.id?.toLowerCase() === want ? 100 : versionFit(ver, versionOf(r.label)));
  const named = (r: ModelRow): string => `${r.label} ${r.id ?? ""}`.toLowerCase();
  return rows
    .filter((r) => words.has(familyOf(r.label)) || [...words].some((w) => named(r).includes(w)))
    .reduce<ModelRow | undefined>((best, r) => (!best || fit(r) > fit(best) ? r : best), undefined);
};

const screen = async (pane: string): Promise<string> => {
  const r = await runTmux(["capture-pane", "-t", pane, "-p"]);
  return r.ok ? r.stdout : "";
};

const key = (pane: string, k: string): Promise<unknown> => runTmux(["send-keys", "-t", pane, k]);

const until = async <T>(probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> => {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(POLL_MS)) {
    const v = await probe();
    if (v !== undefined) return v;
  }
  return undefined;
};

// The window shows ~10 rows of a longer list. Walking UP reaches the far end
// in the fewest steps: from the current model (near the top) it hits row 1,
// then wraps straight onto the last window.
const readCatalog = async (pane: string, seen: ReadonlyMap<number, ModelRow> = new Map(), bottom = false, left = MAX_STEPS): Promise<ModelRow[]> => {
  const f = parseFrame(await screen(pane));
  const all = new Map([...seen, ...(f?.rows ?? []).map((r) => [r.n, r] as const)]);
  const sawBottom = bottom || !!f?.bottom;
  // Numbers are 1..N, so "as many rows as the highest number" = no gap.
  const complete = sawBottom && all.size === Math.max(0, ...all.keys());
  if (!f?.rows.length || complete || left <= 0) return [...all.values()].sort((a, b) => a.n - b.n);
  await key(pane, "Up");
  await sleep(ARROW_STEP_MS);
  return readCatalog(pane, all, sawBottom, left - 1);
};

// One arrow at a time, re-reading the cursor after each: a dropped key costs
// one more step instead of a wrong model. The list wraps, so when the cursor
// sits on a row whose mark is hidden (cursor 0) any direction still gets there.
const moveTo = async (pane: string, n: number, left = MAX_STEPS): Promise<Frame | undefined> => {
  const f = parseFrame(await screen(pane));
  if (!f || f.cursor === n) return f;
  if (left <= 0) return undefined;
  await key(pane, f.cursor && n < f.cursor ? "Up" : "Down");
  await sleep(ARROW_STEP_MS);
  return moveTo(pane, n, left - 1);
};

// Esc is only safe while the picker is what's on screen — in a pane that is
// mid-turn, a stray Esc interrupts the turn. Returns once it is really gone,
// so whatever is typed into the pane next doesn't land in the picker.
const closePicker = async (pane: string): Promise<void> => {
  if (!parseFrame(await screen(pane))) return;
  await key(pane, "Escape");
  await until(async () => (parseFrame(await screen(pane)) ? undefined : true), CLOSE_TIMEOUT_MS);
};

/** Escape out of a picker even when its rows can't be read. Giving up on a
 *  selection HAS to leave the pane back at its prompt: left open, the picker
 *  swallows whatever is typed into the pane next — the wizard's first task
 *  never arrives, and it reads as a dead wizard rather than a mis-modelled one.
 *  Only ever Escs on a screen that is showing a picker footer. */
const dismissPicker = async (pane: string): Promise<void> => {
  const footer = async (): Promise<boolean> => FOOTER_RE.test(linesOf(await screen(pane)).at(-1) ?? "");
  if (!(await footer())) return;
  await key(pane, "Escape");
  await until(async () => ((await footer()) ? undefined : true), CLOSE_TIMEOUT_MS);
};

const cursorRow = (f: Frame): ModelRow | undefined => f.rows.find((r) => r.n === f.cursor);

const byIdMerge = (seen: readonly ModelRow[], rows: readonly ModelRow[]): ModelRow[] =>
  [...seen, ...rows.filter((r) => !seen.some((s) => s.id === r.id))];

/** The whole catalog of the 【id】 render. It normally fits on one screen (32
 *  rows here) and is read off the first frame; only when nothing on it fits the
 *  ask is the cursor walked one full lap — in case the list is windowed on a
 *  short pane — stopping the moment it wraps back onto the row it started on.
 *  (The old walk had no wrap check: a miss always burned all 60 steps, ~21s,
 *  and threw away what it had read.) */
const lapCatalog = async (pane: string, startId: string | undefined, seen: ModelRow[], left = MAX_STEPS): Promise<ModelRow[]> => {
  if (left <= 0) return seen;
  await key(pane, "Down");
  await sleep(ARROW_STEP_MS);
  const f = parseFrame(await screen(pane));
  if (!f) return seen;
  const all = byIdMerge(seen, f.rows);
  const at = cursorRow(f)?.id;
  return startId && at === startId ? all : lapCatalog(pane, startId ?? at, all, left - 1);
};

/** Arrow the cursor onto the row carrying `id`, re-reading after every key (a
 *  dropped arrow costs a step, not a wrong model). Direction comes from the
 *  frame when both rows are on it; otherwise keep going down — the list wraps. */
const moveToId = async (pane: string, id: string, left = MAX_STEPS): Promise<Frame | undefined> => {
  const f = parseFrame(await screen(pane));
  if (!f) return undefined;
  if (cursorRow(f)?.id === id) return f;
  if (left <= 0) return undefined;
  const to = f.rows.find((r) => r.id === id)?.n ?? 0;
  await key(pane, to && f.cursor && to < f.cursor ? "Up" : "Down");
  await sleep(ARROW_STEP_MS);
  return moveToId(pane, id, left - 1);
};

/** Why `want` matched no row — the words it was matched by, against what was there. */
const missReason = (want: string, catalog: readonly string[]): string => {
  const words = [...new Set(want.toLowerCase().match(/[a-z]+/gu) ?? [])];
  return `'${want}' 不在列表里: 读到 ${catalog.length} 项, 没有 id 与它相同, 也没有一项含 ${words.map((w) => `'${w}'`).join(" / ") || "可比的词"} (列表: ${catalog.join(" / ")})`;
};

/** Puts the picker on the tab a caller asked for. Enter applies to the tab that
 *  is showing, and the other one rewrites the model every new session starts
 *  on — so a caller asking for "session" must never Enter on "Global". */
const ensureScope = async (pane: string, scope: ModelScope, left = 4): Promise<ModelScope | undefined> => {
  const f = parseFrame(await screen(pane));
  if (!f) return undefined;
  if (!f.scope || f.scope === scope) return f.scope;
  if (left <= 0) return undefined;
  await key(pane, "Tab");
  await sleep(400);
  return ensureScope(pane, scope, left - 1);
};

// After the select key: answer the cache-warning confirm if it comes up, then
// wait for the picker to be gone and a receipt that wasn't there before.
const settle = (pane: string, before: string): Promise<string | undefined> =>
  until(async () => {
    const s = await screen(pane);
    if (isConfirm(s)) {
      await key(pane, "Enter");
      await sleep(800);
      return undefined;
    }
    if (parseFrame(s)) return undefined;
    const rbs = readbacks(s);
    return rbs.length && rbs.join("\n") !== before ? rbs.at(-1) : undefined;
  }, SETTLE_TIMEOUT_MS);

export interface ModelSelectResult {
  ok: boolean;
  /** What actually landed — the row's id when the render prints one
   *  ("claude-opus-5.5"), else its label ("Opus 5.5"). Persist THIS, not the
   *  caller's raw input: a respawn passes it straight to `--model`. */
  applied?: string;
  /** The row carrying the picker's ✔ when the picker was read — the model the
   *  pane is really on after a selection that did not land. */
  current?: string;
  /** Where it landed, per the CLI's own receipt — "default" also rewrote the
   *  model every NEW session starts on. Can differ from what was asked: a
   *  picker with no session-only key can only set the default. */
  scope?: ModelScope;
  /** Every label the picker offered, in its own order. */
  catalog?: string[];
  reason?: string;
}

/** Puts the pane on the model closest to `wanted` by driving its `/model`
 *  picker. Works on a pane that is mid-turn (the picker opens over a running
 *  turn), which is what lets a wizard switch itself. Never throws: a failed
 *  resolution leaves the pane on whatever model it already had. */
export const selectModel = async (pane: string, wanted: string, log: Logger, scope: ModelScope = "session"): Promise<ModelSelectResult> => {
  const want = wanted.trim();
  if (!want || !pane) return { ok: true };
  const start = await screen(pane);
  // Typed into a permission confirm, "/model⏎" would answer it.
  if (isModalPane(start).modal) return { ok: false, reason: "pane 正停在一个确认框上, 这时敲 /model 会按到它 —— 等它过去再切" };
  await runTmux(["send-keys", "-t", pane, "-l", "/model"]);
  await sleep(150);
  await key(pane, "Enter");
  const opened = await until(async () => parseFrame(await screen(pane)), OPEN_TIMEOUT_MS);
  if (!opened) {
    log.warn({ pane, wanted: want, tail: (await screen(pane)).slice(-300) }, "model-select: picker never opened");
    // A picker we couldn't read is still a modal: Esc out of it, or the very
    // next thing sent to this pane lands in the picker instead of the prompt.
    await dismissPicker(pane);
    return { ok: false, reason: "/model 的模型列表没有出现, 目录没读到" };
  }
  // Two renders, one goal: the best row for `want` over the WHOLE catalog (not
  // the first row that merely shares a word with it), sitting under the cursor.
  const firstRows = opened.byId && closestModel(opened.rows, want) ? opened.rows : undefined;
  const rows = opened.byId
    ? firstRows ?? (await lapCatalog(pane, cursorRow(opened)?.id, opened.rows))
    : await readCatalog(pane);
  const row = closestModel(rows, want);
  const catalog = rows.map((r) => r.id ?? r.label);
  const current = rows.find((r) => r.current);
  const currentKey = current ? current.id ?? current.label : undefined;
  log.info({ pane, wanted: want, scope, rows: rows.length, catalog, current: currentKey, match: row?.id ?? row?.label }, "model-select: read live catalog");
  const frame = !row ? undefined : opened.byId ? await moveToId(pane, row.id!) : (await moveTo(pane, row.n)) ?? undefined;
  const miss = async (reason: string): Promise<ModelSelectResult> => {
    await dismissPicker(pane);
    log.warn({ pane, wanted: want, rows: rows.length, current: currentKey, reason }, "model-select: no selection");
    return { ok: false, catalog, ...(currentKey ? { current: currentKey } : {}), reason };
  };
  if (!rows.length) return miss("选择器开了, 但一行也没认出来 —— 渲染多半又变了");
  if (!row) return miss(missReason(want, catalog));
  if (!frame) return miss(`列表 ${rows.length} 项里匹配到 '${row.id ?? row.label}', 但光标走了 ${MAX_STEPS} 步没停上去`);
  const applied = row.id ?? row.label;
  // Already on it: nothing to do for this session — but making it the default
  // still takes the Enter.
  if (row.current && scope === "session") {
    await closePicker(pane);
    return { ok: true, applied, scope, catalog };
  }
  // The tabbed render applies Enter to whichever tab is showing, and the other
  // one rewrites the default every new session starts on — so an ask for
  // "session" never Enters on "Global".
  if (frame.byId) {
    const on = frame.scope === scope ? frame.scope : await ensureScope(pane, scope);
    if (on !== scope) return miss(`选择器停在「${on ?? "未知"}」这一档, 按 Enter 会写到别处, 没按`);
  }
  await key(pane, !frame.byId && scope === "session" && frame.sessionOnly ? "s" : "Enter");
  const receipt = await settle(pane, readbacks(start).join("\n"));
  if (receipt && APPLIED_RE.test(receipt)) return { ok: true, applied, scope: SESSION_RECEIPT_RE.test(receipt) ? "session" : "default", catalog };
  log.warn({ pane, wanted: want, match: applied, receipt, tail: (await screen(pane)).slice(-300) }, "model-select: selection did not land");
  return { ok: false, catalog, ...(currentKey ? { current: currentKey } : {}), reason: receipt ? `选中 '${applied}' 后没有切换: ${receipt}` : `选中 '${applied}' 后没等到回执` };
};

// ── Effort: the `/effort` slider ─────────────────────────────────────────────
// `/effort <level>` is NOT session-scoped: it also rewrites the user's default
// for every new session (settings.json `modelSettings`). Only the slider's `s`
// key stays inside this session, so mid-session changes drive the slider —
// and a slider offering no `s` is backed out of, never confirmed with Enter.

const EFFORT_HEAD_RE = /^\s*Effort\s*$/u;
const EFFORT_SCALE_RE = new RegExp(EFFORTS.map((e) => `\\b${e}\\b`).join(".*"), "u");
const EFFORT_RECEIPT_RE = /Set effort level to (\w+)/u;
// Worded unlike the model picker's ("s to use this session only").
const EFFORT_SESSION_ONLY_RE = /\bs (?:for|to use) this session only/u;

interface Slider { at: Effort; sessionOnly: boolean }

/** The slider on screen, or undefined: header, a scale row naming every level,
 *  the ▲ marker right above it, and the footer hugging the bottom (same reason
 *  as `parseFrame`). The level under ▲ is the label whose centre is nearest. */
export const parseSlider = (screen: string): Slider | undefined => {
  const lines = linesOf(screen);
  const head = lines.map((l) => EFFORT_HEAD_RE.test(l)).lastIndexOf(true);
  const foot = lines.at(-1) ?? "";
  const scale = lines.findIndex((l, i) => i > head && EFFORT_SCALE_RE.test(l));
  const mark = scale > 0 ? lines[scale - 1]!.indexOf("▲") : -1;
  if (head < 0 || !FOOTER_RE.test(foot) || mark < 0) return undefined;
  const row = lines[scale]!;
  const dist = (e: Effort): number => Math.abs(new RegExp(`\\b${e}\\b`, "u").exec(row)!.index + e.length / 2 - mark);
  const at = EFFORTS.reduce<Effort>((best, e) => (dist(e) < dist(best) ? e : best), EFFORTS[0]);
  return { at, sessionOnly: EFFORT_SESSION_ONLY_RE.test(foot) };
};

const nudgeTo = async (pane: string, want: Effort, left = EFFORTS.length * 2): Promise<Slider | undefined> => {
  const s = parseSlider(await screen(pane));
  if (!s || s.at === want) return s;
  if (left <= 0) return undefined;
  await key(pane, EFFORTS.indexOf(want) < EFFORTS.indexOf(s.at) ? "Left" : "Right");
  await sleep(ARROW_STEP_MS);
  return nudgeTo(pane, want, left - 1);
};

export interface EffortSelectResult { ok: boolean; applied?: Effort; reason?: string }

/** Puts a live pane on `want` for this session only. Never throws, never
 *  touches the user's default; a failure leaves the pane's level as it was. */
export const selectEffort = async (pane: string, want: Effort, log: Logger): Promise<EffortSelectResult> => {
  const start = await screen(pane);
  if (isModalPane(start).modal) return { ok: false, reason: "pane 正停在一个确认框上, 这时敲 /effort 会按到它 —— 等它过去再切" };
  await runTmux(["send-keys", "-t", pane, "-l", "/effort"]);
  await sleep(150);
  await key(pane, "Enter");
  const opened = await until(async () => parseSlider(await screen(pane)), OPEN_TIMEOUT_MS);
  const back = async (reason: string): Promise<EffortSelectResult> => {
    if (parseSlider(await screen(pane))) {
      await key(pane, "Escape");
      await until(async () => (parseSlider(await screen(pane)) ? undefined : true), CLOSE_TIMEOUT_MS);
    }
    log.warn({ pane, want, reason }, "effort-select: not applied");
    return { ok: false, reason };
  };
  if (!opened) return back("/effort 的档位条没有出现");
  if (!opened.sessionOnly) return back("档位条没有「只对本会话」这一键 —— 按 Enter 会改掉全机默认, 没按");
  const at = await nudgeTo(pane, want);
  if (at?.at !== want) return back(`没能把档位挪到 ${want}`);
  const before = (start.match(new RegExp(EFFORT_RECEIPT_RE, "gu")) ?? []).join("\n");
  await key(pane, "s");
  const receipt = await until(async () => {
    const s = await screen(pane);
    const got = s.match(new RegExp(EFFORT_RECEIPT_RE, "gu")) ?? [];
    return !parseSlider(s) && got.join("\n") !== before ? got.at(-1) : undefined;
  }, SETTLE_TIMEOUT_MS);
  const applied = parseEffortReceipt(receipt);
  return applied === want ? { ok: true, applied } : back(receipt ? `回执对不上: ${receipt}` : "选中后没等到回执");
};

const parseEffortReceipt = (receipt: string | undefined): Effort | undefined =>
  parseEffort(EFFORT_RECEIPT_RE.exec(receipt ?? "")?.[1]);
