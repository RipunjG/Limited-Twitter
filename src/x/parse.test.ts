import { describe, expect, it } from 'vitest';

import {
  cursorEntry,
  entry,
  entryTypenameOnly,
  timelinePayload,
  tweetResult,
  userResult,
} from './fixtures';
import { parseProfile, parseThread, parseTimeline, parseTweetResult } from './parse';

const WHEN = 'Wed Sep 24 10:00:00 +0000 2026';
const LATER = 'Wed Sep 24 13:00:00 +0000 2026';

describe('parseTimeline', () => {
  it('reads the classic entry shape and the bottom cursor', () => {
    const page = parseTimeline(
      timelinePayload([
        entry('111', tweetResult({ id: '111', text: 'hello', createdAt: WHEN })),
        cursorEntry('CURSOR123'),
      ]),
    );

    expect(page.tweets).toHaveLength(1);
    expect(page.tweets[0]?.text).toBe('hello');
    expect(page.nextCursor).toBe('CURSOR123');
  });

  it('reads entries that carry __typename but no itemType', () => {
    // Newer operations, UserOriginalsTimeline among them, omit itemType.
    const page = parseTimeline(
      timelinePayload([
        entryTypenameOnly('222', tweetResult({ id: '222', text: 'newer shape', createdAt: WHEN })),
      ]),
    );

    expect(page.tweets).toHaveLength(1);
    expect(page.tweets[0]?.text).toBe('newer shape');
  });

  it('skips pinned posts so they do not float to the top every sync', () => {
    const page = parseTimeline(
      timelinePayload(
        [entry('111', tweetResult({ id: '111', text: 'recent', createdAt: WHEN }))],
        {
          pinned: entry(
            '999',
            tweetResult({ id: '999', text: 'pinned', createdAt: 'Wed Jan 01 00:00:00 +0000 2020' }),
          ),
        },
      ),
    );

    expect(page.tweets.map((tweet) => tweet.id)).toEqual(['111']);
  });

  it('recovers posts when the wrappers are completely unrecognised', () => {
    // The salvage path. Guards the worst failure mode: an unknown wrapper
    // yielding zero posts, which is indistinguishable from "nobody posted".
    const alien = {
      data: {
        user_result_by_rest_id: {
          result: {
            some_future_wrapper: {
              feed: {
                chunks: [
                  { post: { result: tweetResult({ id: '111', text: 'first', createdAt: WHEN }) } },
                  { post: { result: tweetResult({ id: '222', text: 'second', createdAt: LATER }) } },
                ],
              },
            },
          },
        },
      },
    };

    const page = parseTimeline(alien);

    expect(page.tweets).toHaveLength(2);
    // Newest first, same as the structured path.
    expect(page.tweets.map((tweet) => tweet.id)).toEqual(['222', '111']);
  });

  it('returns nothing rather than throwing on junk', () => {
    expect(parseTimeline(null).tweets).toEqual([]);
    expect(parseTimeline({}).tweets).toEqual([]);
    expect(parseTimeline({ data: { user: { result: {} } } }).tweets).toEqual([]);
  });

  it('does not offer a cursor when no posts were found', () => {
    expect(parseTimeline(timelinePayload([cursorEntry('CURSOR123')])).nextCursor).toBeNull();
  });
});

describe('parseTweetResult', () => {
  it('surfaces the original post on a repost and records who boosted it', () => {
    const tweet = parseTweetResult(
      tweetResult({
        id: '333',
        text: 'RT @someone: truncated…',
        createdAt: LATER,
        handle: 'booster',
        legacy: {
          retweeted_status_result: {
            result: tweetResult({
              id: '444',
              text: 'the actual content',
              createdAt: WHEN,
              handle: 'author',
            }),
          },
        },
      }),
    );

    expect(tweet?.text).toBe('the actual content');
    expect(tweet?.author.handle).toBe('author');
    expect(tweet?.retweetedBy?.handle).toBe('booster');
    // The repost keeps its own id so two accounts boosting one post stay distinct.
    expect(tweet?.id).toBe('333');
    expect(tweet?.retweetOfId).toBe('444');
    // Permalink points at the original, as X's own card does.
    expect(tweet?.url).toBe('https://x.com/author/status/444');
  });

  it('slices display_text_range by code point, not UTF-16 unit', () => {
    // Naive slicing truncates any post containing emoji - which is most of them.
    const text = '👋👋 hi';
    const tweet = parseTweetResult(
      tweetResult({
        id: '1',
        text,
        createdAt: WHEN,
        legacy: { display_text_range: [0, [...text].length] },
      }),
    );

    expect(tweet?.text).toBe('👋👋 hi');
  });

  it('expands t.co links to their destination', () => {
    const tweet = parseTweetResult(
      tweetResult({
        id: '1',
        text: 'look at https://t.co/abc123',
        createdAt: WHEN,
        legacy: {
          entities: {
            urls: [
              {
                url: 'https://t.co/abc123',
                expanded_url: 'https://example.com/article',
                display_url: 'example.com/article',
              },
            ],
          },
        },
      }),
    );

    expect(tweet?.text).toBe('look at https://example.com/article');
    expect(tweet?.links[0]?.url).toBe('https://example.com/article');
  });

  it('prefers long-form note_tweet text over the truncated legacy text', () => {
    const tweet = parseTweetResult(
      tweetResult({
        id: '1',
        text: 'truncated version…',
        createdAt: WHEN,
        extra: {
          note_tweet: {
            note_tweet_results: {
              result: { text: 'the full long-form body', entity_set: { urls: [] } },
            },
          },
        },
      }),
    );

    expect(tweet?.text).toBe('the full long-form body');
  });

  it('picks the highest-bitrate mp4 for video', () => {
    const tweet = parseTweetResult(
      tweetResult({
        id: '1',
        text: 'clip',
        createdAt: WHEN,
        legacy: {
          extended_entities: {
            media: [
              {
                type: 'video',
                media_url_https: 'https://pbs.twimg.com/poster.jpg',
                original_info: { width: 1280, height: 720 },
                video_info: {
                  variants: [
                    { content_type: 'application/x-mpegURL', url: 'https://v/hls.m3u8' },
                    { content_type: 'video/mp4', bitrate: 832000, url: 'https://v/low.mp4' },
                    { content_type: 'video/mp4', bitrate: 2176000, url: 'https://v/high.mp4' },
                  ],
                },
              },
            ],
          },
        },
      }),
    );

    expect(tweet?.media[0]?.kind).toBe('video');
    expect(tweet?.media[0]?.videoUrl).toBe('https://v/high.mp4');
  });

  it('rejects tombstones and malformed nodes instead of throwing', () => {
    expect(parseTweetResult({ __typename: 'TweetTombstone' })).toBeNull();
    expect(parseTweetResult({ __typename: 'Tweet', rest_id: '1' })).toBeNull();
    expect(parseTweetResult(null)).toBeNull();
    expect(parseTweetResult('nonsense')).toBeNull();
  });

  it('unwraps visibility-limited posts', () => {
    const tweet = parseTweetResult({
      __typename: 'TweetWithVisibilityResults',
      tweet: tweetResult({ id: '555', text: 'limited', createdAt: WHEN }),
    });

    expect(tweet?.id).toBe('555');
    expect(tweet?.text).toBe('limited');
  });
});

describe('parseProfile', () => {
  it('reads a user from either core or legacy', () => {
    const profile = parseProfile({ data: { user: { result: userResult({ handle: 'someone' }) } } });

    expect(profile?.handle).toBe('someone');
    expect(profile?.userId).toBe('99');
    expect(profile?.followersCount).toBe(5);
    // "_normal" is a 48px thumbnail and looks blurry on retina.
    expect(profile?.avatarUrl).toContain('_x96.');
  });

  it('returns null for a missing user', () => {
    expect(parseProfile({ data: { user: {} } })).toBeNull();
  });
});

describe('parseThread', () => {
  it('reads a conversation', () => {
    const payload = {
      data: {
        threaded_conversation_with_injections_v2: {
          instructions: [
            {
              type: 'TimelineAddEntries',
              entries: [
                entry('1', tweetResult({ id: '1', text: 'root', createdAt: WHEN })),
                entry('2', tweetResult({ id: '2', text: 'a reply', createdAt: LATER })),
              ],
            },
          ],
        },
      },
    };

    expect(parseThread(payload).map((tweet) => tweet.id)).toEqual(['1', '2']);
  });

  it('returns an empty array rather than throwing on junk', () => {
    expect(parseThread(null)).toEqual([]);
    expect(parseThread({})).toEqual([]);
  });
});
