/**
 * Turns X's GraphQL payloads into the normalized shapes in `types.ts`.
 *
 * Two things make this messier than it looks:
 *
 *  1. X is mid-migration from `legacy.*` to `core.*` / `avatar.*` on user
 *     objects, and which one is populated varies by operation and by deploy.
 *     Every read below checks both.
 *  2. Tweets arrive wrapped in several possible envelopes
 *     (`TweetWithVisibilityResults`, tombstones, retweet indirection), so the
 *     unwrapping is done once in `parseTweetResult` and nowhere else.
 *
 * Everything is defensive: a malformed entry yields null and is skipped rather
 * than throwing and losing the whole page.
 */

import type {
  MediaItem,
  TimelinePage,
  Tweet,
  TweetAuthor,
  TweetMetrics,
  XProfile,
} from './types';

/* ------------------------------------------------------------------ utils */

type Dict = Record<string, unknown>;

function obj(value: unknown): Dict | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Dict)
    : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // X returns some counters (notably view counts) as strings.
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** Walk a dotted path, returning null the moment anything is missing. */
function dig(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    const next = obj(current);
    if (!next) return null;
    current = next[segment];
  }
  return current ?? null;
}

/* ------------------------------------------------------------------ users */

function parseUserResult(raw: unknown): TweetAuthor | null {
  const result = obj(raw);
  if (!result) return null;

  const legacy = obj(result.legacy) ?? {};
  const core = obj(result.core) ?? {};
  const avatar = obj(result.avatar) ?? {};

  const userId = str(result.rest_id);
  const handle = str(core.screen_name) ?? str(legacy.screen_name);
  if (!userId || !handle) return null;

  // "_normal" is a 48px thumbnail; "_x96" is the crisp version X itself uses
  // in timelines. Swapping it avoids visibly blurry avatars on retina.
  const rawAvatar =
    str(avatar.image_url) ??
    str(legacy.profile_image_url_https) ??
    str(core.profile_image_url_https);

  return {
    userId,
    handle,
    displayName: str(core.name) ?? str(legacy.name) ?? handle,
    avatarUrl: rawAvatar ? rawAvatar.replace('_normal.', '_x96.') : null,
    verified:
      result.is_blue_verified === true ||
      dig(result, 'verification.verified') === true ||
      legacy.verified === true,
  };
}

export function parseProfile(payload: unknown): XProfile | null {
  const result = obj(dig(payload, 'data.user.result'));
  if (!result) return null;

  const author = parseUserResult(result);
  if (!author) return null;

  const legacy = obj(result.legacy) ?? {};
  return {
    ...author,
    bio: str(legacy.description),
    followersCount: num(legacy.followers_count),
    protected: legacy.protected === true,
  };
}

/* ------------------------------------------------------------------ media */

function parseMedia(legacy: Dict): MediaItem[] {
  // extended_entities carries the full set; entities.media truncates to one.
  const source =
    arr(dig(legacy, 'extended_entities.media')).length > 0
      ? arr(dig(legacy, 'extended_entities.media'))
      : arr(dig(legacy, 'entities.media'));

  const items: MediaItem[] = [];
  for (const entry of source) {
    const media = obj(entry);
    if (!media) continue;

    const url = str(media.media_url_https);
    if (!url) continue;

    const type = str(media.type);
    const kind: MediaItem['kind'] =
      type === 'video' ? 'video' : type === 'animated_gif' ? 'gif' : 'photo';

    // Pick the highest-bitrate mp4; X also offers HLS, which a plain <video>
    // cannot play without a library.
    let videoUrl: string | null = null;
    if (kind !== 'photo') {
      let bestBitrate = -1;
      for (const variantRaw of arr(dig(media, 'video_info.variants'))) {
        const variant = obj(variantRaw);
        if (!variant || str(variant.content_type) !== 'video/mp4') continue;
        const bitrate = num(variant.bitrate) ?? 0;
        const candidate = str(variant.url);
        if (candidate && bitrate > bestBitrate) {
          bestBitrate = bitrate;
          videoUrl = candidate;
        }
      }
    }

    items.push({
      kind,
      url,
      videoUrl,
      width: num(dig(media, 'original_info.width')),
      height: num(dig(media, 'original_info.height')),
      altText: str(media.ext_alt_text),
    });
  }
  return items;
}

/* ------------------------------------------------------------------- text */

interface BuiltText {
  text: string;
  links: Array<{ url: string; display: string }>;
}

function buildText(legacy: Dict, noteText: string | null, noteEntities: Dict | null): BuiltText {
  const links: Array<{ url: string; display: string }> = [];

  let text: string;
  if (noteText !== null) {
    // Long-form posts live in note_tweet and have no display_text_range.
    text = noteText;
  } else {
    const full = str(legacy.full_text) ?? str(legacy.text) ?? '';
    const range = arr(legacy.display_text_range);
    const start = num(range[0]);
    const end = num(range[1]);
    if (start !== null && end !== null) {
      // These offsets are Unicode code points, not UTF-16 units - slicing the
      // string directly corrupts any post containing astral characters
      // (emoji), which is most of them.
      text = Array.from(full).slice(start, end).join('');
    } else {
      text = full;
    }
  }

  const entitySource = noteEntities ?? obj(legacy.entities);
  for (const entryRaw of arr(dig(entitySource ?? {}, 'urls'))) {
    const entry = obj(entryRaw);
    if (!entry) continue;
    const shortUrl = str(entry.url);
    const expanded = str(entry.expanded_url);
    const display = str(entry.display_url) ?? expanded;
    if (!shortUrl || !expanded || !display) continue;

    links.push({ url: expanded, display });
    // Unwrap t.co so the reader sees the real destination.
    text = text.split(shortUrl).join(expanded);
  }

  // A post with media carries a trailing t.co pointing back at itself; X hides
  // it and so do we.
  text = text.replace(/\s*https:\/\/t\.co\/\w+\s*$/, '');

  return { text: text.trim(), links };
}

/* ----------------------------------------------------------------- tweets */

function parseMetrics(legacy: Dict, result: Dict): TweetMetrics {
  return {
    replies: num(legacy.reply_count) ?? 0,
    reposts: num(legacy.retweet_count) ?? 0,
    likes: num(legacy.favorite_count) ?? 0,
    quotes: num(legacy.quote_count) ?? 0,
    bookmarks: num(legacy.bookmark_count) ?? 0,
    views: num(dig(result, 'views.count')),
  };
}

/**
 * Peel off whatever envelope X wrapped the tweet in.
 * Returns null for tombstones and other unrenderable entries.
 */
function unwrapTweet(raw: unknown): Dict | null {
  let node = obj(raw);
  if (!node) return null;

  // Visibility-limited tweets nest the real payload one level down.
  if (str(node.__typename) === 'TweetWithVisibilityResults') {
    node = obj(node.tweet);
    if (!node) return null;
  }

  const typename = str(node.__typename);
  if (typename === 'TweetTombstone' || typename === 'TweetUnavailable') return null;
  if (!str(node.rest_id)) return null;

  return node;
}

export function parseTweetResult(raw: unknown, depth = 0): Tweet | null {
  const result = unwrapTweet(raw);
  if (!result) return null;

  const legacy = obj(result.legacy);
  if (!legacy) return null;

  const id = str(result.rest_id);
  const author = parseUserResult(dig(result, 'core.user_results.result'));
  if (!id || !author) return null;

  const createdAtRaw = str(legacy.created_at);
  const createdAt = createdAtRaw ? Date.parse(createdAtRaw) : Number.NaN;
  if (Number.isNaN(createdAt)) return null;

  // A retweet's own text is a truncated "RT @user: …". The meaningful content
  // is the original, so we surface that and record who boosted it - matching
  // how X itself renders the card.
  const innerRetweet = legacy.retweeted_status_result;
  if (innerRetweet && depth < 3) {
    const original = parseTweetResult(dig(innerRetweet, 'result'), depth + 1);
    if (original) {
      return {
        ...original,
        id,
        retweetOfId: original.id,
        retweetedBy: author,
        createdAt,
      };
    }
  }

  const noteText = str(dig(result, 'note_tweet.note_tweet_results.result.text'));
  const noteEntities = obj(
    dig(result, 'note_tweet.note_tweet_results.result.entity_set'),
  );
  const { text, links } = buildText(legacy, noteText, noteEntities);

  const quotedTweet =
    depth < 3 ? parseTweetResult(dig(result, 'quoted_status_result.result'), depth + 1) : null;

  return {
    id,
    author,
    createdAt,
    text,
    lang: str(legacy.lang),

    isReply: Boolean(str(legacy.in_reply_to_status_id_str)),
    replyToTweetId: str(legacy.in_reply_to_status_id_str),
    replyToHandle: str(legacy.in_reply_to_screen_name),

    retweetOfId: null,
    retweetedBy: null,

    quotedTweetId: str(legacy.quoted_status_id_str) ?? quotedTweet?.id ?? null,
    quotedTweet,

    media: parseMedia(legacy),
    links,
    metrics: parseMetrics(legacy, result),

    url: `https://x.com/${author.handle}/status/${id}`,
  };
}

/* --------------------------------------------------------------- timeline */

/** Both shapes X currently uses to hang a timeline off a user result. */
const TIMELINE_PATHS = [
  'data.user.result.timeline_v2.timeline.instructions',
  'data.user.result.timeline.timeline.instructions',
  'data.user.result.timeline_response.timeline.instructions',
];

/**
 * Last resort: walk the payload looking for an `instructions` array.
 *
 * X moves this around between operations and deploys - a renamed wrapper key
 * would otherwise silently yield an empty feed, which is the worst kind of
 * failure because it looks like "they haven't posted".
 */
function searchInstructions(node: unknown, depth = 0): unknown[] | null {
  if (depth > 6) return null;

  if (Array.isArray(node)) {
    for (const child of node) {
      const found = searchInstructions(child, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const record = obj(node);
  if (!record) return null;

  if (Array.isArray(record.instructions)) return arr(record.instructions);

  for (const value of Object.values(record)) {
    const found = searchInstructions(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function findInstructions(payload: unknown): unknown[] {
  for (const path of TIMELINE_PATHS) {
    const found = dig(payload, path);
    if (Array.isArray(found)) return found;
  }
  return searchInstructions(payload) ?? [];
}

function collectFromEntry(entry: Dict, into: Tweet[], cursors: { bottom: string | null }): void {
  const content = obj(entry.content) ?? obj(entry.item);
  if (!content) return;

  const entryType = str(content.entryType) ?? str(content.__typename);

  if (entryType === 'TimelineTimelineCursor') {
    if (str(content.cursorType) === 'Bottom') cursors.bottom = str(content.value);
    return;
  }

  if (entryType === 'TimelineTimelineItem') {
    const itemContent = obj(content.itemContent);
    if (!itemContent) return;
    if (str(itemContent.cursorType) === 'Bottom') {
      cursors.bottom = str(itemContent.value);
      return;
    }
    if (str(itemContent.itemType) !== 'TimelineTweet') return;
    const tweet = parseTweetResult(dig(itemContent, 'tweet_results.result'));
    if (tweet) into.push(tweet);
    return;
  }

  // Self-threads and conversations arrive as a module of sub-entries.
  if (entryType === 'TimelineTimelineModule') {
    for (const sub of arr(content.items)) {
      const subEntry = obj(sub);
      if (subEntry) collectFromEntry(subEntry, into, cursors);
    }
  }
}

export function parseTimeline(payload: unknown): TimelinePage {
  const tweets: Tweet[] = [];
  const cursors: { bottom: string | null } = { bottom: null };

  for (const instructionRaw of findInstructions(payload)) {
    const instruction = obj(instructionRaw);
    if (!instruction) continue;

    const type = str(instruction.type) ?? str(instruction.__typename);

    if (type === 'TimelineAddEntries') {
      for (const entryRaw of arr(instruction.entries)) {
        const entry = obj(entryRaw);
        if (entry) collectFromEntry(entry, tweets, cursors);
      }
    } else if (type === 'TimelinePinEntry') {
      // Pinned posts are usually old; including them would wrongly float an
      // ancient post to the top of a reverse-chron feed on every sync.
      continue;
    }
  }

  // Guard against X handing back the same cursor forever, which would make
  // "load older" spin without advancing.
  const nextCursor = tweets.length > 0 ? cursors.bottom : null;

  return { tweets, nextCursor };
}

/* ------------------------------------------------------------- tweet detail */

/** Flattens a TweetDetail response into the root post plus its replies. */
export function parseThread(payload: unknown): Tweet[] {
  const direct = dig(
    payload,
    'data.threaded_conversation_with_injections_v2.instructions',
  );
  const instructions = Array.isArray(direct)
    ? direct
    : (searchInstructions(payload) ?? []);

  const tweets: Tweet[] = [];
  const cursors: { bottom: string | null } = { bottom: null };

  for (const instructionRaw of instructions) {
    const instruction = obj(instructionRaw);
    if (!instruction) continue;
    if ((str(instruction.type) ?? str(instruction.__typename)) !== 'TimelineAddEntries') {
      continue;
    }
    for (const entryRaw of arr(instruction.entries)) {
      const entry = obj(entryRaw);
      if (entry) collectFromEntry(entry, tweets, cursors);
    }
  }

  return tweets;
}
