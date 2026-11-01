/**
 * #226 over #185 and #227: one "After a meeting" run over a meeting with a mix
 * of items — the owner's plain commitment, one they are less sure of, someone
 * else's unasked work, a waiting-for they asked for, a decision they made, and
 * a project Claude is sure of — writes ONE meeting write with the summary, the
 * task and the project. The summary lists exactly what reaches the owner and
 * nothing left out, and the run's log line reads back with its tallies. Over
 * the fake vault whose index answers with real SQL, and a scripted model.
 */
import { describe, expect, it } from 'vitest';
import {
  AFTER_A_MEETING_PROMPT,
  builtInPromptAt,
  createVaultPath,
  logPathFor,
  parseObjectType,
  parseRunLog,
  readSummaryBlock,
  splitFrontmatter,
  type AutomationRule,
} from '@dfai/domain';
import type { ModelEvent } from '../chat/ports.ts';
import { automationVault, jsonNote } from '../testing/automation-vault.ts';
import { recordingActivity } from '../testing/fake-activity.ts';
import { fakeClaudeStepPorts } from '../testing/fake-claude-step.ts';
import { runAutomation } from './run-automation.ts';
import type { VaultGuard } from './vault-guard.ts';

const TODAY = '2026-10-14';
const CLOCK = {
  today: () => TODAY,
  localNow: () => `${TODAY}T09:00:00`,
  now: () => Date.parse(`${TODAY}T09:00:00Z`),
};
const VAULT = '/vaults/home';
const GUARD: VaultGuard = { vault: VAULT, currentVault: () => VAULT };

const MEETING = 'Meetings/2026-10-14 Renewal review.md';
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

const TRANSCRIPT = [
  '**Mara Quill** [~00:00:10] I’ll send the renewal contract by Friday. ^t0001',
  '',
  '**Tobias Fenn** [~00:00:20] I’ll flag the new cache. ^t0002',
  '',
  '**Mara Quill** [~00:00:30] Tobias, can you send me the cache numbers? ^t0003',
  '',
  '**Tobias Fenn** [~00:00:40] Sure, Monday. ^t0004',
  '',
  '**Mara Quill** [~00:00:50] I might book the review room. ^t0005',
  '',
  '**Mara Quill** [~00:01:00] Let’s go with the Larkspur vendor. ^t0006',
  '',
].join('\n');
const HEADER = {
  type: 'meeting',
  atlas_import: 'meeting/v1',
  atlas_import_outcome: 'imported',
  title: 'Renewal review',
  date: TODAY,
  start: '09:30',
  provider: 'granola',
  external_id: 'granola-5c1d',
  attendees: [
    { name: 'Mara Quill', email: 'mara.quill@example.com' },
    { name: 'Tobias Fenn', email: 'tobias.fenn@example.com' },
  ],
};
const BODY = `\n## Summary\n\nThe renewal goes ahead.\n\n## Transcript\n\n${TRANSCRIPT}`;

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

const item = (fields: Record<string, unknown>) => ({ confidence: 'high', ...fields });
const ITEMS = [
  item({ kind: 'task', title: 'Send the renewal contract', owner: 'You', source_block: 't0001' }),
  item({ kind: 'task', title: 'Flag the new cache', owner: 'Tobias Fenn', source_block: 't0002' }),
  item({
    kind: 'waiting',
    title: 'Send the cache numbers',
    owner: 'Tobias Fenn',
    source_block: 't0003',
    asked_by_owner: true,
  }),
  item({
    kind: 'task',
    title: 'Book the review room',
    owner: 'You',
    source_block: 't0005',
    confidence: 'medium',
  }),
  item({ kind: 'decision', title: 'Go with the Larkspur vendor', source_block: 't0006' }),
];
const ANSWER: ModelEvent[] = [
  {
    type: 'text',
    text: JSON.stringify({
      summary: 'The renewal goes ahead; the contract goes out this week.',
      key_points: ['The vendor is Larkspur'],
      open_questions: [],
      items: ITEMS,
      project: {
        path: 'Projects/Ledger.md',
        confidence: 'high',
        why: 'Its people run the ledger.',
      },
    }),
  },
];

function setUp({ ruleTimeUnknown = false }: { ruleTimeUnknown?: boolean } = {}) {
  const claude = fakeClaudeStepPorts({
    rounds: [ANSWER],
    model: 'claude-opus-5-5',
    today: TODAY,
    selfName: 'Mara Quill',
    selfEmails: ['mara.quill@example.com'],
  });
  const vault = automationVault({
    notes: {
      ...Object.fromEntries(
        Object.entries(TYPE_FILES).map(([name, properties]) => [
          `.atlas/types/${name}.md`,
          jsonNote({ name, properties }, ''),
        ]),
      ),
      [MEETING]: jsonNote(HEADER, BODY),
      'People/Mara Quill.md': jsonNote({ type: 'person', email: 'mara.quill@example.com' }, ''),
      'People/Tobias Fenn.md': jsonNote({ type: 'person', email: 'tobias.fenn@example.com' }, ''),
      'Projects/Ledger.md': jsonNote({ type: 'project', status: 'active' }),
      [AFTER_A_MEETING_PROMPT]: builtInPromptAt(AFTER_A_MEETING_PROMPT)!.contents,
      // Saved the day before the meeting arrived: an arrival, not a backfill.
      [RULE_FILE]: 'The rule, as its file holds it.\n',
    },
    today: TODAY,
    ageDays: { [RULE_FILE]: 1 },
    types: TYPES,
    claude,
  });
  // The GitHub vault's way (#720): a version far below the meeting's, and no time.
  const fs: typeof vault.ports.fs = {
    ...vault.ports.fs,
    readTextFile: async (path) => {
      const read = await vault.ports.fs.readTextFile(path);
      return ruleTimeUnknown && path === RULE_FILE
        ? { ...read, modified: 5, modifiedAt: null }
        : read;
    },
  };
  const run = () =>
    runAutomation({
      ports: { ...vault.ports, fs },
      rule: RULE,
      clock: CLOCK,
      guard: GUARD,
      activity: recordingActivity(),
      trigger: 'hand',
    });
  return { vault, run };
}

describe('one After a meeting run over a mix of items (#226, #185, #227)', () => {
  it('writes one meeting write of summary, task and project, and lists only what reaches the owner', async () => {
    const { vault, run } = setUp();

    await run();

    // One write to the meeting carries all three.
    expect(vault.log.filter((line) => line === `write ${MEETING}`)).toHaveLength(1);
    expect(vault.properties(MEETING)).toMatchObject({
      project: '[[Ledger]]',
      tasks: ['[[Send the renewal contract]]'],
    });
    const tasks = [...vault.files.keys()].filter((at) => vault.properties(at)['type'] === 'task');
    expect(tasks).toEqual(['Tasks/2026/10/Send the renewal contract.md']);

    // The summary lists the owner's own items and what they asked for; nothing left out.
    const reading = readSummaryBlock(splitFrontmatter(vault.files.get(MEETING)!).body);
    if (reading.kind !== 'block') throw new Error(`no block: ${reading.kind}`);
    expect(reading.text).toContain('> - Send the renewal contract: you (a task was made)');
    expect(reading.text).toContain('> - Book the review room: you (turn t0005)');
    expect(reading.text).toContain('> - Send the cache numbers: Tobias Fenn (turn t0003)');
    expect(reading.text).toContain('> - Go with the Larkspur vendor');
    expect(reading.text).not.toContain('Flag the new cache');

    // The medium item, the waiting-for and the decision are one review: one card.
    const proposals = [...vault.files.keys()].filter((at) => at.startsWith('Inbox/Proposals/'));
    expect(proposals).toEqual([
      'Inbox/Proposals/Review what 2026-10-14 Renewal review left for you.md',
    ]);
  });

  it('only proposes, and writes no task, when the vault cannot tell when the rule was saved (#720)', async () => {
    const { vault, run } = setUp({ ruleTimeUnknown: true });

    await run();

    const tasks = [...vault.files.keys()].filter((at) => vault.properties(at)['type'] === 'task');
    expect(tasks).toEqual([]);
    expect(vault.properties(MEETING)['tasks']).toBeUndefined();
    expect([...vault.files.keys()].some((at) => at.startsWith('Inbox/Proposals/'))).toBe(true);
  });

  it('logs the meeting with its tallies, and the line reads back', async () => {
    const { vault, run } = setUp();

    await run();

    const text = vault.files.get(logPathFor(RULE.id))!;
    expect(text).toContain(
      `- meeting \`"${MEETING}"\`: tasks \`1\`, proposals \`1\`, listed \`3\`, summary \`"written"\`, left out \`1\``,
    );
    const [entry] = parseRunLog(text);
    expect(entry?.kind === 'run' && entry.claude?.meetings).toEqual([
      { path: MEETING, tasks: 1, proposals: 1, listed: 3, summary: 'written', leftOut: 1 },
    ]);
  });
});
