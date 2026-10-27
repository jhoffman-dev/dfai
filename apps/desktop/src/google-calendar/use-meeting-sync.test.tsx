// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { GoogleEvent } from '@dfai/domain';
import {
  fakeCalendarSource,
  fakeIndexPort,
  fakeVaultFs,
  memoryMeetingSyncRecords,
  recordingActivity,
  GoogleCalendarError,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import {
  useMeetingSync,
  MEETING_SYNC_INTERVAL_MS,
  type MeetingSyncOptions,
} from './use-meeting-sync.ts';

const VAULT = '/Users/mara/Vault';
const CLIENT_ID = '123456789012-abcdef0123456789abcdef0123456789.apps.googleusercontent.com';
const NOW = Date.parse('2026-10-24T14:00:00Z');
const MEETINGS_ON = `google_client_id: ${CLIENT_ID}\ngoogle_meetings: true`;

const standup: GoogleEvent = {
  id: 'ev-standup',
  calendarId: 'primary',
  status: 'confirmed',
  title: 'Payroll standup',
  start: { kind: 'timed', at: Date.parse('2026-10-24T16:00:00Z') },
  end: { kind: 'timed', at: Date.parse('2026-10-24T16:30:00Z') },
  attendees: [],
  recurringEventId: null,
  eventType: 'default',
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const READS_EVENTS = 'https://www.googleapis.com/auth/calendar.events.readonly';
const MAKES_BLOCKS = 'https://www.googleapis.com/auth/calendar.app.created';

function setUp({
  settings = MEETINGS_ON,
  indexReady = true,
  offered = true,
  grant,
}: {
  settings?: string;
  indexReady?: boolean;
  offered?: boolean;
  /** This Mac's scopes, as the host's status says them; left out, the host is not asked. */
  grant?: { scopes: string[] };
} = {}) {
  const google = fakeCalendarSource({ primary: [standup] });
  const { records, kept } = memoryMeetingSyncRecords();
  const created: string[] = [];
  const activity = recordingActivity();
  const onWrote = vi.fn();
  const fs = fakeVaultFs({
    readNotes: async (paths) =>
      paths.includes('.atlas/settings.md')
        ? [{ path: '.atlas/settings.md', text: `---\n${settings}\n---\n`, modified: 1, size: 1 }]
        : [],
    createNote: async ({ path }) => {
      created.push(path);
      return 1;
    },
  });
  const options: MeetingSyncOptions = {
    meetings: offered
      ? {
          source: google.source,
          records,
          ...(grant === undefined
            ? {}
            : {
                connection: {
                  status: async () => ({
                    connected: true,
                    clientId: CLIENT_ID,
                    scopes: grant.scopes,
                  }),
                },
              }),
        }
      : null,
    fs,
    markdown: remarkMarkdown,
    index: fakeIndexPort(),
    clock: { today: () => '2026-10-24', now: () => NOW },
    timeZone: () => 'America/Los_Angeles',
    vaultKey: VAULT,
    indexReady,
    activity,
    onWrote,
  };
  const hook = renderHook((props: MeetingSyncOptions) => useMeetingSync(props), {
    wrapper: queryWrapper().wrapper,
    initialProps: options,
  });
  return { hook, google, kept, created, activity, onWrote, options };
}

/** Lets the settings read and a sync under way settle. */
const settle = () =>
  act(async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe('useMeetingSync (ADR-0046)', () => {
  it('syncs a vault that reads its meetings once its index is ready, and says what it wrote', async () => {
    const { hook, google, created, activity, onWrote, kept } = setUp();
    await settle();
    expect(google.state.asked).toEqual([{ calendarId: 'primary', syncToken: null }]);
    expect(created).toEqual(['Calendar/2026-10-24 Payroll standup.md']);
    expect(onWrote).toHaveBeenCalledTimes(1);
    expect(activity.reports.map(({ message }) => message)).toEqual([
      'Meetings from Google Calendar: 1 meeting added.',
    ]);
    expect(hook.result.current).toMatchObject({ enabled: true, syncing: false, lastSyncAt: NOW });
    expect(hook.result.current.report).toMatchObject({ created: 1, problem: null });
    expect(kept.get(VAULT)?.lastSyncAt).toBe(NOW);
  });

  it('syncs again every fifteen minutes, by what changed, and on Sync now', async () => {
    const { hook, google } = setUp();
    await settle();
    await act(async () => vi.advanceTimersByTime(MEETING_SYNC_INTERVAL_MS));
    await settle();
    expect(google.state.asked.at(-1)).toEqual({ calendarId: 'primary', syncToken: 'sync-1' });
    act(() => hook.result.current.syncNow());
    await settle();
    expect(google.state.asked).toHaveLength(3);
  });

  it('never asks the host anything for a vault that does not read its meetings', async () => {
    for (const settings of [
      'theme: dark',
      `google_client_id: ${CLIENT_ID}`,
      'google_meetings: true',
    ]) {
      const { hook, google } = setUp({ settings });
      await settle();
      await act(async () => vi.advanceTimersByTime(MEETING_SYNC_INTERVAL_MS));
      expect(google.state.asked).toEqual([]);
      expect(hook.result.current.enabled).toBe(false);
      hook.unmount();
    }
  });

  it('waits for the index, and syncs nothing where meetings are not offered', async () => {
    const waiting = setUp({ indexReady: false });
    await settle();
    expect(waiting.google.state.asked).toEqual([]);
    waiting.hook.rerender({ ...waiting.options, indexReady: true });
    await settle();
    expect(waiting.google.state.asked).toHaveLength(1);
    const notOffered = setUp({ offered: false });
    await settle();
    expect(notOffered.hook.result.current.enabled).toBe(false);
  });

  it('says a problem in Activity once, not every quarter hour while it lasts', async () => {
    const { hook, google, activity } = setUp();
    google.state.next = new GoogleCalendarError({ kind: 'unreachable', message: 'offline' });
    await settle();
    google.state.next = new GoogleCalendarError({ kind: 'unreachable', message: 'offline' });
    await act(async () => vi.advanceTimersByTime(MEETING_SYNC_INTERVAL_MS));
    await settle();
    expect(google.state.asked).toHaveLength(2);
    expect(activity.reports).toHaveLength(1);
    expect(activity.reports[0]).toMatchObject({ level: 'warning' });
    expect(hook.result.current.report?.problem?.problem).toBe(
      'Google could not be reached: offline.',
    );
  });

  it('says a zone that could not be kept once, and still says what each sync wrote (#587)', async () => {
    const { google, activity, options } = setUp();
    options.fs.writeTextFile = async () => Promise.reject(new Error('the disk is full'));
    await settle();
    const zoneLines = () =>
      activity.reports.filter((report) => report.message.includes('could not be kept'));
    expect(zoneLines()).toHaveLength(1);
    expect(activity.reports.map((report) => report.message)).toContain(
      'Meetings from Google Calendar: 1 meeting added.',
    );
    google.change('primary', { ...standup, id: 'ev-retro', title: 'Retro' });
    await act(async () => vi.advanceTimersByTime(MEETING_SYNC_INTERVAL_MS));
    await settle();
    expect(zoneLines()).toHaveLength(1);
    expect(
      activity.reports.filter((report) => report.message.endsWith('1 meeting added.')),
    ).toHaveLength(2);
  });

  it('never calls Google on a Mac whose sign-in may not read events', async () => {
    const { hook, google } = setUp({ grant: { scopes: [MAKES_BLOCKS] } });
    await settle();
    await act(async () => vi.advanceTimersByTime(MEETING_SYNC_INTERVAL_MS));
    await settle();
    act(() => hook.result.current.syncNow());
    await settle();
    expect(google.state.asked).toEqual([]);
  });

  it('asks again once the grant changes after Google refused it the read scope', async () => {
    const grant = { scopes: [MAKES_BLOCKS, READS_EVENTS] };
    const { google } = setUp({ grant });
    google.state.next = new GoogleCalendarError({
      kind: 'api_refused',
      code: '403',
      message: 'Request had insufficient authentication scopes.',
    });
    await settle();
    await act(async () => vi.advanceTimersByTime(MEETING_SYNC_INTERVAL_MS));
    await settle();
    expect(google.state.asked).toHaveLength(1);
    grant.scopes = [READS_EVENTS, MAKES_BLOCKS, 'openid'];
    await act(async () => vi.advanceTimersByTime(MEETING_SYNC_INTERVAL_MS));
    await settle();
    expect(google.state.asked).toHaveLength(2);
  });

  it('tries again on Sync now after a scope refusal: the person asked', async () => {
    const { hook, google } = setUp();
    google.state.next = new GoogleCalendarError({
      kind: 'api_refused',
      code: '403',
      message: 'Request had insufficient authentication scopes.',
    });
    await settle();
    act(() => hook.result.current.syncNow());
    await settle();
    expect(google.state.asked).toHaveLength(2);
  });

  it('writes nothing more once stopped while a sync is under way', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { hook, google, created, kept } = setUp();
    const listEvents = google.source.listEvents;
    google.source.listEvents = async (ask) => {
      await held;
      return listEvents(ask);
    };
    await settle();
    act(() => hook.result.current.stop());
    release();
    await settle();
    expect(google.state.asked).toHaveLength(1);
    expect(created).toEqual([]);
    expect(kept.get(VAULT)).toBeUndefined();
  });
});
