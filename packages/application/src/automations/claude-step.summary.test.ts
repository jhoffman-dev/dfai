/**
 * #184, #185 (ADR-0036 "The summary block", "One meeting write, tasks
 * first"): the "After a meeting" rule writes a short summary at the top of
 * each meeting it reads — in the same one write as the meeting's `tasks` —
 * replaces only its own block, never the person's edits, never the
 * transcript; a long meeting is read in parts and one reduce; a write
 * refused is retried from the kept answer with no new ask; undo takes it all
 * back. Over the fake vault whose index answers with real SQL, and a
 * scripted model. The rule is the one in a vault saved before the digest
 * existed: `output: meeting-items`, `apply: mine`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AFTER_A_MEETING_PROMPT,
  builtInPromptAt,
  claudeAsks,
  createVaultPath,
  DECLARED_STEP_MODEL,
  deleteThroughLinkRefusal,
  digestOf,
  logPathFor,
  parseObjectType,
  parseRunLog,
  readSummaryBlock,
  splitFrontmatter,
  SUMMARY_CLOSE_MARKER,
  SUMMARY_OPEN_MARKER,
  transcriptDigestOf,
  type AnsweredNote,
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

const blockOf = (body: string) => {
  const reading = readSummaryBlock(body);
  if (reading.kind !== 'block') throw new Error(`no block: ${reading.kind}`);
  return reading;
};

describe('the summary at the top of a meeting', () => {
  it('is written above the provider’s Summary, in one write with the tasks, every other byte kept', async () => {
    const at = setUp([digest()]);

    const entry = await at.run();

    expect(entry?.kind).toBe('run');
    expect(at.claude.fake.requests).toHaveLength(1);
    // Sonnet, the declared step's own, whatever the chat asks.
    expect(at.claude.fake.requests[0]!.model).toBe(DECLARED_STEP_MODEL);
    const body = at.body();
    expect(
      body.startsWith(
        `\n${SUMMARY_OPEN_MARKER}\n\n> [!summary] Summary by Claude (${DECLARED_STEP_MODEL}, ${TODAY})\n`,
      ),
    ).toBe(true);
    // The provider's sections and the transcript are as they were, byte for byte.
    expect(body.endsWith(BODY.slice(1))).toBe(true);
    const block = blockOf(body);
    expect(block.text).toContain(
      '> Mara Quill and Tobias Fenn agreed to ship the new cache behind a flag before Friday.',
    );
    expect(block.text).toContain('> - The new cache is ready');
    expect(block.text).toContain('> - Ship the cache behind a flag');
    expect(block.text).toContain('> - Write the rollout note: you (a task was made)');
    // Someone else's item the owner did not ask for is left out of the summary too (#226).
    expect(block.text).not.toContain('Flag the new cache');
    expect(block.text).toContain('> - Who tells the support team?');
    expect(block.text).not.toMatch(/\[\[|- \[ \]/);
    // Its keys, and the task made joined, in the one write.
    const [task] = at.tasks();
    expect(task).toBeDefined();
    expect(at.properties()).toMatchObject({
      atlas_summary_digest: block.digest,
      atlas_summary_of: transcriptDigestOf(at.meeting()),
      atlas_summary_model: DECLARED_STEP_MODEL,
      tasks: ['[[Write the rollout note]]'],
    });
    expect(at.writesToMeeting()).toBe(1);
    // The task links back.
    expect(at.vault.properties(task!)).toMatchObject({ meeting: '[[Platform weekly sync]]' });
    // On record: what it wrote, and what it made.
    const [ran] = at.entries();
    expect(ran?.kind === 'run' && ran.done).toEqual(
      expect.arrayContaining([
        { kind: 'summarised', path: SYNC, digest: block.digest },
        expect.objectContaining({ kind: 'created', path: task, digest: expect.any(String) }),
      ]),
    );
    expect(ran?.kind === 'run' && ran.claude?.meetings).toEqual([
      { path: SYNC, tasks: 1, proposals: 1, listed: 1, summary: 'written', leftOut: 1 },
    ]);
    expect(at.vault.files.get(logPathFor(RULE.id))).toMatch(
      /Summary written by claude-sonnet-5-5 in \d+ s for Platform weekly sync; 1 task made, 1 item listed, 1 proposal, left out 1 item\./,
    );
  });

  it('is not asked for again while the transcript is the same: a second run asks nothing and writes nothing', async () => {
    const at = setUp([digest()]);
    await at.run();
    const written = at.meeting();
    const writes = at.vault.log.length;

    await at.run();

    expect(at.claude.fake.requests).toHaveLength(1);
    expect(at.meeting()).toBe(written);
    expect(at.vault.log.slice(writes).filter((line) => line.startsWith('write Meetings'))).toEqual(
      [],
    );
  });

  it('replaces only its own block when the words change, shown the meeting without it, never two blocks', async () => {
    const at = setUp([digest(), digest({ summary: 'They moved the date to Monday.', items: [] })]);
    await at.run();
    // The transcript corrected: new words.
    at.vault.files.set(SYNC, at.meeting().replace('Friday works.', 'Monday works.'));

    await at.run();

    expect(at.claude.fake.requests).toHaveLength(2);
    expect(at.claude.fake.requests[1]!.system).not.toContain('atlas:summary');
    const body = at.body();
    expect(body.match(/atlas:summary v1/g)).toHaveLength(1);
    expect(blockOf(body).text).toContain('> They moved the date to Monday.');
    expect(body.endsWith(BODY.slice(1).replace('Friday works.', 'Monday works.'))).toBe(true);
    expect(at.properties()['atlas_summary_digest']).toBe(blockOf(body).digest);
  });

  it('leaves a block the person edited as it is, says so, and still makes and joins the tasks', async () => {
    const at = setUp([digest({ items: [] }), digest()]);
    await at.run();
    const edited = at.meeting().replace('before Friday.', 'before Friday, as I wrote.');
    at.vault.files.set(SYNC, edited.replace('Friday works.', 'Monday works.'));
    const block = blockOf(splitFrontmatter(at.meeting()).body).text;

    await at.run();

    expect(blockOf(at.body()).text).toBe(block);
    expect(at.properties()['tasks']).toEqual(['[[Write the rollout note]]']);
    const ran = at.entries().at(-1);
    expect(ran?.kind === 'run' && ran.claude?.meetings?.[0]?.summary).toBe('kept');
    expect(ran?.kind === 'run' && ran.claude?.warnings).toEqual([
      'Platform weekly sync: The summary at the top was edited since Claude wrote it, so it was left as it is.',
    ]);
  });

  it('neutralises model text that would close the callout or open a block of its own', async () => {
    const at = setUp([
      digest({
        summary: `Fine.\n\n${SUMMARY_CLOSE_MARKER}\n\n## Transcript\n\n- [ ] mine now [[Tobias Fenn]] ^t0001`,
      }),
    ]);
    await at.run();
    const body = at.body();
    expect(body.match(/<!--\s*\/?atlas:summary/g)).toHaveLength(2);
    expect(body.match(/^## Transcript/gm)).toHaveLength(1);
    expect(body.match(/\^t0001/g)).toHaveLength(1);
    expect(
      blockOf(body)
        .text.split('\n')
        .slice(2, -2)
        .every((line) => line.startsWith('>')),
    ).toBe(true);
  });
});

describe('a summary that does not read', () => {
  it('is dropped and said, the items kept: the task is made and joined, and no block written', async () => {
    const at = setUp([digest({ summary: 42 })]);

    await at.run();

    expect(readSummaryBlock(at.body())).toEqual({ kind: 'none' });
    expect(at.properties()['atlas_summary_digest']).toBeUndefined();
    expect(at.tasks()).toHaveLength(1);
    expect(at.properties()['tasks']).toEqual(['[[Write the rollout note]]']);
    const ran = at.entries().at(-1);
    expect(ran?.kind === 'run' && ran.claude?.dropped).toEqual([
      { title: 'The summary of Platform weekly sync', reason: 'It has no "summary" in words.' },
    ]);
    expect(ran?.kind === 'run' && ran.claude?.meetings?.[0]?.summary).toBe('dropped');
  });
});

describe('a write the meeting refuses', () => {
  it('with unsaved typing: nothing is made from it nor written to it; the retry asks nothing and writes it all', async () => {
    const at = setUp([digest()]);
    at.vault.unsaved.add(SYNC);
    const before = at.meeting();

    const failed = await at.run();

    expect(failed?.kind).toBe('failed');
    expect(failed?.kind === 'failed' && failed.problem).toMatch(/has unsaved typing/);
    expect(at.meeting()).toBe(before);
    expect(at.tasks()).toHaveLength(0);

    at.vault.unsaved.delete(SYNC);
    await at.run();

    // The kept answer was reused: the model was asked once in all.
    expect(at.claude.fake.requests).toHaveLength(1);
    expect(at.tasks()).toHaveLength(1);
    expect(blockOf(at.body()).text).toContain('Write the rollout note: you (a task was made)');
    expect(at.properties()['tasks']).toEqual(['[[Write the rollout note]]']);
  });

  it('changed while Claude read it: the task is made, nothing written to the meeting; the retry joins it and writes the summary, asking nothing', async () => {
    const holder: { at?: ReturnType<typeof setUp> } = {};
    const typed = async function* (): AsyncIterable<ModelEvent> {
      // The person types into the meeting's Notes while Claude is reading it: no new words said.
      const { vault, meeting } = holder.at!;
      await vault.ports.fs.writeTextFile({
        path: createVaultPath(SYNC),
        contents: meeting().replace('## Notes\n', '## Notes\n\nA line of my own.\n'),
        expectedModified: null,
      });
      yield* digest();
    };
    const at = setUp([typed]);
    holder.at = at;

    const failed = await at.run();

    expect(failed?.kind === 'failed' && failed.problem).toMatch(/changed while Claude read it/);
    expect(at.meeting()).toContain('A line of my own.');
    expect(readSummaryBlock(at.body())).toEqual({ kind: 'none' });
    expect(at.tasks()).toHaveLength(1);
    expect(at.properties()['tasks']).toBeUndefined();

    await at.run();

    expect(at.claude.fake.requests).toHaveLength(1);
    expect(at.tasks()).toHaveLength(1);
    expect(blockOf(at.body()).text).toContain('> Mara Quill and Tobias Fenn agreed');
    expect(at.meeting()).toContain('A line of my own.');
    expect(at.properties()['tasks']).toEqual(['[[Write the rollout note]]']);
  });

  it('a task that cannot be made: the run fails and no summary is written', async () => {
    const at = setUp([digest()]);
    const { fs } = at.vault.ports;
    const createNote = fs.createNote.bind(fs);
    Object.assign(fs, {
      createNote: async (write: { path: string; contents: string }) => {
        if (write.path.includes('rollout note')) throw new Error('the disk is full');
        return createNote(write as Parameters<typeof createNote>[0]);
      },
    });

    await expect(at.run()).rejects.toThrow('the disk is full');

    const [failed] = at.entries();
    expect(failed?.kind).toBe('failed');
    expect(readSummaryBlock(at.body())).toEqual({ kind: 'none' });
    expect(at.properties()['atlas_summary_digest']).toBeUndefined();
    expect(at.writesToMeeting()).toBe(0);
  });
});

describe('a long meeting', () => {
  /** The fixture with `turns` more turns of about 400 characters each. */
  const longBody = (turns: number) => {
    let body = BODY;
    for (let id = 5; id < 5 + turns; id += 1) {
      body += `\n**Tobias Fenn** [~00:10:00] Turn ${id}. ${'word '.repeat(75)}^t${String(id).padStart(4, '0')}\n`;
    }
    return body;
  };
  const partsOf = (body: string) =>
    claudeAsks(
      [
        {
          path: createVaultPath(SYNC),
          text: meetingWith(body),
          meeting: { identity: null, attendees: [] },
        } as AnsweredNote,
      ],
      { inParts: true, asks: 100 },
    ).asks.length;
  const part = (at: number): ModelEvent[] => [
    {
      type: 'text',
      text: JSON.stringify({
        summary: `Part ${at} said this.`,
        key_points: [`Point ${at}`],
        open_questions: [],
        items: [],
      }),
    },
  ];
  const reduced: ModelEvent[] = [
    {
      type: 'text',
      text: JSON.stringify({
        summary: 'The whole meeting, merged.',
        key_points: ['All of it'],
        open_questions: [],
      }),
    },
  ];

  it('is read in two parts and one reduce over their summaries, whose summary is written', async () => {
    let turns = 1;
    while (partsOf(longBody(turns)) < 2) turns += 5;
    const at = setUp([part(1), part(2), reduced], {
      ...NOTES,
      [SYNC]: meetingWith(longBody(turns)),
    });

    await at.run();

    const requests = at.claude.fake.requests;
    expect(requests).toHaveLength(3);
    const reduce = requests[2]!.system;
    expect(reduce).toContain('One summary of a long meeting');
    expect(reduce).toContain('Part 1 of 2\nSummary: Part 1 said this.');
    expect(reduce).toContain('Part 2 of 2\nSummary: Part 2 said this.');
    expect(reduce).not.toContain('^t0001');
    expect(blockOf(at.body()).text).toContain('> The whole meeting, merged.');
  });

  it('is read in at most nine parts and one reduce: ten asks', async () => {
    const body = longBody(1000);
    expect(partsOf(body)).toBeGreaterThan(9);
    const at = setUp([...Array.from({ length: 9 }, (_, at) => part(at + 1)), reduced], {
      ...NOTES,
      [SYNC]: meetingWith(body),
    });

    await at.run();

    expect(at.claude.fake.requests).toHaveLength(10);
    expect(blockOf(at.body()).text).toContain('> The whole meeting, merged.');
    const ran = at.entries().at(-1);
    expect(ran?.kind === 'run' && ran.claude?.asks).toBe(10);
    expect(ran?.kind === 'run' && ran.claude?.cut).toHaveLength(1);
  });

  it('a reduce that does not read: the summary is dropped and the parts’ items kept', async () => {
    let turns = 1;
    while (partsOf(longBody(turns)) < 2) turns += 5;
    const at = setUp([part(1), part(2), [{ type: 'text', text: 'not json' }]], {
      ...NOTES,
      [SYNC]: meetingWith(longBody(turns)),
    });

    const entry = await at.run();

    expect(entry?.kind).toBe('run');
    expect(readSummaryBlock(at.body())).toEqual({ kind: 'none' });
    expect(entry?.kind === 'run' && entry.claude?.dropped).toEqual([
      { title: 'The summary of Platform weekly sync', reason: 'It is not JSON.' },
    ]);
  });

  it('a retry reuses the parts and the reduce kept from a run that could not write: no ask', async () => {
    let turns = 1;
    while (partsOf(longBody(turns)) < 2) turns += 5;
    const at = setUp([part(1), part(2), reduced], {
      ...NOTES,
      [SYNC]: meetingWith(longBody(turns)),
    });
    at.vault.unsaved.add(SYNC);
    expect((await at.run())?.kind).toBe('failed');
    at.vault.unsaved.delete(SYNC);

    await at.run();

    expect(at.claude.fake.requests).toHaveLength(3);
    expect(blockOf(at.body()).text).toContain('> The whole meeting, merged.');
  });
});

describe('Undo last run', () => {
  it('takes the block and its keys out, and trashes the task it made with its link, while unchanged', async () => {
    const at = setUp([digest()]);
    const before = at.meeting();
    await at.run();
    const [task] = at.tasks();

    const undone = (await at.undo()) as Extract<LogEntry, { kind: 'undo' }> | null;

    expect(undone?.kind).toBe('undo');
    expect(undone?.done).toEqual([
      { kind: 'trashed', path: task },
      { kind: 'unsummarised', path: SYNC },
    ]);
    expect(at.body()).toBe(splitFrontmatter(before).body);
    expect(at.properties()).not.toHaveProperty('atlas_summary_digest');
    expect(at.properties()).not.toHaveProperty('atlas_summary_of');
    expect(at.properties()).not.toHaveProperty('atlas_summary_model');
    expect(at.properties()).not.toHaveProperty('tasks');
    expect(at.vault.files.has(task!)).toBe(false);
  });

  it('leaves a task the host will not trash through a link, saying why, and logs the rest (#685)', async () => {
    const at = setUp([digest()]);
    await at.run();
    const [task] = at.tasks();
    const refusal = deleteThroughLinkRefusal(createVaultPath('Tasks'));
    at.vault.ports.fs.trashEntry = async () => {
      throw new VaultAccessError(refusal);
    };

    const undone = (await at.undo()) as Extract<LogEntry, { kind: 'undo' }> | null;

    expect(undone?.done).toEqual([{ kind: 'unsummarised', path: SYNC }]);
    expect(undone?.left).toContainEqual({ path: task, reason: refusal });
    expect(at.vault.files.has(task!)).toBe(true);
    const logged = at.entries().at(-1);
    expect(logged?.kind === 'undo' && logged.left).toContainEqual({ path: task, reason: refusal });
  });

  it('keeps a task changed since, and its link, and a block edited since', async () => {
    const at = setUp([digest()]);
    await at.run();
    const [task] = at.tasks();
    at.vault.files.set(task!, `${at.vault.files.get(task!)}\nMy notes on it.\n`);
    at.vault.files.set(SYNC, at.meeting().replace('flag before Friday.', 'flag before Friday!'));

    const undone = (await at.undo()) as Extract<LogEntry, { kind: 'undo' }> | null;

    expect(undone?.done).toEqual([]);
    const left = new Map<string, string>(undone?.left.map(({ path, reason }) => [path, reason]));
    expect(left.get(task!)).toBe('It was changed since the run made it, so it was kept.');
    expect(left.get(createVaultPath(SYNC))).toBe(
      'The summary at the top was edited since Claude wrote it, so it was left as it is.',
    );
    expect(at.vault.files.has(task!)).toBe(true);
    expect(at.body()).toContain('flag before Friday!');
    expect(at.properties()['tasks']).toEqual(['[[Write the rollout note]]']);
  });
});

const taskNamed = (at: ReturnType<typeof setUp>, words: string) =>
  [...at.vault.files.keys()].filter(
    (path) => at.vault.properties(path)['type'] === 'task' && path.includes(words),
  );

const RETRO = 'Meetings/Platform retro.md';
const retroWith = (body: string) =>
  jsonNote(
    { ...HEADER, title: 'Platform retro', external_id: 'gemini-0b1d2e3f', date: '2026-10-10' },
    body,
  );
/** A meeting written into the vault as a sync would: a new file, with its modified time. */
const arrives = (at: ReturnType<typeof setUp>, contents: string) =>
  at.vault.ports.fs.createNote({ path: createVaultPath(RETRO), contents });
const RETRO_ITEM = {
  kind: 'task',
  title: 'Send the cache numbers',
  owner: 'Mara Quill',
  source_block: 't0003',
  confidence: 'high',
};

describe('Undo last run reaches the last run, even one that wrote no summary', () => {
  it('a later run that made a task but wrote no summary (it did not read) is the one undone', async () => {
    const at = setUp([digest(), digest({ summary: 42, items: [RETRO_ITEM] })]);
    await at.run();
    const firstBlock = blockOf(at.body()).text;
    // A second meeting arrives; Claude's summary of it does not read, its item is made a task.
    await arrives(at, retroWith(BODY));
    await at.run();
    expect(taskNamed(at, 'cache numbers')).toHaveLength(1);

    await at.undo();

    // The last run's task goes, and its link off the meeting; the first run's summary and task stay.
    expect(taskNamed(at, 'cache numbers')).toHaveLength(0);
    expect(JSON.stringify(at.vault.properties(RETRO)['tasks'] ?? [])).not.toContain(
      'cache numbers',
    );
    expect(taskNamed(at, 'rollout note')).toHaveLength(1);
    expect(blockOf(at.body()).text).toBe(firstBlock);
  });

  it('a later run whose summary was kept (the meeting holds a pasted block) is the one undone', async () => {
    const at = setUp([digest(), digest({ items: [RETRO_ITEM] })]);
    await at.run();
    const firstBlock = blockOf(at.body()).text;
    // The person pasted last week's summary into the new meeting's Notes before the run.
    await arrives(at, retroWith(BODY.replace('## Notes\n', `## Notes\n\n${firstBlock}\n`)));
    await at.run();
    expect(taskNamed(at, 'cache numbers')).toHaveLength(1);

    await at.undo();

    expect(taskNamed(at, 'cache numbers')).toHaveLength(0);
    expect(taskNamed(at, 'rollout note')).toHaveLength(1);
    expect(blockOf(at.body()).text).toBe(firstBlock);
  });
});

describe('Undo of a run that replaced a summary', () => {
  it('puts the summary it replaced back, with its keys', async () => {
    const at = setUp([digest(), digest({ summary: 'They moved the date to Monday.', items: [] })]);
    await at.run();
    const first = { block: blockOf(at.body()).text, properties: at.properties() };
    // The transcript corrected: new words, so the next run writes a new summary over the old.
    at.vault.files.set(SYNC, at.meeting().replace('Friday works.', 'Monday works.'));
    await at.run();
    expect(blockOf(at.body()).text).toContain('Monday');

    const undone = (await at.undo()) as Extract<LogEntry, { kind: 'undo' }> | null;

    expect(undone?.done).toEqual([{ kind: 'unsummarised', path: SYNC }]);
    expect(blockOf(at.body()).text).toBe(first.block);
    for (const key of ['atlas_summary_digest', 'atlas_summary_of', 'atlas_summary_model']) {
      expect(at.properties()[key]).toBe(first.properties[key]);
    }
    // The person's own change to the transcript is theirs: undo leaves it.
    expect(at.body()).toContain('Monday works.');
  });
});

describe('Undo with a summary block the person edited', () => {
  it('never leaves the meeting’s tasks linking a task it trashed', async () => {
    const at = setUp([digest()]);
    await at.run();
    const [task] = at.tasks();
    // Only the block is edited; the task is as made.
    at.vault.files.set(SYNC, at.meeting().replace('flag before Friday.', 'flag before Friday!'));

    await at.undo();

    const trashed = !at.vault.files.has(task!);
    const linked = JSON.stringify(at.properties()['tasks'] ?? []).includes(
      'Write the rollout note',
    );
    expect(trashed && linked).toBe(false);
  });
});

describe('Undo of a meeting being typed in', () => {
  it('trashes none of its tasks and takes nothing off it, saying why', async () => {
    const at = setUp([digest()]);
    await at.run();
    const [task] = at.tasks();
    const before = at.meeting();
    at.vault.unsaved.add(SYNC);

    const undone = (await at.undo()) as Extract<LogEntry, { kind: 'undo' }> | null;

    expect(undone?.done).toEqual([]);
    const left = new Map<string, string>(undone?.left.map(({ path, reason }) => [path, reason]));
    expect(left.get(createVaultPath(SYNC))).toMatch(/has unsaved typing/);
    expect(left.get(task!)).toMatch(
      /^Its meeting was left as it is, so it was kept: .*unsaved typing/,
    );
    expect(at.vault.files.has(task!)).toBe(true);
    expect(at.meeting()).toBe(before);
  });
});

describe('a run log someone else wrote into (A25-01)', () => {
  it('Undo trashes only a task the rule made, never another note a log line names', async () => {
    const at = setUp([digest()]);
    await at.run();
    const [task] = at.tasks();
    const person = 'People/Tobias Fenn.md';
    const log = logPathFor(RULE.id);
    // A sync tool or another program rewrites the "created" line to name a person's note, as it is now.
    const forged = at.vault.files
      .get(log)!
      .replace(
        /- created `"[^`]*"` at `"[^`]*"`/,
        `- created \`"${person}"\` at \`"${digestOf(at.vault.files.get(person)!)}"\``,
      );
    expect(forged).toContain(person);
    at.vault.files.set(log, forged);

    await at.undo();

    expect(at.vault.files.has(person)).toBe(true);
    expect(task).toBeDefined();
  });
});

describe('a meeting filed under a project in the run that summarises it (#227, #171)', () => {
  const LEDGER = {
    path: 'Projects/Ledger.md',
    confidence: 'high',
    why: 'Its people run the ledger.',
  };
  const withLedger = {
    ...NOTES,
    'Projects/Ledger.md': jsonNote({ type: 'project', status: 'active' }),
  };

  it('writes the summary, the tasks and the project in one write, and the rerun after the words change replaces the block and leaves the project', async () => {
    const at = setUp(
      [
        digest({ project: LEDGER }),
        digest({ summary: 'They moved the date to Monday.', items: [] }),
      ],
      withLedger,
    );

    await at.run();

    expect(at.writesToMeeting()).toBe(1);
    expect(at.properties()).toMatchObject({
      atlas_summary_digest: blockOf(at.body()).digest,
      tasks: ['[[Write the rollout note]]'],
      project: '[[Ledger]]',
    });
    const [ran] = at.entries();
    expect(ran?.kind === 'run' && ran.done).toEqual(
      expect.arrayContaining([
        {
          kind: 'set',
          path: SYNC,
          key: 'project',
          before: { absent: true },
          after: { value: '[[Ledger]]' },
        },
      ]),
    );
    expect(ran?.kind === 'run' && ran.claude?.warnings).toBeUndefined();

    at.vault.files.set(SYNC, at.meeting().replace('Friday works.', 'Monday works.'));
    await at.run();

    expect(blockOf(at.body()).text).toContain('> They moved the date to Monday.');
    expect(at.body().match(/atlas:summary v1/g)).toHaveLength(1);
    expect(at.properties()['project']).toBe('[[Ledger]]');
  });

  it('is taken back, all three, in one write by Undo last run', async () => {
    const at = setUp([digest({ project: LEDGER })], withLedger);
    await at.run();
    const writes = at.writesToMeeting();

    const undone = (await at.undo()) as Extract<LogEntry, { kind: 'undo' }> | null;

    expect(at.writesToMeeting()).toBe(writes + 1);
    expect(at.body().includes('atlas:summary')).toBe(false);
    expect(at.properties()).not.toHaveProperty('project');
    expect(at.properties()).not.toHaveProperty('atlas_summary_digest');
    expect(at.properties()['tasks'] ?? []).toEqual([]);
    expect(at.tasks()).toEqual([]);
    expect(undone?.done).toEqual(
      expect.arrayContaining([
        {
          kind: 'restored',
          path: SYNC,
          key: 'project',
          before: { value: '[[Ledger]]' },
          after: { absent: true },
        },
        { kind: 'unsummarised', path: SYNC },
      ]),
    );
  });

  it('restores the prior summary and clears the project, when the run replaced a summary', async () => {
    const at = setUp(
      [digest(), digest({ summary: 'They moved the date to Monday.', items: [], project: LEDGER })],
      withLedger,
    );
    await at.run();
    const first = blockOf(at.body()).text;
    at.vault.files.set(SYNC, at.meeting().replace('Friday works.', 'Monday works.'));
    await at.run();
    expect(at.properties()['project']).toBe('[[Ledger]]');

    await at.undo();

    expect(blockOf(at.body()).text).toBe(first);
    expect(at.properties()).not.toHaveProperty('project');
  });
});
