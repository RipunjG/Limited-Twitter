/**
 * Page-side half of the bridge RPC.
 *
 * Every X request the app makes goes through here. The app supplies an
 * operation name and variables; the userscript owns everything else.
 */

import {
  ENVELOPE_KEY,
  isEnvelope,
  makeEnvelope,
  type AllowedOperation,
  type BridgeCall,
  type BridgeResult,
  type BridgeStatus,
  type RateLimitInfo,
} from '@shared/protocol';

export class BridgeMissingError extends Error {
  constructor() {
    super(
      'The Silent Feed userscript is not running on this page. Install it, then reload.',
    );
    this.name = 'BridgeMissingError';
  }
}

export class BridgeCallError extends Error {
  readonly code: Extract<BridgeResult, { ok: false }>['code'];
  readonly status: number | undefined;
  readonly rateLimit: RateLimitInfo | undefined;

  constructor(result: Extract<BridgeResult, { ok: false }>) {
    super(result.message);
    this.name = 'BridgeCallError';
    this.code = result.code;
    this.status = result.status;
    this.rateLimit = result.rateLimit;
  }
}

/**
 * Rate-limit headers are cross-cutting: the budget is per account, so a
 * near-exhausted response to one call has to throttle every other in-flight
 * call too. Broadcasting them here keeps that concern out of the operation
 * signatures.
 */
type RateLimitListener = (info: RateLimitInfo) => void;
const rateLimitListeners = new Set<RateLimitListener>();

export function onRateLimit(listener: RateLimitListener): () => void {
  rateLimitListeners.add(listener);
  return () => rateLimitListeners.delete(listener);
}

function broadcastRateLimit(info: RateLimitInfo | undefined): void {
  if (!info) return;
  for (const listener of rateLimitListeners) {
    try {
      listener(info);
    } catch {
      // A broken listener must not fail the request that triggered it.
    }
  }
}

/**
 * Fast path only. The userscript sets this at document-start, but a missing
 * marker is not proof of absence - see `detectBridge`, which is what the UI
 * should trust.
 */
export function isBridgeInstalled(): boolean {
  return Boolean(document.documentElement.dataset.silentfeedBridge);
}

let nextId = 0;

function call(payload: BridgeCall, timeoutMs: number): Promise<BridgeResult> {
  const id = `sf-${Date.now().toString(36)}-${(nextId++).toString(36)}`;

  return new Promise<BridgeResult>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('Bridge did not respond in time.'));
    }, timeoutMs);

    function onMessage(event: MessageEvent): void {
      // Origin-only, matching the bridge: replies are posted from the
      // userscript sandbox, whose window is not identical to this one.
      if (event.origin !== location.origin) return;
      if (!isEnvelope(event.data)) return;
      if (event.data.direction !== 'reply' || event.data.id !== id) return;

      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(event.data.payload as BridgeResult);
    }

    window.addEventListener('message', onMessage);
    window.postMessage(makeEnvelope(id, 'call', payload), location.origin);
  });
}

export async function pingBridge(timeoutMs = 5_000): Promise<number> {
  const result = await call({ op: 'ping' }, timeoutMs);
  if (!result.ok) throw new BridgeCallError(result);
  if (result.op !== 'ping') throw new Error('Unexpected bridge reply.');
  return result.version;
}

/**
 * Authoritative "is the bridge there" check.
 *
 * The `<html>` marker is only a fast path: the userscript may be injected
 * after React mounts, or may have failed to set the attribute while still
 * having its message listener attached. So a missing marker falls back to
 * actually pinging, retried briefly to cover late injection.
 */
export async function detectBridge(): Promise<boolean> {
  if (isBridgeInstalled()) return true;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await pingBridge(700);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  return isBridgeInstalled();
}

export async function getBridgeStatus(): Promise<BridgeStatus> {
  const result = await call({ op: 'status' }, 5_000);
  if (!result.ok) throw new BridgeCallError(result);
  if (result.op !== 'status') throw new Error('Unexpected bridge reply.');
  return result.status;
}

export interface GraphqlOutcome {
  data: unknown;
  rateLimit: Extract<BridgeResult, { ok: true; op: 'graphql' }>['rateLimit'];
}

export async function graphql(
  operation: AllowedOperation,
  variables: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<GraphqlOutcome> {
  const result = await call(
    { op: 'graphql', operation, variables, timeoutMs },
    timeoutMs + 5_000,
  );

  if (!result.ok) {
    broadcastRateLimit(result.rateLimit);
    throw new BridgeCallError(result);
  }
  if (result.op !== 'graphql') throw new Error('Unexpected bridge reply.');

  broadcastRateLimit(result.rateLimit);
  return { data: result.data, rateLimit: result.rateLimit };
}

export { ENVELOPE_KEY };
