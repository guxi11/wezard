// Bootstrap claim mode. Lets the very first IM message ("magic phrase" sent by
// the user during `wezard init`) bypass `allowFrom`, set defaultChat, and add the
// sender to allowFrom. After consume, claim is cleared — normal allowFrom
// gating resumes. Single-shot; no concurrency story needed.
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import { parse as parseJsonc } from "jsonc-parser";
import { SECRETS_PATH, type Config } from "../shared/config.js";
import { patchJsonc, appendUnique, readJsoncText } from "../shared/config-writer.js";
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

// ── 副机器人各自的认领 ──────────────────────────────────────────────
// 每个副机器人一份, 互不相干: 它自己的 allowFrom 还空着时, 第一个单聊它的人被写进
// bots[id].allowFrom 并设为 bots[id].defaultChat。全局 defaultChat / wrc.allowFrom (主机器人那份)
// 一个字不碰。不看全局名单: 主机器人的人碰巧先来, 也只是认领了这个副机器人。
// 写回 `bots` 所在的那份文件: secrets.json 里的 bots 数组整体覆盖 config.jsonc 的,
// 写错文件等于写进一份被盖掉的数组。存的是不带 `~bot` 后缀的 principal (授权按裸 id 比对,
// defaultChatOfBot 取用时再挂后缀)。

export const shouldBotAutoClaim = (cfg: Config, bot: string, isDm: boolean): boolean =>
  !!bot && isDm && cfg.bots.find((b) => b.id === bot)?.allowFrom.length === 0;

const botsArrayIn = (file: string): Array<{ id?: unknown }> | undefined => {
  const v = (parseJsonc(readJsoncText(file)) as { bots?: unknown } | undefined)?.bots;
  return Array.isArray(v) ? v : undefined;
};

/** principal 写进机器人 `bot` 的 allowFrom + defaultChat。同时改内存里的 cfg —— 下一条消息不必等重读。 */
export const persistBotClaim = (cfg: Config, sourcePath: string, bot: string, principal: string): void => {
  const entry = cfg.bots.find((b) => b.id === bot);
  if (!entry) throw new Error(`no bot ${bot}`);
  entry.defaultChat = principal;
  if (!entry.allowFrom.includes(principal)) entry.allowFrom.push(principal);
  const file = botsArrayIn(SECRETS_PATH) ? SECRETS_PATH : sourcePath;
  const i = (botsArrayIn(file) ?? []).findIndex((b) => b.id === bot);
  if (i < 0) throw new Error(`bots[id=${bot}] not found in ${file}`);
  appendUnique(file, ["bots", i, "allowFrom"], principal);
  patchJsonc(file, [{ path: ["bots", i, "defaultChat"], value: principal }]);
};

export const ackBotClaim = async (client: WSClient, chat: string, bot: string, log: Logger): Promise<void> => {
  try {
    await client.sendMessage(principalChatId(chat), {
      msgtype: "markdown",
      markdown: {
        content:
          `🛡️ **已设为机器人 \`${bot}\` 的管理员**\n\n` +
          `你是第一个单聊它的人, 已写入 \`bots[id=${bot}].allowFrom\` 与 \`defaultChat\`。` +
          `之后别人要用它, 把对方的 id 加进同一个 allowFrom。`,
      },
    });
  } catch (e) {
    log.warn({ err: (e as Error).message, bot }, "bot claim ack failed");
  }
};

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
