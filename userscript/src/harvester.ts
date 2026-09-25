/**
 * Runs on x.com. Passively observes the requests X's own frontend makes and
 * records how to reproduce them.
 *
 * This exists because X rotates the `queryId` for every GraphQL operation on
 * each frontend deploy, and regularly adds required `features` flags. Any
 * scraper that hardcodes those values breaks within weeks. Learning them from
 * live traffic makes the tool self-healing.
 *
 * It never sends anything anywhere - it only writes to Tampermonkey storage,
 * which the bridge half reads.
 */

import { isAllowedOperation, type Recipe } from '../../shared/protocol';
import {
  CSRF_KEY,
  SEEN_KEY,
  readStringList,
  recipeKey,
  storedOperations,
} from './storage';

/**
 * Headers worth replaying.
 *
 * Deliberately excluded:
 *  - `x-csrf-token`      re-derived from the live ct0 cookie on every send,
 *                        because a stale value fails X's cookie/header match.
 *  - `x-client-transaction-id`
 *                        single-use and request-specific; replaying one is
 *                        worse than omitting it (read endpoints accept its
 *                        absence, only SearchTimeline requires it, and we
 *                        never call SearchTimeline).
 */
const HEADER_ALLOWLIST = new Set([
  'authorization',
  'content-type',
  'x-twitter-active-user',
  'x-twitter-auth-type',
  'x-twitter-client-language',
  'x-twitter-utcoffset',
  'x-client-uuid',
]);

const GRAPHQL_PATH = /\/i\/api\/graphql\/([^/?#]+)\/([^/?#]+)/;

/** Re-capture at most this often per operation, to keep storage writes cheap. */
const RECAPTURE_INTERVAL_MS = 5 * 60 * 1000;

const lastCapture = new Map<string, number>();

/** Operation names observed this page load, before any filtering. */
const seen = new Set<string>();

/** Persist the union of what we have ever seen, so the app can display it. */
function noteSeen(operation: string): void {
  if (seen.has(operation)) return;
  seen.add(operation);

  const stored = new Set(readStringList(SEEN_KEY));
  if (stored.has(operation)) return;
  stored.add(operation);
  GM_setValue(SEEN_KEY, JSON.stringify([...stored].sort()));
}

/**
 * Also exposed on the page as `window.__silentFeed` for console inspection.
 * Best-effort: Tampermonkey can refuse writes to unsafeWindow, and that must
 * not stop the harvester from working.
 */
function installConsoleProbe(target: PatchTarget): void {
  const probe = {
    get seen() {
      return readStringList(SEEN_KEY);
    },
    get stored() {
      return storedOperations();
    },
    get csrf() {
      return Boolean(GM_getValue(CSRF_KEY, ''));
    },
  };

  for (const realm of new Set<unknown>([target, window])) {
    try {
      Object.defineProperty(realm, '__silentFeed', { configurable: true, value: probe });
    } catch {
      // Ignored - the app's Connection panel is the real diagnostic surface.
    }
  }
}

// console.log, not console.debug: Chrome files debug output under the Verbose
// level, which is hidden by default, so debug logs are effectively invisible.
function log(...args: unknown[]): void {
  console.log('%c[silent-feed:harvest]', 'color:#1d9bf0', ...args);
}

function readCsrfCookie(): string | null {
  const match = /(?:^|;\s*)ct0=([^;]+)/.exec(document.cookie);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** Cross-realm safe stand-ins for `instanceof Request` / `instanceof Headers`. */
function isRequestLike(value: unknown): value is Request {
  return (
    typeof value === 'object' &&
    value !== null &&
    'url' in value &&
    'method' in value &&
    typeof (value as Request).clone === 'function'
  );
}

function isHeadersLike(value: unknown): value is Headers {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Headers).forEach === 'function' &&
    typeof (value as Headers).get === 'function'
  );
}

function normalizeHeaders(source: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!source) return out;

  const visit = (rawKey: string, value: string): void => {
    const key = rawKey.toLowerCase();
    if (HEADER_ALLOWLIST.has(key)) out[key] = value;
  };

  if (isHeadersLike(source)) {
    source.forEach((value, key) => visit(key, value));
  } else if (Array.isArray(source)) {
    for (const pair of source) {
      if (pair.length === 2 && pair[0] !== undefined && pair[1] !== undefined) {
        visit(pair[0], pair[1]);
      }
    }
  } else {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'string') visit(key, value);
    }
  }
  return out;
}

/** Pull variables/features/fieldToggles out of a GET query string. */
function fromQuery(url: URL): Pick<Recipe, 'variables' | 'features' | 'fieldToggles'> {
  return {
    variables: url.searchParams.get('variables'),
    features: url.searchParams.get('features'),
    fieldToggles: url.searchParams.get('fieldToggles'),
  };
}

/** Pull the same out of a POST JSON body, re-stringifying to a uniform shape. */
function fromBody(body: string): Pick<Recipe, 'variables' | 'features' | 'fieldToggles'> {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const asString = (value: unknown): string | null =>
      value === undefined || value === null ? null : JSON.stringify(value);
    return {
      variables: asString(parsed.variables),
      features: asString(parsed.features),
      fieldToggles: asString(parsed.fieldToggles),
    };
  } catch {
    return { variables: null, features: null, fieldToggles: null };
  }
}

function capture(
  rawUrl: string,
  method: string,
  headers: Record<string, string>,
  body: string | null,
): void {
  let url: URL;
  try {
    url = new URL(rawUrl, location.origin);
  } catch {
    return;
  }

  const match = GRAPHQL_PATH.exec(url.pathname);
  if (!match) return;

  const [, queryId, operation] = match;
  if (!queryId || !operation) return;

  // Recorded before the allowlist filter, and persisted, so the app can show
  // it without anyone opening a console.
  noteSeen(operation);

  if (!isAllowedOperation(operation)) return;

  const previous = lastCapture.get(operation) ?? 0;
  if (Date.now() - previous < RECAPTURE_INTERVAL_MS) return;

  const upperMethod = method.toUpperCase() === 'POST' ? 'POST' : 'GET';
  const payload =
    upperMethod === 'POST' && body ? fromBody(body) : fromQuery(url);

  // An unauthenticated request would poison the recipe with a guest bearer,
  // so require the auth header before trusting it.
  if (!headers.authorization) return;

  const recipe: Recipe = {
    operation,
    queryId,
    method: upperMethod,
    headers,
    ...payload,
    capturedAt: Date.now(),
  };

  lastCapture.set(operation, recipe.capturedAt);
  GM_setValue(recipeKey(operation), JSON.stringify(recipe));

  const csrf = readCsrfCookie();
  if (csrf) GM_setValue(CSRF_KEY, csrf);

  log(`captured ${operation}`, { queryId, method: upperMethod });
}

/**
 * Just the two globals we patch. Deliberately narrow: `unsafeWindow` is typed
 * without the GM_* globals, so it does not satisfy `Window & typeof globalThis`,
 * and `XMLHttpRequest` lives on globalThis rather than on Window.
 */
interface PatchTarget {
  fetch: typeof fetch;
  XMLHttpRequest: typeof XMLHttpRequest;
}

/**
 * The page's real window.
 *
 * This matters more than it looks. Under Tampermonkey's sandbox `window` is a
 * proxy, and assigning `window.fetch = wrapper` parks the wrapper on the
 * sandbox while the page keeps calling the untouched original - so we would
 * observe none of X's fetch traffic. `XMLHttpRequest.prototype` happens to be
 * shared, which is why XHR-based calls were captured and fetch-based ones were
 * not. Patching through unsafeWindow reaches the page for real, and unlike
 * injecting a <script> it is not subject to X's CSP.
 */
function pageWindow(): PatchTarget {
  return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
}

function hookFetch(target: PatchTarget): void {
  // Bound up front: fetch throws an Illegal invocation if it ever runs with a
  // `this` other than its own window.
  const original = target.fetch.bind(target);

  target.fetch = function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    try {
      // Duck-typed, not `instanceof Request`: the sandbox and the page have
      // separate constructors, so an instanceof check fails across that
      // boundary even for a genuine Request.
      if (isRequestLike(input)) {
        // Body is a stream we must not consume; clone before reading.
        const rawUrl = input.url;
        const method = input.method;
        const headers = {
          ...normalizeHeaders(input.headers),
          ...normalizeHeaders(init?.headers),
        };
        if (method.toUpperCase() === 'POST') {
          input
            .clone()
            .text()
            .then((body) => capture(rawUrl, method, headers, body))
            .catch(() => undefined);
        } else {
          capture(rawUrl, method, headers, null);
        }
      } else {
        const rawUrl = typeof input === 'string' ? input : input.toString();
        const method = init?.method ?? 'GET';
        const body = typeof init?.body === 'string' ? init.body : null;
        capture(rawUrl, method, normalizeHeaders(init?.headers), body);
      }
    } catch (error) {
      log('capture failed (ignored)', error);
    }

    return original(input, init);
  };
}

interface TrackedXhr extends XMLHttpRequest {
  __sfUrl?: string;
  __sfMethod?: string;
  __sfHeaders?: Record<string, string>;
}

function hookXhr(target: PatchTarget): void {
  const proto = target.XMLHttpRequest.prototype;

  /* eslint-disable @typescript-eslint/unbound-method --
     Patching a prototype requires holding the originals unbound; every call
     site below re-attaches `this` explicitly with .call(). */
  const { open, send, setRequestHeader } = proto;
  /* eslint-enable @typescript-eslint/unbound-method */

  proto.open = function patchedOpen(
    this: TrackedXhr,
    method: string,
    url: string | URL,
    // Annotated rather than inferred from the default: the contextual type
    // here is XMLHttpRequest's overloaded `open`, whose two-argument overload
    // leaves this parameter `unknown`.
    isAsync: boolean = true,
    username?: string | null,
    password?: string | null,
  ): void {
    this.__sfMethod = method;
    this.__sfUrl = typeof url === 'string' ? url : url.toString();
    this.__sfHeaders = {};
    open.call(this, method, url, isAsync, username, password);
  };

  proto.setRequestHeader = function patchedSetHeader(
    this: TrackedXhr,
    name: string,
    value: string,
  ): void {
    const key = name.toLowerCase();
    if (this.__sfHeaders && HEADER_ALLOWLIST.has(key)) this.__sfHeaders[key] = value;
    setRequestHeader.call(this, name, value);
  };

  proto.send = function patchedSend(
    this: TrackedXhr,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    try {
      if (this.__sfUrl) {
        capture(
          this.__sfUrl,
          this.__sfMethod ?? 'GET',
          this.__sfHeaders ?? {},
          typeof body === 'string' ? body : null,
        );
      }
    } catch (error) {
      log('xhr capture failed (ignored)', error);
    }
    send.call(this, body ?? null);
  };
}

export function startHarvester(): void {
  const csrf = readCsrfCookie();
  if (csrf) GM_setValue(CSRF_KEY, csrf);

  const target = pageWindow();
  const reachedPage = target !== window;

  hookFetch(target);
  hookXhr(target);

  // The sandbox proxy is patched as well: in @grant none or some Firefox
  // configurations that is the object the page actually uses.
  if (reachedPage) {
    hookFetch(window);
  }

  installConsoleProbe(target);

  const have = storedOperations();
  log(
    `active (page realm: ${reachedPage ? 'unsafeWindow' : 'same'}). ` +
      `${have.length} recipes stored.`,
    have.length ? have : '(open a profile and scroll to capture timelines)',
  );
}
