/**
 * Bounded-concurrency task runner with the manners required to not get an
 * account flagged: a few requests in flight at once, randomized gaps between
 * them, and an immediate stop when X signals it has had enough.
 */

import type { RateLimitInfo } from '@shared/protocol';

/** Stop issuing requests once the remaining budget drops this low. */
const RATE_LIMIT_FLOOR = 40;

/** Never sleep longer than this on a reset, even if X says to. */
const MAX_PAUSE_MS = 5 * 60 * 1000;

export class SyncHaltedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncHaltedError';
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function jitter(range: readonly [number, number]): number {
  const [min, max] = range;
  return min + Math.random() * Math.max(0, max - min);
}

/**
 * Shared throttle state. A 429 or a near-exhausted budget on any one request
 * pauses the whole pool rather than just that worker - the limit is per
 * account, so backing off on a single task would not help.
 */
export class RateLimitGuard {
  private pausedUntil = 0;
  private haltReason: string | null = null;

  note(rateLimit: RateLimitInfo | undefined): void {
    if (!rateLimit) return;
    const { remaining, reset } = rateLimit;
    if (remaining !== null && remaining <= RATE_LIMIT_FLOOR && reset !== null) {
      this.pausedUntil = Math.max(this.pausedUntil, reset * 1000);
    }
  }

  /** Back off after an explicit 429. */
  backOff(attempt: number, rateLimit?: RateLimitInfo): void {
    if (rateLimit?.reset) {
      this.pausedUntil = Math.max(this.pausedUntil, rateLimit.reset * 1000);
      return;
    }
    const delay = Math.min(2 ** attempt * 1000, 60_000);
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + delay);
  }

  /** Abandon the run entirely - used when the session itself is rejected. */
  halt(reason: string): void {
    this.haltReason = reason;
  }

  get halted(): string | null {
    return this.haltReason;
  }

  /** Milliseconds callers should wait before the next request, if any. */
  get waitMs(): number {
    return Math.max(0, Math.min(this.pausedUntil - Date.now(), MAX_PAUSE_MS));
  }

  async gate(signal?: AbortSignal): Promise<void> {
    if (this.haltReason) throw new SyncHaltedError(this.haltReason);
    const wait = this.waitMs;
    if (wait > 0) await sleep(wait, signal);
    if (this.haltReason) throw new SyncHaltedError(this.haltReason);
  }
}

export interface PoolOptions<T> {
  items: T[];
  concurrency: number;
  /** Randomized delay before each task, in ms. Keeps traffic human-shaped. */
  jitterMs?: readonly [number, number];
  guard: RateLimitGuard;
  signal?: AbortSignal;
  worker: (item: T, index: number) => Promise<void>;
  onSettled?: (done: number, total: number) => void;
}

/**
 * Runs `worker` over `items` with at most `concurrency` in flight.
 *
 * Workers are expected to handle their own per-item failures; anything that
 * escapes stops the whole run, which is the right behaviour for a halted
 * session but wrong for one bad handle - hence `syncAll` catches per user.
 */
export async function runPool<T>(options: PoolOptions<T>): Promise<void> {
  const {
    items,
    concurrency,
    jitterMs = [300, 900],
    guard,
    signal,
    worker,
    onSettled,
  } = options;

  if (items.length === 0) return;

  let cursor = 0;
  let done = 0;
  const lanes = Math.max(1, Math.min(concurrency, items.length));

  async function lane(): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;

      await guard.gate(signal);
      await sleep(jitter(jitterMs), signal);

      await worker(item, index);

      done += 1;
      onSettled?.(done, items.length);
    }
  }

  await Promise.all(Array.from({ length: lanes }, () => lane()));
}
