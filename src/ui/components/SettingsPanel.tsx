/** Sync tuning, keyword alerts, and bridge diagnostics. */

import { useCallback, useEffect, useState } from 'react';

import { deleteAlert, getSettings, listAlerts, putAlert, saveSettings } from '@/db/repo';
import type { AlertRule, Settings } from '@/db/schema';
import { DEFAULT_SETTINGS } from '@/db/schema';
import {
  notificationsAvailable,
  requestNotificationPermission,
} from '@/sync/alerts';
import { BridgeDiagnostics } from './BridgeDiagnostics';
import { TrashIcon } from './Icons';
import './SettingsPanel.css';

interface SettingsPanelProps {
  onClose: () => void;
  onSettingsChanged: () => void;
  /** Used to build "open this page to capture it" links in diagnostics. */
  sampleHandle?: string;
}

export function SettingsPanel({
  onClose,
  onSettingsChanged,
  sampleHandle,
}: SettingsPanelProps): React.JSX.Element {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [alerts, setAlerts] = useState<AlertRule[]>([]);
  const [draft, setDraft] = useState('');
  const [draftIsRegex, setDraftIsRegex] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>(
    notificationsAvailable() ? Notification.permission : 'denied',
  );

  useEffect(() => {
    void (async () => {
      setSettings(await getSettings());
      setAlerts(await listAlerts());
    })();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const patch = useCallback(
    async (change: Partial<Settings>) => {
      setSettings(await saveSettings(change));
      onSettingsChanged();
    },
    [onSettingsChanged],
  );

  async function addAlert(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const pattern = draft.trim();
    if (!pattern) return;

    if (draftIsRegex) {
      try {
        new RegExp(pattern);
      } catch {
        return;
      }
    }

    await putAlert({
      id: crypto.randomUUID(),
      pattern,
      isRegex: draftIsRegex,
      handles: [],
      enabled: true,
      createdAt: Date.now(),
    });
    setAlerts(await listAlerts());
    setDraft('');
  }

  async function enableNotifications(): Promise<void> {
    const next = await requestNotificationPermission();
    setPermission(next);
    await patch({ notificationsEnabled: next === 'granted' });
  }

  return (
    <div className="settings" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings__scrim" onClick={onClose} />

      <div className="settings__panel">
        <header className="settings__header">
          <h2 className="settings__title">Settings</h2>
          <button
            type="button"
            className="settings__close"
            onClick={onClose}
            aria-label="Close settings"
          >
            ✕
          </button>
        </header>

        <section className="settings__section">
          <h3 className="settings__heading">Syncing</h3>
          <p className="settings__note">
            Nothing contacts X unless this page is open. There is no background
            timer, no cron and no service worker.
          </p>

          <label className="settings__field">
            <span className="settings__label">
              Refresh accounts older than
              <strong>{settings.stalenessMinutes} min</strong>
            </span>
            <input
              type="range"
              min={5}
              max={180}
              step={5}
              value={settings.stalenessMinutes}
              onChange={(event) =>
                void patch({ stalenessMinutes: Number(event.target.value) })
              }
            />
          </label>

          <label className="settings__field">
            <span className="settings__label">
              Requests at once
              <strong>{settings.concurrency}</strong>
            </span>
            <input
              type="range"
              min={1}
              max={8}
              step={1}
              value={settings.concurrency}
              onChange={(event) => void patch({ concurrency: Number(event.target.value) })}
            />
            <span className="settings__hint">
              Higher is faster but looks less like a person browsing. 4 is a
              comfortable middle.
            </span>
          </label>

          <label className="settings__field">
            <span className="settings__label">
              Posts fetched per account
              <strong>{settings.postsPerSync}</strong>
            </span>
            <input
              type="range"
              min={10}
              max={40}
              step={5}
              value={settings.postsPerSync}
              onChange={(event) => void patch({ postsPerSync: Number(event.target.value) })}
            />
          </label>

          <label className="settings__toggle">
            <input
              type="checkbox"
              checked={settings.includeReplies}
              onChange={(event) => void patch({ includeReplies: event.target.checked })}
            />
            <span>
              Include replies they write
              <span className="settings__hint">
                Off means original posts and reposts only.
              </span>
            </span>
          </label>
        </section>

        <section className="settings__section">
          <h3 className="settings__heading">Keyword alerts</h3>
          <p className="settings__note">
            Alerts fire during a sync, which only happens while this page is
            open. Nothing can notify you with the tab closed.
          </p>

          {notificationsAvailable() && permission !== 'granted' ? (
            <button type="button" className="settings__button" onClick={() => void enableNotifications()}>
              {permission === 'denied'
                ? 'Notifications blocked - enable in site settings'
                : 'Enable desktop notifications'}
            </button>
          ) : (
            <label className="settings__toggle">
              <input
                type="checkbox"
                checked={settings.notificationsEnabled}
                onChange={(event) =>
                  void patch({ notificationsEnabled: event.target.checked })
                }
              />
              <span>Show desktop notifications for matches</span>
            </label>
          )}

          <form className="settings__alert-form" onSubmit={(event) => void addAlert(event)}>
            <input
              className="settings__input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={draftIsRegex ? 'pattern, e.g. (hiring|open role)' : 'keyword'}
              spellCheck={false}
            />
            <label className="settings__regex">
              <input
                type="checkbox"
                checked={draftIsRegex}
                onChange={(event) => setDraftIsRegex(event.target.checked)}
              />
              regex
            </label>
            <button type="submit" className="settings__button" disabled={!draft.trim()}>
              Add
            </button>
          </form>

          {alerts.length > 0 && (
            <ul className="settings__alerts">
              {alerts.map((alert) => (
                <li key={alert.id}>
                  <label className="settings__alert-toggle">
                    <input
                      type="checkbox"
                      checked={alert.enabled}
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        void (async () => {
                          await putAlert({ ...alert, enabled });
                          setAlerts(await listAlerts());
                        })();
                      }}
                    />
                    <code>{alert.pattern}</code>
                    {alert.isRegex && <span className="settings__tag">regex</span>}
                  </label>
                  <button
                    type="button"
                    className="settings__icon-button"
                    onClick={() => {
                      void (async () => {
                        await deleteAlert(alert.id);
                        setAlerts(await listAlerts());
                      })();
                    }}
                    aria-label={`Delete alert ${alert.pattern}`}
                  >
                    <TrashIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="settings__section">
          <h3 className="settings__heading">Connection</h3>
          <BridgeDiagnostics sampleHandle={sampleHandle} />
        </section>
      </div>
    </div>
  );
}
