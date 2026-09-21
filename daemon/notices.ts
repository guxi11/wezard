// 名册增量 —— 「你不在场的时候, 这个网络变了」。
//
// charter (wizard.ts) 是 spawn 那一刻的快照: 它列出出生时群里有谁。快照只会越来
// 越假 —— 新分身出生、老 wizard 收工、谁改了职责, 它一概不知道, 除非自己去
// wizard_roster 问。问一次要花一轮, 于是实际上没人问。
//
// 这里是另一半。变动发生时不打扰任何人, 只把一行字投进每个相关 wizard 的信箱;
// 下一次**无论谁**往它那儿注入点什么 (人在群里说话、同伴派活、定时任务到点),
// 这些行以 `<system-reminder>` 的形式挂在那段文本尾巴上一起进去。不占一轮、不进
// 气泡、不进 transcript (META_RE 会把它剥掉) —— 与 renderPeerMentionHint 同一条
// 边界注入通路。
//
//   感知 = spawn 时的快照 + turn 时的增量。两者都不花额外的轮次。
//
// 投递即清空: 那一次注入失败的话这几行就丢了。通知是提示, 真相永远可以
// wizard_roster 问到; 为一行提示做可靠投递不值当。信箱是纯内存的, daemon 重启即
// 清空 —— 同 graph run, 诚实地说: pane 还在, 没送到的提示没了。
import { baseOfKey } from "../shared/session-label.js";

export interface NoticeBox {
  /** 把一行投给一批 wizard。自己做的事自己知道, 所以调用方负责把当事人排除在外。 */
  post: (audience: readonly string[], line: string) => void;
  /** 取走并清空某个 wizard 的待投递行。 */
  drain: (target: string) => string[];
}

/** 每个信箱最多攒 `max` 行 —— 一个挂了很久的 wizard 不该在醒来时读一部编年史,
 *  溢出时留最新的那些 (旧的那些多半已经被后面的变动覆盖了)。 */
export const createNoticeBox = (max = 12): NoticeBox => {
  const boxes = new Map<string, string[]>();
  return {
    post: (audience, line) => {
      if (!line.trim()) return;
      for (const t of new Set(audience)) {
        boxes.set(t, [...(boxes.get(t) ?? []), line].slice(-max));
      }
    },
    drain: (target) => {
      const lines = boxes.get(target) ?? [];
      boxes.delete(target);
      return lines;
    },
  };
};

// 进程内唯一的信箱。inbound (人说的话) 和 mirror-bridge (同伴/定时注入) 是两条
// 独立的注入路径, 两边都要能挂增量; 为此给各自的安装函数再加一个参数不值当 ——
// 同 bindWizardStore 的取舍。没绑 = 全链路退化成无增量, 行为照旧。
let bound: NoticeBox | undefined;
export const bindNoticeBox = (box: NoticeBox): NoticeBox => (bound = box);
export const noticeBox = (): NoticeBox | undefined => bound;

/** 纯渲染。`<system-reminder>` 是机器信息而非对话, 与 mention hint 同一个壳。 */
export const renderNotices = (lines: readonly string[]): string => {
  if (lines.length === 0) return "";
  return [
    "",
    "<system-reminder>",
    "你出生时拿到的那份名册已经变了 —— 这段时间里:",
    ...lines.map((l) => `- ${l}`),
    "要当下真实的状态 (谁在忙、谁在哪个工作区) 就调 wizard_roster。与手头的活无关就略过,",
    "**不要为此回话, 也不要向用户复述这几行** —— 群里该看见的气泡已经发过了。",
    "</system-reminder>",
  ].join("\n");
};

/** 注入边界上取一次增量。slash 命令按行解析, 尾巴上多挂一段会让它不再被识别成
 *  命令 —— 同 inbound 对 mention hint 的处理, 这类注入直接跳过 (信箱不清空, 等
 *  下一条普通消息)。 */
export const noticeSuffixFor = (target: string, text: string): string => {
  const box = noticeBox();
  if (!box || text.trimStart().startsWith("/")) return "";
  return renderNotices(box.drain(target));
};

/** 同一个聊天里除了当事人之外的所有 wizard —— 一次变动的默认听众。跨聊天的同伴
 *  不在其中: 群成员变动是那个群的事, 别的群只在真的去 send_peer 时才需要知道。 */
export const chatAudience = (
  liveTargets: readonly string[],
  base: string,
  except: readonly string[],
): string[] =>
  liveTargets.filter((t) => baseOfKey(t) === base && !except.includes(t));
