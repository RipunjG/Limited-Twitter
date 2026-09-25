/**
 * Builders for X-shaped GraphQL payloads, used by the parser tests.
 *
 * These mirror the structures X actually returns rather than the structures
 * the parser happens to expect - the distinction matters, because every
 * parser bug so far has been the two drifting apart silently.
 */

export interface TweetOptions {
  id: string;
  text: string;
  createdAt: string;
  handle?: string;
  displayName?: string;
  userId?: string;
  /** Extra keys merged into `legacy`. */
  legacy?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export function userResult(options: {
  userId?: string;
  handle?: string;
  displayName?: string;
} = {}): Record<string, unknown> {
  const { userId = '99', handle = 'testuser', displayName = 'Test User' } = options;
  return {
    __typename: 'User',
    rest_id: userId,
    core: { name: displayName, screen_name: handle },
    avatar: { image_url: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg' },
    legacy: { followers_count: 5, description: 'bio' },
  };
}

export function tweetResult(options: TweetOptions): Record<string, unknown> {
  const { id, text, createdAt, legacy = {}, extra = {} } = options;
  return {
    __typename: 'Tweet',
    rest_id: id,
    core: { user_results: { result: userResult(options) } },
    legacy: {
      created_at: createdAt,
      full_text: text,
      display_text_range: [0, [...text].length],
      reply_count: 1,
      retweet_count: 2,
      favorite_count: 3,
      quote_count: 0,
      bookmark_count: 0,
      lang: 'en',
      entities: { urls: [] },
      ...legacy,
    },
    views: { count: '100' },
    ...extra,
  };
}

/** The classic entry shape, carrying `itemType`. */
export function entry(id: string, tweet: unknown): Record<string, unknown> {
  return {
    entryId: `tweet-${id}`,
    content: {
      entryType: 'TimelineTimelineItem',
      itemContent: { itemType: 'TimelineTweet', tweet_results: { result: tweet } },
    },
  };
}

/** Newer shape: `__typename` only, no `itemType`. */
export function entryTypenameOnly(id: string, tweet: unknown): Record<string, unknown> {
  return {
    entryId: `tweet-${id}`,
    content: {
      entryType: 'TimelineTimelineItem',
      itemContent: { __typename: 'TimelineTweet', tweet_results: { result: tweet } },
    },
  };
}

/**
 * A conversation module, as reply timelines return.
 *
 * The detail that matters: each sub-entry's `item` wrapper carries no
 * `entryType` and no `__typename`. Dispatching on entry type therefore finds
 * nothing here, which is how an entire reply timeline came back empty.
 */
export function moduleEntry(id: string, tweets: unknown[]): Record<string, unknown> {
  return {
    entryId: `profile-conversation-${id}`,
    sortIndex: id,
    content: {
      entryType: 'TimelineTimelineModule',
      __typename: 'TimelineTimelineModule',
      displayType: 'VerticalConversation',
      items: tweets.map((tweet, index) => ({
        entryId: `profile-conversation-${id}-tweet-${index}`,
        item: {
          itemContent: {
            itemType: 'TimelineTweet',
            __typename: 'TimelineTweet',
            tweet_results: { result: tweet },
          },
          clientEventInfo: { component: 'conversation' },
        },
      })),
    },
  };
}

export function cursorEntry(value: string): Record<string, unknown> {
  return {
    entryId: 'cursor-bottom-0',
    content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value },
  };
}

/** A full UserTweets-style response around the given entries. */
export function timelinePayload(
  entries: unknown[],
  options: { pinned?: unknown } = {},
): unknown {
  const instructions: unknown[] = [];
  if (options.pinned) {
    instructions.push({ type: 'TimelinePinEntry', entry: options.pinned });
  }
  instructions.push({ type: 'TimelineAddEntries', entries });

  return { data: { user: { result: { timeline: { timeline: { instructions } } } } } };
}
