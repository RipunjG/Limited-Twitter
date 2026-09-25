/**
 * One post in the feed.
 *
 * The "Open on X" link is the whole point of the app: you read here, and when
 * you want to reply you jump to the real site in the same Chrome profile,
 * already logged in.
 */

import { memo, useCallback } from 'react';

import type { StoredTweet } from '@/db/schema';
import type { Tweet } from '@/x/types';
import { absoluteTime, compactNumber, relativeTime } from '../format';
import {
  ChevronIcon,
  ExternalIcon,
  LikeIcon,
  ReplyIcon,
  RepostIcon,
  VerifiedIcon,
  ViewsIcon,
} from './Icons';
import { MediaGrid } from './MediaGrid';
import { RichText } from './RichText';
import './TweetCard.css';

interface TweetCardProps {
  tweet: StoredTweet;
  expanded: boolean;
  onToggleThread: (tweet: StoredTweet) => void;
  onMarkRead: (id: string) => void;
  children?: React.ReactNode;
}

function QuotedTweet({ tweet }: { tweet: Tweet }): React.JSX.Element {
  return (
    <a
      className="quoted"
      href={tweet.url}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="quoted__head">
        {tweet.author.avatarUrl && (
          <img className="quoted__avatar" src={tweet.author.avatarUrl} alt="" loading="lazy" />
        )}
        <span className="quoted__name">{tweet.author.displayName}</span>
        {tweet.author.verified && <VerifiedIcon className="icon-verified" />}
        <span className="quoted__handle">@{tweet.author.handle}</span>
        <span className="quoted__dot">·</span>
        <span className="quoted__time">{relativeTime(tweet.createdAt)}</span>
      </div>
      {tweet.text && (
        <p className="quoted__text">
          <RichText text={tweet.text} />
        </p>
      )}
      {tweet.media.length > 0 && <MediaGrid media={tweet.media} permalink={tweet.url} />}
    </a>
  );
}

export const TweetCard = memo(function TweetCard({
  tweet,
  expanded,
  onToggleThread,
  onMarkRead,
}: TweetCardProps): React.JSX.Element {
  const handleClick = useCallback(() => {
    if (tweet.read === 0) onMarkRead(tweet.id);
  }, [tweet.id, tweet.read, onMarkRead]);

  const { author, metrics } = tweet;

  return (
    <article
      className={`tweet${tweet.read === 0 ? ' is-unread' : ''}`}
      data-tweet-id={tweet.id}
      onClick={handleClick}
    >
      {tweet.retweetedBy && (
        <div className="tweet__context">
          <RepostIcon className="tweet__context-icon" />
          <span>{tweet.retweetedBy.displayName} reposted</span>
        </div>
      )}

      <div className="tweet__body">
        <a
          className="tweet__avatar-link"
          href={`https://x.com/${author.handle}`}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(event) => event.stopPropagation()}
        >
          {author.avatarUrl ? (
            <img className="tweet__avatar" src={author.avatarUrl} alt="" loading="lazy" />
          ) : (
            <span className="tweet__avatar tweet__avatar--empty" aria-hidden="true" />
          )}
        </a>

        <div className="tweet__content">
          <header className="tweet__head">
            <span className="tweet__name">{author.displayName}</span>
            {author.verified && <VerifiedIcon className="icon-verified" />}
            <span className="tweet__handle">@{author.handle}</span>
            <span className="tweet__dot">·</span>
            <time className="tweet__time" title={absoluteTime(tweet.createdAt)}>
              {relativeTime(tweet.createdAt)}
            </time>

            <a
              className="tweet__open"
              href={tweet.url}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(event) => event.stopPropagation()}
              title="Open on X to reply"
            >
              Open on X
              <ExternalIcon className="tweet__open-icon" />
            </a>
          </header>

          {tweet.isReply && tweet.replyToHandle && (
            <p className="tweet__replying">
              Replying to{' '}
              <a
                href={`https://x.com/${tweet.replyToHandle}`}
                target="_blank"
                rel="noreferrer noopener"
                onClick={(event) => event.stopPropagation()}
              >
                @{tweet.replyToHandle}
              </a>
            </p>
          )}

          {tweet.text && (
            <p className="tweet__text">
              <RichText text={tweet.text} />
            </p>
          )}

          {tweet.media.length > 0 && (
            <MediaGrid media={tweet.media} permalink={tweet.url} />
          )}

          {tweet.quotedTweet && <QuotedTweet tweet={tweet.quotedTweet} />}

          <footer className="tweet__metrics">
            <button
              type="button"
              className={`tweet__metric tweet__metric--button${expanded ? ' is-active' : ''}`}
              onClick={(event) => {
                event.stopPropagation();
                handleClick();
                onToggleThread(tweet);
              }}
              title={expanded ? 'Hide replies' : 'Load replies'}
            >
              <ReplyIcon className="tweet__metric-icon" />
              {metrics.replies > 0 && <span>{compactNumber(metrics.replies)}</span>}
              <ChevronIcon
                className={`tweet__metric-chevron${expanded ? ' is-open' : ''}`}
              />
            </button>

            <span className="tweet__metric">
              <RepostIcon className="tweet__metric-icon" />
              {metrics.reposts > 0 && <span>{compactNumber(metrics.reposts)}</span>}
            </span>

            <span className="tweet__metric">
              <LikeIcon className="tweet__metric-icon" />
              {metrics.likes > 0 && <span>{compactNumber(metrics.likes)}</span>}
            </span>

            {metrics.views !== null && (
              <span className="tweet__metric">
                <ViewsIcon className="tweet__metric-icon" />
                <span>{compactNumber(metrics.views)}</span>
              </span>
            )}

            {tweet.matchedAlerts.length > 0 && (
              <span className="tweet__alert-badge" title="Matched a keyword alert">
                alert
              </span>
            )}
          </footer>
        </div>
      </div>
    </article>
  );
});
