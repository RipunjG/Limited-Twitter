/**
 * Every read and write against IndexedDB. The UI and sync layers call these
 * and never touch `idb` directly.
 */

import type { Tweet, XProfile } from '@/x/types';
import {
  DEFAULT_SETTINGS,
  getDb,
  type AlertRule,
  type Flag,
  type Settings,
  type StoredThread,
  type StoredTweet,
  type TrackedUser,
} from './schema';

const SETTINGS_KEY = 'settings';

/* ------------------------------------------------------------------ users */

export async function listUsers(): Promise<TrackedUser[]> {
  const db = await getDb();
  const users = await db.getAll('users');
  return users.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
  );
}

export async function getUser(handle: string): Promise<TrackedUser | undefined> {
  const db = await getDb();
  return db.get('users', handle.toLowerCase());
}

export async function addUser(profile: XProfile): Promise<TrackedUser> {
  const db = await getDb();
  const key = profile.handle.toLowerCase();
  const existing = await db.get('users', key);

  const user: TrackedUser = {
    handle: key,
    userId: profile.userId,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    enabled: existing?.enabled ?? true,
    addedAt: existing?.addedAt ?? Date.now(),
    lastSyncedAt: existing?.lastSyncedAt ?? null,
    lastError: null,
    protected: profile.protected,
  };

  await db.put('users', user);
  return user;
}

export async function removeUser(handle: string): Promise<void> {
  const db = await getDb();
  const key = handle.toLowerCase();
  const user = await db.get('users', key);
  if (!user) return;

  // Drop the account's archived posts too, so removing someone actually
  // removes them rather than leaving orphans cluttering the feed.
  const tx = db.transaction(['users', 'tweets', 'threads'], 'readwrite');
  const tweets = tx.objectStore('tweets');
  const range = IDBKeyRange.bound(
    [user.userId, -Infinity, ''],
    [user.userId, Infinity, '￿'],
  );

  const removedIds: string[] = [];
  for await (const cursor of tweets.index('by-source-created').iterate(range)) {
    removedIds.push(cursor.value.id);
    await cursor.delete();
  }

  // Cached conversations are keyed by the post they hang off, so they would
  // otherwise linger indefinitely with no way to reach or clear them.
  const threads = tx.objectStore('threads');
  for (const id of removedIds) {
    await threads.delete(id);
  }

  await tx.objectStore('users').delete(key);
  await tx.done;
}

export async function setUserEnabled(handle: string, enabled: boolean): Promise<void> {
  const db = await getDb();
  const key = handle.toLowerCase();
  const user = await db.get('users', key);
  if (!user) return;
  await db.put('users', { ...user, enabled });
}

export async function recordSyncResult(
  handle: string,
  outcome: { ok: true } | { ok: false; error: string },
): Promise<void> {
  const db = await getDb();
  const key = handle.toLowerCase();
  const user = await db.get('users', key);
  if (!user) return;
  await db.put('users', {
    ...user,
    lastSyncedAt: outcome.ok ? Date.now() : user.lastSyncedAt,
    lastError: outcome.ok ? null : outcome.error,
  });
}

/* ----------------------------------------------------------------- tweets */

export interface UpsertResult {
  /** Posts not previously in the archive - what alerts and badges key off. */
  inserted: StoredTweet[];
  updated: number;
}

/**
 * Insert new posts and refresh the metrics on ones already stored.
 *
 * Read state is never clobbered: a post you have already read stays read even
 * when its like count changes on a later sync.
 */
export async function upsertTweets(
  sourceUserId: string,
  tweets: Tweet[],
  matchAlerts: (tweet: Tweet) => string[],
): Promise<UpsertResult> {
  if (tweets.length === 0) return { inserted: [], updated: 0 };

  const db = await getDb();
  const tx = db.transaction('tweets', 'readwrite');
  const store = tx.objectStore('tweets');
  const now = Date.now();

  const inserted: StoredTweet[] = [];
  let updated = 0;

  for (const tweet of tweets) {
    const existing = await store.get(tweet.id);

    if (existing) {
      await store.put({
        ...existing,
        metrics: tweet.metrics,
        text: tweet.text,
        media: tweet.media,
      });
      updated += 1;
      continue;
    }

    const record: StoredTweet = {
      ...tweet,
      sourceUserId,
      read: 0,
      fetchedAt: now,
      matchedAlerts: matchAlerts(tweet),
    };
    await store.put(record);
    inserted.push(record);
  }

  await tx.done;
  return { inserted, updated };
}

export type FeedFilter = 'all' | 'unread' | 'posts' | 'replies' | 'media' | 'alerts';

export interface FeedCursor {
  createdAt: number;
  id: string;
}

export interface FeedQuery {
  filter: FeedFilter;
  /** Restrict to one tracked account. */
  sourceUserId?: string | null;
  limit?: number;
  after?: FeedCursor | null;
}

export interface FeedPage {
  tweets: StoredTweet[];
  nextCursor: FeedCursor | null;
}

/**
 * One page of the feed, newest first.
 *
 * `unread` and per-account views use dedicated indexes so they stay range
 * scans. The remaining filters (posts / replies / media / alerts) are applied
 * while walking the index - they have no useful index of their own, and
 * over-reading a little is cheaper than maintaining more indexes.
 */
export async function getFeed(query: FeedQuery): Promise<FeedPage> {
  const { filter, sourceUserId = null, limit = 40, after = null } = query;
  const db = await getDb();
  const store = db.transaction('tweets').objectStore('tweets');

  const matchesFilter = (tweet: StoredTweet): boolean => {
    switch (filter) {
      case 'posts':
        return !tweet.isReply;
      case 'replies':
        return tweet.isReply;
      case 'media':
        return tweet.media.length > 0;
      case 'alerts':
        return tweet.matchedAlerts.length > 0;
      case 'unread':
        return tweet.read === 0;
      default:
        return true;
    }
  };

  // Pick the tightest index the query allows.
  let iterator: AsyncIterable<{ value: StoredTweet }>;

  if (sourceUserId) {
    const upper: [string, number, string] = after
      ? [sourceUserId, after.createdAt, after.id]
      : [sourceUserId, Infinity, '￿'];
    iterator = store
      .index('by-source-created')
      .iterate(
        IDBKeyRange.bound([sourceUserId, -Infinity, ''], upper, false, Boolean(after)),
        'prev',
      );
  } else if (filter === 'unread') {
    const upper: [number, number, string] = after
      ? [0, after.createdAt, after.id]
      : [0, Infinity, '￿'];
    iterator = store
      .index('by-read-created')
      .iterate(IDBKeyRange.bound([0, -Infinity, ''], upper, false, Boolean(after)), 'prev');
  } else {
    const upper: [number, string] = after
      ? [after.createdAt, after.id]
      : [Infinity, '￿'];
    iterator = store
      .index('by-created')
      .iterate(IDBKeyRange.bound([-Infinity, ''], upper, false, Boolean(after)), 'prev');
  }

  const tweets: StoredTweet[] = [];
  let last: StoredTweet | null = null;

  for await (const cursor of iterator) {
    last = cursor.value;
    if (matchesFilter(cursor.value)) tweets.push(cursor.value);
    if (tweets.length >= limit) break;
  }

  // Only advertise a next page when we actually filled this one; otherwise we
  // reached the end of the archive.
  const nextCursor =
    tweets.length >= limit && last ? { createdAt: last.createdAt, id: last.id } : null;

  return { tweets, nextCursor };
}

export async function getTweet(id: string): Promise<StoredTweet | undefined> {
  const db = await getDb();
  return db.get('tweets', id);
}

/* ------------------------------------------------------------- read state */

export async function setRead(ids: string[], read: Flag): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const tx = db.transaction('tweets', 'readwrite');
  const store = tx.objectStore('tweets');
  for (const id of ids) {
    const tweet = await store.get(id);
    if (tweet && tweet.read !== read) await store.put({ ...tweet, read });
  }
  await tx.done;
}

export async function markAllRead(sourceUserId?: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('tweets', 'readwrite');
  const store = tx.objectStore('tweets');

  // Reading the whole match set first avoids mutating the index we are
  // iterating, which can skip records mid-cursor.
  const pending: StoredTweet[] = [];

  const cursors = sourceUserId
    ? store.index('by-source-read').iterate(IDBKeyRange.only([sourceUserId, 0]))
    : store
        .index('by-read-created')
        .iterate(IDBKeyRange.bound([0, -Infinity, ''], [0, Infinity, '￿']));

  for await (const cursor of cursors) {
    pending.push(cursor.value);
  }
  for (const tweet of pending) {
    await store.put({ ...tweet, read: 1 });
  }
  await tx.done;
}

/** Unread count per tracked account, keyed by userId. */
export async function unreadCounts(): Promise<Map<string, number>> {
  const db = await getDb();
  const users = await db.getAll('users');
  const index = db.transaction('tweets').objectStore('tweets').index('by-source-read');

  const counts = new Map<string, number>();
  await Promise.all(
    users.map(async (user) => {
      counts.set(user.userId, await index.count(IDBKeyRange.only([user.userId, 0])));
    }),
  );
  return counts;
}

export async function totalUnread(): Promise<number> {
  const db = await getDb();
  return db
    .transaction('tweets')
    .objectStore('tweets')
    .index('by-read-created')
    .count(IDBKeyRange.bound([0, -Infinity, ''], [0, Infinity, '￿']));
}

/* ---------------------------------------------------------------- threads */

export async function getThread(rootTweetId: string): Promise<StoredThread | undefined> {
  const db = await getDb();
  return db.get('threads', rootTweetId);
}

export async function putThread(rootTweetId: string, tweets: Tweet[]): Promise<StoredThread> {
  const db = await getDb();
  const record: StoredThread = { rootTweetId, fetchedAt: Date.now(), tweets };
  await db.put('threads', record);
  return record;
}

/* ----------------------------------------------------------------- alerts */

export async function listAlerts(): Promise<AlertRule[]> {
  const db = await getDb();
  const alerts = await db.getAll('alerts');
  return alerts.sort((a, b) => a.createdAt - b.createdAt);
}

export async function putAlert(alert: AlertRule): Promise<void> {
  const db = await getDb();
  await db.put('alerts', alert);
}

export async function deleteAlert(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('alerts', id);
}

/* --------------------------------------------------------------- settings */

export async function getSettings(): Promise<Settings> {
  const db = await getDb();
  const stored = (await db.get('meta', SETTINGS_KEY)) as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const db = await getDb();
  const next = { ...(await getSettings()), ...patch };
  await db.put('meta', next, SETTINGS_KEY);
  return next;
}
