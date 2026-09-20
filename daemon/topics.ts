// 事件订阅 / 广播 / 定时。订阅表 CRUD + 发布 + 定时调度。入口全在 MCP 工具
// (subscribe/unsubscribe/broadcast/schedule_task/cancel),这里只做纯数据操作与推送。
// 订阅关系与调度写回 config.jsonc(`topics.subs` / `topics.schedules`),loadConfig
// 每次读盘,daemon 内 cfg 用 in-place 变更保持同步。
//
// 定时表里有两种动作,共用同一个 20s tick:
//   broadcast  到点推一段固定 markdown 给 topic 订阅者 —— 通知,不产生工作
//   task       到点把一句 prompt 注入某个 wizard 会话 —— 等价于那一刻有人在群里
//              对它说了这句话。pane 死了 injectText 会自己拉起来, 所以「每个工作日
//              晚上 9:30 自动跑任务」不要求那台机器上一直开着窗口。
// 「什么时候」由 shared/schedule-spec.ts 解析与判定, 本模块只负责按判定结果放枪。
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import { randomUUID } from "node:crypto";
import type { Config, ScheduleRecord } from "../shared/config.js";
import { patchJsonc } from "../shared/config-writer.js";
import { baseOfKey, withTagHeader } from "../shared/session-label.js";
import { describeWhen, isDue, nextFire, type When } from "../shared/schedule-spec.js";

const stripPrefix = (s: string): string => {
  const i = s.indexOf(":");
  return i >= 0 ? s.slice(i + 1) : s;
};

// Topic name 允许中文/字母数字/`-`/`_`/`.`,不允许空白。剥离外层引号(中英文单双)。
const stripQuotes = (s: string): string =>
  s.trim().replace(/^[\s'"‘’“”`]+|[\s'"‘’“”`]+$/gu, "");

const normTopic = (raw: string): string => stripQuotes(raw);

// ── 订阅表 ────────────────────────────────────────────────────────
export const subscribe = (
  cfg: Config,
  sourcePath: string,
  topic: string,
  target: string,
): { added: boolean } => {
  const t = normTopic(topic);
  if (!t) return { added: false };
  const arr = cfg.topics.subs[t] ? cfg.topics.subs[t]!.slice() : [];
  if (arr.includes(target)) return { added: false };
  arr.push(target);
  cfg.topics.subs[t] = arr;
  patchJsonc(sourcePath, [{ path: ["topics", "subs", t], value: arr }]);
  return { added: true };
};

export const unsubscribe = (
  cfg: Config,
  sourcePath: string,
  topic: string,
  target: string,
): { removed: boolean } => {
  const t = normTopic(topic);
  const arr = cfg.topics.subs[t] ?? [];
  const next = arr.filter((x) => x !== target);
  if (next.length === arr.length) return { removed: false };
  cfg.topics.subs[t] = next;
  patchJsonc(sourcePath, [{ path: ["topics", "subs", t], value: next }]);
  return { removed: true };
};

export const listSubs = (cfg: Config, target?: string): Array<{ topic: string; targets: string[] }> => {
  const entries = Object.entries(cfg.topics.subs);
  const filtered = target ? entries.filter(([, subs]) => subs.includes(target)) : entries;
  return filtered.map(([topic, targets]) => ({ topic, targets: targets.slice() }));
};

// ── 定时任务 ──────────────────────────────────────────────────────
export type Schedule = ScheduleRecord;
export type { When };

const persistSchedules = (cfg: Config, sourcePath: string): void => {
  patchJsonc(sourcePath, [{ path: ["topics", "schedules"], value: cfg.topics.schedules }]);
};

const newId = (): string => randomUUID().slice(0, 8);

// Omit 作用在联合类型上会把两支揉成公共字段, `target` 就此消失 —— 分配式条件类型
// 让它逐支展开, broadcast 支和 task 支各自保住自己的字段。
type Draft<T = Schedule> = T extends Schedule
  ? Omit<T, "id" | "createdAt" | "note"> & { id?: string; createdAt?: number; note?: string }
  : never;

/** 新增一条定时。id 由这里发, 返回值里带着它 —— 取消只认 id。 */
export const addSchedule = (cfg: Config, sourcePath: string, s: Draft): Schedule => {
  const rec = { ...s, id: s.id ?? newId(), createdAt: s.createdAt ?? Date.now(), note: s.note ?? "" } as Schedule;
  cfg.topics.schedules.push(rec);
  persistSchedules(cfg, sourcePath);
  return rec;
};

export const removeScheduleById = (cfg: Config, sourcePath: string, id: string): Schedule | undefined => {
  const hit = cfg.topics.schedules.find((s) => s.id === id);
  if (!hit) return undefined;
  cfg.topics.schedules = cfg.topics.schedules.filter((s) => s.id !== id);
  persistSchedules(cfg, sourcePath);
  return hit;
};

export const removeSchedulesByTopic = (
  cfg: Config,
  sourcePath: string,
  topic: string,
): number => {
  const t = normTopic(topic);
  const before = cfg.topics.schedules.length;
  cfg.topics.schedules = cfg.topics.schedules.filter((s) => !(s.kind === "broadcast" && s.topic === t));
  const removed = before - cfg.topics.schedules.length;
  if (removed > 0) persistSchedules(cfg, sourcePath);
  return removed;
};

/** 按 topic 取消 task 类定时没有意义, 所以筛选面就是这三个维度。 */
export const listSchedules = (
  cfg: Config,
  filter?: { kind?: Schedule["kind"]; topic?: string; target?: string },
): Schedule[] =>
  cfg.topics.schedules.filter((s) => {
    if (filter?.kind && s.kind !== filter.kind) return false;
    if (filter?.topic && !(s.kind === "broadcast" && s.topic === normTopic(filter.topic))) return false;
    if (filter?.target && !(s.kind === "task" && s.target === filter.target)) return false;
    return true;
  });

/** 列表回显: 规格与下次触发都摊成人话, 调用方直接念给用户听。 */
export const renderSchedule = (s: Schedule, now: Date = new Date()): Record<string, unknown> => ({
  id: s.id,
  kind: s.kind,
  when: describeWhen(s.when),
  next: new Date(nextFire(s.when, s.lastFired ?? s.createdAt, now)).toLocaleString("zh-CN", { hour12: false }),
  lastFired: s.lastFired ? new Date(s.lastFired).toLocaleString("zh-CN", { hour12: false }) : "",
  note: s.note,
  ...(s.kind === "broadcast"
    ? { topic: s.topic, content: s.content }
    : { target: s.target, prompt: s.prompt }),
});

// ── 发布 ──────────────────────────────────────────────────────────
export interface PublishResult {
  topic: string;
  sent: number;
  failed: number;
  subs: string[];
}

export const publish = async (
  client: WSClient,
  cfg: Config,
  log: Logger,
  topic: string,
  content: string,
): Promise<PublishResult> => {
  const t = normTopic(topic);
  const subs = (cfg.topics.subs[t] ?? []).slice();
  let sent = 0;
  let failed = 0;
  for (const s of subs) {
    try {
      // 订阅者 key 可能带 `#tag` (订阅是按会话 key 记的) —— 广播落到该会话的
      // 视觉通道里, 与该会话的其它气泡一致。
      await client.sendMessage(stripPrefix(s), {
        msgtype: "markdown",
        markdown: { content: withTagHeader(s, content) },
      });
      sent++;
    } catch (e) {
      failed++;
      log.warn({ topic: t, target: s, err: (e as Error).message }, "publish target failed");
    }
  }
  log.info({ topic: t, subs: subs.length, sent, failed }, "publish");
  return { topic: t, sent, failed, subs };
};

// ── 调度器 ────────────────────────────────────────────────────────
// 每 20s 一 tick(足够密以捕获整分钟翻转);去重、补跑窗口、间隔计时全部由
// `isDue(when, now, since)` 一个纯函数判定, 这里只负责放枪与记账。
// 记账(lastFired)先于放枪落地: 注入失败不重试 —— 一个每 20s 重试的定时任务
// 会在群里刷屏, 比漏跑一次糟得多。
interface SchedulerDeps {
  client: WSClient;
  cfg: Config;
  sourcePath: string;
  log: Logger;
  /** 注入一句话到某个 wizard 会话。只有 mirror 模式给得出;没有它 task 类定时降级为告警。 */
  inject?: (target: string, text: string) => Promise<{ ok: boolean; reason?: string }>;
}

const announce = async (client: WSClient, target: string, markdown: string): Promise<void> => {
  await client.sendMessage(stripPrefix(baseOfKey(target)), {
    msgtype: "markdown",
    markdown: { content: withTagHeader(target, markdown) },
  });
};

export const startScheduler = ({ client, cfg, sourcePath, log, inject }: SchedulerDeps): { stop: () => void } => {
  const fireTask = async (s: Extract<Schedule, { kind: "task" }>): Promise<void> => {
    if (!inject) {
      log.warn({ id: s.id, target: s.target }, "scheduled task skipped: not in mirror mode");
      return;
    }
    // 先announce后注入: 被唤醒的 wizard 接下来在群里说的话才有出处, 否则群里凭空
    // 冒出一轮对话, 没人知道是谁点的火。
    await announce(client, s.target, `⏰ **定时任务** · ${describeWhen(s.when)}\n> ${s.prompt.split("\n")[0]!.slice(0, 120)}`)
      .catch((e: unknown) => log.warn({ id: s.id, err: (e as Error).message }, "task announce failed"));
    const r = await inject(s.target, s.prompt);
    log.info({ id: s.id, target: s.target, ok: r.ok, reason: r.reason }, "scheduled task fired");
    if (!r.ok) {
      await announce(client, s.target, `⏰ 定时任务注入失败:${r.reason ?? "unknown"}`).catch(() => {});
    }
  };

  const tick = async (): Promise<void> => {
    const now = new Date();
    const due = cfg.topics.schedules.filter(
      (s) =>
        isDue(s.when, now, s.lastFired ?? s.createdAt) &&
        // 广播需要 WS 在线;断线时不记账, 重连后仍在补跑窗口内就补上。
        (s.kind !== "broadcast" || client.isConnected),
    );
    if (!due.length) return;
    const firedAt = now.getTime();
    for (const s of due) s.lastFired = firedAt;
    // once 放完这一枪就没有下一枪了, 留在表里只会让列表越来越脏。
    cfg.topics.schedules = cfg.topics.schedules.filter((s) => !(s.when.kind === "once" && s.lastFired));
    persistSchedules(cfg, sourcePath);
    for (const s of due) {
      try {
        if (s.kind === "broadcast") await publish(client, cfg, log, s.topic, s.content);
        else await fireTask(s);
      } catch (e) {
        log.error({ id: s.id, kind: s.kind, err: (e as Error).message }, "scheduled fire failed");
      }
    }
  };
  const timer = setInterval(() => { void tick(); }, 20_000);
  return { stop: () => clearInterval(timer) };
};
