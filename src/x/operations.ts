/**
 * The four X calls Silent Feed makes, wrapped so callers deal in domain
 * objects instead of GraphQL.
 *
 * Only `variables` are supplied here - queryId, feature flags and auth all
 * come from the recipe the bridge captured, which is why this file never
 * needs touching when X ships a frontend change.
 */

import { BridgeCallError, getBridgeStatus, graphql } from '@/bridge/client';
import {
  isTimelineOperation,
  TIMELINE_POSTS_ONLY,
  TIMELINE_WITH_REPLIES,
} from '@shared/protocol';
import { parseProfile, parseThread, parseTimeline } from './parse';
import { clearUnreadable, recordUnreadable } from './shape';
import type { TimelinePage, Tweet, XProfile } from './types';

export class ProfileNotFoundError extends Error {
  constructor(handle: string) {
    super(`@${handle} does not exist, or the account is suspended.`);
    this.name = 'ProfileNotFoundError';
  }
}

/** Resolve a handle to the numeric id every timeline query needs. */
export async function resolveProfile(handle: string): Promise<XProfile> {
  const cleaned = handle.trim().replace(/^@/, '');
  const { data } = await graphql('UserByScreenName', { screen_name: cleaned });
  const profile = parseProfile(data);
  if (!profile) throw new ProfileNotFoundError(cleaned);
  return profile;
}

export interface TimelineOptions {
  /** Include replies the account wrote to other people. */
  includeReplies?: boolean;
  count?: number;
  cursor?: string | null;
}

/**
 * Outcome of trying one operation. A discriminated result rather than a
 * sentinel value, because a response body is legitimately `unknown` and would
 * swallow any sentinel we tried to union with it.
 */
type Attempt = { hit: true; data: unknown } | { hit: false };

/**
 * The operation that last worked, remembered so a 60-account sync does not
 * rediscover it sixty times over.
 */
let knownGoodTimelineOp: string | null = null;

/**
 * Forget the cached choice. Called once per sync so a rename that happened
 * between runs is noticed, rather than us pinning a name that has since died.
 */
export function resetTimelinePreference(): void {
  knownGoodTimelineOp = null;
}

/**
 * Try timeline operations in order, skipping any whose recipe is missing or
 * has gone stale.
 *
 * X renames these between deploys - `UserTweets` became
 * `UserOriginalsTimeline` - and which names exist depends on the deploy, so
 * there is no single correct one to ask for. Whatever the bridge has actually
 * captured wins, including a name we have never heard of.
 */
async function timelineWithFallback(
  candidates: readonly string[],
  variables: Record<string, unknown>,
): Promise<unknown> {
  const tried = new Set<string>();

  const attempt = async (operation: string): Promise<Attempt> => {
    if (tried.has(operation)) return { hit: false };
    tried.add(operation);
    try {
      const { data } = await graphql(operation, variables);
      knownGoodTimelineOp = operation;
      return { hit: true, data };
    } catch (error) {
      // Never captured, or captured but now rejected by X because the
      // queryId rotated - either way, try the next name. Anything else is a
      // real failure and must not be masked by continuing.
      if (
        error instanceof BridgeCallError &&
        (error.code === 'NO_RECIPE' || error.code === 'STALE_RECIPE')
      ) {
        return { hit: false };
      }
      throw error;
    }
  };

  // Whatever worked last time, first.
  if (knownGoodTimelineOp) {
    const result = await attempt(knownGoodTimelineOp);
    if (result.hit) return result.data;
    knownGoodTimelineOp = null;
  }

  for (const operation of candidates) {
    const result = await attempt(operation);
    if (result.hit) return result.data;
  }

  // Only now - once every name we know of has come up empty - is it worth a
  // round trip to see what the bridge actually captured. This is what lets an
  // operation X renamed to something we have never heard of still work.
  try {
    const status = await getBridgeStatus();
    for (const recipe of status.recipes) {
      if (!isTimelineOperation(recipe.operation)) continue;
      const result = await attempt(recipe.operation);
      if (result.hit) return result.data;
    }
  } catch {
    // Status is a nicety; failing it should not change the error we report.
  }

  throw new BridgeCallError({
    ok: false,
    code: 'NO_RECIPE',
    message:
      'Silent Feed has not learned how X requests timelines yet. ' +
      'Open x.com, visit any profile, and scroll their posts - the bridge ' +
      'picks the format up from X itself.',
  });
}


export async function fetchUserTimeline(
  userId: string,
  options: TimelineOptions = {},
): Promise<TimelinePage> {
  const { includeReplies = true, count = 20, cursor = null } = options;

  const variables: Record<string, unknown> = {
    userId,
    count,
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: false,
    withVoice: true,
    withV2Timeline: true,
  };
  if (cursor) variables.cursor = cursor;

  // With replies wanted, prefer the combined timelines but accept a
  // posts-only one rather than returning nothing.
  const candidates = includeReplies
    ? [...TIMELINE_WITH_REPLIES, ...TIMELINE_POSTS_ONLY]
    : [...TIMELINE_POSTS_ONLY, ...TIMELINE_WITH_REPLIES];

  const data = await timelineWithFallback(candidates, variables);
  const page = parseTimeline(data);

  // Reading nothing from a successful response is the one failure with no
  // visible symptom, so keep the response's shape for the diagnostics panel.
  if (page.tweets.length === 0) {
    recordUnreadable(knownGoodTimelineOp ?? 'timeline', data);
  } else {
    clearUnreadable();
  }

  return page;
}

/**
 * Fetch the conversation under a post. Called only when the user expands a
 * card, so it costs nothing while idle.
 */
export async function fetchThread(tweetId: string): Promise<Tweet[]> {
  const { data } = await graphql('TweetDetail', {
    focalTweetId: tweetId,
    referrer: 'profile',
    with_rux_injections: false,
    includePromotedContent: false,
    withCommunity: true,
    withQuickPromoteEligibilityTweetFields: false,
    withBirdwatchNotes: true,
    withVoice: true,
    withV2Timeline: true,
  });
  return parseThread(data);
}
