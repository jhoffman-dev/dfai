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
  /** Newest first by `date`, at most {@link RELINKS_PER_RUN}. */
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
 * Once it wrote a link into the meeting it is settled: trying again would
 * add back what the owner takes out after, which ADR-0027 forbids. Taking
 * the mark out is not a link, and does not count. A try that had nothing to
 * add and left nothing is settled too.
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
  const wrote = run.done.some(
    (line) =>
      'path' in line &&
      line.path === run.meeting &&
      !('key' in line && line.key === MEETING_LINKS_KEY),
  );
  return !wrote && run.left.some((left) => left.path === run.meeting);
}

/**
 * How a try at linking a marked meeting takes the mark out, so the mark goes
 * only when linking is no longer owed (`linkingOwed`): `with-links` rides in
 * the write of the links and is made only if one of them is; `alone` is for
 * a meeting with nothing left to link and nothing it had to leave, which is
 * linked as it is; `keep` leaves it — not marked, or a key it could not add
 * to (one holding something other than links) and nothing else to write.
 */
export function markRemoval({
  properties,
  linkChanges,
  unreadable,
}: {
  properties: Readonly<Record<string, unknown>>;
  /** How many link keys the try would write. */
  linkChanges: number;
  /** How many keys of the meeting's own it could not add to. */
  unreadable: number;
}): 'keep' | 'with-links' | 'alone' {
  if (!linkingFailed(properties)) return 'keep';
  if (linkChanges > 0) return 'with-links';
  return unreadable > 0 ? 'keep' : 'alone';
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

/** How many paths one {@link compileMarkedAmongQuery} names: well under any host's bound on parameters. */
export const MARKED_AMONG_CHUNK = 500;

/** Whether any note in the vault carries the mark: one row or none, so a vault with no mark costs next to nothing. */
export function compileAnyMarkQuery(): CompiledQuery {
  return {
    sql: `/* meeting links: any marked */ SELECT path FROM props WHERE key = ? LIMIT 1`,
    parameters: [MEETING_LINKS_KEY],
  };
}

/**
 * Which of these notes the index says carry the mark, with each one's
 * `date`: only notes the rule's query matched are asked about, so marks on
 * meetings it cannot reach — older than its window — never crowd out one it
 * can. The index may be behind the files, so whoever asks reads each found.
 * At most {@link MARKED_AMONG_CHUNK} paths at a time.
 */
export function compileMarkedAmongQuery(paths: readonly VaultPath[]): CompiledQuery {
  const holes = paths.map(() => '?').join(', ');
  return {
    sql: [
      `/* meeting links: marked */ SELECT p.path,`,
      `  (SELECT COALESCE(d.value_date, d.value_text) FROM props AS d WHERE d.path = p.path AND d.key = 'date' ORDER BY d.idx LIMIT 1)`,
      `FROM props AS p WHERE p.key = ? AND p.path IN (${holes}) GROUP BY p.path`,
    ].join('\n'),
    parameters: [MEETING_LINKS_KEY, ...paths],
  };
}

/**
 * The paths of {@link compileMarkedAmongQuery}'s rows, newest meeting first
 * — by `date`, undated last, then by path, newest name first — so meetings
 * that stay owed for good cannot hold back a newer one behind a run's cap.
 * A row that is not a vault path is left out.
 */
export function markedMeetingsOf(rows: readonly (readonly unknown[])[]): VaultPath[] {
  const found = rows.flatMap((row) => {
    const [path, date] = row;
    if (typeof path !== 'string') return [];
    try {
      return [{ path: createVaultPath(path), date: typeof date === 'string' ? date : '' }];
    } catch {
      // Not a path in the vault — the index holds no such row, but a hand-made one is dropped.
      return [];
    }
  });
  found.sort((a, b) => b.date.localeCompare(a.date) || b.path.localeCompare(a.path));
  return found.map(({ path }) => path);
}
