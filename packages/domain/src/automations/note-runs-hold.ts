/**
 * What a rule held by an hourly limit says (#813): that it is waiting, not
 * broken; which limit, with its counts; which rules spent a shared one; when
 * it runs; and what the person may do. Built from {@link NoteRunsHold}, so
 * whoever shows it never has to read the state back out of a sentence.
 */

import type { NoteRunsHold } from './automation-due.ts';

const ASK_MEANS =
  'An ask is one question to Claude about one note, or about one part of a long note.';

/** “A”, “A” and “B”, “A”, “B” and “C” — or `or` in place of `and`. */
function quotedList(names: readonly string[], joiner: 'and' | 'or' = 'and'): string {
  const quoted = names.map((name) => `“${name}”`);
  return quoted.length < 2
    ? (quoted[0] ?? '')
    : `${quoted.slice(0, -1).join(', ')} ${joiner} ${quoted[quoted.length - 1]}`;
}

function runsSentence({ most, spent, countsAsks }: NonNullable<NoteRunsHold['runs']>): string {
  return countsAsks
    ? `It may run ${most} times an hour, each question it asks Claude counted as a run, and it has used ${spent} in the last hour.`
    : `It may run ${most} times an hour, and it has run ${spent} times in the last hour.`;
}

function asksSentences(
  rule: string,
  { most, asked, by }: NonNullable<NoteRunsHold['sharedAsks']>,
): string[] {
  const others = by.filter(({ name }) => name !== rule).map(({ name }) => name);
  if (others.length === 0) {
    return [
      `It may ask Claude ${most} times an hour, and it has asked ${asked} times in the last hour.`,
      ASK_MEANS,
    ];
  }
  const counts = by.map(({ name, asks }) => `“${name}” ${asks}`).join(', ');
  return [
    `It shares one limit with ${quotedList(others)}: together they may ask Claude ${most} times an hour.`,
    ASK_MEANS,
    `In the last hour they asked ${asked} times: ${counts}.`,
  ];
}

/** The rules besides it that spent the shared asks: the ones turning off would leave them to it. */
function otherAskers({ rule, sharedAsks }: NoteRunsHold): string[] {
  return (sharedAsks?.by ?? []).filter(({ name }) => name !== rule).map(({ name }) => name);
}

/**
 * The sentences a held rule says. `alsoReading` names the rules that read
 * every meeting a second time beside it (#793), offered to be turned off.
 */
export function noteRunsHoldMessage(
  hold: NoteRunsHold,
  { alsoReading = [] }: { alsoReading?: readonly string[] } = {},
): string {
  const both = hold.runs !== null && hold.sharedAsks !== null;
  const askers = otherAskers(hold);
  const readers = alsoReading.filter((name) => !askers.includes(name));
  const sentences = [
    `Waiting, not broken: it has reached ${both ? 'two hourly limits' : 'an hourly limit'}.`,
    ...(hold.runs === null ? [] : [runsSentence(hold.runs)]),
    ...(hold.sharedAsks === null ? [] : asksSentences(hold.rule, hold.sharedAsks)),
    `It runs next at ${hold.until.slice(11, 16)}, on what changed meanwhile.`,
    askers.length === 0
      ? 'Nothing needs fixing: it catches up by itself.'
      : `Nothing needs fixing: wait, or turn off ${quotedList(askers, 'or')} to leave the limit to this rule.`,
    ...readers.flatMap((name) => [
      `“${name}” reads every meeting too, so Claude is asked about each one twice.`,
      'You can turn it off: this rule already pulls out the action items.',
    ]),
  ];
  return sentences.join(' ');
}
