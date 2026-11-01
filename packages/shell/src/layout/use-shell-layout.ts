import { useSyncExternalStore } from 'react';
import { shellLayoutFor, type ShellLayout } from '@dfai/domain';

/**
 * The window's arrangement — sidebar beside or as a drawer, how many panes
 * fit — by the one rule (`shellLayoutFor`, the domain) from the window's
 * width (#658). Read from the window on each resize; the rule hands back the
 * same object while the width stays on one side of the breakpoint, so a
 * window dragged about on a desktop draws nothing again. The stylesheet has
 * no query of its own for this: it reads the class the shell is given, so the
 * number lives in the domain alone.
 */
export function useShellLayout(): ShellLayout {
  return useSyncExternalStore(subscribeToResize, readLayout, readLayout);
}

function subscribeToResize(onChange: () => void): () => void {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

const readLayout = (): ShellLayout => shellLayoutFor(window.innerWidth);
