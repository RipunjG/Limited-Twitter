/**
 * Local full-text search over the archive.
 *
 * Runs entirely against IndexedDB - we never call X's SearchTimeline. That is
 * partly privacy and partly practical: SearchTimeline is the one read endpoint
 * that hard-requires an `x-client-transaction-id`, so avoiding it removes the
 * most fragile dependency in the whole design.
 */

import MiniSearch from 'minisearch';

import { getDb } from './schema';
import type { StoredTweet } from './schema';

interface IndexedDoc {
  id: string;
  text: string;
  handle: string;
  displayName: string;
}

/**
 * Index the recent window eagerly; older posts are reachable through the
 * slower full scan. Keeps a cold start fast on a multi-year archive.
 */
const HOT_WINDOW_DAYS = 120;

let index: MiniSearch<IndexedDoc> | null = null;
let building: Promise<MiniSearch<IndexedDoc>> | null = null;
let indexedIds = new Set<string>();

function createIndex(): MiniSearch<IndexedDoc> {
  return new MiniSearch<IndexedDoc>({
    fields: ['text', 'handle', 'displayName'],
    storeFields: ['id'],
    searchOptions: {
      prefix: true,
      fuzzy: 0.2,
      boost: { handle: 2, displayName: 1.5 },
    },
  });
}

function toDoc(tweet: StoredTweet): IndexedDoc {
  return {
    id: tweet.id,
    // Quoted text is searchable too - you remember what the post was about,
    // not whose words they technically were.
    text: tweet.quotedTweet ? `${tweet.text}\n${tweet.quotedTweet.text}` : tweet.text,
    handle: tweet.author.handle,
    displayName: tweet.author.displayName,
  };
}

async function buildIndex(): Promise<MiniSearch<IndexedDoc>> {
  const db = await getDb();
  const cutoff = Date.now() - HOT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const docs: IndexedDoc[] = [];
  const ids = new Set<string>();

  const store = db.transaction('tweets').objectStore('tweets');
  const range = IDBKeyRange.bound([cutoff, ''], [Infinity, '￿']);
  for await (const cursor of store.index('by-created').iterate(range)) {
    docs.push(toDoc(cursor.value));
    ids.add(cursor.value.id);
  }

  const next = createIndex();
  next.addAll(docs);
  index = next;
  indexedIds = ids;
  return next;
}

export function ensureIndex(): Promise<MiniSearch<IndexedDoc>> {
  if (index) return Promise.resolve(index);
  building ??= buildIndex().finally(() => {
    building = null;
  });
  return building;
}

/** Keep the index current as sync inserts posts, without a full rebuild. */
export function addToIndex(tweets: StoredTweet[]): void {
  if (!index) return;
  const fresh = tweets.filter((tweet) => !indexedIds.has(tweet.id));
  if (fresh.length === 0) return;
  index.addAll(fresh.map(toDoc));
  for (const tweet of fresh) indexedIds.add(tweet.id);
}

export function invalidateIndex(): void {
  index = null;
  indexedIds = new Set();
}

export interface SearchOptions {
  limit?: number;
  /** Search the entire archive rather than just the recent window. */
  deep?: boolean;
}

/**
 * Returns matching posts, newest first.
 *
 * `deep` falls back to a linear scan of every stored post. It is slow by
 * design and only runs when the user explicitly asks for it.
 */
export async function searchTweets(
  query: string,
  options: SearchOptions = {},
): Promise<StoredTweet[]> {
  const { limit = 100, deep = false } = options;
  const trimmed = query.trim();
  if (!trimmed) return [];

  const db = await getDb();

  if (deep) {
    const needle = trimmed.toLowerCase();
    const results: StoredTweet[] = [];
    const store = db.transaction('tweets').objectStore('tweets');
    for await (const cursor of store.index('by-created').iterate(null, 'prev')) {
      const tweet = cursor.value;
      const haystack = `${tweet.text} ${tweet.author.handle} ${tweet.author.displayName}`;
      if (haystack.toLowerCase().includes(needle)) results.push(tweet);
      if (results.length >= limit) break;
    }
    return results;
  }

  const searcher = await ensureIndex();
  const hits = searcher.search(trimmed).slice(0, limit);
  if (hits.length === 0) return [];

  const store = db.transaction('tweets').objectStore('tweets');
  const found = await Promise.all(hits.map((hit) => store.get(String(hit.id))));

  return found
    .filter((tweet): tweet is StoredTweet => Boolean(tweet))
    .sort((a, b) => b.createdAt - a.createdAt);
}
