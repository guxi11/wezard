// Stable per-session visual tag. Hash a sessionId to a fixed animal emoji so
// the same Claude session always shows the same icon — on approval cards and
// in the /sessions list — letting the user tell sibling sessions apart when
// several un-mirrored sessions all fall back to the same WeCom chat.
//
// Stateless + deterministic: same sessionId → same emoji across daemon
// restarts, no persistence needed.

const ANIMALS = [
  "🦊", "🐬", "🦄", "🐙", "🦉", "🐢", "🦋", "🐝",
  "🐳", "🦁", "🐯", "🐰", "🦝", "🐼", "🐨", "🦓",
  "🦔", "🦇", "🐧", "🦜", "🦩", "🐸", "🐺", "🦅",
  "🐡", "🦞", "🦗", "🐌", "🦚", "🐲",
];

// FNV-1a — small, fast, good spread for short ascii ids.
const hash = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

export const labelFor = (sessionId: string): string => {
  if (!sessionId) return "❔";
  return ANIMALS[hash(sessionId) % ANIMALS.length] ?? "❔";
};

// ── Target-key tagging ──────────────────────────────────────────────────
// Daemon-internal target keys are `user:xxx[#tag]` / `chat:xxx[#tag]`. Every
// user-visible artifact bound to a TAGGED session must carry the same visual
// so a chat hosting parallel sessions stays disambiguated:
//   • markdown bubbles → `emoji \`#tag\`` header line  (withTagHeader)
//   • card titles      → `emoji ` badge                 (tagBadge)
// Untagged (default session) passes through unchanged — single-session users
// see no extra glyphs. Emoji is keyed on the TAG STRING, not the sessionId,
// so it survives `/clear` rotations.

/** `#tag` suffix of a target key, "" when untagged. */
export const tagOfKey = (target: string | undefined): string => {
  if (!target) return "";
  const h = target.indexOf("#");
  return h >= 0 ? target.slice(h + 1) : "";
};

/** Drop the `#tag` suffix — collapses a tagged session key to the chat-scoped
 *  base principal (`user:xxx#foo` → `user:xxx`). Everything shared across a
 *  chat's sessions (cwd, peer discovery, graph runs) keys off this. */
export const baseOfKey = (target: string): string => {
  const h = target.indexOf("#");
  return h >= 0 ? target.slice(0, h) : target;
};

/** Compose a session key from a base principal and a tag ("" → default session). */
export const keyOf = (base: string, tag: string): string => (tag ? `${base}#${tag}` : base);

/** Trailing-space emoji badge for card titles; "" for untagged targets. */
export const tagBadge = (target: string | undefined): string => {
  const tag = tagOfKey(target);
  return tag ? `${labelFor(tag)} ` : "";
};

/** Every `#tag`-looking token in a quoted message, in order of appearance.
 *
 *  Feeds "引用继承 tag": quoting a message from a session and just typing should
 *  be the same as typing `#tag` yourself. Two shapes have to be recognized:
 *    • wezard's own replies — withTagHeader writes ``🦊 `#tag` `` as the first
 *      line, and WeCom's quote bubble sometimes keeps the backticks and
 *      sometimes strips them (it re-renders markdown unpredictably), so both
 *      sides of `#` allow a backtick.
 *    • the user's own earlier `#tag question` — plain space-delimited.
 *
 *  Deliberately looser than inbound's TAG_RE, and deliberately returns ALL
 *  candidates rather than just the first: the caller is expected to keep only
 *  tags whose session actually exists. Without that filter this would happily
 *  read `#include <stdio.h>` out of a quoted code block and spawn a session
 *  called "include"; with it, a stray `#word` is simply ignored. */
const QUOTE_TAG_RE = /(?:^|\s|`)#([\p{L}\p{N}_-]{1,32})(?=`|\s|$)/gu;

export const tagsInQuote = (quoted: string): string[] => {
  const out: string[] = [];
  for (const m of quoted.matchAll(QUOTE_TAG_RE)) {
    const t = m[1];
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
};

/** Prefix markdown content with the `emoji \`#tag\`` header; identity when untagged.
 *  `seq` ("2/5") marks one piece of a split push — it rides in the same header
 *  line so every chunk of a long reply is attributable on its own, and shows
 *  alone when the session is untagged. */
export const withTagHeader = (target: string | undefined, content: string, seq?: string): string => {
  const tag = tagOfKey(target);
  const head = [tag ? `${labelFor(tag)} \`#${tag}\`` : "", seq ? `\`${seq}\`` : ""].filter(Boolean).join(" ");
  return head ? `${head}\n\n${content}` : content;
};
