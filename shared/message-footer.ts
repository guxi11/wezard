import { parseTagHeader, resolveTagTarget, tagUrlOf } from "./session-label.js";

export interface MessageFooterPolicy { topOnly: boolean; url?: string; principal?: string }

/** Only daemon role/chat tickets are movable; ordinary Markdown links stay intact. */
const isRoleUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && /\/(role|chat)$/.test(url.pathname) && !!url.searchParams.get("id");
  } catch { return false; }
};

/** Remove only the generated trailing footer, including repeated copies from older wrappers. */
export const withoutMessageFooter = (content: string): string => {
  const match = /(?:\n\s*)?\[✨\]\(([^\n)]*)\)\s*$/.exec(content);
  return match && isRoleUrl(match[1]!) ? withoutMessageFooter(content.slice(0, match.index).trimEnd()) : content;
};

/** Move the speaker's ticket to one stable footer without changing body links. */
export const withMessageFooter = (content: string, policy?: MessageFooterPolicy): string => {
  if (!policy?.topOnly) return content;
  const prior = /\[✨\]\(([^\n)]*)\)\s*$/.exec(content)?.[1];
  const body = withoutMessageFooter(content);
  const head = /^\[([^\]\n]+)\]\(([^\n)]*)\)/.exec(body);
  const parsedHead = parseTagHeader(body);
  const headRole = head && isRoleUrl(head[2]!) ? new URL(head[2]!).searchParams.get("role") : undefined;
  const priorRole = prior && isRoleUrl(prior) ? new URL(prior).searchParams.get("role") : undefined;
  const linkedHead = !!head && parsedHead.fromBot && isRoleUrl(head[2]!) && (!prior || !priorRole || !headRole || priorRole === headRole);
  const namedTarget = !prior && !linkedHead && parsedHead.fromBot && policy.principal
    ? resolveTagTarget(parsedHead.tag, policy.principal)
    : undefined;
  const namedUrl = namedTarget ? tagUrlOf(namedTarget) : undefined;
  const url = linkedHead ? head![2] : prior && isRoleUrl(prior) ? prior : namedUrl && isRoleUrl(namedUrl) ? namedUrl : policy.url;
  if (!url || !isRoleUrl(url)) return content;
  const text = linkedHead ? body.slice(head![0].length).replace(/^:\s*/, "").trimStart() : body;
  return `${text.trimEnd()}\n\n[✨](${url})`;
};
