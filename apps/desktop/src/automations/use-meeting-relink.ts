import { useCallback, useMemo, useRef } from 'react';
import type { VaultPath } from '@dfai/domain';
import {
  createMeetingLinker,
  relinkMeetings,
  type ActivityLog,
  type AutomationPorts,
  type Clock,
} from '@dfai/application';

/**
 * How Run now links again the meetings whose linking failed (#192): the
 * import's own linker, with the owner as the settings say now, bound to the
 * vault the run is for. Each meeting is said in Activity as the import says
 * it, and the tree and index are read again once it wrote.
 */
export function useMeetingRelink({
  ports,
  clock,
  activity,
  vaultKey,
  selfName,
  selfEmails,
  onSettled,
}: {
  ports: AutomationPorts;
  clock: Pick<Clock, 'today'>;
  activity: ActivityLog;
  vaultKey: string | null;
  selfName: string | null;
  selfEmails: readonly string[];
  onSettled: () => void;
}): (vault: string) => (meetings: readonly VaultPath[]) => Promise<void> {
  const latest = useRef({ ports, vaultKey, selfName, selfEmails, onSettled });
  latest.current = { ports, vaultKey, selfName, selfEmails, onSettled };
  const linker = useMemo(
    () =>
      createMeetingLinker({
        ports: () => latest.current.ports,
        clock,
        activity,
        openVault: () => latest.current.vaultKey,
        selfName: () => latest.current.selfName,
        selfEmails: () => latest.current.selfEmails,
        onWritten: () => latest.current.onSettled(),
      }),
    [clock, activity],
  );
  return useCallback(
    (vault: string) => async (meetings: readonly VaultPath[]) => {
      // The linker checks this vault is still the open one before each meeting, and writes the mark's removal with the links.
      await relinkMeetings({ link: (paths) => linker(vault, paths), paths: meetings });
    },
    [linker],
  );
}
