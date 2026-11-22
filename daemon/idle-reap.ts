// 空闲回收 (wrc.mirror.idleReapMin) 的判据 —— 纯函数, 不碰 tmux / 文件。
//
// 每个空闲的 CLI pane 常驻 250~340MB (PSS) 且越跑越多; 数量上限 (maxPanes) 管不到
// 「只开了几个但全都闲着」。收 pane 只收进程, 不收绑定和身份: 下一条消息走 dead-pane
// `--resume` 复活 (冷启动 5~7s)。闲过 5 分钟 prompt cache 本来就凉了, 再起一次不亏 token。

/** 一个候选 target 在清扫那一刻的已知事实。`busy` 要截屏才知道, 不在这里 —— 调用方
 *  先用本函数筛掉不该碰的, 只对剩下的去截屏判忙, 免得每轮把每个 pane 都 capture 一遍。 */
export interface IdleCandidate {
  /** 最后一次活动: max(本进程见到的注入 / 转录条目 / 轮结束, transcript mtime)。0 = 不知道。 */
  lastActiveAt: number;
  /** 这个 pane 所在 window 正被人 attach 着看。 */
  watched: boolean;
  /** 正在出生 (spawn 了还没 attach) 或手上有一次注入还没落定。 */
  inFlight: boolean;
  /** 外部否决 (名下有定时任务 / 挂着审批长轮询), 带原因。 */
  veto?: string;
}

/** 不收的原因; `undefined` = 可以收 (还要过一道截屏判忙)。`idleMs <= 0` = 功能关着。
 *  不知道最后活动时间的一律不收: 认不出就不动, 永远朝不杀的方向失败。 */
export const idleSkipReason = (c: IdleCandidate, now: number, idleMs: number): string | undefined => {
  if (idleMs <= 0) return "disabled";
  if (c.veto) return c.veto;
  if (c.inFlight) return "in flight";
  if (c.watched) return "watched";
  if (!(c.lastActiveAt > 0)) return "activity unknown";
  if (now - c.lastActiveAt < idleMs) return "recent";
  return undefined;
};

/** 最后一次活动 = 本进程见到的活动 / transcript 最后一条真记录 / pane 出生时刻, 取最晚。
 *  出生时刻必须算进来: `--resume` 重生的 pane 要等到有人说话才写新记录, 旧 transcript
 *  会让它刚起来就「闲了几小时」, 下一轮清扫立刻收掉 —— 唤醒因此永远贴不进去 (死循环)。
 *  transcript 的外部 mtime 仍不信 (见 peers.lastRecordMs)。 */
export const lastActiveOf = (a: { seenAt?: number; transcriptAt?: number; paneBornAt?: number }): number =>
  Math.max(a.seenAt ?? 0, a.transcriptAt ?? 0, a.paneBornAt ?? 0);

/** pane 里进程的年龄 (秒, ps etime) 折成出生时刻; 认不出 = 0 (不参与取最晚)。 */
export const paneBornAt = (now: number, etimeSec: number | undefined): number =>
  etimeSec === undefined ? 0 : now - etimeSec * 1000;
