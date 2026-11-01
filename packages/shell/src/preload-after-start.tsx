import { useEffect } from 'react';

/**
 * Starts `preload` once start-up has committed, after the app's own first
 * effects (the vault opening among them), so loading what start-up does not
 * draw never holds up the first paint. No timer: the work clock holds timers
 * until an action, and a preload must not land inside one. Draws nothing.
 */
export function PreloadAfterStart({ preload }: { preload: () => Promise<void> }) {
  useEffect(() => {
    void preload();
  }, [preload]);
  return null;
}
