import {
  BLOCK_KEYS,
  BLOCK_TYPE,
  blockTasksWith,
  blockTasksWithout,
  blockTypeOf,
  isBlockType,
  NEW_NOTE_CONTENTS,
  newBlockName,
  newBlockTimes,
  splitFrontmatter,
  taskLink,
  type BlockTimes,
  type ObjectType,
  type VaultPath,
} from '@dfai/domain';
import type { IndexPort } from '../index/ports.ts';
import { createNote } from '../notes/create-note.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { PropertyChanges } from '../query/set-property.ts';
import { findTypeTemplate, loadTemplates, readTemplate } from '../types/templates.ts';
import { forgetNotes } from '../index/refresh-index.ts';
import { EntryChangedError, type OpenEditorsPort, type VaultFsPort } from '../vault/ports.ts';

/**
 * Writes a note's properties through whichever of the task rules' chokepoints
 * holds it (ADR-0029): the save of a pane that has it open, else
 * `setNoteProperties`. The app answers with its own; nothing here writes a
 * note's file directly.
 */
export type WriteNoteProperties = (args: {
  path: VaultPath;
  values: PropertyChanges;
}) => Promise<void>;

/** A start and a length that make no block: no time of day, no length, or past a date's range. */
export class BlockTimesError extends Error {
  constructor({ start, minutes }: { start: string; minutes: number }) {
    super(
      `A block cannot run ${String(minutes)} minutes from ${JSON.stringify(start)}: ` +
        'it needs a day and a time, written 2026-10-12T09:00, and a whole number of minutes from 1 to 1440.',
    );
    this.name = 'BlockTimesError';
  }
}

/** Undo found the block changed since the drop, and left it as it is rather than lose that. */
export class BlockChangedError extends Error {
  constructor(block: VaultPath) {
    super(`${block} has changed since the task was scheduled, so it is left as it is.`);
    this.name = 'BlockChangedError';
  }
}

/** Undo found typing not yet saved in a pane holding the block, and left the block rather than lose it. */
export class BlockBeingEditedError extends Error {
  constructor(block: VaultPath) {
    super(`${block} has typing not yet saved, so it is left as it is.`);
    this.name = 'BlockBeingEditedError';
  }
}

/** A task was to join a note that is not a block: nothing was written to it. */
export class NotABlockError extends Error {
  constructor(note: VaultPath) {
    super(`${note} is not a block, so no task was added to it.`);
    this.name = 'NotABlockError';
  }
}

/** What a drop on the calendar did, kept so it can be undone. */
export type Scheduling =
  /** A block made for the task, holding exactly `contents` as it was written. */
  | {
      readonly kind: 'created';
      readonly block: VaultPath;
      readonly task: VaultPath;
      readonly contents: string;
    }
  /** The task linked into a block that was already there. */
  | { readonly kind: 'added'; readonly block: VaultPath; readonly task: VaultPath };

/**
 * A new block for a task (P31-02): `minutes` long from `start`, linking the
 * task, made as every new note is (`createNote`) at the top of the vault —
 * from the Block type's template when the vault has one, with its start, end
 * and tasks written into that frontmatter. Refused with
 * {@link BlockTimesError} before anything is made when the times make no
 * block.
 */
export async function createBlockForTask({
  fs,
  markdown,
  types,
  task,
  start,
  minutes,
  notePaths,
  today,
}: {
  fs: VaultFsPort;
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'updateFrontmatter'>;
  types: readonly ObjectType[];
  task: { readonly path: VaultPath; readonly title: string };
  /** When it starts, as wall-clock time: `2026-10-12T09:00`. */
  start: string;
  minutes: number;
  notePaths: readonly VaultPath[];
  /** `YYYY-MM-DD`: what the task rules date a note by, as every new note is made. */
  today: string;
}): Promise<Scheduling & { readonly kind: 'created' }> {
  const times = newBlockTimes({ start, minutes });
  if (times === null) throw new BlockTimesError({ start, minutes });
  const template = await blockTemplate({ fs, type: blockTypeOf(types) });
  const contents = blockContents({
    markdown,
    template,
    times,
    link: taskLink(task.path, notePaths),
  });
  const block = await createNote({
    fs,
    markdown,
    today,
    name: newBlockName(task.title),
    beside: null,
    notePaths,
    contents,
  });
  return { kind: 'created', block, task: task.path, contents };
}

async function blockTemplate({
  fs,
  type,
}: {
  fs: VaultFsPort;
  type: Pick<ObjectType, 'name' | 'label'>;
}): Promise<string | null> {
  const template = findTypeTemplate(await loadTemplates({ fs }), type);
  return template === null ? null : readTemplate({ fs, template });
}

/** The template, or an empty note, with the block's type, times and task written over its frontmatter. */
function blockContents({
  markdown,
  template,
  times,
  link,
}: {
  markdown: Pick<MarkdownPort, 'updateFrontmatter'>;
  template: string | null;
  times: BlockTimes;
  link: string;
}): string {
  const { frontmatter, body } = splitFrontmatter(template ?? NEW_NOTE_CONTENTS);
  const written = markdown.updateFrontmatter(frontmatter, {
    type: BLOCK_TYPE,
    [BLOCK_KEYS.start]: times.start,
    [BLOCK_KEYS.end]: times.end,
    [BLOCK_KEYS.tasks]: [link],
  });
  return written + body;
}

/**
 * Links a task into a block that is already there (P31-02), through
 * `writeProperties`, worked out against the block as it is when written so a
 * task linked a moment earlier elsewhere is kept. Null when the block already
 * links the task: nothing was written, and there is nothing to undo. A note
 * that is not a block — its type changed since the calendar was drawn, say —
 * is left as it is, with {@link NotABlockError}: a meeting gains no `tasks`.
 */
export async function addTaskToBlock({
  writeProperties,
  block,
  task,
  notePaths,
}: {
  writeProperties: WriteNoteProperties;
  block: VaultPath;
  task: VaultPath;
  notePaths: readonly VaultPath[];
}): Promise<(Scheduling & { readonly kind: 'added' }) | null> {
  let added = false;
  let isBlock = true;
  await writeProperties({
    path: block,
    values: (properties) => {
      isBlock = isBlockType(typeof properties['type'] === 'string' ? properties['type'] : null);
      if (!isBlock) return {};
      const tasks = blockTasksWith({ tasks: properties[BLOCK_KEYS.tasks], task, notePaths });
      added = tasks !== null;
      return tasks === null ? {} : { [BLOCK_KEYS.tasks]: tasks };
    },
  });
  if (!isBlock) throw new NotABlockError(block);
  return added ? { kind: 'added', block, task } : null;
}

/**
 * Takes back what a drop did. A block the drop made goes to the Trash, where
 * it can still be recovered, but only while it holds exactly what the drop
 * wrote and no pane holds typing in it not yet saved — one edited since is
 * left, with {@link BlockChangedError}, and one being edited with
 * {@link BlockBeingEditedError}, rather than the edits lost. A task the drop
 * linked into a block is unlinked, the block's other tasks kept as written; a
 * block that no longer links it is left alone.
 */
export async function undoScheduling({
  scheduling,
  fs,
  index,
  editors,
  writeProperties,
  notePaths,
}: {
  scheduling: Scheduling;
  fs: VaultFsPort;
  index: IndexPort;
  /** The panes, asked whether one holds typing in the block not yet saved. */
  editors: Pick<OpenEditorsPort, 'state'>;
  writeProperties: WriteNoteProperties;
  notePaths: readonly VaultPath[];
}): Promise<void> {
  if (scheduling.kind === 'created') {
    const { text, modified } = await fs.readTextFile(scheduling.block);
    if (text !== scheduling.contents) throw new BlockChangedError(scheduling.block);
    // Asked after the read, as close to the Trash as it can be.
    if (editors.state(scheduling.block) === 'dirty') {
      throw new BlockBeingEditedError(scheduling.block);
    }
    const made = scheduling.block;
    try {
      // Held to the read just checked, so an edit landing before the Trash keeps the block (#694).
      await fs.trashEntry({ path: made, unchanged: [{ path: made, modified, text }] });
    } catch (cause) {
      if (cause instanceof EntryChangedError) throw new BlockChangedError(made);
      throw cause;
    }
    // Safe to let go of, as deleting a note does: the refresh after every
    // change removes what is no longer on disk, so a failure only delays it.
    await forgetNotes(index, [scheduling.block]).catch(() => undefined);
    return;
  }
  const { block, task } = scheduling;
  await writeProperties({
    path: block,
    values: (properties) => {
      const tasks = blockTasksWithout({ tasks: properties[BLOCK_KEYS.tasks], task, notePaths });
      return tasks === null ? {} : { [BLOCK_KEYS.tasks]: tasks };
    },
  });
}
