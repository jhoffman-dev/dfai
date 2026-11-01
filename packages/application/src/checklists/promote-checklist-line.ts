import {
  anchorsIn,
  capturedTaskStatus,
  checklistLines,
  indexedTexts,
  inheritedProject,
  joinFrontmatter,
  leadingLinkTarget,
  lineBlockId,
  lineContent,
  messageOf,
  plainWords,
  resolveWikiLinkTarget,
  splitFrontmatter,
  TASK_TYPE,
  newBlockId,
  noteTitle,
  promotedTaskName,
  promotedTaskProperties,
  promotedTaskStatus,
  wikiLinkTargetFor,
  withPromotedLine,
  type ChecklistLine,
  type EditorDocument,
  type EditorNode,
  type ObjectType,
  type VaultPath,
} from '@dfai/domain';
import type { OpenNotes } from '../api/ports.ts';
import type { Rng } from '../ports.ts';
import { createNoteAsWritten } from '../notes/create-note.ts';
import { NoteChangedError } from '../notes/note-changed-error.ts';
import { noteModified } from '../notes/note-modified.ts';
import { openNote, type OpenNote } from '../notes/open-note.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { saveNote } from '../notes/save-note.ts';
import { UnsavedTypingError } from '../vault/update-links.ts';
import {
  EntryChangedError,
  isChangedOnDiskRefusal,
  type AsRead,
  type VaultFsPort,
} from '../vault/ports.ts';

/** The panes, as a write to a note they may hold needs them. */
export type PromotionPanes = Pick<OpenNotes, 'state' | 'reload'>;

/** What promoting a line did, kept so one undo can take back both halves. */
export interface Promotion {
  /** The note the line was in. */
  readonly source: VaultPath;
  /** The task made of it. */
  readonly task: VaultPath;
  /** The note the line was in, as it was before, byte for byte. */
  readonly previous: string;
  /**
   * Each as the promotion last wrote it, its time and its whole text: an undo
   * refuses either changed since, by the text too for a disk that keeps the
   * time to the second (#245, #694).
   */
  readonly sourceModified: number;
  readonly sourceText: string;
  readonly taskModified: number;
  readonly taskText: string;
}

/** Why a line could not be promoted, or a promotion undone, in words for the person. */
export class PromotionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromotionRefused';
  }
}

/** The line is a link to a task already: promoting it again would make a second. */
export class LineAlreadyPromotedError extends PromotionRefused {
  readonly task: VaultPath;

  constructor(task: VaultPath) {
    super(`That line is the task “${noteTitle(task)}” already.`);
    this.name = 'LineAlreadyPromotedError';
    this.task = task;
  }
}

/** Which line to promote: its place among the note's boxes, and the words it was offered with. */
export interface ChecklistLineChoice {
  readonly source: VaultPath;
  /** Its index among the note's boxes, in the order `checklistLines` reads them. */
  readonly line: number;
  /** Its words when it was offered: a line that no longer says them is refused. */
  readonly text: string;
}

/**
 * Promotes a checklist line to a task (P30-03). The task is a new note
 * beside the line's, named by the line's words, whose `source` links to the
 * line and which is filed under the project the line's note is in (or is);
 * it starts where a captured task does, or finished when the line is ticked.
 * The line becomes a link to the task, keeping its box.
 *
 * Both halves go through the writes every note goes through: the task is
 * made by `createNote`, which holds it to the task rules (ADR-0029), and the
 * line is rewritten by `saveNote`, byte-preserving and refused if the note
 * moved on since it was read. The id the source link names is written on the
 * line in that same save (ADR-0022); a line that has its own keeps it. If
 * the save is refused, the task just made is taken back, so nothing is left
 * half done.
 *
 * A note a pane holds unsaved typing in is not written behind that pane's
 * back (`UnsavedTypingError`); one that no longer has the line where, and as,
 * it was offered is refused (`PromotionRefused`). A clean pane holding it
 * reads it again.
 */
export async function promoteChecklistLine({
  fs,
  markdown,
  openNotes,
  rng,
  today,
  notePaths,
  taskType,
  choice,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  openNotes: PromotionPanes;
  rng: Rng;
  /** `YYYY-MM-DD`: what the task rules date by. */
  today: string;
  notePaths: readonly VaultPath[];
  /** The vault's Task type, which says what a new task starts as; null when it has none. */
  taskType: ObjectType | null;
  choice: ChecklistLineChoice;
}): Promise<Promotion> {
  const { source } = choice;
  refuseUnsaved(openNotes, source);
  const note = await openNote({ fs, markdown, path: source });
  const line = chosenLine(note, choice);
  const content = lineContent(note.doc, line.at);
  await refuseTaskAlready({ fs, markdown, notePaths, content });
  const name = promotedTaskName(line.text);
  if (name === '') throw new PromotionRefused('That line has no words to name a task by.');

  const blockId =
    lineBlockId(note.doc, line.at) ?? newBlockId(() => rng.next(), anchorsIn(note.doc));
  const linkToSource = wikiLinkTargetFor(source, notePaths);
  const properties = promotedTaskProperties({
    status: promotedTaskStatus({ captured: capturedTaskStatus(taskType), done: line.done }),
    linkToSource,
    blockId,
    project: inheritedProject({ properties: note.properties, linkToSource }),
  });
  // As written: the task rules may add to the text asked for (a ticked line is dated `completed`).
  const made = await createNoteAsWritten({
    fs,
    markdown,
    today,
    name,
    beside: source,
    notePaths,
    contents: joinFrontmatter(
      markdown.updateFrontmatter(null, properties),
      keptInTask({ markdown, content }),
    ),
    properties,
  });
  const task = made.path;

  const linkToTask = wikiLinkTargetFor(task, [...notePaths, task]);
  const doc = withPromotedLine(note.doc, { at: line.at, blockId, linkToTask });
  const saved = await savedOrTakenBack({ fs, markdown, openNotes, note, doc, made });
  if (openNotes.state(source) === 'clean') openNotes.reload(source);
  return {
    source,
    task,
    // The split is lossless: frontmatter and body together are the file as read.
    previous: (note.frontmatter ?? '') + note.originalBody,
    sourceModified: saved.modified,
    sourceText: saved.onDisk,
    taskModified: made.modified,
    taskText: made.text,
  };
}

/**
 * A line that starts with a link to a task is that task already — promoted
 * before, or written so: refused, so a retry never makes a second task and
 * leaves the first with a source that no longer points at it.
 */
async function refuseTaskAlready({
  fs,
  markdown,
  notePaths,
  content,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  notePaths: readonly VaultPath[];
  content: readonly EditorNode[];
}): Promise<void> {
  const target = leadingLinkTarget(content);
  const linked = target === null ? null : resolveWikiLinkTarget(target, notePaths);
  if (linked === null) return;
  let text: string;
  try {
    ({ text } = await fs.readTextFile(linked));
  } catch {
    // A note the link names but that cannot be read is no task to keep: the line may be promoted.
    return;
  }
  const properties = markdown.frontmatterProperties(splitFrontmatter(text).frontmatter);
  if (indexedTexts(properties['type']).includes(TASK_TYPE)) {
    throw new LineAlreadyPromotedError(linked);
  }
}

/**
 * The task's body: nothing for a line of plain words, which its name and its
 * link already say; else the line's markdown, so its links and tags reach the task.
 */
function keptInTask({
  markdown,
  content,
}: {
  markdown: MarkdownPort;
  content: readonly EditorNode[];
}): string {
  if (plainWords(content) !== null) return '';
  return `${lineMarkdown({ markdown, content })}\n`;
}

/** A line's own content as markdown, written as the note's writer writes it. */
export function lineMarkdown({
  markdown,
  content,
}: {
  markdown: Pick<MarkdownPort, 'parseBody' | 'serializeBody'>;
  content: readonly EditorNode[];
}): string {
  const doc: EditorDocument = { type: 'doc', content: [{ type: 'paragraph', content }] };
  return markdown.serializeBody({ originalBody: '', parsed: markdown.parseBody(''), doc }).trim();
}

/** The line chosen, as the note says it now; refused when it is not there or not as offered. */
function chosenLine(note: OpenNote, choice: ChecklistLineChoice): ChecklistLine {
  const line = checklistLines(note.doc)[choice.line];
  if (line === undefined || line.text !== choice.text) {
    throw new PromotionRefused(
      `${noteTitle(choice.source)} changed since that line was offered. Pick it again.`,
    );
  }
  return line;
}

/**
 * The line's note written with the line promoted, and when it was; if the
 * write is refused — typing began in a pane, or the file moved on — the task
 * just made is taken back first, and the refusal said.
 */
async function savedOrTakenBack({
  fs,
  markdown,
  openNotes,
  note,
  doc,
  made,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  openNotes: PromotionPanes;
  note: OpenNote;
  doc: EditorDocument | null;
  /** The task just made, as the create wrote it. */
  made: AsRead;
}): Promise<OpenNote> {
  try {
    if (doc === null) throw new PromotionRefused('That line is no longer a checklist line.');
    refuseUnsaved(openNotes, note.path);
    return (await saveNote({ fs, markdown, note, doc })).note;
  } catch (error) {
    await takeBack({ fs, made, cause: error });
    if (await movedOn({ fs, path: note.path, expected: note.modified, error })) {
      throw new PromotionRefused(
        `${noteTitle(note.path)} changed while the line was being promoted; nothing was changed.`,
      );
    }
    throw error;
  }
}

/**
 * Whether a write was refused because the note moved on since `expected`,
 * however the host worded the refusal.
 */
async function movedOn({
  fs,
  path,
  expected,
  error,
}: {
  fs: VaultFsPort;
  path: VaultPath;
  expected: number;
  error: unknown;
}): Promise<boolean> {
  return error instanceof NoteChangedError || (await noteModified({ fs, path })) !== expected;
}

/**
 * Trashes the task a refused promotion made, held to the version the create
 * wrote, so one already typed in is kept (#694); if that fails too, says both.
 */
async function takeBack({
  fs,
  made,
  cause,
}: {
  fs: VaultFsPort;
  made: AsRead;
  cause: unknown;
}): Promise<void> {
  const task = made.path;
  try {
    await fs.trashEntry({ path: task, unchanged: [made] });
  } catch (trashError) {
    throw new AggregateError(
      [cause, trashError],
      `The line was not changed, and ${noteTitle(task)}, made for it, could not be taken back.`,
      { cause: trashError },
    );
  }
}

/**
 * Takes a promotion back in one step: the line's note gets back its bytes and
 * the task goes to the trash — refused, with nothing changed, when either was
 * written since, or a pane holds unsaved typing in either.
 */
export async function undoPromotion({
  fs,
  openNotes,
  promotion,
}: {
  fs: VaultFsPort;
  openNotes: PromotionPanes;
  promotion: Promotion;
}): Promise<void> {
  const { source, task } = promotion;
  refuseUnsaved(openNotes, source);
  refuseUnsaved(openNotes, task);
  const asPromoted = { path: task, modified: promotion.taskModified, text: promotion.taskText };
  await refuseChanged({ fs, read: asPromoted, gone: taskGone });
  await refuseChanged({
    fs,
    read: { path: source, modified: promotion.sourceModified, text: promotion.sourceText },
  });
  // The task goes first, held to the promotion's version: if it is kept, the
  // line still links it, rather than a line put back beside a task it no
  // longer names (#694).
  try {
    await fs.trashEntry({ path: task, unchanged: [asPromoted] });
  } catch (error) {
    if (error instanceof EntryChangedError) throw changedSince(task);
    throw error;
  }
  try {
    await fs.writeTextFile({
      path: source,
      contents: promotion.previous,
      expectedModified: promotion.sourceModified,
      expectedText: promotion.sourceText,
    });
  } catch (error) {
    throw await sourceNotPutBack({ fs, promotion, error });
  }
  if (openNotes.state(source) === 'clean') openNotes.reload(source);
}

/**
 * Why the line was not put back once its task was in the Trash: the task can
 * be put back from there, so the person is told both halves.
 */
async function sourceNotPutBack({
  fs,
  promotion: { source, task, sourceModified },
  error,
}: {
  fs: VaultFsPort;
  promotion: Promotion;
  error: unknown;
}): Promise<Error> {
  const why =
    isChangedOnDiskRefusal(error) ||
    (await movedOn({ fs, path: source, expected: sourceModified, error }))
      ? `${noteTitle(source)} changed since the line was promoted`
      : messageOf(error);
  return new PromotionRefused(
    `${noteTitle(task)} went to the Trash, but its line was not put back: ${why}. Put the task back from the Trash to keep both as they were.`,
  );
}

/**
 * Refuses unless the note still has the time and the text the promotion left
 * it with. One that cannot be read is refused with `gone`, when given.
 */
async function refuseChanged({
  fs,
  read,
  gone = changedSince,
}: {
  fs: VaultFsPort;
  read: AsRead;
  gone?: (path: VaultPath) => PromotionRefused;
}): Promise<void> {
  let now: { text: string; modified: number };
  try {
    now = await fs.readTextFile(read.path);
  } catch {
    // Gone or unreadable: either way it is not as the promotion left it.
    throw gone(read.path);
  }
  if (now.modified !== read.modified || now.text !== read.text) throw changedSince(read.path);
}

/** The task is not there: an earlier undo may have put it in the Trash before its line failed. */
function taskGone(path: VaultPath): PromotionRefused {
  return new PromotionRefused(
    `${noteTitle(path)} is not where the line was promoted to; if it is in the Trash, put it back first, then undo again. Nothing was undone.`,
  );
}

function changedSince(path: VaultPath): PromotionRefused {
  return new PromotionRefused(
    `${noteTitle(path)} changed since the line was promoted; nothing was undone.`,
  );
}

function refuseUnsaved(openNotes: PromotionPanes, path: VaultPath): void {
  if (openNotes.state(path) === 'dirty') throw new UnsavedTypingError(path);
}
