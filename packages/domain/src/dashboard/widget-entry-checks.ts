/**
 * What a caller's widget entry says that the widget editor's draft would
 * quietly read as something else (P32-05). The draft is forgiving on purpose
 * — a hand-written file keeps drawing — but a spec Claude sends is refused
 * rather than coerced: a filter the parser cannot read would be dropped and
 * the tile count every note; a span of 3.5 would become 3.
 */

import { FILTER_OPERATORS, type FilterOperator } from '../query/view-query.ts';
import { GRID_COLUMNS, MAX_RANK_SIZE, SQL_SHOWS, WIDGET_ICONS } from './dashboard.ts';

type Entry = Readonly<Record<string, unknown>>;

/** The keys that must be text when they are given at all. */
const TEXT_KEYS = ['title', 'type', 'groupBy', 'sql', 'query'] as const;

/** Operators that compare against nothing, so their value may be null. */
const WITHOUT_VALUE: readonly FilterOperator[] = ['isEmpty', 'isNotEmpty'];

/** Everything in the entry the draft would read as something it does not say; none when it reads as written. */
export function widgetEntryShapeProblems(entry: Entry): string[] {
  return [
    ...TEXT_KEYS.flatMap((key) => textProblem(entry, key)),
    ...highlightProblem(entry),
    ...filtersProblems(entry['filters'], 'filters'),
    ...progressProblems(entry['progress']),
    ...choiceProblem(entry, 'show', SQL_SHOWS),
    ...choiceProblem(entry, 'icon', WIDGET_ICONS),
    ...wholeNumberProblem(entry, 'span', 1, GRID_COLUMNS),
    ...wholeNumberProblem(entry, 'limit', 1, entry['kind'] === 'rank' ? MAX_RANK_SIZE : null),
  ];
}

function given(entry: Entry, key: string): boolean {
  return entry[key] !== undefined && entry[key] !== null;
}

function textProblem(entry: Entry, key: string): string[] {
  return given(entry, key) && typeof entry[key] !== 'string' ? [`${key} must be text.`] : [];
}

/** A highlight is a group's key as written — text, or a number such as `15` (docs/dashboards.md). */
function highlightProblem(entry: Entry): string[] {
  const value = entry['highlight'];
  if (!given(entry, 'highlight') || typeof value === 'string') return [];
  return typeof value === 'number' && Number.isFinite(value)
    ? []
    : ['highlight must be text or a number.'];
}

function filtersProblems(value: unknown, at: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [`${at} must be a list of { key, operator, value }.`];
  return value.flatMap((filter: unknown, index) => filterProblem(filter, `${at}[${index}]`));
}

function filterProblem(filter: unknown, at: string): string[] {
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
    return [`${at} must be { key, operator, value }.`];
  }
  const { key, operator, value } = filter as Entry;
  if (typeof key !== 'string' || key.trim() === '') return [`${at} needs a key.`];
  if (!FILTER_OPERATORS.includes(operator as FilterOperator)) {
    return [`${at}’s operator must be one of ${FILTER_OPERATORS.join(', ')}.`];
  }
  const plain = ['string', 'number', 'boolean'].includes(typeof value);
  const nothing = value === null && WITHOUT_VALUE.includes(operator as FilterOperator);
  return value === undefined || plain || nothing
    ? []
    : [`${at}’s value must be text, a number or true/false.`];
}

function progressProblems(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== 'object' || Array.isArray(value)) return ['progress must be { filters }.'];
  return filtersProblems((value as Entry)['filters'], 'progress.filters');
}

function choiceProblem(entry: Entry, key: string, choices: readonly string[]): string[] {
  if (!given(entry, key) || choices.includes(entry[key] as string)) return [];
  return [`${key} must be one of ${choices.join(', ')}.`];
}

function wholeNumberProblem(
  entry: Entry,
  key: string,
  least: number,
  most: number | null,
): string[] {
  if (!given(entry, key)) return [];
  const value = entry[key];
  const inRange =
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= least &&
    (most === null || value <= most);
  if (inRange) return [];
  return [
    `${key} must be a whole number ${most === null ? `of ${least} or more` : `from ${least} to ${most}`}.`,
  ];
}
