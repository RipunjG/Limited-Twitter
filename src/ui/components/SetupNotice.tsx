/**
 * Shown in the feed column while the bridge is still missing a capability.
 *
 * This lives here rather than only in Settings because the symptom the user
 * actually sees is an empty feed - and an empty feed that does not explain
 * itself reads as "nobody has posted", which sends people looking in entirely
 * the wrong place.
 */

import type { BridgeStatus, MissingCapability } from '@shared/protocol';
import './SetupNotice.css';

const STEPS: Record<
  MissingCapability,
  { title: string; detail: string; path: string; blocking: boolean }
> = {
  profile: {
    title: 'Open any profile on x.com',
    detail: 'Needed to look up the accounts you add.',
    path: '',
    blocking: true,
  },
  timeline: {
    title: 'Scroll a profile’s posts on x.com',
    detail:
      'Needed for the feed itself. The home timeline does not count - it has to be someone’s profile.',
    path: '',
    blocking: true,
  },
  thread: {
    title: 'Open a single post on x.com',
    detail: 'Only needed to expand comment threads. The feed works without it.',
    path: '',
    blocking: false,
  },
};

interface SetupNoticeProps {
  status: BridgeStatus;
  sampleHandle: string;
  onRecheck: () => void;
}

export function SetupNotice({
  status,
  sampleHandle,
  onRecheck,
}: SetupNoticeProps): React.JSX.Element | null {
  if (status.missing.length === 0) return null;

  const blocking = status.missing.filter((item) => STEPS[item].blocking);

  return (
    <aside className={`setup${blocking.length > 0 ? ' is-blocking' : ''}`}>
      <h3 className="setup__title">
        {blocking.length > 0
          ? 'Silent Feed cannot load posts yet'
          : 'One optional step remaining'}
      </h3>
      <p className="setup__lede">
        It learns how to talk to X by watching X&apos;s own traffic, so each kind
        of request has to happen once in your browser first.
      </p>

      <ol className="setup__steps">
        {status.missing.map((capability) => {
          const step = STEPS[capability];
          return (
            <li key={capability} className={step.blocking ? '' : 'is-optional'}>
              <a
                href={`https://x.com/${sampleHandle}${step.path}`}
                target="_blank"
                rel="noreferrer"
                className="setup__link"
              >
                {step.title}
              </a>
              <span className="setup__detail">{step.detail}</span>
            </li>
          );
        })}
      </ol>

      <div className="setup__foot">
        <button type="button" className="setup__button" onClick={onRecheck}>
          I&apos;ve done that - re-check
        </button>
        {status.observed.length === 0 && (
          <span className="setup__warn">
            No X traffic observed yet at all - if that persists after visiting
            x.com, the userscript is not running there.
          </span>
        )}
      </div>
    </aside>
  );
}
