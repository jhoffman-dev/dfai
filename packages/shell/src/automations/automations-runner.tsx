import { memo, useEffect, useLayoutEffect } from 'react';
import { AUTOMATIONS_SCOPE } from '@dfai/application';
import type { IndexStatusStore } from '../index/index-status-store.ts';
import { useScopedIndexKey } from '../reads/use-scoped-index-key.ts';
import type { AutomationRelay } from '../api/automation-relay.ts';
import { useAutomations, type AutomationsOptions } from './use-automations.ts';
import { publishAutomations, type AutomationsStore } from './automations-store.ts';
import { automationsScheduled } from './automations-scheduled.ts';
import { useSyncForRunners, type SyncStore } from '../sync/sync-store.ts';

export type AutomationsRunnerProps = Omit<
  AutomationsOptions,
  'indexKey' | 'scheduled' | 'pulledFiles'
> & {
  readonly store: AutomationsStore;
  /**
   * Where sync says whether this Mac runs the vault's automations (U-29) and
   * what a pull brought in (ADR-0035 part 4), read here so the window is not
   * drawn for it.
   */
  readonly sync: SyncStore;
  /** Whether the vault's settings have answered for the owner's name and addresses (#173). */
  readonly ownerKnown: boolean;
  /** The index's status, whose news of the rules reads them again while the page is shown. */
  readonly status: IndexStatusStore;
  /** What the API's automations routes read: when the runner began watching, and its pauses. */
  readonly relay: AutomationRelay;
};

/**
 * Runs the open vault's automations outside the window (#326): the clock's
 * minute, a rule read again, a run and its log draw this, which draws
 * nothing, and say where the rules stand in `store`. A rule a note sets off
 * hears every sync's news of that note (`changes`), as it always has. The
 * list is read again for the index's news of the rules and their logs alone
 * (`AUTOMATIONS_SCOPE`), and only while the page is shown (`live`).
 */
export const AutomationsRunner = memo(function AutomationsRunner({
  store,
  status,
  relay,
  sync,
  ownerKnown,
  ...options
}: AutomationsRunnerProps) {
  const { automationsHere, macKnown, pulledFiles } = useSyncForRunners(sync, options.vaultKey);
  const rulesKey = useScopedIndexKey({
    status,
    vault: options.vaultKey,
    reader: ['automations'],
    scope: AUTOMATIONS_SCOPE,
    enabled: options.live === true,
  });
  const automations = useAutomations({
    ...options,
    indexKey: rulesKey,
    // A synced vault runs its automations on one Mac only (U-29), once it and the owner are known.
    scheduled: automationsScheduled({ automationsHere, macKnown, ownerKnown }),
    // Its Claude step runs only on fresh sync state (ADR-0035 part 4).
    pulledFiles,
  });
  // Before paint, so the page never shows a run a step behind the runner's.
  useLayoutEffect(() => publishAutomations(store, automations), [store, automations]);
  useLayoutEffect(() => () => publishAutomations(store, null), [store]);
  const { watchingSince, pauses } = automations;
  const vault = options.vaultKey;
  useEffect(
    () => relay.point({ vault, watchingSince, pauses }),
    [relay, vault, watchingSince, pauses],
  );
  return null;
});
