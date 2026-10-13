import { headed, linkedTagHead, rawTagHeader, resolveTagTarget, tagUrlOf, targetOfTagUrl } from "./session-label.js";

export interface MessageFooterPolicy {
  principal: string;
  /** Stable target key of the destination chat's actual default session. */
  defaultTarget: string;
  url?: string;
}

const footerUrl = (content: string): string | undefined => /\[[✨✦]\]\(([^\n)]*)\)\s*$/.exec(content)?.[1];

/** Only the daemon's trusted ticket resolver can classify a generated footer. */
export const withoutMessageFooter = (content: string, _ownUrl?: string): string => {
  const match = /(?:\n\s*)?\[[✨✦]\]\(([^\n)]*)\)\s*$/.exec(content);
  return match && targetOfTagUrl(match[1]!) ? withoutMessageFooter(content.slice(0, match.index).trimEnd()) : content;
};

/** The real destination default uses a footer; every other known sender keeps a name header. */
export const withMessageFooter = (content: string, policy?: MessageFooterPolicy): string => {
  if (!policy) return content;
  const candidate = footerUrl(content);
  const footerTarget = candidate && targetOfTagUrl(candidate);
  const clean = footerTarget ? withoutMessageFooter(content) : content;
  // A previously generated footer owns the identity. A body link at the start stays body content.
  const header = footerTarget ? undefined : rawTagHeader(clean);
  const sender = footerTarget || (header?.url ? targetOfTagUrl(header.url) : header && resolveTagTarget(header.tag, policy.principal));
  if (!sender) return content;
  const url = footerTarget ? candidate : header?.url ?? tagUrlOf(sender);
  if (!url) return content;
  const body = header?.body ?? clean;
  const emptyHeader = footerTarget && rawTagHeader(body);
  const emptySender = emptyHeader && (emptyHeader.url ? targetOfTagUrl(emptyHeader.url) : resolveTagTarget(emptyHeader.tag, policy.principal));
  const payload = emptyHeader && !emptyHeader.body.trim() && emptySender === sender ? "" : body;
  if (sender === policy.defaultTarget) return `${payload.trimEnd()} [✦](${url})`;
  if (header?.url) return content;
  const seq = header?.header.match(/\b\d+\/\d+\b/)?.[0];
  return headed([`${linkedTagHead(sender, url)}:`, seq].filter(Boolean).join(" "), payload);
};
