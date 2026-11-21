import {
  archiveDestination,
  archiveRefusal,
  archiveStamp,
  ARCHIVED_FROM_KEY,
  isArchiveFolder,
  isBlankFrontmatter,
  joinVaultPath,
  parentVaultPath,
  restoreDestination,
  splitFrontmatter,
  unarchiveRefusal,
  unarchiveStamp,
  vaultPathName,
  VAULT_ROOT,
  type EntryMove,
  type Unstamp,
  type VaultPath,
} from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import { ensureFolder } from '../vault/create-folder.ts';
import { moveEntryTo, type Relocation, type RelocationPorts } from '../vault/relocate-entry.ts';
import {
  linksToUpdate,
  updateLinks,
  UnsavedTypingError,
  type LinkUpdateFailure,
  type LinkUpdatePanes,
} from '../vault/update-links.ts';

/** What archiving reaches: a move's ports, a way to write frontmatter, and panes that can re-read. */
export interface ArchivePorts extends RelocationPorts {
  readonly markdown: MarkdownPort;
  readonly editors: RelocationPorts['editors'] & Pick<LinkUpdatePanes, 'reload'>;
}

/** A note of the batch that did not move, or moved and was not fully updated, and why. */
export type ArchiveFailure = LinkUpdateFailure;

/** What a batch did: every note that moved, the ones that could not, and links rewritten. */
export interface ArchiveOutcome {
  readonly moves: readonly Relocation[];
  readonly failed: readonly ArchiveFailure[];
  /** Links rewritten along the way; only counted when the batch was asked to rewrite them. */
  readonly linksUpdated: number;
}

/**
 * What to do with typing a pane has not saved yet, in a note the batch would
 * move or write. `save` writes it first — the person asked, from the app, so
 * the change is made to what is on screen. `leave` never does: a request from
 * another tool must not save what someone is still typing (ADR-0016), so such
 * a note is left alone and reported as `unsavedInApp`.
 */
export type UnsavedTyping = 'save' | 'leave';

/** Notes to move together, and how. */
export interface NoteBatch {
  readonly ports: ArchivePorts;
  readonly paths: readonly VaultPath[];
  /** Every note in the vault before the batch, for naming clashes and finding links. */
  readonly notePaths: readonly VaultPath[];
  /**
   * Rewrite the links the moves leave behind, in one pass once every note has
   * moved. A single note is archived the way it is moved — with the links
   * offered afterwards — so this is for a batch, where one offer per note
   * would be no offer at all.
   */
  readonly updateLinks?: boolean;
  /** `save` unless said otherwise: the app's own commands are the person's. */
  readonly unsavedTyping?: UnsavedTyping;
}

/** Where one note of a batch goes, given what the vault holds by then. */
type Destination = (args: { path: VaultPath; taken: ReadonlySet<string> }) => Promise<VaultPath>;

/** A note's frontmatter as the stamp needs it; null when the note has no block. */
interface OwnFrontmatter {
  readonly properties: Readonly<Record<string, unknown>>;
  /** Each key's text as written. */
  readonly keyTexts: Readonly<Record<string, string>>;
}

/** What is written into a note's frontmatter where it lands, given what it held. */
export type Stamp = (own: OwnFrontmatter | null) => Unstamp;

/** Where a batch's notes go and what is written into each where it lands. */
export interface MoveRule {
  /** Why a note may not go, or null when it may. */
  readonly refusal: (path: VaultPath) => string | null;
  readonly destination: Destination;
  /** The stamp for a note that was at `from`. */
  readonly stamp: (from: VaultPath) => Stamp;
}

/**
 * Puts notes in the Archive, each at its own path under `Archive/`, stamped
 * with the day and where it was (U-22).
 *
 * The note moves first and is stamped where it lands, so a stamp that fails
 * leaves a note that is archived all the same — and unarchiving works out
 * where it came from by its path. The other way round would leave a note that
 * says it is archived and is not.
 */
export async function archiveNotes(batch: NoteBatch & { today: string }): Promise<ArchiveOutcome> {
  const archive = await archiveFolderOf(batch.ports);
  return moveAndStampNotes(batch, {
    refusal: archiveRefusal,
    destination: async ({ path, taken }) =>
      archiveDestination({ path, taken, ...(archive !== undefined && { archive }) }),
    stamp: (from) => (own) => ({
      changes: archiveStamp({ from, on: batch.today, own: own?.keyTexts ?? null }),
      keepsBlock: true,
    }),
  });
}

/**
 * Takes notes out of the Archive, back to where the Archive holds them minus
 * `Archive/`, numbered when something has taken that path since, and gives
 * back what the stamp covered.
 */
export async function unarchiveNotes(batch: NoteBatch): Promise<ArchiveOutcome> {
  return moveAndStampNotes(batch, unarchiveRule(batch));
}

/** Where unarchiving takes a batch's notes, and what it gives back in each. */
export function unarchiveRule(batch: NoteBatch): MoveRule {
  const editors = panesFor(batch);
  return {
    refusal: unarchiveRefusal,
    destination: async ({ path, taken }) => {
      // Where it goes back to is read from what is on screen, not a save behind it.
      if (editors.state(path) === 'dirty') await editors.flush([path]);
      const { text } = await batch.ports.fs.readTextFile(path);
      const recorded = batch.ports.markdown.frontmatterProperties(
        splitFrontmatter(text).frontmatter,
      )[ARCHIVED_FROM_KEY];
      return restoreDestination({ path, archivedFrom: recorded, taken });
    },
    stamp: () => (own) => unarchiveStamp(own?.properties ?? {}),
  };
}

/** The Archive folder as the disk spells it, when there is one yet. */
async function archiveFolderOf(ports: ArchivePorts): Promise<VaultPath | undefined> {
  const root = await ports.fs.listDirectory(VAULT_ROOT);
  return root.find(isArchiveFolder)?.path;
}

/** The panes as the batch may use them: ones whose `flush` saves nothing, when typing is left alone. */
export function panesFor(batch: NoteBatch): ArchivePorts['editors'] {
  const { editors } = batch.ports;
  if (batch.unsavedTyping !== 'leave') return editors;
  // Deliberately a no-op: each writer checks the pane is still dirty afterwards and leaves the note alone.
  return { ...editors, flush: () => Promise.resolve() };
}

export const UNSAVED_REASON = 'It is open in DFAI with unsaved typing, so it was left where it is.';

/**
 * One note after another, so each lands knowing where the ones before it
 * went. A note that cannot go is reported and the rest carry on. The links
 * are rewritten once, for every move together, after the last: the vault is
 * read once per batch, not once per note.
 */
export async function moveAndStampNotes(batch: NoteBatch, rule: MoveRule): Promise<ArchiveOutcome> {
  const ports = { ...batch.ports, editors: panesFor(batch) };
  const moves: Relocation[] = [];
  const failed: ArchiveFailure[] = [];
  let notePaths = [...batch.notePaths];

  for (const path of batch.paths) {
    const refusal = rule.refusal(path);
    if (refusal !== null) {
      failed.push({ path, reason: refusal });
      continue;
    }
    if (batch.unsavedTyping === 'leave' && ports.editors.state(path) === 'dirty') {
      failed.push({ path, reason: UNSAVED_REASON, unsavedInApp: true });
      continue;
    }
    try {
      const to = await rule.destination({ path, taken: new Set(notePaths) });
      const stamp = rule.stamp(path);
      const moved = await relocateAndStamp({
        ports,
        move: { from: path, to },
        stamp,
        notePaths,
        unsavedTyping: batch.unsavedTyping ?? 'save',
      });
      moves.push(moved.relocation);
      if (moved.stampProblem !== null) failed.push(moved.stampProblem);
      notePaths = [...notePaths.filter((each) => each !== path), moved.relocation.move.to];
    } catch (cause) {
      failed.push({ path, reason: reasonOf(cause) });
    }
  }
  if (batch.updateLinks !== true || moves.length === 0) return { moves, failed, linksUpdated: 0 };
  const links = await rewriteLinks({
    ports,
    moves: moves.map((relocation) => relocation.move),
    before: batch.notePaths,
  }).catch((cause: unknown) => ({
    count: 0,
    failed: moves.map(({ move }) => ({
      path: move.to,
      reason: `Moved, but its links were not updated: ${reasonOf(cause)}`,
    })),
  }));
  return { moves, failed: [...failed, ...links.failed], linksUpdated: links.count };
}

/** What stamping notes where they are did: the notes written, and the ones that could not be. */
export interface StampOutcome {
  readonly stamped: readonly VaultPath[];
  readonly failed: readonly ArchiveFailure[];
}

/**
 * Writes each note's frontmatter where it is, moving nothing — filing a
 * meeting under a project by its link alone (#214) — as a batch's stamp is
 * written where a note lands: the same unsaved-typing rule, the rest of the
 * file byte for byte. A note that cannot be written is reported and the rest
 * carry on.
 */
export async function stampNotes(
  batch: Pick<NoteBatch, 'ports' | 'paths' | 'unsavedTyping'>,
  rule: Pick<MoveRule, 'refusal'> & { readonly stamp: Stamp },
): Promise<StampOutcome> {
  const stamped: VaultPath[] = [];
  const failed: ArchiveFailure[] = [];
  const unsavedTyping = batch.unsavedTyping ?? 'save';
  for (const path of batch.paths) {
    const refusal = rule.refusal(path);
    if (refusal !== null) {
      failed.push({ path, reason: refusal });
      continue;
    }
    try {
      await rewriteFrontmatter({ ports: batch.ports, path, stamp: rule.stamp, unsavedTyping });
      stamped.push(path);
    } catch (cause) {
      failed.push(
        cause instanceof UnsavedTypingError
          ? { path, reason: UNSAVED_REASON, unsavedInApp: true }
          : { path, reason: reasonOf(cause) },
      );
    }
  }
  return { stamped, failed };
}

/**
 * Moves one note and writes its frontmatter where it landed. The folder it
 * lands in is named as the disk spells it, so the move reported — and the
 * panes that follow it — name the note where it really is.
 */
async function relocateAndStamp({
  ports,
  move,
  stamp,
  notePaths,
  unsavedTyping,
}: {
  ports: ArchivePorts;
  move: EntryMove;
  stamp: Stamp;
  notePaths: readonly VaultPath[];
  unsavedTyping: UnsavedTyping;
}): Promise<{ relocation: Relocation; stampProblem: ArchiveFailure | null }> {
  const folder = await ensureFolder({ fs: ports.fs, folder: parentVaultPath(move.to) });
  const landing = joinVaultPath(folder, vaultPathName(move.to));
  const relocation = await moveEntryTo({
    ports,
    entry: { path: move.from, kind: 'file' },
    to: landing,
    notePaths,
  });
  try {
    await rewriteFrontmatter({ ports, path: landing, stamp, unsavedTyping });
    return { relocation, stampProblem: null };
  } catch (cause) {
    const reason = `Moved, but its frontmatter was not updated: ${reasonOf(cause)}`;
    return {
      relocation,
      stampProblem:
        cause instanceof UnsavedTypingError
          ? { path: landing, reason, unsavedInApp: true }
          : { path: landing, reason },
    };
  }
}

/**
 * Changes a note's frontmatter, keeping the rest of the file byte for byte.
 *
 * Its pane's typing is written first, so the change is made to what is on
 * screen — unless the batch leaves typing alone, when a note being typed in
 * is not written at all. A pane without unsaved typing re-reads the note afterwards. A block
 * that cannot be read is left as it is, and said so. A block left with
 * nothing in it — no keys, no comments — is taken out, unless the stamp says
 * the note had that block of its own; so a note that had no frontmatter
 * before it was archived has none after it is unarchived.
 */
export async function rewriteFrontmatter({
  ports,
  path,
  stamp,
  unsavedTyping,
}: {
  ports: ArchivePorts;
  path: VaultPath;
  stamp: Stamp;
  unsavedTyping: UnsavedTyping;
}): Promise<void> {
  if (ports.editors.state(path) === 'dirty') {
    if (unsavedTyping === 'leave') throw new UnsavedTypingError(path);
    await ports.editors.flush([path]);
  }
  const { text, modified } = await ports.fs.readTextFile(path);
  const document = splitFrontmatter(text);
  const problem = ports.markdown.frontmatterProblem(document.frontmatter);
  if (problem !== null) throw new Error(`its frontmatter could not be read (${problem})`);
  const own =
    document.frontmatter === null
      ? null
      : {
          properties: ports.markdown.frontmatterProperties(document.frontmatter),
          keyTexts: ports.markdown.frontmatterKeyTexts(document.frontmatter),
        };
  const { changes, keepsBlock } = stamp(own);
  // Only keys to take away that are not there — a note with no block —
  // leaves the file untouched rather than rewritten.
  const nothingToDo = Object.entries(changes).every(
    ([key, value]) => value === null && (own === null || !Object.hasOwn(own.properties, key)),
  );
  if (nothingToDo) return;
  const frontmatter = ports.markdown.updateFrontmatter(document.frontmatter, changes);
  const dropped = !keepsBlock && isBlankFrontmatter(frontmatter);
  await ports.fs.writeTextFile({
    path,
    contents: dropped ? document.body : frontmatter + document.body,
    expectedModified: modified,
  });
  if (ports.editors.state(path) !== 'dirty') ports.editors.reload(path);
}

/** Rewrites every link the batch's moves left behind, in one pass: how many, and each note it could not. */
async function rewriteLinks({
  ports,
  moves,
  before,
}: {
  ports: ArchivePorts;
  moves: readonly EntryMove[];
  before: readonly VaultPath[];
}): Promise<{ count: number; failed: readonly ArchiveFailure[] }> {
  const update = await linksToUpdate({ fs: ports.fs, moves, notePaths: before });
  if (update.total === 0) return { count: 0, failed: [] };
  const report = await updateLinks({ fs: ports.fs, openNotes: ports.editors, update });
  const rewritten = new Set(report.updated);
  const count = update.notes
    .filter((note) => rewritten.has(note.path))
    .reduce((sum, note) => sum + note.count, 0);
  const failed = report.failed.map((failure) => ({
    ...failure,
    reason: `Its links to the notes that moved were not updated: ${failure.reason}`,
  }));
  return { count, failed };
}

const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
