// 切网守望: 轮询网卡指纹, 变化 settle 后触发回调 (index.ts 接成 WS 原地重建)。
// 为什么需要它: 切网 (换 WiFi / 插拔网线 / VPN 起停) 后旧 socket 常黑洞化 —
// TCP 层没人发 RST, 心跳要连续 miss 若干个 30s 周期才判死, 期间对 WeCom 失聪。
// 为什么不用系统事件 (scutil / netlink): 跨 darwin+linux 还得 spawn 常驻子进程;
// networkInterfaces() 是纯内存 syscall, 5s 轮询成本可忽略。
import { networkInterfaces } from "node:os";
import type { Logger } from "pino";

const POLL_MS = 5_000;
// 切网是 down→up 两跳, 中间态 (空网 / 只剩旧网卡残影) 也会形成新指纹;
// 连续稳定 2 拍才算 settle, 避免半程就触发、settle 后又触发一次。
const SETTLE_POLLS = 2;

// 指纹 = 全部非内部 IPv4 地址排序拼接。只认 IPv4: IPv6 临时地址会周期轮换
// (privacy extensions), 掺进来会造成无谓的定期重连; 169.254 是"没拿到 DHCP"
// 的链路本地占位, 同样排除。
export const netSignature = (): string =>
  Object.entries(networkInterfaces())
    .flatMap(([name, list]) => (list ?? []).map((i) => ({ name, ...i })))
    .filter((i) => i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254."))
    .map((i) => `${i.name}/${i.address}`)
    .sort()
    .join("|");

export interface NetWatch {
  stop: () => void;
}

export const startNetWatch = (log: Logger, onChange: (from: string, to: string) => void): NetWatch => {
  let settled = netSignature();
  let candidate = settled;
  let stable = 0;
  log.info({ net: settled }, "net watch start");
  const timer = setInterval(() => {
    const sig = netSignature();
    if (sig === settled) {
      candidate = settled;
      stable = 0;
      return;
    }
    if (sig !== candidate) {
      candidate = sig;
      stable = 1;
      return;
    }
    if (++stable < SETTLE_POLLS) return;
    const from = settled;
    settled = sig;
    stable = 0;
    // 断网 (指纹变空) 只记账不动作 — 没有网, 重连也白搭; 等新网络 settle 后
    // 那一跳再触发 (届时 from 是空串)。
    if (!sig) {
      log.warn({ from }, "network lost");
      return;
    }
    log.warn({ from, to: sig }, "network changed");
    onChange(from, sig);
  }, POLL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
};
