import type { RunTolerance } from './work-budgets.ts';

/**
 * Every action the work budgets measure, in the order `budgets.spec.ts` does
 * them: each starts from where the one before left the app.
 */
export const BUDGETED_ACTIONS = [
  'Open a vault',
  'Click a sidebar note',
  'Switch notes',
  'Open in a new tab',
  'Switch tabs',
  'Type 10 characters in a note',
  'One autosave and its watcher echo',
  'Idle 3 s with a note open',
  // A block's handle (#569): following the pointer, then a block dragged by it.
  'Hover a block',
  'Drag a block',
  'Split the window',
  'Focus the other pane',
  'Close a pane',
  'Open Settings',
  'Open Today',
  'Idle 3 s on Today',
  'Tick a task on Today',
  'Choose a task on Today',
  // A scroll that keeps the same rows drawn draws none of the list again (#238).
  'Scroll Today a little',
  'Open the Inbox',
  'Decide an Inbox row',
  "Open a person's page",
  'Open the 420-row table',
  'Scroll the 420-row table a little',
  '⌘K + 5 keys over the table',
  'Drag a board card',
  'Run a 2,000-row SQL query',
  'Run a 920-row DFAI query',
  // Ask (#37), from the PDF the pass left open: the page, its chunk, and the recent questions.
  'Open Ask (⌘J)',
  // On the research fixture (#507): 2,000 literature notes holding 20,000 highlights.
  'Open the Library (2,000 sources)',
  'Open All highlights (20,000)',
  'Open a 500-page PDF',
  'Scroll a 500-page PDF to its middle',
  // A generated book of 1,000 chapters, about 30 MB (#505).
  'Open a 1,000-chapter EPUB',
  'Turn a chapter of a 1,000-chapter EPUB',
  'Find in a 1,000-chapter EPUB',
  // On a literature note of 500 highlights, each drawn as its quote and a comment to type in (#534).
  'Open a 500-highlight literature note',
  'Save a comment in a 500-highlight note',
  // A note of code in five languages, each language's grammar loaded on first use (#265).
  'Open a note with code in 5 languages',
  // Last on the main fixture: once on, the cache of meanings follows every later write (P32-02).
  '⌘K by meaning + 5 keys',
] as const;

export type BudgetedAction = (typeof BUDGETED_ACTIONS)[number];

/**
 * The actions allowed to differ between two counted runs, and by how much.
 * Opening the vault indexes 2,000 notes: on CI it counted 121 commits on one
 * run and 122 on the next, each component one render apart, host calls the
 * same (#130). Every other action must match exactly, the drag included
 * (#243). The same whether the runs were counted on one machine or two.
 */
export const RUN_TOLERANCE: Partial<Record<BudgetedAction, RunTolerance>> = {
  'Open a vault': { commits: 2, rendersEach: 2 },
};

/**
 * The vaults the actions are done on, in the order a run does them: each a
 * pass on a fresh page (`budgets.spec.ts`).
 */
export const BUDGET_FIXTURES = ['main', 'research', 'long-note', 'code-note'] as const;

export type BudgetFixture = (typeof BUDGET_FIXTURES)[number];

/** The actions done on each fixture but the main one, which does all the rest. */
const OFF_MAIN: Readonly<Record<Exclude<BudgetFixture, 'main'>, readonly BudgetedAction[]>> = {
  research: ['Open the Library (2,000 sources)', 'Open All highlights (20,000)'],
  'long-note': ['Open a 500-highlight literature note', 'Save a comment in a 500-highlight note'],
  'code-note': ['Open a note with code in 5 languages'],
};

/** The actions done on `fixtures`, in `BUDGETED_ACTIONS`' order. */
export function actionsOn(fixtures: readonly BudgetFixture[]): BudgetedAction[] {
  const elsewhere = new Set(Object.values(OFF_MAIN).flat());
  const on = new Set<BudgetedAction>(
    fixtures.flatMap((fixture) =>
      fixture === 'main'
        ? BUDGETED_ACTIONS.filter((action) => !elsewhere.has(action))
        : OFF_MAIN[fixture],
    ),
  );
  return BUDGETED_ACTIONS.filter((action) => on.has(action));
}

/** The two ways a run does the actions: counted on the work clock, and timed. */
export const BUDGET_PASSES = ['counted', 'timed'] as const;

export type BudgetPass = (typeof BUDGET_PASSES)[number];

/** Which fixtures and passes one run does: by default all, as `pnpm perf:budgets` does. */
export interface BudgetsPart {
  readonly fixtures: readonly BudgetFixture[];
  readonly passes: readonly BudgetPass[];
}

/**
 * The part named by `PERF_BUDGETS_FIXTURES` and `PERF_BUDGETS_PASSES`, each a
 * comma-separated list, in their canonical order; unset or empty, all of them.
 * CI does the parts on machines of their own, and a report job puts them back
 * together (`tools/perf/combine-budgets.ts`).
 */
export function budgetsPart(env: {
  readonly fixtures?: string | undefined;
  readonly passes?: string | undefined;
}): BudgetsPart {
  return {
    fixtures: listOf('PERF_BUDGETS_FIXTURES', env.fixtures, BUDGET_FIXTURES),
    passes: listOf('PERF_BUDGETS_PASSES', env.passes, BUDGET_PASSES),
  };
}

function listOf<Name extends string>(
  variable: string,
  given: string | undefined,
  every: readonly Name[],
): Name[] {
  if (given === undefined || given.trim() === '') return [...every];
  const named = given.split(',').map((name) => name.trim());
  const unknown = named.filter((name) => !(every as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new Error(`${variable} names ${unknown.join(', ')}; it takes ${every.join(', ')}`);
  }
  return every.filter((name) => named.includes(name));
}

/** The name a part's results are written under: empty for the whole run. */
export function partLabel(part: BudgetsPart): string {
  const whole =
    part.fixtures.length === BUDGET_FIXTURES.length && part.passes.length === BUDGET_PASSES.length;
  return whole ? '' : `${part.fixtures.join('+')}.${part.passes.join('+')}`;
}
