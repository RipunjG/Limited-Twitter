/** The people you watch: add, filter by, mute, remove. */

import { useState } from 'react';

import type { TrackedUser } from '@/db/schema';
import { compactNumber } from '../format';
import { SettingsIcon, TrashIcon } from './Icons';
import './PeopleRail.css';

interface PeopleRailProps {
  users: TrackedUser[];
  counts: Map<string, number>;
  selectedUserId: string | null;
  adding: boolean;
  addError: string | null;
  totalUnread: number;
  onSelect: (userId: string | null) => void;
  onAdd: (handle: string) => Promise<unknown>;
  onRemove: (handle: string) => void;
  onToggle: (handle: string, enabled: boolean) => void;
  onMarkAllRead: () => void;
  onOpenSettings: () => void;
  onDismissAddError: () => void;
}

export function PeopleRail(props: PeopleRailProps): React.JSX.Element {
  const {
    users,
    counts,
    selectedUserId,
    adding,
    addError,
    totalUnread,
    onSelect,
    onAdd,
    onRemove,
    onToggle,
    onMarkAllRead,
    onOpenSettings,
    onDismissAddError,
  } = props;

  const [draft, setDraft] = useState('');
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!draft.trim() || adding) return;
    const added = await onAdd(draft);
    if (added) setDraft('');
  }

  return (
    <aside className="rail">
      <div className="rail__brand">
        <span className="rail__logo" aria-hidden="true" />
        <div>
          <h1 className="rail__title">Silent Feed</h1>
          <p className="rail__subtitle">
            {users.length ? `${users.length} tracked` : 'no one yet'}
          </p>
        </div>
        <button
          type="button"
          className="rail__icon-button"
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Settings"
        >
          <SettingsIcon />
        </button>
      </div>

      <form className="rail__add" onSubmit={(event) => void submit(event)}>
        <span className="rail__at">@</span>
        <input
          className="rail__input"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (addError) onDismissAddError();
          }}
          placeholder="add a username"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={adding}
        />
        <button
          type="submit"
          className="rail__add-button"
          disabled={adding || !draft.trim()}
        >
          {adding ? '…' : 'Add'}
        </button>
      </form>

      {addError && <p className="rail__error">{addError}</p>}

      <nav className="rail__list">
        <button
          type="button"
          className={`rail__row${selectedUserId === null ? ' is-selected' : ''}`}
          onClick={() => onSelect(null)}
        >
          <span className="rail__all-dot" aria-hidden="true" />
          <span className="rail__row-name">Everyone</span>
          {totalUnread > 0 && (
            <span className="rail__badge">{compactNumber(totalUnread)}</span>
          )}
        </button>

        {users.map((user) => {
          const unread = counts.get(user.userId) ?? 0;
          const selected = selectedUserId === user.userId;
          const confirming = confirmingRemove === user.handle;

          return (
            <div
              key={user.handle}
              className={`rail__item${user.enabled ? '' : ' is-muted'}`}
            >
              <button
                type="button"
                className={`rail__row${selected ? ' is-selected' : ''}`}
                onClick={() => onSelect(user.userId)}
                title={user.lastError ?? `@${user.handle}`}
              >
                {user.avatarUrl ? (
                  <img className="rail__avatar" src={user.avatarUrl} alt="" loading="lazy" />
                ) : (
                  <span className="rail__avatar rail__avatar--empty" />
                )}
                <span className="rail__row-text">
                  <span className="rail__row-name">{user.displayName}</span>
                  <span className="rail__row-handle">@{user.handle}</span>
                </span>
                {user.lastError && (
                  <span className="rail__warn" title={user.lastError}>
                    !
                  </span>
                )}
                {unread > 0 && (
                  <span className="rail__badge">{compactNumber(unread)}</span>
                )}
              </button>

              <div className="rail__actions">
                <button
                  type="button"
                  className="rail__action"
                  onClick={() => onToggle(user.handle, !user.enabled)}
                  title={user.enabled ? 'Pause syncing this account' : 'Resume syncing'}
                >
                  {user.enabled ? 'Pause' : 'Resume'}
                </button>
                {confirming ? (
                  <>
                    <button
                      type="button"
                      className="rail__action is-danger"
                      onClick={() => {
                        onRemove(user.handle);
                        setConfirmingRemove(null);
                      }}
                    >
                      Delete posts
                    </button>
                    <button
                      type="button"
                      className="rail__action"
                      onClick={() => setConfirmingRemove(null)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="rail__action rail__action--icon"
                    onClick={() => setConfirmingRemove(user.handle)}
                    title="Remove and delete their archived posts"
                    aria-label={`Remove @${user.handle}`}
                  >
                    <TrashIcon />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </nav>

      {totalUnread > 0 && (
        <button type="button" className="rail__mark-all" onClick={onMarkAllRead}>
          Mark all read
        </button>
      )}
    </aside>
  );
}
