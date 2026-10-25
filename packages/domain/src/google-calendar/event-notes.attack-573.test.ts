import { describe, expect, it } from 'vitest';
import { wallClockIn } from '../meetings/mapping/meeting-when.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import {
  meetingWindow,
  planEventNotes,
  startOfDayIn,
  type EventNotesInput,
  type GoogleEvent,
  type MeetingWindow,
} from './index.ts';

/* Attack on PR #573 (#31, ADR-0046): the event-note plan, against hostile and edge data. */

const ZONE = 'America/Los_Angeles';
const WINDOW = meetingWindow({ today: '2026-10-24', timeZone: ZONE }) as MeetingWindow;
const at = (iso: string) => ({ kind: 'timed', at: Date.parse(iso) }) as const;

const event = (overrides: Partial<GoogleEvent> = {}): GoogleEvent => ({
  id: 'ev-standup',
  calendarId: 'primary',
  status: 'confirmed',
  title: 'Payroll standup',
  start: at('2026-10-24T16:00:00Z'),
  end: at('2026-10-24T16:30:00Z'),
  attendees: [],
  recurringEventId: null,
  eventType: 'default',
  ...overrides,
});

const linkTo = (path: VaultPath) => `[[${path.replace(/\.md$/, '')}]]`;

const plan = (overrides: Partial<EventNotesInput> = {}) =>
  planEventNotes({
    events: [event()],
    existing: [],
    complete: [],
    window: WINDOW,
    timeZone: ZONE,
    ignoredCalendars: [],
    people: [],
    companies: [],
    meetings: [],
    linkTo,
    taken: new Set(),
    ...overrides,
  });

describe('attack #573: matching a meeting note', () => {
  it('links a meeting note with no start to at most one of two same-titled events that day', () => {
    const writes = plan({
      events: [
        event({ id: 'ev-morning' }),
        event({
          id: 'ev-afternoon',
          start: at('2026-10-24T22:00:00Z'),
          end: at('2026-10-24T22:30:00Z'),
        }),
      ],
      meetings: [
        {
          path: createVaultPath('Inbox/Meetings/Payroll standup.md'),
          title: 'Payroll standup',
          date: '2026-10-24',
          start: null,
        },
      ],
    });
    const linked = writes.filter(
      (write) => write.kind === 'create' && write.properties['meeting'] !== undefined,
    );
    expect(writes).toHaveLength(2);
    expect(linked.length).toBeLessThanOrEqual(1);
  });
});

describe('attack #573: hostile titles become file names', () => {
  const hostile = [
    '../../.atlas/settings',
    '/etc/passwd',
    'a/b\\c:d',
    '.atlas',
    'CON',
    'Line one\nline two\r\n---\nkey: value',
    '[[Secret plan]] %%hidden%% #tag ^block |pipe',
    '<img src=x onerror=alert(1)>',
    '‮gnp.exe‏⁦',
    'x'.repeat(10_000),
    '   ',
    '\u0000\u0007\u001b[31m',
  ];

  it('makes every note one plain file inside Calendar/, never elsewhere or hidden', () => {
    for (const title of hostile) {
      const [write] = plan({ events: [event({ title })] });
      expect(write?.kind, title).toBe('create');
      const path = String(write?.path);
      const segments = path.split('/');
      expect(segments, title).toHaveLength(2);
      expect(segments[0], title).toBe('Calendar');
      const name = segments[1] ?? '';
      expect(name.startsWith('.'), title).toBe(false);
      expect(name.endsWith('.md'), title).toBe(true);
      const unsafe = [...name].some((char) => char.charCodeAt(0) < 0x20 || '\\:'.includes(char));
      expect(unsafe, title).toBe(false);
      expect(new TextEncoder().encode(name).length, title).toBeLessThanOrEqual(255);
    }
  });

  it('gives each of several hostile titles on one day its own file', () => {
    const writes = plan({
      events: hostile.map((title, at) => event({ id: `ev-${at}`, title })),
    });
    const paths = writes.map((write) => write.path.toLowerCase());
    expect(new Set(paths).size).toBe(hostile.length);
  });

  it('never takes the name of a note already there in another case', () => {
    const [write] = plan({
      taken: new Set(['Calendar/2026-10-24 payroll STANDUP.md']),
    });
    expect(write?.path.toLowerCase()).not.toBe('calendar/2026-10-24 payroll standup.md');
  });
});

describe('attack #573: the window in odd zones', () => {
  const zones = [
    'Pacific/Chatham',
    'Asia/Kathmandu',
    'Pacific/Kiritimati',
    'Pacific/Pago_Pago',
    'America/Santiago',
    'America/St_Johns',
    'Australia/Lord_Howe',
    'Asia/Tehran',
    'Europe/London',
  ];

  it('starts each window at the first instant of its first day, every day of the year', () => {
    for (const zone of zones) {
      const clock = wallClockIn(zone);
      for (let day = 0; day < 366; day += 1) {
        const today = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
        const window = meetingWindow({ today, timeZone: zone });
        expect(window, `${zone} ${today}`).not.toBeNull();
        if (window === null) continue;
        expect(clock(window.timeMin).day, `${zone} ${today}`).toBe(window.fromDay);
        expect(clock(window.timeMin - 1).day, `${zone} ${today}`).not.toBe(window.fromDay);
        expect(startOfDayIn(window.fromDay, zone)).toBe(window.timeMin);
      }
    }
  });

  it('writes an event spanning midnight with its start and its end on their own days', () => {
    const [write] = plan({
      events: [event({ start: at('2026-10-25T06:30:00Z'), end: at('2026-10-25T08:00:00Z') })],
    });
    expect(write).toMatchObject({
      kind: 'create',
      properties: { date: '2026-10-24T23:30', ends: '2026-10-25T01:00' },
    });
  });
});
