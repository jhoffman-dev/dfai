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
  type CalendarSource,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import {
  useMeetingSync,
  MEETING_SYNC_INTERVAL_MS,
  type MeetingSyncOptions,
} from './use-meeting-sync.ts';

/* Attack on PR #573 (#31, ADR-0046): when the meetings sync asks Google, and for which vault. */

const VAULT = '/Users/mara/Vault';
const OTHER_VAULT = '/Users/mara/Second Vault';
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

function setUp(source: CalendarSource) {
  const { records } = memoryMeetingSyncRecords();
  const fs = fakeVaultFs({
    readNotes: async (paths) =>
      paths.includes('.atlas/settings.md')
        ? [{ path: '.atlas/settings.md', text: `---\n${MEETINGS_ON}\n---\n`, modified: 1, size: 1 }]
        : [],
    createNote: async () => 1,
  });
  const options: MeetingSyncOptions = {
    meetings: { source, records },
    fs,
    markdown: remarkMarkdown,
    index: fakeIndexPort(),
    clock: { today: () => '2026-10-24', now: () => NOW },
    timeZone: () => 'America/Los_Angeles',
    vaultKey: VAULT,
    indexReady: true,
    activity: recordingActivity(),
    onWrote: vi.fn(),
  };
  const hook = renderHook((props: MeetingSyncOptions) => useMeetingSync(props), {
    wrapper: queryWrapper().wrapper,
    initialProps: options,
  });
  return { hook, options };
}

const settle = () =>
  act(async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe('attack #573: a Mac without the meetings scope', () => {
  it('stops asking Google every quarter hour once Google says the read scope was not granted', async () => {
    const google = fakeCalendarSource({ primary: [standup] });
    const insufficient = () =>
      new GoogleCalendarError({
        kind: 'api_refused',
        code: '403',
        message: 'Request had insufficient authentication scopes.',
      });
    google.state.next = insufficient();
    setUp(google.source);
    await settle();
    for (let tick = 0; tick < 4; tick += 1) {
      google.state.next = insufficient();
      await act(async () => vi.advanceTimersByTime(MEETING_SYNC_INTERVAL_MS));
      await settle();
    }
    // One hour later: the same refusal should not have been asked for four more times.
    expect(google.state.asked).toHaveLength(1);
  });
});

describe('attack #573: switching vaults during a sync', () => {
  it('syncs the vault switched to as soon as the one before has finished, not 15 minutes later', async () => {
    const google = fakeCalendarSource({ primary: [standup] });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const vaults: string[] = [];
    const source: CalendarSource = {
      listEvents: async (ask) => {
        vaults.push(ask.vault);
        if (ask.vault === VAULT) await held;
        return google.source.listEvents(ask);
      },
    };
    const { hook, options } = setUp(source);
    await settle();
    expect(vaults).toEqual([VAULT]);
    hook.rerender({ ...options, vaultKey: OTHER_VAULT });
    await settle();
    release();
    await settle();
    expect(vaults).toContain(OTHER_VAULT);
  });
});
