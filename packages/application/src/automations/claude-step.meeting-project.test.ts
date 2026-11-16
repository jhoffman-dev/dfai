/**
 * #227: the "After a meeting" step chooses a project for a meeting nothing
 * else could file — from the vault's open projects and areas, shown beside
 * the meeting. Sure, the meeting is filed under it, and "Undo last run" takes
 * it back; otherwise one proposal waits in the Inbox. Over the fake vault
 * whose index answers with real SQL, and a scripted model.
 */
import { describe, expect, it } from 'vitest';
import {
  AFTER_A_MEETING_PROMPT,
  builtInPromptAt,
  createVaultPath,
  logPathFor,
  MAX_PROJECT_CHOICES,
  parseObjectType,
  type AutomationRule,
  type ClaudeAction,
} from '@dfai/domain';
import type { ModelEvent } from '../chat/ports.ts';
import {
  automationVault,
  jsonNote,
  TASK_TYPES,
  type IndexedLink,
} from '../testing/automation-vault.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeClaudeStepPorts } from '../testing/fake-claude-step.ts';
import { MEETING_BODY, MEETING_HEADER } from '../testing/meeting-files.ts';
import { fileChosenMeetings } from './meeting-project-choice.ts';
import { runAutomation } from './run-automation.ts';
import { undoLastRun } from './undo-last-run.ts';
import type { VaultGuard } from './vault-guard.ts';

const TODAY = '2026-10-14';
const CLOCK = {
  today: () => TODAY,
  localNow: () => `${TODAY}T09:00:00`,
  now: () => Date.parse(`${TODAY}T09:00:00Z`),
};
const VAULT = '/vaults/home';
const GUARD: VaultGuard = { vault: VAULT, currentVault: () => VAULT };
const TYPES = [
  ...TASK_TYPES,
  parseObjectType({ name: 'meeting', label: 'Meeting', properties: { date: 'date' } }),
];
const MEETING = 'Meetings/2026-10-06 Standup.md';

const step = (apply: ClaudeAction['apply']): ClaudeAction => ({
  kind: 'claude',
  prompt: AFTER_A_MEETING_PROMPT,
  tools: [],
  output: { kind: 'proposals', schema: 'meeting-items' },
  ...(apply !== undefined && { apply }),
});
const rule = (apply: ClaudeAction['apply']): AutomationRule => ({
  id: 'After a meeting',
  path: createVaultPath('.atlas/automations/After a meeting.md'),
  name: 'After a meeting',
  enabled: true,
  when: { kind: 'note', type: 'meeting', on: ['created'] },
  which: 'FROM meeting',
  olderThanDays: null,
  action: step(apply),
});

const answer = (project?: Record<string, unknown>): ModelEvent[] => [
  { type: 'text', text: JSON.stringify({ items: [], ...(project !== undefined && { project }) }) },
];

function setUp({
  round,
  filed = false,
  more = {},
  links = [],
}: {
  round: ModelEvent[];
  filed?: boolean;
  more?: Record<string, string>;
  links?: readonly IndexedLink[];
}) {
  const claude = fakeClaudeStepPorts({ rounds: [round], model: 'claude-opus-5-5', today: TODAY });
  const header = { ...MEETING_HEADER, atlas_import_outcome: 'imported' };
  const notes: Record<string, string> = {
    [AFTER_A_MEETING_PROMPT]: builtInPromptAt(AFTER_A_MEETING_PROMPT)!.contents,
    [MEETING]: jsonNote(filed ? { ...header, project: '[[Operations]]' } : header, MEETING_BODY),
    'Projects/Ledger.md': jsonNote({ type: 'project', status: 'active' }),
    'Areas/Operations.md': jsonNote({ type: 'project', para: 'area' }),
    'Resources/Style guide.md': jsonNote({ type: 'project', para: 'resource' }),
    'Projects/Old payrun.md': jsonNote({ type: 'project', para: 'archive' }),
    ...more,
  };
  const vault = automationVault({ notes, today: TODAY, types: TYPES, claude, links });
  const run = { ports: vault.ports, clock: CLOCK, guard: GUARD, activity: recordingActivity() };
  const byHand = ({ declared = true }: { declared?: boolean } = {}) =>
    runAutomation({ ...run, rule: rule(declared ? 'mine' : undefined), trigger: 'hand' });
  const proposals = () =>
    [...vault.files.keys()].filter((path) => path.startsWith('Inbox/Proposals/'));
  return { claude, vault, run, byHand, proposals };
}

const LEDGER = {
  path: 'Projects/Ledger.md',
  confidence: 'high',
  why: 'Its people run the ledger.',
};

describe('the After a meeting step’s project (#227)', () => {
  it('is shown the open projects and areas, never a resource or an archived one', async () => {
    const { claude, byHand } = setUp({ round: answer() });
    await byHand();
    const [request] = claude.fake.requests;
    const said = JSON.stringify(request);
    expect(said).toContain('Projects/Ledger.md — Ledger (project)');
    expect(said).toContain('Areas/Operations.md — Operations (area)');
    expect(said).not.toContain('Style guide');
    expect(said).not.toContain('Old payrun');
  });

  it('is shown at most the cap, the projects tied to the meeting’s people first, and told the rest are cut (#793)', async () => {
    const more = Object.fromEntries(
      Array.from({ length: 60 }, (_, at) => [
        `Projects/Aster ${String(at).padStart(2, '0')}.md`,
        jsonNote({ type: 'project' }),
      ]),
    );
    const MARA = 'People/Mara Quill.md';
    const ZINNIA = 'Projects/Zinnia rollout.md';
    const { claude, vault, byHand } = setUp({
      round: answer({ ...LEDGER, path: ZINNIA }),
      more: {
        ...more,
        [MARA]: jsonNote({ type: 'person' }),
        [ZINNIA]: jsonNote({ type: 'project', status: 'active' }),
      },
      links: [
        { src: MEETING, key: 'people', dst: MARA },
        { src: ZINNIA, key: 'people', dst: MARA },
      ],
    });
    await byHand();
    const system = claude.fake.requests[0]!.system;
    const listed = system.split('\n').filter((line) => / — .* \((project|area)\)$/.test(line));

    expect(listed).toHaveLength(MAX_PROJECT_CHOICES);
    expect(listed[0]).toBe(`- ${ZINNIA} — Zinnia rollout (project)`);
    expect(system).toContain(`${MAX_PROJECT_CHOICES} of the 63 open projects and areas are shown`);
    // Read against the list it was shown: the tied project, last by title, is a choice it may make.
    expect(vault.properties(MEETING)['project']).toBe('[[Zinnia rollout]]');
  });

  it('leaves a meeting changed since it was read without the project, and says why', async () => {
    const { vault } = setUp({ round: answer(), filed: true });
    const warnings: string[] = [];
    const done = await fileChosenMeetings({
      ports: vault.ports,
      changes: [
        {
          path: createVaultPath(MEETING),
          key: 'project',
          expect: { absent: true },
          to: { value: '[[Ledger]]' },
        },
      ],
      today: TODAY,
      warnings,
    });
    expect(done).toEqual([]);
    expect(vault.properties(MEETING)['project']).toBe('[[Operations]]');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^Left 2026-10-06 Standup without the project Claude chose: /);
  });

  it('files the meeting under a project Claude is sure of, and Undo last run takes it back', async () => {
    const { vault, run, byHand, proposals } = setUp({ round: answer(LEDGER) });
    await byHand();
    expect(vault.properties(MEETING)['project']).toBe('[[Ledger]]');
    expect(proposals()).toEqual([]);

    await undoLastRun({ ...run, rule: rule('mine') });
    expect(vault.properties(MEETING)['project']).toBeUndefined();
  });

  it('never takes `project` off a note that is not a meeting, though its log says the run filed it', async () => {
    const { vault, run, byHand } = setUp({ round: answer(LEDGER) });
    await byHand();
    // A log is a note anyone can write: one line now names a task, really filed under Ledger.
    const TASK = 'Tasks/Send the Larkspur contract.md';
    vault.files.set(TASK, jsonNote({ type: 'task', project: '[[Ledger]]' }));
    const log = logPathFor('After a meeting');
    vault.files.set(log, vault.files.get(log)!.replaceAll(MEETING, TASK));

    const undone = await undoLastRun({ ...run, rule: rule('mine') });
    expect(vault.properties(TASK)['project']).toBe('[[Ledger]]');
    expect(JSON.stringify(undone)).toContain('files only meetings');
  });

  it('proposes one it is not sure of, once, in the Inbox', async () => {
    const { vault, byHand, proposals } = setUp({
      round: answer({ ...LEDGER, confidence: 'medium' }),
    });
    await byHand();
    expect(vault.properties(MEETING)['project']).toBeUndefined();
    const [proposal, ...others] = proposals();
    expect(others).toEqual([]);
    expect(vault.properties(proposal!)).toMatchObject({
      kind: 'link',
      confidence: 'medium',
      proposal_id: 'meeting links:gemini/gemini-7f3a9c21:project',
      payload: { note: MEETING, property: 'project', link: '[[Ledger]]' },
    });
  });

  it('is shown no projects, and files nothing, for a meeting that has one', async () => {
    const { claude, vault, byHand } = setUp({ round: answer(LEDGER), filed: true });
    await byHand();
    expect(JSON.stringify(claude.fake.requests[0])).not.toContain('Projects/Ledger.md — Ledger');
    expect(vault.properties(MEETING)['project']).toBe('[[Operations]]');
  });

  it('files nothing when the rule is not the declared step', async () => {
    const { claude, vault, byHand, proposals } = setUp({ round: answer(LEDGER) });
    await byHand({ declared: false });
    expect(JSON.stringify(claude.fake.requests[0])).not.toContain('Projects/Ledger.md — Ledger');
    expect(vault.properties(MEETING)['project']).toBeUndefined();
    expect(proposals()).toEqual([]);
  });

  it('leaves out a project it was not shown, and still reads the rest of the answer', async () => {
    const { vault, byHand, proposals } = setUp({
      round: answer({ ...LEDGER, path: 'Resources/Style guide.md' }),
    });
    const entry = await byHand();
    expect(vault.properties(MEETING)['project']).toBeUndefined();
    expect(proposals()).toEqual([]);
    expect(JSON.stringify(entry)).toContain('is not one it was shown');
  });
});
