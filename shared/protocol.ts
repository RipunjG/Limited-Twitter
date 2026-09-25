/**
 * Wire contract between the Vercel-hosted page and the Tampermonkey bridge.
 *
 * Design rule: the page never sees credentials. It asks for an *operation by
 * name* with variables; the bridge owns the recipes (queryId, bearer, ct0,
 * feature flags) and assembles the real request. That keeps the X session
 * token out of page JavaScript entirely.
 */

export const BRIDGE_PROTOCOL_VERSION = 1;

/** Marker key on every postMessage envelope so we ignore unrelated chatter. */
export const ENVELOPE_KEY = '__silentfeed';

/**
 * Which GraphQL operations the bridge will capture and replay.
 *
 * This is a *pattern*, not a fixed list, and that is deliberate. X renames
 * these between frontend deploys - `UserTweets` became `UserOriginalsTimeline`
 * - so a hardcoded list quietly stops matching and the app goes blind. Naming
 * the shape we accept instead survives renames without a code change, which
 * was the whole point of learning recipes from live traffic.
 */
export const CORE_OPERATIONS = ['UserByScreenName', 'TweetDetail'] as const;

/**
 * Timeline operations in preference order. The first one with a captured
 * recipe wins; several are listed because which names exist, and which tab of
 * a profile teaches them, varies by deploy.
 */
export const TIMELINE_WITH_REPLIES = [
  'UserTweetsAndReplies',
  'UserRepliesTimeline',
  'UserWithRepliesTimeline',
] as const;

export const TIMELINE_POSTS_ONLY = [
  'UserOriginalsTimeline',
  'UserTweets',
  'UserPostsTimeline',
] as const;

/** Any user-timeline-shaped read operation. */
const TIMELINE_PATTERN = /^User[A-Za-z]*(?:Timeline|Tweets|TweetsAndReplies)$/;

export type AllowedOperation = string;

export function isTimelineOperation(value: string): boolean {
  return TIMELINE_PATTERN.test(value);
}

export function isAllowedOperation(value: string): value is AllowedOperation {
  return (
    (CORE_OPERATIONS as readonly string[]).includes(value) || isTimelineOperation(value)
  );
}

/**
 * Onboarding steps, expressed as capabilities rather than X's operation names
 * so the UI does not need updating when X renames things.
 */
export type MissingCapability = 'profile' | 'timeline' | 'thread';

/**
 * A captured request "recipe" - everything needed to replay one GraphQL
 * operation the way X's own frontend issues it.
 *
 * `features` / `fieldToggles` are kept as the *raw JSON strings* X sent, not
 * parsed objects: the server rejects payloads whose flag set does not match
 * the deployed frontend, so byte-faithful replay is the point.
 */
export interface Recipe {
  operation: string;
  queryId: string;
  method: 'GET' | 'POST';
  /** Allowlisted headers only - see HEADER_ALLOWLIST in the bridge. */
  headers: Record<string, string>;
  /**
   * The variables X itself sent, raw. Used as the *base* that our overrides
   * (userId, count, cursor) are merged onto - X's timeline queries carry a
   * dozen `include*` / `withX` booleans that must be present or the request
   * is rejected, and those change between deploys too.
   */
  variables: string | null;
  features: string | null;
  fieldToggles: string | null;
  capturedAt: number;
}

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  /** Unix seconds when the window resets. */
  reset: number | null;
}

export interface BridgeStatus {
  version: number;
  /** True once the x.com half has seen a ct0 cookie. */
  hasCsrfToken: boolean;
  recipes: Array<Pick<Recipe, 'operation' | 'queryId' | 'capturedAt'>>;
  /** Capabilities still missing a captured recipe. */
  missing: MissingCapability[];
  /**
   * Every GraphQL operation the harvester has ever seen on x.com, including
   * ones we do not replay. An empty list means we are not observing X's
   * traffic at all - a fundamentally different problem from seeing it but not
   * recognising it.
   */
  observed: string[];
}

export type BridgeCall =
  | { op: 'ping' }
  | { op: 'status' }
  | {
      op: 'graphql';
      operation: AllowedOperation;
      /** Merged over the recipe's own variables before sending. */
      variables: Record<string, unknown>;
      timeoutMs?: number;
    };

export type BridgeResult =
  | { ok: true; op: 'ping'; version: number }
  | { ok: true; op: 'status'; status: BridgeStatus }
  | {
      ok: true;
      op: 'graphql';
      status: number;
      data: unknown;
      rateLimit: RateLimitInfo;
    }
  | {
      ok: false;
      /** Machine-readable so the UI can react (re-login banner, onboarding, backoff). */
      code:
        | 'NO_RECIPE'
        /** Captured queryId no longer accepted by X; recipe has been discarded. */
        | 'STALE_RECIPE'
        | 'NO_CSRF'
        | 'UNAUTHORIZED'
        | 'RATE_LIMITED'
        | 'HTTP_ERROR'
        | 'NETWORK'
        | 'TIMEOUT'
        | 'BAD_REQUEST'
        | 'BAD_JSON';
      message: string;
      status?: number;
      rateLimit?: RateLimitInfo;
    };

export interface Envelope<T> {
  [ENVELOPE_KEY]: typeof BRIDGE_PROTOCOL_VERSION;
  id: string;
  direction: 'call' | 'reply';
  payload: T;
}

export function makeEnvelope<T>(
  id: string,
  direction: 'call' | 'reply',
  payload: T,
): Envelope<T> {
  return { [ENVELOPE_KEY]: BRIDGE_PROTOCOL_VERSION, id, direction, payload };
}

export function isEnvelope(value: unknown): value is Envelope<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate[ENVELOPE_KEY] === BRIDGE_PROTOCOL_VERSION &&
    typeof candidate.id === 'string' &&
    (candidate.direction === 'call' || candidate.direction === 'reply')
  );
}
