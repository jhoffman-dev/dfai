import { useEffect, useMemo, useRef, useState } from 'react';
import { blockSyncEnabled, grantsUse, parseGoogleCalendarSetting } from '@dfai/domain';
import {
  blockSyncActivity,
  syncBlocks,
  type ActivityLog,
  type BlockCalendar,
  type BlockSyncRecords,
  type BlockSyncReport,
  type Clock,
  type GoogleCalendarPort,
  type IndexPort,
  type MarkdownPort,
  type VaultFsPort,
} from '@dfai/application';
import { useSteadyCallback } from '@dfai/ui';
import { useVaultSettingsRead } from '../settings/use-vault-settings-read.ts';
import { vaultSettingsWriter } from '../settings/vault-settings-writer.ts';

/** How often an open vault whose blocks sync is synced. */
export const BLOCK_SYNC_INTERVAL_MS = 15 * 60_000;

/** The blocks calendar through the host (#30), and this Mac's record of each vault's syncs. */
export interface BlockSyncHost {
  readonly calendar: BlockCalendar;
  readonly records: BlockSyncRecords;
  /** This Mac's sign-in, asked before each sync what it may do; one that may not write blocks never calls Google. */
  readonly connection?: Pick<GoogleCalendarPort, 'status'>;
}

export interface BlockSyncOptions {
  /** Null where blocks are not synced from this Mac — it is not the one that runs the vault's automations. */
  readonly blocks: BlockSyncHost | null;
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
  readonly index: Pick<IndexPort, 'query'>;
  readonly clock: Pick<Clock, 'today' | 'now'>;
  /** The zone the Mac keeps time in, asked at each sync: used only when Google names none for the primary calendar. */
  readonly timeZone: () => string;
  readonly vaultKey: string | null;
  readonly indexReady: boolean;
  readonly activity: Pick<ActivityLog, 'inVault'>;
  readonly onWrote: () => void;
}

export interface BlockSyncController {
  /** Whether the open vault syncs its blocks and names a client and a calendar to sync with. */
  readonly enabled: boolean;
  readonly syncing: boolean;
  readonly report: BlockSyncReport | null;
  readonly lastSyncAt: number | null;
  /** Syncs now, even after Google refused for want of the scope: the person asked. */
  readonly syncNow: () => void;
  /** Ends a sync under way: from now on it asks Google nothing and writes nothing. */
  readonly stop: () => void;
}

interface Shown {
  readonly vault: string | null;
  readonly syncing: boolean;
  readonly report: BlockSyncReport | null;
}

const grantKey = (scopes: readonly string[] | null) =>
  scopes === null ? 'unknown' : [...scopes].sort().join(' ');

async function grantOf(host: BlockSyncHost, vault: string): Promise<readonly string[] | null> {
  if (host.connection === undefined) return null;
  try {
    return (await host.connection.status({ vault })).scopes;
  } catch {
    // Safe to ignore: the sync then asks Google, whose refusal is reported and waited on.
    return null;
  }
}

/** Whether the open vault syncs its blocks, as its settings say: the same shared read the sync makes. */
export function useBlockSyncOn({
  fs,
  markdown,
  vaultKey,
}: Pick<BlockSyncOptions, 'fs' | 'markdown' | 'vaultKey'>): boolean {
  const { settings } = useVaultSettingsRead({ fs, markdown, vaultKey });
  return blockSyncEnabled(settings ?? {});
}

/**
 * Two-way sync of the open vault's blocks with its Google calendar (#30):
 * once its index is ready, every 15 minutes while it is open, and on Sync
 * now — only for a vault whose settings turn it on and name a client and a
 * calendar, on a Mac whose sign-in may write that calendar, so a vault that
 * does not sync blocks never asks the host anything. One sync at a time per
 * vault. Once Google refuses for want of the scope, the clock asks no more
 * until the grant changes. Activity hears what a sync wrote each time, and a
 * warning once until it changes, not every quarter hour.
 */
export function useBlockSync(options: BlockSyncOptions): BlockSyncController {
  const { blocks, fs, markdown, vaultKey, indexReady } = options;
  const { settings } = useVaultSettingsRead({ fs, markdown, vaultKey });
  const on = blockSyncEnabled(settings ?? {});
  const google = useMemo(() => parseGoogleCalendarSetting(settings ?? {}), [settings]);
  const calendarId = google.calendarId;
  const enabled = blocks !== null && on && google.clientId !== null && calendarId !== null;
  const latest = useRef({ options, enabled, calendarId });
  latest.current = { options, enabled, calendarId };
  const running = useRef(new Set<string>());
  const stops = useRef(0);
  const refused = useRef(new Map<string, string>());
  const lastWarnings = useRef(new Map<string, ReadonlySet<string>>());
  const [shown, setShown] = useState<Shown>({ vault: null, syncing: false, report: null });

  const tell = (vault: string, report: BlockSyncReport) => {
    const lines = blockSyncActivity(report);
    const before = lastWarnings.current.get(vault) ?? new Set<string>();
    const warnings = new Set<string>();
    for (const line of lines) {
      if (line.level === 'warning') warnings.add(line.message);
      if (line.level !== 'warning' || !before.has(line.message)) {
        latest.current.options.activity.inVault(vault).record(line);
      }
    }
    lastWarnings.current.set(vault, warnings);
  };

  const show = (vault: string, next: (last: Shown) => Shown) =>
    setShown((last) => (latest.current.options.vaultKey === vault ? next(last) : last));

  const sync = async (
    now: BlockSyncOptions,
    host: BlockSyncHost,
    vault: string,
    calendar: string,
  ) => {
    const stopsAtStart = stops.current;
    const report = await syncBlocks(
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
        calendarId: calendar,
        timeZone: now.timeZone(),
        // Stop ends it, and so does the switch going off for this vault; opening another does not.
        wanted: () =>
          stops.current === stopsAtStart &&
          (latest.current.options.vaultKey !== vault || latest.current.enabled),
      },
    );
    tell(vault, report);
    if (report.inserted + report.pushed + report.pulled + report.missing > 0) now.onWrote();
    return report;
  };

  const run = useSteadyCallback(async (asked: boolean) => {
    const { options: now, enabled: wanted, calendarId: calendar } = latest.current;
    const host = now.blocks;
    if (!wanted || host === null || calendar === null || now.vaultKey === null) return;
    const vault = now.vaultKey;
    if (running.current.has(vault)) return;
    running.current.add(vault);
    try {
      const granted = await grantOf(host, vault);
      if (granted !== null && !grantsUse(granted, 'blocks')) return;
      if (!asked && refused.current.get(vault) === grantKey(granted)) return;
      show(vault, (last) => ({
        vault,
        syncing: true,
        report: last.vault === vault ? last.report : null,
      }));
      const report = await sync(now, host, vault, calendar);
      if (report.scopeRefused) refused.current.set(vault, grantKey(granted));
      else refused.current.delete(vault);
      show(vault, () => ({ vault, syncing: false, report }));
    } finally {
      running.current.delete(vault);
    }
  });

  useEffect(() => {
    if (!enabled || !indexReady || vaultKey === null) return;
    void run(false);
    const timer = window.setInterval(() => void run(false), BLOCK_SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, indexReady, vaultKey, calendarId, run]);

  const mine = shown.vault === vaultKey;
  const report = mine ? shown.report : null;
  const lastSyncAt = useMemo(
    () => (blocks === null || vaultKey === null ? null : blocks.records.read(vaultKey).lastSyncAt),
    // Read again once a sync of this vault has ended, when the record may have moved on.
    [blocks, vaultKey, report],
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
