/** Normalized shapes the rest of the app works with. Nothing downstream of
 * `parse.ts` should ever touch X's raw GraphQL payloads. */

export interface MediaItem {
  kind: 'photo' | 'video' | 'gif';
  /** Still image. For video/gif this is the poster frame. */
  url: string;
  /** Best-effort direct playback URL; null means "open it on X". */
  videoUrl: string | null;
  width: number | null;
  height: number | null;
  altText: string | null;
}

export interface TweetMetrics {
  replies: number;
  reposts: number;
  likes: number;
  quotes: number;
  views: number | null;
  bookmarks: number;
}

export interface TweetAuthor {
  userId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  verified: boolean;
}

export interface Tweet {
  /** X snowflake id, kept as a string - it exceeds Number.MAX_SAFE_INTEGER. */
  id: string;
  author: TweetAuthor;
  /** Epoch ms. */
  createdAt: number;
  text: string;
  lang: string | null;

  isReply: boolean;
  replyToTweetId: string | null;
  replyToHandle: string | null;

  /** Set when this entry is a retweet; points at the original tweet's id. */
  retweetOfId: string | null;
  /** The account that did the retweeting, when different from `author`. */
  retweetedBy: TweetAuthor | null;

  quotedTweetId: string | null;
  quotedTweet: Tweet | null;

  media: MediaItem[];
  /** Outbound links with X's t.co unwrapped back to the real destination. */
  links: Array<{ url: string; display: string }>;
  metrics: TweetMetrics;

  /** Permalink on x.com. */
  url: string;
}

export interface TimelinePage {
  tweets: Tweet[];
  /** Pass back as `cursor` to page further into history; null when exhausted. */
  nextCursor: string | null;
}

export interface XProfile {
  userId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  verified: boolean;
  followersCount: number | null;
  protected: boolean;
}
