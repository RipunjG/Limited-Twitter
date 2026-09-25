import { useCallback, useEffect, useRef, useState } from 'react';

import { getFeed, setRead, type FeedCursor, type FeedFilter } from '@/db/repo';
import type { StoredTweet } from '@/db/schema';
import { addToIndex, searchTweets } from '@/db/search';

const PAGE_SIZE = 40;

export interface FeedState {
  tweets: StoredTweet[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  searching: boolean;
  reload: () => Promise<void>;
  loadMore: () => Promise<void>;
  /** Batched: scrolling past a screenful should be one write, not forty. */
  markRead: (ids: string[]) => void;
  /** Splice freshly synced posts into the current view without a refetch. */
  applyInserted: (tweets: StoredTweet[]) => void;
}

export interface UseFeedOptions {
  filter: FeedFilter;
  sourceUserId: string | null;
  query: string;
  /** Searching the whole archive rather than the recent window. */
  deepSearch: boolean;
  onReadChanged?: () => void;
}

export function useFeed(options: UseFeedOptions): FeedState {
  const { filter, sourceUserId, query, deepSearch, onReadChanged } = options;

  const [tweets, setTweets] = useState<StoredTweet[]>([]);
  const [cursor, setCursor] = useState<FeedCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const trimmedQuery = query.trim();
  const searching = trimmedQuery.length > 0;

  // Guards against a slow earlier request landing after a newer one and
  // overwriting the fresher results.
  const requestId = useRef(0);

  const reload = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);

    if (searching) {
      const results = await searchTweets(trimmedQuery, { deep: deepSearch });
      if (id !== requestId.current) return;
      setTweets(results);
      setCursor(null);
      setHasMore(false);
    } else {
      const page = await getFeed({ filter, sourceUserId, limit: PAGE_SIZE });
      if (id !== requestId.current) return;
      setTweets(page.tweets);
      setCursor(page.nextCursor);
      setHasMore(Boolean(page.nextCursor));
    }
    setLoading(false);
  }, [filter, sourceUserId, trimmedQuery, searching, deepSearch]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore || searching) return;
    setLoadingMore(true);
    const id = requestId.current;

    const page = await getFeed({
      filter,
      sourceUserId,
      limit: PAGE_SIZE,
      after: cursor,
    });

    if (id === requestId.current) {
      setTweets((previous) => {
        const seen = new Set(previous.map((tweet) => tweet.id));
        return [...previous, ...page.tweets.filter((tweet) => !seen.has(tweet.id))];
      });
      setCursor(page.nextCursor);
      setHasMore(Boolean(page.nextCursor));
    }
    setLoadingMore(false);
  }, [cursor, loadingMore, searching, filter, sourceUserId]);

  const markRead = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      const target = new Set(ids);

      // Optimistic: rows un-highlight instantly, the write follows.
      setTweets((previous) => {
        let changed = false;
        const next = previous.map((tweet) => {
          if (!target.has(tweet.id) || tweet.read === 1) return tweet;
          changed = true;
          return { ...tweet, read: 1 as const };
        });
        return changed ? next : previous;
      });

      void setRead(ids, 1).then(() => onReadChanged?.());
    },
    [onReadChanged],
  );

  const applyInserted = useCallback(
    (incoming: StoredTweet[]) => {
      if (incoming.length === 0) return;
      addToIndex(incoming);

      // A filtered or searched view should not have unrelated posts injected
      // into it mid-scroll; the sync badge tells the user to refresh instead.
      if (searching || sourceUserId || filter !== 'all') return;

      setTweets((previous) => {
        const seen = new Set(previous.map((tweet) => tweet.id));
        const fresh = incoming.filter((tweet) => !seen.has(tweet.id));
        if (fresh.length === 0) return previous;
        return [...fresh, ...previous].sort((a, b) => b.createdAt - a.createdAt);
      });
    },
    [searching, sourceUserId, filter],
  );

  return {
    tweets,
    loading,
    loadingMore,
    hasMore,
    searching,
    reload,
    loadMore,
    markRead,
    applyInserted,
  };
}
