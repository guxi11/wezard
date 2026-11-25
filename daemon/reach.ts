// 一个聊天此刻能不能把卡片 / 消息送到人眼前。企微聊天看 aibot 长连接; 别的通道 (微信) 由它自己判 ——
// 微信出站走自己的长轮询账号, 企微 WS 断着 (reload 刚起来未鉴权、切网重连) 不该挡住微信 chat 的审批卡。
// approval / ask / outbound 的门控都问这里, 不逐处特判通道; 通道在 index.ts 启动时装上。
import type { WSClient } from "@wecom/aibot-node-sdk";

/** 归自己管的 chat 回 true / false, 不归自己管回 undefined (交给企微长连接判)。 */
type Reach = (bareChatId: string) => boolean | undefined;
let other: Reach = () => undefined;
export const bindChatReach = (r: Reach): void => { other = r; };

/** `chat:wx_…#tag` / `wx_…` 都认: 剥前缀与 slot。 */
const bare = (chat: string): string => chat.replace(/^(user|chat|group):/, "").split("#")[0] ?? "";

export const reachable = (client: WSClient, chat: string): boolean => other(bare(chat)) ?? client.isConnected;
