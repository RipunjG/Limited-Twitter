/**
 * Live view of the bridge: is the userscript installed, has it learned X's
 * current request format, and can it actually reach x.com with your session.
 *
 * Doubles as onboarding (it tells you exactly what is missing and how to fix
 * it) and as the first end-to-end proof that the whole architecture works.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  detectBridge,
  getBridgeStatus,
  graphql,
  isBridgeInstalled,
  BridgeCallError,
} from '@/bridge/client';
import type { BridgeStatus, MissingCapability } from '@shared/protocol';
import './BridgeDiagnostics.css';

/**
 * Each capability is learned from a specific page on x.com, so a missing one
 * is only actionable if we say which page teaches it. `path` is appended to a
 * profile URL.
 *
 * Keyed by capability rather than by X's operation names, which change - the
 * timeline query was `UserTweets` and is now `UserOriginalsTimeline`.
 */
const CAPTURE_HINTS: Record<
  MissingCapability,
  { what: string; why: string; path: string }
> = {
  profile: {
    what: 'Open any profile',
    why: 'needed to look up accounts you add',
    path: '',
  },
  timeline: {
    what: 'Scroll their posts',
    why: 'needed for the feed itself',
    path: '',
  },
  thread: {
    what: 'Click into any single post',
    why: 'needed to expand comment threads',
    path: '',
  },
};

type ProbeState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'ok'; handle: string; userId: string; name: string; followers: number | null }
  | { phase: 'error'; message: string; code?: string };

function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Narrow the UserByScreenName payload without trusting its shape. */
function readUser(
  data: unknown,
): { userId: string; name: string; followers: number | null } | null {
  const result = (data as { data?: { user?: { result?: Record<string, unknown> } } })?.data
    ?.user?.result;
  if (!result) return null;

  const legacy = result.legacy as Record<string, unknown> | undefined;
  const core = result.core as Record<string, unknown> | undefined;
  const userId = typeof result.rest_id === 'string' ? result.rest_id : null;
  if (!userId) return null;

  const name =
    (typeof core?.name === 'string' && core.name) ||
    (typeof legacy?.name === 'string' && legacy.name) ||
    'Unknown';
  const followers =
    typeof legacy?.followers_count === 'number' ? legacy.followers_count : null;

  return { userId, name, followers };
}

interface BridgeDiagnosticsProps {
  /** A handle to build the "go capture this" links from. */
  sampleHandle?: string;
}

export function BridgeDiagnostics({
  sampleHandle = 'x',
}: BridgeDiagnosticsProps = {}): React.JSX.Element {
  const [installed, setInstalled] = useState(isBridgeInstalled);
  const [rechecking, setRechecking] = useState(false);
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [handle, setHandle] = useState('naval');
  const [probe, setProbe] = useState<ProbeState>({ phase: 'idle' });

  const refreshStatus = useCallback(async () => {
    if (!isBridgeInstalled()) return;
    try {
      setStatus(await getBridgeStatus());
      setStatusError(null);
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const recheck = useCallback(async () => {
    setRechecking(true);
    const found = await detectBridge();
    setInstalled(found);
    if (found) await refreshStatus();
    setRechecking(false);
  }, [refreshStatus]);

  const runProbe = useCallback(async () => {
    const cleaned = handle.trim().replace(/^@/, '');
    if (!cleaned) return;

    setProbe({ phase: 'running' });
    try {
      const { data } = await graphql('UserByScreenName', { screen_name: cleaned });
      const user = readUser(data);
      if (!user) {
        setProbe({
          phase: 'error',
          message:
            'Reached X and got a 200, but the payload had no user - check the handle is spelled right.',
        });
        return;
      }
      setProbe({ phase: 'ok', handle: cleaned, ...user });
    } catch (error) {
      if (error instanceof BridgeCallError) {
        setProbe({ phase: 'error', message: error.message, code: error.code });
      } else {
        setProbe({
          phase: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      void refreshStatus();
    }
  }, [handle, refreshStatus]);

  if (!installed) {
    return (
      <section className="diag diag--blocked">
        <h2 className="diag__title">Userscript not detected</h2>
        <p className="diag__lede">
          Silent Feed reads X through your own browser session. That needs a small
          userscript - this page cannot call x.com on its own.
        </p>
        <ol className="diag__steps">
          <li>
            Install{' '}
            <a
              href="https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo"
              target="_blank"
              rel="noreferrer"
            >
              Tampermonkey
            </a>{' '}
            (free).
          </li>
          <li>
            Open <a href="/silentfeed.user.js">/silentfeed.user.js</a> and confirm the
            install prompt.
          </li>
          <li>Reload this page.</li>
        </ol>

        <button
          type="button"
          className="diag__button"
          onClick={() => void recheck()}
          disabled={rechecking}
        >
          {rechecking ? 'Checking…' : 'Check again'}
        </button>

        {/* If the script is installed but still not seen, it is almost always
            because its @match does not cover this exact origin. */}
        <p className="diag__hint">
          Already installed it? The script must be granted{' '}
          <code>{location.origin}</code>. Open the Tampermonkey dashboard, click{' '}
          <strong>Silent Feed Bridge</strong>, and check that origin appears under
          its <em>Settings → Includes/Excludes</em>. Its console tag is{' '}
          <code>[silent-feed:bridge]</code>.
        </p>
      </section>
    );
  }

  const captured = status?.recipes.length ?? 0;
  const total = captured + (status?.missing.length ?? 0);
  const ready = Boolean(status?.hasCsrfToken) && captured > 0;

  return (
    <section className="diag">
      <header className="diag__header">
        <h2 className="diag__title">Bridge</h2>
        <span className={`diag__pill ${ready ? 'is-ok' : 'is-warn'}`}>
          {ready ? 'Connected' : 'Needs setup'}
        </span>
      </header>

      {statusError && <p className="diag__error">{statusError}</p>}

      <dl className="diag__facts">
        <div>
          <dt>Session token (ct0)</dt>
          <dd className={status?.hasCsrfToken ? 'is-ok' : 'is-warn'}>
            {status?.hasCsrfToken ? 'captured' : 'not captured'}
          </dd>
        </div>
        <div>
          <dt>Request formats learned</dt>
          <dd className={captured > 0 ? 'is-ok' : 'is-warn'}>
            {captured} of {total || 4}
          </dd>
        </div>
      </dl>

      {/* The single most diagnostic fact when nothing is being captured:
          whether we can see X's traffic at all. */}
      {status && status.missing.length > 0 && (
        <div className={`diag__observed${status.observed.length === 0 ? ' is-warn' : ''}`}>
          {status.observed.length === 0 ? (
            <>
              <strong>No X traffic observed yet.</strong> Open x.com in a tab and
              browse for a few seconds. If this still reads zero afterwards, the
              userscript is not seeing X&apos;s requests and the console on x.com
              will say why.
            </>
          ) : (
            <>
              <strong>Seen on x.com so far:</strong>{' '}
              <span className="diag__observed-list">{status.observed.join(', ')}</span>
            </>
          )}
        </div>
      )}

      {status && status.missing.length > 0 && (
        <div className="diag__todo">
          <p className="diag__todo-lede">
            Silent Feed learns how to talk to X by watching X&apos;s own traffic.
            These formats have not come up yet - each link below triggers one.
          </p>
          <ul className="diag__todo-list">
            {status.missing.map((capability) => {
              const hint = CAPTURE_HINTS[capability];
              return (
                <li key={capability}>
                  <a
                    href={`https://x.com/${sampleHandle}${hint.path}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {hint.what}
                  </a>
                  <span className="diag__muted">{hint.why}</span>
                </li>
              );
            })}
          </ul>
          <p className="diag__todo-foot">
            Give each page a few seconds and a scroll, then{' '}
            <button type="button" className="diag__link-button" onClick={() => void refreshStatus()}>
              re-check
            </button>
            .
          </p>
        </div>
      )}

      {status && status.recipes.length > 0 && (
        <ul className="diag__recipes">
          {status.recipes.map((recipe) => (
            <li key={recipe.operation}>
              <code>{recipe.operation}</code>
              <span className="diag__muted">
                {recipe.queryId.slice(0, 10)}… · {relativeTime(recipe.capturedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="diag__probe">
        <label className="diag__label" htmlFor="probe-handle">
          Test a live call
        </label>
        <div className="diag__row">
          <span className="diag__at">@</span>
          <input
            id="probe-handle"
            className="diag__input"
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void runProbe();
            }}
            placeholder="username"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="diag__button"
            onClick={() => void runProbe()}
            disabled={probe.phase === 'running'}
          >
            {probe.phase === 'running' ? 'Calling…' : 'Resolve'}
          </button>
        </div>

        {probe.phase === 'ok' && (
          <p className="diag__result is-ok">
            Reached X as your logged-in session. <strong>{probe.name}</strong> (@
            {probe.handle}) — id <code>{probe.userId}</code>
            {probe.followers !== null && ` · ${probe.followers.toLocaleString()} followers`}
          </p>
        )}
        {probe.phase === 'error' && (
          <p className="diag__result is-error">
            {probe.code && <code>{probe.code}</code>} {probe.message}
          </p>
        )}
      </div>
    </section>
  );
}
