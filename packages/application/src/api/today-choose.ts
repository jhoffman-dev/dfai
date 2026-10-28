import { choosesForToday } from '@dfai/domain';
import { choiceChange, FocusNotChosenError } from '../today/choose-for-today.ts';
import { loadObjectTypes } from '../types/load-types.ts';
import { ApiError } from './api-error.ts';
import { bodyObject, optionalBoolean } from './fields.ts';
import { answerWithNote } from './note-io.ts';
import { writeProperties } from './notes-write.ts';
import { taskNoteFrom } from './task-note.ts';
import type { RouteResult, VaultRequest } from './vault-request.ts';

const NOT_CHOOSING =
  'This vault’s Task type has no Chosen for (focus) date, so tasks cannot be chosen for today: add focus to the Task type as a date.';

/**
 * Chooses a task for today, or takes it off (#108), as the Today page's
 * Today, Keep and Drop do: its `focus` set to today on the app's clock, or
 * taken out — the same change, through the same write a property change
 * takes, so a task open in a pane is written through it. Refused as
 * `invalid` where the vault's Task type has no `focus` as a date, or the
 * task's `focus` is the person's own. Answers the task.
 */
export async function chooseForTodayRoute(request: VaultRequest): Promise<RouteResult> {
  const fields = bodyObject(request.body);
  const chosen = optionalBoolean(fields, 'chosen');
  if (chosen === undefined) throw new ApiError('invalid', 'chosen is required: true or false');
  const { path, modified } = await taskNoteFrom(request, { fields, field: 'path' });
  const types = await loadObjectTypes({ fs: request.fs, markdown: request.markdown });
  if (!choosesForToday(types)) throw new ApiError('invalid', NOT_CHOOSING);
  const values = choiceChange({
    choice: chosen ? 'choose' : 'unchoose',
    today: request.clock.today(),
  });
  try {
    await writeProperties(request, { path, expected: modified, values });
  } catch (error) {
    if (error instanceof FocusNotChosenError) throw new ApiError('invalid', error.message);
    throw error;
  }
  return answerWithNote(request, { path });
}
