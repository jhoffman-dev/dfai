import { describe, expect, it } from 'vitest';
import {
  blockEventId,
  blockOnDisk,
  blockPlanZone,
  blockZoneChange,
  blockSyncEnabled,
  eventTimes,
  isBlockCalendarId,
  isGoogleEventId,
  pushableFields,
  reconcileBlocks,
  wallClockText,
  type BlockEvent,
  type BlockOnDisk,
  type BlockSyncFields,
  type ReconcileBlocksInput,
} from './index.ts';
import { blockIdDigest } from './block-event-id.ts';

const ZONE = 'America/Los_Angeles';
const CALENDAR = 'dfai-blocks@group.calendar.example.com';

/** 09:00–10:00 on 2026-10-26 in Los Angeles (PDT, -07:00). */
const NINE = Date.parse('2026-10-26T16:00:00Z');
const TEN = Date.parse('2026-10-26T17:00:00Z');
const ELEVEN = Date.parse('2026-10-26T18:00:00Z');

const agreedNineToTen: BlockSyncFields = {
  title: 'Larkspur close block',
  start: '2026-10-26T09:00',
  end: '2026-10-26T10:00',
};

/** A block synced at 09:00–10:00, both sides agreeing, unless `more` says otherwise. */
const block = (more: Partial<BlockOnDisk> = {}): BlockOnDisk => ({
  path: 'Larkspur close block.md',
  title: 'Larkspur close block',
  start: '2026-10-26T09:00',
  end: '2026-10-26T10:00',
  eventId: 'dfaiev1',
  etag: '"v1"',
  calendarId: CALENDAR,
  missing: false,
  pending: false,
  synced: agreedNineToTen,
  ...more,
});

const moved = { start: '2026-10-26T13:00', end: '2026-10-26T14:00' } as const;

const event = (more: Partial<BlockEvent> = {}): BlockEvent => ({
  id: 'dfaiev1',
  etag: '"v1"',
  cancelled: false,
  title: 'Larkspur close block',
  start: { kind: 'timed', at: NINE },
  end: { kind: 'timed', at: TEN },
  ...more,
});

/** The event moved in Google to 10:00–11:00, with a new version. */
const tenToEleven = (more: Partial<BlockEvent> = {}) =>
  event({
    etag: '"v2"',
    start: { kind: 'timed', at: TEN },
    end: { kind: 'timed', at: ELEVEN },
    ...more,
  });

const plan = (input: Partial<ReconcileBlocksInput>) =>
  reconcileBlocks({
    blocks: [],
    events: [],
    listedInFull: false,
    calendarId: CALENDAR,
    timeZone: ZONE,
    fromDay: '2026-10-11',
    ...input,
  });

const kinds = (input: Partial<ReconcileBlocksInput>) => plan(input).actions.map((a) => a.kind);

const unmade = { eventId: null, etag: null, calendarId: null, synced: null } as const;

describe('reconcileBlocks: the table of cases', () => {
  const cases: {
    name: string;
    input: Partial<ReconcileBlocksInput>;
    expected: string[];
  }[] = [
    {
      name: 'a new block with times is inserted',
      input: { blocks: [block(unmade)] },
      expected: ['insert'],
    },
    {
      name: 'a new block without a time at both ends is not pushed',
      input: { blocks: [block({ ...unmade, end: '2026-10-26' })] },
      expected: ['unplaced'],
    },
    {
      name: 'a new block ending when it starts is not pushed',
      input: { blocks: [block({ ...unmade, end: '2026-10-26T09:00' })] },
      expected: ['unplaced'],
    },
    {
      name: 'an id written but no version yet, event not listed: the insert is tried again',
      input: { blocks: [block({ etag: null })] },
      expected: ['insert'],
    },
    {
      name: 'an id Google could never have given is no id: the block is new',
      input: {
        blocks: [
          blockOnDisk({
            path: 'x.md',
            title: 'x',
            properties: { start: '2026-10-26T09:00', end: '2026-10-26T10:00', gcal_event_id: '..' },
          }),
        ],
      },
      expected: ['insert'],
    },
    {
      name: 'nothing changed on either side: nothing to do',
      input: { blocks: [block()] },
      expected: [],
    },
    {
      name: 'DFAI moved the block, Google did not list it: patch',
      input: { blocks: [block(moved)] },
      expected: ['patch'],
    },
    {
      name: 'DFAI renamed the block: patch, since titles go one way',
      input: { blocks: [block({ title: 'Mara Quill prep' })] },
      expected: ['patch'],
    },
    {
      name: 'DFAI changed it, no agreed record on the block, Google listed nothing: wait',
      input: { blocks: [block({ ...moved, synced: null })] },
      expected: [],
    },
    {
      name: 'Google lists the version the block holds, with DFAI’s change not on it: patch',
      input: { blocks: [block(moved)], events: [event()] },
      expected: ['patch'],
    },
    {
      name: 'Google moved the event, DFAI did not: pull',
      input: { blocks: [block()], events: [tenToEleven()] },
      expected: ['pull'],
    },
    {
      name: 'a new version with the agreed times (a push coming back, a colour): adopt its version only',
      input: { blocks: [block()], events: [event({ etag: '"v2"' })] },
      expected: ['adopt'],
    },
    {
      name: 'a new version with the agreed times while DFAI moved the block: DFAI’s move is pushed',
      input: { blocks: [block(moved)], events: [event({ etag: '"v2"' })] },
      expected: ['patch'],
    },
    {
      name: 'Google renamed the event, times unchanged: the block’s name is put back',
      input: { blocks: [block()], events: [event({ etag: '"v2"', title: 'Renamed in Google' })] },
      expected: ['patch'],
    },
    {
      name: 'Google renamed and moved the event: its times are pulled and the name put back',
      input: { blocks: [block()], events: [tenToEleven({ title: 'Renamed in Google' })] },
      expected: ['pull'],
    },
    {
      name: 'both sides moved it to the same place: agreed, only the record is written',
      input: {
        blocks: [block({ start: '2026-10-26T10:00', end: '2026-10-26T11:00' })],
        events: [tenToEleven()],
      },
      expected: ['adopt'],
    },
    {
      name: 'both sides moved it apart: Google’s time is pulled, as a conflict',
      input: { blocks: [block(moved)], events: [tenToEleven()] },
      expected: ['pull'],
    },
    {
      name: 'no agreed record, Google on the block’s times: learnt as agreed',
      input: { blocks: [block({ synced: null })], events: [event()] },
      expected: ['adopt'],
    },
    {
      name: 'no agreed record, Google on other times: Google’s are pulled, as a conflict',
      input: { blocks: [block({ synced: null })], events: [tenToEleven()] },
      expected: ['pull'],
    },
    {
      name: 'an event Google lists with no version, values agreed: nothing written',
      input: { blocks: [block()], events: [event({ etag: null })] },
      expected: [],
    },
    {
      name: 'an event written for another note (the block was moved to a folder): patched to say this one',
      input: {
        blocks: [block()],
        events: [event({ notePath: 'Old folder/Larkspur close block.md' })],
      },
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
      input: { blocks: [block({ ...unmade, missing: true })] },
      expected: [],
    },
    {
      name: 'an event whose times cannot be read: the block is left as it is',
      input: { blocks: [block()], events: [event({ etag: '"v2"', start: null })] },
      expected: [],
    },
    {
      name: 'a copy (one event id on two notes) moved to another day: the copy gets its own event',
      input: {
        blocks: [block(), block({ path: 'Larkspur close block copy.md', ...moved })],
        events: [event({ notePath: 'Larkspur close block.md' })],
      },
      expected: ['insert'],
    },
    {
      name: 'a copy older than the sync looks back: cleared, and kept off Google',
      input: {
        blocks: [
          block(),
          block({ path: 'Archive/x.md', start: '2026-09-01T09:00', end: '2026-09-01T10:00' }),
        ],
        events: [event({ notePath: 'Larkspur close block.md' })],
      },
      expected: ['detach'],
    },
    {
      name: 'a copy with no time to push: cleared',
      input: {
        blocks: [block(), block({ path: 'Z copy.md', end: null })],
        events: [event({ notePath: 'Larkspur close block.md' })],
      },
      expected: ['detach'],
    },
  ];

  it.each(cases)('$name', ({ input, expected }) => {
    expect(kinds(input)).toEqual(expected);
  });
});

describe('reconcileBlocks: a push that never landed (sent, Google not answered)', () => {
  // Agreed 09:00; James moved it to 10:00; the push wrote the record and the
  // pending mark, kept the last version Google confirmed, then never landed.
  const sentTen: BlockSyncFields = {
    ...agreedNineToTen,
    start: '2026-10-26T10:00',
    end: '2026-10-26T11:00',
  };
  const pendingTen = (more: Partial<BlockOnDisk> = {}) =>
    block({ start: sentTen.start, end: sentTen.end, synced: sentTen, pending: true, ...more });

  const only = (input: Partial<ReconcileBlocksInput>) => {
    const [action, ...rest] = plan(input).actions;
    expect(rest).toEqual([]);
    return action;
  };

  it('Google lists the version the block kept, in a full listing: unchanged there, so it is sent again', () => {
    expect(only({ blocks: [pendingTen()], events: [event()], listedInFull: true })).toMatchObject({
      kind: 'patch',
      fields: sentTen,
    });
  });

  it('Google lists the version the block kept, incrementally: sent again', () => {
    expect(only({ blocks: [pendingTen()], events: [event()] })).toMatchObject({ kind: 'patch' });
  });

  it('Google lists nothing: sent again, not taken as agreed', () => {
    expect(only({ blocks: [pendingTen()] })).toMatchObject({ kind: 'patch', fields: sentTen });
  });

  it('a full listing without the event: marked missing, never pushed', () => {
    expect(only({ blocks: [pendingTen()], listedInFull: true })).toMatchObject({ kind: 'missing' });
  });

  it('Google changed the event since (a colour), on its old times: both changed, Google kept and said', () => {
    expect(
      only({ blocks: [pendingTen()], events: [event({ etag: '"v2"' })], listedInFull: true }),
    ).toMatchObject({
      kind: 'pull',
      fields: { start: '2026-10-26T09:00', end: '2026-10-26T10:00' },
      conflict: true,
    });
  });

  it('Google moved the event elsewhere since: Google kept, as a conflict', () => {
    const elsewhere = event({
      etag: '"v2"',
      start: { kind: 'timed', at: Date.parse('2026-10-26T20:00:00Z') },
      end: { kind: 'timed', at: Date.parse('2026-10-26T21:00:00Z') },
    });
    expect(only({ blocks: [pendingTen()], events: [elsewhere] })).toMatchObject({
      kind: 'pull',
      fields: { start: '2026-10-26T13:00', end: '2026-10-26T14:00' },
      conflict: true,
    });
  });

  it('the push landed but its version was not written: Google on the sent times, so it is adopted', () => {
    expect(only({ blocks: [pendingTen()], events: [tenToEleven()] })).toMatchObject({
      kind: 'adopt',
      etag: '"v2"',
    });
  });

  it('landed, and James saved a newer edit before its version was written: his edit is pushed (2c)', () => {
    const newer = pendingTen({ start: '2026-10-26T12:00', end: '2026-10-26T13:00' });
    expect(only({ blocks: [newer], events: [tenToEleven()] })).toMatchObject({
      kind: 'patch',
      fields: { start: '2026-10-26T12:00', end: '2026-10-26T13:00' },
    });
  });

  it('a block with a record but no version, Google on other times in a full listing: never silently reverted', () => {
    const unconfirmed = block({
      start: sentTen.start,
      end: sentTen.end,
      synced: sentTen,
      etag: null,
    });
    expect(only({ blocks: [unconfirmed], events: [event()], listedInFull: true })).toMatchObject({
      kind: 'pull',
      conflict: true,
    });
  });

  it('a patch planned from a listed event is based on that event’s version; an unlisted one on the block’s', () => {
    const colouredMoved = block({ start: sentTen.start, end: sentTen.end });
    expect(only({ blocks: [colouredMoved], events: [event({ etag: '"v5"' })] })).toMatchObject({
      kind: 'patch',
      basedOn: '"v5"',
    });
    expect(only({ blocks: [colouredMoved] })).toMatchObject({ kind: 'patch', basedOn: null });
  });

  it('reads the pending mark from the block, only as true', () => {
    const read = (value: unknown) =>
      blockOnDisk({ path: 'x.md', title: 'x', properties: { gcal_pending: value } }).pending;
    expect([read(true), read('true'), read(null), read(undefined)]).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });
});

describe('reconcileBlocks: what each action carries', () => {
  it('pushes a new block’s note name and wall-clock times, with no id yet', () => {
    const [action] = plan({ blocks: [block(unmade)] }).actions;
    expect(action).toEqual({
      kind: 'insert',
      path: 'Larkspur close block.md',
      eventId: null,
      fields: agreedNineToTen,
      copyOf: null,
    });
  });

  it('retries an insert with the id already written, so it is the same event', () => {
    const [action] = plan({ blocks: [block({ etag: null })] }).actions;
    expect(action).toMatchObject({ kind: 'insert', eventId: 'dfaiev1', copyOf: null });
  });

  it('patches with the block’s own title and times, whatever Google changed besides', () => {
    const [action] = plan({
      blocks: [block(moved)],
      events: [event({ etag: '"v2"', title: 'Renamed in Google' })],
    }).actions;
    expect(action).toEqual({
      kind: 'patch',
      path: 'Larkspur close block.md',
      eventId: 'dfaiev1',
      fields: { title: 'Larkspur close block', ...moved },
      basedOn: '"v2"',
    });
  });

  it('pulls Google’s times on the plan zone with its version, no conflict when DFAI did not change it', () => {
    const [action] = plan({ blocks: [block()], events: [tenToEleven()] }).actions;
    expect(action).toEqual({
      kind: 'pull',
      path: 'Larkspur close block.md',
      eventId: 'dfaiev1',
      etag: '"v2"',
      fields: { title: 'Larkspur close block', start: '2026-10-26T10:00', end: '2026-10-26T11:00' },
      conflict: false,
      returned: false,
      retitle: false,
    });
  });

  it('both sides changed: Google’s time is pulled, and it says there was a conflict', () => {
    const [action] = plan({ blocks: [block(moved)], events: [tenToEleven()] }).actions;
    expect(action).toMatchObject({
      kind: 'pull',
      conflict: true,
      fields: { start: '2026-10-26T10:00', end: '2026-10-26T11:00' },
    });
  });

  it('with no agreed record on the block, Google’s other time is kept and said as a conflict', () => {
    const [action] = plan({ blocks: [block({ synced: null })], events: [tenToEleven()] }).actions;
    expect(action).toMatchObject({ kind: 'pull', conflict: true });
  });

  it('a pull of an event renamed in Google says to put the block’s name back', () => {
    const [action] = plan({
      blocks: [block()],
      events: [tenToEleven({ title: 'Lunch with Tobias Fenn' })],
    }).actions;
    expect(action).toMatchObject({
      kind: 'pull',
      retitle: true,
      fields: { title: 'Larkspur close block' },
    });
  });

  it('reads Google’s times on the zone given, not a fixed one', () => {
    const [action] = plan({
      blocks: [block()],
      events: [tenToEleven()],
      timeZone: 'America/New_York',
    }).actions;
    expect(action).toMatchObject({
      fields: { start: '2026-10-26T13:00', end: '2026-10-26T14:00' },
    });
  });

  it('a returned event takes the missing mark off, as a pull that says so', () => {
    const [action] = plan({
      blocks: [block({ missing: true })],
      events: [event({ etag: '"v3"', title: 'Renamed' })],
    }).actions;
    expect(action).toMatchObject({
      kind: 'pull',
      returned: true,
      conflict: false,
      etag: '"v3"',
      retitle: true,
    });
  });

  it('adopts only what is new: the version when it moved, the record when it was not there', () => {
    expect(plan({ blocks: [block()], events: [event({ etag: '"v2"' })] }).actions).toEqual([
      {
        kind: 'adopt',
        path: 'Larkspur close block.md',
        eventId: 'dfaiev1',
        etag: '"v2"',
        synced: null,
      },
    ]);
    expect(plan({ blocks: [block({ synced: null })], events: [event()] }).actions).toEqual([
      {
        kind: 'adopt',
        path: 'Larkspur close block.md',
        eventId: 'dfaiev1',
        etag: null,
        synced: agreedNineToTen,
      },
    ]);
  });

  it('a version Google gives as null is never taken for the block’s', () => {
    const [action] = plan({
      blocks: [block({ synced: null })],
      events: [event({ etag: null })],
    }).actions;
    expect(action).toMatchObject({ kind: 'adopt', etag: null, synced: agreedNineToTen });
  });

  it('a block changed in DFAI to have no end, with nothing to push: said as unplaced', () => {
    const [action] = plan({ blocks: [block({ end: '2026-10-26' })] }).actions;
    expect(action).toEqual({ kind: 'unplaced', path: 'Larkspur close block.md' });
  });

  it('a block with no calendar yet is taken as the current calendar’s', () => {
    expect(kinds({ blocks: [block({ calendarId: null })], listedInFull: true })).toEqual([
      'missing',
    ]);
  });
});

describe('reconcileBlocks: copies keep one event with one note', () => {
  const original = 'Blocks/Ledger review block.md';
  const copy = 'Blocks/Ledger review block copy.md';
  const actionsFor = (blocks: BlockOnDisk[], listed: BlockEvent[]) =>
    plan({ blocks, events: listed }).actions;

  it('the note the event was written for keeps it, though a copy sorts first and is unchanged', () => {
    const actions = actionsFor(
      [block({ path: original, ...moved }), block({ path: copy })],
      [event({ notePath: original })],
    );
    expect(actions).toEqual([
      {
        kind: 'insert',
        path: copy,
        eventId: null,
        fields: agreedNineToTen,
        copyOf: 'dfaiev1',
      },
      {
        kind: 'patch',
        path: original,
        eventId: 'dfaiev1',
        fields: { title: 'Larkspur close block', ...moved },
        basedOn: '"v1"',
      },
    ]);
  });

  it('with no note named on the event, the one on the event’s times keeps it', () => {
    const actions = actionsFor(
      [block({ path: original }), block({ path: copy, ...moved })],
      [event()],
    );
    expect(actions.map((action) => [action.kind, action.path])).toEqual([['insert', copy]]);
  });

  it('with the event not known, the one unchanged since it was agreed keeps it', () => {
    const actions = actionsFor([block({ path: copy, ...moved }), block({ path: original })], []);
    expect(actions.map((action) => [action.kind, action.path])).toEqual([['insert', copy]]);
  });

  it('with nothing to tell them apart, the first by path keeps it', () => {
    const actions = actionsFor(
      [
        block({ path: original, ...moved, synced: null }),
        block({ path: copy, ...moved, synced: null }),
      ],
      [],
    );
    expect(actions.map((action) => [action.kind, action.path])).toEqual([['insert', original]]);
  });

  describe('renamed, and copied, before the next sync: no note is the one the event names', () => {
    // The event still names the old path; the original was renamed since, and a copy made.
    const renamed = 'Blocks/Ledger review, Q4.md';
    const oldPath = 'Blocks/Ledger review block.md';
    it.each([
      'Blocks/Ledger review block copy.md',
      'Blocks/Ledger review block copy 2.md',
      'Blocks/Ledger review block 2.md',
    ])('the renamed original keeps the event, never the copy %s that sorts first', (copied) => {
      const actions = actionsFor(
        [
          block({ path: renamed, title: 'Ledger review, Q4' }),
          block({ path: copied, title: copied.slice(7, -3) }),
        ],
        [event({ notePath: oldPath })],
      );
      expect(actions.map((action) => [action.kind, action.path])).toEqual([
        ['insert', copied],
        ['patch', renamed],
      ]);
    });

    it('when every note looks like a copy, the rules before decide as they did', () => {
      const first = 'Blocks/Ledger review block 2.md';
      const second = 'Blocks/Ledger review block copy.md';
      const actions = actionsFor(
        [
          block({ path: second, title: 'Ledger review block copy' }),
          block({ path: first, title: 'Ledger review block 2' }),
        ],
        [event({ notePath: oldPath })],
      );
      expect(actions.map((action) => [action.kind, action.path])).toEqual([
        ['patch', first],
        ['insert', second],
      ]);
    });
  });

  it('a copy never patches the event, and its times are never pulled into another note', () => {
    const actions = actionsFor(
      [
        block({ path: original }),
        block({ path: copy, start: '2026-10-28T13:00', end: '2026-10-28T14:00' }),
      ],
      [tenToEleven({ notePath: original })],
    );
    expect(actions.filter((action) => action.kind === 'patch')).toEqual([]);
    expect(actions.find((action) => action.kind === 'pull')).toMatchObject({ path: original });
  });

  it('copies of a block on another calendar are left alone', () => {
    const elsewhere = { calendarId: 'old@group.calendar.example.com' };
    expect(
      actionsFor(
        [block({ path: original, ...elsewhere }), block({ path: copy, ...elsewhere })],
        [],
      ),
    ).toEqual([]);
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
      pending: false,
      synced: null,
    });
    const bare = blockOnDisk({ path: 'y.md', title: 'y', properties: { gcal_missing: 'yes' } });
    expect(bare).toMatchObject({ eventId: null, etag: null, calendarId: null, missing: false });
  });

  it('reads the agreed record only when all of it is there', () => {
    const synced = {
      gcal_synced_title: 'Larkspur close block',
      gcal_synced_start: '2026-10-26T09:00:00',
      gcal_synced_end: '2026-10-26T10:00',
    };
    const read = (properties: Record<string, unknown>) =>
      blockOnDisk({ path: 'x.md', title: 'x', properties }).synced;
    expect(read(synced)).toEqual(agreedNineToTen);
    expect(read({ ...synced, gcal_synced_end: undefined })).toBeNull();
    expect(read({ ...synced, gcal_synced_title: 3 })).toBeNull();
    expect(read({ ...synced, gcal_synced_start: 'soon' })).toBeNull();
  });
});

describe('blockEventId', () => {
  const VAULT_ID = 'k3v9q0m2b7hd5t1e';
  const id = (path: string, attempt = 0, calendarId = CALENDAR, vaultId = VAULT_ID) =>
    blockEventId({ vaultId, calendarId, path, attempt });

  it('pins the exact ids drawn for fixed inputs', () => {
    // Changing these makes two app versions draw different ids for one new
    // block: two writers on different versions would then make two events.
    // Ids already pushed are kept on their notes and never drawn again.
    expect(id('Blocks/Payroll run block.md')).toBe('dfaic52ed443a64adb9b8e4ed70a2240502c');
    expect(id('Blocks/Payroll run block.md', 1)).toBe('dfaic52ed343a64ad9e88e4ed80a224051df');
    expect(id('Blocks/Mara Quill prep — Q4 ✓.md')).toBe('dfaif2b55218ddcf62b73e8c147f3e20db6e');
    expect(id('Blocks/Payroll run block.md', 0, CALENDAR, 'p8r2s6u0c4f1g9j7')).toBe(
      'dfai9fc20c8b20b34fb7abb90616d2e91b14',
    );
  });

  it('pins the id drawn for a vault with no id of its own: from the calendar and the path alone', () => {
    expect(
      blockEventId({
        vaultId: null,
        calendarId: CALENDAR,
        path: 'Blocks/Payroll run block.md',
        attempt: 0,
      }),
    ).toBe('dfaia80d472d8e863e224b16aa3d35f8cb53');
  });

  it('is FNV-1a, 64 bits, over the UTF-8 bytes: its published test values', () => {
    expect([blockIdDigest(''), blockIdDigest('a'), blockIdDigest('foobar')]).toEqual([
      'cbf29ce484222325',
      'af63dc4c8601ec8c',
      '85944171f73967e8',
    ]);
  });

  it('differs by vault: two vaults on one calendar never draw one id for one path', () => {
    expect(id('Blocks/Payroll run block.md', 0, CALENDAR, 'p8r2s6u0c4f1g9j7')).not.toBe(
      id('Blocks/Payroll run block.md'),
    );
  });

  it('is the same on every Mac for one calendar and one path, and in Google’s alphabet', () => {
    expect(id('Blocks/Payroll run block.md')).toBe(id('Blocks/Payroll run block.md'));
    expect(id('Blocks/Payroll run block.md')).toMatch(/^dfai[0-9a-f]{32}$/);
    expect(isGoogleEventId(id('Blocks/Payroll run block.md'))).toBe(true);
  });

  it('differs by path, by calendar and by attempt', () => {
    const ids = new Set([
      id('Blocks/Payroll run block.md'),
      id('Blocks/Payroll run block copy.md'),
      id('Blocks/Payroll run block.md', 1),
      id('Blocks/Payroll run block.md', 0, 'other@group.calendar.example.com'),
    ]);
    expect(ids.size).toBe(4);
  });

  it('does not meet another block’s over a vault of blocks', () => {
    const ids = new Set(Array.from({ length: 20_000 }, (_, at) => id(`Blocks/Block ${at}.md`)));
    expect(ids.size).toBe(20_000);
  });
});

describe('the ids a sync puts in a URL', () => {
  it('takes an event id only in Google’s alphabet, 5 to 1024 long', () => {
    expect(isGoogleEventId('dfaiev1')).toBe(true);
    expect(isGoogleEventId('abcde')).toBe(true);
    expect(isGoogleEventId('abcd')).toBe(false);
    expect(isGoogleEventId('a'.repeat(1025))).toBe(false);
    for (const hostile of [
      '..',
      '.',
      'dfai/../x',
      'dfaiW1234',
      'dfai%2e%2e',
      'dfai_12345',
      'dfai 12345',
    ]) {
      expect(isGoogleEventId(hostile)).toBe(false);
    }
  });

  it('takes a calendar id only as Google names one, name@domain', () => {
    expect(isBlockCalendarId(CALENDAR)).toBe(true);
    expect(isBlockCalendarId('mara.quill@example.com')).toBe(true);
    for (const hostile of [
      '..',
      '.',
      'primary',
      '../users/me',
      'a@b',
      'a@b.com/..',
      'a@b.com?x=1',
      '@example.com',
    ]) {
      expect(isBlockCalendarId(hostile)).toBe(false);
    }
  });
});

describe('blockPlanZone', () => {
  it('is the primary calendar’s zone when Google gave it, else the Mac’s', () => {
    expect(blockPlanZone({ primaryZone: 'America/Chicago', timeZone: ZONE })).toBe(
      'America/Chicago',
    );
    expect(blockPlanZone({ primaryZone: null, timeZone: ZONE })).toBe(ZONE);
  });
});

describe('blockSyncEnabled', () => {
  it('is on only for true', () => {
    expect(blockSyncEnabled({ google_blocks: true })).toBe(true);
    expect(blockSyncEnabled({ google_blocks: 'true' })).toBe(false);
    expect(blockSyncEnabled({})).toBe(false);
  });
});

describe('blockZoneChange', () => {
  const at = Date.parse('2026-10-26T16:00:00Z');
  it('is none on a first sync, or on the same zone', () => {
    expect(blockZoneChange({ from: null, to: ZONE, at })).toBeNull();
    expect(blockZoneChange({ from: ZONE, to: ZONE, at })).toBeNull();
  });

  it('says how far a block’s times move: the new zone’s offset less the old one’s, then', () => {
    expect(blockZoneChange({ from: ZONE, to: 'America/New_York', at })).toEqual({
      from: ZONE,
      to: 'America/New_York',
      shiftMinutes: 180,
    });
    expect(blockZoneChange({ from: 'Europe/London', to: 'Asia/Kolkata', at })?.shiftMinutes).toBe(
      330,
    );
    // A week on, both have left summer time: London on UTC, Los Angeles eight hours behind.
    const later = Date.parse('2026-11-02T16:00:00Z');
    expect(blockZoneChange({ from: 'Europe/London', to: ZONE, at: later })?.shiftMinutes).toBe(
      -480,
    );
  });
});
