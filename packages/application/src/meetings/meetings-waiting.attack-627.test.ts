import { describe, expect, it } from 'vitest';
import {
  conflictCopyPath,
  digestOf,
  type CountableStanding,
  type MeetingsWaiting,
  type NoteChange,
  type VaultPath,
  type WaitingCountGate,
} from '@dfai/domain';
import { automationVault, jsonNote } from '../testing/automation-vault.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { MEETING_HEADER, meetingFile } from '../testing/meeting-files.ts';
import { createWaitingCounter, type MeetingsWaitingWatch } from './meetings-waiting.ts';
import { WAITING_READS_AT_ONCE } from './waiting-meeting-files.ts';

/**
 * Attack on PR #627 (#175): the count of meetings waiting for the named Mac,
 * against an oracle written from #175's rules, over seeded vaults; the gates
 * moving while it reads; and what it costs the host.
 */

const VAULT = '/Users/j/Vault';
const TODAY = '2026-10-08';
const DAY_MS = 24 * 60 * 60 * 1000;
/** A pull that finished an hour after every note's noon. */
const PULL: CountableStanding = {
  kind: 'pulled',
  startedAsleepMs: 0,
  finishedAt: Date.parse(`${TODAY}T13:00:00Z`),
  namedAfter: false,
};
const LATER_PULL: CountableStanding = { ...PULL, finishedAt: PULL.finishedAt + 2 * DAY_MS };

/** mulberry32: the same seed, the same run. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: () => number, from: readonly T[]): T =>
  from[Math.floor(rng() * from.length)]!;

/** What one generated file is, as the oracle knows it. */
type Content =
  | 'unstamped-declared'
  | 'unstamped-undeclared'
  | 'stamped-imported'
  | 'stamped-duplicate'
  | 'stamped-error'
  | 'stamped-unknown'
  | 'stamp-empty-list'
  | 'bad-frontmatter'
  | 'task-note'
  | 'unreadable'
  | 'gone-before-read';

const CONTENTS: readonly Content[] = [
  'unstamped-declared',
  'unstamped-undeclared',
  'stamped-imported',
  'stamped-duplicate',
  'stamped-error',
  'stamped-unknown',
  'stamp-empty-list',
  'bad-frontmatter',
  'task-note',
  'unreadable',
  'gone-before-read',
];

function textOf(content: Content, at: number): string {
  const header = { ...MEETING_HEADER, external_id: `gemini-${at}` };
  const undeclared = Object.fromEntries(
    Object.entries(header).filter(([key]) => key !== 'atlas_import'),
  );
  switch (content) {
    case 'unstamped-declared':
    case 'unreadable':
    case 'gone-before-read':
      return meetingFile(header);
    case 'unstamped-undeclared':
      return meetingFile(undeclared);
    case 'stamped-imported':
      return meetingFile({ ...header, atlas_import_outcome: 'imported' });
    case 'stamped-duplicate':
      return meetingFile({ ...header, atlas_import_outcome: ['duplicate'] });
    case 'stamped-error':
      return meetingFile({ ...header, atlas_import_outcome: ' error ' });
    case 'stamped-unknown':
      return meetingFile({ ...header, atlas_import_outcome: 'settled-somehow' });
    case 'stamp-empty-list':
      return meetingFile({ ...header, atlas_import_outcome: [] });
    case 'bad-frontmatter':
      return '---\n{"type": "meeting",\n---\nNotes.\n';
    case 'task-note':
      return jsonNote({ type: 'task' });
  }
}

/** A folder, how the disk spells it in this vault, and whether #175 / #214 make it a landing place. */
interface Folder {
  readonly path: string;
  /** Every file here is an arrival (`Inbox/Meetings`), only declared ones are (a month folder), or none is. */
  readonly kind: 'inbox' | 'month' | 'none';
}

function foldersFor(rng: () => number): Folder[] {
  const inbox = pick(rng, ['Inbox/Meetings', 'inbox/meetings', 'INBOX/Meetings', 'Inbox/MEETINGS']);
  const home = pick(rng, ['Meetings', 'meetings', 'MEETINGS']);
  return [
    { path: inbox, kind: 'inbox' },
    { path: `${inbox}/2026/10`, kind: 'inbox' },
    { path: `${inbox}/deep/er/still`, kind: 'inbox' },
    { path: `${inbox}/.hidden`, kind: 'none' },
    { path: `${home}/2026/10`, kind: 'month' },
    { path: `${home}/2025/01`, kind: 'month' },
    { path: `${home}/2026/10/nested`, kind: 'month' },
    { path: `${home}/2026/1`, kind: 'none' },
    { path: `${home}/From Notion`, kind: 'none' },
    { path: home, kind: 'none' },
    { path: 'Archive/Inbox/Meetings', kind: 'none' },
    // The Inbox itself, spelt as the disk spells it on the way to its Meetings: one folder on APFS.
    { path: inbox.split('/')[0]!, kind: 'none' },
    { path: 'Projects/Meetings/2026/10', kind: 'none' },
  ];
}

/** Mac names a conflict copy is made with that the name pattern can read back. */
const SAFE_MACS = ['Studio', 'Mac/Studio', 'Tobias: mini', '   ', 'x'.repeat(60), 'Café Mac'];

/** A file's name: a meeting's, an NFD one, odd extensions, link-like names, or a conflict copy of any form. */
function nameFor(rng: () => number, folder: string, at: number, taken: Set<string>) {
  const stem = pick(rng, [
    `2026-10-0${1 + (at % 9)} Standup ${at}`,
    `Café sync ${at}`.normalize('NFD'),
    `Ünïcødé ${at}`,
    `${at} -> target`,
    `Standup ${at}.md`,
    `${'Long name '.repeat(20)}${at}`,
  ]);
  const extension = pick(rng, ['.md', '.md', '.markdown', '.MD', '.txt', '.md.lnk']);
  const plain = `${folder}/${stem}${extension}`;
  const conflict = rng() < 0.3;
  if (!conflict) return { path: plain, conflict: false };
  const mac = pick(rng, SAFE_MACS);
  const copy = conflictCopyPath({ path: plain, mac, taken });
  taken.add(copy);
  // A numbered one too, now and then: the name is taken.
  const numbered = rng() < 0.3 ? conflictCopyPath({ path: plain, mac, taken }) : copy;
  taken.add(numbered);
  return { path: numbered, conflict: true };
}

interface Generated {
  readonly notes: Record<string, string>;
  readonly ageDays: Record<string, number>;
  readonly unreadable: ReadonlySet<string>;
  readonly gone: ReadonlySet<string>;
  readonly expected: { count: number; deferred: number };
}

/** The oracle, from #175: an unstamped, readable, non-conflict arrival, changed here before the pull. */
function generate(seed: number): Generated {
  const rng = seeded(seed);
  const notes: Record<string, string> = {};
  const ageDays: Record<string, number> = {};
  const unreadable = new Set<string>();
  const gone = new Set<string>();
  const taken = new Set<string>();
  let count = 0;
  let deferred = 0;
  const folders = foldersFor(rng);
  const files = 1 + Math.floor(rng() * 40);
  for (let at = 0; at < files; at += 1) {
    const folder = pick(rng, folders);
    const { path, conflict } = nameFor(rng, folder.path, at, taken);
    if (path in notes) continue;
    const content = pick(rng, CONTENTS);
    notes[path] = textOf(content, at);
    // Now and then, changed here after the pull: tomorrow at noon.
    const changedAfterPull = rng() < 0.2;
    ageDays[path] = changedAfterPull ? -1 : Math.floor(rng() * 300);
    if (content === 'unreadable') unreadable.add(path);
    if (content === 'gone-before-read') gone.add(path);
    const markdown = /\.(md|markdown)$/i.test(path);
    const hidden = path.split('/').some((name) => name.startsWith('.'));
    const landing = folder.kind !== 'none' && markdown && !hidden;
    const declared = !['unstamped-undeclared', 'task-note', 'bad-frontmatter'].includes(content);
    const arrival = landing && (folder.kind === 'inbox' || declared);
    const readable = !['unreadable', 'gone-before-read', 'bad-frontmatter'].includes(content);
    const unstamped = [
      'unstamped-declared',
      'unstamped-undeclared',
      'stamp-empty-list',
      'task-note',
    ].includes(content);
    if (!arrival || conflict || !readable || !unstamped) continue;
    if (changedAfterPull) deferred += 1;
    else count += 1;
  }
  return { notes, ageDays, unreadable, gone, expected: { count, deferred } };
}

interface Host {
  listings: number;
  reads: string[];
  inFlight: number;
  mostInFlight: number;
}

/** A counter over a vault held in memory, with every host call it makes counted. */
function counterOver({
  notes,
  ageDays = {},
  unreadable = new Set<string>(),
  gone = new Set<string>(),
  gate = { open: true, standing: PULL } as WaitingCountGate,
  named = { name: 'Studio' } as { name: string | null } | null,
}: {
  notes: Record<string, string>;
  ageDays?: Record<string, number>;
  unreadable?: ReadonlySet<string>;
  gone?: ReadonlySet<string>;
  gate?: WaitingCountGate;
  named?: { name: string | null } | null;
}) {
  const vault = automationVault({ notes, today: TODAY, ageDays });
  const host: Host = { listings: 0, reads: [], inFlight: 0, mostInFlight: 0 };
  const state = {
    gate,
    named,
    gateCalls: 0,
    /** Awaited as each file is read, before it answers. */
    onRead: (async () => undefined) as (path: string) => Promise<void>,
    /** Files saved here since, by when: what the host's \`modified\` says of them. */
    editedHere: new Map<string, number>(),
  };
  const fs = {
    ...vault.ports.fs,
    listDirectory: async (path: VaultPath) => {
      host.listings += 1;
      return vault.ports.fs.listDirectory(path);
    },
    readTextFile: async (path: VaultPath) => {
      host.reads.push(path);
      host.inFlight += 1;
      host.mostInFlight = Math.max(host.mostInFlight, host.inFlight);
      try {
        await state.onRead(path);
        if (unreadable.has(path)) throw new Error('permission denied');
        if (gone.has(path)) vault.files.delete(path);
        const read = await vault.ports.fs.readTextFile(path);
        return { ...read, modified: state.editedHere.get(path) ?? read.modified };
      } finally {
        host.inFlight -= 1;
      }
    },
  };
  const activity = recordingActivity();
  const said: (MeetingsWaiting | null)[] = [];
  const watch: MeetingsWaitingWatch = {
    namedElsewhere: () => state.named,
    countGate: async () => {
      state.gateCalls += 1;
      return state.gate;
    },
    said: (_, waiting) => void said.push(waiting),
  };
  const counter = createWaitingCounter(watch);
  const run = { ports: { fs, markdown: vault.ports.markdown }, activity };
  const judge = () => counter.judge(VAULT, run);
  const warnings = () =>
    activity.reports.filter((report) => report.level === 'warning').map((report) => report.message);
  const heard = (path: string, kind: NoteChange['kind'] = 'changed') =>
    counter.heard(VAULT, [{ kind, path, type: 'meeting', digest: digestOf(path) } as NoteChange]);
  return { vault, host, state, said, counter, judge, warnings, heard };
}

describe('the waiting count against #175 (attack on PR #627)', () => {
  it('counts what the oracle counts, over 300 seeded vaults', async () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const generated = generate(seed);
      const { judge } = counterOver(generated);

      const waiting = await judge();

      const expected = generated.expected.count;
      const got = waiting?.kind === 'counted' ? waiting.count : null;
      expect({ seed, count: got }).toEqual({ seed, count: expected });
    }
  });

  it('counts a deferred file once a later pull lets it be judged', async () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const generated = generate(seed);
      const { judge, state } = counterOver(generated);
      await judge();

      state.gate = { open: true, standing: LATER_PULL };
      const waiting = await judge();

      const { count, deferred } = generated.expected;
      expect({ seed, waiting }).toEqual({
        seed,
        waiting: { kind: 'counted', mac: 'Studio', count: count + deferred },
      });
    }
  });

  it('never counts a conflict copy, whatever the other Mac is called', async () => {
    // macOS names a second Mac of the same name "… (2)"; the copy carries that name.
    const original = 'Inbox/Meetings/2026-10-06 Standup.md';
    const copy = conflictCopyPath({
      path: original,
      mac: "Mara's MacBook Pro (2)",
      taken: new Set([original]),
    });
    const { judge } = counterOver({
      notes: {
        [original]: meetingFile({ ...MEETING_HEADER, atlas_import_outcome: 'imported' }),
        [copy]: meetingFile(),
      },
    });

    const waiting = await judge();

    // The copy is the person's to merge; a claim never clears it (#175). None waits, so
    // the Inbox shows no line (`meetingsWaitingLine` of a count of 0 is null), and the
    // count is 0 as the oracle above has it.
    expect(waiting).toEqual({ kind: 'counted', mac: 'Studio', count: 0 });
  });
});

describe('the waiting count as the gates move (attack on PR #627)', () => {
  it('says no count once the settings stop naming another Mac while the files are read', async () => {
    const { judge, state, said } = counterOver({
      notes: { 'Inbox/Meetings/2026-10-06 Standup.md': meetingFile() },
    });
    // The settings note is edited here, mid-read, so it no longer reads: nothing names another Mac.
    state.onRead = async () => {
      state.named = null;
    };

    await judge();

    // On a Mac whose settings name no other, the Inbox says nothing waits (#175: shown only on a Mac not named).
    expect(said.at(-1) ?? null).toBe(null);
  });

  it('drops a count the next pull started under, with no warning', async () => {
    const { judge, state, warnings, said } = counterOver({
      notes: { 'Inbox/Meetings/2026-10-06 Standup.md': meetingFile() },
    });
    state.onRead = async () => {
      state.gate = { open: false, why: 'pulling' };
    };

    await judge();

    expect({ said, warnings: warnings() }).toEqual({ said: [], warnings: [] });
  });

  it('says no count that resolves after another vault opened', async () => {
    const { judge, state, warnings, said } = counterOver({
      notes: { 'Inbox/Meetings/2026-10-06 Standup.md': meetingFile() },
    });
    // Another vault opens while the files are read: the gate forgets this vault's pull.
    state.onRead = async () => {
      state.gate = { open: false, why: 'no-pull' };
    };

    await judge();

    expect({ said, warnings: warnings() }).toEqual({ said: [], warnings: [] });
  });

  it('warns no new count when a meeting waiting is edited here and no pull has run', async () => {
    const waitingFiles = {
      'Inbox/Meetings/2026-10-06 Standup.md': meetingFile(),
      'Inbox/Meetings/2026-10-07 Platform sync.md': meetingFile({
        ...MEETING_HEADER,
        external_id: 'b',
      }),
      'Inbox/Meetings/2026-10-08 Retro.md': meetingFile({ ...MEETING_HEADER, external_id: 'c' }),
    };
    const { judge, state, warnings, heard } = counterOver({ notes: waitingFiles });
    await judge();
    // The person adds a line to one of them here: it changed after the pull, so it is left for the next.
    state.editedHere.set('Inbox/Meetings/2026-10-06 Standup.md', PULL.finishedAt + 60_000);
    heard('Inbox/Meetings/2026-10-06 Standup.md');
    await judge();
    // The next look counts it again.
    state.gate = { open: true, standing: LATER_PULL };
    await judge();

    // Nothing was imported or arrived: three waited throughout, so Activity says so once.
    expect(warnings()).toEqual(['3 meetings are waiting for Studio to process them.']);
  });
});

describe('what the waiting count costs the host (attack on PR #627)', () => {
  /** A Meetings history of `size` stamped files over many months, and two waiting. */
  function history(size: number): Record<string, string> {
    const notes: Record<string, string> = {};
    for (let at = 0; at < size; at += 1) {
      const month = String(1 + (at % 12)).padStart(2, '0');
      const year = 2020 + Math.floor(at / 1200);
      notes[`Meetings/${year}/${month}/Call ${at}.md`] = meetingFile({
        ...MEETING_HEADER,
        external_id: `gemini-${at}`,
        atlas_import_outcome: 'imported',
      });
    }
    notes['Inbox/Meetings/2026-10-06 Standup.md'] = meetingFile();
    notes['Inbox/Meetings/2026-10-07 Platform sync.md'] = meetingFile({
      ...MEETING_HEADER,
      external_id: 'b',
    });
    return notes;
  }

  it(`reads at most ${WAITING_READS_AT_ONCE} files at once, however slow each read`, async () => {
    const { judge, state, host } = counterOver({ notes: history(200) });
    state.onRead = () => new Promise((resolve) => setTimeout(resolve, 0));

    await judge();

    expect(host.mostInFlight).toBe(WAITING_READS_AT_ONCE);
  });

  it('makes no host call in a vault that does not sync', async () => {
    const { judge, host } = counterOver({
      notes: history(50),
      gate: { open: false, why: 'not-synced' },
    });

    await judge();

    expect({ listings: host.listings, reads: host.reads.length }).toEqual({
      listings: 0,
      reads: 0,
    });
  });

  it('makes no host call on the named Mac', async () => {
    const { judge, host, heard, said } = counterOver({ notes: history(50), named: null });

    heard('Inbox/Meetings/2026-10-06 Standup.md');
    await judge();

    expect({ listings: host.listings, reads: host.reads.length, said }).toEqual({
      listings: 0,
      reads: 0,
      said: [null],
    });
  });

  it('a look that brought nothing lists and reads nothing', async () => {
    const { judge, state, host } = counterOver({ notes: history(1000) });
    await judge();
    const before = { listings: host.listings, reads: host.reads.length };

    state.gate = { open: true, standing: { ...PULL, finishedAt: PULL.finishedAt + 60_000 } };
    await judge();

    expect({ listings: host.listings, reads: host.reads.length }).toEqual(before);
  });

  it('news of one meeting file on a 10k history reads only what the news names', async () => {
    const { judge, host, heard } = counterOver({ notes: history(10_000) });
    await judge();
    const readsBefore = host.reads.length;

    heard('Inbox/Meetings/2026-10-06 Standup.md');
    await judge();

    // The other 10,001 files did not change; what each holds is already known.
    expect(host.reads.length - readsBefore).toBeLessThanOrEqual(1);
  }, 60_000);
});
