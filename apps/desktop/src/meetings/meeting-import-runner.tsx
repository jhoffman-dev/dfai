import { memo, useCallback, useMemo, useRef } from 'react';
import type { MeetingsWaiting } from '@dfai/domain';
import { createRulesTakeCache, type RuleQueryPorts, type RunClock } from '@dfai/application';
import type { AutomationsStore } from '../automations/automations-store.ts';
import { useSyncForRunners, type SyncStore } from '../sync/sync-store.ts';
import {
  readPostProcessing,
  rulesTakeFrom,
  usePostProcessingNews,
} from './post-processing-facts.ts';
import { sayMeetingsWaiting, type MeetingsWaitingStore } from './meetings-waiting-store.ts';
import { useMeetingImport } from './use-meeting-import.ts';

export type MeetingImportRunnerProps = Omit<
  Parameters<typeof useMeetingImport>[0],
  'active' | 'pulledFiles' | 'namedElsewhere' | 'onWaiting' | 'postProcessing' | 'clock'
> & {
  /** The Mac's clock: the rules' reach is counted on it, or on the plan zone's for a rule that keeps it. */
  readonly clock: RunClock;
  /** Where the automations runner says what the rules have finished with, and how its runs went (#182). */
  readonly automations: AutomationsStore;
  /** What the rules' own queries are asked through: which meetings they take (#637 attack). */
  readonly rulePorts: RuleQueryPorts;
  /** Where sync says whether this Mac runs the vault's automations, and what a pull brought in. */
  readonly sync: SyncStore;
  /** Where the import says what waits for the named Mac, for the Inbox to show (ADR-0035 part 1). */
  readonly waiting: MeetingsWaitingStore;
};

/**
 * Runs the meeting import (P28-04) outside the window (#326). Only the Mac
 * that runs the automations writes into meeting files (U-29), and only on
 * fresh sync state (ADR-0035 part 4): both are read from the sync store here,
 * so the window is not drawn when they change. Another Mac says what waits
 * for it into `waiting`, which the Inbox reads.
 */
export const MeetingImportRunner = memo(function MeetingImportRunner({
  sync,
  waiting,
  automations,
  rulePorts,
  ...options
}: MeetingImportRunnerProps) {
  const { automationsHere, pulledFiles, namedElsewhere, namedMacName } = useSyncForRunners(
    sync,
    options.vaultKey,
  );
  const named = useMemo(
    () => (namedElsewhere ? { name: namedMacName } : null),
    [namedElsewhere, namedMacName],
  );
  const onWaiting = useCallback(
    (vault: string, said: MeetingsWaiting | null) => sayMeetingsWaiting(waiting, vault, said),
    [waiting],
  );
  const { clock, indexReady } = options;
  const news = usePostProcessingNews(automations, clock);
  const ready = useRef(indexReady);
  ready.current = indexReady;
  const take = useMemo(
    () =>
      rulesTakeFrom({
        store: automations,
        clock,
        ports: rulePorts,
        indexReady: () => ready.current,
        take: createRulesTakeCache(),
      }),
    [automations, clock, rulePorts],
  );
  const postProcessing = useMemo(
    () => ({
      ...news,
      ledger: () => readPostProcessing(automations, clock),
      take,
      // The settings name this Mac when it runs the automations: its name is theirs.
      mac: automationsHere ? namedMacName : null,
    }),
    [news, automations, clock, take, automationsHere, namedMacName],
  );
  useMeetingImport({
    ...options,
    active: automationsHere,
    pulledFiles,
    namedElsewhere: named,
    onWaiting,
    postProcessing,
  });
  return null;
});
