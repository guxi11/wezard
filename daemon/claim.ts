// Bootstrap claim mode. Lets the very first IM message ("magic phrase" sent by
// the user during `wezard init`) bypass `allowFrom`, set defaultChat, and add the
// sender to allowFrom. After consume, claim is cleared — normal allowFrom
// gating resumes. Single-shot; no concurrency story needed.
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import { type Config } from "../shared/config.js";
import { patchJsonc, appendUnique } from "../shared/config-writer.js";
import { json, readBody, type Handler } from "./http.js";

interface ClaimState {
  phrase: string;
  expiresAt: number;
  claimed?: { principal: string; at: number };
}

let state: ClaimState | undefined;

const now = (): number => Date.now();
const isActive = (): boolean => !!state && !state.claimed && state.expiresAt > now();

/** Returns true iff this message consumed the claim. Caller must skip allowFrom check. */
export const tryConsumeClaim = (text: string, principal: string): boolean => {
  if (!isActive()) return false;
  if (text.trim() !== state!.phrase) return false;
  state!.claimed = { principal, at: now() };
  return true;
};

/** Persist principal as defaultChat + add to allowFrom. Mutates `cfg` in place too. */
export const persistClaim = (cfg: Config, sourcePath: string, principal: string): void => {
  cfg.defaultChat = principal;
  if (!cfg.wrc.allowFrom.includes(principal)) cfg.wrc.allowFrom.push(principal);
  patchJsonc(sourcePath, [{ path: ["defaultChat"], value: principal }]);
  appendUnique(sourcePath, ["wrc", "allowFrom"], principal);
};

const principalChatId = (p: string): string => {
  const i = p.indexOf(":");
  return i >= 0 ? p.slice(i + 1) : p;
};

interface Deps {
  cfg: Config;
  sourcePath: string;
  client: WSClient;
  log: Logger;
}

export const makeClaimStartHandler = ({ log }: Pick<Deps, "log">): Handler => {
  return async (req, res) => {
    const body = (await readBody(req)) as Partial<{ phrase: string; ttlSec: number }>;
    const phrase = (body.phrase ?? "").trim();
    const ttlSec = Math.max(30, Math.min(body.ttlSec ?? 600, 1800));
    if (!phrase) {
      json(res, 400, { ok: false, error: "phrase required" });
      return;
    }
    state = { phrase, expiresAt: now() + ttlSec * 1000 };
    log.info({ phrase, ttlSec }, "claim mode armed");
    json(res, 200, { ok: true, expiresAt: state.expiresAt });
  };
};

export const makeClaimStatusHandler = (): Handler => {
  return (_req, res) => {
    if (!state) {
      json(res, 200, { armed: false });
      return;
    }
    json(res, 200, {
      armed: !state.claimed && state.expiresAt > now(),
      expired: !state.claimed && state.expiresAt <= now(),
      claimed: state.claimed ?? null,
      phrase: state.phrase,
    });
  };
};

export const makeClaimResetHandler = (): Handler => {
  return (_req, res) => {
    state = undefined;
    json(res, 200, { ok: true });
  };
};

/** Send a markdown ack to the user that just completed the claim. */
export const ackClaim = async (
  client: WSClient,
  principal: string,
  log: Logger,
): Promise<void> => {
  try {
    await client.sendMessage(principalChatId(principal), {
      msgtype: "markdown",
      markdown: {
        content:
          "✅ **已设为默认会话**\n\n" +
          "你已被加入 `allowFrom`。接下来 `wezard init` 会触发一个真实授权演示——留意按钮卡片。",
      },
    });
  } catch (e) {
    log.warn({ err: (e as Error).message }, "claim ack failed");
  }
};

/** Auto-claim: in a fresh install (empty allowFrom) the first DM sender is
 * promoted to super admin without any magic phrase. Group chats are excluded —
 * a randomly-added bot in a group should never auto-promote. */
export const shouldAutoClaim = (cfg: Config, isDm: boolean): boolean =>
  isDm && cfg.wrc.allowFrom.length === 0;

export const ackAutoClaim = async (
  client: WSClient,
  principal: string,
  log: Logger,
): Promise<void> => {
  try {
    await client.sendMessage(principalChatId(principal), {
      msgtype: "markdown",
      markdown: {
        content:
          "🛡️ **已自动设为超级管理员**\n\n" +
          `首位单聊用户 \`${principal}\` 被写入 \`defaultChat\` 与 \`wrc.allowFrom\`，` +
          "后续无需再手动授权。如要再添加成员，请编辑 `~/.wezard/config.jsonc`。",
      },
    });
  } catch (e) {
    log.warn({ err: (e as Error).message }, "auto-claim ack failed");
  }
};
