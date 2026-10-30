import { useMemo, useState } from 'react';
import type { IdlePort, SemanticEngine } from '@dfai/application';
import {
  browserRelatedPanelMemory,
  createBrowserDismissedRelatedStore,
} from './browser-related-stores.ts';
import { createTrailMemory } from './trail-memory.ts';
import type { RelatedPorts } from './use-related-notes.ts';

/** What Related notes and trails run on in the open vault: one set per vault, the trails per window. */
export function useRelatedPorts({
  semantic,
  idle,
  vaultKey,
}: {
  semantic: SemanticEngine | null;
  idle: IdlePort | null;
  vaultKey: string | null;
}): RelatedPorts {
  const [trails] = useState(createTrailMemory);
  const dismissed = useMemo(
    () => (vaultKey === null ? null : createBrowserDismissedRelatedStore(vaultKey)),
    [vaultKey],
  );
  return useMemo(
    () => ({ semantic, idle, dismissed, panel: browserRelatedPanelMemory, trails }),
    [semantic, idle, dismissed, trails],
  );
}
