import {
  anchorsIn,
  blockOutline,
  joinFrontmatter,
  locateFragment,
  newBlockId,
  noteLabelForNotice,
  parentVaultPath,
  splitFrontmatter,
  VAULT_ROOT,
  withAnchorAt,
  type NodePath,
  type OutlineEntry,
  type VaultPath,
} from '@dfai/domain';
import type { Rng } from '../ports.ts';
import type { IndexPort } from '../index/ports.ts';
import { modifiedTimes } from '../index/modified-times.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { OpenEditorsPort, VaultFsPort } from '../vault/ports.ts';
import { UnsavedTypingError } from '../vault/update-links.ts';

/** The panes, as a write to a note they may hold needs them. */
export type BlockLinkPanes = Pick<OpenEditorsPort, 'state'> & {
  /** Re-reads the note in every pane that holds it and has no unsaved edits. */
  reload(path: VaultPath): void;
};

/** A note's headings and blocks for the `#` picker, kept while its file is the same version. */
export interface BlockChoicesReader {
  /** Null when there is no note there to read: deleted, say, before the tree caught up. */
  read(path: VaultPath): Promise<OutlineEntry[] | null>;
}

/**
 * A note's headings and blocks, as the `#` after a page's name offers them
 * (P26-02): read from its file, as the editor reads it. They are asked for on
 * every key typed after the `#`, so each note is read and parsed once for
 * each version of its file (A26-01), as the index tells the version
 * (`modifiedTimes`). A note the index does not know is read every time — the
 * index only spares reads, it never decides one — and parsed again only when
 * its file has changed.
 */
export function createBlockChoicesReader({
  fs,
  markdown,
  index,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  index: IndexPort;
}): BlockChoicesReader {
  const kept = new Map<string, { modified: number; entries: OutlineEntry[] }>();
  return {
    async read(path) {
      const known = (await modifiedTimes(index)).get(path);
      const held = kept.get(path);
      if (held !== undefined && known === held.modified) return held.entries;
      const file = await readIfThere(fs, path);
      if (file === null) {
        kept.delete(path);
        return null;
      }
      if (held !== undefined && file.modified === held.modified) return held.entries;
      const entries = blockOutline(markdown.parseBody(splitFrontmatter(file.text).body).doc);
      kept.set(path, { modified: file.modified, entries });
      return entries;
    },
  };
}

/**
 * A note's text, or null when there is no note there to read. The host words
 * a missing file as it words any failure, so its folder is asked: a file the
 * folder lists — one too large, not text, not readable — is there, and the
 * failure to read it is passed on.
 */
async function readIfThere(fs: VaultFsPort, path: VaultPath) {
  try {
    return await fs.readTextFile(path);
  } catch (cause) {
    // The read's own failure is the one to show: one in asking the folder only means it may be there.
    if (await isThere(fs, path).catch(() => true)) throw cause;
    return null;
  }
}

/** Whether the folder a path is in lists it; a folder no longer there lists nothing. */
async function isThere(fs: VaultFsPort, path: VaultPath): Promise<boolean> {
  if (path === VAULT_ROOT) return true;
  const folder = parentVaultPath(path);
  try {
    return (await fs.listDirectory(folder)).some((entry) => entry.path === path);
  } catch (cause) {
    if (await isThere(fs, folder)) throw cause;
    return false;
  }
}

/** The block a link was about to name is not where, or what, it was when it was offered. */
export class BlockMovedError extends Error {
  constructor(path: VaultPath) {
    // Shown on its own, so the note is named — as a chat note, when it is one, never by the question.
    super(
      `${noteLabelForNotice(path)} changed while its blocks were being offered. Pick the block again.`,
    );
    this.name = 'BlockMovedError';
  }
}

/**
 * The id of the block at `at` in the note at `path`, given one first if it
 * has none (P26-01): the id is written at the end of the block and nothing
 * else in the file changes, through the same byte-preserving save as any
 * edit, and against the version of the file just read.
 *
 * A note a pane holds unsaved typing in is not written behind that pane's
 * back: the write is refused (`UnsavedTypingError`), and the person can save
 * it and pick the block again. A note that no longer has that block where it
 * was offered — `text` is what the offer showed — is refused too
 * (`BlockMovedError`). A pane holding the note with nothing unsaved reads it
 * again once the id is written.
 */
export async function anchorBlock({
  fs,
  markdown,
  openNotes,
  rng,
  path,
  at,
  text,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  openNotes: BlockLinkPanes;
  rng: Rng;
  path: VaultPath;
  at: NodePath;
  text: string;
}): Promise<string> {
  if (openNotes.state(path) === 'dirty') throw new UnsavedTypingError(path);
  const file = await fs.readTextFile(path);
  const { frontmatter, body } = splitFrontmatter(file.text);
  const parsed = markdown.parseBody(body);
  const offered = blockOutline(parsed.doc).find(
    (entry) => entry.kind === 'block' && samePath(entry.at, at),
  );
  if (offered?.kind !== 'block' || offered.text !== text) {
    throw new BlockMovedError(path);
  }
  // An id another block before it also holds names that one, not this: this
  // block is given one of its own (a pasted copy is how two come to share one).
  const owned =
    offered.id !== null &&
    samePath(locateFragment(parsed.doc, { kind: 'block', id: offered.id }) ?? [], at);
  if (owned && offered.id !== null) return offered.id;
  const id = newBlockId(() => rng.next(), anchorsIn(parsed.doc));
  const doc = withAnchorAt(parsed.doc, at, id);
  const contents = joinFrontmatter(
    frontmatter,
    markdown.serializeBody({ originalBody: body, parsed, doc }),
  );
  // Typing may have begun in a pane while the note was read.
  if (openNotes.state(path) === 'dirty') throw new UnsavedTypingError(path);
  await fs.writeTextFile({ path, contents, expectedModified: file.modified });
  if (openNotes.state(path) === 'clean') openNotes.reload(path);
  return id;
}

const samePath = (left: NodePath, right: NodePath): boolean =>
  left.length === right.length && left.every((step, index) => step === right[index]);
