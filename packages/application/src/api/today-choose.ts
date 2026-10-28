import { focusChange } from '@dfai/domain';
import { ApiError } from './api-error.ts';
import { bodyObject, optionalBoolean } from './fields.ts';
import { answerWithNote } from './note-io.ts';
import { writeProperties } from './notes-write.ts';
import { taskNoteFrom } from './task-note.ts';
import type { RouteResult, VaultRequest } from './vault-request.ts';

/**
 * Chooses a task for today, or takes it off (#108), as the Today page's
 * Today, Keep and Drop do: its `focus` set to today on the app's clock, or
 * taken out — the same change, through the same write a property change
 * takes, so a task open in a pane is written through it. Answers the task.
 */
export async function chooseForTodayRoute(request: VaultRequest): Promise<RouteResult> {
  const fields = bodyObject(request.body);
  const chosen = optionalBoolean(fields, 'chosen');
  if (chosen === undefined) throw new ApiError('invalid', 'chosen is required: true or false');
  const { path, modified } = await taskNoteFrom(request, { fields, field: 'path' });
  const values = focusChange({
    choice: chosen ? 'choose' : 'unchoose',
    today: request.clock.today(),
  });
  await writeProperties(request, { path, expected: modified, values });
  return answerWithNote(request, { path });
}
