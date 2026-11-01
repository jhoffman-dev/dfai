import {
  MEETING_LINK_WRITTEN_KEYS,
  messageWithoutPaths,
  PROPOSAL_ID_KEY,
  readProposal,
  splitFrontmatter,
  type DoneAction,
  type PassedOver,
  type VaultPath,
} from '@dfai/domain';
import { changeProperties, type PropertyChange } from '../automations/apply-changes.ts';
import { EntryChangedError } from '../vault/ports.ts';
import type { MeetingLinkPorts, MeetingLinkRun } from './link-meeting.ts';

/** What undoing a meeting's linking did: each relation put back, each proposal taken away, and what was left. */
export interface MeetingLinkUndone {
  readonly restored: readonly DoneAction[];
  readonly withdrawn: readonly VaultPath[];
  readonly left: readonly PassedOver[];
}

const ANSWERED = 'It was answered since, so it was left as it is.';
const CHANGED = 'It was changed since, so it was left as it is.';

/**
 * Undoes linking a meeting, as an automation's run is undone: each relation
 * it set goes back to what it held — unless it has changed since, which is
 * left and said — and each proposal it wrote that is still open where it
 * was written goes to the Trash. Only what linking
 * declares it writes is put back: `people`, `companies` and `project` of that meeting.
 */
export async function undoMeetingLink({
  ports,
  run,
  today,
}: {
  ports: MeetingLinkPorts;
  run: MeetingLinkRun;
  today: string;
}): Promise<MeetingLinkUndone> {
  const restoring = run.done.flatMap((line) => restoringChange(run.meeting, line));
  const restored = await changeProperties({ ports, changes: restoring, kind: 'restored', today });
  const withdrawn: VaultPath[] = [];
  const left: PassedOver[] = [...restored.left];
  for (const path of run.proposed) {
    const problem = await withdraw(ports, path);
    if (problem === null) withdrawn.push(path);
    else left.push({ path, reason: problem });
  }
  return { restored: restored.done, withdrawn, left };
}

/** The change that puts one line back, or none for a line linking never writes. */
function restoringChange(meeting: VaultPath, line: DoneAction): PropertyChange[] {
  if (line.kind !== 'set' || line.path !== meeting) return [];
  if (!(MEETING_LINK_WRITTEN_KEYS as readonly string[]).includes(line.key)) return [];
  return [{ path: line.path, key: line.key, expect: line.after, to: line.before }];
}

/** Takes an open proposal away, or says why it was left. */
async function withdraw(ports: MeetingLinkPorts, path: VaultPath): Promise<string | null> {
  if (ports.editors.state(path) === 'dirty')
    return 'It has unsaved typing, so it was left as it is.';
  try {
    const { text, modified } = await ports.fs.readTextFile(path);
    const properties = ports.markdown.frontmatterProperties(splitFrontmatter(text).frontmatter);
    const reading = readProposal({ path, properties });
    if (
      !reading.ok ||
      reading.proposal.state !== 'open' ||
      properties[PROPOSAL_ID_KEY] === undefined
    ) {
      return ANSWERED;
    }
    // Held to the version just checked, so an edit landing before the Trash keeps it (#693).
    await ports.fs.trashEntry({ path, unchanged: [{ path, modified, text }] });
    return null;
  } catch (cause) {
    if (cause instanceof EntryChangedError) return CHANGED;
    // Gone — answered and archived, or deleted by hand: there is nothing left to take away.
    return messageWithoutPaths(cause);
  }
}
