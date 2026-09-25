/**
 * The comment thread under a post, fetched only when you expand a card.
 *
 * On-demand is the whole point: pre-fetching threads for every post would
 * multiply request volume by an order of magnitude for content you would
 * mostly never read.
 */

import { useEffect, useState } from 'react';

import { getThread, putThread } from '@/db/repo';
import { fetchThread } from '@/x/operations';
import type { Tweet } from '@/x/types';
import { compactNumber, relativeTime } from '../format';
import { ExternalIcon, LikeIcon, VerifiedIcon } from './Icons';
import { MediaGrid } from './MediaGrid';
import { RichText } from './RichText';
import './Thread.css';

/** Re-fetch a cached thread once it is older than this. */
const STALE_MS = 15 * 60 * 1000;

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; replies: Tweet[]; cached: boolean }
  | { phase: 'error'; message: string };

interface ThreadProps {
  rootTweetId: string;
}

export function Thread({ rootTweetId }: ThreadProps): React.JSX.Element {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      setState({ phase: 'loading' });

      const cached = await getThread(rootTweetId);
      const fresh = cached && Date.now() - cached.fetchedAt < STALE_MS;

      // Show what we have immediately, then refresh behind it if stale.
      if (cached && !cancelled) {
        setState({
          phase: 'ready',
          replies: cached.tweets.filter((tweet) => tweet.id !== rootTweetId),
          cached: true,
        });
        if (fresh && reloadToken === 0) return;
      }

      try {
        const tweets = await fetchThread(rootTweetId);
        if (cancelled) return;
        await putThread(rootTweetId, tweets);
        setState({
          phase: 'ready',
          replies: tweets.filter((tweet) => tweet.id !== rootTweetId),
          cached: false,
        });
      } catch (error) {
        if (cancelled) return;
        // A cached copy beats an error message.
        if (cached) return;
        setState({
          phase: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [rootTweetId, reloadToken]);

  if (state.phase === 'loading') {
    return (
      <div className="thread thread--status">
        <span className="thread__spinner" aria-hidden="true" />
        Loading replies…
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="thread thread--status is-error">
        {state.message}
        <button
          type="button"
          className="thread__retry"
          onClick={() => setReloadToken((token) => token + 1)}
        >
          Retry
        </button>
      </div>
    );
  }

  if (state.replies.length === 0) {
    return <div className="thread thread--status">No replies yet.</div>;
  }

  return (
    <div className="thread">
      {state.replies.map((reply) => (
        <article key={reply.id} className="reply">
          {reply.author.avatarUrl ? (
            <img className="reply__avatar" src={reply.author.avatarUrl} alt="" loading="lazy" />
          ) : (
            <span className="reply__avatar" />
          )}
          <div className="reply__content">
            <header className="reply__head">
              <span className="reply__name">{reply.author.displayName}</span>
              {reply.author.verified && <VerifiedIcon className="icon-verified" />}
              <span className="reply__handle">@{reply.author.handle}</span>
              <span className="reply__dot">·</span>
              <span className="reply__time">{relativeTime(reply.createdAt)}</span>
              <a
                className="reply__open"
                href={reply.url}
                target="_blank"
                rel="noreferrer noopener"
                title="Open this reply on X"
                aria-label="Open this reply on X"
              >
                <ExternalIcon />
              </a>
            </header>
            {reply.text && (
              <p className="reply__text">
                <RichText text={reply.text} />
              </p>
            )}
            {reply.media.length > 0 && (
              <MediaGrid media={reply.media} permalink={reply.url} />
            )}
            {reply.metrics.likes > 0 && (
              <span className="reply__likes">
                <LikeIcon />
                {compactNumber(reply.metrics.likes)}
              </span>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
