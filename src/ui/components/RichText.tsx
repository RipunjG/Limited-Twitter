/**
 * Renders post text with mentions, hashtags, cashtags and URLs turned into
 * links.
 *
 * Built by tokenizing rather than by injecting HTML - post text is untrusted
 * input from accounts you do not control, and this keeps it impossible for a
 * post to inject markup.
 */

import { Fragment, useMemo } from 'react';

type Token =
  | { kind: 'text'; value: string }
  | { kind: 'link'; value: string; href: string };

/**
 * One pass over the text. Order inside the alternation matters: URLs first,
 * so a query string containing "#section" is not torn apart into a hashtag.
 */
const PATTERN =
  /(https?:\/\/[^\s<>"]+)|(?:^|(?<=[^\w@]))@(\w{1,15})\b|(?:^|(?<=[^\w#]))#(\w+)|(?:^|(?<=[^\w$]))\$([A-Za-z]{1,6})\b/g;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(PATTERN)) {
    const index = match.index;
    if (index === undefined) continue;

    if (index > lastIndex) {
      tokens.push({ kind: 'text', value: text.slice(lastIndex, index) });
    }

    const [whole, url, mention, hashtag, cashtag] = match;

    if (url) {
      // Trailing punctuation is almost always sentence punctuation, not part
      // of the URL.
      const trimmed = url.replace(/[.,;:!?)\]]+$/, '');
      const dropped = url.slice(trimmed.length);
      tokens.push({ kind: 'link', value: trimmed, href: trimmed });
      if (dropped) tokens.push({ kind: 'text', value: dropped });
    } else if (mention) {
      tokens.push({
        kind: 'link',
        value: `@${mention}`,
        href: `https://x.com/${mention}`,
      });
    } else if (hashtag) {
      tokens.push({
        kind: 'link',
        value: `#${hashtag}`,
        href: `https://x.com/hashtag/${encodeURIComponent(hashtag)}`,
      });
    } else if (cashtag) {
      tokens.push({
        kind: 'link',
        value: `$${cashtag}`,
        href: `https://x.com/search?q=${encodeURIComponent(`$${cashtag}`)}`,
      });
    } else {
      tokens.push({ kind: 'text', value: whole });
    }

    lastIndex = index + whole.length;
  }

  if (lastIndex < text.length) {
    tokens.push({ kind: 'text', value: text.slice(lastIndex) });
  }
  return tokens;
}

/** Shorten a bare URL for display the way X does. */
function displayUrl(href: string): string {
  try {
    const url = new URL(href);
    const path = `${url.pathname}${url.search}`.replace(/\/$/, '');
    const host = url.hostname.replace(/^www\./, '');
    const shown = `${host}${path}`;
    return shown.length > 42 ? `${shown.slice(0, 41)}…` : shown;
  } catch {
    return href;
  }
}

export function RichText({ text }: { text: string }): React.JSX.Element {
  const tokens = useMemo(() => tokenize(text), [text]);

  return (
    <>
      {tokens.map((token, index) =>
        token.kind === 'text' ? (
          <Fragment key={index}>{token.value}</Fragment>
        ) : (
          <a
            key={index}
            href={token.href}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(event) => event.stopPropagation()}
          >
            {token.value.startsWith('http') ? displayUrl(token.value) : token.value}
          </a>
        ),
      )}
    </>
  );
}
