/**
 * The "After a meeting" rule makes the owner's own action items into tasks,
 * linked both ways, and proposes the rest (#180, ADR-0036): over a vault held
 * in memory whose index answers with real SQL, read and written through the
 * real YAML adapter, with a scripted model. All names are made up.
 */
import { describe, expect, it } from 'vitest';
import {
  acceptProposalNote,
  fakeClaudeStepPorts,
  recordingActivity,
  runAutomation,
  runOnNoteChanges,
  type FreshPullCheck,
} from '@dfai/application';
import { automationVault } from '@dfai/application/testing/sqlite';
import {
  AFTER_A_MEETING_PROMPT,
  builtInPromptAt,
  createVaultPath,
  digestOf,
  parseObjectType,
  type AutomationRule,
  type NoteChange,
} from '@dfai/domain';
import { remarkMarkdown } from './markdown-port.ts';

// Adversarial pass on #180 (uncommitted): each test below fails on 570df09 and names a P2 defect.

const TODAY = '2026-10-14';
const CLOCK = {
  today: () => TODAY,
  localNow: () => `${TODAY}T13:00:00`,
  now: () => Date.parse(`${TODAY}T13:00:00Z`),
};
const VAULT = '/vaults/home';
const GUARD = { vault: VAULT, currentVault: () => VAULT };

const MEETING = 'Meetings/2026-10-14 Renewal review.md';
const PROPOSALS = 'Inbox/Proposals/';
const RULE_FILE = '.atlas/automations/After a meeting.md';

const RULE: AutomationRule = {
  id: 'After a meeting',
  path: createVaultPath(RULE_FILE),
  name: 'After a meeting',
  enabled: true,
  when: { kind: 'note', type: 'meeting', on: ['created'] },
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

const TYPES = [
  parseObjectType({ name: 'task', label: 'Task', properties: { status: 'text' } }),
  parseObjectType({ name: 'meeting', label: 'Meeting', properties: { date: 'date' } }),
];

const MEETING_TYPE = [
  '---',
  'name: meeting',
  'properties:',
  '  tasks:',
  '    kind: relation',
  '    target: task',
  '    many: true',
  '---',
  '',
].join('\n');

const TRANSCRIPT = [
  '**Mara Quill** [~00:00:10] I’ll send the renewal contract by Friday. ^t0001',
  '',
  '**Tobias Fenn** [~00:00:20] I’ll flag the new cache. ^t0002',
  '',
  '**Mara Quill** [~00:00:30] And I’ll book the review room. ^t0003',
  '',
];

const meetingFile = (transcript: readonly string[] = TRANSCRIPT) =>
  [
    '---',
    'type: meeting',
    'atlas_import: meeting/v1',
    'atlas_import_outcome: imported',
    'title: Renewal review',
    "date: '2026-10-14'",
    "start: '09:30'",
    'provider: granola',
    'external_id: granola-5c1d',
    'attendees:',
    '  - name: Mara Quill',
    '    email: mara.quill@example.com',
    '  - name: Tobias Fenn',
    '    email: tobias.fenn@example.com',
    '---',
    '',
    '## Summary',
    '',
    'The renewal goes ahead.',
    '',
    '## Transcript',
    '',
    ...transcript,
  ].join('\n');

const OWNERS_SEND = {
  kind: 'task',
  title: 'Send the renewal contract',
  owner: 'You',
  source_block: 't0001',
  confidence: 'high',
};
const TOBIAS_FLAG = {
  kind: 'task',
  title: 'Flag the new cache',
  owner: 'Tobias Fenn',
  source_block: 't0002',
  confidence: 'high',
};
const OWNERS_BOOK = {
  kind: 'task',
  title: 'Book the review room',
  owner: 'You',
  source_block: 't0003',
  // A task is made only at high (#226).
  confidence: 'high',
};

const answer = (...items: unknown[]) => [
  { type: 'text' as const, text: JSON.stringify({ items }) },
];
const TWO_MINE_ONE_TOBIAS = answer(OWNERS_SEND, TOBIAS_FLAG, OWNERS_BOOK);

function setUp({
  rounds = [TWO_MINE_ONE_TOBIAS],
  owner = 'Mara Quill',
  ruleAgeDays = 1,
}: {
  rounds?: ReturnType<typeof answer>[];
  /** The owner's profile name; null for a vault that does not say who its owner is. */
  owner?: string | null;
  /** How long ago the rule's file was written; the meeting arrived today. */
  ruleAgeDays?: number;
} = {}) {
  const claude = fakeClaudeStepPorts({
    rounds,
    today: TODAY,
    selfName: owner,
    selfEmails: owner === null ? [] : ['mara.quill@example.com'],
  });
  const vault = automationVault({
    notes: {
      [MEETING]: meetingFile(),
      [RULE_FILE]: '---\natlas: automation\n---\n',
      [AFTER_A_MEETING_PROMPT]: builtInPromptAt(AFTER_A_MEETING_PROMPT)!.contents,
      '.atlas/types/meeting.md': MEETING_TYPE,
    },
    today: TODAY,
    ageDays: { [RULE_FILE]: ruleAgeDays, [AFTER_A_MEETING_PROMPT]: ruleAgeDays },
    types: TYPES,
    claude,
    markdown: remarkMarkdown,
  });
  const activity = recordingActivity();
  const run = { ports: vault.ports, rule: RULE, clock: CLOCK, guard: GUARD, activity };
  const arrived = (freshPull?: FreshPullCheck) => {
    const change: NoteChange = {
      kind: 'added',
      path: MEETING,
      type: 'meeting',
      digest: digestOf(vault.files.get(MEETING) ?? ''),
    };
    return runOnNoteChanges({
      ...run,
      changes: [change],
      ...(freshPull !== undefined && { freshPull }),
    });
  };
  const runNow = () => runAutomation({ ...run, trigger: 'hand' });
  const notesIn = (prefix: string) => [...vault.files.keys()].filter((at) => at.startsWith(prefix));
  const tasks = () =>
    [...vault.files.keys()].filter((at) => vault.properties(at)['type'] === 'task').sort();
  const asked = () => claude.fake.requests.length;
  return { vault, activity, arrived, runNow, notesIn, tasks, asked };
}

describe('adversarial: the owner’s items on a retry (#180)', () => {
  it('loses the owner’s item when Run now comes while the index still lists a task the failed run took back', async () => {
    const { vault, arrived, runNow, tasks } = setUp({
      rounds: [TWO_MINE_ONE_TOBIAS, TWO_MINE_ONE_TOBIAS],
    });
    const query = vault.ports.index.query;
    let stale: Awaited<ReturnType<typeof query>> | null = null;
    vault.ports.fs.trashEntry = async ({ path }) => {
      stale = await query(
        (await import('@dfai/domain')).compileMadeItemsQuery().sql,
        (await import('@dfai/domain')).compileMadeItemsQuery().parameters as never,
      );
      vault.files.delete(path);
    };
    const create = vault.ports.fs.createNote;
    let edited = false;
    vault.ports.fs.createNote = async (write) => {
      const modified = await create(write);
      if (!edited && write.path === 'Tasks/2026/10/Book the review room.md') {
        edited = true;
        await vault.ports.fs.writeTextFile({
          path: MEETING as never,
          contents: vault.files.get(MEETING)! + '\n## Notes\n\nmine\n',
          expectedModified: null,
        });
      }
      return modified;
    };
    await arrived();
    expect(edited).toBe(true);
    vault.ports.index.query = async (sql, parameters) =>
      sql.includes('meeting items: made') && stale !== null ? stale : query(sql, parameters);
    await runNow();
    expect(tasks()).toEqual([
      'Tasks/2026/10/Book the review room.md',
      'Tasks/2026/10/Send the renewal contract.md',
    ]);
  });

  it('makes a second task for one item: a plain retry of a long meeting re-asks, and Accept takes the reworded item as new', async () => {
    const filler = Array.from(
      { length: 300 },
      (_, i) =>
        `**Tobias Fenn** [~00:${String(10 + (i % 50)).padStart(2, '0')}:00] We went over line ${i} of the renewal schedule in some detail today. ^t${String(i + 10).padStart(4, '0')}\n`,
    );
    const long = [
      ...TRANSCRIPT,
      ...filler,
      '**Mara Quill** [~00:59:00] I’ll write up the pricing memo. ^t0999',
      '',
    ];
    const MEMO = {
      kind: 'task',
      title: 'Write up the pricing memo',
      owner: 'You',
      source_block: 't0999',
      confidence: 'high',
    };
    const SECOND = 'Meetings/2026-10-14 Vendor sync.md';
    const second = meetingFile()
      .replace('Renewal review', 'Vendor sync')
      .replace('granola-5c1d', 'granola-7e2f')
      .replace('send the renewal contract by Friday', 'chase the vendor invoice');
    const CHASE = {
      kind: 'task',
      title: 'Chase the vendor invoice',
      owner: 'You',
      source_block: 't0001',
      confidence: 'high',
    };
    const { vault, runNow, tasks, asked, notesIn } = setUp({
      rounds: [
        answer(OWNERS_SEND, TOBIAS_FLAG),
        answer(MEMO),
        answer(CHASE),
        answer(OWNERS_SEND, TOBIAS_FLAG),
        answer({ ...MEMO, title: 'Draft the pricing memo' }),
        answer(CHASE),
      ],
    });
    vault.files.set(MEETING, meetingFile(long));
    vault.files.set(SECOND, second);
    const create = vault.ports.fs.createNote;
    let refuseOnce = true;
    vault.ports.fs.createNote = async (write) => {
      if (write.path === 'Tasks/2026/10/Chase the vendor invoice.md' && refuseOnce) {
        refuseOnce = false;
        throw new Error('the disk is full');
      }
      return create(write);
    };
    await runNow().catch(() => undefined);
    expect(refuseOnce).toBe(false);
    const firstAsked = asked();
    await runNow();
    // The retry reuses the answers the failed run kept: nothing is asked again.
    expect(asked()).toBe(firstAsked);
    const leftover = notesIn(PROPOSALS).find((at) =>
      vault.files.get(at)!.includes('Draft the pricing memo'),
    );
    if (leftover !== undefined) {
      await acceptProposalNote({
        via: 'app',
        ports: vault.ports,
        path: createVaultPath(leftover),
        today: TODAY,
      }).catch(() => undefined);
    }
    // One item (block t0999, the owner's) must be one task.
    expect(tasks().filter((t) => t.includes('pricing memo'))).toHaveLength(1);
  });
});
