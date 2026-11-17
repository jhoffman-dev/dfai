/**
 * What a rule held by an hourly limit says (#813), built from
 * {@link NoteRunsHold} so whoever shows it never reads the state back out of
 * a sentence. A rule whose runs in the hour failed is failing, not waiting,
 * and says so; one that is only waiting says it is not broken, which limit,
 * when it runs, and the one thing that would help, if any: turning off
 * another rule that is on and shares its asks. The limits are constants, so
 * nothing else is offered.
 */

import type { HoldFailures, NoteRunsHold, RuleAsks } from './automation-due.ts';
import { localTimeMs, localTimeOf } from './schedule.ts';

const MINUTE_MS = 60_000;

/**
 * Whether a held rule is failing rather than waiting: any run that spent the
 * limit holding it failed. Such a rule is shown and logged as failing.
 */
export function noteRunsHoldIsFailing(hold: NoteRunsHold): boolean {
  return hold.failures !== null;
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

/** What a failing hold says: how many of its runs failed, the last one's why, and when it tries again. */
function failingMessage(hold: NoteRunsHold, { failed, ran, latest }: HoldFailures): string {
  const count =
    failed === ran
      ? `It failed all ${ran} times it ran this hour.`
      : `It failed ${failed} of the ${ran} times it ran this hour.`;
  const why = /[.!?]$/.test(latest.trim()) ? latest.trim() : `${latest.trim()}.`;
  const limits =
    hold.runs !== null && hold.sharedAsks !== null
      ? 'It has used up two hourly limits'
      : 'It has used up its hourly limit';
  return `${count} The last time: ${why} ${limits}, so it tries again at ${runsAt(hold.until)}.`;
}

/** The sentences a held rule says. */
export function noteRunsHoldMessage(hold: NoteRunsHold): string {
  if (hold.failures !== null) return failingMessage(hold, hold.failures);
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
  return `${what} ${remedy}`;
}
