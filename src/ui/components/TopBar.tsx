/** Filters, search, and the sync control. */

import type { FeedFilter } from '@/db/repo';
import type { SyncProgress } from '@/sync/sync';
import { SearchIcon } from './Icons';
import './TopBar.css';

const FILTERS: Array<{ id: FeedFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'posts', label: 'Posts' },
  { id: 'replies', label: 'Replies' },
  { id: 'media', label: 'Media' },
  { id: 'alerts', label: 'Alerts' },
];

interface TopBarProps {
  title: string;
  filter: FeedFilter;
  query: string;
  deepSearch: boolean;
  progress: SyncProgress;
  running: boolean;
  onFilter: (filter: FeedFilter) => void;
  onQuery: (query: string) => void;
  onDeepSearch: (deep: boolean) => void;
  onSync: () => void;
  onCancel: () => void;
}

function SyncPill({
  progress,
  running,
  onSync,
  onCancel,
}: Pick<TopBarProps, 'progress' | 'running' | 'onSync' | 'onCancel'>): React.JSX.Element {
  if (running) {
    const pct =
      progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
    return (
      <button
        type="button"
        className="topbar__sync is-running"
        onClick={onCancel}
        title="Click to stop"
      >
        <span className="topbar__sync-bar" style={{ width: `${pct}%` }} />
        <span className="topbar__sync-label">
          Syncing {progress.done}/{progress.total}
        </span>
      </button>
    );
  }

  return (
    <button type="button" className="topbar__sync" onClick={onSync}>
      Sync all
    </button>
  );
}

export function TopBar(props: TopBarProps): React.JSX.Element {
  const {
    title,
    filter,
    query,
    deepSearch,
    progress,
    running,
    onFilter,
    onQuery,
    onDeepSearch,
    onSync,
    onCancel,
  } = props;

  return (
    <div className="topbar">
      <div className="topbar__row">
        <h2 className="topbar__title">{title}</h2>

        <label className="topbar__search">
          <SearchIcon className="topbar__search-icon" />
          <input
            className="topbar__search-input"
            type="search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Search your archive"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <SyncPill
          progress={progress}
          running={running}
          onSync={onSync}
          onCancel={onCancel}
        />
      </div>

      <div className="topbar__row topbar__row--filters">
        {query.trim() ? (
          <label className="topbar__deep">
            <input
              type="checkbox"
              checked={deepSearch}
              onChange={(event) => onDeepSearch(event.target.checked)}
            />
            Search entire archive
            <span className="topbar__deep-note">slower, no recency limit</span>
          </label>
        ) : (
          FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`topbar__chip${filter === entry.id ? ' is-active' : ''}`}
              onClick={() => onFilter(entry.id)}
            >
              {entry.label}
            </button>
          ))
        )}
      </div>

      {progress.phase === 'halted' && progress.haltReason && (
        <p className="topbar__banner is-error">
          {progress.haltReason}{' '}
          <a href="https://x.com" target="_blank" rel="noreferrer">
            Open x.com
          </a>
        </p>
      )}

      {progress.phase === 'done' && progress.errors.length > 0 && (
        <div className="topbar__banner is-warn">
          <strong>
            {progress.errors.length} account
            {progress.errors.length === 1 ? '' : 's'} failed to sync
          </strong>
          {/* The reason matters far more than the list of handles - these
              failures are usually one shared cause, not sixty separate ones. */}
          <ul className="topbar__errors">
            {[
              ...new Map(
                progress.errors.map((error) => [error.message, error]),
              ).values(),
            ]
              .slice(0, 3)
              .map((error) => {
                const sharing = progress.errors.filter(
                  (other) => other.message === error.message,
                ).length;
                return (
                  <li key={error.message}>
                    <code>@{error.handle}</code>
                    {sharing > 1 && (
                      <span className="topbar__errors-count">
                        +{sharing - 1} more
                      </span>
                    )}{' '}
                    {error.message}
                  </li>
                );
              })}
          </ul>
        </div>
      )}
    </div>
  );
}
