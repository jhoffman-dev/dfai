import { describe, expect, it, vi } from 'vitest';
import {
  createVaultPath,
  digestOf,
  type CountableStanding,
  type MeetingsWaiting,
  type VaultPath,
  type WaitingCountGate,
} from '@dfai/domain';
import { automationVault, jsonNote } from '../testing/automation-vault.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { MEETING_HEADER, meetingFile } from '../testing/meeting-files.ts';
import { createMeetingImporter } from './meeting-importer.ts';
import type { MeetingsWaitingWatch } from './meetings-waiting.ts';

/**
 * ADR-0035 parts 1 and 3 (#175): on a Mac that is not named, the importer
 * does not drop what it hears without a word. It counts the meetings waiting
 * for the named Mac and says so — on the Inbox, and in Activity once per pull.
 */

const VAULT = '/Users/j/Vault';
const TODAY = '2026-10-08';
const UNSTAMPED = 'Inbox/Meetings/2026-10-06 Standup.md';
const SECOND = 'Inbox/Meetings/2026-10-07 Platform sync.md';
const STAMPED = 'Inbox/Meetings/2026-10-05 Vendor call.md';
const CONFLICT = 'Inbox/Meetings/2026-10-06 Standup (conflict from Studio).md';
const UNREADABLE = 'Inbox/Meetings/2026-10-04 Quarterly review.md';
const BAD_FRONTMATTER = 'Inbox/Meetings/2026-10-03 Retro.md';

const pulledAt = (finishedAt: number): CountableStanding => ({
  kind: 'pulled',
  startedAsleepMs: 0,
  finishedAt,
  namedAfter: false,
});
/** A pull that finished an hour after every note's noon. */
const PULL = pulledAt(Date.parse(`${TODAY}T13:00:00Z`));

const MIXED: Record<string, string> = {
  [UNSTAMPED]: meetingFile(),
  [SECOND]: meetingFile({ ...MEETING_HEADER, external_id: 'gemini-11aa22bb' }),
  [STAMPED]: meetingFile({ ...MEETING_HEADER, atlas_import_outcome: 'imported' }),
  [CONFLICT]: meetingFile(),
  [UNREADABLE]: meetingFile(),
  [BAD_FRONTMATTER]: '---\n{"type": "meeting",\n---\nNotes.\n',
  'Inbox/Call Mara.md': jsonNote({ type: 'task' }),
};

function setUp({
  notes = MIXED,
  named = { name: 'Studio' } as { name: string | null } | null,
  gate = { open: true, standing: PULL } as WaitingCountGate,
  watching = true,
} = {}) {
  const vault = automationVault({ notes, today: TODAY });
  const reads: string[] = [];
  const ports = {
    ...vault.ports,
    fs: {
      ...vault.ports.fs,
      readTextFile: async (path: VaultPath) => {
        reads.push(path);
        await state.onRead(path);
        if (path === UNREADABLE) throw new Error('permission denied');
        return vault.ports.fs.readTextFile(path);
      },
    },
  };
  const activity = recordingActivity();
  const state = {
    named,
    gate,
    active: false,
    gateCalls: 0,
    /** Awaited as each file is read, before it answers: what happens while the count reads. */
    onRead: async (_path: string): Promise<void> => undefined,
  };
  const said: (MeetingsWaiting | null)[] = [];
  const watch: MeetingsWaitingWatch = {
    namedElsewhere: () => state.named,
    countGate: async () => {
      state.gateCalls += 1;
      return state.gate;
    },
    said: (_, waiting) => void said.push(waiting),
  };
  const importer = createMeetingImporter({
    ports: () => ports,
    clock: { today: () => TODAY },
    activity,
    openVault: () => VAULT,
    active: () => state.active,
    onWritten: vi.fn(),
    ...(watching && { waiting: watch }),
  });
  const warnings = () =>
    activity.reports.filter((report) => report.level === 'warning').map((report) => report.message);
  /** The index hears of one note changing, as after a save or a pull. */
  const hearOf = (path: string) =>
    importer.hear({
      vault: VAULT,
      changes: [{ kind: 'changed', path, type: 'meeting', digest: digestOf(path) }],
    });
  return { vault, importer, state, said, warnings, reads, hearOf };
}

describe('createMeetingImporter on a Mac that is not named (ADR-0035 parts 1 and 3)', () => {
  it('counts the unstamped meetings alone, and reports instead of dropping', async () => {
    const { importer, warnings, said, vault } = setUp();

    const outcome = await importer.catchUp(VAULT);

    const waiting = { kind: 'counted', mac: 'Studio', count: 2 };
    expect(outcome).toEqual({ happenings: [], wrote: false, waiting });
    expect(warnings()).toEqual(['2 meetings are waiting for Studio to process them.']);
    expect(said).toEqual([waiting]);
    // It imports nothing: no file is written.
    expect(vault.files.get(UNSTAMPED)).toBe(meetingFile());
  });

  it('news of a note outside where meetings land asks nothing: no gate, no read, no line', async () => {
    const { importer, state, reads, hearOf, said } = setUp();
    await importer.catchUp(VAULT);
    const before = { gateCalls: state.gateCalls, reads: reads.length, said: said.length };

    await hearOf('Inbox/Call Mara.md');

    expect(state.gateCalls).toBe(before.gateCalls);
    expect(reads).toHaveLength(before.reads);
    expect(said).toHaveLength(before.said);
  });

  it('a later pull that brought no meeting reads nothing again and warns of nothing (#627 review)', async () => {
    const { importer, warnings, reads, state, said } = setUp();
    await importer.catchUp(VAULT);
    const readsAfterFirst = reads.length;
    expect(readsAfterFirst).toBeGreaterThan(0);

    // A look at GitHub that finds nothing new completes a pull, about once a minute.
    for (let minute = 1; minute <= 3; minute += 1) {
      state.gate = { open: true, standing: pulledAt(PULL.finishedAt + minute * 60_000) };
      await importer.catchUp(VAULT);
    }

    expect(warnings()).toHaveLength(1);
    expect(reads).toHaveLength(readsAfterFirst);
    expect(said.at(-1)).toEqual({ kind: 'counted', mac: 'Studio', count: 2 });
  });

  it('counts again when news names a meeting file, and warns only if the count changed', async () => {
    const { importer, warnings, reads, vault, hearOf } = setUp();
    await importer.catchUp(VAULT);
    const readsAfterFirst = reads.length;

    // A meeting file edited: read again, the same count, so no warning.
    await hearOf(UNSTAMPED);
    expect(reads.length).toBeGreaterThan(readsAfterFirst);
    expect(warnings()).toHaveLength(1);

    // A third meeting arrives: the count changes, and that is warned of.
    const THIRD = 'Inbox/Meetings/2026-10-08 Retro two.md';
    vault.files.set(THIRD, meetingFile({ ...MEETING_HEADER, external_id: 'gemini-33cc44dd' }));
    expect((await hearOf(THIRD))?.waiting).toMatchObject({ count: 3 });
    expect(warnings()).toEqual([
      '2 meetings are waiting for Studio to process them.',
      '3 meetings are waiting for Studio to process them.',
    ]);
  });

  it('counts at the next pull a meeting it left for it (changed here after the last pull)', async () => {
    const { importer, state } = setUp({
      notes: { [UNSTAMPED]: meetingFile() },
      gate: { open: true, standing: pulledAt(0) },
    });
    expect((await importer.catchUp(VAULT))?.waiting).toMatchObject({ count: 0 });

    state.gate = { open: true, standing: PULL };
    expect((await importer.catchUp(VAULT))?.waiting).toMatchObject({ count: 1 });
  });

  it('counts again when the gates open after being shut, though the pull is the same', async () => {
    const { importer, state, reads } = setUp();
    await importer.catchUp(VAULT);
    const readsAfterFirst = reads.length;

    state.gate = { open: false, why: 'paused' };
    await importer.catchUp(VAULT);
    state.gate = { open: true, standing: PULL };
    await importer.catchUp(VAULT);

    expect(reads.length).toBeGreaterThan(readsAfterFirst);
  });

  it('while a pull is under way, keeps what it said: news it hears changes no line', async () => {
    const { importer, state, said, hearOf } = setUp();
    await importer.catchUp(VAULT);
    const shown = said.at(-1);

    state.gate = { open: false, why: 'pulling' };
    await hearOf(UNSTAMPED);
    await importer.catchUp(VAULT);

    expect(said.at(-1)).toEqual(shown);
  });

  it('drops a count whose pull changed while the files were read: nothing said, nothing warned', async () => {
    const { importer, state, said, warnings } = setUp();
    state.onRead = async () => {
      state.gate = { open: false, why: 'pulling' };
    };

    await importer.catchUp(VAULT);

    expect(said.filter((waiting) => waiting?.kind === 'counted')).toEqual([]);
    expect(warnings()).toEqual([]);
  });

  it('says nothing at all, before the gates hold, in a vault with no meeting file', async () => {
    const { importer, said } = setUp({
      notes: { 'Inbox/Call Mara.md': jsonNote({ type: 'task' }) },
      gate: { open: false, why: 'no-pull' },
    });
    expect(await importer.catchUp(VAULT)).toBeNull();
    expect(said).toEqual([null]);
  });

  it('reads at most eight files at once', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 30 }, (_, n) => [
        `Inbox/Meetings/2026-10-01 Call ${n}.md`,
        meetingFile({ ...MEETING_HEADER, external_id: `gemini-${n}` }),
      ]),
    );
    const { importer, state } = setUp({ notes: many });
    let inFlight = 0;
    let most = 0;
    state.onRead = async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      // Each read answers some turns later, so reads started together overlap.
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      inFlight -= 1;
    };
    expect((await importer.catchUp(VAULT))?.waiting).toMatchObject({ count: 30 });
    expect(most).toBeLessThanOrEqual(8);
    expect(most).toBeGreaterThan(1);
  });

  it('counts month folders through the real listing, a lower-case folder too, and leaves out a file gone before its read', async () => {
    const MONTH = 'Meetings/2026/10/2026-10-06 Standup.md';
    const LOWER = 'meetings/2026/09/2026-09-30 Larkspur kickoff.md';
    const HAND_MADE = 'Meetings/2026/10/Notes from lunch.md';
    const GONE = 'Inbox/Meetings/2026-10-07 Gone.md';
    const { importer, state, vault } = setUp({
      notes: {
        [MONTH]: meetingFile(),
        [HAND_MADE]: jsonNote({ type: 'meeting' }),
        [GONE]: meetingFile(),
      },
    });
    // Another folder, spelled in lower case, as a disk that ignores case may hold it.
    const lowerVault = automationVault({ notes: { [LOWER]: meetingFile() }, today: TODAY });
    expect(await lowerVault.ports.fs.listDirectory(createVaultPath('meetings'))).not.toEqual([]);
    state.onRead = async (path) => {
      if (path === GONE) vault.files.delete(GONE);
    };
    expect((await importer.catchUp(VAULT))?.waiting).toMatchObject({ count: 1 });

    const lower = createMeetingImporter({
      ports: () => lowerVault.ports,
      clock: { today: () => TODAY },
      activity: recordingActivity(),
      openVault: () => VAULT,
      active: () => false,
      onWritten: vi.fn(),
      waiting: {
        namedElsewhere: () => ({ name: 'Studio' }),
        countGate: async () => ({ open: true, standing: PULL }),
        said: () => undefined,
      },
    });
    expect((await lower.catchUp(VAULT))?.waiting).toMatchObject({ count: 1 });
  });

  it('says one meeting, and warns of it, when one waits', async () => {
    const { importer, warnings } = setUp({ notes: { [UNSTAMPED]: meetingFile() } });
    expect((await importer.catchUp(VAULT))?.waiting).toEqual({
      kind: 'counted',
      mac: 'Studio',
      count: 1,
    });
    expect(warnings()).toEqual(['1 meeting is waiting for Studio to process it.']);
  });

  it('counts 0 and warns of nothing when every meeting is stamped or is a conflict copy', async () => {
    const { importer, warnings } = setUp({
      notes: { [STAMPED]: MIXED[STAMPED]!, [CONFLICT]: MIXED[CONFLICT]! },
    });
    expect((await importer.catchUp(VAULT))?.waiting).toEqual({
      kind: 'counted',
      mac: 'Studio',
      count: 0,
    });
    expect(warnings()).toEqual([]);
  });

  it('leaves out a meeting changed here after the pull: the next pull judges it', async () => {
    const { importer } = setUp({ gate: { open: true, standing: pulledAt(0) } });
    expect((await importer.catchUp(VAULT))?.waiting).toMatchObject({ count: 0 });
  });

  it('before the gates hold, says it waits and gives no count, reading no meeting', async () => {
    const { importer, warnings, reads } = setUp({ gate: { open: false, why: 'no-pull' } });

    const outcome = await importer.catchUp(VAULT);

    expect(outcome?.waiting).toEqual({ kind: 'uncounted', mac: 'Studio', why: 'no-pull' });
    expect(reads).toEqual([]);
    expect(warnings()).toEqual([]);
  });

  it('names the Mac from the settings, and describes one the settings keep no name for', async () => {
    const { importer } = setUp({ named: { name: null } });
    expect((await importer.catchUp(VAULT))?.waiting).toMatchObject({
      mac: 'the Mac that runs the automations',
    });
  });

  it('on the named Mac, with its gates shut, drops the run and says nothing waits', async () => {
    const { importer, said, warnings, reads } = setUp({ named: null });
    expect(await importer.catchUp(VAULT)).toBeNull();
    expect(said).toEqual([null]);
    expect(reads).toEqual([]);
    expect(warnings()).toEqual([]);
  });

  it('once this Mac imports, clears what it said waits', async () => {
    const { importer, said, state } = setUp();
    await importer.catchUp(VAULT);
    state.active = true;
    await importer.catchUp(VAULT);
    expect(said.at(-1)).toBeNull();
  });

  it('counts again, and warns, when the named Mac’s name changes within one pull', async () => {
    const { importer, state, warnings } = setUp();
    await importer.catchUp(VAULT);
    state.named = { name: 'Laptop' };
    expect((await importer.catchUp(VAULT))?.waiting).toMatchObject({ mac: 'Laptop', count: 2 });
    expect(warnings()).toHaveLength(2);
  });

  it('without a watch, drops a run it may not make, as before', async () => {
    const { importer } = setUp({ watching: false });
    expect(await importer.catchUp(VAULT)).toBeNull();
  });
});
