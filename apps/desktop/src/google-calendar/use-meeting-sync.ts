import { useEffect, useMemo, useRef, useState } from 'react';
import { grantsUse, parseGoogleCalendarSetting, parseMeetingSetting } from '@dfai/domain';
import {
  meetingSyncActivity,
  syncMeetings,
  type ActivityLog,
  type CalendarSource,
  type Clock,
  type GoogleCalendarPort,
  type IndexPort,
  type MarkdownPort,
  type MeetingSyncRecords,
  type MeetingSyncReport,
  type VaultFsPort,
} from '@dfai/application';
import { useSteadyCallback } from '@dfai/ui';
import { useVaultSettingsRead } from '../settings/use-vault-settings-read.ts';
import { vaultSettingsWriter } from '../settings/vault-settings-writer.ts';

/** How often an open vault that reads its meetings is synced. */
export const MEETING_SYNC_INTERVAL_MS = 15 * 60_000;

/** Google Calendar's events through the host (ADR-0046), and this Mac's record of each vault's syncs. */
export interface MeetingSyncHost {
  readonly source: CalendarSource;
  readonly records: MeetingSyncRecords;
  /**
   * This Mac's sign-in, asked before each sync what it may do: one that may
   * not read events never calls Google. Left out, Google's own refusal is
   * what stops the syncs, until Sync now.
   */
  readonly connection?: Pick<GoogleCalendarPort, 'status'>;
}

export interface MeetingSyncOptions {
  /**
   * Null where meetings are not offered, or are not written on this Mac — it
   * is not the one that runs the vault's automations: nothing is synced.
   */
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
  /** Syncs now, even one Google refused for want of the read scope: the person asked. */
  readonly syncNow: () => void;
  /** Ends a sync under way: from now on it asks Google nothing and writes nothing. */
  readonly stop: () => void;
}

interface Shown {
  readonly vault: string | null;
  readonly syncing: boolean;
  readonly report: MeetingSyncReport | null;
}

/** The grant a scope refusal was given for, so a new grant is tried again. Unknown is its own. */
const grantKey = (scopes: readonly string[] | null) =>
  scopes === null ? 'unknown' : [...scopes].sort().join(' ');

/**
 * This Mac's grant for `vault`, or null when it cannot say. A Mac whose
 * sign-in cannot be read is left to Google's own answer.
 */
async function grantOf(host: MeetingSyncHost, vault: string): Promise<readonly string[] | null> {
  if (host.connection === undefined) return null;
  try {
    return (await host.connection.status({ vault })).scopes;
  } catch {
    // Safe to ignore: the sync then asks Google, whose refusal is reported and waited on.
    return null;
  }
}

/**
 * Whether the open vault reads its meetings, as its settings say: the same
 * shared read the sync makes, so asking it draws nothing more.
 */
export function useMeetingsOn({
  fs,
  markdown,
  vaultKey,
}: Pick<MeetingSyncOptions, 'fs' | 'markdown' | 'vaultKey'>): boolean {
  const { settings } = useVaultSettingsRead({ fs, markdown, vaultKey });
  return parseMeetingSetting(settings ?? {}).enabled;
}

/**
 * Today's meetings from Google Calendar into the open vault (ADR-0046): once
 * its index is ready, every 15 minutes while it is open, and on Sync now —
 * only for a vault whose settings turn meetings on and name a client, on a
 * Mac whose sign-in may read events, so a vault that does not read its
 * meetings never asks the host anything. One sync at a time for each vault.
 * Once Google says the sign-in may not read events, the clock asks no more
 * until the grant changes. Activity hears what a sync wrote, and a problem
 * once until it changes, not every quarter hour while offline.
 */
export function useMeetingSync(options: MeetingSyncOptions): MeetingSyncController {
  const { meetings, fs, markdown, vaultKey, indexReady } = options;
  const { settings } = useVaultSettingsRead({ fs, markdown, vaultKey });
  const setting = useMemo(() => parseMeetingSetting(settings ?? {}), [settings]);
  const google = useMemo(() => parseGoogleCalendarSetting(settings ?? {}), [settings]);
  const enabled = meetings !== null && setting.enabled && google.clientId !== null;
  const latest = useRef({ options, enabled });
  latest.current = { options, enabled };
  const running = useRef(new Set<string>());
  const stops = useRef(0);
  const refused = useRef(new Map<string, string>());
  const lastWarnings = useRef(new Map<string, ReadonlySet<string>>());
  const [shown, setShown] = useState<Shown>({ vault: null, syncing: false, report: null });

  // Each warning is said once, until a sync no longer has it; what a sync wrote is said each time.
  const tell = (vault: string, report: MeetingSyncReport) => {
    const before = lastWarnings.current.get(vault) ?? new Set<string>();
    const warnings = new Set<string>();
    for (const line of meetingSyncActivity(report)) {
      if (line.level === 'warning') warnings.add(line.message);
      if (line.level !== 'warning' || !before.has(line.message)) {
        latest.current.options.activity.inVault(vault).record(line);
      }
    }
    lastWarnings.current.set(vault, warnings);
  };

  /** Shows what a sync of `vault` is doing, unless another vault has been opened since. */
  const show = (vault: string, next: (last: Shown) => Shown) =>
    setShown((last) => (latest.current.options.vaultKey === vault ? next(last) : last));

  const sync = async (now: MeetingSyncOptions, host: MeetingSyncHost, vault: string) => {
    const stopsAtStart = stops.current;
    const report = await syncMeetings(
      {
        ...host,
        fs: now.fs,
        markdown: now.markdown,
        index: now.index,
        clock: now.clock,
        settings: vaultSettingsWriter({ fs: now.fs, markdown: now.markdown }),
      },
      {
        vault,
        timeZone: now.timeZone(),
        setting,
        blocksCalendarId: google.calendarId,
        // Stop ends it, and so does the switch going off for this vault; opening another does not.
        wanted: () =>
          stops.current === stopsAtStart &&
          (latest.current.options.vaultKey !== vault || latest.current.enabled),
      },
    );
    tell(vault, report);
    if (report.created + report.updated + report.missing > 0) now.onWrote();
    return report;
  };

  const run = useSteadyCallback(async (asked: boolean) => {
    const now = latest.current.options;
    const host = now.meetings;
    if (host === null || now.vaultKey === null || running.current.has(now.vaultKey)) return;
    const vault = now.vaultKey;
    running.current.add(vault);
    try {
      const granted = await grantOf(host, vault);
      if (granted !== null && !grantsUse(granted, 'meetings')) return;
      if (!asked && refused.current.get(vault) === grantKey(granted)) return;
      show(vault, (last) => ({
        vault,
        syncing: true,
        report: last.vault === vault ? last.report : null,
      }));
      const report = await sync(now, host, vault);
      if (report.scopeRefused) refused.current.set(vault, grantKey(granted));
      else refused.current.delete(vault);
      show(vault, () => ({ vault, syncing: false, report }));
    } finally {
      running.current.delete(vault);
    }
  });

  const calendars = setting.calendars.join('\n');
  useEffect(() => {
    if (!enabled || !indexReady || vaultKey === null) return;
    void run(false);
    const timer = window.setInterval(() => void run(false), MEETING_SYNC_INTERVAL_MS);
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
      syncNow: () => void run(true),
      stop: () => {
        stops.current += 1;
      },
    }),
    [enabled, mine, shown.syncing, report, lastSyncAt, run],
  );
}
