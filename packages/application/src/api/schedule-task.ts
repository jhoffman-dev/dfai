import {
  LONGEST_NEW_BLOCK_MINUTES,
  messageWithoutPaths,
  newBlockLength,
  noteTitle,
  taskTypeOf,
  type ObjectType,
  type VaultPath,
} from '@dfai/domain';
import { NoteNameTakenError } from '../notes/create-note.ts';
import { BlockTimesError, createBlockForTask } from '../timeblocks/schedule-task.ts';
import { readTaskSchedules } from '../timeblocks/task-schedules.ts';
import { loadObjectTypes } from '../types/load-types.ts';
import { listVaultNotes } from '../vault/read-vault.ts';
import { ApiError } from './api-error.ts';
import { bodyObject, countOf, requiredString, type Fields } from './fields.ts';
import { answerWithNote } from './note-io.ts';
import { taskNoteFrom } from './task-note.ts';
import type { RouteResult, VaultRequest } from './vault-request.ts';

/**
 * Schedules a task (P31-02): a new block for it, `minutes` long from
 * `start`, linking it — what a task let go on the calendar's empty time makes
 * in the app, by the same code: made as every new note is, from the Block
 * type's template when there is one, at the top of the vault, named
 * "<task> block" and numbered when that is taken. With no `minutes`, the block
 * is as long as the task still needs, as the app sizes it. Answers 201 with
 * the block.
 */
export async function scheduleTaskRoute(request: VaultRequest): Promise<RouteResult> {
  const fields = bodyObject(request.body);
  const { path: task } = await taskNoteFrom(request, { fields, field: 'task' });
  const start = wallClockStart(fields);
  const types = await loadObjectTypes({ fs: request.fs, markdown: request.markdown });
  const minutes =
    fields['minutes'] === undefined
      ? await minutesStillNeeded(request, { task, types })
      : countOf(fields['minutes'], {
          field: 'minutes',
          fallback: 0,
          max: LONGEST_NEW_BLOCK_MINUTES,
        });

  request.assertStillOpen();
  try {
    const { block } = await createBlockForTask({
      fs: request.fs,
      markdown: request.markdown,
      types,
      task: { path: task, title: noteTitle(task) },
      start,
      minutes,
      notePaths: await listVaultNotes({ fs: request.fs }),
      today: request.clock.today(),
    });
    return await answerWithNote(request, { path: block, status: 201 });
  } catch (error) {
    if (error instanceof BlockTimesError) throw new ApiError('invalid', error.message);
    if (error instanceof NoteNameTakenError) throw new ApiError('conflict', error.message);
    throw error;
  }
}

/** A day and a time to the minute, and nothing after: how a block holds its times (ADR-0030). */
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * The block's start, as local wall-clock time. A zone or an offset written
 * after it would name another moment than its digits — `toISOString()` is
 * UTC — and the block holds no offset, so it would land hours from where it
 * was asked for: such a start is refused rather than read as its digits.
 */
function wallClockStart(fields: Fields): string {
  const start = requiredString(fields, 'start');
  if (!WALL_CLOCK.test(start)) {
    throw new ApiError(
      'invalid',
      `start must be local wall-clock time to the minute, written 2026-10-12T09:00, with no seconds, zone or offset: ${JSON.stringify(start)} is not`,
    );
  }
  return start;
}

/** What the task still needs set aside, as a drop in the app sizes its block. */
async function minutesStillNeeded(
  request: VaultRequest,
  { task, types }: { task: VaultPath; types: readonly ObjectType[] },
): Promise<number> {
  try {
    const schedules = await readTaskSchedules({
      index: request.index,
      paths: [task],
      taskType: taskTypeOf(types),
    });
    return newBlockLength(schedules.get(task) ?? null);
  } catch (error) {
    throw new ApiError('query_failed', messageWithoutPaths(error));
  }
}
