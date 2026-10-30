import { taskRowChange } from '../today/task-row-change.ts';
import { ApiError } from './api-error.ts';
import { bodyObject, optionalBoolean, optionalModified } from './fields.ts';
import { answerWithNote, checkIfModified } from './note-io.ts';
import { writeProperties } from './notes-write.ts';
import { taskNoteFrom } from './task-note.ts';
import type { RouteResult, VaultRequest } from './vault-request.ts';

/**
 * Ticks a task done, or unticks it (#107), as a row's done box does on the
 * Today page and in a query view: the same change (`taskRowChange`) through
 * the same write a property change takes. Finishing is Archive dated today
 * on the app's clock — a repeating task rolls on to its next `due` instead —
 * and ends a dated choice for today; unticking goes back to Next Action.
 *
 * A tick needs `ifModified`: a rolled task is open again, so a tick sent
 * twice would roll it twice; with the stamp, the second is a `conflict`.
 * Answers the task.
 */
export async function taskDoneRoute(request: VaultRequest): Promise<RouteResult> {
  const fields = bodyObject(request.body);
  const done = optionalBoolean(fields, 'done');
  if (done === undefined) throw new ApiError('invalid', 'done is required: true or false');
  const ifModified = optionalModified(fields, 'ifModified');
  if (done && ifModified === undefined) {
    throw new ApiError(
      'invalid',
      'ifModified is required to tick a task done: a repeating task ticked twice would roll on twice',
    );
  }
  const { path, modified } = await taskNoteFrom(request, { fields, field: 'path' });
  checkIfModified(path, modified, ifModified);
  const values = taskRowChange({ kind: done ? 'done' : 'reopen' });
  await writeProperties(request, { path, expected: modified, values });
  return answerWithNote(request, { path });
}
