import { linkingOwed, type VaultPath } from '@dfai/domain';
import type { MeetingLinkRun } from './link-meeting.ts';

/** What linking meetings again did: those now linked, and those still marked for the next try. */
export interface MeetingsRelinked {
  readonly linked: readonly VaultPath[];
  readonly notLinked: readonly VaultPath[];
}

/**
 * Links again meetings whose linking is still owed (#192), as the import
 * would have: `link` is the import's linker, which says each meeting in
 * Activity, checks its vault is still the one open before each, and takes
 * the mark out in the same write as the links (`linkMeeting`). Nothing is
 * written here. A meeting is linked once the try settled it
 * (`linkingOwed`, the rule the import marks by); the rest keep the mark.
 */
export async function relinkMeetings({
  link,
  paths,
}: {
  /** Links these meetings, saying each in Activity; settles with a run for each one it tried. */
  link: (paths: readonly VaultPath[]) => Promise<readonly MeetingLinkRun[]>;
  paths: readonly VaultPath[];
}): Promise<MeetingsRelinked> {
  if (paths.length === 0) return { linked: [], notLinked: [] };
  const runs = new Map((await link(paths)).map((run) => [run.meeting, run] as const));
  const linked = paths.filter((path) => !linkingOwed(runs.get(path) ?? null));
  return { linked, notLinked: paths.filter((path) => !linked.includes(path)) };
}
