import { useCallback, useEffect, useState } from 'react';

import { getBridgeStatus, isBridgeInstalled } from '@/bridge/client';
import type { BridgeStatus } from '@shared/protocol';

export interface BridgeStatusState {
  status: BridgeStatus | null;
  refresh: () => Promise<void>;
}

/**
 * Which capabilities the bridge has learned.
 *
 * Polled on mount and after each sync rather than continuously - recipes only
 * change when the user visits x.com, and there is no event for that.
 */
export function useBridgeStatus(): BridgeStatusState {
  const [status, setStatus] = useState<BridgeStatus | null>(null);

  const refresh = useCallback(async () => {
    if (!isBridgeInstalled()) return;
    try {
      setStatus(await getBridgeStatus());
    } catch {
      // A failed status read should never break the feed around it.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The most common reason a capability appears is that the user just went to
  // x.com in another tab and came back.
  useEffect(() => {
    const onFocus = (): void => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  return { status, refresh };
}
