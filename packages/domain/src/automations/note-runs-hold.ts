/**
 * What a rule held by an hourly limit says (#813), built from
 * {@link NoteRunsHold} so whoever shows it never reads the state back out of
 * a sentence. A rule whose own last run this hour failed is failing, not
 * waiting, and says so; one that is only waiting says it is not broken, which limit,
 * when it runs, and the one thing that would help, if any: turning off
 * another rule that is on and shares its asks. The limits are constants, so
 * nothing else is offered.
 */

import type { HoldFailures, NoteRunsHold, RuleAsks } from './automation-due.ts';
import { localTimeMs, localTimeOf } from './schedule.ts';

const MINUTE_MS = 60_000;

/**
 * Whether a held rule is failing rather than waiting: its own last run this
 * hour failed. One that failed earlier and has since worked is waiting.
 */
export function noteRunsHoldIsFailing(hold: NoteRunsHold): boolean {
  return hold.failures?.lastFailed ?? false;
}

/** The minute it can run, `14:32`: a hold ending part-way through a minute runs at the next one. */
function runsAt(until: NoteRunsHold['until']): string {
  const ms = localTimeMs(until);
  if (ms === null) return until.slice(11, 16);
  return localTimeOf(Math.ceil(ms / MINUTE_MS) * MINUTE_MS).slice(11, 16);
}

/** “Board digest”, or “the other …” for one named as the held rule is. */
function nameOf(rule: string, other: RuleAsks, lead = false): string {
  if (other.own) return 'this rule';
  if (other.name !== rule) return `“${other.name}”`;
  return lead ? `another “${other.name}”` : `the other “${other.name}”`;
}

/** “A”, “A” and “B”, “A”, “B” and “C”. */
function andList(items: readonly string[]): string {
  return items.length < 2
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function runsClause({ most, spent, countsAsks }: NonNullable<NoteRunsHold['runs']>): string {
  return countsAsks
    ? `it has used ${spent} runs this hour, and ${most} is its most (each question it asks Claude counts as a run)`
    : `it has run ${spent} times this hour, and ${most} is its most`;
}

function asksClause(
  rule: string,
  { most, asked, by }: NonNullable<NoteRunsHold['sharedAsks']>,
  others: readonly RuleAsks[],
): string {
  if (others.length === 0) {
    return `it has asked Claude ${asked} times this hour, and ${most} is its most (an ask is one question; a long meeting takes a few)`;
  }
  const counts = by
    .map((each) => {
      const off = each.enabled ? '' : ' before it was turned off';
      return `${nameOf(rule, each)} ${each.asks}${off}`;
    })
    .join(', ');
  return (
    `it shares one limit of ${most} asks to Claude an hour with ${andList(others.map((each) => nameOf(rule, each, true)))} ` +
    `(${counts}; an ask is one question, and a long meeting takes a few)`
  );
}

const sentence = (clause: string) => `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;

/** How many of its runs failed: `all 20 times`, `3 of the 20 times`, `the one time`, `both times`. */
function failedCount({ failed, ran }: HoldFailures): string {
  if (ran === 1) return 'It failed the one time it ran this hour.';
  if (failed === ran) {
    return ran === 2
      ? 'It failed both times it ran this hour.'
      : `It failed all ${ran} times it ran this hour.`;
  }
  return `It failed ${failed} of the ${ran} times it ran this hour.`;
}

/** What a failing hold says: how many of its runs failed, the last failure's why, and when it tries again. */
function failingMessage(hold: NoteRunsHold, failures: HoldFailures): string {
  const reason = failures.latest.trim();
  const why =
    reason === '' ? [] : [`The last failure: ${/[.!?]$/.test(reason) ? reason : `${reason}.`}`];
  return [
    failedCount(failures),
    ...why,
    `${usedUp(hold)}, so it tries again at ${runsAt(hold.until)}.`,
  ].join(' ');
}

/**
 * Which limit is used up, and by whom: its own runs, or the asks it shares —
 * named as the waiting message names them, since there another rule may
 * have spent them — or both.
 */
function usedUp({ rule, runs, sharedAsks }: NoteRunsHold): string {
  if (sharedAsks === null) return 'It has used up its hourly limit';
  const others = sharedAsks.by.filter((each) => !each.own);
  const sharedWith = andList(others.map((each) => nameOf(rule, each, true)));
  const { most } = sharedAsks;
  if (runs === null) {
    return others.length === 0
      ? `It has used up its ${most} asks to Claude this hour`
      : `The ${most} asks to Claude an hour that it shares with ${sharedWith} are used up`;
  }
  return others.length === 0
    ? `It has used up its hourly runs and its ${most} asks to Claude`
    : `It has used up its hourly runs and the ${most} asks to Claude an hour it shares with ${sharedWith}`;
}

/** Said of a waiting rule whose earlier runs failed, so the count is not hidden. */
function earlierFailures(failures: HoldFailures | null): string[] {
  if (failures === null) return [];
  const runs = failures.failed === 1 ? '1 run' : `${failures.failed} runs`;
  return [`${runs} failed earlier this hour; the last one worked.`];
}

/** The sentences a held rule says. */
export function noteRunsHoldMessage(hold: NoteRunsHold): string {
  if (hold.failures?.lastFailed) return failingMessage(hold, hold.failures);
  const shared = hold.sharedAsks;
  const others = (shared?.by ?? []).filter((each) => !each.own);
  const offerable = others.filter((each) => each.enabled);
  const clauses = [
    ...(hold.runs === null ? [] : [runsClause(hold.runs)]),
    ...(shared === null ? [] : [asksClause(hold.rule, shared, others)]),
  ];
  const what =
    clauses.length === 1
      ? `Not broken: ${clauses[0]}.`
      : `Not broken: it has reached two hourly limits. ${clauses.map(sentence).join(' ')}`;
  const when = `It runs next at ${runsAt(hold.until)}, on what arrived meanwhile`;
  const remedy =
    shared === null || offerable.length === 0
      ? `${when}; nothing to do.`
      : `${when}. To give it the whole ${shared.most}, turn off ${andList(offerable.map((each) => nameOf(hold.rule, each)))}.`;
  return [what, ...earlierFailures(hold.failures), remedy].join(' ');
}
