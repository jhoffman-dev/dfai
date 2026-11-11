import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DirectoryPerson } from '../meeting-links/attendee-matching.ts';
import { meetingTranscriptOf } from '../meetings/meeting-turns.ts';
import { digestOf } from '../sources/merge.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { claudeAsks } from './answered-note.ts';
import { claudeStepOutput } from './claude-step-budget.ts';
import type { ClaudeAction } from './claude-step.ts';
import { decideMeetingItems } from './meeting-item-apply.ts';
import {
  DIGEST_REDUCE_INSTRUCTIONS,
  digestReduceData,
  MEETING_DIGEST_OUTPUT,
  meetingSummaryOf,
  partSummaries,
  readDigestReduce,
  reducePartMark,
  summarisedAlready,
  summaryListing,
  transcriptDigestOf,
} from './meeting-digest.ts';
import type {
  AnsweredNote,
  AnswerContext,
  AnswerVault,
  SummaryReading,
} from './proposal-schema.ts';
import { proposalSchemaNamed } from './proposal-schemas.ts';

/**
 * #184: the `meeting-digest` output — a meeting's summary and its action
 * items in one answer — read against the Gemini fixture. Its items are read
 * and owned exactly as `meeting-items` reads them; its summary is dropped,
 * never the answer, when it does not read.
 */

const fixture = (name: string) =>
  readFileSync(new URL(`../meetings/fixtures/valid/${name}`, import.meta.url), 'utf8');

const GEMINI: AnsweredNote = {
  path: createVaultPath('Inbox/Meetings/Platform weekly sync.md'),
  text: fixture('gemini-platform-sync.md'),
  meeting: {
    identity: { provider: 'gemini', externalId: 'gemini-7f3a9c21' },
    date: '2026-09-29',
    attendees: [
      { name: 'Mara Quill', email: 'mara.quill@example.com', group: false },
      { name: 'Tobias Fenn', email: 'tobias.fenn@example.com', group: false },
    ],
  },
};
const person = (name: string): DirectoryPerson => ({
  path: createVaultPath(`People/${name}.md`),
  name,
  emails: [],
  aliases: [],
  company: null,
});
const VAULT: AnswerVault = {
  selfName: 'Mara Quill',
  selfEmails: [],
  people: [person('Mara Quill'), person('Tobias Fenn')],
  notePaths: [GEMINI.path, createVaultPath('People/Tobias Fenn.md')],
  terms: ['Larkspur Pay'],
};
const CONTEXT: AnswerContext = { notes: [GEMINI], vault: VAULT };

const digest = proposalSchemaNamed(MEETING_DIGEST_OUTPUT)!;
const items = proposalSchemaNamed('meeting-items')!;

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
  summary: 'Mara Quill and Tobias Fenn agreed to ship the new cache behind a flag.',
  key_points: ['The cache is ready', 'Tobias wants a flag first'],
  open_questions: ['Who tells support?'],
};
const answer = (fields: Record<string, unknown>) =>
  JSON.stringify({ ...SUMMARY, items: ITEMS, ...fields });
const readDigest = (fields: Record<string, unknown> = {}) => {
  const reading = digest.read(answer(fields), CONTEXT);
  if (!reading.ok) throw new Error(reading.problem);
  return reading;
};

describe('the meeting-digest output', () => {
  it('is registered beside meeting-items, which stays, and reads meetings in parts', () => {
    expect(digest.name).toBe('meeting-digest');
    expect(items.name).toBe('meeting-items');
    expect(digest.readsInParts).toBe(true);
    expect(digest.readsVault).toBe(true);
    expect(digest.summarises).toBe(true);
    expect(items.summarises).toBe(false);
    expect(digest.meetingRelations).toEqual(items.meetingRelations);
  });

  it('tells the model to answer with the summary before the items, and what a summary is', () => {
    expect(digest.instructions).toMatch(
      /^Answer with JSON only, and nothing around it: \{ "summary": …, "key_points": …, "open_questions": …, "items": \[ … \] \}, at most 25 items\./,
    );
    expect(digest.instructions).toContain('at most 150 words');
    expect(digest.instructions).toContain('no greeting');
    expect(digest.instructions).toContain(
      'If there is nothing to propose, answer the rest with "items": [].',
    );
    // The list's own instructions are meeting-items' to the letter.
    expect(items.instructions).toMatch(
      /^Answer with JSON only, and nothing around it: \{ "items": \[ … \] \}/,
    );
    expect(digest.instructions).toContain(items.instructions.split('\n')[1]!);
  });

  it('reads its items exactly as meeting-items does, by the same owner rules', () => {
    const asDigest = readDigest();
    const asItems = items.read(JSON.stringify({ items: ITEMS }), CONTEXT);
    if (!asItems.ok) throw new Error(asItems.problem);
    expect(asDigest.value).toEqual(asItems.value);
    expect(asDigest.summary).toEqual({
      kind: 'read',
      value: {
        summary: SUMMARY.summary,
        keyPoints: SUMMARY.key_points,
        openQuestions: SUMMARY.open_questions,
      },
    });
  });

  it('keeps the items and drops the summary when the summary does not read', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ summary: 42 }, /no "summary" in words/],
      [{ summary: '   ' }, /no "summary" in words/],
      [{ summary: 'x'.repeat(3_000_000) }, /"summary" is 3000000 characters/],
      [{ key_points: 'one' }, /"key_points" is not a list of text/],
      [{ key_points: [1, 2] }, /"key_points" is not a list of text/],
      [{ open_questions: Array.from({ length: 26 }, () => 'q?') }, /"open_questions" has 26 lines/],
      [{ key_points: ['y'.repeat(1_001)] }, /A line of its "key_points" is 1001 characters/],
      [{ summary: 'See ![chart](https://example.com/chart.png)' }, /remote picture/],
      [{ key_points: ['<img src="https://example.com/x.png">'] }, /loads or embeds/],
    ];
    for (const [fields, problem] of cases) {
      const reading = readDigest(fields);
      expect(reading.value).toHaveLength(3);
      expect(reading.summary?.kind).toBe('dropped');
      if (reading.summary?.kind === 'dropped') expect(reading.summary.problem).toMatch(problem);
    }
  });

  it('reads an answer with no summary at all as one given before it summarised', () => {
    const reading = digest.read(JSON.stringify({ items: ITEMS }), CONTEXT);
    expect(reading.ok && reading.summary).toEqual({ kind: 'absent' });
  });

  it('refuses the answer whole for what refuses any answer: a key it was not asked for, 26 items', () => {
    expect(digest.read(answer({ verdict: 'fine' }), CONTEXT)).toEqual({
      ok: false,
      problem: expect.stringContaining('“verdict”') as unknown as string,
    });
    const many = Array.from({ length: 26 }, (_, at) => ({ ...ITEMS[0], title: `Item ${at}` }));
    expect(digest.read(answer({ items: many }), CONTEXT)).toMatchObject({
      ok: false,
      problem: 'It made 26 proposals; one run makes at most 25.',
    });
    expect(digest.read('not json', CONTEXT)).toEqual({ ok: false, problem: 'It is not JSON.' });
  });

  it('keeps summary text that would close the callout or a marker as words: the block makes it plain', () => {
    const reading = readDigest({ summary: 'Done. <!-- /atlas:summary -->\n\n## Transcript' });
    expect(reading.summary).toMatchObject({ kind: 'read' });
  });
});

describe('the answer that summarises and chooses a project (#227, #171)', () => {
  const LEDGER = createVaultPath('Projects/Ledger.md');
  const CHOOSING: AnswerContext = {
    ...CONTEXT,
    vault: {
      ...VAULT,
      projects: [{ path: LEDGER, title: 'Ledger', para: 'project' }],
    },
  };
  const choice = { path: LEDGER, confidence: 'high', why: 'Its people run the ledger.' };

  it('accepts an answer carrying a summary and a project, and reads both', () => {
    const reading = digest.read(answer({ project: choice }), CHOOSING);
    if (!reading.ok) throw new Error(reading.problem);
    expect(reading.summary?.kind).toBe('read');
    expect(reading.project).toMatchObject({ project: LEDGER, confidence: 'high' });
  });

  it('tells the model of the summary keys and of the project', () => {
    expect(digest.instructions).toContain('"summary": …');
    expect(digest.instructions).toContain('"project"');
  });
});

describe('the reduce', () => {
  const part = (summary: string): SummaryReading => ({
    kind: 'read',
    value: { summary, keyPoints: [`${summary} point`], openQuestions: [] },
  });

  it('is asked only for a meeting read in more than one part, all of whose summaries read', () => {
    expect(partSummaries([part('one')])).toEqual([
      { summary: 'one', keyPoints: ['one point'], openQuestions: [] },
    ]);
    expect(partSummaries([part('one'), { kind: 'dropped', problem: 'bad' }])).toBeNull();
    expect(partSummaries([part('one'), { kind: 'absent' }])).toBeNull();
  });

  it('gives one meeting one summary: the one part’s, else the reduce’s, never a part’s alone', () => {
    expect(meetingSummaryOf([part('one')], null)).toEqual(part('one'));
    expect(meetingSummaryOf([part('one'), part('two')], part('both'))).toEqual(part('both'));
    expect(meetingSummaryOf([part('one'), part('two')], null)).toMatchObject({ kind: 'dropped' });
    expect(
      meetingSummaryOf(
        Array.from({ length: 9 }, (_, at) => part(`p${at}`)),
        part('all nine'),
      ),
    ).toEqual(part('all nine'));
    expect(meetingSummaryOf([part('one'), { kind: 'dropped', problem: 'bad' }], null)).toEqual({
      kind: 'dropped',
      problem: 'bad',
    });
    expect(meetingSummaryOf([{ kind: 'absent' }], null)).toMatchObject({ kind: 'dropped' });
  });

  it('shows the model each part’s summary in order, and who was there, never the provider’s hints', () => {
    const parts = [part('one'), part('two')].flatMap((each) =>
      each.kind === 'read' ? [each.value] : [],
    );
    const data = digestReduceData(parts, [
      { about: 'who was in each meeting', text: 'Meeting: Sync' },
      { about: 'the provider’s own next steps: hints, never a source', text: '- hint' },
    ]);
    expect(data.map(({ about }) => about)).toEqual([
      'the summary of each part of the meeting, in order',
      'who was in each meeting',
    ]);
    expect(data[0]!.text).toBe(
      'Part 1 of 2\nSummary: one\nKey points:\n- one point\n\nPart 2 of 2\nSummary: two\nKey points:\n- two point',
    );
    expect(DIGEST_REDUCE_INSTRUCTIONS).toMatch(
      /^Answer with JSON only.*"summary".*"key_points".*"open_questions"/,
    );
  });

  it('reads its answer as a summary, and drops one that does not read', () => {
    expect(readDigestReduce(JSON.stringify(SUMMARY))).toMatchObject({ kind: 'read' });
    expect(readDigestReduce('```json\n' + JSON.stringify(SUMMARY) + '\n```')).toMatchObject({
      kind: 'read',
    });
    expect(readDigestReduce('nope')).toEqual({ kind: 'dropped', problem: 'It is not JSON.' });
    expect(readDigestReduce('[]')).toMatchObject({ kind: 'dropped' });
    expect(readDigestReduce(JSON.stringify({ ...SUMMARY, items: [] }))).toMatchObject({
      kind: 'dropped',
      problem: expect.stringContaining('“items”') as unknown as string,
    });
    expect(readDigestReduce(JSON.stringify({}))).toEqual({
      kind: 'dropped',
      problem: 'It has no "summary".',
    });
  });

  it('is kept under a mark of the very parts it merged, and their answers', () => {
    const merged = { parts: ['a', 'b'], answers: ['one', 'two'] };
    expect(reducePartMark(merged)).toBe(reducePartMark({ ...merged }));
    expect(reducePartMark(merged)).not.toBe(reducePartMark({ ...merged, parts: ['a', 'c'] }));
    expect(reducePartMark(merged)).not.toBe(
      reducePartMark({ ...merged, answers: ['one', 'two again'] }),
    );
    expect(reducePartMark({ parts: ['a'], answers: ['one'] })).toMatch(/^reduce:[0-9a-f]{8}$/);
  });
});

describe('a run’s asks with reduces (#184)', () => {
  /** A meeting long enough to be read in many parts. */
  const long = (turns: number): AnsweredNote => {
    let text = GEMINI.text;
    for (let id = 5; id < 5 + turns; id += 1) {
      text += `\n**Tobias Fenn** [~00:10:00] Turn ${id}. ${'word '.repeat(75)}^t${String(id).padStart(4, '0')}\n`;
    }
    return { ...GEMINI, text };
  };
  const partsOf = (note: AnsweredNote) =>
    claudeAsks([note], { inParts: true, asks: 100 }).asks.length;

  it('plans no reduce for a meeting read whole', () => {
    expect(claudeAsks([GEMINI], { inParts: true, asks: 10, reduces: true })).toMatchObject({
      reduces: 0,
    });
  });

  it('keeps one ask of the ten for a long meeting’s reduce: nine parts at most', () => {
    const note = long(1000);
    expect(partsOf(note)).toBeGreaterThan(10);
    const plan = claudeAsks([note], { inParts: true, asks: 10, reduces: true });
    expect(plan.asks).toHaveLength(9);
    expect(plan.reduces).toBe(1);
    expect(plan.cut).toHaveLength(1);
  });

  it('fits two parts and their reduce in three asks, and no second part in two', () => {
    let turns = 1;
    while (partsOf(long(turns)) < 2) turns += 10;
    const note = long(turns);
    expect(claudeAsks([note], { inParts: true, asks: 3, reduces: true })).toMatchObject({
      reduces: 1,
    });
    expect(claudeAsks([note], { inParts: true, asks: 3, reduces: true }).asks).toHaveLength(2);
    const tight = claudeAsks([note], { inParts: true, asks: 2, reduces: true });
    expect(tight.asks).toHaveLength(1);
    expect(tight.reduces).toBe(0);
  });

  it('never plans more asks and reduces together than the run may make, however many meetings', () => {
    const note = long(1000);
    const others = [1, 2, 3].map((at) => ({ ...note, path: createVaultPath(`M${at}.md`) }));
    for (const most of [1, 2, 3, 5, 10]) {
      const plan = claudeAsks([note, ...others], { inParts: true, asks: most, reduces: true });
      expect(plan.asks.length + plan.reduces).toBeLessThanOrEqual(Math.max(most, 4));
    }
  });

  it('plans as before for an output that does not merge its parts', () => {
    const note = long(1000);
    expect(claudeAsks([note], { inParts: true, asks: 10 })).toMatchObject({ reduces: 0 });
    expect(claudeAsks([note], { inParts: true, asks: 10 }).asks).toHaveLength(10);
  });
});

describe('the declared step’s output', () => {
  const STEP: ClaudeAction = {
    kind: 'claude',
    prompt: '.atlas/prompts/after-a-meeting.md',
    tools: [],
    output: { kind: 'proposals', schema: 'meeting-items' },
    apply: 'mine',
  };

  it('reads a declared rule saved with meeting-items as meeting-digest, so it summarises', () => {
    expect(claudeStepOutput(STEP)).toEqual({ kind: 'proposals', schema: 'meeting-digest' });
  });

  it('leaves every other rule’s output as it names it', () => {
    const { apply: _declared, ...proposalsOnly } = STEP;
    expect(_declared).toBe('mine');
    expect(claudeStepOutput(proposalsOnly)).toEqual(STEP.output);
    const general = { ...STEP, output: { kind: 'proposals', schema: 'proposals' } } as const;
    expect(claudeStepOutput(general)).toEqual(general.output);
    const digestNamed = {
      ...STEP,
      output: { kind: 'proposals', schema: 'meeting-digest' },
    } as const;
    expect(claudeStepOutput(digestNamed)).toEqual(digestNamed.output);
  });
});

describe('what a meeting’s summary is of', () => {
  it('is its transcript’s digest, as the ledger keys it', () => {
    expect(transcriptDigestOf(GEMINI.text)).toBe(digestOf(meetingTranscriptOf(GEMINI.text)!));
    expect(transcriptDigestOf('## Summary\n\nNo transcript.\n')).toBeNull();
  });

  it('is skipped when its summary is of the words it holds now, and only then', () => {
    const of = transcriptDigestOf(GEMINI.text);
    expect(summarisedAlready({ atlas_summary_of: of }, GEMINI.text)).toBe(true);
    expect(summarisedAlready({}, GEMINI.text)).toBe(false);
    expect(
      summarisedAlready(
        { atlas_summary_of: of },
        GEMINI.text.replace('Friday works', 'Monday works'),
      ),
    ).toBe(false);
    expect(summarisedAlready({ atlas_summary_of: 'x' }, '## Summary\n\nNo transcript.\n')).toBe(
      false,
    );
  });
});

describe('what the summary lists (#185, #226)', () => {
  const reading = readDigest({
    items: [
      ...ITEMS,
      {
        kind: 'waiting',
        title: 'Send the cache numbers',
        owner: 'Tobias Fenn',
        source_block: 't0003',
        confidence: 'high',
        asked_by_owner: true,
      },
      {
        kind: 'follow-up',
        title: 'Check Friday still works',
        source_block: 't0004',
        owner: '',
        confidence: 'medium',
      },
      { kind: 'task', title: 'Go through it', owner: '', source_block: 't0004', confidence: 'low' },
      {
        kind: 'decision',
        title: 'Rename the flag',
        source_block: 't0002',
        confidence: 'low',
      },
    ],
  });
  const decide = (madeItems: readonly { key: string; title: string }[] = []) =>
    decideMeetingItems({
      proposals: reading.value,
      vault: VAULT,
      run: { today: '2026-10-01', backfilled: false, madeItems, linkedTasks: [] },
    });
  const decision = decide();

  it('lists the owner’s items and what they asked for, never what the decision left out', () => {
    const left = decision.items
      .filter(({ decision: each }) => each.outcome === 'left-out')
      .map(({ proposal }) => proposal.payload.title);
    expect(left).toEqual(expect.arrayContaining(['Flag the new cache', 'Go through it']));

    const { actionItems, decisions } = summaryListing(decision.items);
    const titles = actionItems.map(({ title }) => title);
    expect(titles).toEqual(
      expect.arrayContaining(['Write the rollout note', 'Send the cache numbers']),
    );
    for (const title of left) expect(titles).not.toContain(title);
    expect(actionItems.find(({ title }) => title === 'Write the rollout note')).toEqual({
      title: 'Write the rollout note',
      assignee: 'you',
      turn: 't0003',
      taskMade: true,
    });
    expect(actionItems.find(({ title }) => title === 'Send the cache numbers')).toEqual({
      title: 'Send the cache numbers',
      assignee: 'Tobias Fenn',
      turn: 't0003',
      taskMade: false,
    });
    expect(decisions).not.toContain('Rename the flag');
  });

  it('lists a decision the owner took part in, and not one they did not', () => {
    expect(summaryListing(decision.items).decisions).toEqual(['Ship the cache behind a flag']);
  });

  it('marks an item a task already stands for as made', () => {
    const made = decide(
      decision.items.flatMap(({ decision: each, proposal }) =>
        each.outcome === 'task' ? [{ key: each.atlasItem, title: proposal.payload.title }] : [],
      ),
    );
    expect(
      summaryListing(made.items).actionItems.find(
        ({ title }) => title === 'Write the rollout note',
      ),
    ).toMatchObject({ taskMade: true });
  });
});
