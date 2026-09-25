/**
 * The sync pass.
 *
 * Triggered by a page load or the Sync button - never by a timer. There is no
 * alarm, no cron and no service worker in this project, so nothing contacts X
 * unless you are looking at the app.
 */

import { BridgeCallError, isBridgeInstalled, onRateLimit } from '@/bridge/client';
import {
  getSettings,
  listAlerts,
  listUsers,
  recordSyncResult,
  upsertTweets,
} from '@/db/repo';
import type { StoredTweet, TrackedUser } from '@/db/schema';
import { fetchUserTimeline, resetTimelinePreference } from '@/x/operations';
import type { Tweet } from '@/x/types';
import { compileAlerts, matchAlerts, notifyMatches } from './alerts';
import { RateLimitGuard, SyncHaltedError, runPool } from './pool';

export interface SyncError {
  handle: string;
  message: string;
}

export interface SyncProgress {
  phase: 'idle' | 'running' | 'done' | 'halted' | 'aborted';
  done: number;
  total: number;
  newPosts: number;
  /**
   * Posts successfully parsed this run, including ones already archived.
   * Distinguishes "X returned nothing" from "we could not read what it
   * returned" - both of which otherwise look like an empty feed.
   */
  parsedPosts: number;
  errors: SyncError[];
  haltReason: string | null;
}

export const IDLE_PROGRESS: SyncProgress = {
  phase: 'idle',
  done: 0,
  total: 0,
  newPosts: 0,
  parsedPosts: 0,
  errors: [],
  haltReason: null,
};

export interface SyncOptions {
  /** Ignore the staleness window and refresh every enabled account. */
  force?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: SyncProgress) => void;
  /** Called as each account's new posts land, so the feed can stream in. */
  onInserted?: (tweets: StoredTweet[]) => void;
}

function isStale(user: TrackedUser, stalenessMs: number): boolean {
  return user.lastSyncedAt === null || Date.now() - user.lastSyncedAt > stalenessMs;
}

/** One retry, only for the errors where retrying is meaningful. */
const RETRYABLE = new Set(['RATE_LIMITED', 'NETWORK', 'TIMEOUT']);

export async function syncAll(options: SyncOptions = {}): Promise<SyncProgress> {
  const { force = false, signal, onProgress, onInserted } = options;

  const progress: SyncProgress = {
    ...IDLE_PROGRESS,
    phase: 'running',
    errors: [],
  };
  const emit = (): void => onProgress?.({ ...progress, errors: [...progress.errors] });

  if (!isBridgeInstalled()) {
    return {
      ...progress,
      phase: 'halted',
      haltReason: 'The Silent Feed userscript is not installed on this page.',
    };
  }

  const [settings, users, alertRules] = await Promise.all([
    getSettings(),
    listUsers(),
    listAlerts(),
  ]);

  const stalenessMs = settings.stalenessMinutes * 60 * 1000;
  const due = users
    .filter((user) => user.enabled)
    .filter((user) => force || isStale(user, stalenessMs));

  progress.total = due.length;
  emit();

  if (due.length === 0) return { ...progress, phase: 'done' };

  const alerts = compileAlerts(alertRules);
  const matcher = (tweet: Tweet): string[] => matchAlerts(tweet, alerts);

  // Revalidate which timeline operation to use once per run: X may have
  // renamed it since the last sync, and pinning a dead name would fail every
  // account identically.
  resetTimelinePreference();

  const guard = new RateLimitGuard();
  const unsubscribe = onRateLimit((info) => guard.note(info));
  const alerted: Tweet[] = [];

  async function syncOne(user: TrackedUser, attempt = 0): Promise<void> {
    try {
      const page = await fetchUserTimeline(user.userId, {
        includeReplies: settings.includeReplies,
        count: settings.postsPerSync,
      });

      const { inserted } = await upsertTweets(user.userId, page.tweets, matcher);

      progress.parsedPosts += page.tweets.length;
      progress.newPosts += inserted.length;
      if (inserted.length > 0) onInserted?.(inserted);
      for (const tweet of inserted) {
        if (tweet.matchedAlerts.length > 0) alerted.push(tweet);
      }

      await recordSyncResult(user.handle, { ok: true });
    } catch (error) {
      if (error instanceof BridgeCallError) {
        // A rejected session is not a per-account problem - every remaining
        // request would fail the same way, so stop the whole run.
        if (error.code === 'UNAUTHORIZED') {
          guard.halt(error.message);
          throw new SyncHaltedError(error.message);
        }

        if (RETRYABLE.has(error.code) && attempt === 0) {
          if (error.code === 'RATE_LIMITED') guard.backOff(1, error.rateLimit);
          await guard.gate(signal);
          return syncOne(user, attempt + 1);
        }
      }

      const message = error instanceof Error ? error.message : String(error);
      progress.errors.push({ handle: user.handle, message });
      await recordSyncResult(user.handle, { ok: false, error: message });
    }
  }

  try {
    await runPool({
      items: due,
      concurrency: settings.concurrency,
      guard,
      signal,
      worker: (user) => syncOne(user),
      onSettled: (done) => {
        progress.done = done;
        emit();
      },
    });
    progress.phase = 'done';
  } catch (error) {
    if (error instanceof SyncHaltedError) {
      progress.phase = 'halted';
      progress.haltReason = error.message;
    } else if (error instanceof DOMException && error.name === 'AbortError') {
      progress.phase = 'aborted';
    } else {
      progress.phase = 'halted';
      progress.haltReason = error instanceof Error ? error.message : String(error);
    }
  } finally {
    unsubscribe();
  }

  if (settings.notificationsEnabled) notifyMatches(alerted);

  emit();
  return { ...progress, errors: [...progress.errors] };
}
