import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import type { AssistItemAnswer, AssistKind } from './assist-answer.ts';
import { assistPlan, type AssistFacts, type AssistStep } from './assist-plan.ts';
import { inboxItem, type InboxItem } from './inbox.ts';
import type { ProposalConfidence } from '../proposals/proposal.ts';

/**
 * Adversarial pass on #903 (#900): answers a steered model could return,
 * checked against what the plan may do with them. Later slices act on these
 * plans unattended, so an action where a question belongs is the harm.
 */

const PAYROLL = {
  path: createVaultPath('Projects/Larkspur Payroll.md'),
  title: 'Larkspur Payroll',
};
const HIRING = { path: createVaultPath('Areas/Hiring.md'), title: 'Hiring' };
const MARA = { path: createVaultPath('People/Mara Quill.md'), title: 'Mara Quill' };
const TOBIAS = { path: createVaultPath('People/Tobias Fenn.md'), title: 'Tobias Fenn' };
const FACTS: AssistFacts = {
  today: '2026-11-17',
  filingTargets: [PAYROLL, HIRING],
  people: [MARA, TOBIAS],
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
  ...extra,
});

/** A task the person already filed: under Payroll, due 2026-12-01, waiting on Mara. */
const filedTask = (): InboxItem =>
  inboxItem({
    path: ITEM_PATH,
    title: 'Call Mara Quill',
    type: 'task',
    status: 'inbox',
    project: PAYROLL.path,
    due: '2026-12-01',
    waitingOn: MARA.path,
  });

describe('attack-903: an answer that disagrees with what the person set is a question', () => {
  it('precondition: the filed task carries the project, due and person it was given', () => {
    expect(filedTask().task).toMatchObject({
      project: PAYROLL.path,
      due: '2026-12-01',
      waitingOn: MARA.path,
    });
  });

  it('a different due from the one the task already has is asked, not planned', () => {
    const step = assistPlan(filedTask(), answer({ due: '2026-11-18' }), FACTS).step;
    expect(step.kind).toBe('ask');
  });

  it('a different project from the one the task is filed under is asked, not planned', () => {
    const step = assistPlan(filedTask(), answer({ projects: [HIRING.path] }), FACTS).step;
    expect(step.kind).toBe('ask');
  });

  it('a different person from the one the task waits on is asked, not planned', () => {
    const step = assistPlan(filedTask(), answer({ waitingOn: TOBIAS.path }), FACTS).step;
    expect(step.kind).toBe('ask');
  });

  it('a task called a note is asked, not filed as a note', () => {
    const step = assistPlan(
      filedTask(),
      answer({ kind: 'note', projects: [HIRING.path] }),
      FACTS,
    ).step;
    expect(step.kind).toBe('ask');
  });
});

describe('attack-903: an implausible due is a question', () => {
  it.each(['9999-12-31', '3026-11-17'])('due %s is asked, not planned', (due) => {
    const plain = inboxItem({ path: ITEM_PATH, title: 'Call Mara Quill', type: null });
    const step = assistPlan(plain, answer({ due, projects: [PAYROLL.path] }), FACTS).step;
    expect(step.kind).toBe('ask');
  });
});

/** mulberry32: a small seeded generator, so every run walks the same cases. */
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

/** Names a steered model could return: real ones, look-alikes and paths that are not targets. */
const HOSTILE_NAMES = [
  'Projects/Larkspur Payroll.md',
  'Areas/Hiring.md',
  'Larkspur Payroll',
  'larkspur payroll',
  'PROJECTS/LARKSPUR PAYROLL.MD',
  '../Projects/Larkspur Payroll.md',
  '/Projects/Larkspur Payroll.md',
  'Projects/Larkspur Payroll.md/',
  'Projects/Larkspur%20Payroll.md',
  'Projects/Larkspur Payrołl.md',
  'Projects/Larkspur Payroll​.md',
  'Areas/Hirinǵ.md',
  '.atlas/prompts/Hiring.md',
  'Inbox/Call Mara Quill.md',
  'Archive/Projects/Larkspur Payroll.md',
  'People/Mara Quill.md',
  'Mara Quill',
  'Tobias Fenn',
  'People/Tobias Fenn.md',
  'Nobody At All',
];
const KINDS: readonly AssistKind[] = ['task', 'note', 'reference', 'person', 'meeting', 'junk'];
const CONFIDENCES: readonly ProposalConfidence[] = ['high', 'medium', 'low'];
const DUES = [null, '2026-11-17', '2026-11-16', '2026-11-18', '1970-01-01', '2027-02-28'];

const pick = <T>(rng: () => number, from: readonly T[]): T =>
  from[Math.floor(rng() * from.length)]!;

const isAction = (step: AssistStep) => step.kind === 'task' || step.kind === 'file';

describe('attack-903: property, over seeded hostile answers', () => {
  const CASES = 5_000;

  it(`acts only on a sure task, note or reference naming real targets (${CASES} cases)`, () => {
    const rng = seeded(903);
    const items = [
      inboxItem({ path: ITEM_PATH, title: 'Call Mara Quill', type: null }),
      inboxItem({ path: ITEM_PATH, title: 'Call Mara Quill', type: 'task', status: 'inbox' }),
    ];
    for (let n = 0; n < CASES; n += 1) {
      const projectCount = Math.floor(rng() * 4);
      const given = answer({
        kind: pick(rng, KINDS),
        confidence: pick(rng, CONFIDENCES),
        projects: Array.from({ length: projectCount }, () => pick(rng, HOSTILE_NAMES)),
        due: pick(rng, DUES),
        waitingOn: rng() < 0.5 ? null : pick(rng, HOSTILE_NAMES),
      });
      const step = assistPlan(pick(rng, items), given, FACTS).step;
      const label = JSON.stringify(given);
      if (!isAction(step)) continue;
      expect(['task', 'note', 'reference'], label).toContain(given.kind);
      expect(given.confidence, label).toBe('high');
      if (step.kind === 'file') {
        expect(FACTS.filingTargets, label).toContain(step.project);
      }
      if (step.kind === 'task') {
        if (step.project !== null) expect(FACTS.filingTargets, label).toContain(step.project);
        if (step.waitingOn !== null) expect(FACTS.people, label).toContain(step.waitingOn);
        if (step.due !== null) expect(step.due >= FACTS.today, label).toBe(true);
      }
      // Every name the answer gave resolved to the one target acted on: none was ignored.
      const target = step.project;
      for (const name of given.projects) {
        expect(target, label).not.toBeNull();
        const stem = (text: string) => text.replace(/\.md$/i, '').toLowerCase();
        expect([stem(target!.path), stem(target!.title)], label).toContain(stem(name));
      }
    }
  });
});
