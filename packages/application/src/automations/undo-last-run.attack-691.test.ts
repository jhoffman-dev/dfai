/**
 * Attack on PR #691 (#685): undoing a run whose task the host will not trash.
 * Set up as `claude-step.summary.test.ts` does, over the same fake vault.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AFTER_A_MEETING_PROMPT,
  builtInPromptAt,
  createVaultPath,
  deleteThroughLinkRefusal,
  logPathFor,
  parseObjectType,
  parseRunLog,
  splitFrontmatter,
  type AutomationRule,
  type LogEntry,
} from '@dfai/domain';
import type { ModelEvent } from '../chat/ports.ts';
import { automationVault, jsonNote } from '../testing/automation-vault.ts';
import { editedBeforeTrash } from '../testing/edited-before-trash.ts';
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

const refuseTrash = (at: ReturnType<typeof setUp>, error: Error) => {
  at.vault.ports.fs.trashEntry = async () => {
    throw error;
  };
};

describe('Undo last run, a task the host will not trash (attack #691)', () => {
  // takeBackSummaries: "A task changed since stays, and so does its link." A task
  // the Trash refused stays too, but the meeting's one write has already dropped
  // its link, so the meeting no longer names a task that is still there.
  it('keeps the link to a task the host would not trash through a link', async () => {
    const at = setUp([digest()]);
    await at.run();
    const [task] = at.tasks();
    expect(task).toBeDefined();
    expect(at.properties()['tasks']).toContain('[[Write the rollout note]]');
    refuseTrash(at, new VaultAccessError(deleteThroughLinkRefusal(createVaultPath('Tasks'))));

    await at.undo();

    expect(at.vault.files.has(task!)).toBe(true);
    expect(at.properties()['tasks']).toContain('[[Write the rollout note]]');
  });

  it('keeps the link to a task the Trash refused for any other reason', async () => {
    const at = setUp([digest()]);
    await at.run();
    const [task] = at.tasks();
    refuseTrash(at, new VaultAccessError('cannot move to the Trash: permission denied'));

    await at.undo();

    expect(at.vault.files.has(task!)).toBe(true);
    expect(at.properties()['tasks']).toContain('[[Write the rollout note]]');
  });

  it('names every task left, with the host reason, when another host error refuses the trash', async () => {
    const at = setUp([digest()]);
    await at.run();
    const tasks = [...at.vault.files.keys()].filter(
      (path) => at.vault.properties(path)['type'] === 'task',
    );
    expect(tasks.length).toBeGreaterThan(0);
    const denied = 'cannot move to the Trash: permission denied';
    refuseTrash(at, new VaultAccessError(denied));

    const undone = (await at.undo()) as Extract<LogEntry, { kind: 'undo' }> | null;

    for (const task of tasks) {
      expect(at.vault.files.has(task)).toBe(true);
      expect(undone?.left).toContainEqual({ path: task, reason: denied });
    }
    expect(undone?.done.some((action) => action.kind === 'trashed')).toBe(false);
    const logged = at.entries().at(-1);
    expect(logged?.kind === 'undo' && logged.left).toEqual(undone?.left);
  });

  it('stops on an error that is not the host refusing, and trashes nothing more', async () => {
    const at = setUp([digest()]);
    await at.run();
    const [task] = at.tasks();
    refuseTrash(at, new TypeError('the port broke'));

    await expect(at.undo()).rejects.toThrow('the port broke');
    expect(at.vault.files.has(task!)).toBe(true);
  });
});

describe('Undo last run, a task edited between its check and the Trash (#693)', () => {
  it('keeps the task and its link, and names it as left, trashing nothing', async () => {
    const at = setUp([digest()]);
    await at.run();
    const tasks = [...at.vault.files.keys()].filter(
      (path) => at.vault.properties(path)['type'] === 'task',
    );
    expect(tasks.length).toBeGreaterThan(0);
    const fs = { ...at.vault.ports.fs };
    const edited = new Map(
      tasks.map((path) => [path, `${at.vault.files.get(path)}Typed meanwhile.\n`]),
    );
    at.vault.ports.fs.trashEntry = editedBeforeTrash(fs, async () => {
      for (const [path, contents] of edited) {
        await fs.writeTextFile({ path: createVaultPath(path), contents, expectedModified: null });
      }
    }).trashEntry;

    const undone = (await at.undo()) as Extract<LogEntry, { kind: 'undo' }> | null;

    for (const [task, contents] of edited) {
      expect(at.vault.files.get(task)).toBe(contents);
      expect(undone?.left).toContainEqual({
        path: task,
        reason: 'It was changed since the run made it, so it was kept.',
      });
    }
    expect(undone?.done.some((action) => action.kind === 'trashed')).toBe(false);
    expect(at.properties()['tasks']).toContain('[[Write the rollout note]]');
  });

  it('trashes and logs every task left as made, through the same hold', async () => {
    const at = setUp([digest()]);
    await at.run();
    const tasks = [...at.vault.files.keys()].filter(
      (path) => at.vault.properties(path)['type'] === 'task',
    );
    expect(tasks.length).toBeGreaterThan(0);
    at.vault.ports.fs.trashEntry = editedBeforeTrash(
      { ...at.vault.ports.fs },
      () => undefined,
    ).trashEntry;

    const undone = (await at.undo()) as Extract<LogEntry, { kind: 'undo' }> | null;

    for (const task of tasks) {
      expect(at.vault.files.has(task)).toBe(false);
      expect(undone?.done).toContainEqual({ kind: 'trashed', path: task });
    }
  });
});
