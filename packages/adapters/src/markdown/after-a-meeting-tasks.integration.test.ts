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
  HeldForPullError,
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
  logPathFor,
  parseObjectType,
  parseRunLog,
  type AutomationRule,
  type NoteChange,
} from '@dfai/domain';
import { remarkMarkdown } from './markdown-port.ts';

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

/** The step's answer as it is asked for it (#184): a summary of the meeting, and its items. */
const answer = (...items: unknown[]) => [
  {
    type: 'text' as const,
    text: JSON.stringify({
      summary: 'The renewal is on track; the contract goes out this week.',
      key_points: [],
      open_questions: [],
      items,
    }),
  },
];
const TWO_MINE_ONE_TOBIAS = answer(OWNERS_SEND, TOBIAS_FLAG, OWNERS_BOOK);
/** What a rule that only proposes (`meeting-items`) is answered: the items alone. */
const itemsOnly = (...items: unknown[]) => [
  { type: 'text' as const, text: JSON.stringify({ items }) },
];

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

describe('a meeting that arrives after the rule', () => {
  it('makes the owner’s two items tasks, linked both ways, and leaves the other person’s out (#226)', async () => {
    const { vault, activity, arrived, notesIn, tasks } = setUp();

    const entry = await arrived();

    expect(tasks()).toEqual([
      'Tasks/2026/10/Book the review room.md',
      'Tasks/2026/10/Send the renewal contract.md',
    ]);
    for (const [task, block] of [
      ['Tasks/2026/10/Send the renewal contract.md', 't0001'],
      ['Tasks/2026/10/Book the review room.md', 't0003'],
    ] as const) {
      expect(vault.properties(task)).toMatchObject({
        type: 'task',
        status: 'inbox',
        meeting: '[[2026-10-14 Renewal review]]',
        source: `[[2026-10-14 Renewal review#^${block}]]`,
      });
      expect(vault.properties(task)['atlas_item']).toMatch(/^item-/);
    }
    expect(vault.properties(MEETING)['tasks']).toEqual([
      '[[Send the renewal contract]]',
      '[[Book the review room]]',
    ]);
    expect(notesIn(PROPOSALS)).toEqual([]);
    expect(entry).toMatchObject({ kind: 'run', claude: { asks: 1 } });
    expect(activity.reports.map((report) => report.message).join('\n')).toMatch(
      /Summary written by claude-sonnet-5-5 in \d+ s for 2026-10-14 Renewal review; 2 tasks made, 2 items listed, 0 proposals, left out 1 item\./,
    );
  });

  it('gathers the owner’s less certain items and a waiting-for they asked for into one review proposal (#226)', async () => {
    const asked = {
      kind: 'waiting',
      title: 'Flag the new cache',
      owner: 'Tobias Fenn',
      source_block: 't0002',
      confidence: 'high',
      asked_by_owner: true,
    };
    const { vault, arrived, notesIn, tasks } = setUp({
      rounds: [answer(OWNERS_SEND, asked, { ...OWNERS_BOOK, confidence: 'medium' })],
    });

    await arrived();

    expect(tasks()).toEqual(['Tasks/2026/10/Send the renewal contract.md']);
    const proposals = notesIn(PROPOSALS);
    expect(proposals).toEqual([
      'Inbox/Proposals/Review what 2026-10-14 Renewal review left for you.md',
    ]);
    const review = vault.properties(proposals[0]!);
    expect(review).toMatchObject({ kind: 'task', state: 'open', confidence: 'medium' });
    expect(review['payload']).toMatchObject({
      title: 'Review what 2026-10-14 Renewal review left for you',
      properties: { status: 'inbox', meeting: '[[2026-10-14 Renewal review]]' },
    });
    const body = (review['payload'] as { body: string }).body;
    expect(body).toContain(
      '- [ ] Waiting on Tobias Fenn: Flag the new cache [[2026-10-14 Renewal review#^t0002]]',
    );
    expect(body).toContain('- [ ] Book the review room [[2026-10-14 Renewal review#^t0003]]');
  });

  it('makes nothing at all of a meeting with only small talk and ideas', async () => {
    const idea = { ...OWNERS_BOOK, title: 'Maybe redo the office', confidence: 'low' };
    const theirs = { ...TOBIAS_FLAG, title: 'Try the new café' };
    const { arrived, notesIn, tasks, activity } = setUp({ rounds: [answer(idea, theirs)] });

    await arrived();

    expect(tasks()).toEqual([]);
    expect(notesIn(PROPOSALS)).toEqual([]);
    expect(activity.reports.map((report) => report.message).join('\n')).toMatch(
      /Summary written by claude-sonnet-5-5 in \d+ s for 2026-10-14 Renewal review; 0 tasks made, 0 items listed, 0 proposals, left out 2 items\./,
    );
  });

  it('makes nothing new when it runs again, whether the meeting is heard again or run by hand', async () => {
    const { arrived, runNow, notesIn, tasks, asked } = setUp();
    await arrived();
    const proposals = notesIn(PROPOSALS);

    expect(await arrived()).toBeNull();
    await runNow();

    expect(tasks()).toEqual([
      'Tasks/2026/10/Book the review room.md',
      'Tasks/2026/10/Send the renewal contract.md',
    ]);
    expect(notesIn(PROPOSALS)).toEqual(proposals);
    expect(asked()).toBe(1);
  });

  it('makes no task twice when Run now asks again after the transcript is corrected and the items come back in another order', async () => {
    const reordered = answer(OWNERS_BOOK, TOBIAS_FLAG, OWNERS_SEND);
    const { vault, arrived, runNow, notesIn, tasks, asked } = setUp({
      rounds: [TWO_MINE_ONE_TOBIAS, reordered],
    });
    await arrived();
    const proposals = notesIn(PROPOSALS);
    vault.files.set(
      MEETING,
      vault.files.get(MEETING)!.replace('flag the new cache', 'flag the new caches'),
    );

    const entry = await runNow();

    expect(asked()).toBe(2);
    expect(tasks()).toEqual([
      'Tasks/2026/10/Book the review room.md',
      'Tasks/2026/10/Send the renewal contract.md',
    ]);
    expect(notesIn(PROPOSALS)).toEqual(proposals);
    expect(vault.properties(MEETING)['tasks']).toHaveLength(2);
    // Nothing made: only the summary, of the corrected words, written again in place (#185).
    expect(entry).toMatchObject({
      kind: 'run',
      done: [{ kind: 'summarised', path: MEETING }],
    });
  });

  it('reuses the answer it kept when a task could not be made, asking nothing on the retry', async () => {
    const { vault, arrived, runNow, tasks, asked } = setUp();
    const create = vault.ports.fs.createNote;
    let refuseOnce = true;
    vault.ports.fs.createNote = async (write) => {
      if (write.path === 'Tasks/2026/10/Book the review room.md' && refuseOnce) {
        refuseOnce = false;
        throw new Error('the disk is full');
      }
      return create(write);
    };

    await expect(arrived()).rejects.toThrow('the disk is full');
    expect(tasks()).toEqual(['Tasks/2026/10/Send the renewal contract.md']);
    const failed = parseRunLog(vault.files.get(logPathFor(RULE.id))!).at(-1);
    expect(failed).toMatchObject({
      kind: 'failed',
      done: [{ kind: 'created', path: 'Tasks/2026/10/Send the renewal contract.md' }],
    });

    await runNow();

    expect(asked()).toBe(1);
    expect(tasks()).toEqual([
      'Tasks/2026/10/Book the review room.md',
      'Tasks/2026/10/Send the renewal contract.md',
    ]);
    expect(vault.properties(MEETING)['tasks']).toEqual([
      '[[Send the renewal contract]]',
      '[[Book the review room]]',
    ]);
  });
});

describe('an answer kept for other turns', () => {
  it('is asked again, not read against turns it never answered', async () => {
    const { vault, arrived, runNow, tasks, asked } = setUp({
      rounds: [TWO_MINE_ONE_TOBIAS, TWO_MINE_ONE_TOBIAS],
    });
    const create = vault.ports.fs.createNote;
    let refuseOnce = true;
    vault.ports.fs.createNote = async (write) => {
      if (write.path === 'Tasks/2026/10/Book the review room.md' && refuseOnce) {
        refuseOnce = false;
        throw new Error('the disk is full');
      }
      return create(write);
    };
    await expect(arrived()).rejects.toThrow('the disk is full');
    // As if the meeting were cut into parts differently now: the turns the kept answer was given about.
    const log = logPathFor(RULE.id);
    const kept = /(- stored .*: `\[.*\]` `\[")([0-9a-f]+)("\]`)/.exec(vault.files.get(log)!);
    expect(kept).not.toBeNull();
    vault.files.set(log, vault.files.get(log)!.replace(kept![0], `${kept![1]}0000${kept![3]}`));

    await runNow();

    expect(asked()).toBe(2);
    expect(tasks()).toEqual([
      'Tasks/2026/10/Book the review room.md',
      'Tasks/2026/10/Send the renewal contract.md',
    ]);
  });
});

/** A rule that reads the same meeting and only proposes: what leaves a proposal for an item made since. */
const PROPOSALS_ONLY: AutomationRule = {
  ...RULE,
  id: 'Meeting extraction',
  name: 'Meeting extraction',
  action: {
    kind: 'claude',
    prompt: AFTER_A_MEETING_PROMPT,
    tools: [],
    output: { kind: 'proposals', schema: 'meeting-items' },
  },
};

const proposeOnly = (vault: ReturnType<typeof setUp>['vault']) =>
  runAutomation({
    ports: vault.ports,
    rule: PROPOSALS_ONLY,
    clock: CLOCK,
    guard: GUARD,
    activity: recordingActivity(),
    trigger: 'hand',
  });

describe('a leftover proposal for an item already made', () => {
  it('is refused on Accept as already made, and archived, making no second task', async () => {
    const { vault, arrived, notesIn, tasks } = setUp({
      rounds: [TWO_MINE_ONE_TOBIAS, itemsOnly(OWNERS_SEND, TOBIAS_FLAG, OWNERS_BOOK)],
    });
    await arrived();
    // A rule that only proposes reads the same meeting: the owner's items come back as proposals.
    await proposeOnly(vault);
    const leftover = notesIn(PROPOSALS).find((at) =>
      vault.files.get(at)!.includes('Send the renewal contract'),
    );
    expect(leftover).toBeDefined();

    await expect(
      acceptProposalNote({
        via: 'app',
        ports: vault.ports,
        path: createVaultPath(leftover!),
        today: TODAY,
      }),
    ).rejects.toThrow('is already a task, made from the same item of the meeting');

    expect(tasks()).toEqual([
      'Tasks/2026/10/Book the review room.md',
      'Tasks/2026/10/Send the renewal contract.md',
    ]);
    expect(vault.files.has(leftover!)).toBe(false);
    expect(vault.properties(MEETING)['tasks']).toHaveLength(2);
  });

  it('is accepted as before when its item was made a task under another title', async () => {
    const { vault, arrived, notesIn, tasks } = setUp({
      rounds: [
        TWO_MINE_ONE_TOBIAS,
        itemsOnly({ ...OWNERS_SEND, title: 'Post the renewal contract' }),
      ],
    });
    await arrived();
    await proposeOnly(vault);
    const other = notesIn(PROPOSALS).find((at) =>
      vault.files.get(at)!.includes('Post the renewal contract'),
    );

    await acceptProposalNote({
      via: 'app',
      ports: vault.ports,
      path: createVaultPath(other!),
      today: TODAY,
    });

    expect(tasks()).toContain('Tasks/2026/10/Post the renewal contract.md');
  });
});

describe('a meeting whose items stay proposals', () => {
  it('makes one review of a meeting that arrived before the rule (a backfill), and no task', async () => {
    const { vault, runNow, notesIn, tasks } = setUp({ ruleAgeDays: -1 });

    await runNow();

    expect(tasks()).toEqual([]);
    const proposals = notesIn(PROPOSALS);
    expect(proposals).toHaveLength(1);
    const { body } = vault.properties(proposals[0]!)['payload'] as { body: string };
    expect(body).toContain('Send the renewal contract');
    expect(body).toContain('Book the review room');
    expect(body).not.toContain('Flag the new cache');
  });

  it('makes no task when the vault does not say who its owner is, and says why on every run (#181)', async () => {
    const { vault, arrived, runNow, notesIn, tasks, activity } = setUp({
      owner: null,
      rounds: [TWO_MINE_ONE_TOBIAS, TWO_MINE_ONE_TOBIAS],
    });

    await arrived();

    expect(tasks()).toEqual([]);
    expect(notesIn(PROPOSALS)).toHaveLength(1);
    expect(vault.properties(MEETING)['tasks']).toBeUndefined();
    const warned = () =>
      activity.reports.filter((report) =>
        report.message.includes('DFAI can’t tell which action items are yours'),
      ).length;
    expect(warned()).toBe(1);

    // New words read again: said again.
    vault.files.set(
      MEETING,
      vault.files.get(MEETING)!.replace('flag the new cache', 'flag the new caches'),
    );
    await runNow();
    expect(warned()).toBe(2);
    expect(tasks()).toEqual([]);
  });
});

describe('the gates of a fresh pull', () => {
  it('writes nothing when they shut after Claude has answered', async () => {
    const { vault, arrived, notesIn, tasks, asked } = setUp();
    const before = vault.files.get(MEETING);
    let checks = 0;
    const freshPull: FreshPullCheck = async () => (checks += 1) === 1;

    await expect(arrived(freshPull)).rejects.toBeInstanceOf(HeldForPullError);

    expect(asked()).toBe(1);
    expect(tasks()).toEqual([]);
    expect(notesIn(PROPOSALS)).toEqual([]);
    expect(vault.files.get(MEETING)).toBe(before);
    expect(vault.files.has(logPathFor(RULE.id))).toBe(false);
  });
});
