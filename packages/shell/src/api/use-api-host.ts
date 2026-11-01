import { useEffect, useMemo, useRef } from 'react';
import type { ApiHost, VaultLocation } from '@dfai/application';

/**
 * The app as the local API asks about it: one object for the life of the app,
 * answering with what is on screen when a request arrives rather than when the
 * API began listening — so a request after a vault switch is answered for the
 * vault that is open now.
 */
export function useApiHost({
  vault,
  indexReady,
}: {
  vault: VaultLocation | null;
  indexReady: boolean;
}): ApiHost {
  const now = useRef({ vault, indexReady });
  useEffect(() => {
    now.current = { vault, indexReady };
  });

  return useMemo(
    () => ({
      currentVault: () => now.current.vault,
      indexReady: () => now.current.indexReady,
    }),
    [],
  );
}
