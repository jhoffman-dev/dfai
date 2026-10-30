import type { AutomationAction } from '../automations/automation-rule.ts';
import type { VaultPath } from '../vault/vault-path.ts';

/**
 * The mark a meeting is let in with when its linking failed (#192): the
 * import stamps it all the same (ADR-0027), and the "After a meeting" rule's
 * Run now links it again. Only linking that failed is marked, so a meeting
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

/** What the stamp write adds for a meeting whose linking failed. */
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
 * Whether a rule's run by hand links its meetings again: the declared
 * "After a meeting" step (`apply: mine`, #179), the one rule the pipeline
 * of ADR-0027 runs linking for.
 */
export function relinksMeetings(rule: { readonly action: AutomationAction }): boolean {
  return rule.action.kind === 'claude' && rule.action.apply === 'mine';
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

/**
 * Whether linking a meeting again settled it, so its mark goes: the run left
 * nothing of the meeting's own — not unsaved typing, a relation changed
 * since it was read, or a directory note it could not read. A proposal it
 * could not write does not count: the links stand without it. Anything else
 * keeps the mark, and the next Run now tries again; linking adds only what is
 * missing, so nothing is linked twice.
 */
export function relinkSettled(run: {
  readonly meeting: VaultPath;
  readonly left: readonly { readonly path: VaultPath }[];
}): boolean {
  return run.left.every((left) => left.path !== run.meeting);
}

/** What a dry run says of them: "2 meetings are not linked: Run now links them first." */
export function describeNotLinked(notLinked: MeetingsNotLinked): string {
  const count = notLinked.paths.length;
  const head =
    count === 1
      ? '1 meeting is not linked: Run now links it first.'
      : `${count} meetings are not linked: Run now links them first.`;
  return notLinked.capped ? `${head} More wait for the next run.` : head;
}
