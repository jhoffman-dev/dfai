/**
 * Rules a note sets off (P29-01), over a vault held in memory whose index
 * answers with real SQL. Each run is handed one sync's changes, as the
 * change feed reports them; the rule's log, read back from the vault, is the
 * only memory a run has — so a run made after a restart reads the same log.
 */
import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  digestOf,
  logPathFor,
  MAX_ACTIONS_PER_RUN,
  NOTE_RUNS_PER_HOUR,
  parseObjectType,
  parseRunLog,
  type AutomationRule,
  type LogEntry,
  type NoteChange,
} from '@dfai/domain';
import { recordingActivity } from '../testing/fake-activity.ts';
import { automationVault, jsonNote, TASK_TYPES } from '../testing/automation-vault.ts';
import { dryRunAutomation } from './dry-run-automation.ts';
import { appendToRuleLog } from './automation-log.ts';
import { NoteRunsCappedError } from './note-runs.ts';
import { runAutomation, runOnNoteChanges } from './run-automation.ts';
import type { VaultGuard } from './vault-guard.ts';

const p = createVaultPath;
const TODAY = '2026-10-08';
const CLOCK = {
  today: () => TODAY,
  localNow: () => `${TODAY}T09:00:00`,
  now: () => Date.parse(`${TODAY}T09:00:00Z`),
};
const VAULT = '/vaults/home';
const GUARD: VaultGuard = { vault: VAULT, currentVault: () => VAULT };
const STANDUP = 'Meetings/2026-10-06 Standup.md';
const KICKOFF = 'Meetings/2026-10-07 Kickoff.md';

const TYPES = [
  ...TASK_TYPES,
  parseObjectType({
    name: 'meeting',
    label: 'Meeting',
    properties: { status: 'text', kind: 'text' },
  }),
];

/** A rule that marks each new meeting as new. */
const MARK: AutomationRule = {
  id: 'Mark',
  path: createVaultPath('.atlas/automations/Mark.md'),
  name: 'Mark new meetings',
  enabled: true,
  when: { kind: 'note', type: 'meeting', on: ['created'] },
  which: 'FROM meeting',
  olderThanDays: null,
  action: { kind: 'set', values: { status: 'new' } },
};

/** A rule that archives standups as they arrive or change. */
const FILE_STANDUPS: AutomationRule = {
  ...MARK,
  id: 'File',
  path: createVaultPath('.atlas/automations/File.md'),
  name: 'File standups',
  when: { kind: 'note', type: 'meeting', on: ['created', 'changed'] },
  which: 'FROM meeting WHERE kind = standup',
  action: { kind: 'archive' },
};

const meeting = (kind: string, body = 'Notes.\n') => jsonNote({ type: 'meeting', kind }, body);

function setUp(notes: Record<string, string>) {
  const vault = automationVault({ notes, today: TODAY, types: TYPES });
  const activity = recordingActivity();
  let queries = 0;
  const ask = vault.ports.index.query;
  vault.ports.index.query = (sql, parameters) => {
    queries += 1;
    return ask(sql, parameters);
  };
  const run = (rule: AutomationRule, changes: readonly NoteChange[]) =>
    runOnNoteChanges({ ports: vault.ports, rule, clock: CLOCK, guard: GUARD, activity, changes });
  /** What the feed reports of a note as it is now. */
  const as = (kind: NoteChange['kind'], path: string): NoteChange => ({
    kind,
    path,
    type: 'meeting',
    digest: digestOf(vault.files.get(path) ?? ''),
  });
  const logOf = (rule: AutomationRule): LogEntry[] =>
    parseRunLog(vault.files.get(logPathFor(rule.id)) ?? '');
  /** The vault's writes and moves, without the rule's log. */
  const changed = () => vault.log.filter((line) => !line.includes('.atlas/automations/log/'));
  return { vault, activity, run, as, logOf, changed, queries: () => queries };
}

describe('runOnNoteChanges: a note arrives', () => {
  it('runs once for a new meeting, logs the version it handled and the one it wrote', async () => {
    const { vault, activity, run, as, logOf } = setUp({ [STANDUP]: meeting('standup') });
    const arrived = as('added', STANDUP);

    const entry = await run(MARK, [arrived]);

    expect(vault.properties(STANDUP)['status']).toBe('new');
    expect(entry).toMatchObject({ kind: 'run', trigger: 'note', capped: false });
    expect(entry?.kind === 'run' && entry.versions).toEqual([
      { path: STANDUP, digest: arrived.digest, wrote: false },
      { path: STANDUP, digest: digestOf(vault.files.get(STANDUP)!), wrote: true },
    ]);
    expect(logOf(MARK)).toEqual([entry]);
    expect(activity.reports.map((report) => report.message)).toEqual([
      'Mark new meetings: Ran when a note appeared or changed (2026-10-06 Standup). Changed 1 note.',
    ]);
  });

  it('does not run again for the same version, heard again after a restart or a re-index', async () => {
    const { run, as, changed, logOf } = setUp({ [STANDUP]: meeting('standup') });
    const arrived = as('added', STANDUP);
    await run(MARK, [arrived]);
    const before = changed().length;

    expect(await run(MARK, [arrived])).toBeNull();
    expect(changed()).toHaveLength(before);
    expect(logOf(MARK)).toHaveLength(1);
  });

  it('is not set off again by its own write, heard back as a change: it does not even look', async () => {
    const { run, as, logOf, queries } = setUp({ [STANDUP]: meeting('other') });
    const both = { ...MARK, when: { ...FILE_STANDUPS.when } };
    await run(both, [as('added', STANDUP)]);
    const asked = queries();

    expect(await run(both, [as('changed', STANDUP)])).toBeNull();
    expect(queries()).toBe(asked);
    expect(logOf(both)).toHaveLength(1);
  });

  it('runs for a meeting written by any means: one sync can carry several', async () => {
    const { vault, run, as } = setUp({
      [STANDUP]: meeting('standup'),
      [KICKOFF]: meeting('kickoff'),
    });

    const entry = await run(MARK, [as('added', STANDUP), as('added', KICKOFF)]);

    expect(
      entry?.kind === 'run' && entry.done.map((action) => 'path' in action && action.path),
    ).toEqual([STANDUP, KICKOFF]);
    expect(vault.properties(KICKOFF)['status']).toBe('new');
  });

  it('is not set off by a meeting moved or renamed: same bytes, gone from one path to another', async () => {
    const { vault, run, as, changed } = setUp({ [STANDUP]: meeting('standup') });
    const moved = as('added', STANDUP);

    const entry = await run(MARK, [
      { ...moved, kind: 'removed', path: 'Meetings/Standup.md' },
      moved,
    ]);

    expect(entry).toBeNull();
    expect(changed()).toEqual([]);
    expect(vault.files.has(logPathFor(MARK.id))).toBe(false);
  });

  it('writes nothing, and says nothing, when its query matches none of the notes', async () => {
    const { vault, activity, run, as } = setUp({ [KICKOFF]: meeting('kickoff') });

    expect(await run(FILE_STANDUPS, [as('added', KICKOFF)])).toBeNull();

    expect(vault.files.has(KICKOFF)).toBe(true);
    expect(vault.files.has(logPathFor(FILE_STANDUPS.id))).toBe(false);
    expect(activity.reports).toEqual([]);
  });

  it('acts only on the notes that set it off, not every note its query matches', async () => {
    const { vault, run, as } = setUp({
      [STANDUP]: meeting('standup'),
      'Meetings/Old standup.md': meeting('standup'),
    });

    await run(FILE_STANDUPS, [as('added', STANDUP)]);

    expect(vault.files.has(`Archive/${STANDUP}`)).toBe(true);
    expect(vault.files.has('Meetings/Old standup.md')).toBe(true);
  });

  it('records the archived copy as its own write, so archiving it does not set it off', async () => {
    const { vault, run, logOf } = setUp({ [STANDUP]: meeting('standup') });
    const digest = digestOf(vault.files.get(STANDUP)!);
    await run(FILE_STANDUPS, [{ kind: 'added', path: STANDUP, type: 'meeting', digest }]);

    const archived = `Archive/${STANDUP}`;
    const [entry] = logOf(FILE_STANDUPS);
    expect(entry?.kind === 'run' && entry.versions).toEqual([
      { path: STANDUP, digest, wrote: false },
      { path: archived, digest: digestOf(vault.files.get(archived)!), wrote: true },
    ]);
  });
});

describe('runOnNoteChanges: its own writes elsewhere', () => {
  it('hears a note an archive relinked, and writes nothing when it finds it as it leaves it', async () => {
    const linking = meeting('kickoff', 'Follows [[Meetings/2026-10-06 Standup]].\n');
    const { vault, run, as, logOf } = setUp({
      [STANDUP]: meeting('standup'),
      [KICKOFF]: linking,
    });
    await run(FILE_STANDUPS, [as('added', STANDUP)]);
    expect(vault.files.get(KICKOFF)).not.toBe(linking);
    // Its bytes cannot say the relink was all that happened to it, so it is not taken as the rule's.
    const [entry] = logOf(FILE_STANDUPS);
    expect(entry?.kind === 'run' && entry.versions?.map((version) => version.path)).not.toContain(
      KICKOFF,
    );

    expect(await run(FILE_STANDUPS, [as('changed', KICKOFF)])).toBeNull();
    expect(logOf(FILE_STANDUPS)).toHaveLength(1);
  });
});

describe('runOnNoteChanges: a note changes', () => {
  const ON_CHANGE = { ...MARK, when: { kind: 'note', type: 'meeting', on: ['changed'] } } as const;

  it('runs once per new version, and not again for one it has handled', async () => {
    const { vault, run, as, logOf } = setUp({ [STANDUP]: meeting('standup') });
    const reviewed = { ...ON_CHANGE, action: { kind: 'archive' } } as const;

    expect(await run(reviewed, [as('added', STANDUP)])).toBeNull();
    vault.files.set(STANDUP, meeting('standup', 'Notes, edited.\n'));
    const edited = as('changed', STANDUP);
    vault.unsaved.add(STANDUP);
    // Left alone while typed in: said, but not logged, so the version is not taken as handled.
    expect(await run(reviewed, [edited])).toMatchObject({ kind: 'run', done: [], left: [{}] });
    expect(logOf(reviewed)).toEqual([]);
    vault.unsaved.delete(STANDUP);
    expect(await run(reviewed, [edited])).toMatchObject({
      kind: 'run',
      done: [{ kind: 'archived' }],
    });
    expect(await run(reviewed, [edited])).toBeNull();
    expect(logOf(reviewed)).toHaveLength(1);
  });

  it('runs again on each later version its query matches and its action would change', async () => {
    const { vault, run, as, logOf } = setUp({ [STANDUP]: meeting('standup') });
    await run(ON_CHANGE, [as('changed', STANDUP)]);
    vault.files.set(STANDUP, jsonNote({ type: 'meeting', kind: 'standup', status: 'read' }));

    expect(await run(ON_CHANGE, [as('changed', STANDUP)])).toMatchObject({ kind: 'run' });
    expect(vault.properties(STANDUP)['status']).toBe('new');
    expect(logOf(ON_CHANGE)).toHaveLength(2);
  });

  it('writes nothing for a later version already as it leaves it', async () => {
    const { vault, run, as, logOf } = setUp({ [STANDUP]: meeting('standup') });
    await run(ON_CHANGE, [as('changed', STANDUP)]);
    vault.files.set(STANDUP, jsonNote({ type: 'meeting', kind: 'daily', status: 'new' }));

    expect(await run(ON_CHANGE, [as('changed', STANDUP)])).toBeNull();
    expect(logOf(ON_CHANGE)).toHaveLength(1);
  });
});

describe('runOnNoteChanges: what holds it back', () => {
  it('hears nothing of a note of another type, nor when it is off or on a clock', async () => {
    const { vault, run, as } = setUp({ [STANDUP]: meeting('standup') });
    const task = { ...as('added', STANDUP), type: 'task' };

    expect(await run(MARK, [task])).toBeNull();
    expect(await run({ ...MARK, enabled: false }, [as('added', STANDUP)])).toBeNull();
    expect(await run({ ...MARK, when: { kind: 'manual' } }, [as('added', STANDUP)])).toBeNull();
    expect(vault.log).toEqual([]);
  });

  it('runs nothing once it has run as often this hour as one may, and says it is waiting, not failing', async () => {
    const { vault, activity, run, as } = setUp({ [STANDUP]: meeting('standup') });
    for (let at = 0; at < NOTE_RUNS_PER_HOUR; at += 1) {
      const entry: LogEntry = {
        kind: 'run',
        at: `${TODAY}T08:${String(10 + at).padStart(2, '0')}:00`,
        trigger: 'note',
        done: [{ kind: 'archived', from: p('A.md'), to: p('Archive/A.md') }],
        left: [],
        capped: false,
      };
      await appendToRuleLog({ fs: vault.ports.fs, rule: MARK, entry, now: CLOCK.now() });
    }
    const logged = vault.files.get(logPathFor(MARK.id));

    const held = await run(MARK, [as('added', STANDUP)]).catch((cause: unknown) => cause);
    expect(held).toBeInstanceOf(NoteRunsCappedError);
    expect((held as NoteRunsCappedError).until).toBe(`${TODAY}T09:10:00`);

    expect(vault.properties(STANDUP)['status']).toBeUndefined();
    expect(vault.files.get(logPathFor(MARK.id))).toBe(logged);
    expect(activity.reports.map((report) => [report.level, report.message])).toEqual([
      [
        'info',
        `Mark new meetings: Not broken: it has used ${NOTE_RUNS_PER_HOUR} runs this hour, ` +
          `and ${NOTE_RUNS_PER_HOUR} is its most (each question it asks Claude counts as a run). ` +
          'It runs next at 09:10, on what arrived meanwhile; nothing to do.',
      ],
    ]);
  });

  it('logs an error, not news, when the runs that used up its hour failed (#813)', async () => {
    const { vault, activity, run, as } = setUp({ [STANDUP]: meeting('standup') });
    for (let at = 0; at < NOTE_RUNS_PER_HOUR; at += 1) {
      const entry: LogEntry = {
        kind: 'failed',
        at: `${TODAY}T08:${String(10 + at).padStart(2, '0')}:00`,
        trigger: 'note',
        problem: 'Claude could not be reached.',
      };
      await appendToRuleLog({ fs: vault.ports.fs, rule: MARK, entry, now: CLOCK.now() });
    }

    const held = await run(MARK, [as('added', STANDUP)]).catch((cause: unknown) => cause);

    expect(held).toBeInstanceOf(NoteRunsCappedError);
    expect(activity.reports.map((report) => [report.level, report.message])).toEqual([
      [
        'error',
        `Mark new meetings: Could not run. It failed all ${NOTE_RUNS_PER_HOUR} times it ran this hour. ` +
          'The last failure: Claude could not be reached. ' +
          'It has used up its hourly limit, so it tries again at 09:10.',
      ],
    ]);
  });

  it('logs a run whose query does not read as one that could not, set off by a note', async () => {
    const { run, as, logOf } = setUp({ [STANDUP]: meeting('standup') });
    const broken = { ...MARK, which: 'FROM meeting WHERE nonsense = 1' };

    const entry = await run(broken, [as('added', STANDUP)]);

    expect(entry).toMatchObject({ kind: 'failed', trigger: 'note' });
    expect(logOf(broken)).toEqual([entry]);
  });

  it('acts on at most one run’s worth of notes from one sync, and says it stopped short', async () => {
    const paths = Array.from({ length: MAX_ACTIONS_PER_RUN + 1 }, (_, at) => `Inbox/M${at}.md`);
    const { vault, run, as } = setUp(Object.fromEntries(paths.map((path) => [path, meeting('x')])));

    const entry = await run(
      MARK,
      paths.map((path) => as('added', path)),
    );

    expect(entry).toMatchObject({ kind: 'run', capped: true });
    expect(entry?.kind === 'run' && entry.done).toHaveLength(MAX_ACTIONS_PER_RUN);
    expect(vault.properties(paths.at(-1)!)['status']).toBeUndefined();
  });
});

describe('a rule a note sets off, dry-run and run by hand', () => {
  it('dry-runs to the notes it would act on now: those it has not handled as they are', async () => {
    const { vault, run, as, logOf } = setUp({
      [STANDUP]: meeting('standup'),
      [KICKOFF]: meeting('kickoff'),
    });
    await run(MARK, [as('added', STANDUP)]);
    // Put back as it arrived, as an undo does: that version was handled, so it waits for nothing.
    vault.files.set(STANDUP, meeting('standup'));
    const dryRun = () =>
      dryRunAutomation({
        ports: vault.ports,
        rule: MARK,
        log: logOf(MARK),
        named: MARK,
        today: TODAY,
        activity: recordingActivity(),
      });

    expect((await dryRun()).paths).toEqual([KICKOFF]);
  });

  it('run by hand, does what it would have for each note not yet handled, then nothing', async () => {
    const { vault, run, as, logOf } = setUp({
      [STANDUP]: meeting('standup'),
      [KICKOFF]: meeting('kickoff'),
    });
    await run(MARK, [as('added', STANDUP)]);
    const byHand = () =>
      runAutomation({
        ports: vault.ports,
        rule: MARK,
        clock: CLOCK,
        guard: GUARD,
        activity: recordingActivity(),
        trigger: 'hand',
      });

    const entry = await byHand();
    expect(entry).toMatchObject({ kind: 'run', trigger: 'hand' });
    expect(entry.kind === 'run' && entry.versions?.map((version) => version.path)).toEqual([
      KICKOFF,
      KICKOFF,
    ]);
    expect(vault.properties(KICKOFF)['status']).toBe('new');

    expect(await byHand()).toMatchObject({ kind: 'run', done: [] });
    expect(logOf(MARK)).toHaveLength(3);
  });
});
