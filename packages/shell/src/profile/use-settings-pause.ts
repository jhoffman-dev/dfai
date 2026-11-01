import { useEffect, useRef } from 'react';
import { VAULT_SETTINGS_PATH } from '@dfai/domain';
import type { ActivityRecorder } from '@dfai/application';

/** What Activity says when the settings note stops reading, and when it reads again. */
export const pausedMessage = (problem: string): string =>
  `Meetings and automations are paused: ${VAULT_SETTINGS_PATH} can’t be read (${problem}). Nothing is lost — meetings wait in their folder — and both resume once it reads.`;
export const RESUMED_MESSAGE = `Meetings and automations resumed: ${VAULT_SETTINGS_PATH} reads again.`;

/**
 * Says in Activity, once each time it changes, that the meeting import and
 * the automations are held because the vault's settings note cannot be read
 * (#226), and that they resumed once it reads. `unreadable` is why it cannot
 * be read, or null while it reads.
 */
export function useSettingsPause({
  unreadable,
  vaultKey,
  activity,
}: {
  unreadable: string | null;
  vaultKey: string | null;
  activity: ActivityRecorder;
}): void {
  // The vault last said to be paused: a resume is said only after a pause, and a pause once.
  const paused = useRef<string | null>(null);
  useEffect(() => {
    if (vaultKey === null) return;
    if (unreadable !== null) {
      if (paused.current === vaultKey) return;
      paused.current = vaultKey;
      activity.record({
        level: 'warning',
        kind: 'automation',
        message: pausedMessage(unreadable),
        subject: null,
      });
    } else if (paused.current === vaultKey) {
      paused.current = null;
      activity.record({
        level: 'info',
        kind: 'automation',
        message: RESUMED_MESSAGE,
        subject: null,
      });
    }
  }, [unreadable, vaultKey, activity]);
}
