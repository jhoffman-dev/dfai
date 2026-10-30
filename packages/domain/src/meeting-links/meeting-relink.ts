import type { CompiledQuery } from '../query/view-query.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';

/**
 * The mark a meeting is let in with when linking it is still owed (#192):
 * the import stamps it all the same (ADR-0027), and the "After a meeting"
 * rule's Run now links it again. Only such a meeting is marked, so a meeting
 * linked once is never linked again by it, and a person taken out of its
 * `people` stays out.
 */
export const MEETING_LINKS_KEY = 'atlas_links';

/** What {@link MEETING_LINKS_KEY} holds while the meeting is not linked. */
export const LINKING_FAILED = 'failed';

/** The most meetings one Run now links again: each reads the vault's people and companies. */
export const RELINKS_PER_RUN = 50;

/** The meetings a run by hand would link again, before anything else it does. */
export interface MeetingsNotLinked {
  /** In the order the rule's query matched them, at most {@link RELINKS_PER_RUN}. */
  readonly paths: readonly VaultPath[];
  /** More were not linked than one run links; the rest wait for the next. */
  readonly capped: boolean;
}

/** What the stamp write adds for a meeting whose linking is still owed. */
export function linkingFailedStamp(): Readonly<Record<string, string>> {
  return { [MEETING_LINKS_KEY]: LINKING_FAILED };
}

/**
 * Whether a meeting's linking failed and has not been done since. Read as a
 * stamp is: a list by its first item, the word without the spaces round it.
 */
export function linkingFailed(properties: Readonly<Record<string, unknown>>): boolean {
  if (!Object.hasOwn(properties, MEETING_LINKS_KEY)) return false;
  const mark = properties[MEETING_LINKS_KEY];
  const said: unknown = Array.isArray(mark) ? mark[0] : mark;
  return typeof said === 'string' && said.trim() === LINKING_FAILED;
}

/**
 * Whether linking a meeting is still owed after a try — the one rule the
 * import (which marks the meeting) and Run now (which keeps the mark) both
 * go by. Owed when the try did not run (`null`: it threw), or wrote nothing
 * into the meeting and left the meeting itself (unsaved typing, a key
 * changed since it was read, a key holding something other than links).
 * Once it wrote anything into the meeting it is settled: trying again would
 * add back what the owner takes out after, which ADR-0027 forbids. A try that
 * had nothing to add is settled too.
 */
export function linkingOwed(
  run: {
    readonly meeting: VaultPath;
    /** What it wrote, as an automation's log records it: a line with a `path` is a write there. */
    readonly done: readonly object[];
    readonly left: readonly { readonly path: VaultPath }[];
  } | null,
): boolean {
  if (run === null) return true;
  const wrote = run.done.some((line) => 'path' in line && line.path === run.meeting);
  return !wrote && run.left.some((left) => left.path === run.meeting);
}

/**
 * Which of the notes a rule matched it links again: those whose linking
 * failed, in the order given, each once, at most `cap`. Null when there are none.
 */
export function meetingsToRelink(
  notes: readonly {
    readonly path: VaultPath;
    readonly properties: Readonly<Record<string, unknown>>;
  }[],
  cap: number = RELINKS_PER_RUN,
): MeetingsNotLinked | null {
  const failed = [...new Set(notes.filter((note) => linkingFailed(note.properties)).map(pathOf))];
  if (failed.length === 0) return null;
  return { paths: failed.slice(0, cap), capped: failed.length > cap };
}

function pathOf(note: { readonly path: VaultPath }): VaultPath {
  return note.path;
}

/** The most notes {@link compileMarkedMeetingsQuery} asks the index for: well past a run's cap. */
export const MARKED_MEETINGS_PAGE = 1000;

/**
 * The notes the index says carry the mark, by path: the only ones worth
 * reading to know whether linking is owed. The index may be behind the
 * files, so whoever asks reads each one found; a vault with no mark costs
 * one small query and no read.
 */
export function compileMarkedMeetingsQuery(): CompiledQuery {
  return {
    sql: [
      `/* meeting links */ SELECT DISTINCT path FROM props`,
      `WHERE key = ? ORDER BY path LIMIT ?`,
    ].join('\n'),
    parameters: [MEETING_LINKS_KEY, MARKED_MEETINGS_PAGE],
  };
}

/** The paths of {@link compileMarkedMeetingsQuery}'s rows; a row that is not a vault path is left out. */
export function markedMeetingsOf(rows: readonly (readonly unknown[])[]): VaultPath[] {
  return rows.flatMap((row) => {
    const path = row[0];
    if (typeof path !== 'string') return [];
    try {
      return [createVaultPath(path)];
    } catch {
      // Not a path in the vault — the index holds no such row, but a hand-made one is dropped.
      return [];
    }
  });
}
