// 定时任务的注册表 —— `~/.wezard/tasks/*.task.mjs` 这一目录的读侧。
//
// 两条分界线:
//   · **源码归源码, 状态归状态**。任务文件是人与 wizard 写的代码, daemon 只读不写;
//     lastFired / gate 记忆写进 task-state.json。不然每放一枪就要改一次源码,
//     wizard 刚编辑过的文件下一秒被守护进程覆盖掉。
//   · **一条坏文件只坑它自己**。加载失败记进 errors 照常回显 (wizard 改错了得看得见
//     理由), 其余任务照跑 —— 一个语法错误不该让全机的定时停摆。
//
// 热加载靠 mtime: 只有变过的文件才重新 import (每次 import 都会在 Node 的模块表里
// 留一份, 靠 ?v= 绕缓存的代价是永久驻留, 所以不能见 tick 就重载)。
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { expandHome } from "../shared/paths.js";
import { loadJsonMap } from "../shared/json-map-store.js";
import {
  TASK_EXT, TASKS_DIR, fileOfTaskId, normalizeTask, renderTaskFile, taskIdOfFile,
  type TaskDraft, type TaskRecord, type TaskState,
} from "../shared/task-file.js";

export interface TaskRegistry {
  dir: string;
  list: () => TaskRecord[];
  get: (id: string) => TaskRecord | undefined;
  /** id → 加载失败的理由。回显给 wizard 看, 它才知道自己刚写的文件哪里不对。 */
  errors: () => Record<string, string>;
  create: (draft: TaskDraft) => TaskRecord | { error: string };
  remove: (id: string) => TaskRecord | undefined;
  stateOf: (id: string) => TaskState;
  patchState: (id: string, patch: Partial<TaskState>) => void;
  takenIds: () => Set<string>;
  reload: () => Promise<void>;
  stop: () => void;
}

const WATCH_DEBOUNCE_MS = 300;
// fs.watch 在某些挂载点 (网络盘、容器 bind mount) 上不报事件, 轮询兜底。
const POLL_MS = 30_000;

export const openTaskRegistry = async (
  log: Logger,
  onChange?: (added: string[], removed: string[]) => void,
  dirPath: string = TASKS_DIR,
): Promise<TaskRegistry> => {
  const dir = expandHome(dirPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const state = loadJsonMap<TaskState>("~/.wezard/task-state.json", undefined, { strict: true });

  let tasks = new Map<string, TaskRecord>();
  let errors: Record<string, string> = {};
  let mtimes = new Map<string, number>();
  let cache = new Map<string, unknown>();
  let revision = 0;

  const loadOne = async (id: string, file: string, next: Map<string, TaskRecord>, nextErrors: Record<string, string>, nextMtimes: Map<string, number>, nextCache: Map<string, unknown>): Promise<void> => {
    const mtime = statSync(file).mtimeMs;
    if (nextMtimes.get(id) !== mtime || !nextCache.has(id)) {
      nextMtimes.set(id, mtime);
      nextCache.set(id, (await import(`${pathToFileURL(file).href}?v=${mtime}`)).default);
    }
    const r = normalizeTask(nextCache.get(id), id, file);
    if (r.ok) {
      // 手写文件也要有稳定的计时起点, 否则每次读取都从「现在」重新计时。
      const saved = state.get(id);
      if (saved?.createdAt === undefined || !saved.instance) state.set(id, {
        ...saved, createdAt: saved?.createdAt ?? (statSync(file).birthtimeMs || mtime), instance: saved?.instance ?? randomUUID(),
      });
      next.set(id, { ...r.task, instance: state.get(id)!.instance });
    }
    else nextErrors[id] = r.reason;
  };

  const reload = async (): Promise<void> => {
    const version = ++revision;
    const files = readdirSync(dir).filter((f) => f.endsWith(TASK_EXT)).sort();
    const before = new Set(tasks.keys());
    const next = new Map<string, TaskRecord>();
    const nextErrors: Record<string, string> = {};
    const nextMtimes = new Map(mtimes);
    const nextCache = new Map(cache);
    const keep = tasks;
    for (const f of files) {
      const id = taskIdOfFile(f);
      try {
        await loadOne(id, `${dir}/${f}`, next, nextErrors, nextMtimes, nextCache);
      } catch (e) {
        nextErrors[id] = (e as Error).message;
        nextCache.delete(id);
        nextMtimes.delete(id);
        // 语法错到 import 都进不去: 保住上一版, 免得改到一半存盘就丢一条定时。
        const prev = keep.get(id);
        if (prev) next.set(id, prev);
      }
    }
    // import 会让出事件循环: 不暴露半张表, 不把其间取消/创建的记录复活或抹掉。
    if (version !== revision) return;
    tasks = next;
    errors = nextErrors;
    mtimes = nextMtimes;
    cache = nextCache;
    const added = [...tasks.keys()].filter((k) => !before.has(k));
    const removed = [...before].filter((k) => !tasks.has(k));
    if (added.length || removed.length) onChange?.(added, removed);
    if (Object.keys(errors).length) log.warn({ errors }, "task files failed to load");
  };

  await reload();

  let timer: NodeJS.Timeout | undefined;
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void reload(); }, WATCH_DEBOUNCE_MS);
  };
  const watcher = (() => {
    try {
      const active = watch(dir, { persistent: false }, schedule);
      active.on("error", (err) => {
        active.close();
        log.warn({ err: err.message }, "task dir watch failed; polling only");
      });
      return active;
    } catch (e) {
      log.warn({ err: (e as Error).message }, "task dir watch failed; polling only");
      return undefined;
    }
  })();
  const poll = setInterval(() => { void reload(); }, POLL_MS);
  poll.unref();

  return {
    dir,
    list: () => [...tasks.values()],
    get: (id) => tasks.get(id),
    errors: () => ({ ...errors }),
    takenIds: () => new Set([...tasks.keys(), ...Object.keys(errors)]),
    create: (draft) => {
      revision++;
      const file = fileOfTaskId(dir, draft.id);
      writeFileSync(file, renderTaskFile(draft), "utf8");
      const r = normalizeTask(
        { when: draft.trigger, prompt: draft.prompt, note: draft.note, target: draft.target, fresh: draft.fresh, quiet: draft.quiet, createdBy: draft.createdBy },
        draft.id, file,
      );
      if (!r.ok) { try { unlinkSync(file); } catch { /* 写进去又立刻删不掉, 下次 reload 会报出来 */ } return { error: r.reason }; }
      mtimes.set(draft.id, statSync(file).mtimeMs);
      cache.delete(draft.id);
      const instance = randomUUID();
      state.set(draft.id, { createdAt: Date.now(), instance });
      const task = { ...r.task, instance };
      tasks.set(draft.id, task);
      return task;
    },
    remove: (id) => {
      revision++;
      const hit = tasks.get(id);
      const file = fileOfTaskId(dir, id);
      if (!hit && !existsSync(file)) return undefined;
      try { unlinkSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      tasks.delete(id);
      cache.delete(id);
      mtimes.delete(id);
      state.drop(id);
      return hit;
    },
    stateOf: (id) => state.get(id) ?? {},
    patchState: (id, patch) => { state.set(id, { ...(state.get(id) ?? {}), ...patch }); },
    reload,
    stop: () => { watcher?.close(); clearInterval(poll); if (timer) clearTimeout(timer); },
  };
};
