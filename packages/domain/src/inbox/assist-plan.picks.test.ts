import { describe, expect, it } from 'vitest';
import type { PossibleDuplicateTask, TaskCandidate } from '../gtd/task-similarity.ts';
import {
  mailboxKey,
  mentionsName,
  personMatch,
  type PersonCandidate,
} from '../people/person-match.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import type { AssistItemAnswer, AssistPersonAnswer } from './assist-answer.ts';
import { listedPeopleOf } from './assist-held.ts';
import {
  assistPlan,
  withoutRepeatedAdds,
  type AssistFacts,
  type AssistItemFacts,
  type AssistRow,
} from './assist-plan.ts';
import { inboxItem } from './inbox.ts';

/**
 * #906, #907: duplicates and people in the plan. A line is planned only when
 * the item's own text and the vault confirm it, with Claude merely agreeing;
 * Claude's own names and addresses are never evidence. Anything between is
 * a question.
 */

const ITEM = createVaultPath('Inbox/Renew Larkspur Payroll contract.md');
const TITLE = 'Renew Larkspur Payroll contract';
const PAYROLL = {
  path: createVaultPath('Projects/Larkspur Payroll.md'),
  title: 'Larkspur Payroll',
};
const HIRING = { path: createVaultPath('Areas/Hiring.md'), title: 'Hiring' };
const MARA = { path: createVaultPath('People/Mara Quill.md'), title: 'Mara Quill' };
const STONE = { path: createVaultPath('People/Mara Stone.md'), title: 'Mara Stone' };
const MARA_PERSON: PersonCandidate = {
  path: MARA.path,
  name: 'Mara Quill',
  emails: ['mara.quill@example.com'],
  aliases: [],
};
const STONE_PERSON: PersonCandidate = {
  path: STONE.path,
  name: 'Mara Stone',
  emails: ['mara.stone@example.com'],
  aliases: ['Mara Quill'],
};
const ARCHIVED_TOBIAS: PersonCandidate = {
  path: createVaultPath('Archive/People/Tobias Fenn.md'),
  name: 'Tobias Fenn',
  emails: ['tobias@example.org'],
  aliases: [],
};

const task = (extra: Partial<TaskCandidate> = {}): TaskCandidate => ({
  path: createVaultPath('Tasks/Renew Larkspur Payroll contract.md'),
  title: TITLE,
  project: null,
  status: 'next-action',
  due: null,
  recurrence: null,
  waitingOn: '',
  ...extra,
});
const RENEW = task();
const SAME: PossibleDuplicateTask = { task: RENEW, likeness: 'same-title' };
const REORDERED: PossibleDuplicateTask = {
  task: task({
    path: createVaultPath('Tasks/Contract renew.md'),
    title: 'Payroll contract renew Larkspur',
  }),
  likeness: 'same-words',
};
const CONTAINED: PossibleDuplicateTask = {
  task: task({ path: createVaultPath('Tasks/With Mara.md'), title: `${TITLE} with Mara` }),
  likeness: 'contained',
};

const own = (extra: Partial<AssistItemFacts> = {}): AssistItemFacts => ({
  duplicates: [],
  inboxTwin: null,
  addresses: [],
  listedPeople: null,
  text: TITLE,
  hasBody: false,
  ...extra,
});
const facts = (
  mine: Partial<AssistItemFacts> = {},
  vault: Partial<AssistFacts> = {},
): AssistFacts => ({
  today: '2026-11-17',
  filingTargets: [PAYROLL, HIRING],
  people: [MARA, STONE],
  directory: [MARA_PERSON],
  takenTitles: new Set(),
  items: new Map([[ITEM, own(mine)]]),
  ...vault,
});
const item = (row: Record<string, unknown> = {}) =>
  inboxItem({ path: ITEM, title: TITLE, type: null, ...row });
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
const plan = (
  extra: Partial<AssistItemAnswer>,
  mine: Partial<AssistItemFacts> = {},
  vault: Partial<AssistFacts> = {},
  row = {},
) => assistPlan(item(row), answer(extra), facts(mine, vault));
const question = (text: string) => ({ kind: 'ask', question: text });

describe('duplicates: planned only when the vault confirms and Claude agrees', () => {
  it('plans one only on the same title, picked by Claude sure it is a task, filed alike', () => {
    expect(plan({ duplicateOf: RENEW.path }, { duplicates: [SAME] }).step).toEqual({
      kind: 'duplicate',
      of: { path: RENEW.path, title: TITLE },
      newerHolds: [],
    });
  });

  it('asks of the same words in another order, or a title within a longer one, even when picked', () => {
    expect(plan({ duplicateOf: REORDERED.task.path }, { duplicates: [REORDERED] }).step).toEqual(
      question('Is this the same as Payroll contract renew Larkspur?'),
    );
    expect(plan({ duplicateOf: CONTAINED.task.path }, { duplicates: [CONTAINED] }).step).toEqual(
      question(`Is this the same as ${TITLE} with Mara?`),
    );
  });

  it('asks when Claude picks none of the same title; says nothing of other likenesses then', () => {
    expect(plan({}, { duplicates: [SAME] }).step).toEqual(
      question(`Is this the same as ${TITLE}?`),
    );
    expect(
      plan({ projects: [PAYROLL.path] }, { duplicates: [REORDERED, CONTAINED] }).step,
    ).toMatchObject({
      kind: 'task',
      project: PAYROLL,
    });
  });

  it('asks when Claude says it is not a task, or is not sure', () => {
    expect(plan({ kind: 'note', duplicateOf: RENEW.path }, { duplicates: [SAME] }).step.kind).toBe(
      'ask',
    );
    expect(
      plan({ confidence: 'medium', duplicateOf: RENEW.path }, { duplicates: [SAME] }).step.kind,
    ).toBe('ask');
  });

  it('asks when the task is filed elsewhere than Claude, or the item, files it', () => {
    const underPayroll = { task: task({ project: PAYROLL.path }), likeness: 'same-title' } as const;
    expect(
      plan({ duplicateOf: RENEW.path, projects: [HIRING.path] }, { duplicates: [underPayroll] })
        .step.kind,
    ).toBe('ask');
    expect(plan({ duplicateOf: RENEW.path }, { duplicates: [underPayroll] }).step.kind).toBe('ask');
    expect(
      plan({ duplicateOf: RENEW.path, projects: [PAYROLL.path] }, { duplicates: [SAME] }).step.kind,
    ).toBe('ask');
    expect(
      plan({ duplicateOf: RENEW.path, projects: [PAYROLL.path] }, { duplicates: [underPayroll] })
        .step.kind,
    ).toBe('duplicate');
    expect(
      plan(
        { duplicateOf: RENEW.path },
        { duplicates: [underPayroll] },
        {},
        { project: PAYROLL.path, projectWritten: '[[Larkspur Payroll]]' },
      ).step.kind,
    ).toBe('duplicate');
  });

  it('asks of a task that repeats, or is due on another day', () => {
    const repeating = {
      task: task({ recurrence: 'every month' }),
      likeness: 'same-title',
    } as const;
    expect(plan({ duplicateOf: RENEW.path }, { duplicates: [repeating] }).step.kind).toBe('ask');
    const dueFirst = { task: task({ due: '2026-12-01' }), likeness: 'same-title' } as const;
    expect(
      plan({ duplicateOf: RENEW.path, due: '2026-12-02' }, { duplicates: [dueFirst] }).step.kind,
    ).toBe('ask');
    const heldOther = { due: '2026-12-03', dueWritten: '2026-12-03' };
    expect(
      plan({ duplicateOf: RENEW.path }, { duplicates: [dueFirst] }, {}, heldOther).step.kind,
    ).toBe('ask');
    expect(
      plan({ duplicateOf: RENEW.path, due: '2026-12-01' }, { duplicates: [dueFirst] }).step.kind,
    ).toBe('duplicate');
  });

  it('says what this copy holds that the kept task lacks', () => {
    const row = plan(
      { duplicateOf: RENEW.path },
      { duplicates: [SAME], hasBody: true, listedPeople: listedPeopleOf('[[Mara Quill]]') },
      {},
      { due: '2026-12-01', dueWritten: '2026-12-01' },
    );
    expect(row.step).toMatchObject({ kind: 'duplicate', newerHolds: ['due', 'people', 'notes'] });
  });

  it('asks on an item that is the newer of two captures in the Inbox', () => {
    expect(
      plan({ duplicateOf: RENEW.path }, { duplicates: [SAME], inboxTwin: TITLE }).step,
    ).toEqual(question(`Is this the same as ${TITLE}, also in your Inbox?`));
  });

  it('says plainly when Claude picked something it was not offered', () => {
    const offList = question(
      'Claude suggested a task or person that isn’t in your vault. Check this one by hand.',
    );
    expect(plan({ offList: true }).step).toEqual(offList);
    expect(plan({ duplicateOf: RENEW.path }, { duplicates: [] }).step).toEqual(offList);
  });
});

describe('links: the item’s own text must name them', () => {
  const pick = (name = 'Mara Quill', extra: Partial<AssistPersonAnswer> = {}) => [
    named(name, { person: MARA.path, ...extra }),
  ];

  it('links someone the item names in full, whom Claude picked', () => {
    expect(plan({ people: pick() }, { text: 'Call Mara Quill about it' })).toMatchObject({
      step: { kind: 'task' },
      people: [{ kind: 'link', person: MARA }],
    });
  });

  it('links someone by one of their addresses in the item, whatever name it gives', () => {
    const mine = {
      text: 'From M. Quill <mara.quill@example.com>',
      addresses: ['mara.quill@example.com'],
    };
    expect(plan({ people: pick('M. Quill') }, mine).people).toEqual([
      { kind: 'link', person: MARA },
    ]);
  });

  it('asks when the item never names them, whatever Claude says (attack-907)', () => {
    expect(plan({ people: pick() }, { text: 'Call Tobias about the contract' }).step).toEqual(
      question('Is this Mara Quill?'),
    );
    expect(plan({ people: pick() }, { text: 'Call Maralyn Quillson' }).step.kind).toBe('ask');
  });

  it('asks when the item holds an address with their name that is not theirs', () => {
    const mine = {
      text: 'Mara Quill <mara@other.example.net>',
      addresses: ['mara@other.example.net'],
    };
    expect(plan({ people: pick() }, mine).step).toEqual(question('Is this Mara Quill?'));
  });

  it('asks when Claude gives them an address the item lacks, or one that is someone else’s', () => {
    expect(
      plan(
        { people: pick('Mara Quill', { email: 'mara.quill@example.com' }) },
        { text: 'Mara Quill' },
      ).step,
    ).toEqual(question('Claude gave an email for Mara Quill that this item doesn’t mention.'));
    const mine = {
      text: 'Mara Quill <mq@elsewhere.example.net>',
      addresses: ['mq@elsewhere.example.net'],
    };
    expect(
      plan({ people: pick('Mara Quill', { email: 'mq@elsewhere.example.net' }) }, mine).step,
    ).toEqual(question('Is this Mara Quill?'));
  });

  it('asks which, when someone else goes by the same name', () => {
    const vault = { directory: [MARA_PERSON, STONE_PERSON] };
    expect(plan({ people: pick() }, { text: 'Call Mara Quill' }, vault).step).toEqual(
      question('Which Mara: Mara Quill or Mara Stone?'),
    );
  });

  it('asks when Claude picked nobody for someone exactly or nearly in People', () => {
    expect(plan({ people: [named('Mara Quill')] }, { text: 'Call Mara Quill' }).step).toEqual(
      question('Is this Mara Quill?'),
    );
    const vault = { directory: [MARA_PERSON, STONE_PERSON] };
    expect(plan({ people: [named('Mara')] }, { text: 'Ask Mara' }, vault).step).toEqual(
      question('Which Mara: Mara Quill or Mara Stone?'),
    );
  });

  it('keeps the people an item lists: the same adds nothing; anyone else is a question', () => {
    const mine = { text: 'Call Mara Quill', listedPeople: listedPeopleOf(['[[Mara Quill]]']) };
    expect(plan({ people: pick() }, mine)).toMatchObject({ step: { kind: 'task' }, people: [] });
    expect(
      plan({ people: pick() }, { ...mine, listedPeople: listedPeopleOf('Wren') }).step,
    ).toEqual(question('It lists Wren; Claude suggests Mara Quill.'));
  });

  it('says nothing of people beside a duplicate or an item left alone', () => {
    const mine = { text: 'Call Mara Quill', duplicates: [SAME] };
    expect(plan({ duplicateOf: RENEW.path, people: pick() }, mine).people).toEqual([]);
    const left = plan(
      { people: pick() },
      { text: 'Call Mara Quill' },
      {},
      { type: 'task', status: 'inbox' },
    );
    expect(left.step.kind).toBe('leave');
    expect(left.people).toEqual([]);
  });
});

describe('adds: the item’s own text and the vault must leave no doubt', () => {
  const TOBIAS_TEXT = {
    text: 'Lunch with Tobias Fenn <Tobias@Example.org>',
    addresses: ['Tobias@Example.org'],
  };
  const tobias = (extra: Partial<AssistPersonAnswer> = {}) => [
    named('Tobias Fenn', { email: 'tobias@example.org', ...extra }),
  ];

  it('adds under the cleaned name and the address exactly as the item writes it', () => {
    expect(plan({ people: tobias({ name: ' Tobias Fenn.' }) }, TOBIAS_TEXT).people).toEqual([
      { kind: 'add', name: 'Tobias Fenn', email: 'Tobias@Example.org' },
    ]);
  });

  it('asks when the item does not name them, or lacks that exact address', () => {
    expect(plan({ people: tobias() }, { ...TOBIAS_TEXT, text: 'Lunch on Friday' }).step).toEqual(
      question('Claude named someone this item doesn’t mention.'),
    );
    expect(
      plan({ people: tobias({ email: 'tobias+lunch@example.org' }) }, TOBIAS_TEXT).step,
    ).toEqual(question('Claude gave an email for Tobias Fenn that this item doesn’t mention.'));
    expect(plan({ people: tobias({ email: null }) }, TOBIAS_TEXT).step).toEqual(
      question('Tobias Fenn is not in People, and the item gives no email. Add them?'),
    );
  });

  it('asks of someone in the Archive, by address or by name', () => {
    const vault = { directory: [MARA_PERSON, ARCHIVED_TOBIAS] };
    expect(plan({ people: tobias() }, TOBIAS_TEXT, vault).step).toEqual(
      question('Tobias Fenn is in your Archive. Is this them?'),
    );
  });

  it('asks of a name a note already has, or no note can take', () => {
    expect(
      plan({ people: tobias() }, TOBIAS_TEXT, { takenTitles: new Set(['tobiasfenn']) }).step,
    ).toEqual(question('A note is called Tobias Fenn already. Is this them?'));
    const con = { text: 'From CON <con@example.org>', addresses: ['con@example.org'] };
    expect(plan({ people: [named('CON', { email: 'con@example.org' })] }, con).step.kind).toBe(
      'ask',
    );
  });

  it('adds one person for one mailbox within an item, and asks of a second across the plan', () => {
    const twice = [
      named('Tobias Fenn', { email: 'Tobias@Example.org' }),
      named('tobias  fenn', { email: 'tobias@example.org' }),
    ];
    expect(plan({ people: twice }, TOBIAS_TEXT).people).toHaveLength(1);
    const first = { ...plan({ people: tobias() }, TOBIAS_TEXT), title: 'Lunch' };
    const second = { ...plan({ people: tobias() }, TOBIAS_TEXT), title: 'Dinner' };
    const [kept, asked] = withoutRepeatedAdds([first, second]);
    expect(kept!.people).toHaveLength(1);
    expect(asked!.step).toEqual(
      question('Tobias Fenn would be added from Lunch already. Is this them?'),
    );
  });
});

describe('the principle, over seeded answers (#906, #907)', () => {
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
  const NAMES = ['Mara Quill', 'Mara', 'Marra Quill', 'Tobias Fenn', 'Wren Calloway', 'Mara Stone'];
  const EMAILS = [
    null,
    null,
    'mara.quill@example.com',
    'tobias@example.org',
    'tobias+x@example.org',
    'wren@example.org',
  ];
  const TEXTS = [
    'Renew it',
    'Call Mara Quill',
    'Lunch with Tobias Fenn <tobias@example.org>',
    'Ask Wren Calloway <wren@example.org> and Mara Quill <mara@other.example.net>',
    'From mara.quill@example.com',
  ];
  const DIRECTORIES = [[MARA_PERSON], [MARA_PERSON, STONE_PERSON], [MARA_PERSON, ARCHIVED_TOBIAS]];
  const CANDIDATES: PossibleDuplicateTask[][] = [
    [],
    [SAME],
    [REORDERED],
    [{ task: task({ project: PAYROLL.path }), likeness: 'same-title' }],
    [{ task: task({ recurrence: 'weekly' }), likeness: 'same-title' }],
    [{ task: task({ due: '2026-12-01' }), likeness: 'same-title' }],
  ];
  const addressesOf = (text: string) => [...text.matchAll(/[^\s<>]+@[^\s<>]+/g)].map((m) => m[0]);

  it('plans only what the item’s text and the vault confirm (4,000 cases)', () => {
    const rng = seeded(9071);
    for (let n = 0; n < 4_000; n += 1) {
      const text = pick(rng, TEXTS);
      const directory = pick(rng, DIRECTORIES);
      const candidates = pick(rng, CANDIDATES);
      const mine = { text, addresses: addressesOf(text), duplicates: candidates, hasBody: true };
      const given = answer({
        confidence: pick(rng, ['high', 'high', 'medium'] as const),
        kind: pick(rng, ['task', 'task', 'note'] as const),
        projects: pick(rng, [[], [PAYROLL.path]]),
        due: pick(rng, [null, '2026-12-01', '2026-12-02']),
        duplicateOf: candidates.length > 0 && rng() < 0.7 ? candidates[0]!.task.path : null,
        people: Array.from({ length: 1 + Math.floor(rng() * 2) }, () =>
          named(pick(rng, NAMES), {
            email: pick(rng, EMAILS),
            person: pick(rng, [null, MARA.path, STONE.path] as (VaultPath | null)[]),
          }),
        ),
      });
      const rows: AssistRow[] = [0, 1].map((at) => ({
        ...assistPlan(item(), given, facts(mine, { directory })),
        title: `Row ${at}`,
      }));
      const label = JSON.stringify({ text, directory: directory.map((p) => p.path), given });
      const row = rows[0]!;
      if (row.step.kind === 'duplicate') {
        const kept = candidates.find(
          (each) => each.task.path === (row.step as { of: { path: string } }).of.path,
        )!;
        expect(kept.likeness, label).toBe('same-title');
        expect(kept.task.recurrence, label).toBeNull();
        expect(kept.task.project, label).toBe(given.projects[0] ?? null);
        if (given.due !== null && kept.task.due !== null)
          expect(kept.task.due, label).toBe(given.due);
        expect(given.confidence, label).toBe('high');
      }
      for (const step of row.people) {
        if (step.kind === 'link') {
          const person = directory.find((each) => each.path === step.person.path) ?? MARA_PERSON;
          const byAddress = mine.addresses.some((a) => person.emails.includes(a.toLowerCase()));
          expect(byAddress || mentionsName(text, person.name), label).toBe(true);
        } else {
          expect(mentionsName(text, step.name), label).toBe(true);
          expect(mine.addresses, label).toContain(step.email);
          expect(
            personMatch({ name: step.name, email: step.email, people: directory }).kind,
            label,
          ).toBe('none');
        }
      }
      const added = withoutRepeatedAdds(rows).flatMap((each) =>
        each.people.flatMap((step) => (step.kind === 'add' ? [mailboxKey(step.email)] : [])),
      );
      expect(new Set(added).size, label).toBe(added.length);
    }
  });
});
