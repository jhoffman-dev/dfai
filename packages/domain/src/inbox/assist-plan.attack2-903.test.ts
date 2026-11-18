import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import type { AssistItemAnswer, AssistKind } from './assist-answer.ts';
import { assistPlan, type AssistFacts, type AssistStep } from './assist-plan.ts';
import { inboxItem, type InboxItem } from './inbox.ts';
import type { ProposalConfidence } from '../proposals/proposal.ts';

/**
 * Adversarial second pass on #903 (#900): a plan never changes what the
 * person already set on an item; every difference is a question naming both.
 */

const PAYROLL = {
  path: createVaultPath('Projects/Larkspur Payroll.md'),
  title: 'Larkspur Payroll',
};
const HIRING = { path: createVaultPath('Areas/Hiring.md'), title: 'Hiring' };
const GONE = createVaultPath('Projects/Quarry Launch.md');
const MARA = { path: createVaultPath('People/Mara Quill.md'), title: 'Mara Quill' };
const TOBIAS = { path: createVaultPath('People/Tobias Fenn.md'), title: 'Tobias Fenn' };
const FACTS: AssistFacts = {
  today: '2026-11-17',
  filingTargets: [PAYROLL, HIRING],
  people: [MARA, TOBIAS],
  directory: [],
  items: new Map(),
  takenTitles: new Set(),
};
const ITEM_PATH = createVaultPath('Inbox/Call Mara Quill.md');

const answer = (extra: Partial<AssistItemAnswer> = {}): AssistItemAnswer => ({
  item: ITEM_PATH,
  kind: 'task',
  projects: [],
  due: null,
  waitingOn: null,
  confidence: 'high',
  why: 'It asks for a call.',
  duplicateOf: null,
  people: [],
  ...extra,
});
const itemWith = (row: Record<string, unknown>): InboxItem =>
  inboxItem({ path: ITEM_PATH, title: 'Call Mara Quill', type: null, ...row });
const task = (row: Record<string, unknown> = {}) =>
  itemWith({ type: 'task', status: 'inbox', ...row });
const stepOf = (item: InboxItem, extra: Partial<AssistItemAnswer>) =>
  assistPlan(item, answer(extra), FACTS).step;

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: () => number, from: readonly T[]): T =>
  from[Math.floor(rng() * from.length)]!;

describe('attack2-903: property, never overwrite (seeded)', () => {
  const CASES = 10_000;
  const HELD_PROJECTS = [undefined, '', '   ', PAYROLL.path, HIRING.path, GONE];
  const HELD_DUES = [undefined, '', '  ', '2026-12-01', '2026-11-20'];
  const HELD_WAITING = [undefined, MARA.path, TOBIAS.path];
  const HELD_NAMES = [undefined, '', '  ', 'Mara Quill', 'mara@example.com'];
  const NAMES = [
    PAYROLL.path,
    HIRING.path,
    'larkspur payroll',
    'Hiring',
    'Projects/Larkspur Payroll.md/',
  ];
  const PEOPLE = [null, MARA.path, TOBIAS.path, 'Mara Quill', 'mara quill'];
  const DUES = [null, '2026-12-01', '2026-12-02', '2026-11-20'];
  const KINDS: readonly AssistKind[] = ['task', 'note', 'reference', 'junk'];
  const CONF: readonly ProposalConfidence[] = ['high', 'high', 'medium'];

  it(`an action never touches a task field already set, and a project clash names both (${CASES} cases)`, () => {
    const rng = seeded(9032);
    for (let n = 0; n < CASES; n += 1) {
      const row = {
        type: pick(rng, ['task', 'task', null] as const),
        status: 'inbox',
        project: pick(rng, HELD_PROJECTS),
        due: pick(rng, HELD_DUES),
        waitingOn: pick(rng, HELD_WAITING),
        waitingOnNames: pick(rng, HELD_NAMES),
        defer: pick(rng, [undefined, '2026-11-30']),
      };
      const item = itemWith(row);
      const given = answer({
        kind: pick(rng, KINDS),
        confidence: pick(rng, CONF),
        projects: rng() < 0.4 ? [] : [pick(rng, NAMES)],
        due: pick(rng, DUES),
        waitingOn: pick(rng, PEOPLE),
      });
      const step: AssistStep = assistPlan(item, given, FACTS).step;
      const label = JSON.stringify({ row, given });
      const held = item.task;
      if (step.kind === 'file') expect(held, label).toBeNull();
      if (step.kind === 'task' && held !== null) {
        if (step.project !== null) expect(held.project, label).toBeNull();
        if (step.due !== null) expect(held.due, label).toBeNull();
        if (step.waitingOn !== null) {
          expect(held.waitingOn, label).toBeNull();
          expect(held.waitingOnNames.trim(), label).toBe('');
        }
        expect(step.makeTask, label).toBe(false);
      }
      if (step.kind === 'ask' && step.question.startsWith('You filed this under')) {
        expect(step.question, label).toMatch(/Larkspur Payroll|Hiring|Quarry Launch/);
        expect(step.question.match(/Larkspur Payroll|Hiring|Quarry Launch/g), label).toHaveLength(
          2,
        );
      }
    }
  });
});

describe('attack2-903: never-overwrite edges (held: pinned behaviour)', () => {
  it('a project no longer in the listing is a question naming both', () => {
    expect(stepOf(task({ project: GONE }), { projects: [PAYROLL.path] })).toEqual({
      kind: 'ask',
      question: 'You filed this under Quarry Launch; Claude suggests Larkspur Payroll.',
    });
  });

  it('the same project by title, in another case, agrees and adds nothing', () => {
    expect(stepOf(task({ project: PAYROLL.path }), { projects: ['larkspur payroll'] })).toEqual({
      kind: 'leave',
      because: 'Already a task, with nothing clear to add.',
    });
  });

  it('the same person written as an email is a question, not a link', () => {
    expect(stepOf(task({ waitingOnNames: 'mara@example.com' }), { waitingOn: MARA.path })).toEqual({
      kind: 'ask',
      question: 'It waits on mara@example.com; Claude suggests Mara Quill.',
    });
  });

  it('a due date equal adds nothing; one day different is a question', () => {
    expect(stepOf(task({ due: '2026-12-01' }), { due: '2026-12-01' }).kind).toBe('leave');
    expect(stepOf(task({ due: '2026-12-01' }), { due: '2026-12-02' })).toEqual({
      kind: 'ask',
      question: 'You set it due 2026-12-01; Claude suggests 2026-12-02.',
    });
  });

  it('an empty or blank field is not set: a suggestion fills it', () => {
    expect(stepOf(task({ project: '   ', due: '' }), { projects: [HIRING.path] })).toMatchObject({
      kind: 'task',
      project: HIRING,
    });
  });

  it('a filed task Claude calls junk is a question', () => {
    expect(stepOf(task({ project: PAYROLL.path }), { kind: 'junk' }).kind).toBe('ask');
  });
});

describe('attack2-903: a note that is not a task keeps what it is', () => {
  it.each(['person', 'reference', 'project'])(
    'a note of type %s is asked about before it is made a task',
    (type) => {
      expect(stepOf(itemWith({ type }), { kind: 'task', projects: [HIRING.path] }).kind).toBe(
        'ask',
      );
    },
  );

  it('a note already under a project is not filed under another without a question', () => {
    const filedNote = itemWith({ type: 'note', project: PAYROLL.path });
    expect(stepOf(filedNote, { kind: 'note', projects: [HIRING.path] }).kind).toBe('ask');
  });
});
