import {
  NEW_NOTE_CONTENTS,
  newNoteFolder,
  nextAvailableNotePath,
  splitFrontmatter,
  type VaultPath,
} from '@dfai/domain';
import { ensureFolder } from '../vault/create-folder.ts';
import { listVaultNotes } from '../vault/read-vault.ts';
import type { AsRead, VaultFsPort } from '../vault/ports.ts';
import { guardTemplateEdit } from '../vault/template-guard.ts';
import { newNoteTaskRules } from '../gtd/task-rules.ts';
import { homeFolderFor } from './home-folder.ts';
import type { MarkdownPort } from './ports.ts';

/**
 * How many names are tried when each one is taken between listing and
 * creating. Each round of notes made at the same moment gives at least one
 * of them its name, so this is how many can be made at once — five "+ New"
 * from an agent, say — before one is refused. Bounded, since each try lists
 * the vault again.
 */
export const CREATE_ATTEMPTS = 20;

/** No free name was found: every one tried was taken before the note could be made. */
export class NoteNameTakenError extends Error {
  constructor(name: string, options: { cause: unknown }) {
    super(
      `No free name for ${JSON.stringify(name)}: ${CREATE_ATTEMPTS} were taken while it was being made`,
      options,
    );
    this.name = 'NoteNameTakenError';
  }
}

/** Where a new note goes and what it starts as. */
interface NewNote {
  fs: VaultFsPort;
  name: string;
  /** The note currently open, whose folder the new one joins. */
  beside: VaultPath | null;
  /** The folder to put it in, which wins over its type's home and `beside`. */
  folder?: VaultPath;
  /** The home folder of its type, for its day, which wins over `beside`; null when it has none. */
  home?: VaultPath | null;
  notePaths: readonly VaultPath[];
  /** Starting text, when the note comes from a template. */
  contents?: string;
  /** The frontmatter `contents` starts with, read as values. */
  properties?: Readonly<Record<string, unknown>>;
}

/**
 * Creates a note and reports where it landed.
 *
 * It goes into `folder` when one is named — "New note here" on a folder.
 * Otherwise `newNoteFolder` says: a dashboard or a view with its kind, a
 * note whose type has a home folder there, dated by its own day (#214),
 * anything else beside the note in view, or at the root. A name
 * already in use is numbered rather than refused, so the button always works —
 * including when another program takes the name after `notePaths` was listed:
 * the host refuses, the vault is listed again and the next number is tried.
 *
 * A note whatever its starting text says is made here, so the task rules
 * (ADR-0029) are held here: one made already in Archive is dated today, and
 * a new task Waiting with nobody to wait on is made as it is (#202).
 */
export async function createNote(note: RuledNewNote): Promise<VaultPath> {
  return (await createNoteAsWritten(note)).path;
}

type RuledNewNote = NewNote & {
  /** What a new note's frontmatter is read and dated through. */
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'updateFrontmatter'>;
  /** `YYYY-MM-DD`: the day a task made already finished is dated. */
  today: string;
};

/**
 * {@link createNote}, answering the note as it was written — the text after
 * the task rules, and the time the host reported for the create — for a
 * caller that will later hold the note to that version (#694).
 */
export async function createNoteAsWritten({
  markdown,
  today,
  contents,
  ...note
}: RuledNewNote): Promise<AsRead> {
  const properties = note.properties ?? startingProperties(markdown, contents);
  const home =
    note.folder === undefined
      ? await homeFolderFor({ fs: note.fs, markdown, properties, today })
      : null;
  return createNoteFileAsWritten({
    ...note,
    properties,
    home,
    ...(contents === undefined
      ? {}
      : { contents: newNoteTaskRules({ markdown, contents, today }) }),
  });
}

/** The frontmatter a note's starting text holds, read as values: none for a blank note. */
function startingProperties(
  markdown: Pick<MarkdownPort, 'frontmatterProperties'>,
  contents: string | undefined,
): Readonly<Record<string, unknown>> {
  if (contents === undefined) return {};
  return markdown.frontmatterProperties(splitFrontmatter(contents).frontmatter);
}

/**
 * {@link createNote} without the task rules: for a note whose text DFAI
 * writes whole and which is never a task — a chat's transcript.
 */
export async function createNoteFile(note: NewNote): Promise<VaultPath> {
  return (await createNoteFileAsWritten(note)).path;
}

/** {@link createNoteFile}, answering the note as it was written. */
async function createNoteFileAsWritten({
  fs,
  name,
  beside,
  folder: named,
  home = null,
  notePaths,
  contents,
  properties = {},
}: NewNote): Promise<AsRead> {
  const chosen = named ?? newNoteFolder({ beside, properties, home });
  // A home folder is made when it is not there yet, and named as the disk spells it.
  const folder =
    named === undefined && chosen === home ? await ensureFolder({ fs, folder: chosen }) : chosen;
  let taken: readonly VaultPath[] = notePaths;

  for (let attempt = 1; ; attempt += 1) {
    const path = nextAvailableNotePath({ folder, name, taken: new Set<string>(taken) });
    guardTemplateEdit([path]);
    try {
      const text = contents ?? NEW_NOTE_CONTENTS;
      const modified = await fs.createNote({ path, contents: text });
      return { path, text, modified };
    } catch (error) {
      taken = await listVaultNotes({ fs });
      // Refused for some reason other than the name being taken: trying again is pointless.
      if (nextAvailableNotePath({ folder, name, taken: new Set<string>(taken) }) === path) {
        throw error;
      }
      if (attempt === CREATE_ATTEMPTS) throw new NoteNameTakenError(name, { cause: error });
    }
  }
}
