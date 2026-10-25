import { useEffect, useMemo, useRef, useState } from 'react';
import { parseGoogleCalendarSetting, parseMeetingSetting } from '@dfai/domain';
import {
  meetingSyncActivity,
  syncMeetings,
  type ActivityLog,
  type CalendarSource,
  type Clock,
  type IndexPort,
  type MarkdownPort,
  type MeetingSyncRecords,
  type MeetingSyncReport,
  type VaultFsPort,
} from '@dfai/application';
import { useSteadyCallback } from '@dfai/ui';
import { useVaultSettingsRead } from '../settings/use-vault-settings-read.ts';

/** How often an open vault that reads its meetings is synced. */
export const MEETING_SYNC_INTERVAL_MS = 15 * 60_000;

/** Google Calendar's events through the host (ADR-0046), and this Mac's record of each vault's syncs. */
export interface MeetingSyncHost {
  readonly source: CalendarSource;
  readonly records: MeetingSyncRecords;
}

export interface MeetingSyncOptions {
  /** Null where meetings are not offered: nothing is ever synced. */
  readonly meetings: MeetingSyncHost | null;
  /** The open vault's files, notes and index, bound to it. */
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
  readonly index: Pick<IndexPort, 'query'>;
  readonly clock: Pick<Clock, 'today' | 'now'>;
  /** The zone the Mac keeps time in, asked at each sync: a laptop travels. */
  readonly timeZone: () => string;
  readonly vaultKey: string | null;
  /** Whether the index holds the vault as it is: event notes are found in it. */
  readonly indexReady: boolean;
  readonly activity: Pick<ActivityLog, 'inVault'>;
  /** Re-reads the tree and the index once a sync has written into the vault. */
  readonly onWrote: () => void;
}

export interface MeetingSyncController {
  /** Whether the open vault reads its meetings and names a client to read them with. */
  readonly enabled: boolean;
  readonly syncing: boolean;
  /** How the open vault's last sync this session ended; null before one has. */
  readonly report: MeetingSyncReport | null;
  /** When this Mac last finished a whole sync of the open vault, as its record keeps it. */
  readonly lastSyncAt: number | null;
  readonly syncNow: () => void;
}

interface Shown {
  readonly vault: string | null;
  readonly syncing: boolean;
  readonly report: MeetingSyncReport | null;
}

/**
 * Today's meetings from Google Calendar into the open vault (ADR-0046): once
 * its index is ready, every 15 minutes while it is open, and on Sync now —
 * only for a vault whose settings turn meetings on and name a client, so a
 * vault that does not read its meetings never asks the host anything. One
 * sync at a time for the window. Activity hears what a sync wrote, and a
 * problem once until it changes, not every quarter hour while offline.
 */
export function useMeetingSync(options: MeetingSyncOptions): MeetingSyncController {
  const { meetings, fs, markdown, vaultKey, indexReady } = options;
  const { settings } = useVaultSettingsRead({ fs, markdown, vaultKey });
  const setting = useMemo(() => parseMeetingSetting(settings ?? {}), [settings]);
  const google = useMemo(() => parseGoogleCalendarSetting(settings ?? {}), [settings]);
  const enabled = meetings !== null && setting.enabled && google.clientId !== null;
  const latest = useRef(options);
  latest.current = options;
  const running = useRef(false);
  const lastWarning = useRef<string | null>(null);
  const [shown, setShown] = useState<Shown>({ vault: null, syncing: false, report: null });

  const tell = (vault: string, report: MeetingSyncReport) => {
    const line = meetingSyncActivity(report);
    const warning = report.problem === null ? null : (line?.message ?? null);
    if (line !== null && (warning === null || warning !== lastWarning.current)) {
      latest.current.activity.inVault(vault).record(line);
    }
    lastWarning.current = warning;
  };

  const run = useSteadyCallback(async () => {
    const now = latest.current;
    if (now.meetings === null || now.vaultKey === null || running.current) return;
    const vault = now.vaultKey;
    running.current = true;
    setShown((last) => ({
      vault,
      syncing: true,
      report: last.vault === vault ? last.report : null,
    }));
    try {
      const report = await syncMeetings(
        { ...now.meetings, fs: now.fs, markdown: now.markdown, index: now.index, clock: now.clock },
        { vault, timeZone: now.timeZone(), setting, blocksCalendarId: google.calendarId },
      );
      tell(vault, report);
      if (report.created + report.updated + report.missing > 0) now.onWrote();
      setShown({ vault, syncing: false, report });
    } finally {
      running.current = false;
    }
  });

  const calendars = setting.calendars.join('\n');
  useEffect(() => {
    if (!enabled || !indexReady || vaultKey === null) return;
    void run();
    const timer = window.setInterval(() => void run(), MEETING_SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, indexReady, vaultKey, calendars, run]);

  const mine = shown.vault === vaultKey;
  const report = mine ? shown.report : null;
  const lastSyncAt = useMemo(
    () =>
      meetings === null || vaultKey === null ? null : meetings.records.read(vaultKey).lastSyncAt,
    // Read again once a sync of this vault has ended, when the record may have moved on.
    [meetings, vaultKey, report],
  );
  return useMemo(
    () => ({
      enabled,
      syncing: mine && shown.syncing,
      report,
      lastSyncAt,
      syncNow: () => void run(),
    }),
    [enabled, mine, shown.syncing, report, lastSyncAt, run],
  );
}
