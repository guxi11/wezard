import { parseTagHeader, resolveTagTarget, tagUrlOf } from "./session-label.js";

export interface MessageFooterPolicy { topOnly: boolean; url?: string; principal?: string }

/** A ticket is ours only when it belongs to this daemon's configured detail root. */
const isRoleUrl = (value: string, ownUrl?: string): boolean => {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || !url.searchParams.get("id")) return false;
    if (!ownUrl) return false;
    const own = new URL(ownUrl);
    const rootPath = own.pathname.replace(/\/(?:role|chat)\/?$/, "");
    return url.origin === own.origin && ["role", "chat"].some((page) => url.pathname === `${rootPath}/${page}`);
  } catch { return false; }
};

/** Remove only the generated trailing footer, including repeated copies from older wrappers. */
export const withoutMessageFooter = (content: string, ownUrl?: string): string => {
  const match = /(?:\n\s*)?\[[✨✦]\]\(([^\n)]*)\)\s*$/.exec(content);
  return match && isRoleUrl(match[1]!, ownUrl) ? withoutMessageFooter(content.slice(0, match.index).trimEnd(), ownUrl) : content;
};

/** Move the speaker's ticket to one stable footer without changing body links. */
export const withMessageFooter = (content: string, policy?: MessageFooterPolicy): string => {
  if (!policy?.topOnly) return content;
  const candidate = /\[[✨✦]\]\(([^\n)]*)\)\s*$/.exec(content)?.[1];
  const prior = candidate && isRoleUrl(candidate, policy.url) ? candidate : undefined;
  const body = withoutMessageFooter(content, policy.url);
  const head = /^\[([^\]\n]+)\]\(([^\n)]*)\)/.exec(body);
  const parsedHead = parseTagHeader(body);
  const namedTarget = parsedHead.fromBot && policy.principal ? resolveTagTarget(parsedHead.tag, policy.principal) : undefined;
  const namedUrl = namedTarget ? tagUrlOf(namedTarget) : undefined;
  const trustedRoot = policy.url ?? namedUrl;
  const linkedHead = !prior && !!head && parsedHead.fromBot && isRoleUrl(head[2]!, trustedRoot) && (!policy.principal || !!namedTarget);
  const text = linkedHead ? body.slice(head![0].length).replace(/^:\s*/, "").trimStart()
    : !prior && namedTarget ? parsedHead.body : body;
  const url = linkedHead ? head![2] : prior ?? namedUrl ?? policy.url;
  if (!url || !isRoleUrl(url, url)) return content;
  return `${text.trimEnd()} [✦](${url})`;
};
