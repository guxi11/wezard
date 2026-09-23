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
  const state = loadJsonMap<TaskState>("~/.wezard/task-state.json");

  let tasks = new Map<string, TaskRecord>();
  let errors: Record<string, string> = {};
  const mtimes = new Map<string, number>();
  const cache = new Map<string, unknown>();

  const loadOne = async (id: string, file: string): Promise<void> => {
    const mtime = statSync(file).mtimeMs;
    if (mtimes.get(id) !== mtime || !cache.has(id)) {
      mtimes.set(id, mtime);
      cache.set(id, (await import(`${pathToFileURL(file).href}?v=${mtime}`)).default);
    }
    const r = normalizeTask(cache.get(id), id, file);
    if (r.ok) tasks.set(id, r.task);
    else errors[id] = r.reason;
  };

  const reload = async (): Promise<void> => {
    const files = readdirSync(dir).filter((f) => f.endsWith(TASK_EXT)).sort();
    const before = new Set(tasks.keys());
    const next = new Map<string, TaskRecord>();
    errors = {};
    const keep = tasks;
    tasks = next;
    for (const f of files) {
      const id = taskIdOfFile(f);
      try {
        await loadOne(id, `${dir}/${f}`);
      } catch (e) {
        errors[id] = (e as Error).message;
        cache.delete(id);
        mtimes.delete(id);
        // 语法错到 import 都进不去: 保住上一版, 免得改到一半存盘就丢一条定时。
        const prev = keep.get(id);
        if (prev) tasks.set(id, prev);
      }
    }
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
      return watch(dir, { persistent: false }, schedule);
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
      const file = fileOfTaskId(dir, draft.id);
      writeFileSync(file, renderTaskFile(draft), "utf8");
      const r = normalizeTask(
        { when: draft.trigger, prompt: draft.prompt, note: draft.note, target: draft.target, fresh: draft.fresh, createdBy: draft.createdBy },
        draft.id, file,
      );
      if (!r.ok) { try { unlinkSync(file); } catch { /* 写进去又立刻删不掉, 下次 reload 会报出来 */ } return { error: r.reason }; }
      mtimes.set(draft.id, statSync(file).mtimeMs);
      cache.delete(draft.id);
      tasks.set(draft.id, r.task);
      return r.task;
    },
    remove: (id) => {
      const hit = tasks.get(id);
      const file = fileOfTaskId(dir, id);
      if (!hit && !existsSync(file)) return undefined;
      try { unlinkSync(file); } catch { /* 已经不在了 */ }
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
