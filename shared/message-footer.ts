import { headed, rawTagHeader, resolveTagTarget, tagHead, tagUrlOf, targetOfTagUrl } from "./session-label.js";

export interface MessageFooterPolicy {
  principal: string;
  /** Stable target key of the destination chat's actual default session. */
  defaultTarget: string;
  url?: string;
}

const footerUrl = (content: string): string | undefined => /\[[✨✦]\]\(([^\n)]*)\)\s*$/.exec(content)?.[1];

const endsWithClosedFence = (content: string): boolean => {
  const lines = content.split("\n");
  const open = lines.reduce<{ char: string; size: number } | undefined>((fence, line) => {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!marker) return fence;
    const token = marker[1]!;
    if (!fence) return { char: token[0]!, size: token.length };
    return token[0] === fence.char && token.length >= fence.size && !marker[2]!.trim() ? undefined : fence;
  }, undefined);
  return !open && /^\s*(`{3,}|~{3,})\s*$/.test(lines.at(-1) ?? "") &&
    lines.slice(0, -1).some((line) => /^\s*(`{3,}|~{3,})/.test(line));
};

/** Only the daemon's trusted ticket resolver can classify a generated footer. */
export const withoutMessageFooter = (content: string, _ownUrl?: string): string => {
  const match = /(?:\n\s*)?\[[✨✦]\]\(([^\n)]*)\)\s*$/.exec(content);
  return match && targetOfTagUrl(match[1]!) ? withoutMessageFooter(content.slice(0, match.index).trimEnd()) : content;
};

/** Every known sender has a detail footer; only the destination default omits its name header. */
export const withMessageFooter = (content: string, policy?: MessageFooterPolicy): string => {
  if (!policy) return content;
  const candidate = footerUrl(content);
  const footerTarget = candidate && targetOfTagUrl(candidate);
  const clean = footerTarget ? withoutMessageFooter(content) : content;
  // A previously generated footer owns the identity. A body link at the start stays body content.
  const raw = rawTagHeader(clean);
  const header = !footerTarget || (raw && !raw.url && resolveTagTarget(raw.tag, policy.principal) === footerTarget) ? raw : undefined;
  const sender = footerTarget || (header?.url ? targetOfTagUrl(header.url) : header && resolveTagTarget(header.tag, policy.principal));
  if (!sender) return content;
  const url = footerTarget ? candidate : header?.url ?? tagUrlOf(sender);
  if (!url) return content;
  const body = header?.body ?? clean;
  const emptyHeader = footerTarget && rawTagHeader(body);
  const emptySender = emptyHeader && (emptyHeader.url ? targetOfTagUrl(emptyHeader.url) : resolveTagTarget(emptyHeader.tag, policy.principal));
  const payload = emptyHeader && !emptyHeader.body.trim() && emptySender === sender ? "" : body;
  const seq = header?.header.match(/\b\d+\/\d+\b/)?.[0];
  // 这一层是所有出站气泡 (stream / standalone / frozen final) 的最后一道改写: 上游 chatHead 写的头在这里被剥掉重写,
  // 所以非 default wizard 的 code 样式署名只能在这里定 —— 名字不挂链接, rolepage 入口归尾部 ✦。
  const head = [sender === policy.defaultTarget ? "" : `\`${tagHead(sender)}\`:`, seq].filter(Boolean).join(" ");
  const message = headed(head, payload).trimEnd();
  return `${message}${endsWithClosedFence(payload) ? "\n\n" : " "}[✦](${url})`;
};
