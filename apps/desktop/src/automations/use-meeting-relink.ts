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
 * vault the run is for. Each meeting is said in Activity as the import says it.
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
      const { linked } = await relinkMeetings({
        link: (paths) => linker(vault, paths),
        paths: meetings,
        ports: latest.current.ports,
        today: clock.today(),
      });
      if (linked.length > 0) latest.current.onSettled();
    },
    [linker, clock],
  );
}
