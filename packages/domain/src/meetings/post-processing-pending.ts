/**
 * ADR-0035 part 3, ADR-0036 (#182): whether an imported meeting's
 * post-processing — its summary and the owner's tasks, written together in
 * the step's one meeting write — is still to come. This is the one
 * definition of "pending": the Inbox row's "summary pending" (#186) and the
 * waiting count both judge by it.
 *
 * A meeting is pending while a rule that writes summaries is on, the import
 * let it in, it is out of the Archive, has transcript turns, is dated within
 * the rule's reach ({@link meetingReachFrom}), carries no summary block, and the rule's
 * handled ledger has not finished with it: it has never answered it, or it
 * holds an answer stored for its words whose writes are not done (#180: a
 * run that asked and could not finish, waiting for its retry). A run that
 * failed before asking records nothing, so its meetings stay unanswered.
 *
 * The facts are read by the caller and handed in; this reads nothing.
 */

import { isArchivedPath } from '../archive/archive.ts';
import { movingDate } from '../automations/automation-query.ts';
import type { Expression, QueryValue } from '../query-language/ast.ts';
import { parseAtlasQuery } from '../query-language/parse.ts';
import { addDays } from '../timeline/timeline.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import type { ImportOutcome } from './meeting-arrival.ts';
import {
  summaryWritten,
  SUMMARY_DIGEST_KEY,
  type SummaryWritten,
} from './meeting-summary-block.ts';
import { meetingTurnsOf } from './meeting-turns.ts';

/**
 * The furthest back a meeting counts as pending, in days: the "After a
 * meeting" preset's 14 (`date >= @-14d`, ADR-0036). A rule that reaches
 * further takes older meetings by hand or by backfill, which makes proposals
 * and is never waited on; one that reaches less is held to its own reach.
 */
export const SUMMARY_PENDING_DAYS = 14;

const PLAIN_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The day a value in a `date` comparison names on `today`; null for one that names none. */
function dayOf(value: QueryValue, today: string): string | null {
  if (value.kind === 'relativeDate') return movingDate(value.name, today);
  if (value.kind === 'text' && PLAIN_DAY.test(value.text)) return value.text;
  return null;
}

/**
 * The earliest day a condition takes every day from, up to today, when that
 * can be proved from the condition alone: a lower bound on `date` (`>=` or
 * `>` a day), or several joined by AND, each one of them. Null for anything
 * else — OR, NOT, an upper bound, a condition on another field — whose days
 * only the index can tell (#637 attack).
 */
function provenLowerBound(where: Expression, today: string): string | null {
  if (where.kind === 'and') {
    const bounds = where.operands.map((operand) => provenLowerBound(operand, today));
    if (bounds.some((bound) => bound === null)) return null;
    return (bounds as string[]).reduce((a, b) => (a > b ? a : b));
  }
  if (where.kind !== 'compare' || where.field.via !== null || where.field.name.text !== 'date') {
    return null;
  }
  if (where.op !== '>=' && where.op !== '>') return null;
  const day = dayOf(where.value, today);
  if (day === null) return null;
  return where.op === '>' ? addDays(day, 1) : day;
}

/**
 * The earliest meeting date (`YYYY-MM-DD`) from which a rule that writes
 * summaries takes every meeting up to `today`, as the rule's own clock reads
 * it, when that can be read off its `which` alone: no condition, a lower
 * bound on `date` (`date >= @-7d`, `date > 2026-10-20`), or several such
 * joined by AND — never earlier than {@link SUMMARY_PENDING_DAYS} back. For a
 * `which` that does not read, or whose days only the index can tell (OR,
 * NOT, an upper bound, another field), it is the day after `today`: nothing
 * is pending on it until the index says what the rule takes
 * ({@link PostProcessingLedger.taken}). A later day than `today` means none.
 */
export function meetingReachFrom(which: string, today: string): string {
  const floor = addDays(today, -SUMMARY_PENDING_DAYS) ?? today;
  const none = addDays(today, 1) ?? today;
  let where: Expression | null;
  try {
    where = parseAtlasQuery(which).where;
  } catch {
    // A `which` that does not read never runs: no meeting waits on it.
    return none;
  }
  if (where === null) return floor;
  const bound = provenLowerBound(where, today);
  if (bound === null) return none;
  return bound > floor ? bound : floor;
}

/** What one meeting file holds that says whether its post-processing is still to come: kept small, a file per meeting. */
export interface PostProcessingFacts {
  /** Where its summary block stands: Claude's as written, the person's, or none. */
  readonly summary: SummaryWritten;
  /** Whether its transcript has turns for the step to read. */
  readonly hasTurns: boolean;
  /** The day its `date` names, read by its first ten characters as the rules' queries read it; null for none. */
  readonly date: string | null;
  /** The words the step knows it by (`meeting:<provider>:<id>:transcript:<digest>`); null when it has none. */
  readonly key: string | null;
}

/** What the vault's rules that write summaries say, read from their handled ledgers and logs. */
export interface PostProcessingLedger {
  /** Whether an enabled rule writes meetings' summaries (`writesSummaries`). */
  readonly summarising: boolean;
  /**
   * The earliest meeting date (`YYYY-MM-DD`) from which its `which` alone
   * proves it takes every meeting ({@link meetingReachFrom}): what is judged
   * by when the index has not said what it takes.
   */
  readonly from: string;
  /**
   * What the rules' own queries take, as the index answered them among the
   * meetings dated from `from` (the 14 days back) — a meeting counts as
   * pending only if one takes it. Left out when the index was not asked, or
   * could not answer.
   */
  readonly taken?: { readonly paths: ReadonlySet<string>; readonly from: string };
  /** The meetings it has handled or answered, by path. */
  readonly answered: ReadonlySet<string>;
  /** The words it holds an answer for whose writes are not done yet, by key. */
  readonly stored: ReadonlySet<string>;
}

/** A ledger that writes no summaries: nothing is pending under it. */
export const NO_POST_PROCESSING: PostProcessingLedger = {
  summarising: false,
  from: '',
  answered: new Set(),
  stored: new Set(),
};

/**
 * The day a `date` property names, as the rules' queries compare it
 * (`substr(date, 1, 10)`): a datetime, with a zone or not, by its day; a list
 * by its first item. Null for a value that names no day.
 */
function dayOfDate(value: unknown): string | null {
  const first = Array.isArray(value) ? (value as unknown[])[0] : value;
  if (typeof first !== 'string') return null;
  const day = first.slice(0, 10);
  return PLAIN_DAY.test(day) ? day : null;
}

/** The facts {@link postProcessingPending} judges, from a meeting's body and frontmatter. */
export function postProcessingFactsOf({
  body,
  properties,
  key,
}: {
  /** The note's body, after its frontmatter. */
  body: string;
  properties: Readonly<Record<string, unknown>>;
  key: string | null;
}): PostProcessingFacts {
  const recorded = properties[SUMMARY_DIGEST_KEY];
  const date = properties['date'];
  return {
    summary: summaryWritten(body, typeof recorded === 'string' ? recorded : null),
    hasTurns: meetingTurnsOf(body).length > 0,
    date: dayOfDate(date),
    key,
  };
}

/**
 * Whether the ledger is finished with one meeting: it answered it, and keeps
 * no answer for its words still waiting to be written.
 */
export function answeredIn(
  ledger: Pick<PostProcessingLedger, 'answered' | 'stored'>,
  { path, key }: { path: string; key: string | null },
): boolean {
  return ledger.answered.has(path) && !(key !== null && ledger.stored.has(key));
}

/** What a meeting with no summary block must be for one still to come. */
export interface PendingSigns {
  readonly path: VaultPath | string;
  readonly importOutcome: ImportOutcome | null;
  readonly hasTurns: boolean;
  readonly date: string | null;
}

/**
 * Whether a summary is still coming for a meeting that has no block: the
 * rule is on and has not answered it, and it is a meeting the rule takes.
 */
export function summaryStillComing(
  signs: PendingSigns,
  step: { readonly summarising: boolean; readonly from: string; readonly answered: boolean },
): boolean {
  if (!step.summarising || step.answered || isArchivedPath(signs.path)) return false;
  if (signs.importOutcome !== 'imported') return false;
  // The rule's `date >= …` never matches a meeting with no date: it never comes (#637 review).
  if (signs.date === null || signs.date < step.from) return false;
  return signs.hasTurns;
}

/** Whether one meeting's summary and tasks are still pending under the vault's ledger. */
export function postProcessingPending({
  path,
  importOutcome,
  facts,
  ledger,
}: {
  path: VaultPath | string;
  importOutcome: ImportOutcome | null;
  facts: PostProcessingFacts;
  ledger: PostProcessingLedger;
}): boolean {
  if (facts.summary !== 'none') return false;
  const { taken } = ledger;
  // The index said what the rules take: only those wait, within the 14 days.
  if (taken !== undefined && !taken.paths.has(path)) return false;
  const answered = answeredIn(ledger, { path, key: facts.key });
  return summaryStillComing(
    { path, importOutcome, hasTurns: facts.hasTurns, date: facts.date },
    { summarising: ledger.summarising, from: taken?.from ?? ledger.from, answered },
  );
}
