import { describe, expect, it } from 'vitest';
import type { PossibleDuplicateTask } from '../gtd/task-similarity.ts';
import type { PersonCandidate } from '../people/person-match.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import type { AssistItemAnswer, AssistPersonAnswer } from './assist-answer.ts';
import { listedPeopleOf } from './assist-held.ts';
import { assistPlan, type AssistFacts, type AssistItemFacts } from './assist-plan.ts';
import { inboxItem } from './inbox.ts';

/**
 * #906: duplicates and people in the plan. The title rule and Claude must
 * agree before a duplicate is planned; a person is linked only on an exact
 * match and added only with an address the item gives and nobody near.
 * Anything between is a question.
 */

const ITEM = createVaultPath('Inbox/Renew Larkspur Payroll contract.md');
const PAYROLL = {
  path: createVaultPath('Projects/Larkspur Payroll.md'),
  title: 'Larkspur Payroll',
};
const MARA = { path: createVaultPath('People/Mara Quill.md'), title: 'Mara Quill' };
const DIRECTORY: PersonCandidate[] = [
  { path: MARA.path, name: 'Mara Quill', emails: ['mara.quill@example.com'], aliases: [] },
];
const RENEW = {
  path: createVaultPath('Tasks/Renew Larkspur Payroll contract.md'),
  title: 'Renew Larkspur Payroll contract',
  project: null,
  status: 'next-action' as const,
};
const RENEW_WITH_MARA = {
  ...RENEW,
  path: createVaultPath('Tasks/Renew Larkspur Payroll contract with Mara.md'),
  title: 'Renew Larkspur Payroll contract with Mara',
};
const SAME: PossibleDuplicateTask = { task: RENEW, likeness: 'same-title' };
const CONTAINED: PossibleDuplicateTask = { task: RENEW_WITH_MARA, likeness: 'contained' };

const facts = (own: Partial<AssistItemFacts> = {}): AssistFacts => ({
  today: '2026-11-17',
  filingTargets: [PAYROLL],
  people: [MARA],
  directory: DIRECTORY,
  items: new Map([[ITEM, { duplicates: [], addresses: [], listedPeople: null, ...own }]]),
});
const item = (row: Record<string, unknown> = {}) =>
  inboxItem({ path: ITEM, title: 'Renew Larkspur Payroll contract', type: null, ...row });
const answer = (extra: Partial<AssistItemAnswer> = {}): AssistItemAnswer => ({
  item: ITEM,
  kind: 'task',
  projects: [],
  due: null,
  waitingOn: null,
  confidence: 'high',
  why: 'It asks for a renewal.',
  duplicateOf: null,
  people: [],
  ...extra,
});
const named = (name: string, extra: Partial<AssistPersonAnswer> = {}): AssistPersonAnswer => ({
  name,
  email: null,
  person: null,
  ...extra,
});
const plan = (extra: Partial<AssistItemAnswer>, own: Partial<AssistItemFacts> = {}, row = {}) =>
  assistPlan(item(row), answer(extra), facts(own));

describe('duplicates: the title rule and Claude must agree', () => {
  it('plans a duplicate when Claude, sure it is a task, picks a task the rule found the same', () => {
    expect(plan({ duplicateOf: RENEW.path }, { duplicates: [SAME] })).toMatchObject({
      step: { kind: 'duplicate', of: { path: RENEW.path, title: RENEW.title } },
      people: [],
    });
  });

  it('asks when Claude picks none where the rule found the same title', () => {
    expect(plan({}, { duplicates: [SAME] }).step).toEqual({
      kind: 'ask',
      question: 'Is this the same as Renew Larkspur Payroll contract?',
    });
  });

  it('asks when Claude picks a task the rule only half matched', () => {
    expect(plan({ duplicateOf: RENEW_WITH_MARA.path }, { duplicates: [CONTAINED] }).step).toEqual({
      kind: 'ask',
      question: 'Is this the same as Renew Larkspur Payroll contract with Mara?',
    });
  });

  it('asks when Claude picks a duplicate but says the item is not a task', () => {
    expect(plan({ kind: 'note', duplicateOf: RENEW.path }, { duplicates: [SAME] }).step).toEqual({
      kind: 'ask',
      question: 'Is this the same as Renew Larkspur Payroll contract?',
    });
  });

  it('asks rather than plan when Claude is not sure', () => {
    expect(
      plan({ confidence: 'medium', duplicateOf: RENEW.path }, { duplicates: [SAME] }).step.kind,
    ).toBe('ask');
  });

  it('says nothing of a half match Claude did not pick: the plan goes on', () => {
    expect(plan({ projects: [PAYROLL.path] }, { duplicates: [CONTAINED] }).step).toMatchObject({
      kind: 'task',
      project: PAYROLL,
    });
  });

  it('makes a pick it was not offered, or one the item’s list lacks, a question', () => {
    expect(plan({ offList: true }).step).toEqual({
      kind: 'ask',
      question: 'Claude picked a task or a person it was not offered.',
    });
    expect(plan({ duplicateOf: RENEW.path }, { duplicates: [] }).step).toEqual({
      kind: 'ask',
      question: 'Claude picked a task or a person it was not offered.',
    });
  });
});

describe('people', () => {
  it('links someone exactly in People that Claude picked too', () => {
    expect(plan({ people: [named('Mara Quill', { person: MARA.path })] })).toMatchObject({
      step: { kind: 'task' },
      people: [{ kind: 'link', person: MARA }],
    });
  });

  it('links them by the vault’s title, whatever name the item gives with their address', () => {
    const row = plan({
      people: [named('M. Quill', { email: 'mara.quill@example.com', person: MARA.path })],
    });
    expect(row.people).toEqual([{ kind: 'link', person: MARA }]);
  });

  it('asks when Claude did not pick the person the name matches exactly', () => {
    expect(plan({ people: [named('Mara Quill')] }).step).toEqual({
      kind: 'ask',
      question: 'Is this Mara Quill?',
    });
  });

  it('asks, naming the vault’s person, for someone near', () => {
    expect(plan({ people: [named('Mara')] }).step).toEqual({
      kind: 'ask',
      question: 'Is this Mara Quill?',
    });
    expect(plan({ people: [named('Mara', { person: MARA.path })] }).step.kind).toBe('ask');
  });

  it('asks when Claude picks a person the name does not match', () => {
    expect(plan({ people: [named('Wren Calloway', { person: MARA.path })] }).step).toEqual({
      kind: 'ask',
      question: 'Is this Mara Quill?',
    });
  });

  it('would add someone nobody is like, with an address the item gives', () => {
    const tobias = named('Tobias Fenn', { email: 'tobias@example.org' });
    expect(plan({ people: [tobias] }, { addresses: ['Tobias@example.org'] })).toMatchObject({
      step: { kind: 'task' },
      people: [{ kind: 'add', name: 'Tobias Fenn', email: 'tobias@example.org' }],
    });
  });

  it('asks rather than add without an address, or with one the item does not hold', () => {
    expect(plan({ people: [named('Tobias Fenn')] }).step).toEqual({
      kind: 'ask',
      question: 'Tobias Fenn is not in People, and the item gives no email. Add them?',
    });
    const invented = named('Tobias Fenn', { email: 'tobias@example.org' });
    expect(plan({ people: [invented] }, { addresses: [] }).step).toEqual({
      kind: 'ask',
      question: 'Claude gave an email for Tobias Fenn that the item does not hold.',
    });
  });

  it('asks rather than add a name no note can take', () => {
    const odd = named('Tobias [[Fenn]]', { email: 'tobias@example.org' });
    expect(plan({ people: [odd] }, { addresses: ['tobias@example.org'] }).step.kind).toBe('ask');
  });

  it('keeps the people an item lists: the same adds nothing; anyone else is a question', () => {
    const listed = listedPeopleOf(['[[Mara Quill]]']);
    const mara = named('Mara Quill', { person: MARA.path });
    expect(plan({ people: [mara] }, { listedPeople: listed })).toMatchObject({
      step: { kind: 'task' },
      people: [],
    });
    const tobias = named('Tobias Fenn', { email: 'tobias@example.org' });
    expect(
      plan({ people: [tobias] }, { listedPeople: listed, addresses: ['tobias@example.org'] }).step,
    ).toEqual({
      kind: 'ask',
      question: 'It lists Mara Quill; Claude suggests adding Tobias Fenn.',
    });
    expect(plan({ people: [mara] }, { listedPeople: listedPeopleOf('Wren') }).step).toEqual({
      kind: 'ask',
      question: 'It lists Wren; Claude suggests Mara Quill.',
    });
  });

  it('links each person once, and says nothing of people beside a duplicate or an item left', () => {
    const mara = named('Mara Quill', { person: MARA.path });
    expect(plan({ people: [mara, mara] }).people).toHaveLength(1);
    expect(
      plan({ duplicateOf: RENEW.path, people: [mara] }, { duplicates: [SAME] }).people,
    ).toEqual([]);
    const leftAlone = plan({ people: [mara] }, {}, { type: 'task', status: 'inbox' });
    expect(leftAlone.step.kind).toBe('leave');
    expect(leftAlone.people).toEqual([]);
  });

  it('never links someone who is not among the people offered', () => {
    const outside = { ...facts(), people: [] };
    const row = assistPlan(item(), answer({ people: [named('Mara Quill')] }), outside);
    expect(row.step).toEqual({
      kind: 'ask',
      question: 'Mara Quill is not in People, and the item gives no email. Add them?',
    });
  });
});

describe('the people and duplicate rules, over seeded answers (#906)', () => {
  /** mulberry32: every run walks the same cases. */
  const seeded = (seed: number) => {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const pick = <T>(rng: () => number, from: readonly T[]): T =>
    from[Math.floor(rng() * from.length)]!;
  const NAMES = ['Mara Quill', 'Mara', 'Marra Quill', 'Tobias Fenn', 'MaraQuill', 'mara quill'];
  const EMAILS = [
    null,
    null,
    'mara.quill@example.com',
    'marra.quill@example.com',
    'tobias@example.org',
  ];
  const PICKS: (VaultPath | null)[] = [null, null, MARA.path];
  const LISTED = [null, null, listedPeopleOf('[[Mara Quill]]'), listedPeopleOf('Wren')];
  const ADDRESSES = [[], ['tobias@example.org'], ['mara.quill@example.com', 'tobias@example.org']];

  it('adds only with an address the item gives and nobody near; links only exactly (5,000 cases)', () => {
    const rng = seeded(9061);
    for (let n = 0; n < 5_000; n += 1) {
      const people = Array.from({ length: 1 + Math.floor(rng() * 2) }, () =>
        named(pick(rng, NAMES), { email: pick(rng, EMAILS), person: pick(rng, PICKS) }),
      );
      const own = {
        addresses: pick(rng, ADDRESSES),
        listedPeople: pick(rng, LISTED),
        duplicates: pick(rng, [[], [SAME], [CONTAINED]]),
      };
      const given = answer({
        confidence: pick(rng, ['high', 'high', 'medium'] as const),
        kind: pick(rng, ['task', 'note'] as const),
        projects: [PAYROLL.path],
        duplicateOf: pick(rng, [null, RENEW.path, RENEW_WITH_MARA.path]),
        people,
      });
      const row = assistPlan(item(), given, facts(own));
      const label = JSON.stringify({ given, own });
      if (row.step.kind === 'ask') expect(row.people, label).toEqual([]);
      if (row.step.kind === 'duplicate') {
        expect(given.confidence, label).toBe('high');
        expect(given.duplicateOf, label).toBe(RENEW.path);
        expect(own.duplicates, label).toContain(SAME);
      }
      for (const step of row.people) {
        if (step.kind === 'add') {
          expect(given.confidence, label).toBe('high');
          expect(
            own.addresses.map((each) => each.toLowerCase()),
            label,
          ).toContain(step.email.toLowerCase());
          // Nobody near: no name or address of Mara's family is ever added.
          expect(step.name, label).toBe('Tobias Fenn');
          expect(own.listedPeople, label).toBeNull();
        } else {
          expect(step.person, label).toEqual(MARA);
          expect(own.listedPeople, label).toBeNull();
          expect(
            people.some((each) => each.person === MARA.path),
            label,
          ).toBe(true);
        }
      }
    }
  });
});
