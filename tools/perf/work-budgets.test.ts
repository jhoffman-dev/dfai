import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  breachesOf,
  budgetFor,
  combineParts,
  describeBreaches,
  differencesBetween,
  looksMinified,
  lowered,
  measurementsOf,
  reportTable,
  timesTable,
  topOf,
  withHeadroom,
  withRenderHeadroom,
  type ActionBudget,
  type BudgetsFile,
  type Work,
} from './work-budgets.ts';
import { BUDGETED_ACTIONS } from './budgeted-actions.ts';

const work = (over: Partial<Work> = {}): Work => ({
  commits: 4,
  renders: { InboxRow: 2, Sidebar: 3 },
  calls: { read_note: 1 },
  ...over,
});

const budget: ActionBudget = {
  commits: 6,
  renders: 7,
  calls: { read_note: 3 },
  rows: { InboxRow: 2 },
};

describe('headroom', () => {
  it('is 2 for a small count and 10% for a large one', () => {
    expect(withHeadroom(1)).toBe(3);
    expect(withHeadroom(20)).toBe(22);
    expect(withHeadroom(21)).toBe(24);
    expect(withHeadroom(1000)).toBe(1100);
  });

  it('is none for work not done today', () => {
    expect(withHeadroom(0)).toBe(0);
  });
});

describe('breaches', () => {
  it('finds none within the budget, at the limit included', () => {
    expect(breachesOf(work({ commits: 6, renders: { InboxRow: 2, Sidebar: 5 } }), budget)).toEqual(
      [],
    );
  });

  it('names each count over its budget', () => {
    const over = work({ commits: 7, renders: { InboxRow: 3, Sidebar: 5 } });
    expect(breachesOf(over, budget)).toEqual([
      { count: 'InboxRow renders (hard rule)', budget: 2, actual: 3 },
      { count: 'React commits', budget: 6, actual: 7 },
      { count: 'component renders', budget: 7, actual: 8 },
    ]);
  });

  it('holds a command that has no budget to none', () => {
    expect(breachesOf(work({ calls: { read_note: 1, list_notes: 1 } }), budget)).toEqual([
      { count: 'host calls to list_notes', budget: 0, actual: 1 },
    ]);
  });

  it('holds a command to its own budget', () => {
    expect(breachesOf(work({ calls: { read_note: 4 } }), budget)).toEqual([
      { count: 'host calls to read_note', budget: 3, actual: 4 },
    ]);
  });
});

describe('the floor', () => {
  it('fails a count under half its budget, saying the action probably did not happen', () => {
    const little = work({ commits: 2 });
    const [breach] = breachesOf(little, budget);
    expect(breach).toMatchObject({ count: 'React commits', budget: 6, actual: 2 });
    expect(describeBreaches('Tick', little, breachesOf(little, budget))).toContain(
      'the action probably did not happen',
    );
  });

  it('lets a count fall past its floor when the drop is allowed', () => {
    expect(breachesOf(work({ commits: 2 }), budget, { allowDrop: true })).toEqual([]);
  });

  it('holds a budgeted command to its floor too', () => {
    expect(breachesOf(work({ calls: {} }), { ...budget, calls: { read_note: 4 } })).toEqual([
      expect.objectContaining({ count: 'host calls to read_note', budget: 4, actual: 0 }),
    ]);
  });
});

describe('a minified build', () => {
  it('is told apart from one that kept its names', () => {
    expect(looksMinified(['e', 't', 'n', 'Ar'])).toBe(true);
    expect(looksMinified([])).toBe(true);
    expect(looksMinified(['TaskRow', 'Icon', 'e'])).toBe(false);
  });
});

describe('the failure message', () => {
  it('names the action, each count, budget against actual, and the top offenders', () => {
    const over = work({ commits: 9, calls: { read_note: 5, list_notes: 2 } });
    const message = describeBreaches('Open the Inbox', over, breachesOf(over, budget));
    expect(message).toBe(
      [
        '"Open the Inbox" did more work than its budget (tools/perf/budgets.json):',
        '  React commits: budget 6, actual 9 (+3)',
        '  host calls to list_notes: budget 0, actual 2 (+2)',
        '  host calls to read_note: budget 3, actual 5 (+2)',
        '  most rendered: Sidebar×3, InboxRow×2',
        '  most called:   read_note×5, list_notes×2',
      ].join('\n'),
    );
  });

  it('ranks the top five, ties by name, and says none when there were none', () => {
    expect(topOf({ b: 1, a: 1, c: 9, d: 2, e: 3, f: 4 })).toBe('c×9, f×4, e×3, d×2, a×1');
    expect(topOf({})).toBe('none');
  });
});

describe('writing budgets', () => {
  it('gives a new action its counts with headroom, and keeps its rows', () => {
    expect(budgetFor(work(), { InboxRow: 2 })).toEqual({
      commits: 6,
      renders: 7,
      calls: { read_note: 3 },
      rows: { InboxRow: 2 },
    });
  });

  it('only ever lowers a budget', () => {
    const now = budgetFor(
      work({ commits: 100, renders: { Sidebar: 1 }, calls: { list_notes: 1 } }),
    );
    // read_note stopped being sent: past its floor, so it keeps its budget unless the drop is allowed.
    expect(lowered(budget, now)).toEqual({
      commits: 6,
      renders: 3,
      calls: { read_note: 3 },
      rows: { InboxRow: 2 },
    });
    // Allowed, it is no longer allowed at all; list_notes was never allowed.
    expect(lowered(budget, now, { allowDrop: true })).toEqual({
      commits: 6,
      renders: 3,
      calls: {},
      rows: { InboxRow: 2 },
    });
  });

  it('refuses to lower a count past its floor unless the drop is allowed', () => {
    // 0 commits, against a budget of 6 whose floor is 3.
    const fell = budgetFor(work({ commits: 0 }));
    expect(lowered(budget, fell).commits).toBe(6);
    expect(lowered(budget, fell, { allowDrop: true }).commits).toBe(0);
  });

  it('keeps commits set from CI’s count, however low a Mac counts them', () => {
    const fromCi = { ...budget, commits: 37, commitsFromCi: true as const };
    const lowerHere = budgetFor(work({ commits: 30 }));
    const kept = lowered(fromCi, lowerHere, { allowDrop: true });
    expect(kept.commits).toBe(37);
    expect(kept.commitsFromCi).toBe(true);
    // Every other count is still lowered as usual.
    expect(lowered(budget, lowerHere).commits).toBeLessThan(37);
  });

  it('keeps renders set from CI’s count the same way', () => {
    const fromCi = { ...budget, renders: 48, rendersFromCi: true as const };
    const lowerHere = budgetFor(work({ renders: { Row: 39 } }));
    const kept = lowered(fromCi, lowerHere, { allowDrop: true });
    expect(kept.renders).toBe(48);
    expect(kept.rendersFromCi).toBe(true);
    expect(lowered(budget, lowerHere).renders).toBeLessThan(48);
  });

  it('gives summed renders 2% of headroom, not 10%', () => {
    expect(budgetFor(work({ renders: { Row: 10_000 } })).renders).toBe(10_200);
    expect(withRenderHeadroom(10)).toBe(12);
    expect(withRenderHeadroom(0)).toBe(0);
  });

  it('takes the measured budget whole for an action that had none', () => {
    const now = budgetFor(work());
    expect(lowered(undefined, now)).toBe(now);
  });
});

describe('budgets.json', () => {
  const file = JSON.parse(
    readFileSync(new URL('./budgets.json', import.meta.url), 'utf8'),
  ) as BudgetsFile;

  it('budgets every action the harness measures, and nothing else', () => {
    expect(Object.keys(file.actions).sort()).toEqual([...BUDGETED_ACTIONS].sort());
  });

  it('holds the page to doing nothing while idle', () => {
    for (const action of BUDGETED_ACTIONS.filter((name) => name.startsWith('Idle'))) {
      expect(file.actions[action]).toEqual({ commits: 0, renders: 0, calls: {} });
    }
  });

  it('says that the numbers only go down', () => {
    expect(file.$comment.join(' ')).toMatch(/only go down/i);
  });
});

describe('the report', () => {
  it('sets each count beside its budget, marks a breach, and rounds the times', () => {
    const table = reportTable([
      { action: 'Open the Inbox', work: work(), budget, inputToReady: 12.4, longestFrame: 30.6 },
      {
        action: 'Something new',
        work: work({ commits: 9 }),
        budget: undefined,
        inputToReady: 1,
        longestFrame: 2,
      },
    ]);
    const [, , inbox, fresh] = table.split('\n');
    expect(inbox).toBe('| Open the Inbox | 4 / 6 | 5 / 7 | 1 / 3 | read_note×1 | 12 | 31 |');
    expect(fresh).toBe('| Something new | 9 / none | 5 / none | 1 / none | read_note×1 | 1 | 2 |');
    expect(
      reportTable([
        { action: 'Over', work: work({ commits: 7 }), budget, inputToReady: 0, longestFrame: 0 },
      ]),
    ).toContain('7 / 6 ✗');
  });
});

describe('two runs compared', () => {
  it('allows only the difference it is told to, and never in host calls', () => {
    const second = work({ commits: 6, renders: { InboxRow: 4, Sidebar: 3 } });
    const loose = { commits: 2, rendersEach: 2 };
    expect(differencesBetween(work(), second, loose)).toEqual([]);
    expect(differencesBetween(work(), work({ commits: 7 }), loose)).toEqual([
      'React commits: 4 → 7',
    ]);
    expect(differencesBetween(work(), work({ calls: { read_note: 2 } }), loose)).toEqual([
      'host calls to read_note: 1 → 2',
    ]);
  });

  it('finds nothing between equal runs', () => {
    expect(differencesBetween(work(), work())).toEqual([]);
  });

  it('names every count that moved, including one only one run had', () => {
    const second = work({
      commits: 5,
      renders: { InboxRow: 2 },
      calls: { read_note: 1, list_notes: 1 },
    });
    expect(differencesBetween(work(), second)).toEqual([
      'React commits: 4 → 5',
      'renders of Sidebar: 3 → 0',
      'host calls to list_notes: 0 → 1',
    ]);
  });
});

describe('putting the parts of a run together', () => {
  const counts = (commits: number): Work => ({ commits, renders: { Row: 2 }, calls: {} });
  const times = { inputToReady: 12, longestFrame: 8 };

  it('takes each action from the one part that counted it and the one that timed it', () => {
    const { result, problems } = combineParts(
      [
        { counted: { Open: counts(3) }, timed: {} },
        { counted: {}, timed: { Open: times, Close: times } },
        { counted: { Close: counts(1) }, timed: {} },
      ],
      ['Open', 'Close'],
    );
    expect(problems).toEqual([]);
    expect(result).toEqual({
      counted: { Open: counts(3), Close: counts(1) },
      timed: { Open: times, Close: times },
    });
  });

  it('names an action no part counted or timed, and one two parts did', () => {
    const { problems } = combineParts(
      [
        { counted: { Open: counts(3) }, timed: { Open: times } },
        { counted: { Open: counts(3) }, timed: {} },
      ],
      ['Open', 'Close'],
    );
    expect(problems).toEqual([
      '"Open" was counted by 2 parts',
      '"Close" was counted by no part',
      '"Close" was timed by no part',
    ]);
  });

  it('reports each counted action with its times, and a dash where it was not timed', () => {
    const budgets: BudgetsFile = {
      $comment: [],
      actions: { Open: { commits: 4, renders: 3, calls: {} } },
    };
    const rows = measurementsOf(
      ['Open', 'Close', 'Never'],
      { counted: { Open: counts(3), Close: counts(1) }, timed: { Open: times } },
      budgets,
    );
    expect(rows.map((row) => row.action)).toEqual(['Open', 'Close']);
    const table = reportTable(rows);
    expect(table).toContain('| Open | 3 / 4 | 2 / 3 | 0 / 0 | none | 12 | 8 |');
    expect(table).toContain('| Close | 1 / none | 2 / none | 0 / none | none | – | – |');
  });

  it('tables a part that only timed by its times', () => {
    expect(timesTable(['Open', 'Close'], { Open: times })).toBe(
      [
        '| Action | Input→ready (ms) | Longest frame (ms) |',
        '| --- | --- | --- |',
        '| Open | 12 | 8 |',
      ].join('\n'),
    );
  });
});
