/**
 * Second attack on PR #691 (#685): the reorder in undoMeetingSummary — check the
 * meeting, trash its tasks, then one write taking off the links of only those
 * the Trash took. Set up as `claude-step.summary.test.ts` does.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AFTER_A_MEETING_PROMPT,
  builtInPromptAt,
  createVaultPath,
  logPathFor,
  parseObjectType,
  parseRunLog,
  splitFrontmatter,
  type AutomationRule,
  type LogEntry,
} from '@dfai/domain';
import type { ModelEvent } from '../chat/ports.ts';
import { automationVault, jsonNote } from '../testing/automation-vault.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeClaudeStepPorts } from '../testing/fake-claude-step.ts';
import { VaultAccessError } from '../vault/ports.ts';
import type { ScriptedRound } from '../testing/fake-model.ts';
import { runAutomation } from './run-automation.ts';
import { undoLastRun } from './undo-last-run.ts';
import type { VaultGuard } from './vault-guard.ts';

const TODAY = '2026-10-11';
const CLOCK = {
  today: () => TODAY,
  localNow: () => `${TODAY}T09:00:00`,
  now: () => Date.parse(`${TODAY}T09:00:00Z`),
};
const VAULT = '/vaults/home';
const GUARD: VaultGuard = { vault: VAULT, currentVault: () => VAULT };

const fixtureBody = (): string =>
  splitFrontmatter(
    readFileSync(
      new URL(
        '../../../domain/src/meetings/fixtures/valid/gemini-platform-sync.md',
        import.meta.url,
      ),
      'utf8',
    ),
  ).body;

const SYNC = 'Meetings/Platform weekly sync.md';
const HEADER = {
  type: 'meeting',
  atlas_import: 'meeting/v1',
  atlas_import_outcome: 'imported',
  title: 'Platform weekly sync',
  date: '2026-09-29',
  start: '10:00',
  provider: 'gemini',
  external_id: 'gemini-7f3a9c21',
  attendees: [
    { name: 'Mara Quill', email: 'mara.quill@example.com' },
    { name: 'Tobias Fenn', email: 'tobias.fenn@example.com' },
  ],
};
const BODY = fixtureBody();
const meetingWith = (body: string) => jsonNote(HEADER, body);

const RULE_FILE = '.atlas/automations/After a meeting.md';
const RULE: AutomationRule = {
  id: 'After a meeting',
  path: createVaultPath(RULE_FILE),
  name: 'After a meeting',
  enabled: true,
  when: { kind: 'manual' },
  which: 'FROM meeting',
  olderThanDays: null,
  action: {
    kind: 'claude',
    prompt: AFTER_A_MEETING_PROMPT,
    tools: [],
    output: { kind: 'proposals', schema: 'meeting-items' },
    apply: 'mine',
  },
};

const relation = (target: string) => ({ kind: 'relation', target, many: true });
const TYPE_FILES = {
  meeting: { provider: 'text', tasks: relation('task'), decisions: relation('decision') },
  task: {
    status: { kind: 'select', options: ['inbox', 'next-action', 'waiting', 'archive'] },
    waiting_on: { kind: 'relation', target: 'person' },
    due: 'date',
  },
  decision: { meeting: { kind: 'relation', target: 'meeting' } },
  person: {},
};
const TYPES = Object.entries(TYPE_FILES).map(([name, properties]) =>
  parseObjectType({ name, label: name, properties }),
);
const NOTES: Record<string, string> = {
  [SYNC]: meetingWith(BODY),
  'People/Mara Quill.md': jsonNote({ type: 'person', email: 'mara.quill@example.com' }, ''),
  'People/Tobias Fenn.md': jsonNote({ type: 'person', email: 'tobias.fenn@example.com' }, ''),
  [AFTER_A_MEETING_PROMPT]: builtInPromptAt(AFTER_A_MEETING_PROMPT)!.contents,
  // Saved the day before the meeting arrived: the meeting is an arrival, not a backfill.
  [RULE_FILE]: 'The rule, as its file holds it.\n',
  ...Object.fromEntries(
    Object.entries(TYPE_FILES).map(([name, properties]) => [
      `.atlas/types/${name}.md`,
      jsonNote({ name, properties }, ''),
    ]),
  ),
};

const ITEMS = [
  {
    kind: 'task',
    title: 'Write the rollout note',
    owner: 'Mara Quill',
    source_block: 't0003',
    confidence: 'high',
  },
  {
    kind: 'task',
    title: 'Flag the new cache',
    owner: 'Tobias Fenn',
    source_block: 't0002',
    confidence: 'high',
  },
  {
    kind: 'decision',
    title: 'Ship the cache behind a flag',
    source_block: 't0003',
    confidence: 'high',
  },
];
const SUMMARY = {
  summary: 'Mara Quill and Tobias Fenn agreed to ship the new cache behind a flag before Friday.',
  key_points: ['The new cache is ready', 'Tobias wants a flag on it first'],
  open_questions: ['Who tells the support team?'],
};
const digest = (fields: Record<string, unknown> = {}): ModelEvent[] => [
  { type: 'text', text: JSON.stringify({ ...SUMMARY, items: ITEMS, ...fields }) },
];

function setUp(rounds: readonly ScriptedRound[], notes: Record<string, string> = NOTES) {
  const claude = fakeClaudeStepPorts({
    rounds,
    model: 'claude-opus-5-5',
    today: TODAY,
    selfName: 'Mara Quill',
  });
  const vault = automationVault({
    notes: { ...notes },
    today: TODAY,
    ageDays: { [RULE_FILE]: 1 },
    types: TYPES,
    claude,
  });
  const activity = recordingActivity();
  const run = () =>
    runAutomation({
      ports: vault.ports,
      rule: RULE,
      clock: CLOCK,
      guard: GUARD,
      activity,
      trigger: 'hand',
    });
  const undo = () =>
    undoLastRun({ ports: vault.ports, rule: RULE, clock: CLOCK, guard: GUARD, activity });
  const meeting = () => vault.files.get(SYNC) ?? '';
  const body = () => splitFrontmatter(meeting()).body;
  const properties = () => vault.properties(SYNC);
  const tasks = () =>
    [...vault.files.keys()].filter(
      (path) => vault.properties(path)['type'] === 'task' && path.includes('rollout note'),
    );
  const entries = (): LogEntry[] => parseRunLog(vault.files.get(logPathFor(RULE.id)) ?? '');
  const writesToMeeting = () => vault.log.filter((line) => line === `write ${SYNC}`).length;
  return {
    vault,
    claude,
    run,
    undo,
    meeting,
    body,
    properties,
    tasks,
    entries,
    writesToMeeting,
    activity,
  };
}

type At = ReturnType<typeof setUp>;
type Undo = Extract<LogEntry, { kind: 'undo' }>;

const refuseTrash = (at: At, error: Error) => {
  at.vault.ports.fs.trashEntry = async () => {
    throw error;
  };
};

/** The meeting's one undo write fails with an error that is not a refusal. */
const breakMeetingWrite = (at: At, error: Error) => {
  const write = at.vault.ports.fs.writeTextFile;
  at.vault.ports.fs.writeTextFile = async (args) => {
    if (args.path === SYNC) throw error;
    return write(args);
  };
};

/** Something happens to the meeting while the first of its tasks goes to the Trash. */
const duringTrash = (at: At, meanwhile: () => Promise<void>) => {
  const trash = at.vault.ports.fs.trashEntry;
  let once = false;
  at.vault.ports.fs.trashEntry = async (args) => {
    if (!once) {
      once = true;
      await meanwhile();
    }
    await trash(args);
  };
};

const saveMeeting = (at: At) => () =>
  at.vault.ports.fs
    .writeTextFile({
      path: createVaultPath(SYNC),
      contents: `${at.meeting()}\nTyped meanwhile.\n`,
      expectedModified: null,
    })
    .then(() => undefined);

const lastUndo = (at: At): Undo | undefined => {
  const last = at.entries().at(-1);
  return last?.kind === 'undo' ? last : undefined;
};

const allTasks = (at: At) =>
  [...at.vault.files.keys()].filter((path) => at.vault.properties(path)['type'] === 'task');

describe('Undo last run, the meeting write fails after its tasks are trashed (attack2 #691)', () => {
  // The reorder trashes before the one meeting write. A write error that is not a
  // MeetingSummaryRefused propagates out of takeBackSummaries before it returns, so
  // undoOnce's `finally` logs `summaries.done` as its initial empty value: the
  // tasks are in the Trash, the undo entry says nothing was trashed, and that entry
  // marks the run undone (lastUndoableRun), so it can never be retried.
  it.fails('logs every task it trashed when the meeting write then throws', async () => {
    const at = setUp([digest()]);
    await at.run();
    const trashedBefore = allTasks(at);
    expect(trashedBefore.length).toBeGreaterThan(0);
    breakMeetingWrite(at, new Error('disk full'));

    await expect(at.undo()).rejects.toThrow('disk full');

    const gone = trashedBefore.filter((path) => !at.vault.files.has(path));
    expect(gone.length).toBeGreaterThan(0);
    const logged = lastUndo(at)?.done ?? [];
    for (const path of gone) expect(logged).toContainEqual({ kind: 'trashed', path });
  });

  it.fails(
    'names the meeting as left when its write throws after its tasks are trashed',
    async () => {
      const at = setUp([digest()]);
      await at.run();
      breakMeetingWrite(at, new VaultAccessError('permission denied'));

      await expect(at.undo()).rejects.toThrow('permission denied');

      // The summary still says the tasks were made, and they are in the Trash.
      expect(at.body()).toContain('atlas:summary');
      expect(lastUndo(at)?.left.map(({ path }) => path)).toContain(SYNC);
    },
  );

  it.fails(
    'leaves the run undoable when its meeting write threw before anything was logged',
    async () => {
      const at = setUp([digest()]);
      await at.run();
      const write = at.vault.ports.fs.writeTextFile;
      breakMeetingWrite(at, new Error('disk full'));
      await expect(at.undo()).rejects.toThrow('disk full');
      at.vault.ports.fs.writeTextFile = write;

      // A retry once the disk is fine takes the summary out.
      await at.undo();

      expect(at.body().includes('atlas:summary')).toBe(false);
    },
  );

  it('never asks the Trash for anything when the run made no task', async () => {
    const at = setUp([digest({ items: [] })]);
    await at.run();
    expect(allTasks(at)).toHaveLength(0);
    let asked = 0;
    at.vault.ports.fs.trashEntry = async () => {
      asked += 1;
    };

    const undone = (await at.undo()) as Undo | null;

    expect(asked).toBe(0);
    expect(undone?.done).toEqual([{ kind: 'unsummarised', path: SYNC }]);
    expect(at.body().includes('atlas:summary')).toBe(false);
  });
});

describe('Undo last run, the meeting changes while its tasks are trashed (attack2 #691)', () => {
  it('keeps the person’s save, logs each trashed task once, and names the meeting', async () => {
    const at = setUp([digest()]);
    await at.run();
    const before = allTasks(at);
    duringTrash(at, saveMeeting(at));

    const undone = (await at.undo()) as Undo | null;

    expect(at.body()).toContain('Typed meanwhile.');
    // The summary is still there: the write was refused, nothing else written.
    expect(at.body()).toContain('atlas:summary');
    const trashed = undone?.done.filter((line) => line.kind === 'trashed') ?? [];
    expect(trashed).toHaveLength(before.length);
    for (const path of before) {
      expect(at.vault.files.has(path)).toBe(false);
      expect(undone?.left.map((line) => line.path)).not.toContain(path);
    }
    expect(undone?.left.map(({ path }) => path)).toContain(SYNC);
    expect(lastUndo(at)).toEqual(undone);
  });

  it('a second undo after the refused one does nothing more and does not throw', async () => {
    const at = setUp([digest()]);
    await at.run();
    duringTrash(at, saveMeeting(at));
    await at.undo();
    const files = new Map(at.vault.files);

    const again = await at.undo();

    expect(again).toBeNull();
    expect(new Map(at.vault.files)).toEqual(files);
  });

  it('keeps the meeting as typed when a pane gets unsaved typing during the trash', async () => {
    const at = setUp([digest()]);
    await at.run();
    const meeting = at.meeting();
    duringTrash(at, async () => {
      at.vault.unsaved.add(SYNC);
    });

    const undone = (await at.undo()) as Undo | null;

    expect(at.meeting()).toBe(meeting);
    const left = undone?.left.find(({ path }) => path === SYNC);
    expect(left?.reason).toContain('unsaved typing');
    for (const path of allTasks(at)) expect(undone?.left.map((l) => l.path)).toContain(path);
  });

  // A run that wrote no summary (it did not read) but joined its tasks: its tasks
  // are trashed, the meeting's write is refused, and it keeps links to notes in the
  // Trash. With `summary === null` the catch pushes nothing for the meeting, so the
  // log never says the meeting was left, nor why, though it still links them.
  it.fails(
    'names a meeting with no summary as left when it changed while its tasks were trashed',
    async () => {
      const at = setUp([digest({ summary: 42 })]);
      await at.run();
      expect(at.body().includes('atlas:summary')).toBe(false);
      expect(at.properties()['tasks']).toContain('[[Write the rollout note]]');
      duringTrash(at, saveMeeting(at));

      const undone = (await at.undo()) as Undo | null;

      expect(at.tasks()).toHaveLength(0);
      expect(at.properties()['tasks']).toContain('[[Write the rollout note]]');
      expect(undone?.left.map(({ path }) => path)).toContain(SYNC);
    },
  );
});

describe('Undo last run, the links the one write takes off (attack2 #691)', () => {
  const linking = (at: At, links: readonly string[]) => {
    const { frontmatter, body } = splitFrontmatter(at.meeting());
    const properties = at.vault.properties(SYNC);
    expect(frontmatter).not.toBeNull();
    at.vault.files.set(SYNC, jsonNote({ ...properties, tasks: links }, body));
  };

  const spellings = (rollout: string) => [
    '[[Write the rollout note]]',
    `[[${rollout.replace(/\.md$/, '')}]]`,
    '[[Write the rollout note|the note]]',
    '[[A task of my own]]',
    '[[Write the rollout note]]',
  ];

  it('takes off every spelling of a trashed task, twice-linked too, and keeps the person’s own link', async () => {
    const at = setUp([digest()]);
    await at.run();
    const [rollout] = at.tasks();
    linking(at, spellings(rollout!));

    const undone = (await at.undo()) as Undo | null;

    expect(at.vault.files.has(rollout!)).toBe(false);
    const tasks = JSON.stringify(at.properties()['tasks'] ?? []);
    expect(tasks).not.toContain('rollout');
    expect(tasks).toContain('[[A task of my own]]');
    expect(undone?.done).toContainEqual({ kind: 'trashed', path: rollout });
  });

  it('keeps every spelling of a task the Trash refused, and logs it left, not trashed', async () => {
    const at = setUp([digest()]);
    await at.run();
    const [rollout] = at.tasks();
    linking(at, spellings(rollout!));
    refuseTrash(at, new VaultAccessError('permission denied'));

    const undone = (await at.undo()) as Undo | null;

    expect(at.vault.files.has(rollout!)).toBe(true);
    expect(at.properties()['tasks']).toEqual(spellings(rollout!));
    expect(at.body().includes('atlas:summary')).toBe(false);
    expect(undone?.done).not.toContainEqual({ kind: 'trashed', path: rollout });
    expect(undone?.left).toContainEqual({ path: rollout, reason: 'permission denied' });
  });

  it('keeps the link of a task already gone before undo, and still takes the summary out', async () => {
    const at = setUp([digest()]);
    await at.run();
    const [rollout] = at.tasks();
    at.vault.files.delete(rollout!);

    const undone = (await at.undo()) as Undo | null;

    expect(at.body().includes('atlas:summary')).toBe(false);
    expect(undone?.left.map(({ path }) => path)).toContain(rollout);
    expect(undone?.done).not.toContainEqual({ kind: 'trashed', path: rollout });
  });
});
