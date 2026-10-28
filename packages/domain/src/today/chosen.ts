import { TASK_KEYS } from '../gtd/gtd-status.ts';
import type { ObjectType, PropertyDef } from '../types/property-def.ts';

/**
 * `focus`: the day a task was chosen to be done on (#108). A date, not a
 * flag, so a choice is of one day: tomorrow it is yesterday's, carried over
 * until it is kept or dropped, and nothing has to be written at midnight.
 */
export const FOCUS_PROPERTY: PropertyDef = {
  key: TASK_KEYS.focus,
  kind: 'date',
  label: 'Chosen for',
  required: false,
  options: [],
  target: null,
  many: false,
};

/**
 * What a row can do to a task's choice: choose it for today or take it off,
 * and for one chosen on an earlier day, keep it for today or drop it.
 */
export type TodayChoice = 'choose' | 'unchoose' | 'keep' | 'drop';

/**
 * Where a task stands with the day: chosen for it, chosen on an earlier day
 * and not yet kept or dropped, or neither — not chosen, or chosen for a day
 * still to come, which is a choice of that day's.
 */
export type FocusStanding = 'today' | 'carried' | 'none';

export function focusStanding({
  focus,
  today,
}: {
  /** The task's `focus` day, `YYYY-MM-DD`; null or absent when it has none. */
  focus: string | null | undefined;
  /** `YYYY-MM-DD`, from the injected clock. */
  today: string;
}): FocusStanding {
  if (focus === null || focus === undefined) return 'none';
  if (focus === today) return 'today';
  return focus < today ? 'carried' : 'none';
}

/**
 * The change a choice makes to a task: `focus` set to today to choose or
 * keep it, taken out to unchoose or drop it — so a task chosen and then
 * unchosen is written back as it was.
 */
export function focusChange({
  choice,
  today,
}: {
  choice: TodayChoice;
  today: string;
}): Readonly<Record<string, string | null>> {
  const chosen = choice === 'choose' || choice === 'keep';
  return { [TASK_KEYS.focus]: chosen ? today : null };
}

/**
 * Whether the vault's Task type has `focus` as a date, which is when a
 * query can ask for `focus = @today`: a vault that took the key off, or
 * made it something else, is not asked.
 */
export function declaresFocus(type: ObjectType | null): boolean {
  return (
    type?.properties.some(
      (property) => property.key === TASK_KEYS.focus && property.kind === 'date',
    ) ?? false
  );
}
