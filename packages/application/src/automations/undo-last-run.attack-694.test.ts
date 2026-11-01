/**
 * Attack on PR #694 (#693): undoing a run whose tasks are held to the version
 * checked, when only one of several is edited before the Trash. Set up as
 * `undo-last-run.attack-691.test.ts` does, over the same fake vault.
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
import { editedBeforeTrash } from '../testing/edited-before-trash.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeClaudeStepPorts } from '../testing/fake-claude-step.ts';
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
    owner: 'Mara Quill', // Mine, on a turn Mara spoke, so the run makes both tasks.
    source_block: 't0001',
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

const taskPaths = (at: ReturnType<typeof setUp>) =>
  [...at.vault.files.keys()].filter((path) => at.vault.properties(path)['type'] === 'task');

/** Edits one task at the first trash, as an edit landing between the undo's check and its Trash. */
function editOneBeforeTrash(at: ReturnType<typeof setUp>, edited: string) {
  const typed = `${at.vault.files.get(edited)}Typed meanwhile.\n`;
  const fs = { ...at.vault.ports.fs };
  at.vault.ports.fs.trashEntry = editedBeforeTrash(fs, () =>
    fs.writeTextFile({ path: createVaultPath(edited), contents: typed, expectedModified: null }),
  ).trashEntry;
  return { typed, unheld: fs.trashEntry };
}

describe('Undo last run, one task of several edited before the Trash (attack #694)', () => {
  it('trashes the tasks left as made, keeps the edited one, and the meeting links only it', async () => {
    const at = setUp([digest()]);
    await at.run();
    const tasks = taskPaths(at);
    expect(tasks.length).toBe(2);
    const edited = tasks.find((path) => path.includes('Flag the new cache'))!;
    const other = tasks.find((path) => path !== edited)!;
    const { typed } = editOneBeforeTrash(at, edited);

    const undone = (await at.undo()) as Extract<LogEntry, { kind: 'undo' }> | null;

    expect(at.vault.files.get(edited)).toBe(typed);
    expect(at.vault.files.has(other)).toBe(false);
    expect(undone?.done).toContainEqual({ kind: 'trashed', path: other });
    expect(undone?.done).not.toContainEqual({ kind: 'trashed', path: edited });
    expect(undone?.left).toContainEqual({
      path: edited,
      reason: 'It was changed since the run made it, so it was kept.',
    });
    expect(at.properties()['tasks']).toContain('[[Flag the new cache]]');
    expect(at.properties()['tasks']).not.toContain('[[Write the rollout note]]');
  });

  it('does not trash the edited task on a second undo after the refusal', async () => {
    const at = setUp([digest()]);
    await at.run();
    const edited = taskPaths(at).find((path) => path.includes('Flag the new cache'))!;
    const { typed, unheld } = editOneBeforeTrash(at, edited);
    await at.undo();
    at.vault.ports.fs.trashEntry = unheld;

    await at.undo().catch(() => null);

    expect(at.vault.files.get(edited)).toBe(typed);
  });
});
