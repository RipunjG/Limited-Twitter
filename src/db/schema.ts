/**
 * IndexedDB schema.
 *
 * Everything lives in the browser - there is no server and no hosted database,
 * which is what keeps this project free and keeps your reading history off
 * anyone else's disk.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Tweet } from '@/x/types';

export const DB_NAME = 'silent-feed';
export const DB_VERSION = 1;

/** IndexedDB cannot index booleans, so read state is stored as 0 | 1. */
export type Flag = 0 | 1;

export interface TrackedUser {
  /** Lowercased handle - the primary key, stable across display-name changes. */
  handle: string;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  /** Unfollowed accounts stay in the DB but are skipped by sync. */
  enabled: boolean;
  addedAt: number;
  lastSyncedAt: number | null;
  /** Populated when the last sync attempt failed, cleared on success. */
  lastError: string | null;
  protected: boolean;
}

export interface StoredTweet extends Tweet {
  /**
   * The tracked account whose timeline surfaced this post. Differs from
   * `author` on retweets, where `author` is the original writer.
   *
   * First writer wins: if two tracked accounts both boost the same post we
   * keep one row rather than showing it twice.
   */
  sourceUserId: string;
  read: Flag;
  /** When the post first entered the local archive. */
  fetchedAt: number;
  /** Ids of alert rules this post matched, for the Alerts filter. */
  matchedAlerts: string[];
}

export interface StoredThread {
  rootTweetId: string;
  fetchedAt: number;
  tweets: Tweet[];
}

export interface AlertRule {
  id: string;
  /** Plain substring, or a regex source when `isRegex`. */
  pattern: string;
  isRegex: boolean;
  /** Empty means "any tracked account". */
  handles: string[];
  enabled: boolean;
  createdAt: number;
}

export interface Settings {
  /** Accounts synced less recently than this are refreshed on page load. */
  stalenessMinutes: number;
  /** How many timeline requests run at once. */
  concurrency: number;
  includeReplies: boolean;
  postsPerSync: number;
  notificationsEnabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  stalenessMinutes: 30,
  concurrency: 4,
  includeReplies: true,
  postsPerSync: 20,
  notificationsEnabled: false,
};

interface SilentFeedDB extends DBSchema {
  users: {
    key: string;
    value: TrackedUser;
    indexes: { 'by-added': number };
  };
  tweets: {
    key: string;
    value: StoredTweet;
    indexes: {
      /**
       * Feed ordering indexes end in `id` so cursor pagination is exact.
       * Ordering on createdAt alone would silently skip or repeat posts that
       * share a timestamp, which is common - scheduled posts and threads
       * frequently land in the same second.
       */
      'by-created': [number, string];
      'by-source-created': [string, number, string];
      'by-read-created': [number, number, string];
      /** Counting only, hence no id component. */
      'by-source-read': [string, number];
    };
  };
  threads: {
    key: string;
    value: StoredThread;
  };
  alerts: {
    key: string;
    value: AlertRule;
  };
  meta: {
    key: string;
    value: unknown;
  };
}

export type SilentFeedDatabase = IDBPDatabase<SilentFeedDB>;

let handle: Promise<SilentFeedDatabase> | null = null;

export function getDb(): Promise<SilentFeedDatabase> {
  handle ??= openDB<SilentFeedDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const users = db.createObjectStore('users', { keyPath: 'handle' });
      users.createIndex('by-added', 'addedAt');

      const tweets = db.createObjectStore('tweets', { keyPath: 'id' });
      // Main reverse-chron feed.
      tweets.createIndex('by-created', ['createdAt', 'id']);
      // One account's posts, newest first.
      tweets.createIndex('by-source-created', ['sourceUserId', 'createdAt', 'id']);
      // Unread badge per account - a counted range query, not a scan.
      tweets.createIndex('by-source-read', ['sourceUserId', 'read']);
      // The "Unread" filter across all accounts.
      tweets.createIndex('by-read-created', ['read', 'createdAt', 'id']);

      db.createObjectStore('threads', { keyPath: 'rootTweetId' });
      db.createObjectStore('alerts', { keyPath: 'id' });
      db.createObjectStore('meta');
    },
  });
  return handle;
}
