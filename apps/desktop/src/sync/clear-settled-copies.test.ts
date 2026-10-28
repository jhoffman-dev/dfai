/**
 * #235: a conflict copy of one of DFAI's own files, under `Sync conflicts/atlas/`,
 * goes to the Trash when its live file already holds everything in it — the
 * live file's own merge with the copy (`mergeSettings`, no base) gives it back
 * byte for byte. Anything else, near misses included, is kept for a person.
 * With the real markdown adapter, as the sync runs it.
 */
import { describe, expect, it } from 'vitest';
import {
  clearSettledCopies,
  createUnsettledSaid,
  EntryChangedError,
  recordingActivity,
  type NoteContents,
  type UnsettledSaid,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import {
  SHIPPED_PROPERTIES,
  SHIPPED_PROPERTIES_RECORD_PATH,
  shippedPropertiesRecordText,
  type VaultPath,
} from '@dfai/domain';

const LIVE = '.atlas/types/meeting.md';
const COPY = 'Sync conflicts/atlas/types/meeting (conflict from Laptop).md';

const ATTENDEES = [
  '  attendees:',
  '    kind: relation',
  '    label: Attendees',
  '    target: person',
];
const DATE = ['  date:', '    kind: date', '    label: Date'];
const SUMMARY = ['  atlas_summary_of:', '    kind: text', '    label: Summary of'];

const meeting = (
  properties: readonly string[],
  { head = ['name: meeting', 'label: Meeting'], body = '\nA meeting with Mara Quill.\n' } = {},
) => ['---', ...head, 'properties:', ...properties, '---', body].join('\n');

/** The live type: the copy's keys, and the summary key the newer build added. */
const LIVE_TEXT = meeting([...ATTENDEES, ...DATE, ...SUMMARY]);
/** The copy, made before #234: the older build's Meeting, which lacked the summary key. */
const OLD_COPY = meeting([...ATTENDEES, ...DATE]);

const OID = 'a'.repeat(40);

const RECORD_PATH = SHIPPED_PROPERTIES_RECORD_PATH as string;
/** The vault's record: DFAI added the summary key to the Meeting type itself. */
const RECORD = shippedPropertiesRecordText({
  settled: { meeting: ['atlas_summary_of'] },
  added: { meeting: ['atlas_summary_of'] },
});

/** What the host is asked to hold still while it trashes: each file as it was read. */
type Unchanged = readonly { path: VaultPath; modified: number; text: string }[];

/** The vault's files, read and trashed as the host does; `onRead` runs after each read. */
function vault(
  files: Record<string, string>,
  {
    onRead,
    stage = 0,
    record = RECORD,
  }: {
    onRead?: (path: string, reads: number, held: Map<string, NoteContents>) => void;
    /** The index stage every file is listed at: 0, or 1–3 while a merge is in conflict. */
    stage?: number;
    /** The vault's record of the properties DFAI added; null for a vault without one. */
    record?: string | null;
  } = {},
) {
  const all = record === null ? files : { [RECORD_PATH]: record, ...files };
  const held = new Map(Object.entries(all).map(([path, text]) => [path, { text, modified: 1 }]));
  const asked: Unchanged[] = [];
  const trashed: string[] = [];
  const reads = new Map<string, number>();
  const index = () =>
    Object.keys(all)
      .map((path) => `100644 ${OID} ${stage}\t${path}\0`)
      .join('');
  return {
    trashed,
    held,
    asked,
    git: { indexEntries: async () => ({ code: 0, stdout: index(), stderr: '' }) },
    fs: {
      readTextFile: async (path: VaultPath) => {
        const read = held.get(path);
        if (read === undefined) throw new Error(`${path}: no such file`);
        const count = (reads.get(path) ?? 0) + 1;
        reads.set(path, count);
        onRead?.(path, count, held);
        return read;
      },
      // As the host does: nothing moves unless every file named is still as it was read.
      trashEntry: async ({ path, unchanged = [] }: { path: VaultPath; unchanged?: Unchanged }) => {
        asked.push(unchanged);
        for (const file of unchanged) {
          const now = held.get(file.path);
          if (now?.modified !== file.modified || now.text !== file.text) {
            throw new EntryChangedError(`${file.path} changed on disk since it was read`);
          }
        }
        if (!held.delete(path)) throw new Error(`${path}: no such file`);
        trashed.push(path);
      },
    },
  };
}

/** A non-type `.atlas` file and its copy, the copy the live file exactly. */
const nested2 = (path: string) => {
  const text = ['---', `name: ${path}`, 'when:', '  type: task', '---', ''].join('\n');
  return {
    [path]: text,
    [`Sync conflicts/atlas/${path.slice('.atlas/'.length, -'.md'.length)} (conflict from Laptop).md`]:
      text,
  };
};

async function clear(
  world: ReturnType<typeof vault>,
  { keep = new Set<string>(), said }: { keep?: ReadonlySet<string>; said?: UnsettledSaid } = {},
) {
  const activity = recordingActivity();
  const cleared = await clearSettledCopies({
    ports: { git: world.git, fs: world.fs, markdown: remarkMarkdown, activity },
    keep,
    ...(said !== undefined && { said }),
  });
  return { cleared, reports: activity.reports };
}

/** The copy is kept: nothing trashed, nothing said, the live file as it was. */
async function expectKept(files: Record<string, string>, options?: Parameters<typeof vault>[1]) {
  const world = vault(files, options);
  const { cleared, reports } = await clear(world);
  expect(cleared).toEqual([]);
  expect(world.trashed).toEqual([]);
  expect(reports).toEqual([]);
  return world;
}

describe('clearSettledCopies (#235)', () => {
  it('trashes a copy whose every key the live file already holds, and says so with both paths', async () => {
    const world = vault({ [LIVE]: LIVE_TEXT, [COPY]: OLD_COPY });
    const { cleared, reports } = await clear(world);
    expect(cleared).toEqual([COPY]);
    expect(world.trashed).toEqual([COPY]);
    expect(world.held.get(LIVE)?.text).toBe(LIVE_TEXT);
    expect(reports).toEqual([
      {
        level: 'info',
        kind: 'sync',
        message: `Cleared the conflict copy ${COPY}: ${LIVE} already holds everything in it. It is in the Trash.`,
        subject: null,
      },
    ]);
  });

  it('trashes a copy byte for byte the same as its live file', async () => {
    const world = vault({ [LIVE]: LIVE_TEXT, [COPY]: LIVE_TEXT });
    expect((await clear(world)).cleared).toEqual([COPY]);
  });

  it('trashes a numbered copy and a copy from a Mac whose name has brackets', async () => {
    const numbered = 'Sync conflicts/atlas/types/meeting (conflict from Laptop) 2.md';
    const bracketed = 'Sync conflicts/atlas/types/meeting (conflict from Studio (work)).md';
    const world = vault({ [LIVE]: LIVE_TEXT, [numbered]: OLD_COPY, [bracketed]: OLD_COPY });
    expect((await clear(world)).cleared).toEqual([numbered, bracketed]);
  });

  describe('keeps a copy that differs from the live file', () => {
    it('only in whitespace: a trailing space, a blank line, an indent', async () => {
      await expectKept({
        [LIVE]: LIVE_TEXT,
        [COPY]: OLD_COPY.replace('label: Meeting', 'label: Meeting '),
      });
      await expectKept({
        [LIVE]: LIVE_TEXT,
        [COPY]: OLD_COPY.replace('properties:\n', '\nproperties:\n'),
      });
      await expectKept({
        [LIVE]: LIVE_TEXT,
        [COPY]: OLD_COPY.replaceAll('\n    ', '\n      ').replaceAll('\n  ', '\n   '),
      });
    });

    it('only in the order of its keys, or of its properties', async () => {
      await expectKept({
        [LIVE]: LIVE_TEXT,
        [COPY]: meeting([...ATTENDEES, ...DATE], { head: ['label: Meeting', 'name: meeting'] }),
      });
      await expectKept({ [LIVE]: LIVE_TEXT, [COPY]: meeting([...DATE, ...ATTENDEES]) });
    });

    it('in one value', async () => {
      await expectKept({
        [LIVE]: LIVE_TEXT,
        [COPY]: meeting([...ATTENDEES, ...DATE], { head: ['name: meeting', 'label: Meetings'] }),
      });
      await expectKept({
        [LIVE]: LIVE_TEXT,
        [COPY]: meeting([...ATTENDEES, ...DATE.map((line) => line.replace('Date', 'When'))]),
      });
    });

    it('by a key, or a property, the live file lacks', async () => {
      await expectKept({
        [LIVE]: LIVE_TEXT,
        [COPY]: meeting([...ATTENDEES, ...DATE], {
          head: ['name: meeting', 'label: Meeting', 'icon: calendar'],
        }),
      });
      await expectKept({
        [LIVE]: LIVE_TEXT,
        [COPY]: meeting([...ATTENDEES, ...DATE, ...SUMMARY, '  room:', '    kind: text']),
      });
    });

    it('in its body', async () => {
      await expectKept({
        [LIVE]: LIVE_TEXT,
        [COPY]: meeting([...ATTENDEES, ...DATE], { body: '\nA meeting with Tobias Fenn.\n' }),
      });
    });
  });

  describe('keeps a copy when a file cannot be read whole', () => {
    it('the live file is missing, unreadable, or its frontmatter broken', async () => {
      await expectKept({ [COPY]: OLD_COPY });
      await expectKept(
        { [LIVE]: LIVE_TEXT, [COPY]: OLD_COPY },
        {
          onRead: (path) => {
            if (path === LIVE) throw new Error('permission denied');
          },
        },
      );
      await expectKept({
        [LIVE]: LIVE_TEXT.replace('label: Meeting', 'label: [Meeting'),
        [COPY]: OLD_COPY,
      });
      await expectKept({
        [LIVE]: LIVE_TEXT.replace(/---\n\nA meeting/, '\nA meeting'),
        [COPY]: OLD_COPY,
      });
    });

    it('the copy is unreadable, or its frontmatter broken', async () => {
      await expectKept(
        { [LIVE]: LIVE_TEXT, [COPY]: OLD_COPY },
        {
          onRead: (path) => {
            if (path === COPY) throw new Error('not a text file');
          },
        },
      );
      await expectKept({
        [LIVE]: LIVE_TEXT,
        [COPY]: OLD_COPY.replace('label: Meeting', 'label: [Meeting'),
      });
      await expectKept({ [LIVE]: LIVE_TEXT, [COPY]: 'name: meeting\n' });
      await expectKept({ [LIVE]: LIVE_TEXT, [COPY]: '' });
    });
  });

  it('keeps a copy of a copy, even when the first copy holds the same', async () => {
    const copyOfCopy =
      'Sync conflicts/atlas/types/meeting (conflict from Laptop) (conflict from Studio).md';
    await expectKept({ [LIVE]: LIVE_TEXT, [copyOfCopy]: LIVE_TEXT });
    // Beside its first copy, which is cleared on its own merits, it still stays.
    const world = vault({ [LIVE]: LIVE_TEXT, [COPY]: LIVE_TEXT, [copyOfCopy]: LIVE_TEXT });
    expect((await clear(world)).cleared).toEqual([COPY]);
    expect(world.held.has(copyOfCopy)).toBe(true);
  });

  it('keeps a copy that changes while it is checked: its text, or only its time', async () => {
    for (const change of [
      (file: NoteContents) => ({ text: `${file.text}\n`, modified: file.modified }),
      (file: NoteContents) => ({ text: file.text, modified: file.modified + 1 }),
    ]) {
      await expectKept(
        { [LIVE]: LIVE_TEXT, [COPY]: OLD_COPY },
        {
          onRead: (path, reads, held) => {
            if (path === COPY && reads === 1) held.set(COPY, change(held.get(COPY)!));
          },
        },
      );
    }
  });

  it('keeps a copy whose live file is written while it is checked — by sync or by this Mac', async () => {
    for (const written of [
      { text: meeting([...ATTENDEES]), modified: 2 },
      { text: LIVE_TEXT, modified: 2 },
    ]) {
      await expectKept(
        { [LIVE]: LIVE_TEXT, [COPY]: OLD_COPY },
        {
          onRead: (path, reads, held) => {
            if (path === LIVE && reads === 1) held.set(LIVE, written);
          },
        },
      );
    }
  });

  it('keeps a copy this sync made, which Activity is about to tell the person of', async () => {
    const world = vault({ [LIVE]: LIVE_TEXT, [COPY]: OLD_COPY });
    const { cleared } = await clear(world, { keep: new Set([COPY]) });
    expect(cleared).toEqual([]);
    expect(world.trashed).toEqual([]);
  });

  it('leaves alone a copy git still holds in conflict', async () => {
    await expectKept({ [LIVE]: LIVE_TEXT, [COPY]: LIVE_TEXT }, { stage: 2 });
  });

  it('leaves alone a copy of a note, however alike the two are', async () => {
    await expectKept({
      'Notes/Plan.md': 'Plan\n',
      'Notes/Plan (conflict from Laptop).md': 'Plan\n',
    });
  });

  it('merges the record of shipped properties as the sync does: a subset goes, a key more stays', async () => {
    // Keys DFAI ships on Meeting: a record lacking one of them adds nothing (#235).
    const [first = '', second = ''] = SHIPPED_PROPERTIES.get('meeting')!.map(({ key }) => key);
    const copy = 'Sync conflicts/atlas/migrations/type-properties (conflict from Laptop).md';
    const record = (keys: string[]) =>
      shippedPropertiesRecordText({ settled: { meeting: keys }, added: {} });
    const cleared = vault({ [copy]: record([first]) }, { record: record([first, second]) });
    expect((await clear(cleared)).cleared).toEqual([copy]);
    await expectKept({ [copy]: record([first, second]) }, { record: record([first]) });
  });

  it('keeps a record copy that lacks a key DFAI does not ship on that type: a person took it off', async () => {
    const [first = ''] = SHIPPED_PROPERTIES.get('meeting')!.map(({ key }) => key);
    const copy = 'Sync conflicts/atlas/migrations/type-properties (conflict from Laptop).md';
    const record = (keys: string[]) =>
      shippedPropertiesRecordText({ settled: { meeting: keys }, added: {} });
    await expectKept({ [copy]: record([first]) }, { record: record([first, 'venue']) });
  });

  describe('keeps a copy that lacks something DFAI did not write into the live file (#235)', () => {
    const P = ['  p:', '    kind: text'];

    it('before #234: a property taken off on the copy’s Mac while this one gained a shipped one', async () => {
      // Mac B took `p` off; Mac A's newer build added the summary key; the copy is B's.
      await expectKept({
        [LIVE]: meeting([...ATTENDEES, ...DATE, ...P, ...SUMMARY]),
        [COPY]: meeting([...ATTENDEES, ...DATE]),
      });
    });

    it('a copy trimmed by hand of a property, or of a top-level key', async () => {
      await expectKept({ [LIVE]: LIVE_TEXT, [COPY]: meeting([...ATTENDEES, ...SUMMARY]) });
      await expectKept({
        [LIVE]: meeting([...ATTENDEES, ...DATE, ...SUMMARY], {
          head: ['name: meeting', 'label: Meeting', 'icon: calendar'],
        }),
        [COPY]: meeting([...ATTENDEES, ...DATE, ...SUMMARY]),
      });
    });

    it('a shipped property the record does not say DFAI added, or a vault with no record or a broken one', async () => {
      const settledOnly = shippedPropertiesRecordText({
        settled: { meeting: ['atlas_summary_of'] },
        added: {},
      });
      await expectKept({ [LIVE]: LIVE_TEXT, [COPY]: OLD_COPY }, { record: settledOnly });
      await expectKept({ [LIVE]: LIVE_TEXT, [COPY]: OLD_COPY }, { record: null });
      await expectKept({ [LIVE]: LIVE_TEXT, [COPY]: OLD_COPY }, { record: 'not a record\n' });
    });

    it('a property DFAI added to another type', async () => {
      const otherType = shippedPropertiesRecordText({
        settled: { daily: ['atlas_summary_of'] },
        added: { daily: ['atlas_summary_of'] },
      });
      await expectKept({ [LIVE]: LIVE_TEXT, [COPY]: OLD_COPY }, { record: otherType });
    });

    // Verification review of PR #599: a key the copy lacks one map down was missed.
    const nested = (path: string, live: string[], copy: string[]) => ({
      [path]: ['---', ...live, '---', ''].join('\n'),
      [`Sync conflicts/atlas/${path.slice('.atlas/'.length, -'.md'.length)} (conflict from Laptop).md`]:
        ['---', ...copy, '---', ''].join('\n'),
    });

    it('a key one map down in an automation, a view or the settings', async () => {
      await expectKept(
        nested(
          '.atlas/automations/weekly.md',
          ['name: weekly', 'when:', '  type: task', '  status: done'],
          ['name: weekly', 'when:', '  type: task'],
        ),
      );
      await expectKept(
        nested(
          '.atlas/views/Board.md',
          ['name: Board', 'filters:', '  status: next', '  owner: me'],
          ['name: Board', 'filters:', '  status: next'],
        ),
      );
      await expectKept(
        nested(
          '.atlas/settings.md',
          ['sync:', '  auto: true', '  every: 5'],
          ['sync:', '  auto: true'],
        ),
      );
    });

    it('a key in a type’s map other than its properties', async () => {
      await expectKept({
        [LIVE]: meeting([...ATTENDEES, ...DATE, ...SUMMARY], {
          head: [
            'name: meeting',
            'label: Meeting',
            'display:',
            '  icon: calendar',
            '  color: blue',
          ],
        }),
        [COPY]: meeting([...ATTENDEES, ...DATE], {
          head: ['name: meeting', 'label: Meeting', 'display:', '  icon: calendar'],
        }),
      });
    });

    it('a view, the settings or an automation that is not its live file exactly', async () => {
      await expectKept(
        nested('.atlas/views/Board.md', ['name: Board', 'limit: 5'], ['name: Board']),
      );
    });
  });

  it('clears a view, the settings or an automation whose copy is its live file exactly', async () => {
    const world = vault(
      Object.fromEntries(
        ['.atlas/views/Board.md', '.atlas/settings.md', '.atlas/automations/weekly.md'].flatMap(
          (path) => Object.entries(nested2(path)),
        ),
      ),
    );
    expect((await clear(world)).cleared).toHaveLength(3);
  });

  it('finds what DFAI added to a type whose name is written with capitals or spaces', async () => {
    for (const name of ['Meeting', ' meeting', 'MEETING ']) {
      const head = [`name: "${name}"`, 'label: Meeting'];
      const world = vault({
        [LIVE]: meeting([...ATTENDEES, ...DATE, ...SUMMARY], { head }),
        [COPY]: meeting([...ATTENDEES, ...DATE], { head }),
      });
      expect((await clear(world)).cleared, name).toEqual([COPY]);
    }
  });

  it('keeps a record copy whose JSON is broken past the block that parses, and never throws', async () => {
    const copy = 'Sync conflicts/atlas/migrations/type-properties (conflict from Laptop).md';
    const good = shippedPropertiesRecordText({ settled: {}, added: {} });
    const json = JSON.stringify({ settled: {}, added: {} });
    expect(good).toContain(json);
    // Block 1 parses, over two lines; block 2, on one line, is cut short.
    const broken = good.replace(json, '{"settled":\n{}}\n```\n\n```json\n{"a');
    await expectKept({ [copy]: broken }, { record: broken });
    await expectKept({ [copy]: broken });
  });

  it('asks the host to trash the copy only while it and its live file are as they were read', async () => {
    const world = vault({ [LIVE]: LIVE_TEXT, [COPY]: OLD_COPY });
    await clear(world);
    expect(world.asked).toEqual([
      [
        { path: COPY, modified: 1, text: OLD_COPY },
        { path: LIVE, modified: 1, text: LIVE_TEXT },
      ],
    ]);
  });

  it('keeps a copy the host finds changed as it trashes, and says so', async () => {
    const world = vault({ [LIVE]: LIVE_TEXT, [COPY]: OLD_COPY });
    const trash = world.fs.trashEntry;
    // A save lands between the last read and the Trash: the host refuses.
    world.fs.trashEntry = async (args) => {
      world.held.set(COPY, { text: OLD_COPY, modified: world.held.get(COPY)!.modified + 1 });
      await trash(args);
    };
    const said = createUnsettledSaid();
    const first = await clear(world, { said });
    expect(first.cleared).toEqual([]);
    expect(world.held.has(COPY)).toBe(true);
    expect(first.reports.map(({ level, message }) => ({ level, message }))).toEqual([
      {
        level: 'info',
        message: `The conflict copy ${COPY} was kept: it or ${LIVE} changed while it was checked.`,
      },
    ]);
  });

  it('says a Trash that keeps refusing a copy once, and again only when the copy changes', async () => {
    const world = vault({ [LIVE]: LIVE_TEXT, [COPY]: OLD_COPY });
    world.fs.trashEntry = async () => {
      throw new Error('the Trash is not available');
    };
    const said = createUnsettledSaid();
    expect((await clear(world, { said })).reports).toHaveLength(1);
    expect((await clear(world, { said })).reports).toEqual([]);
    world.held.set(COPY, { text: OLD_COPY, modified: 5 });
    expect((await clear(world, { said })).reports).toHaveLength(1);
    expect((await clear(world, { said })).reports).toEqual([]);
  });

  it('says a copy the Trash refused, keeps it, and goes on to the next', async () => {
    const other = 'Sync conflicts/atlas/types/meeting (conflict from Laptop) 2.md';
    const world = vault({ [LIVE]: LIVE_TEXT, [COPY]: OLD_COPY, [other]: OLD_COPY });
    const trash = world.fs.trashEntry;
    world.fs.trashEntry = async (args) => {
      if (args.path === COPY) throw new Error('the Trash is not available');
      await trash(args);
    };
    const { cleared, reports } = await clear(world);
    expect(cleared).toEqual([other]);
    expect(world.held.has(COPY)).toBe(true);
    expect(reports.map(({ level, message }) => ({ level, message }))).toEqual([
      {
        level: 'warning',
        message: `The conflict copy ${COPY} holds nothing ${LIVE} lacks, but it could not be moved to the Trash: the Trash is not available`,
      },
      {
        level: 'info',
        message: `Cleared the conflict copy ${other}: ${LIVE} already holds everything in it. It is in the Trash.`,
      },
    ]);
  });
});
