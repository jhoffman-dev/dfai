import { describe, expect, it } from 'vitest';
import type { PossibleDuplicateTask } from '../gtd/task-similarity.ts';
import type { PersonCandidate } from '../people/person-match.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import type { AssistItemAnswer, AssistPersonAnswer } from './assist-answer.ts';
import { assistPlan, type AssistFacts, type AssistItemFacts } from './assist-plan.ts';
import { inboxItem } from './inbox.ts';

/**
 * Attack on #906 (PR #907): lines the preview PLANS that later slices will
 * act on unattended — archive the item as a duplicate, create a person note.
 * Each test names a case where the rules say "question" (or a narrower plan).
 */

const ITEM = createVaultPath('Inbox/Renew Larkspur contract.md');
const LARKSPUR = {
  path: createVaultPath('Projects/Larkspur Payroll.md'),
  title: 'Larkspur Payroll',
};
const FENN = { path: createVaultPath('Projects/Fenn Renovation.md'), title: 'Fenn Renovation' };
const MARA = { path: createVaultPath('People/Mara Quill.md'), title: 'Mara Quill' };
const ARCHIVED_TOBIAS = createVaultPath('Archive/People/Tobias Fenn.md');

const DIRECTORY: PersonCandidate[] = [
  { path: MARA.path, name: 'Mara Quill', emails: ['mara.quill@example.com'], aliases: [] },
  // The link directory reads archived people too; Suggest does not offer them.
  { path: ARCHIVED_TOBIAS, name: 'Tobias Fenn', emails: ['tobias@example.com'], aliases: [] },
];

const facts = (own: Partial<AssistItemFacts> = {}): AssistFacts => ({
  today: '2026-11-17',
  filingTargets: [LARKSPUR, FENN],
  people: [MARA],
  directory: DIRECTORY,
  items: new Map([[ITEM, { duplicates: [], addresses: [], listedPeople: null, ...own }]]),
});
const item = () => inboxItem({ path: ITEM, title: 'Renew Larkspur contract', type: null });
const answer = (extra: Partial<AssistItemAnswer> = {}): AssistItemAnswer => ({
  item: ITEM,
  kind: 'task',
  projects: [],
  due: null,
  waitingOn: null,
  confidence: 'high',
  why: 'Something to do.',
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
const plan = (extra: Partial<AssistItemAnswer>, own: Partial<AssistItemFacts> = {}) =>
  assistPlan(item(), answer(extra), facts(own));

describe('attack-907: duplicates', () => {
  it('never plans a duplicate of a task under another project than the one Claude files the item under', () => {
    // The item has no project yet, so the title rule lists a task from any project.
    const underLarkspur: PossibleDuplicateTask = {
      task: {
        path: createVaultPath('Tasks/Renew Larkspur contract.md'),
        title: 'Renew Larkspur contract',
        project: LARKSPUR.path,
        status: 'next-action',
      },
      likeness: 'same-title',
    };
    const row = plan(
      { projects: [FENN.path], duplicateOf: underLarkspur.task.path },
      { duplicates: [underLarkspur] },
    );
    expect(row.step.kind).not.toBe('duplicate');
  });
});

describe('attack-907: people', () => {
  it('never plans adding a person whose address an archived person already has', () => {
    const row = plan(
      { people: [named('Tobias Fenn', { email: 'tobias@example.com' })] },
      { addresses: ['tobias@example.com'] },
    );
    expect(row.people.filter((step) => step.kind === 'add')).toEqual([]);
  });

  it('never plans two new people for one mailbox', () => {
    const row = plan(
      {
        people: [
          named('Tobias Fenn', { email: 'tobi@example.org' }),
          named('tobias fenn', { email: 'tobi@example.org' }),
        ],
      },
      { addresses: ['tobi@example.org'] },
    );
    expect(row.people.filter((step) => step.kind === 'add')).toHaveLength(1);
  });

  it('adds a new person only under an address the item itself holds, not a +tag variant of it', () => {
    const row = plan(
      { people: [named('Tobias Fenn', { email: 'tobi+anything@example.org' })] },
      { addresses: ['tobi@example.org'] },
    );
    const added = row.people.flatMap((step) => (step.kind === 'add' ? [step.email] : []));
    expect(added.filter((email) => email !== 'tobi@example.org')).toEqual([]);
  });
});
