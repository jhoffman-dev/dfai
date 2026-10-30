import { MEETING_LINKS_KEY, relinkSettled, type VaultPath } from '@dfai/domain';
import type { ArchivePorts } from '../archive/archive-notes.ts';
import { changeProperties } from '../automations/apply-changes.ts';
import type { MeetingLinkRun } from './link-meeting.ts';

/** What linking meetings again did: those now linked, and those still marked for the next try. */
export interface MeetingsRelinked {
  readonly linked: readonly VaultPath[];
  readonly notLinked: readonly VaultPath[];
}

/**
 * Links again meetings whose linking failed (#192), as the import would
 * have: `link` is the import's linker, which says each meeting in Activity.
 * A meeting it settled (`relinkSettled`) has its mark taken out, so it is
 * never linked again by this; one it did not keeps the mark for the next
 * Run now. Linking adds only what is missing, so a second try links nothing
 * twice. The mark goes whatever else its frontmatter holds now: it is DFAI's.
 */
export async function relinkMeetings({
  link,
  paths,
  ports,
  today,
}: {
  /** Links these meetings, saying each in Activity; settles with a run for each one it linked. */
  link: (paths: readonly VaultPath[]) => Promise<readonly MeetingLinkRun[]>;
  paths: readonly VaultPath[];
  ports: Pick<ArchivePorts, 'fs' | 'markdown' | 'editors'>;
  /** `YYYY-MM-DD`, the day of the write. */
  today: string;
}): Promise<MeetingsRelinked> {
  if (paths.length === 0) return { linked: [], notLinked: [] };
  const runs = await link(paths);
  const settled = runs.filter(relinkSettled).map((run) => run.meeting);
  const cleared = await changeProperties({
    ports,
    changes: settled.map((path) => ({
      path,
      key: MEETING_LINKS_KEY,
      expect: null,
      to: { absent: true },
    })),
    kind: 'set',
    today,
  });
  // A mark that could not be taken out — unsaved typing since — is tried again next time.
  const marked = new Set(cleared.left.map((left) => left.path));
  const linked = settled.filter((path) => !marked.has(path));
  return { linked, notLinked: paths.filter((path) => !linked.includes(path)) };
}
