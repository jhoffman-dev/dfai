import { describe, expect, it } from 'vitest';
import {
  blockOnDisk,
  blockSyncEnabled,
  eventTimes,
  newBlockEventId,
  pushableFields,
  reconcileBlocks,
  wallClockText,
  type BlockEvent,
  type BlockOnDisk,
  type BlockSyncFields,
  type ReconcileBlocksInput,
} from './index.ts';

const ZONE = 'America/Los_Angeles';
const CALENDAR = 'dfai-blocks@group.calendar.example.com';

/** 09:00–10:00 on 2026-10-26 in Los Angeles (PDT, -07:00). */
const NINE = Date.parse('2026-10-26T16:00:00Z');
const TEN = Date.parse('2026-10-26T17:00:00Z');
const ELEVEN = Date.parse('2026-10-26T18:00:00Z');

const block = (more: Partial<BlockOnDisk> = {}): BlockOnDisk => ({
  path: 'Larkspur close block.md',
  title: 'Larkspur close block',
  start: '2026-10-26T09:00',
  end: '2026-10-26T10:00',
  eventId: 'dfaiev1',
  etag: '"v1"',
  calendarId: CALENDAR,
  missing: false,
  ...more,
});

const event = (more: Partial<BlockEvent> = {}): BlockEvent => ({
  id: 'dfaiev1',
  etag: '"v1"',
  cancelled: false,
  title: 'Larkspur close block',
  start: { kind: 'timed', at: NINE },
  end: { kind: 'timed', at: TEN },
  ...more,
});

const agreedNineToTen: BlockSyncFields = {
  title: 'Larkspur close block',
  start: '2026-10-26T09:00',
  end: '2026-10-26T10:00',
};

const plan = (input: Partial<ReconcileBlocksInput>) =>
  reconcileBlocks({
    blocks: [],
    events: [],
    listedInFull: false,
    lastSync: {},
    calendarId: CALENDAR,
    timeZone: ZONE,
    ...input,
  });

const kinds = (input: Partial<ReconcileBlocksInput>) => plan(input).actions.map((a) => a.kind);

describe('reconcileBlocks: the table of cases', () => {
  const cases: {
    name: string;
    input: Partial<ReconcileBlocksInput>;
    expected: string[];
  }[] = [
    {
      name: 'a new block with times is inserted',
      input: { blocks: [block({ eventId: null, etag: null, calendarId: null })] },
      expected: ['insert'],
    },
    {
      name: 'a new block without a time at both ends is not pushed',
      input: { blocks: [block({ eventId: null, etag: null, end: '2026-10-26' })] },
      expected: ['unplaced'],
    },
    {
      name: 'a new block ending when it starts is not pushed',
      input: { blocks: [block({ eventId: null, etag: null, end: '2026-10-26T09:00' })] },
      expected: ['unplaced'],
    },
    {
      name: 'an id written but no version yet, event not listed: the insert is tried again',
      input: { blocks: [block({ etag: null })] },
      expected: ['insert'],
    },
    {
      name: 'nothing changed on either side: nothing to do',
      input: { blocks: [block()], lastSync: { dfaiev1: agreedNineToTen } },
      expected: [],
    },
    {
      name: 'DFAI moved the block, Google did not list it: patch',
      input: {
        blocks: [block({ start: '2026-10-26T10:00', end: '2026-10-26T11:00' })],
        lastSync: { dfaiev1: agreedNineToTen },
      },
      expected: ['patch'],
    },
    {
      name: 'DFAI renamed the block: patch, since titles go one way',
      input: {
        blocks: [block({ title: 'Mara Quill prep' })],
        lastSync: { dfaiev1: agreedNineToTen },
      },
      expected: ['patch'],
    },
    {
      name: 'DFAI changed it but no last sync is known on this Mac and Google listed nothing: wait',
      input: { blocks: [block({ start: '2026-10-26T10:00', end: '2026-10-26T11:00' })] },
      expected: [],
    },
    {
      name: 'Google lists the version the block holds, with DFAI’s change not on it: patch',
      input: {
        blocks: [block({ start: '2026-10-26T10:00', end: '2026-10-26T11:00' })],
        events: [event()],
      },
      expected: ['patch'],
    },
    {
      name: 'Google moved the event, DFAI did not: pull',
      input: {
        blocks: [block()],
        events: [
          event({
            etag: '"v2"',
            start: { kind: 'timed', at: TEN },
            end: { kind: 'timed', at: ELEVEN },
          }),
        ],
        lastSync: { dfaiev1: agreedNineToTen },
      },
      expected: ['pull'],
    },
    {
      name: 'a new version with the block’s own times (a push coming back): adopt its version only',
      input: { blocks: [block()], events: [event({ etag: '"v2"' })] },
      expected: ['adopt'],
    },
    {
      name: 'Google renamed the event, times unchanged: the block’s name is put back',
      input: { blocks: [block()], events: [event({ etag: '"v2"', title: 'Renamed in Google' })] },
      expected: ['patch'],
    },
    {
      name: 'Google cancelled the event: marked missing',
      input: { blocks: [block()], events: [event({ cancelled: true, start: null, end: null })] },
      expected: ['missing'],
    },
    {
      name: 'a full listing without the event: marked missing',
      input: { blocks: [block()], listedInFull: true },
      expected: ['missing'],
    },
    {
      name: 'a block already missing whose event stays gone: left alone',
      input: { blocks: [block({ missing: true })], listedInFull: true },
      expected: [],
    },
    {
      name: 'a block marked missing whose event is back: pulled',
      input: { blocks: [block({ missing: true })], events: [event({ etag: '"v3"' })] },
      expected: ['pull'],
    },
    {
      name: 'a block on another calendar: left alone',
      input: {
        blocks: [block({ calendarId: 'old@group.calendar.example.com' })],
        listedInFull: true,
      },
      expected: [],
    },
    {
      name: 'a new block marked missing by hand, with no event: left alone',
      input: { blocks: [block({ eventId: null, etag: null, missing: true })] },
      expected: [],
    },
    {
      name: 'an event whose times cannot be read: the block is left as it is',
      input: { blocks: [block()], events: [event({ etag: '"v2"', start: null })] },
      expected: [],
    },
  ];

  it.each(cases)('$name', ({ input, expected }) => {
    expect(kinds(input)).toEqual(expected);
  });
});

describe('reconcileBlocks: what each action carries', () => {
  it('pushes a new block’s note name and wall-clock times, with no id yet', () => {
    const [action] = plan({ blocks: [block({ eventId: null, etag: null })] }).actions;
    expect(action).toEqual({
      kind: 'insert',
      path: 'Larkspur close block.md',
      eventId: null,
      fields: agreedNineToTen,
    });
  });

  it('retries an insert with the id already written, so it is the same event', () => {
    const [action] = plan({ blocks: [block({ etag: null })] }).actions;
    expect(action).toMatchObject({ kind: 'insert', eventId: 'dfaiev1' });
  });

  it('pulls Google’s times on the calendar’s clock with its version, and is no conflict when DFAI did not change it', () => {
    const [action] = plan({
      blocks: [block()],
      events: [
        event({
          etag: '"v2"',
          start: { kind: 'timed', at: TEN },
          end: { kind: 'timed', at: ELEVEN },
        }),
      ],
      lastSync: { dfaiev1: agreedNineToTen },
    }).actions;
    expect(action).toEqual({
      kind: 'pull',
      path: 'Larkspur close block.md',
      eventId: 'dfaiev1',
      etag: '"v2"',
      fields: { title: 'Larkspur close block', start: '2026-10-26T10:00', end: '2026-10-26T11:00' },
      conflict: false,
      returned: false,
    });
  });

  it('both sides changed: Google’s time is pulled, and it says there was a conflict', () => {
    const [action] = plan({
      blocks: [block({ start: '2026-10-26T13:00', end: '2026-10-26T14:00' })],
      events: [
        event({
          etag: '"v2"',
          start: { kind: 'timed', at: TEN },
          end: { kind: 'timed', at: ELEVEN },
        }),
      ],
      lastSync: { dfaiev1: agreedNineToTen },
    }).actions;
    expect(action).toMatchObject({
      kind: 'pull',
      conflict: true,
      fields: { start: '2026-10-26T10:00', end: '2026-10-26T11:00' },
    });
  });

  it('reads Google’s times on the zone given, not a fixed one', () => {
    const [action] = plan({
      blocks: [block()],
      events: [
        event({
          etag: '"v2"',
          start: { kind: 'timed', at: TEN },
          end: { kind: 'timed', at: ELEVEN },
        }),
      ],
      timeZone: 'America/New_York',
    }).actions;
    expect(action).toMatchObject({
      fields: { start: '2026-10-26T13:00', end: '2026-10-26T14:00' },
    });
  });

  it('a returned event takes the missing mark off, as a pull that says so', () => {
    const [action] = plan({
      blocks: [block({ missing: true })],
      events: [event({ etag: '"v3"' })],
    }).actions;
    expect(action).toMatchObject({ kind: 'pull', returned: true, conflict: false, etag: '"v3"' });
  });

  it('a block whose event Google lists unchanged, with no last sync known, is learnt as agreed', () => {
    const result = plan({ blocks: [block()], events: [event()] });
    expect(result.actions).toEqual([]);
    expect(result.agreed).toEqual({ dfaiev1: agreedNineToTen });
  });

  it('a second block with the same event id is left alone and named, the first by path followed', () => {
    const result = plan({
      blocks: [
        block({ path: 'b.md', start: '2026-10-26T10:00', end: '2026-10-26T11:00' }),
        block({ path: 'a.md' }),
      ],
      events: [event()],
    });
    expect(result.actions).toEqual([{ kind: 'duplicate', path: 'b.md', eventId: 'dfaiev1' }]);
  });

  it('a block changed in DFAI to have no end, with nothing to push: said as unplaced', () => {
    const [action] = plan({
      blocks: [block({ end: '2026-10-26' })],
      lastSync: { dfaiev1: agreedNineToTen },
    }).actions;
    expect(action).toEqual({ kind: 'unplaced', path: 'Larkspur close block.md' });
  });

  it('a block with no calendar yet is taken as the current calendar’s', () => {
    expect(kinds({ blocks: [block({ calendarId: null })], listedInFull: true })).toEqual([
      'missing',
    ]);
  });

  it('a block whose event id is written, no version, but the event is listed: its version is adopted', () => {
    expect(kinds({ blocks: [block({ etag: null })], events: [event()] })).toEqual(['adopt']);
  });

  it('a version Google gives as null is never taken for the block’s', () => {
    const result = plan({ blocks: [block({ etag: null })], events: [event({ etag: null })] });
    expect(result.actions.map((a) => a.kind)).toEqual(['adopt']);
  });
});

describe('the times sync compares', () => {
  it('writes a date property the one way: minutes, no seconds, no offset', () => {
    expect(wallClockText('2026-10-26T09:00:00')).toBe('2026-10-26T09:00');
    expect(wallClockText('2026-10-26T09:05+02:00')).toBe('2026-10-26T09:05');
    expect(wallClockText('2026-10-26')).toBe('2026-10-26');
    expect(wallClockText('soon')).toBeNull();
    expect(wallClockText(42)).toBeNull();
  });

  it('reads an all-day event as its first and last day', () => {
    const allDay = event({
      start: { kind: 'day', date: '2026-10-26' },
      end: { kind: 'day', date: '2026-10-28' },
    });
    expect(eventTimes(allDay, ZONE)).toEqual({ start: '2026-10-26', end: '2026-10-27' });
    const oneDay = event({
      start: { kind: 'day', date: '2026-10-26' },
      end: { kind: 'day', date: '2026-10-27' },
    });
    expect(eventTimes(oneDay, ZONE)).toEqual({ start: '2026-10-26', end: '2026-10-26' });
  });

  it('pushes only a block with a time at both ends that ends after it starts', () => {
    expect(pushableFields(block())).toEqual(agreedNineToTen);
    expect(pushableFields(block({ start: null }))).toBeNull();
    expect(pushableFields(block({ start: '2026-10-26' }))).toBeNull();
    expect(pushableFields(block({ end: '2026-10-26T08:00' }))).toBeNull();
    expect(pushableFields(block({ start: '2026-10-26T23:00', end: '2026-10-27T01:00' }))).toEqual({
      title: 'Larkspur close block',
      start: '2026-10-26T23:00',
      end: '2026-10-27T01:00',
    });
  });

  it('reads a block’s sync state from its frontmatter, and only its owned keys', () => {
    expect(
      blockOnDisk({
        path: 'x.md',
        title: 'x',
        properties: {
          start: '2026-10-26T09:00',
          end: '2026-10-26T10:00',
          gcal_event_id: ' dfaiev1 ',
          gcal_etag: '"v1"',
          gcal_calendar: CALENDAR,
          gcal_missing: true,
          tasks: ['[[Close the books]]'],
        },
      }),
    ).toEqual({
      path: 'x.md',
      title: 'x',
      start: '2026-10-26T09:00',
      end: '2026-10-26T10:00',
      eventId: 'dfaiev1',
      etag: '"v1"',
      calendarId: CALENDAR,
      missing: true,
    });
    const bare = blockOnDisk({ path: 'y.md', title: 'y', properties: { gcal_missing: 'yes' } });
    expect(bare).toMatchObject({ eventId: null, etag: null, calendarId: null, missing: false });
  });
});

describe('newBlockEventId', () => {
  it('is in Google’s alphabet for an id a client picks, and long enough to be unique', () => {
    let seed = 0;
    const id = newBlockEventId(() => {
      seed = (seed + 0.37) % 1;
      return seed;
    });
    expect(id).toMatch(/^[a-v0-9]{30}$/);
    expect(id.startsWith('dfai')).toBe(true);
  });

  it('reaches both ends of the alphabet', () => {
    expect(newBlockEventId(() => 0)).toBe(`dfai${'0'.repeat(26)}`);
    expect(newBlockEventId(() => 0.9999)).toBe(`dfai${'v'.repeat(26)}`);
  });
});

describe('blockSyncEnabled', () => {
  it('is on only for true', () => {
    expect(blockSyncEnabled({ google_blocks: true })).toBe(true);
    expect(blockSyncEnabled({ google_blocks: 'true' })).toBe(false);
    expect(blockSyncEnabled({})).toBe(false);
  });
});
