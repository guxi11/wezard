// Interactive, ground-truth model selection for a freshly-spawned pane.
//
// `--model <slug>` at CLI launch is NOT validated: an unrecognized slug spawns
// fine and the pane only reports "There's an issue with the selected model"
// on its first real turn — by then the wizard has already been announced as
// ready and the caller has moved on. `/model <arg>` typed into the running
// TUI IS validated: an exact match applies immediately with a "Set model to
// X" readback, a miss reports "Model 'X' not found" and changes nothing. We
// drive selection through the latter instead of trusting the launch flag.
//
// A caller's model string is often colloquial ("最新的 opus", "sonnet 5.1")
// rather than one of the CLI's own short aliases, and that alias set changes
// with every new model family. Rather than hardcode a table that goes stale,
// we recover the live catalog straight from the pane's own bare `/model`
// picker and match against ITS keywords — so a brand-new family Just Works
// the day it ships, no code change needed here.
import type { Logger } from "pino";
import { sleep } from "../shared/std.js";
import { runTmux } from "./spawn-tmux.js";

const READBACK_SETTLE_MS = 800;
const ARROW_STEP_MS = 350; // faster repeats get dropped/coalesced by the TUI — this is the empirically-verified floor
const CATALOG_HUNT_STEPS = 10; // > any plausible catalog size; Down wraps, so this always laps the full list at least once

// "  ❯ 2. Opus (1M context)      Opus 5 with 1M context · …" and its
// scrolled-window siblings ("↑ 2. …" / "↓ 3. …") — we only need the leading
// alpha token (Opus / Sonnet / Fable / Haiku / Default), not the rest of the
// row's description text.
const CATALOG_ROW_RE = /^\s*[❯>↑↓]?\s*(\d+)\.\s+([A-Za-z][A-Za-z0-9.]*)/u;
const SET_OK_RE = /Set model to|Kept model as/iu;
const NOT_FOUND_RE = /Model '.*' not found/iu;

const capture = async (pane: string, rows: number): Promise<string> => {
  const r = await runTmux(["capture-pane", "-t", pane, "-p", "-S", `-${rows}`]);
  return r.ok ? r.stdout : "";
};

const sendModelArg = async (pane: string, arg: string): Promise<string> => {
  await runTmux(["send-keys", "-t", pane, `/model ${arg}`, "Enter"]);
  await sleep(READBACK_SETTLE_MS);
  return capture(pane, 10);
};

// Walks the picker's scroll window one row at a time (arrow repeats faster
// than ARROW_STEP_MS get coalesced by the TUI and skip rows) and collects
// every numbered row's leading keyword it passes. The list is short enough
// that CATALOG_HUNT_STEPS always wraps past the start at least once.
const discoverCatalogKeywords = async (pane: string, log: Logger): Promise<string[]> => {
  await runTmux(["send-keys", "-t", pane, "/model", "Enter"]);
  await sleep(READBACK_SETTLE_MS);
  const seen = new Map<number, string>();
  for (let i = 0; i < CATALOG_HUNT_STEPS; i++) {
    const cap = await capture(pane, 20);
    for (const line of cap.split("\n")) {
      const m = CATALOG_ROW_RE.exec(line);
      if (m) seen.set(Number(m[1]), m[2]!);
    }
    await runTmux(["send-keys", "-t", pane, "Down"]);
    await sleep(ARROW_STEP_MS);
  }
  await runTmux(["send-keys", "-t", pane, "Escape"]);
  await sleep(200);
  const keywords = [...seen.values()];
  log.info({ pane, keywords }, "model-select: discovered live catalog");
  return keywords;
};

export interface ModelSelectResult {
  ok: boolean;
  /** The keyword that actually landed, per the CLI's own readback — persist
   *  THIS (not the caller's raw input) so a later respawn's fast path matches
   *  on the first try instead of re-discovering the catalog every time. */
  applied?: string;
  reason?: string;
}

/** Drives the pane's `/model` command until `wanted` — or the catalog keyword
 *  it contains — is confirmed applied. Never throws: a failed resolution
 *  leaves the pane on whatever model it already had, which is always safer
 *  than the unvalidated `--model` launch flag silently wedging the wizard. */
export const selectModel = async (pane: string, wanted: string, log: Logger): Promise<ModelSelectResult> => {
  const want = wanted.trim();
  if (!want || !pane) return { ok: true };
  const first = await sendModelArg(pane, want);
  if (SET_OK_RE.test(first)) return { ok: true, applied: want };
  if (!NOT_FOUND_RE.test(first)) {
    log.warn({ pane, wanted: want, tail: first.slice(-300) }, "model-select: unexpected readback on first attempt");
    return { ok: false, reason: "/model 没有按预期方式回应" };
  }
  const keywords = await discoverCatalogKeywords(pane, log);
  const lower = want.toLowerCase();
  const match = keywords
    .filter((k) => lower.includes(k.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0]; // longest keyword wins on overlap
  if (!match) return { ok: false, reason: `'${want}' 不匹配任何已知模型 (当前目录: ${keywords.join(", ") || "读取失败"})` };
  const second = await sendModelArg(pane, match);
  if (SET_OK_RE.test(second)) return { ok: true, applied: match };
  log.warn({ pane, wanted: want, match, tail: second.slice(-300) }, "model-select: retry with discovered keyword also failed");
  return { ok: false, reason: `按目录匹配到 '${match}' 后仍未生效` };
};
