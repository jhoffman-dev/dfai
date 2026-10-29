import { memo, useCallback, useMemo } from 'react';
import type { MeetingsWaiting } from '@dfai/domain';
import { useSyncForRunners, type SyncStore } from '../sync/sync-store.ts';
import { sayMeetingsWaiting, type MeetingsWaitingStore } from './meetings-waiting-store.ts';
import { useMeetingImport } from './use-meeting-import.ts';

export type MeetingImportRunnerProps = Omit<
  Parameters<typeof useMeetingImport>[0],
  'active' | 'pulledFiles' | 'namedElsewhere' | 'onWaiting'
> & {
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
  useMeetingImport({
    ...options,
    active: automationsHere,
    pulledFiles,
    namedElsewhere: named,
    onWaiting,
  });
  return null;
});
