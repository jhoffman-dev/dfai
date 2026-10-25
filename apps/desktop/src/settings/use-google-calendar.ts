import { useCallback, useEffect, useRef, useState } from 'react';
import {
  dedicatedCalendar,
  grantsUse,
  needsBlocksCalendar,
  parseGoogleCalendarSetting,
  parseMeetingSetting,
  DEDICATED_CALENDAR_NAME,
  type GoogleCalendar,
  type GoogleCalendarSetting,
  type GoogleProblem,
} from '@dfai/domain';
import {
  allowGoogleMeetings,
  blockCalendars,
  connectGoogleCalendar,
  createBlocksCalendar,
  disconnectGoogleCalendar,
  googleProblemOf,
  meetingSyncProblem,
  saveGoogleCalendarSetting,
  saveMeetingsEnabled,
  type ActivityLog,
  type GoogleCalendarPort,
  type GoogleConnection,
  type MarkdownPort,
  type VaultFsPort,
} from '@dfai/application';
import type {
  GoogleCalendarView,
  GoogleConnectRequest,
  GoogleMeetingsActions,
  GoogleMeetingsView,
} from '@dfai/ui';
import type { MeetingSyncController } from '../google-calendar/use-meeting-sync.ts';
import { useVaultSetting } from './use-vault-setting.ts';
import { useVaultSettingsRead } from './use-vault-settings-read.ts';
import { vaultSettingsWriter } from './vault-settings-writer.ts';

/** Settings → Google Calendar as the card draws it, and what it can ask for. */
export interface GoogleCalendarSettingState {
  readonly view: GoogleCalendarView;
  readonly connect: (request: GoogleConnectRequest) => void;
  readonly cancel: () => void;
  readonly disconnect: () => void;
  readonly choose: (calendarId: string) => void;
  readonly create: () => void;
  readonly meetings: GoogleMeetingsActions;
}

const NO_SETTING: GoogleCalendarSetting = { clientId: null, calendarId: null };

const problemOf = (message: string | null): GoogleProblem | null =>
  message === null ? null : { problem: message, fix: null };

/** `9:41 AM`, on the Mac's clock and in its language. */
const timeOfDay = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** The meetings part of the card, from the vault's switch, this Mac's grant and the last sync. */
function meetingsViewOf({
  meetingSync,
  enabled,
  writesHere,
  scopes,
}: {
  meetingSync: MeetingSyncController;
  enabled: boolean;
  writesHere: boolean;
  scopes: readonly string[];
}): GoogleMeetingsView {
  const state = !enabled
    ? 'off'
    : !writesHere
      ? 'elsewhere'
      : grantsUse(scopes, 'meetings')
        ? 'on'
        : 'consent';
  const report = meetingSync.report;
  return {
    state,
    syncing: meetingSync.syncing,
    lastSynced: meetingSync.lastSyncAt === null ? null : timeOfDay(meetingSync.lastSyncAt),
    problem: report === null ? null : meetingSyncProblem(report),
  };
}

/**
 * The open vault's Google Calendar connection, read from the host while
 * Settings is open (`active`), and the client and calendar the vault's
 * settings name. Which calendar blocks go to is kept in the vault, so both
 * Macs use the same one; the sign-in is each Mac's own.
 */
export function useGoogleCalendar({
  port,
  fs,
  markdown,
  vault,
  active,
  activity,
  meetingSync,
  meetingsWrittenHere,
}: {
  port: GoogleCalendarPort;
  fs: VaultFsPort;
  markdown: MarkdownPort;
  vault: string | null;
  active: boolean;
  /** Where a save of the vault's setting that fails is recorded. */
  activity: Pick<ActivityLog, 'inOpenVault'>;
  /** The window's meetings sync (ADR-0046); left out, the card offers no meetings. */
  meetingSync?: MeetingSyncController;
  /**
   * Whether this Mac writes the vault's meeting notes: it runs the vault's
   * automations (U-29). Only one Mac does, so two never write the same note.
   */
  meetingsWrittenHere: boolean;
}): GoogleCalendarSettingState {
  const store = useCallback(
    (setting: GoogleCalendarSetting) =>
      saveGoogleCalendarSetting({ settings: vaultSettingsWriter({ fs, markdown }), setting }),
    [fs, markdown],
  );
  const setting = useVaultSetting({
    fs,
    markdown,
    parse: parseGoogleCalendarSetting,
    store,
    vaultKey: vault,
    activity,
  });
  const kept = setting.value ?? NO_SETTING;
  const settingsRead = useVaultSettingsRead({ fs, markdown, vaultKey: vault });
  const meetingsOn = parseMeetingSetting(settingsRead.settings ?? {}).enabled;
  /** Writes the vault's meetings switch, and reads the settings again so the card and the sync see it now. */
  const switchMeetings = async (enabled: boolean) => {
    await saveMeetingsEnabled({ settings: vaultSettingsWriter({ fs, markdown }), enabled });
    await settingsRead.readAgain();
  };

  const [connection, setConnection] = useState<GoogleConnection | null>(null);
  const [calendars, setCalendars] = useState<readonly GoogleCalendar[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<GoogleProblem | null>(null);
  const [reads, setReads] = useState(0);
  // Reads can land out of order after a change; only the latest may land.
  const latest = useRef(0);

  useEffect(() => {
    latest.current += 1;
    const ticket = latest.current;
    if (vault === null || !active) {
      setConnection(null);
      setCalendars([]);
      return;
    }
    const current = () => ticket === latest.current;
    void (async () => {
      try {
        const found = await port.status({ vault });
        const listed = found.connected ? await blockCalendars({ port, vault }) : [];
        if (!current()) return;
        setConnection(found);
        setCalendars(listed);
      } catch (cause) {
        if (!current()) return;
        setConnection((known) => known ?? { connected: false, clientId: null, scopes: [] });
        setProblem(googleProblemOf(cause));
      }
    })();
  }, [port, vault, active, reads]);

  /** Runs a step, shows what it reports, and reads the connection again. */
  const run = useCallback(async (step: () => Promise<GoogleProblem | null>) => {
    setPending(true);
    setProblem(null);
    try {
      setProblem(await step());
    } catch (cause) {
      setProblem(googleProblemOf(cause));
    } finally {
      setPending(false);
      setReads((count) => count + 1);
    }
  }, []);

  const inVault = (step: (at: string) => Promise<GoogleProblem | null>) => {
    if (vault !== null) void run(() => step(vault));
  };

  const connect = ({ clientId, clientSecret }: GoogleConnectRequest) =>
    inVault(async (at) => {
      setConnecting(true);
      try {
        const made = await connectGoogleCalendar({ port, vault: at, clientId, clientSecret });
        if (made.clientId !== kept.clientId) setting.save({ ...kept, clientId: made.clientId });
        return null;
      } finally {
        setConnecting(false);
      }
    });

  const create = () =>
    inVault(async (at) => {
      const made = await createBlocksCalendar({ port, vault: at });
      setting.save({ ...kept, calendarId: made.id });
      return null;
    });

  /** Asks this Mac's sign-in to read meetings, then turns them on for the vault and reads them. */
  const allowMeetings = () =>
    inVault(async (at) => {
      setConnecting(true);
      try {
        await allowGoogleMeetings({ port, vault: at });
        await switchMeetings(true);
        // Already on for the vault (another Mac turned it on), the sync does not start by itself.
        if (meetingsOn) meetingSync?.syncNow();
        return null;
      } finally {
        setConnecting(false);
      }
    });

  /** Ends a sync under way at once, then turns meetings off for the vault. */
  const stopMeetings = () =>
    inVault(async () => {
      meetingSync?.stop();
      await switchMeetings(false);
      return null;
    });

  const chosen = dedicatedCalendar(calendars, kept.calendarId);
  const phase = connecting
    ? 'connecting'
    : connection === null
      ? 'loading'
      : connection.connected
        ? 'connected'
        : 'disconnected';

  return {
    view: {
      phase,
      clientId: kept.clientId ?? connection?.clientId ?? '',
      calendars: calendars.map(({ id, name }) => ({ id, name })),
      chosen: chosen?.id ?? null,
      canCreate: needsBlocksCalendar(calendars),
      calendarName: DEDICATED_CALENDAR_NAME,
      problem: problem ?? problemOf(setting.problem ?? setting.unreadable),
      pending,
      meetings:
        meetingSync === undefined
          ? null
          : meetingsViewOf({
              meetingSync,
              enabled: meetingsOn,
              writesHere: meetingsWrittenHere,
              scopes: connection?.scopes ?? [],
            }),
    },
    connect,
    cancel: () => {
      port.cancelConnect().catch((cause: unknown) => setProblem(googleProblemOf(cause)));
    },
    disconnect: () => inVault((at) => disconnectGoogleCalendar({ port, vault: at })),
    choose: (calendarId) => setting.save({ ...kept, calendarId }),
    create,
    meetings: {
      onAllow: allowMeetings,
      onSync: () => meetingSync?.syncNow(),
      onStop: stopMeetings,
    },
  };
}
