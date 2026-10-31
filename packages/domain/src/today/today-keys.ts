import type { GtdStatus } from '../gtd/gtd-status.ts';
import type { TodayChoice } from './chosen.ts';
import { TODAY_DEFER_DAYS, todayMovesFor, type TodaySectionId } from './today-lists.ts';

/**
 * What one key does to the Today row that has the focus (#109): the same
 * acts as the row's own controls — tick it done, choose it for today or take
 * it off, defer it a day, move it to a status, or open its Move to… menu.
 */
export type TodayKeyAction =
  | { readonly kind: 'done' }
  | { readonly kind: 'choice'; readonly choice: TodayChoice }
  | { readonly kind: 'defer'; readonly days: number }
  | { readonly kind: 'move'; readonly status: GtdStatus }
  | { readonly kind: 'move-menu' };

/** The keys Today answers to on a row, in the order its hint strip lists them. */
export const TODAY_KEYS = ['x', 't', 'd', 'n', 'w', 's', 'm'] as const;
export type TodayKeyLetter = (typeof TODAY_KEYS)[number];

/** The statuses a letter moves a task to — the same letters the Inbox gives them. */
const MOVES: Partial<Record<TodayKeyLetter, GtdStatus>> = {
  n: 'next-action',
  w: 'waiting',
  s: 'someday',
};

/** Where the focused row stands: what its controls offer depends on it. */
export interface TodayRowStanding {
  readonly status: GtdStatus | null;
  readonly section: TodaySectionId;
  /** Whether the vault chooses tasks for today (#108). */
  readonly choosing: boolean;
  /** Whether the task's `focus` is the person's own, which no choice writes over. */
  readonly focusIsOwn: boolean;
}

/**
 * The choice T makes on a row, as its Today button would: off today where it
 * is chosen, kept where it was carried over, chosen anywhere else. None where
 * the vault does not choose, or the `focus` is the person's own.
 */
function choiceFor({ section, choosing, focusIsOwn }: TodayRowStanding): TodayChoice | null {
  if (!choosing || focusIsOwn) return null;
  if (section === 'chosen') return 'unchoose';
  return section === 'carriedOver' ? 'keep' : 'choose';
}

/**
 * The action a key stands for on a row, or null: not one of Today's keys, or
 * one the row does not offer — a move to the status it has already, a choice
 * the vault does not make.
 */
export function todayKeyActionOf(key: string, row: TodayRowStanding): TodayKeyAction | null {
  const letter = key.toLowerCase();
  if (letter === 'x') return { kind: 'done' };
  if (letter === 'd') return { kind: 'defer', days: TODAY_DEFER_DAYS[0] };
  if (letter === 'm') return { kind: 'move-menu' };
  if (letter === 't') {
    const choice = choiceFor(row);
    return choice === null ? null : { kind: 'choice', choice };
  }
  const status = MOVES[letter as TodayKeyLetter];
  if (status === undefined || !todayMovesFor(row.status).includes(status)) return null;
  return { kind: 'move', status };
}
