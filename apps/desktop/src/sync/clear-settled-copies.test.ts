/**
 * #235: a conflict copy of one of DFAI's own files, under `Sync conflicts/atlas/`,
 * goes to the Trash when its live file already holds everything in it — the
 * live file's own merge with the copy (`mergeSettings`, no base) gives it back
 * byte for byte. Anything else, near misses included, is kept for a person.
 * With the real markdown adapter, as the sync runs it.
 */
import { describe, expect, it } from 'vitest';
import { clearSettledCopies, recordingActivity, type NoteContents } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { shippedPropertiesRecordText, type VaultPath } from '@dfai/domain';

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

/** The vault's files, read and trashed as the host does; `onRead` runs after each read. */
function vault(
  files: Record<string, string>,
  {
    onRead,
    stage = 0,
  }: {
    onRead?: (path: string, reads: number, held: Map<string, NoteContents>) => void;
    /** The index stage every file is listed at: 0, or 1–3 while a merge is in conflict. */
    stage?: number;
  } = {},
) {
  const held = new Map(Object.entries(files).map(([path, text]) => [path, { text, modified: 1 }]));
  const trashed: string[] = [];
  const reads = new Map<string, number>();
  const index = () =>
    Object.keys(files)
      .map((path) => `100644 ${OID} ${stage}\t${path}\0`)
      .join('');
  return {
    trashed,
    held,
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
      trashEntry: async ({ path }: { path: VaultPath }) => {
        if (!held.delete(path)) throw new Error(`${path}: no such file`);
        trashed.push(path);
      },
    },
  };
}

async function clear(
  world: ReturnType<typeof vault>,
  { keep = new Set<string>() }: { keep?: ReadonlySet<string> } = {},
) {
  const activity = recordingActivity();
  const cleared = await clearSettledCopies({
    ports: { git: world.git, fs: world.fs, markdown: remarkMarkdown, activity },
    keep,
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
    const live = '.atlas/migrations/type-properties.md';
    const copy = 'Sync conflicts/atlas/migrations/type-properties (conflict from Laptop).md';
    const record = (keys: string[]) =>
      shippedPropertiesRecordText({ settled: { meeting: keys }, added: {} });
    const cleared = vault({ [live]: record(['date', 'summary']), [copy]: record(['date']) });
    expect((await clear(cleared)).cleared).toEqual([copy]);
    await expectKept({ [live]: record(['date']), [copy]: record(['date', 'summary']) });
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
