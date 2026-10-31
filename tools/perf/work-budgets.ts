/*
 * The work budgets (`tools/perf/budgets.json`): how much one action may make
 * the app do, as counts — React commits, component renders, host commands by
 * name — so the gate fails when the app does more than it did, and a count on
 * one machine is the count on every machine. Time is too noisy on a CI runner
 * to fail on; it is reported beside the counts and never gated.
 *
 * Pure: the harness (`budgets.spec.ts`) measures, this compares and words it.
 */

/** What one action made the app do, from its input until the app went quiet. */
export interface Work {
  readonly commits: number;
  /** Each component's renders, mounts included, by name. */
  readonly renders: Readonly<Record<string, number>>;
  /** Each host command sent, by name. */
  readonly calls: Readonly<Record<string, number>>;
}

/** The most one action may do. A host command not listed may not be sent at all. */
export interface ActionBudget {
  readonly commits: number;
  /** Every component render, summed. */
  readonly renders: number;
  readonly calls: Readonly<Record<string, number>>;
  /**
   * Hard rules, never given headroom: the most times these components (a
   * list's rows) may render. Ticking one row draws that row, not the list.
   */
  readonly rows?: Readonly<Record<string, number>>;
  /**
   * The commits were set by hand from CI's count (`withHeadroom` of it), which
   * runs a few above a Mac's for this action: `write` keeps them as they are,
   * so a Mac run cannot lower them below what CI counts.
   */
  readonly commitsFromCi?: true;
  /**
   * As `commitsFromCi`, for the renders: an action whose draws land a few
   * more on CI than on a Mac — the focus settling after a pane closes —
   * keeps the renders set from CI's count.
   */
  readonly rendersFromCi?: true;
}

/** `budgets.json`: a note for the reader, and each action's budget by name. */
export interface BudgetsFile {
  readonly $comment: readonly string[];
  readonly actions: Readonly<Record<string, ActionBudget>>;
}

/** One count out of its budget: over it, far under it, or missing from it. */
export interface Breach {
  readonly count: string;
  readonly budget: number;
  readonly actual: number;
  /** Why it fails, when it is not simply over: under the floor, never drawn, or no budget to hold to. */
  readonly why?: string;
}

/**
 * A measured count with room to vary: 10% or 2, whichever is more. Work that
 * is not done today (0) gets none — it must not start.
 */
export function withHeadroom(measured: number): number {
  if (measured === 0) return 0;
  return measured + Math.max(2, Math.ceil(measured * 0.1));
}

/**
 * The same for summed component renders, at 2%: a sum in the tens of
 * thousands would hide a whole extra list's worth of rows in 10%.
 */
export function withRenderHeadroom(measured: number): number {
  if (measured === 0) return 0;
  return measured + Math.max(2, Math.ceil(measured * 0.02));
}

/**
 * The least an action may count against a budget: half of it. Less, and the
 * action most likely did not happen — a step skipped, a window that closed
 * before the work came — and a gate that passes on no work is fooled.
 */
export const floorOf = (budget: number): number => Math.floor(budget / 2);

/** Re-recording a budget past its floor is allowed only on purpose, once the work really went. */
export interface DropRule {
  /** `PERF_BUDGETS_ALLOW_DROP=1`: the counts fell for a reason, and the budget may follow. */
  readonly allowDrop?: boolean;
}

const sum = (counts: Readonly<Record<string, number>>) =>
  Object.values(counts).reduce((total, count) => total + count, 0);

const UNDER =
  'far under its budget: the action probably did not happen (if the work really went, re-record with PERF_BUDGETS=write PERF_BUDGETS_ALLOW_DROP=1)';
const UNBUDGETED = 'the budget has no number for this count';
const UNNAMED = 'never rendered under that name: renamed, or a minified build';

/**
 * Every count in `work` out of `budget`: over it; under its floor (unless the
 * drop is allowed); a hard row rule whose component never rendered; and a
 * count the budget has no number for.
 */
export function breachesOf(
  work: Work,
  budget: ActionBudget,
  { allowDrop = false }: DropRule = {},
): Breach[] {
  const breaches: Breach[] = [];
  const held = (count: string, limit: unknown, actual: number) => {
    if (typeof limit !== 'number' || !Number.isFinite(limit)) {
      breaches.push({ count, budget: Number.NaN, actual, why: UNBUDGETED });
    } else if (actual > limit) {
      breaches.push({ count, budget: limit, actual });
    } else if (!allowDrop && actual < floorOf(limit)) {
      breaches.push({ count, budget: limit, actual, why: UNDER });
    }
  };
  for (const [row, limit] of Object.entries(budget.rows ?? {})) {
    const actual = work.renders[row];
    if (actual === undefined)
      breaches.push({
        count: `${row} renders (hard rule)`,
        budget: limit,
        actual: 0,
        why: UNNAMED,
      });
    else if (actual > limit)
      breaches.push({ count: `${row} renders (hard rule)`, budget: limit, actual });
  }
  held('React commits', budget.commits, work.commits);
  held('component renders', budget.renders, sum(work.renders));
  const budgeted = budget.calls as Readonly<Record<string, unknown>>;
  for (const command of [
    ...new Set([...Object.keys(work.calls), ...Object.keys(budgeted)]),
  ].sort()) {
    held(`host calls to ${command}`, budgeted[command] ?? 0, work.calls[command] ?? 0);
  }
  return breaches;
}

/** The `limit` largest entries of a count, as `name×count`, most first. */
export function topOf(counts: Readonly<Record<string, number>>, limit = 5): string {
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length === 0) return 'none';
  return ranked
    .slice(0, limit)
    .map(([name, count]) => `${name}×${count}`)
    .join(', ');
}

const signed = (difference: number) => (difference >= 0 ? `+${difference}` : `${difference}`);

/** What the gate prints when an action is out of its budget: which counts, by how much, why, and who did it. */
export function describeBreaches(action: string, work: Work, breaches: readonly Breach[]): string {
  const lines = breaches.map(({ count, budget, actual, why }) =>
    why === undefined
      ? `  ${count}: budget ${budget}, actual ${actual} (${signed(actual - budget)})`
      : `  ${count}: budget ${Number.isNaN(budget) ? 'none' : budget}, actual ${actual}: ${why}`,
  );
  const over = breaches.some((breach) => breach.why === undefined);
  return [
    `"${action}" ${over ? 'did more work than' : 'is out of'} its budget (tools/perf/budgets.json):`,
    ...lines,
    `  most rendered: ${topOf(work.renders)}`,
    `  most called:   ${topOf(work.calls)}`,
  ].join('\n');
}

/** The budget an action measured at `work` gets: its counts, with headroom; rows keep their rules. */
export function budgetFor(work: Work, rows?: ActionBudget['rows']): ActionBudget {
  return {
    commits: withHeadroom(work.commits),
    renders: withRenderHeadroom(sum(work.renders)),
    calls: Object.fromEntries(
      Object.entries(work.calls)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([command, count]) => [command, withHeadroom(count)]),
    ),
    ...(rows === undefined ? {} : { rows }),
  };
}

/**
 * `was`, lowered wherever `now` is under it, and never raised: each count is
 * the lesser of the two. A count `was` lacks, or holds as no number, takes
 * `now`'s. One that would fall below `was`'s floor keeps `was` unless the
 * drop is allowed: a step that stopped happening must not write itself a
 * budget of nothing. An action with no budget yet takes `now` whole.
 */
export function lowered(
  was: ActionBudget | undefined,
  now: ActionBudget,
  { allowDrop = false }: DropRule = {},
): ActionBudget {
  if (was === undefined) return now;
  const lower = (before: unknown, after: number) => {
    if (typeof before !== 'number' || !Number.isFinite(before)) return after;
    if (!allowDrop && after < floorOf(before)) return before;
    return Math.min(before, after);
  };
  const kept = Object.keys(was.calls).filter((command) => command in now.calls || !allowDrop);
  const calls = Object.fromEntries(
    kept
      .map((command) => [command, lower(was.calls[command], now.calls[command] ?? 0)] as const)
      .filter(([, count]) => count > 0),
  );
  return {
    commits: was.commitsFromCi === true ? was.commits : lower(was.commits, now.commits),
    renders: was.rendersFromCi === true ? was.renders : lower(was.renders, now.renders),
    calls,
    ...(was.rows === undefined ? {} : { rows: was.rows }),
    ...(was.commitsFromCi === true ? { commitsFromCi: true } : {}),
    ...(was.rendersFromCi === true ? { rendersFromCi: true } : {}),
  };
}

/**
 * Whether the component names counted look minified: none longer than three
 * letters, or most of them one or two. The row rules and the "most rendered"
 * names mean nothing then, so the run refuses such a build.
 */
export function looksMinified(names: readonly string[]): boolean {
  if (names.length === 0) return true;
  const short = names.filter((name) => name.length <= 2).length;
  return !names.some((name) => name.length > 3) || short * 2 > names.length;
}

/** One action as the run measured it, for the report. */
export interface Measurement {
  readonly action: string;
  readonly work: Work;
  readonly budget: ActionBudget | undefined;
  /** Reported, never gated: milliseconds from the input to the page being ready. */
  readonly inputToReady: number;
  /** Reported, never gated: the longest the main thread went without a frame. */
  readonly longestFrame: number;
}

const against = (actual: number, limit: number | undefined) =>
  limit === undefined ? `${actual} / none` : `${actual} / ${limit}${actual > limit ? ' ✗' : ''}`;

/**
 * The run as a Markdown table, for the CI log and the job summary: each
 * count beside its budget, and the times, which are there to watch, not to fail on.
 */
export function reportTable(measured: readonly Measurement[]): string {
  const head = [
    '| Action | Commits / budget | Renders / budget | Host calls / budget | Most called | Input→ready (ms) | Longest frame (ms) |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  const rows = measured.map(({ action, work, budget, inputToReady, longestFrame }) => {
    const calls = sum(work.calls);
    const allowed = budget === undefined ? undefined : sum(budget.calls);
    return `| ${action} | ${against(work.commits, budget?.commits)} | ${against(sum(work.renders), budget?.renders)} | ${against(calls, allowed)} | ${topOf(work.calls, 3)} | ${ms(inputToReady)} | ${ms(longestFrame)} |`;
  });
  return [...head, ...rows].join('\n');
}

/** Milliseconds, whole; a dash for an action the run did not time. */
const ms = (value: number) => (Number.isFinite(value) ? String(Math.round(value)) : '–');

/** What the timed pass took over one action: reported, never gated. */
export interface Times {
  readonly inputToReady: number;
  readonly longestFrame: number;
}

/**
 * What one run of the harness measured, by action: the first counted run's
 * counts and the timed pass's times. CI does the fixtures and passes on
 * machines of their own, each writing one of these, and puts them together.
 */
export interface PartResult {
  /** The counted runs this part did, in order; `counted` is the first's. Empty if it only timed. */
  readonly runs: readonly number[];
  readonly counted: Readonly<Record<string, Work>>;
  readonly timed: Readonly<Record<string, Times>>;
}

/** The report's rows: each of `actions` that was counted, its times beside it where it was timed. */
export function measurementsOf(
  actions: readonly string[],
  { counted, timed }: PartResult,
  budgets: BudgetsFile,
): Measurement[] {
  return actions.flatMap((action) => {
    const work = counted[action];
    if (work === undefined) return [];
    const times = timed[action];
    return [
      {
        action,
        work,
        budget: budgets.actions[action],
        inputToReady: times?.inputToReady ?? Number.NaN,
        longestFrame: times?.longestFrame ?? Number.NaN,
      },
    ];
  });
}

/** A part that only timed: its times as a table, the counts being another part's. */
export function timesTable(actions: readonly string[], timed: PartResult['timed']): string {
  const rows = actions.flatMap((action) => {
    const times = timed[action];
    return times === undefined
      ? []
      : [`| ${action} | ${ms(times.inputToReady)} | ${ms(times.longestFrame)} |`];
  });
  return [
    '| Action | Input→ready (ms) | Longest frame (ms) |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** How the whole run was counted: how many runs, and how far each action's may differ. */
export interface RunsWanted {
  readonly runs: number;
  readonly tolerance: Readonly<Partial<Record<string, RunTolerance>>>;
}

/**
 * The parts put back together, and what is wrong with them as a whole: an
 * action of `actions` that no part, or two, counted on some run of
 * `wanted.runs`, or timed; and a later run, counted apart from run 1, that
 * counted differently from it beyond the action's tolerance. Run 1's counts
 * are the result's; a part that counted runs together compared them itself.
 */
export function combineParts(
  parts: readonly PartResult[],
  actions: readonly string[],
  wanted: RunsWanted,
): { readonly result: PartResult; readonly problems: string[] } {
  const problems: string[] = [];
  const firstRuns = parts.filter((part) => part.runs[0] === 1);
  const counted = onePerAction(
    'counted on run 1',
    actions,
    firstRuns.map((part) => part.counted),
    problems,
  );
  for (let run = 2; run <= wanted.runs; run += 1) {
    const covering = parts.filter((part) => part.runs.includes(run));
    const counts = onePerAction(
      `counted on run ${run}`,
      actions,
      covering.map((part) => part.counted),
      problems,
    );
    const apart = new Set(
      covering.filter((part) => part.runs[0] === run).flatMap((part) => Object.keys(part.counted)),
    );
    for (const action of actions) {
      const [first, now] = [counted[action], counts[action]];
      if (!apart.has(action) || first === undefined || now === undefined) continue;
      const changed = differencesBetween(first, now, wanted.tolerance[action]);
      if (changed.length > 0) {
        problems.push(`"${action}" counted differently on run ${run}: ${changed.join(', ')}`);
      }
    }
  }
  const timed = onePerAction(
    'timed',
    actions,
    parts.map((part) => part.timed),
    problems,
  );
  return { result: { runs: [1], counted, timed }, problems };
}

/** Each action's one entry among `lists`; an action in none, or in more than one, is a problem. */
function onePerAction<Entry>(
  kind: string,
  actions: readonly string[],
  lists: readonly Readonly<Record<string, Entry>>[],
  problems: string[],
): Record<string, Entry> {
  const one: Record<string, Entry> = {};
  for (const action of actions) {
    const found = lists.flatMap((list) => (action in list ? [list[action]!] : []));
    if (found.length === 0) problems.push(`"${action}" was ${kind} by no part`);
    else if (found.length > 1) problems.push(`"${action}" was ${kind} by ${found.length} parts`);
    else one[action] = found[0]!;
  }
  return one;
}

/** How far two runs of one action may differ and still count as the same: none, unless said. */
export interface RunTolerance {
  readonly commits: number;
  /** For each component, how many renders either way. */
  readonly rendersEach: number;
}

const EXACT: RunTolerance = { commits: 0, rendersEach: 0 };

/**
 * Every count that differs between two runs of one action, beyond `tolerance`,
 * as `count: first → second`. Host calls are always held to an exact match.
 */
export function differencesBetween(
  first: Work,
  second: Work,
  tolerance: RunTolerance = EXACT,
): string[] {
  const differ: string[] = [];
  const compare = (count: string, a: number, b: number, allowed: number) => {
    if (Math.abs(a - b) > allowed) differ.push(`${count}: ${a} → ${b}`);
  };
  compare('React commits', first.commits, second.commits, tolerance.commits);
  for (const [kind, a, b, allowed] of [
    ['renders of', first.renders, second.renders, tolerance.rendersEach],
    ['host calls to', first.calls, second.calls, 0],
  ] as const) {
    for (const name of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      compare(`${kind} ${name}`, a[name] ?? 0, b[name] ?? 0, allowed);
    }
  }
  return differ;
}
