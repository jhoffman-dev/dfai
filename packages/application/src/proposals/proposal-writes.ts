import {
  digestOf,
  FINISHED_TASK_STATUS,
  isTaskNote,
  joinFrontmatter,
  joinVaultPath,
  messageOf,
  noteTitle,
  parentVaultPath,
  PROPOSAL_NOTE_TYPES,
  splitFrontmatter,
  TASK_KEYS,
  vaultPathName,
  type LinkFrom,
  type LinkTarget,
  type MarkdownDocument,
  type NoteProposalKind,
  type NotePayload,
  type ProposalWrite,
  type VaultPath,
} from '@dfai/domain';
import {
  checkUndo,
  ProposalRefused,
  undoProposal,
  type AppliedProposal,
} from '../chat/proposals.ts';
import { newNoteTaskRules, taskRuleProperties, withTaskRules } from '../gtd/task-rules.ts';
import { archiveTaskChange } from '../review/review-actions.ts';
import { NoteChangedError } from '../notes/note-changed-error.ts';
import { homeFolderFor } from '../notes/home-folder.ts';
import { noteModified } from '../notes/note-modified.ts';
import { loadObjectTypes } from '../types/load-types.ts';
import { ensureFolder } from '../vault/create-folder.ts';
import { VaultAccessError } from '../vault/ports.ts';
import { refuseUnsaved, type ProposalPorts } from './proposal-file.ts';

/**
 * What writing a proposal's notes reaches: the vault, the markdown port and
 * the panes. Accept writes through these, and so does making a task from a
 * meeting's action item (#177).
 */
export type NoteWritePorts = Pick<ProposalPorts, 'fs' | 'markdown' | 'editors'>;

/**
 * The home folder, for its day, of the note a proposal of `kind` makes
 * (#214): where a task or a decision goes when its payload names no folder.
 */
export function proposalHomeFolder(
  { fs, markdown }: Pick<NoteWritePorts, 'fs' | 'markdown'>,
  { kind, payload, today }: { kind: NoteProposalKind; payload: NotePayload; today: string },
): Promise<VaultPath | null> {
  const properties = { ...payload.properties, type: PROPOSAL_NOTE_TYPES[kind] };
  return homeFolderFor({ fs, markdown, properties, today });
}

/** A link proposal's note, as read to check it and write it. */
export interface LinkNote {
  readonly target: LinkTarget;
  readonly document: MarkdownDocument;
  readonly text: string;
  readonly modified: number;
}

/** The note a proposal links through, as it is now; null when it is not there. */
export async function readLinkNote(
  ports: NoteWritePorts,
  payload: Pick<LinkFrom, 'note' | 'property'>,
): Promise<LinkNote | null> {
  refuseUnsaved(ports.editors, payload.note);
  const read = await ports.fs.readTextFile(payload.note).catch((error: unknown) => {
    // Not there is an answer — the proposal is refused saying so; anything else is a fault.
    if (error instanceof VaultAccessError) return null;
    throw error;
  });
  if (read === null) return null;
  const document = splitFrontmatter(read.text);
  // As the write reads it: a block listing a key twice is otherwise read as nothing.
  const properties = ports.markdown.frontmatterProperties(document.frontmatter, {
    forWriting: true,
  });
  const types = await loadObjectTypes({ fs: ports.fs, markdown: ports.markdown });
  const type = typeNamed(types, properties['type']);
  const relation = type?.properties.find(
    (property) => property.key === payload.property && property.kind === 'relation',
  );
  return {
    target: {
      digest: digestOf(read.text),
      value: properties[payload.property],
      relation: relation === undefined ? null : { many: relation.many },
    },
    document,
    text: read.text,
    modified: read.modified,
  };
}

/** A note's type among the vault's, its name matched in any case and spacing as type files are. */
function typeNamed<Type extends { readonly name: string }>(
  types: readonly Type[],
  name: unknown,
): Type | undefined {
  if (typeof name !== 'string') return undefined;
  const folded = name.trim().toLowerCase();
  return types.find((candidate) => candidate.name.trim().toLowerCase() === folded);
}

/** A proposal's write once held to the task rules: a new note carries the text it will have. */
export type RuledWrite =
  | (Extract<ProposalWrite, { kind: 'create' }> & { readonly contents: string })
  | Extract<ProposalWrite, { kind: 'set' }>;

/**
 * One of the proposal's writes as the task rules have it, worked out before
 * anything is written so a refusal leaves the vault as it was: a new note's
 * text judged as a new note's is, a link's change judged against the note it
 * changes.
 */
export function heldToTaskRules(
  ports: NoteWritePorts,
  { write, link, today }: { write: ProposalWrite; link: LinkNote | null; today: string },
): RuledWrite {
  if (write.kind === 'create') {
    const text = joinFrontmatter(
      ports.markdown.updateFrontmatter(null, finishedAsTicked(write.properties)),
      write.body,
    );
    return {
      ...write,
      contents: newNoteTaskRules({ markdown: ports.markdown, contents: text, today }),
    };
  }
  if (link === null) return write;
  const properties = taskRuleProperties(ports.markdown, link.document.frontmatter);
  return { ...write, changes: withTaskRules({ values: write.changes, today })(properties) };
}

/**
 * A task proposed already finished, as ticking it done would leave it: a
 * repeating one rolls on to its next date and back to Next Action, rather
 * than being made as the end of its series.
 */
function finishedAsTicked(
  properties: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!isTaskNote(properties) || properties[TASK_KEYS.status] !== FINISHED_TASK_STATUS) {
    return properties;
  }
  const change = archiveTaskChange();
  return { ...properties, ...(typeof change === 'function' ? change(properties) : change) };
}

/**
 * Makes the writes, in order. One that fails after another was made takes
 * back what was written, so a note is never left half made: a person made but
 * their meeting not linked, say.
 */
export async function carryOut(
  ports: NoteWritePorts,
  {
    writes,
    link,
    headline,
  }: { writes: readonly RuledWrite[]; link: LinkNote | null; headline: string },
): Promise<AppliedProposal[]> {
  const wrote: AppliedProposal[] = [];
  try {
    for (const write of writes) {
      wrote.push(
        write.kind === 'create'
          ? await createNote(ports, write)
          : await setOnNote(ports, write, link),
      );
    }
  } catch (cause) {
    // A person made but their meeting not linked is half an accept: what was written is taken back.
    if (wrote.length > 0) throw await takenBack(ports, { wrote, headline, cause });
    throw cause;
  }
  return wrote;
}

async function createNote(
  ports: NoteWritePorts,
  { path: proposed, contents }: Extract<RuledWrite, { kind: 'create' }>,
): Promise<AppliedProposal> {
  const folder = await ensureFolder({ fs: ports.fs, folder: parentVaultPath(proposed) });
  const path = joinVaultPath(folder, vaultPathName(proposed));
  let modified: number;
  try {
    modified = await ports.fs.createNote({ path, contents });
  } catch (error) {
    // Made in the moment between the check and the write — by another accept, say.
    if ((await noteModified({ fs: ports.fs, path })) !== null) {
      throw new ProposalRefused(`${path} was made just now; nothing was written.`);
    }
    throw error;
  }
  // The time the create reports, not one read after it: a read could take in an edit made since.
  return { kind: 'created', path, modified, text: contents };
}

async function setOnNote(
  ports: NoteWritePorts,
  write: Extract<ProposalWrite, { kind: 'set' }>,
  link: LinkNote | null,
): Promise<AppliedProposal> {
  // applyProposal only sets on a note it was handed, so `link` is that note.
  if (link === null) throw new ProposalRefused(`${write.path} is not there any more.`);
  const { path } = write;
  const text =
    ports.markdown.updateFrontmatter(link.document.frontmatter, write.changes) + link.document.body;
  let modified: number;
  try {
    modified = await ports.fs.writeTextFile({
      path,
      contents: text,
      expectedModified: link.modified,
    });
  } catch (error) {
    const changed =
      error instanceof NoteChangedError ||
      (await noteModified({ fs: ports.fs, path })) !== link.modified;
    if (changed) throw new ProposalRefused(`${path} changed just now; nothing was written.`);
    throw error;
  }
  ports.editors.reload(path);
  return { kind: 'edited', path, previous: link.text, modified, text };
}

/**
 * The refusal for an accept whose proposal could not be marked accepted after
 * its notes were written: they are taken back, so an open proposal never sits
 * beside what accepting it made — or, when they cannot be, the refusal says so.
 */
export async function takenBack(
  ports: NoteWritePorts,
  {
    wrote,
    headline,
    cause,
  }: { wrote: readonly AppliedProposal[]; headline: string; cause: unknown },
): Promise<Error> {
  const reason = messageOf(cause);
  try {
    for (const applied of wrote) {
      await undoProposal({ fs: ports.fs, openNotes: ports.editors, applied });
    }
  } catch (undoing) {
    return new ProposalRefused(
      `“${headline}” was written, but the proposal could not be marked accepted (${reason}), and taking it back failed: ${messageOf(undoing)}`,
    );
  }
  return new ProposalRefused(`${reason} Nothing was kept.`);
}

/**
 * Takes back what was written, all of it or none: every write is checked
 * before the first is taken back, so a meeting never lists a task that was
 * trashed, nor a task stays after the meeting kept its link.
 *
 * The notes made go to the Trash first, and only then are the notes linking
 * them put back: one the Trash will not take leaves its links as they were,
 * and the refusal says so.
 */
export async function takeBackAll(
  ports: NoteWritePorts,
  wrote: readonly AppliedProposal[],
): Promise<void> {
  for (const applied of wrote) {
    await checkUndo({ fs: ports.fs, openNotes: ports.editors, applied });
  }
  for (const applied of wrote.filter(({ kind }) => kind === 'created')) {
    await undoProposal({ fs: ports.fs, openNotes: ports.editors, applied }).catch(
      (cause: unknown) => {
        throw new ProposalRefused(
          `“${noteTitle(applied.path)}” could not be taken back (${messageOf(cause)}), so it and the notes linking it were left as they were.`,
        );
      },
    );
  }
  for (const applied of wrote.filter(({ kind }) => kind !== 'created').reverse()) {
    await undoProposal({ fs: ports.fs, openNotes: ports.editors, applied });
  }
}
