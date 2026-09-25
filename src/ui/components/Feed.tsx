/**
 * The scrolling list.
 *
 * Read state is driven by scrolling past a post rather than by an explicit
 * action - the same gesture you already make when reading. Writes are batched
 * so flicking through a screenful is one transaction, not forty.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { StoredTweet } from '@/db/schema';
import { Thread } from './Thread';
import { TweetCard } from './TweetCard';
import './Feed.css';

const READ_FLUSH_MS = 400;

interface FeedProps {
  tweets: StoredTweet[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  emptyState: React.ReactNode;
  onMarkRead: (ids: string[]) => void;
  onLoadMore: () => void;
}

export function Feed(props: FeedProps): React.JSX.Element {
  const { tweets, loading, loadingMore, hasMore, emptyState, onMarkRead, onLoadMore } =
    props;

  const [expanded, setExpanded] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Queue + timer live in refs so the observer callback never needs to be
  // rebuilt, which would detach and reattach every row on each render.
  const pending = useRef<Set<string>>(new Set());
  const flushTimer = useRef<number | null>(null);
  const markReadRef = useRef(onMarkRead);
  markReadRef.current = onMarkRead;

  const flush = useCallback(() => {
    flushTimer.current = null;
    if (pending.current.size === 0) return;
    const ids = [...pending.current];
    pending.current.clear();
    markReadRef.current(ids);
  }, []);

  const queueRead = useCallback(
    (id: string) => {
      pending.current.add(id);
      if (flushTimer.current === null) {
        flushTimer.current = window.setTimeout(flush, READ_FLUSH_MS);
      }
    },
    [flush],
  );

  // Flush anything still queued when the view changes or the tab closes.
  useEffect(() => {
    const onHide = (): void => flush();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      flush();
    };
  }, [flush]);

  /** Mark a post read once it has scrolled off the top of the viewport. */
  useEffect(() => {
    const root = listRef.current;
    if (!root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) continue;
          // Above the fold means read; below means not yet seen.
          if (entry.boundingClientRect.top >= 0) continue;

          const id = (entry.target as HTMLElement).dataset.tweetId;
          if (id) {
            queueRead(id);
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0 },
    );

    for (const node of root.querySelectorAll<HTMLElement>('.tweet.is-unread')) {
      observer.observe(node);
    }
    return () => observer.disconnect();
  }, [tweets, queueRead]);

  /** Infinite scroll. */
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, onLoadMore, tweets.length]);

  const toggleThread = useCallback((tweet: StoredTweet) => {
    setExpanded((current) => (current === tweet.id ? null : tweet.id));
  }, []);

  const markOne = useCallback((id: string) => markReadRef.current([id]), []);

  if (loading) {
    return (
      <div className="feed feed--status">
        <span className="feed__spinner" aria-hidden="true" />
        Loading…
      </div>
    );
  }

  if (tweets.length === 0) {
    return <div className="feed feed--empty">{emptyState}</div>;
  }

  return (
    <div className="feed" ref={listRef}>
      {tweets.map((tweet) => (
        <div key={tweet.id}>
          <TweetCard
            tweet={tweet}
            expanded={expanded === tweet.id}
            onToggleThread={toggleThread}
            onMarkRead={markOne}
          />
          {expanded === tweet.id && <Thread rootTweetId={tweet.id} />}
        </div>
      ))}

      <div ref={sentinelRef} className="feed__sentinel">
        {loadingMore && (
          <>
            <span className="feed__spinner" aria-hidden="true" />
            Loading more…
          </>
        )}
        {!hasMore && <span className="feed__end">You are all caught up.</span>}
      </div>
    </div>
  );
}
