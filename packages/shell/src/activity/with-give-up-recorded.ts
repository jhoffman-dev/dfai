import {
  insideVault,
  messageWithoutPaths,
  screenWriteFailedReport,
  type ScreenWrite,
} from '@dfai/domain';
import type { ActivityLog } from '@dfai/application';

/** An error a write throws to refuse what the person asked for, rather than failing. */
type Refusal = abstract new (...args: never[]) => Error;

/** A screen's write, as its Activity line names it should the screen give up on it. */
export interface ScreenWriteNamed {
  readonly activity: Pick<ActivityLog, 'inOpenVault'>;
  readonly write: ScreenWrite;
  /** The note being written, when it is there to open: never one being made. */
  readonly path: string | null;
  /**
   * The write's refusals of what the person asked for — a name taken, a file
   * that is no image, a task rule — which the screen shows them to act on,
   * and are no fault.
   */
  readonly refusal?: Refusal | readonly Refusal[];
}

/**
 * Runs a screen's write and, when it fails, says so once in the Activity log
 * of the vault open when it began — then fails as it would have, so the screen
 * still shows why. This is where the screen gives up: a name tried and passed
 * over, or a write tried again, inside it is never recorded; nor is a refusal.
 */
export async function withGiveUpRecorded<Result>(
  { activity, write, path, refusal }: ScreenWriteNamed,
  work: () => Promise<Result>,
): Promise<Result> {
  const recorder = activity.inOpenVault();
  try {
    return await work();
  } catch (cause) {
    const refusals = refusal === undefined ? [] : [refusal].flat();
    if (!refusals.some((each) => cause instanceof each)) {
      const problem = messageWithoutPaths(cause);
      const note = path === null ? null : insideVault(path);
      recorder.record(screenWriteFailedReport({ write, path: note, problem }));
    }
    throw cause;
  }
}
