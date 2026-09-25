import { useCallback, useEffect, useRef, useState } from 'react';

import type { StoredTweet } from '@/db/schema';
import { IDLE_PROGRESS, syncAll, type SyncProgress } from '@/sync/sync';

export interface SyncState {
  progress: SyncProgress;
  running: boolean;
  run: (force?: boolean) => Promise<void>;
  cancel: () => void;
}

export interface UseSyncOptions {
  onInserted?: (tweets: StoredTweet[]) => void;
  onFinished?: (progress: SyncProgress) => void;
}

export function useSync(options: UseSyncOptions = {}): SyncState {
  const { onInserted, onFinished } = options;

  const [progress, setProgress] = useState<SyncProgress>(IDLE_PROGRESS);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Held in refs so `run` stays stable and does not retrigger the page-load
  // sync effect every time a parent rerenders.
  const insertedRef = useRef(onInserted);
  const finishedRef = useRef(onFinished);
  insertedRef.current = onInserted;
  finishedRef.current = onFinished;

  const run = useCallback(async (force = false) => {
    if (abortRef.current) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);

    try {
      const result = await syncAll({
        force,
        signal: controller.signal,
        onProgress: setProgress,
        onInserted: (tweets) => insertedRef.current?.(tweets),
      });
      setProgress(result);
      finishedRef.current?.(result);
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { progress, running, run, cancel };
}
