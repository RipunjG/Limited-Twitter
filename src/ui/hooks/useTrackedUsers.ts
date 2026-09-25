import { useCallback, useEffect, useState } from 'react';

import {
  addUser,
  listUsers,
  removeUser,
  setUserEnabled,
  unreadCounts,
} from '@/db/repo';
import type { TrackedUser } from '@/db/schema';
import { invalidateIndex } from '@/db/search';
import { resolveProfile } from '@/x/operations';

export interface TrackedUsersState {
  users: TrackedUser[];
  /** Unread count keyed by userId. */
  counts: Map<string, number>;
  loading: boolean;
  adding: boolean;
  addError: string | null;
  reload: () => Promise<void>;
  refreshCounts: () => Promise<void>;
  add: (handle: string) => Promise<TrackedUser | null>;
  remove: (handle: string) => Promise<void>;
  toggle: (handle: string, enabled: boolean) => Promise<void>;
  clearAddError: () => void;
}

export function useTrackedUsers(): TrackedUsersState {
  const [users, setUsers] = useState<TrackedUser[]>([]);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const refreshCounts = useCallback(async () => {
    setCounts(await unreadCounts());
  }, []);

  const reload = useCallback(async () => {
    const [next] = await Promise.all([listUsers(), refreshCounts()]);
    setUsers(next);
    setLoading(false);
  }, [refreshCounts]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = useCallback(
    async (handle: string): Promise<TrackedUser | null> => {
      const cleaned = handle.trim().replace(/^@/, '');
      if (!cleaned) return null;

      setAdding(true);
      setAddError(null);
      try {
        // Resolving first means a typo fails before it pollutes the DB, and
        // gets us the numeric id every timeline query needs.
        const profile = await resolveProfile(cleaned);
        const user = await addUser(profile);
        await reload();
        return user;
      } catch (error) {
        setAddError(error instanceof Error ? error.message : String(error));
        return null;
      } finally {
        setAdding(false);
      }
    },
    [reload],
  );

  const remove = useCallback(
    async (handle: string) => {
      await removeUser(handle);
      // Their posts are gone, so any cached search index is now wrong.
      invalidateIndex();
      await reload();
    },
    [reload],
  );

  const toggle = useCallback(
    async (handle: string, enabled: boolean) => {
      await setUserEnabled(handle, enabled);
      await reload();
    },
    [reload],
  );

  const clearAddError = useCallback(() => setAddError(null), []);

  return {
    users,
    counts,
    loading,
    adding,
    addError,
    reload,
    refreshCounts,
    add,
    remove,
    toggle,
    clearAddError,
  };
}
