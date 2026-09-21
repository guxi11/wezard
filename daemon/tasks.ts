// 定时任务。到点把一句 prompt 注入某个 wizard 会话 —— 等价于那一刻有人在群里对它
// 说了这句话, 所以它会真的去做, 产出照常落在群里。pane 死了 injectText 会自己拉
// 起来, 于是「每个工作日晚上 9:30 自动跑任务」不要求那台机器上一直开着窗口。
//
// 入口全在 MCP 工具 (schedule_task / list_tasks / cancel_task), 这里只做纯数据操作
// 与放枪。定时表写回 config.jsonc 的 `schedules`, loadConfig 每次读盘, daemon 内
// cfg 用 in-place 变更保持同步。
// 「什么时候」由 shared/schedule-spec.ts 解析与判定, 本模块只负责按判定结果放枪。
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import { randomUUID } from "node:crypto";
import type { Config, ScheduleRecord } from "../shared/config.js";
import { patchJsonc } from "../shared/config-writer.js";
import { baseOfKey, withTagHeader } from "../shared/session-label.js";
import { describeWhen, isDue, nextFire, type When } from "../shared/schedule-spec.js";

export type Schedule = ScheduleRecord;
export type { When };

const stripPrefix = (s: string): string => {
  const i = s.indexOf(":");
  return i >= 0 ? s.slice(i + 1) : s;
};

const persist = (cfg: Config, sourcePath: string): void => {
  patchJsonc(sourcePath, [{ path: ["schedules"], value: cfg.schedules }]);
};

type Draft = Omit<Schedule, "id" | "createdAt" | "note"> &
  Partial<Pick<Schedule, "id" | "createdAt" | "note">>;

/** 新增一条定时。id 由这里发, 返回值里带着它 —— 取消只认 id。 */
export const addSchedule = (cfg: Config, sourcePath: string, s: Draft): Schedule => {
  const rec: Schedule = {
    ...s,
    id: s.id ?? randomUUID().slice(0, 8),
    createdAt: s.createdAt ?? Date.now(),
    note: s.note ?? "",
  };
  cfg.schedules = [...cfg.schedules, rec];
  persist(cfg, sourcePath);
  return rec;
};

export const removeScheduleById = (cfg: Config, sourcePath: string, id: string): Schedule | undefined => {
  const hit = cfg.schedules.find((s) => s.id === id);
  if (!hit) return undefined;
  cfg.schedules = cfg.schedules.filter((s) => s !== hit);
  persist(cfg, sourcePath);
  return hit;
};

/** 给出 `target` 就只列排给那个 wizard 的。 */
export const listSchedules = (cfg: Config, target?: string): Schedule[] =>
  target ? cfg.schedules.filter((s) => s.target === target) : cfg.schedules;

/** 列表回显: 规格与下次触发都摊成人话, 调用方直接念给用户听。 */
export const renderSchedule = (s: Schedule, now: Date = new Date()): Record<string, unknown> => ({
  id: s.id,
  when: describeWhen(s.when),
  next: new Date(nextFire(s.when, s.lastFired ?? s.createdAt, now)).toLocaleString("zh-CN", { hour12: false }),
  lastFired: s.lastFired ? new Date(s.lastFired).toLocaleString("zh-CN", { hour12: false }) : "",
  note: s.note,
  target: s.target,
  prompt: s.prompt,
});

// ── 调度器 ────────────────────────────────────────────────────────
// 每 20s 一 tick (足够密以捕获整分钟翻转); 去重、补跑窗口、间隔计时全部由
// `isDue(when, now, since)` 一个纯函数判定, 这里只负责放枪与记账。
// 记账(lastFired)先于放枪落地: 注入失败不重试 —— 一个每 20s 重试的定时任务
// 会在群里刷屏, 比漏跑一次糟得多。
interface SchedulerDeps {
  client: WSClient;
  cfg: Config;
  sourcePath: string;
  log: Logger;
  /** 注入一句话到某个 wizard 会话。只有 mirror 模式给得出; 没有它定时任务只能告警。 */
  inject?: (target: string, text: string) => Promise<{ ok: boolean; reason?: string }>;
}

const announce = async (client: WSClient, target: string, markdown: string): Promise<void> => {
  await client.sendMessage(stripPrefix(baseOfKey(target)), {
    msgtype: "markdown",
    markdown: { content: withTagHeader(target, markdown) },
  });
};

export const startScheduler = ({ client, cfg, sourcePath, log, inject }: SchedulerDeps): { stop: () => void } => {
  const fire = async (s: Schedule): Promise<void> => {
    if (!inject) {
      log.warn({ id: s.id, target: s.target }, "scheduled task skipped: not in mirror mode");
      return;
    }
    // 先 announce 后注入: 被唤醒的 wizard 接下来在群里说的话才有出处, 否则群里凭空
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
    const due = cfg.schedules.filter((s) => isDue(s.when, now, s.lastFired ?? s.createdAt));
    if (!due.length) return;
    const firedAt = now.getTime();
    const fired = new Set(due.map((s) => s.id));
    // once 放完这一枪就没有下一枪了, 留在表里只会让列表越来越脏。
    cfg.schedules = cfg.schedules
      .map((s) => (fired.has(s.id) ? { ...s, lastFired: firedAt } : s))
      .filter((s) => !(s.when.kind === "once" && s.lastFired));
    persist(cfg, sourcePath);
    for (const s of due) {
      try {
        await fire(s);
      } catch (e) {
        log.error({ id: s.id, err: (e as Error).message }, "scheduled fire failed");
      }
    }
  };
  const timer = setInterval(() => { void tick(); }, 20_000);
  return { stop: () => clearInterval(timer) };
};
