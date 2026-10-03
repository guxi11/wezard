// rolepage 的已读记录 —— 页面 SEEN (消息 id → 上屏时它说完的时刻) 的落盘版。单用户部署, 全局一份, 不按人分:
// 刷新、另开标签页看到的已读与此前一致。只有 svr 开它 (远端同一份代码, 落在各自的 stateDir);
// 没开的地方页面退回只活在内存里的老行为。
import { loadJsonMap } from "./json-map-store.js";

/** 基线行: 此前说完的话一律不算未读。随 GC 上抬 —— 过期删掉的那几条不能因此又冒成未读。 */
const BASE = "@base";

export interface SeenLog {
  /** 未读基线 (页面的 BASE)。 */
  base: () => number;
  /** 这几条里记过的那些。 */
  pick: (ids: Iterable<string>) => Record<string, number>;
  /** 记一批; 同一条取较晚的 fin。 */
  add: (rows: Record<string, number>) => void;
}

/** keepMs = 视界: 更早说完的话页面上已经看不到, 记着也没用。 */
export const openSeenLog = (file: string, keepMs: number): SeenLog => {
  const gc = (m: Record<string, number>): Record<string, number> => {
    const base = Math.max(m[BASE] ?? Date.now(), Date.now() - keepMs);
    return { ...Object.fromEntries(Object.entries(m).filter(([k, fin]) => k !== BASE && fin > base)), [BASE]: base };
  };
  const db = loadJsonMap<number>(file, gc);
  if (db.get(BASE) === undefined) db.set(BASE, Date.now());
  return {
    base: () => db.get(BASE) ?? 0,
    pick: (ids) => Object.fromEntries([...ids].flatMap((id) => ((fin) => (fin ? [[id, fin] as const] : []))(db.get(id)))),
    add: (rows) => {
      const fresh = Object.entries(rows).filter(([id, fin]) => id !== BASE && fin > (db.get(id) ?? 0) && fin > (db.get(BASE) ?? 0));
      if (fresh.length) db.merge(Object.fromEntries(fresh));
    },
  };
};
