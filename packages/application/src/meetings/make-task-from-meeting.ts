import {
  applyNoteProposal,
  isArchivedPath,
  isConflictCopyPath,
  MEETING_ITEM_KEY,
  MEETING_TASKS_KEY,
  meetingHolding,
  noteTitle,
  proposedChangeRefusal,
  TASK_MEETING_KEY,
  wikiLinkTargetFor,
  type MeetingIdentity,
  type ProposedNote,
  type VaultPath,
} from '@dfai/domain';
import { ProposalRefused, type AppliedProposal } from '../chat/proposals.ts';
import {
  carryOut,
  heldToTaskRules,
  proposalHomeFolder,
  readLinkNote,
  takeBackAll,
  type LinkNote,
  type NoteWritePorts,
} from '../proposals/proposal-writes.ts';
import { readFrontmatter } from './meeting-reading.ts';

/** The meeting a task is made from: where it is now, and which meeting it is. */
export interface TaskMeeting {
  readonly path: VaultPath;
  readonly identity: MeetingIdentity;
}

/** One of a meeting's action items, as the task made from it. */
export interface MeetingItemTask {
  /** A task, or a follow-up: a task to chase someone. */
  readonly kind: 'task' | 'follow-up';
  readonly title: string;
  /** Where the task goes; null for the top of the vault. */
  readonly folder: VaultPath | null;
  /** The task's own properties: its status, when it is due, who it waits on. */
  readonly properties: Readonly<Record<string, unknown>>;
  readonly body: string;
  /** The transcript block it came from, as a link: `[[2026-10-06 Standup#^t0001]]`. */
  readonly source: string;
  /**
   * Its identity as a meeting item (ADR-0036: the primary meeting, the cited
   * block and the owner), written as `atlas_item` beside a `meeting` link
   * back, so a re-run finds the task rather than making it again. Null makes
   * the task as Accept always has, with neither: a proposal keeps whose item
   * it was only inside its id.
   */
  readonly atlasItem: string | null;
}

/** What making the task did, kept so it can be undone in one step. */
export interface MadeTask {
  /** Where the task was made: its title's path, or a numbered one past a note of that name. */
  readonly task: VaultPath;
  /** The task made, then the meeting's `tasks` joined — unless the meeting listed it already. */
  readonly wrote: readonly AppliedProposal[];
}

/**
 * Makes a task from a meeting's action item and joins it to the meeting's
 * `tasks`: the one way a task is made from a meeting, whether a proposal is
 * accepted or a step makes it (#177, ADR-0036 "Linked both ways").
 *
 * The task cites its block in `source` and goes through the task rules
 * (ADR-0029), so one Waiting on nobody is refused before anything is written.
 * Only a meeting the import let in (ADR-0027) is written to: one in the
 * Archive, one still waiting to be let in, a copy, or a note holding another
 * meeting is refused, in words, with nothing written. A join that fails after
 * the task was made takes the task back.
 */
export async function makeTaskFromMeeting({
  ports,
  meeting,
  item,
  notePaths,
  today,
  joinsMeeting = true,
}: {
  ports: NoteWritePorts;
  meeting: TaskMeeting;
  item: MeetingItemTask;
  /** Every note in the vault now: the task never takes a path one of them has. */
  notePaths: readonly VaultPath[];
  /** `YYYY-MM-DD`, from the injected clock: what a task made finished says it was finished. */
  today: string;
  /**
   * Whether the meeting's `tasks` is joined here. False when the caller joins
   * it later, in its own one write to the meeting: the step that writes the
   * summary (#185, ADR-0036 "One meeting write").
   */
  joinsMeeting?: boolean;
}): Promise<MadeTask> {
  const link = await meetingLetIn(ports, meeting);
  const proposed = proposedTask({ meeting, item, notePaths, joinsMeeting });
  const applied = applyNoteProposal(proposed, {
    notePaths,
    target: link.target,
    homeFolder: await proposalHomeFolder(ports, { ...proposed, today }),
  });
  if (!applied.ok) throw new ProposalRefused(applied.problem);
  const ruled = applied.writes.map((write) => heldToTaskRules(ports, { write, link, today }));
  const wrote = await carryOut(ports, {
    writes: ruled,
    link,
    headline: item.title,
    failed: 'the task could not be added to its meeting',
  });
  const [made] = wrote;
  // A task is a record of its own: it is always made, under a numbered name if need be.
  if (made?.kind !== 'created') throw new Error(`No task was made for “${item.title}”.`);
  return { task: made.path, wrote };
}

/** Takes back what making a task did, all of it or none (see {@link makeTaskFromMeeting}). */
export async function undoMadeTask({
  ports,
  made,
}: {
  ports: NoteWritePorts;
  made: MadeTask;
}): Promise<void> {
  await takeBackAll(ports, made.wrote);
}

/** The meeting as it is now, read to join; refused unless the import let it in and it is out of the Archive. */
async function meetingLetIn(
  ports: NoteWritePorts,
  { path, identity }: TaskMeeting,
): Promise<LinkNote> {
  const title = noteTitle(path);
  if (isArchivedPath(path)) {
    throw new ProposalRefused(
      `The meeting “${title}” has been archived; no task is made from it, so nothing was written.`,
    );
  }
  const refusal = proposedChangeRefusal(path);
  if (refusal !== null) throw new ProposalRefused(refusal);
  // A sync's conflict copy holds no meeting, whatever its keys say: its path tells.
  if (isConflictCopyPath(path)) throw notTheMeeting(title);
  const link = await readLinkNote(ports, { note: path, property: MEETING_TASKS_KEY });
  if (link === null) {
    throw new ProposalRefused(`“${title}” is not there any more; nothing was written.`);
  }
  const held = meetingHolding({
    text: link.text,
    readFrontmatter: (frontmatter) => readFrontmatter(ports.markdown, frontmatter),
    meeting: identity,
  });
  if (held === 'unsettled') {
    throw new ProposalRefused(
      `The meeting “${title}” has not been let in by the import yet, so no task is made from it; nothing was written.`,
    );
  }
  if (held === null) throw notTheMeeting(title);
  return link;
}

const notTheMeeting = (title: string) =>
  new ProposalRefused(
    `“${title}” is not the meeting this task is for, as the import let it in; nothing was written.`,
  );

/** The task as a note to make: citing its block, joining the meeting's `tasks` unless told not to, and keyed by its item when it has a key. */
function proposedTask({
  meeting,
  item,
  notePaths,
  joinsMeeting,
}: {
  meeting: TaskMeeting;
  item: MeetingItemTask;
  notePaths: readonly VaultPath[];
  joinsMeeting: boolean;
}): ProposedNote {
  const keyed =
    item.atlasItem === null
      ? {}
      : {
          [TASK_MEETING_KEY]: `[[${wikiLinkTargetFor(meeting.path, notePaths)}]]`,
          [MEETING_ITEM_KEY]: item.atlasItem,
        };
  return {
    kind: item.kind,
    source: item.source,
    payload: {
      title: item.title,
      folder: item.folder,
      properties: { ...item.properties, ...keyed },
      body: item.body,
      linkFrom: joinsMeeting
        ? { note: meeting.path, property: MEETING_TASKS_KEY, meeting: meeting.identity }
        : null,
    },
  };
}
