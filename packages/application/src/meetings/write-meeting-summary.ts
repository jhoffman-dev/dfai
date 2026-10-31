import {
  MEETING_TASKS_KEY,
  noteTitle,
  placeSummary,
  removeSummary,
  restoreSummary,
  SUMMARY_DIGEST_KEY,
  SUMMARY_MODEL_KEY,
  stillAsLeft,
  SUMMARY_OF_KEY,
  tasksJoined,
  tasksParted,
  type DoneAction,
  type ReplacedSummary,
  type SummaryRefusal,
  type VaultPath,
} from '@dfai/domain';
import { priorOf, restoredValue, type PropertyChange } from '../automations/apply-changes.ts';
import { ProposalRefused } from '../chat/proposals.ts';
import { NoteChangedError } from '../notes/note-changed-error.ts';
import { readLinkNote, type NoteWritePorts } from '../proposals/proposal-writes.ts';
import { writeStamp } from './meeting-stamp-writer.ts';

/** What the declared step writes to one meeting, last, in one write (ADR-0036). */
export interface MeetingSummaryWrite {
  readonly meeting: VaultPath;
  /** When the step read the meeting: the write is refused if it changed since. */
  readonly modified: number;
  /** The summary block to place, as `renderSummaryBlock` wrote it; null when there is none to write. */
  readonly block: string | null;
  /** The digest of the transcript the summary is of: `atlas_summary_of`. */
  readonly summaryOf: string | null;
  readonly model: string;
  /** The tasks to join into the meeting's `tasks`: made now, or made before and not yet listed. */
  readonly tasks: readonly VaultPath[];
  /** Every note in the vault, the tasks included: what a link to a task is spelt against. */
  readonly notePaths: readonly VaultPath[];
  /** The project to file the meeting under, in this same write (#227); null when it is not to be filed. */
  readonly project?: PropertyChange | null;
}

/** A property a run set or an undo put back, as the log says it. */
type PropertyLine = Extract<DoneAction, { key: string }>;

/** What the write did to the meeting. */
export interface MeetingSummaryWritten {
  /** The block's digest when it was written; null when none was. */
  readonly digest: string | null;
  /** The summary the block was written over, for undo to put back; null when there was none. */
  readonly replaced: ReplacedSummary | null;
  /** Why the block was left as the person has it, when it was: a refusal of the grammar's. */
  readonly kept: { readonly refusal: SummaryRefusal; readonly reason: string } | null;
  /** The tasks it joined into the meeting's `tasks`. */
  readonly joined: readonly VaultPath[];
  /** The `project` it set, as the run's log says it; null when none was set. */
  readonly filed: PropertyLine | null;
  /** Why the project was not set, when it was left: the meeting's `project` changed since it was read. */
  readonly projectLeft: string | null;
}

/**
 * The write was refused, with nothing written: the meeting has unsaved typing
 * in a pane, changed since the step read it, or is not there. The summary and
 * the `tasks` relation are written later, from the answer the step keeps.
 */
export class MeetingSummaryRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeetingSummaryRefused';
  }
}

/**
 * Writes a meeting's summary block, its keys and its `tasks` relation in one
 * write (#185, ADR-0036 "One meeting write, tasks first"), guarded by the
 * modified time the step read: the step makes the tasks first, so no summary
 * lists a task that does not exist.
 *
 * The block is placed by the domain's rule (`placeSummary`): replaced only
 * when it is the one recorded, so the person's edits are never written over.
 * A block the grammar refuses is left as it is (`kept`), and the tasks are
 * still joined. The keys go after the `atlas_import:` line; every byte
 * outside the block and the keys is kept.
 *
 * Rejects with {@link MeetingSummaryRefused}, writing nothing, when the
 * meeting has unsaved typing, changed since `modified`, or is gone.
 */
export async function writeMeetingSummary(
  ports: NoteWritePorts,
  write: MeetingSummaryWrite,
): Promise<MeetingSummaryWritten> {
  const link = await readMeeting(ports, write.meeting, WRITING);
  if (link.modified !== write.modified) throw WRITING.changed(noteTitle(write.meeting));
  const properties = ports.markdown.frontmatterProperties(link.document.frontmatter);
  const recorded = properties[SUMMARY_DIGEST_KEY];
  const placed =
    write.block === null
      ? null
      : placeSummary(link.document.body, write.block, {
          recorded: typeof recorded === 'string' ? recorded : null,
        });
  const tasks =
    link.target.relation === null
      ? null
      : tasksJoined({
          value: link.target.value,
          tasks: write.tasks,
          notePaths: write.notePaths,
          many: link.target.relation.many,
        });
  const summary =
    placed?.ok === true
      ? {
          [SUMMARY_DIGEST_KEY]: placed.digest,
          [SUMMARY_OF_KEY]: write.summaryOf,
          [SUMMARY_MODEL_KEY]: write.model,
        }
      : {};
  const project = projectFiling(properties, write.project ?? null);
  const values = {
    ...summary,
    ...(tasks !== null && { [MEETING_TASKS_KEY]: tasks }),
    ...project.values,
  };
  const written: MeetingSummaryWritten = {
    digest: placed?.ok === true ? placed.digest : null,
    replaced:
      placed?.ok === true && placed.prior !== null
        ? {
            block: placed.prior,
            of: textOrNull(properties[SUMMARY_OF_KEY]),
            model: textOrNull(properties[SUMMARY_MODEL_KEY]),
          }
        : null,
    kept: placed === null || placed.ok ? null : { refusal: placed.refusal, reason: placed.reason },
    joined: tasks === null ? [] : write.tasks,
    filed: project.filed,
    projectLeft: project.left,
  };
  if (Object.keys(values).length === 0) return written;
  await stamped(
    ports,
    {
      path: write.meeting,
      modified: link.modified,
      values,
      ...(placed?.ok === true && { body: placed.body }),
    },
    WRITING,
  );
  return written;
}

/** The `project` to set with the summary, decided against the meeting as it is being written. */
function projectFiling(
  properties: Readonly<Record<string, unknown>>,
  change: PropertyChange | null,
): { values: Record<string, unknown>; filed: PropertyLine | null; left: string | null } {
  const none = { values: {}, filed: null, left: null };
  if (change === null) return none;
  const before = priorOf(properties, change.key);
  if (change.expect !== null && !stillAsLeft(before, change.expect)) {
    return { ...none, left: `Its ${change.key} has changed since, so it was left as it is.` };
  }
  if (stillAsLeft(before, change.to)) return none;
  return {
    values: { [change.key]: restoredValue(change.key, change.to) },
    filed: { kind: 'set', path: change.path, key: change.key, before, after: change.to },
    left: null,
  };
}

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** What a run wrote of a meeting's summary, as its log says: the block's digest, and what it replaced. */
export interface SummaryToTakeBack {
  readonly digest: string;
  readonly replaced?: ReplacedSummary | undefined;
}

/**
 * Takes a run's writes back off a meeting, in one write (#185, Undo last
 * run): the block while it is still the one written — out, or back to the
 * summary it replaced, with that one's keys — and the links to the tasks the
 * undo is to trash, and the `project` the run filled, while it is still the
 * run's.
 *
 * The meeting is checked, then `trash` is handed the tasks, then the one
 * write drops the links of only those it took (#685). So a refusal found in
 * the check leaves the meeting and its tasks as they are, and a task the
 * Trash will not take keeps its link. Should the meeting change while its
 * tasks are trashed, the write is refused and a link names a trashed note:
 * the one failure left, and the safe one, since the Trash gives the note back
 * and the link shows where it was.
 *
 * Rejects with {@link MeetingSummaryRefused}, writing nothing, when the block
 * was edited since, the meeting has unsaved typing, changed meanwhile, or is
 * gone.
 */
export async function undoMeetingSummary(
  ports: NoteWritePorts,
  {
    meeting,
    summary,
    trashing,
    trash,
    notePaths,
    project = null,
  }: {
    meeting: VaultPath;
    /** What the run wrote of the summary; null when it wrote none (it only joined tasks). */
    summary: SummaryToTakeBack | null;
    /** The tasks the undo is to trash. */
    trashing: readonly VaultPath[];
    /** Trashes those tasks once the meeting is checked; the ones it took leave the meeting's `tasks`. */
    trash: (tasks: readonly VaultPath[]) => Promise<readonly VaultPath[]>;
    /** Every note the links were spelt against, the tasks included. */
    notePaths: readonly VaultPath[];
    /** The `project` the run filled the meeting under, to clear in this same write (#227). */
    project?: PropertyChange | null;
  },
): Promise<MeetingSummaryUndone> {
  const link = await readMeeting(ports, meeting, UNDOING);
  const taken = summary === null ? null : summaryTakenBack(link.document.body, summary);
  if (taken !== null && !taken.ok) throw new MeetingSummaryRefused(taken.reason);
  const trashed = trashing.length === 0 ? [] : await trash(trashing);
  const tasks =
    trashed.length === 0
      ? undefined
      : tasksParted({ value: link.target.value, tasks: trashed, notePaths });
  const properties = ports.markdown.frontmatterProperties(link.document.frontmatter);
  const filing = projectFiling(properties, project);
  const values = {
    ...(taken === null ? {} : taken.keys),
    ...(tasks !== undefined && { [MEETING_TASKS_KEY]: tasks }),
    ...filing.values,
  };
  const restored = filing.filed === null ? null : { ...filing.filed, kind: 'restored' as const };
  const undone = { restored, projectLeft: filing.left };
  if (Object.keys(values).length === 0) return undone;
  await stamped(
    ports,
    {
      path: meeting,
      modified: link.modified,
      values,
      ...(taken !== null && { body: taken.body }),
    },
    UNDOING,
  );
  return undone;
}

/** What taking a run's writes off a meeting did besides the summary and the links. */
export interface MeetingSummaryUndone {
  /** The `project` put back, as the undo's log says it; null when none was. */
  readonly restored: PropertyLine | null;
  /** Why `project` was left, when it was: it changed since the run set it. */
  readonly projectLeft: string | null;
}

/** The body and keys with the run's block taken out, or put back to the one it replaced. */
function summaryTakenBack(
  body: string,
  { digest, replaced }: SummaryToTakeBack,
):
  | { readonly ok: true; readonly body: string; readonly keys: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string } {
  if (replaced === undefined) {
    const removed = removeSummary(body, { recorded: digest });
    if (!removed.ok) return removed;
    const keys = { [SUMMARY_DIGEST_KEY]: null, [SUMMARY_OF_KEY]: null, [SUMMARY_MODEL_KEY]: null };
    return { ok: true, body: removed.body, keys };
  }
  const restored = restoreSummary(body, { recorded: digest, prior: replaced.block });
  if (!restored.ok) return restored;
  const keys = {
    [SUMMARY_DIGEST_KEY]: restored.digest,
    [SUMMARY_OF_KEY]: replaced.of,
    [SUMMARY_MODEL_KEY]: replaced.model,
  };
  return { ok: true, body: restored.body, keys };
}

/** What a refusal says, by what was being done. */
interface Refusals {
  readonly unsaved: (title: string) => MeetingSummaryRefused;
  readonly changed: (title: string) => MeetingSummaryRefused;
}

const WRITING: Refusals = {
  unsaved: (title) =>
    new MeetingSummaryRefused(
      `“${title}” has unsaved typing, so its summary was not written yet; it is written from the same answer once it is saved.`,
    ),
  changed: (title) =>
    new MeetingSummaryRefused(
      `“${title}” changed while Claude read it, so its summary was not written yet; it is written from the same answer on the next try.`,
    ),
};

const UNDOING: Refusals = {
  unsaved: (title) =>
    new MeetingSummaryRefused(`“${title}” has unsaved typing, so its summary was left as it is.`),
  changed: (title) =>
    new MeetingSummaryRefused(`“${title}” changed just now, so its summary was left as it is.`),
};

/** The meeting as it is now, with its `tasks` as its type reads it; refused when typed in or gone. */
async function readMeeting(ports: NoteWritePorts, meeting: VaultPath, refusals: Refusals) {
  const title = noteTitle(meeting);
  let link;
  try {
    link = await readLinkNote(ports, { note: meeting, property: MEETING_TASKS_KEY });
  } catch (error) {
    // The one refusal reading makes is a pane with unsaved typing.
    if (error instanceof ProposalRefused) throw refusals.unsaved(title);
    throw error;
  }
  if (link === null) throw new MeetingSummaryRefused(`“${title}” is not there any more.`);
  return link;
}

/** Writes the keys and body through the import's stamp writer, its refusals said as the summary's. */
async function stamped(
  ports: NoteWritePorts,
  stamp: Parameters<typeof writeStamp>[1],
  refusals: Refusals,
): Promise<void> {
  const title = noteTitle(stamp.path);
  let refused: string | null;
  try {
    refused = await writeStamp(ports, stamp);
  } catch (error) {
    if (error instanceof NoteChangedError) throw refusals.changed(title);
    throw error;
  }
  if (refused !== null) throw refusals.unsaved(title);
}
