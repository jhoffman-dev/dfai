import { describe, expect, it, vi } from 'vitest';
import {
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
        if (path === UNREADABLE) throw new Error('permission denied');
        return vault.ports.fs.readTextFile(path);
      },
    },
  };
  const activity = recordingActivity();
  const state = { named, gate, active: false };
  const said: (MeetingsWaiting | null)[] = [];
  const watch: MeetingsWaitingWatch = {
    namedElsewhere: () => state.named,
    countGate: async () => state.gate,
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
  const hear = () =>
    importer.hear({
      vault: VAULT,
      changes: [{ kind: 'added', path: UNSTAMPED, type: 'meeting', digest: digestOf('') }],
    });
  return { vault, importer, state, said, warnings, reads, hear };
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

  it('warns once per pull: a second run for the same pull reads nothing and says nothing', async () => {
    const { importer, warnings, reads, hear, said } = setUp();
    await importer.catchUp(VAULT);
    const readsAfterFirst = reads.length;
    expect(readsAfterFirst).toBeGreaterThan(0);

    await hear();
    await importer.catchUp(VAULT);

    expect(warnings()).toHaveLength(1);
    expect(reads).toHaveLength(readsAfterFirst);
    expect(said.at(-1)).toEqual({ kind: 'counted', mac: 'Studio', count: 2 });
  });

  it('counts and warns again after the next pull', async () => {
    const { importer, warnings, state } = setUp();
    await importer.catchUp(VAULT);
    state.gate = { open: true, standing: pulledAt(PULL.finishedAt + 60_000) };

    await importer.catchUp(VAULT);

    expect(warnings()).toHaveLength(2);
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
