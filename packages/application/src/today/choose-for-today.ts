import { focusChange, focusIsOwn, type TodayChoice } from '@dfai/domain';
import type { PropertyChanges } from '../query/set-property.ts';

/** A task's `focus` is the person's own, so a choice is not written over it (#108). */
export class FocusNotChosenError extends Error {
  constructor() {
    super(
      'This task’s Chosen for (focus) holds something other than one day, so it was left as it is.',
    );
    this.name = 'FocusNotChosenError';
  }
}

/**
 * A choice for today as a change to a task (#108): `focus` set to today or
 * taken out — judged against the frontmatter the write itself reads, so a
 * `focus` that is the person's own is refused with {@link FocusNotChosenError}
 * and nothing is written.
 */
export function choiceChange({
  choice,
  today,
}: {
  choice: TodayChoice;
  today: string;
}): PropertyChanges {
  return (properties) => {
    if (focusIsOwn(properties)) throw new FocusNotChosenError();
    return focusChange({ choice, today });
  };
}
