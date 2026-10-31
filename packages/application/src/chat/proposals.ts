import {
  applyTextEdits,
  appendToBody,
  blockIdOf,
  chatWriteRefusal,
  cleanEntryName,
  createVaultPath,
  diffBlocks,
  foldUnchanged,
  joinFrontmatter,
  newNoteFolder,
  nextAvailableNotePath,
  noteTitle,
  taskRuleChanges,
  type BlockChange,
  type EditorDocument,
  type EditorNode,
  type ParsedBody,
  type TextEdit,
  type VaultPath,
} from '@dfai/domain';
import type { OpenNotes } from '../api/index.ts';
import { taskRuleProperties } from '../gtd/task-rules.ts';
import { FrontmatterRefusedError } from '../notes/frontmatter-refused-error.ts';
import { NoteChangedError } from '../notes/note-changed-error.ts';
import { noteModified } from '../notes/note-modified.ts';
import { openNote } from '../notes/open-note.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { EntryChangedError, type VaultFsPort } from '../vault/ports.ts';

/**
 * Changes the model proposes (P27-04). Nothing here writes until the person
 * accepts. A proposal carries the whole text Accept writes and the path it
 * writes it to, and the card is drawn from that text: what the person saw is
 * what lands, byte for byte, and every byte the change did not touch is kept
 * (ADR-0003, ADR-0021).
 */

/** One block of a proposal's diff, drawn as the note draws it. */
export type ProposalBlock =
  | { readonly kind: 'same' | 'added' | 'removed'; readonly doc: EditorDocument }
  | { readonly kind: 'folded'; readonly count: number };

export interface PropertyChange {
  readonly key: string;
  readonly before: unknown;
  /** Null when the change removes the property. */
  readonly after: unknown;
}

export interface EditProposal {
  readonly kind: 'edit';
  readonly id: string;
  readonly path: VaultPath;
  readonly title: string;
  /** The note's modified time when proposed: accepting after it changed is refused. */
  readonly baseModified: number;
  readonly afterBody: string;
  /** The whole file Accept writes: the frontmatter, changed by `properties`, then `afterBody`. */
  readonly contents: string;
  readonly properties: Readonly<Record<string, unknown>> | null;
  readonly blocks: readonly ProposalBlock[];
  readonly propertyChanges: readonly PropertyChange[];
}

export interface NoteProposal {
  readonly kind: 'note';
  readonly id: string;
  readonly title: string;
  /** Where Accept creates it, worked out and checked before the card is shown. */
  readonly path: VaultPath;
  readonly contents: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly blocks: readonly ProposalBlock[];
  readonly propertyChanges: readonly PropertyChange[];
}

export type Proposal = EditProposal | NoteProposal;

/** What accepting did, kept so it can be undone in one step. */
export type AppliedProposal =
  | {
      readonly kind: 'edited';
      readonly path: VaultPath;
      readonly previous: string;
      readonly modified: number;
    }
  | { readonly kind: 'created'; readonly path: VaultPath; readonly modified: number };

/**
 * The properties a proposal writes, held to the task rules against the note
 * as it is (ADR-0029): one the rules refuse is not proposed, and says why;
 * one that finishes a task is dated.
 */
function ruledProperties(
  before: Readonly<Record<string, unknown>>,
  asked: Readonly<Record<string, unknown>>,
  today: string,
): Record<string, unknown> {
  const outcome = taskRuleChanges({ before, changes: asked, today });
  if ('refused' in outcome) throw new ProposalRefused(outcome.refused);
  return { ...outcome.changes };
}

/** Why a proposal could not be made, accepted or undone, in words for the person or the model. */
export class ProposalRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalRefused';
  }
}

type Input = Readonly<Record<string, unknown>>;

/** Checks a `propose_edit` call against the note as it is, and describes the change. */
export async function proposeEdit({
  fs,
  markdown,
  input,
  id,
  today,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  input: Input;
  id: string;
  /** `YYYY-MM-DD`: a task the edit finishes is dated by it (ADR-0029). */
  today: string;
}): Promise<EditProposal> {
  const path = writablePath(input['path']);
  const edits = textEdits(input['edits']);
  const append = optionalString(input['append'], 'append');
  const asked = propertyValues(input['properties']);
  if (edits.length === 0 && append === null && asked === null) {
    throw new ProposalRefused('A proposed edit needs "edits", "append" or "properties".');
  }

  const note = await readForEdit({ fs, markdown, path });
  // Ruled against the block as the write reads it, not as shown: Accept writes
  // exactly the contents built here.
  const properties =
    asked === null
      ? null
      : toldAsRefusal(() =>
          ruledProperties(taskRuleProperties(markdown, note.frontmatter), asked, today),
        );
  const edited = applyTextEdits(note.originalBody, edits);
  if (!edited.ok) throw new ProposalRefused(edited.problem);
  const afterBody = append === null ? edited.text : appendToBody(edited.text, append);
  if (afterBody === note.originalBody && properties === null) {
    throw new ProposalRefused('That edit changes nothing.');
  }
  return {
    kind: 'edit',
    id,
    path,
    title: noteTitle(path),
    baseModified: note.modified,
    afterBody,
    contents: joinFrontmatter(
      properties === null
        ? note.frontmatter
        : toldAsRefusal(() => markdown.updateFrontmatter(note.frontmatter, properties)),
      afterBody,
    ),
    properties,
    blocks: shownBlocks(blockDiff(note.parsed, markdown.parseBody(afterBody))),
    propertyChanges: changesOf(note.properties, properties ?? {}),
  };
}

/**
 * A block the edit cannot be written to, refused as a proposal is: the model
 * is told why, in the person's words, and the chat goes on.
 */
function toldAsRefusal<Result>(work: () => Result): Result {
  try {
    return work();
  } catch (error) {
    if (error instanceof FrontmatterRefusedError) throw new ProposalRefused(error.message);
    throw error;
  }
}

/**
 * Checks a `propose_note` call and describes the note it would make, at the
 * path it would land: the folder named, or the one its kind files it in
 * (a view or a dashboard goes under `.atlas/`, which is refused), numbered
 * past the notes already there.
 */
export function proposeNote({
  markdown,
  input,
  id,
  notePaths,
  today,
}: {
  markdown: MarkdownPort;
  input: Input;
  id: string;
  notePaths: readonly VaultPath[];
  /** `YYYY-MM-DD`: a task proposed already finished is dated by it (ADR-0029). */
  today: string;
}): NoteProposal {
  const title = cleanEntryName(typeof input['title'] === 'string' ? input['title'] : '');
  if (title === '') throw new ProposalRefused('A new note needs a "title".');
  const named = optionalString(input['folder'], 'folder');
  const body = optionalString(input['body'], 'body') ?? '';
  const properties = ruledProperties({}, propertyValues(input['properties']) ?? {}, today);
  const folder =
    named === null ? newNoteFolder({ beside: null, properties }) : checkedFolder(named, title);
  const path = nextAvailableNotePath({ folder, name: title, taken: new Set<string>(notePaths) });
  const refusal = chatWriteRefusal(path);
  if (refusal !== null) throw new ProposalRefused(refusal);
  const frontmatter =
    Object.keys(properties).length === 0 ? null : markdown.updateFrontmatter(null, properties);
  const empty: ParsedBody = { blocks: [], doc: { type: 'doc', content: [] } };
  return {
    kind: 'note',
    id,
    title,
    path,
    contents: joinFrontmatter(frontmatter, body),
    properties,
    blocks: shownBlocks(blockDiff(empty, markdown.parseBody(body))),
    propertyChanges: changesOf({}, properties),
  };
}

/**
 * Writes an accepted proposal: exactly its `contents`, at exactly its path.
 * An edit is refused if the note changed since the proposal or a pane holds
 * unsaved typing for it — typing is never written over.
 */
export async function acceptProposal({
  fs,
  openNotes,
  proposal,
}: {
  fs: VaultFsPort;
  openNotes: Pick<OpenNotes, 'state' | 'reload'>;
  proposal: Proposal;
}): Promise<AppliedProposal> {
  if (proposal.kind === 'note') return createProposed({ fs, proposal });

  const { path } = proposal;
  const pane = refuseUnsaved(openNotes, path);
  const previous = await readPrevious({ fs, path });
  if (previous.modified !== proposal.baseModified) throw changedSince(path);
  const modified = await guarded({ fs, path, expected: previous.modified }, () =>
    fs.writeTextFile({ path, contents: proposal.contents, expectedModified: previous.modified }),
  );
  if (pane === 'clean') openNotes.reload(path);
  return { kind: 'edited', path, previous: previous.text, modified };
}

/**
 * Creates the proposed note at the one path its card named. Taken since, it
 * is refused rather than numbered: a different path is not what was accepted.
 */
async function createProposed({
  fs,
  proposal,
}: {
  fs: VaultFsPort;
  proposal: NoteProposal;
}): Promise<AppliedProposal> {
  const { path } = proposal;
  if ((await noteModified({ fs, path })) !== null) throw takenSince(path);
  try {
    await fs.createNote({ path, contents: proposal.contents });
  } catch (error) {
    if ((await noteModified({ fs, path })) !== null) throw takenSince(path);
    throw error;
  }
  return { kind: 'created', path, modified: (await noteModified({ fs, path })) ?? 0 };
}

async function readPrevious({ fs, path }: { fs: VaultFsPort; path: VaultPath }) {
  try {
    return await fs.readTextFile(path);
  } catch {
    // Gone since it was proposed; any read failure means the same to the person.
    throw changedSince(path);
  }
}

function takenSince(path: VaultPath): ProposalRefused {
  return new ProposalRefused(`${path} was made since this was proposed; nothing was written.`);
}

function checkedFolder(folder: string, title: string): VaultPath {
  const refusal = chatWriteRefusal(`${folder}/${title}.md`);
  if (refusal !== null) throw new ProposalRefused(refusal);
  return createVaultPath(folder);
}

/**
 * Whether `applied` can be put back now, without putting anything back:
 * throws what {@link undoProposal} would. For an undo of several writes that
 * must all happen or none.
 */
export async function checkUndo({
  fs,
  openNotes,
  applied,
}: {
  fs: VaultFsPort;
  openNotes: Pick<OpenNotes, 'state'>;
  applied: AppliedProposal;
}): Promise<void> {
  const { path } = applied;
  refuseUnsaved(openNotes, path);
  if ((await noteModified({ fs, path })) !== applied.modified) throw changedSince(path);
}

/** Puts back what an accepted proposal replaced, if nothing has written the note since. */
export async function undoProposal({
  fs,
  openNotes,
  applied,
}: {
  fs: VaultFsPort;
  openNotes: Pick<OpenNotes, 'state' | 'reload'>;
  applied: AppliedProposal;
}): Promise<void> {
  const { path } = applied;
  const pane = refuseUnsaved(openNotes, path);
  if (applied.kind === 'created') {
    await trashAsCreated({ fs, path, expected: applied.modified });
    return;
  }
  await guarded({ fs, path, expected: applied.modified }, () =>
    fs.writeTextFile({ path, contents: applied.previous, expectedModified: applied.modified }),
  );
  if (pane === 'clean') openNotes.reload(path);
}

function refuseUnsaved(openNotes: Pick<OpenNotes, 'state'>, path: VaultPath) {
  const pane = openNotes.state(path);
  if (pane === 'dirty') {
    throw new ProposalRefused(
      `${noteTitle(path)} has unsaved typing; save it first, so nothing you typed is written over.`,
    );
  }
  return pane;
}

/**
 * Runs a write checked against the note at `expected`, and says so when it was
 * refused because the note moved on — however the host worded the refusal.
 */
async function guarded<T>(
  { fs, path, expected }: { fs: VaultFsPort; path: VaultPath; expected: number },
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof NoteChangedError) throw changedSince(path);
    if ((await noteModified({ fs, path })) !== expected) throw changedSince(path);
    throw error;
  }
}

/**
 * Trashes a created note held to the version checked here, so an edit that
 * lands between the check and the Trash keeps the note (#693).
 */
async function trashAsCreated({
  fs,
  path,
  expected,
}: {
  fs: VaultFsPort;
  path: VaultPath;
  expected: number;
}): Promise<void> {
  const { text, modified } = await readPrevious({ fs, path });
  if (modified !== expected) throw changedSince(path);
  try {
    await fs.trashEntry({ path, unchanged: [{ path, modified, text }] });
  } catch (error) {
    if (error instanceof EntryChangedError) throw changedSince(path);
    throw error;
  }
}

function changedSince(path: VaultPath): ProposalRefused {
  return new ProposalRefused(
    `${noteTitle(path)} changed since this was proposed; nothing was written.`,
  );
}

async function readForEdit({
  fs,
  markdown,
  path,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  path: VaultPath;
}) {
  try {
    return await openNote({ fs, markdown, path });
  } catch {
    // Whatever the host said, the answer for the model is the same: there is
    // no note to change there, and it can search for the right path.
    throw new ProposalRefused(`There is no note at ${JSON.stringify(path)}.`);
  }
}

function writablePath(value: unknown): VaultPath {
  const path = typeof value === 'string' ? value : '';
  const refusal = chatWriteRefusal(path);
  if (refusal !== null) throw new ProposalRefused(refusal);
  return createVaultPath(path);
}

function textEdits(value: unknown): TextEdit[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw new ProposalRefused('"edits" must be a list of { find, replace }.');
  return value.map((edit: unknown) => {
    const { find, replace } = (edit ?? {}) as Record<string, unknown>;
    if (typeof find !== 'string' || typeof replace !== 'string') {
      throw new ProposalRefused('Each edit must be { "find": "...", "replace": "..." }.');
    }
    return { find, replace };
  });
}

function optionalString(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ProposalRefused(`"${name}" must be text.`);
  return value;
}

function propertyValues(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ProposalRefused('"properties" must be an object of key and value.');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([key]) => key.trim() === ''))
    throw new ProposalRefused('A property needs a key.');
  return entries.length === 0 ? null : Object.fromEntries(entries);
}

function changesOf(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): PropertyChange[] {
  return Object.entries(after).map(([key, value]) => ({
    key,
    before: before[key] ?? null,
    after: value,
  }));
}

interface ShownBlock {
  readonly key: string;
  readonly node: EditorNode;
}

/** Each top-level block with the node the editor draws it as. */
function blocksOf(parsed: ParsedBody): ShownBlock[] {
  const nodes = new Map(parsed.doc.content.map((node) => [blockIdOf(node), node]));
  return parsed.blocks.map((block) => ({
    key: block.source.trim(),
    node: nodes.get(block.id) ?? {
      type: 'paragraph',
      content: [{ type: 'text', text: block.source }],
    },
  }));
}

function blockDiff(before: ParsedBody, after: ParsedBody): BlockChange<ShownBlock>[] {
  return diffBlocks({
    before: blocksOf(before),
    after: blocksOf(after),
    keyOf: (block) => block.key,
  });
}

function shownBlocks(changes: readonly BlockChange<ShownBlock>[]): ProposalBlock[] {
  return foldUnchanged(changes).map((change) => {
    if (change.kind === 'folded') return change;
    const node = change.kind === 'added' ? change.after.node : change.before.node;
    return { kind: change.kind, doc: { type: 'doc', content: [node] } };
  });
}
