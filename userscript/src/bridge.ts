/**
 * Runs on the Silent Feed app origin. The only component that touches the X
 * session.
 *
 * The page cannot call x.com itself: CORS blocks it, and the `auth_token`
 * cookie is HttpOnly + SameSite so it would not be attached anyway. This half
 * bridges that gap with GM_xmlhttpRequest, which issues the request from the
 * user's real browser, on their residential IP, with their real cookie jar.
 *
 * Security posture: the bearer token and ct0 never leave this module. The page
 * asks for an allowlisted operation by name; it never supplies a URL, a header,
 * or a token.
 */

import {
  BRIDGE_PROTOCOL_VERSION,
  isAllowedOperation,
  isEnvelope,
  makeEnvelope,
  isTimelineOperation,
  type AllowedOperation,
  type MissingCapability,
  type BridgeCall,
  type BridgeResult,
  type RateLimitInfo,
  type Recipe,
} from '../../shared/protocol';
import {
  CSRF_KEY,
  SEEN_KEY,
  readStringList,
  recipeKey,
  storedOperations,
} from './storage';

declare const __APP_ORIGINS__: string[];

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 60_000;

function log(...args: unknown[]): void {
  console.log('%c[silent-feed:bridge]', 'color:#00ba7c', ...args);
}

function loadRecipe(operation: AllowedOperation): Recipe | null {
  const raw = GM_getValue(recipeKey(operation), '');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Recipe;
  } catch {
    return null;
  }
}

/** GM_xmlhttpRequest hands back headers as one raw CRLF-delimited blob. */
function parseRateLimit(rawHeaders: string): RateLimitInfo {
  const read = (name: string): number | null => {
    const match = new RegExp(`^${name}:\\s*(\\d+)\\s*$`, 'im').exec(rawHeaders);
    return match?.[1] ? Number(match[1]) : null;
  };
  return {
    limit: read('x-rate-limit-limit'),
    remaining: read('x-rate-limit-remaining'),
    reset: read('x-rate-limit-reset'),
  };
}

function buildRequest(
  recipe: Recipe,
  csrf: string,
  overrides: Record<string, unknown>,
): { url: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: string } {
  // Start from the variables X itself sent so every `include*` / `with*` flag
  // the current deploy requires is present, then layer our own on top.
  let base: Record<string, unknown> = {};
  if (recipe.variables) {
    try {
      base = JSON.parse(recipe.variables) as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  const variables = { ...base, ...overrides };

  const headers: Record<string, string> = {
    ...recipe.headers,
    'x-csrf-token': csrf,
    // X checks these on session requests; the captured recipe normally has
    // them already, but a guest-ish capture might not.
    'x-twitter-active-user': recipe.headers['x-twitter-active-user'] ?? 'yes',
    'x-twitter-auth-type': recipe.headers['x-twitter-auth-type'] ?? 'OAuth2Session',
  };

  const endpoint = `https://x.com/i/api/graphql/${recipe.queryId}/${recipe.operation}`;

  if (recipe.method === 'POST') {
    const body: Record<string, unknown> = { variables, queryId: recipe.queryId };
    if (recipe.features) body.features = JSON.parse(recipe.features);
    if (recipe.fieldToggles) body.fieldToggles = JSON.parse(recipe.fieldToggles);
    return {
      url: endpoint,
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  const params = new URLSearchParams({ variables: JSON.stringify(variables) });
  if (recipe.features) params.set('features', recipe.features);
  if (recipe.fieldToggles) params.set('fieldToggles', recipe.fieldToggles);

  const result: { url: string; method: 'GET'; headers: Record<string, string> } = {
    url: `${endpoint}?${params.toString()}`,
    method: 'GET',
    headers,
  };
  // A GET with a content-type header is a needless deviation from what the
  // real client sends.
  delete result.headers['content-type'];
  return result;
}

function runGraphql(
  operation: AllowedOperation,
  variables: Record<string, unknown>,
  timeoutMs: number,
): Promise<BridgeResult> {
  const recipe = loadRecipe(operation);
  if (!recipe) {
    return Promise.resolve({
      ok: false,
      code: 'NO_RECIPE',
      message: `No captured request format for ${operation}. Open x.com so the bridge can learn it.`,
    });
  }

  const csrf = GM_getValue(CSRF_KEY, '');
  if (!csrf) {
    return Promise.resolve({
      ok: false,
      code: 'NO_CSRF',
      message: 'No ct0 cookie captured yet. Open x.com while logged in.',
    });
  }

  let request: ReturnType<typeof buildRequest>;
  try {
    request = buildRequest(recipe, csrf, variables);
  } catch (error) {
    return Promise.resolve({
      ok: false,
      code: 'BAD_REQUEST',
      message: `Could not build ${operation} request: ${String(error)}`,
    });
  }

  return new Promise<BridgeResult>((resolve) => {
    GM_xmlhttpRequest({
      method: request.method,
      url: request.url,
      headers: request.headers,
      data: request.body,
      timeout: timeoutMs,
      // Default, but stated explicitly: this is what carries the HttpOnly
      // auth_token cookie, and the entire design depends on it.
      anonymous: false,
      onload: (response) => {
        const rateLimit = parseRateLimit(response.responseHeaders ?? '');

        if (response.status === 401 || response.status === 403) {
          resolve({
            ok: false,
            code: 'UNAUTHORIZED',
            message: 'X rejected the session. Open x.com and make sure you are logged in.',
            status: response.status,
            rateLimit,
          });
          return;
        }
        if (response.status === 429) {
          resolve({
            ok: false,
            code: 'RATE_LIMITED',
            message: 'Rate limited by X. Backing off.',
            status: response.status,
            rateLimit,
          });
          return;
        }
        // A 404 on a GraphQL operation means the queryId is stale - X has
        // redeployed and rotated it. The stored recipe is now worthless, so
        // drop it: keeping it would make us retry a dead endpoint forever,
        // and discarding it lets the harvester relearn the current one.
        if (response.status === 404) {
          GM_deleteValue(recipeKey(operation));
          resolve({
            ok: false,
            code: 'STALE_RECIPE',
            message: `X no longer recognises ${operation} (queryId rotated). Discarded it; open x.com to relearn.`,
            status: response.status,
            rateLimit,
          });
          return;
        }

        if (response.status < 200 || response.status >= 300) {
          resolve({
            ok: false,
            code: 'HTTP_ERROR',
            message: `HTTP ${response.status} from ${operation}.`,
            status: response.status,
            rateLimit,
          });
          return;
        }

        try {
          resolve({
            ok: true,
            op: 'graphql',
            status: response.status,
            data: JSON.parse(response.responseText) as unknown,
            rateLimit,
          });
        } catch {
          resolve({
            ok: false,
            code: 'BAD_JSON',
            message: `${operation} returned a non-JSON body (usually an interstitial or challenge page).`,
            status: response.status,
            rateLimit,
          });
        }
      },
      onerror: () =>
        resolve({ ok: false, code: 'NETWORK', message: `Network error calling ${operation}.` }),
      ontimeout: () =>
        resolve({ ok: false, code: 'TIMEOUT', message: `${operation} timed out.` }),
    });
  });
}

function handleCall(call: BridgeCall): Promise<BridgeResult> {
  switch (call.op) {
    case 'ping':
      return Promise.resolve({ ok: true, op: 'ping', version: BRIDGE_PROTOCOL_VERSION });

    case 'status': {
      // Enumerated from storage rather than from a fixed list, so a timeline
      // operation X renamed still shows up.
      const recipes = storedOperations().flatMap((operation) => {
        const recipe = loadRecipe(operation);
        return recipe
          ? [{ operation, queryId: recipe.queryId, capturedAt: recipe.capturedAt }]
          : [];
      });
      const captured = new Set(recipes.map((entry) => entry.operation));

      const missing: MissingCapability[] = [];
      if (!captured.has('UserByScreenName')) missing.push('profile');
      if (![...captured].some(isTimelineOperation)) missing.push('timeline');
      if (!captured.has('TweetDetail')) missing.push('thread');

      return Promise.resolve({
        ok: true,
        op: 'status',
        status: {
          version: BRIDGE_PROTOCOL_VERSION,
          hasCsrfToken: Boolean(GM_getValue(CSRF_KEY, '')),
          recipes,
          missing,
          observed: readStringList(SEEN_KEY),
        },
      });
    }

    case 'graphql': {
      if (!isAllowedOperation(call.operation)) {
        return Promise.resolve({
          ok: false,
          code: 'BAD_REQUEST',
          message: `Operation ${String(call.operation)} is not allowlisted.`,
        });
      }
      const timeout = Math.min(call.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      return runGraphql(call.operation, call.variables ?? {}, timeout);
    }

    default:
      return Promise.resolve({
        ok: false,
        code: 'BAD_REQUEST',
        message: 'Unknown bridge call.',
      });
  }
}

export function startBridge(): void {
  const trusted = new Set(__APP_ORIGINS__);

  window.addEventListener('message', (event: MessageEvent) => {
    // The origin check is the security-relevant one: a page cannot forge
    // event.origin, and @noframes keeps this out of embedded frames.
    //
    // Note there is deliberately no `event.source !== window` check. Under
    // Tampermonkey's sandbox, the script's `window` is a proxy that is not
    // identical to the page's real window, so that comparison would reject
    // every legitimate message.
    if (!trusted.has(event.origin)) return;
    if (!isEnvelope(event.data) || event.data.direction !== 'call') return;

    const { id, payload } = event.data;

    void handleCall(payload as BridgeCall)
      .catch(
        (error: unknown): BridgeResult => ({
          ok: false,
          code: 'NETWORK',
          message: String(error),
        }),
      )
      .then((result) => {
        window.postMessage(makeEnvelope(id, 'reply', result), event.origin);
      });
  });

  markPresence();

  window.postMessage(
    makeEnvelope('hello', 'reply', {
      ok: true,
      op: 'ping',
      version: BRIDGE_PROTOCOL_VERSION,
    } satisfies BridgeResult),
    location.origin,
  );

  log(`ready on ${location.origin}`);
}

/**
 * Flag our presence on <html> so the page can tell instantly, without waiting
 * on a ping round-trip.
 *
 * At @run-at document-start the document can still be empty, so
 * documentElement may not exist yet - retry until it does. The message
 * listener is already attached by this point either way, so a late marker
 * only delays the fast path, it never breaks the bridge.
 */
function markPresence(attempt = 0): void {
  const root = document.documentElement;
  if (root) {
    root.dataset.silentfeedBridge = String(BRIDGE_PROTOCOL_VERSION);
    return;
  }
  if (attempt > 50) return;
  setTimeout(() => markPresence(attempt + 1), 10);
}
