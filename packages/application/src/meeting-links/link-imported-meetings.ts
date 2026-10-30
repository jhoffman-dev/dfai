import {
  linkingFailedStamp,
  meetingLinkReport,
  messageWithoutPaths,
  type VaultPath,
  type Vocabulary,
} from '@dfai/domain';
import type { ActivityLog } from '../activity/ports.ts';
import type { Clock } from '../ports.ts';
import { linkMeeting, type MeetingLinkPorts, type MeetingLinkRun } from './link-meeting.ts';

/** Links the meetings at these paths in this vault; settles with each run, or none when the vault has changed. */
export type MeetingLinker = (
  vault: string,
  paths: readonly VaultPath[],
  /** What the caller's run has already read: the vocabulary it corrects by, for the speakers to be read by too. */
  reading?: { readonly vocabulary?: Vocabulary | undefined },
) => Promise<readonly MeetingLinkRun[]>;

/**
 * Links meetings one at a time, each said in Activity: who it linked, what it
 * proposed, what it could not write. One meeting's failure is its own line,
 * and the rest are linked. Nothing is linked once another vault is open.
 *
 * The importer runs it as each meeting is about to be let in (`beforeLetIn`):
 * once per meeting, before the stamp, so the links are part of the meeting
 * that arrives and no write to it follows. A meeting stamped `imported` is
 * never judged again, so never linked again, and a person taken out of its
 * `people` stays out. A meeting whose linking failed is stamped with a mark
 * saying so (`linkBeforeLetIn`), and linked again by the "After a meeting"
 * rule's Run now (#192); Activity says it could not be linked. A
 * meeting whose links were written and whose proposals then could not be is
 * said as linked, with why nothing was proposed, and its run is kept.
 */
export function createMeetingLinker({
  ports,
  clock,
  activity,
  openVault,
  selfName,
  selfEmails,
  onWritten,
}: {
  ports: () => MeetingLinkPorts;
  clock: Pick<Clock, 'today'>;
  activity: ActivityLog;
  openVault: () => string | null;
  /** The vault owner's name, from their profile, as it is now. */
  selfName: () => string | null;
  /** The vault owner's own addresses, its `selfEmails`, as they are now. */
  selfEmails: () => readonly string[];
  /** Told when linking wrote a note, so the tree and the index read it again. */
  onWritten: () => void;
}): MeetingLinker {
  return async (vault, paths, reading = {}) => {
    const recorder = activity.inVault(vault);
    const runs: MeetingLinkRun[] = [];
    for (const path of paths) {
      if (openVault() !== vault) break;
      try {
        const run = await linkMeeting({
          ports: ports(),
          path,
          today: clock.today(),
          selfName: selfName(),
          selfEmails: selfEmails(),
          vocabulary: reading.vocabulary,
        });
        const { linked, filed, proposed, left, unproposed } = run;
        recorder.record(
          meetingLinkReport({
            meeting: path,
            linked,
            filed,
            proposed: proposed.length,
            left,
            unproposed,
          }),
        );
        runs.push(run);
      } catch (cause) {
        recorder.record({
          level: 'error',
          kind: 'meeting',
          message: `Could not link the meeting: ${messageWithoutPaths(cause)}`,
          subject: { kind: 'note', path },
        });
      }
    }
    if (runs.some((run) => run.done.length > 0 || run.proposed.length > 0)) onWritten();
    return runs;
  };
}

/**
 * Links a meeting the import is about to let in, and says what its stamp
 * write carries: the mark of linking that failed (#192), when the linker
 * settled with no run for it while its vault is still open. Once another
 * vault is open the import does not stamp it at all, so no mark is said.
 */
export async function linkBeforeLetIn({
  linker,
  vault,
  path,
  reading,
}: {
  linker: MeetingLinker;
  vault: string;
  path: VaultPath;
  reading: { readonly vocabulary: Vocabulary };
}): Promise<{ readonly stamp: Readonly<Record<string, unknown>> } | undefined> {
  const runs = await linker(vault, [path], reading);
  return runs.some((run) => run.meeting === path) ? undefined : { stamp: linkingFailedStamp() };
}
