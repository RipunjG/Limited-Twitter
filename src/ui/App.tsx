import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { detectBridge } from '@/bridge/client';
import { markAllRead, type FeedFilter } from '@/db/repo';
import type { StoredTweet } from '@/db/schema';
import { BridgeDiagnostics } from './components/BridgeDiagnostics';
import { Feed } from './components/Feed';
import { PeopleRail } from './components/PeopleRail';
import { SettingsPanel } from './components/SettingsPanel';
import { SetupNotice } from './components/SetupNotice';
import { TopBar } from './components/TopBar';
import { useBridgeStatus } from './hooks/useBridgeStatus';
import { useFeed } from './hooks/useFeed';
import { useSync } from './hooks/useSync';
import { useTrackedUsers } from './hooks/useTrackedUsers';
import './App.css';

export function App(): React.JSX.Element {
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [deepSearch, setDeepSearch] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // null = still checking. Detection can take a moment when the userscript is
  // injected late, so we must not render "not installed" before it resolves.
  const [bridgeReady, setBridgeReady] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void detectBridge().then((found) => {
      if (!cancelled) setBridgeReady(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const users = useTrackedUsers();
  const bridge = useBridgeStatus();

  const feed = useFeed({
    filter,
    sourceUserId: selectedUserId,
    query,
    deepSearch,
    onReadChanged: () => void users.refreshCounts(),
  });

  // Refs let the sync callbacks stay stable, so the page-load sync effect
  // below fires exactly once rather than on every feed rerender.
  const applyInsertedRef = useRef(feed.applyInserted);
  applyInsertedRef.current = feed.applyInserted;
  const refreshCountsRef = useRef(users.refreshCounts);
  refreshCountsRef.current = users.refreshCounts;
  const bridgeRefreshRef = useRef(bridge.refresh);
  bridgeRefreshRef.current = bridge.refresh;

  const sync = useSync({
    onInserted: (tweets: StoredTweet[]) => {
      applyInsertedRef.current(tweets);
      void refreshCountsRef.current();
    },
    onFinished: () => {
      void refreshCountsRef.current();
      void users.reload();
      void bridgeRefreshRef.current();
    },
  });

  const runSync = sync.run;

  /**
   * The only automatic sync there is: once, after the first load, for accounts
   * that have gone stale. Deliberately not a timer.
   */
  const autoSyncDone = useRef(false);
  useEffect(() => {
    if (autoSyncDone.current) return;
    if (users.loading || !bridgeReady || users.users.length === 0) return;
    autoSyncDone.current = true;
    void runSync(false);
  }, [users.loading, users.users.length, bridgeReady, runSync]);

  const totalUnread = useMemo(
    () => [...users.counts.values()].reduce((sum, count) => sum + count, 0),
    [users.counts],
  );

  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) Silent Feed` : 'Silent Feed';
  }, [totalUnread]);

  const handleMarkAllRead = useCallback(async () => {
    await markAllRead(selectedUserId ?? undefined);
    await users.refreshCounts();
    await feed.reload();
  }, [selectedUserId, users, feed]);

  const selectedUser = useMemo(
    () => users.users.find((user) => user.userId === selectedUserId) ?? null,
    [users.users, selectedUserId],
  );

  const title = query.trim()
    ? `Search: ${query.trim()}`
    : (selectedUser?.displayName ?? 'Everyone');

  const emptyState = useMemo(() => {
    if (query.trim()) {
      return (
        <>
          <strong>Nothing matched “{query.trim()}”.</strong>
          {!deepSearch && <span>Try “Search entire archive” for older posts.</span>}
        </>
      );
    }
    if (users.users.length === 0) {
      return (
        <>
          <strong>No one tracked yet.</strong>
          <span>Add a username on the left to start watching them.</span>
        </>
      );
    }
    if (filter !== 'all') {
      return (
        <>
          <strong>Nothing here.</strong>
          <span>No posts match this filter yet.</span>
        </>
      );
    }
    // A sync that reached accounts but parsed nothing is not "no posts" - it
    // means we could not read X's response, and saying so is the difference
    // between a five-minute fix and a silent dead end.
    if (
      sync.progress.phase === 'done' &&
      sync.progress.total > 0 &&
      sync.progress.parsedPosts === 0 &&
      sync.progress.errors.length === 0
    ) {
      return (
        <>
          <strong>Reached X, but could not read any posts.</strong>
          <span>
            {sync.progress.total} account
            {sync.progress.total === 1 ? '' : 's'} synced without error, yet zero
            posts were parsed. X has probably changed its response format.
          </span>
          <span>Check the browser console for details.</span>
        </>
      );
    }

    return (
      <>
        <strong>No posts yet.</strong>
        <span>Hit “Sync all” to pull the latest from everyone you track.</span>
      </>
    );
  }, [query, deepSearch, users.users.length, filter, sync.progress]);

  if (bridgeReady === null) {
    return (
      <div className="app app--setup">
        <div className="app__booting">
          <span className="feed__spinner" aria-hidden="true" />
          Looking for the userscript…
        </div>
      </div>
    );
  }

  // Without the bridge nothing can be fetched, so lead with setup instead of
  // an empty feed the user cannot fill.
  if (!bridgeReady) {
    return (
      <div className="app app--setup">
        <header className="app__masthead">
          <h1 className="app__wordmark">Silent Feed</h1>
          <p className="app__tagline">The people you watch, without following them.</p>
        </header>
        <main className="app__main">
          <BridgeDiagnostics />
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <PeopleRail
        users={users.users}
        counts={users.counts}
        selectedUserId={selectedUserId}
        adding={users.adding}
        addError={users.addError}
        totalUnread={totalUnread}
        onSelect={setSelectedUserId}
        onAdd={users.add}
        onRemove={(handle) => void users.remove(handle)}
        onToggle={(handle, enabled) => void users.toggle(handle, enabled)}
        onMarkAllRead={() => void handleMarkAllRead()}
        onOpenSettings={() => setSettingsOpen(true)}
        onDismissAddError={users.clearAddError}
      />

      <main className="app__column">
        <TopBar
          title={title}
          filter={filter}
          query={query}
          deepSearch={deepSearch}
          progress={sync.progress}
          running={sync.running}
          onFilter={setFilter}
          onQuery={setQuery}
          onDeepSearch={setDeepSearch}
          onSync={() => void runSync(true)}
          onCancel={sync.cancel}
        />

        {bridge.status && (
          <SetupNotice
            status={bridge.status}
            sampleHandle={users.users[0]?.handle ?? 'x'}
            onRecheck={() => {
              void bridge.refresh();
              void runSync(true);
            }}
          />
        )}

        <Feed
          tweets={feed.tweets}
          loading={feed.loading}
          loadingMore={feed.loadingMore}
          hasMore={feed.hasMore}
          emptyState={emptyState}
          onMarkRead={feed.markRead}
          onLoadMore={() => void feed.loadMore()}
        />
      </main>

      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onSettingsChanged={() => void users.reload()}
          sampleHandle={users.users[0]?.handle}
        />
      )}
    </div>
  );
}
