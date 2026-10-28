import {
  isEmbeddableNote,
  lineBreakOf,
  noteTitle,
  splitFrontmatter,
  wikiLinkTargetFor,
  withRelatedLink,
  type VaultPath,
} from '@dfai/domain';
import type { IndexPort } from '../index/ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { guardTemplateEdit } from '../vault/template-guard.ts';

/** The note asked to be linked could never be related: the note itself, or a template. */
export class NotRelatableError extends Error {
  constructor(target: VaultPath) {
    super(`${noteTitle(target)} cannot be linked as a related note.`);
    this.name = 'NotRelatableError';
  }
}

/** The note to link is no longer in the vault — deleted or renamed since it was offered. */
export class RelatedNoteGoneError extends Error {
  constructor(target: VaultPath) {
    super(`${noteTitle(target)} is no longer in the vault, so it was not linked.`);
    this.name = 'RelatedNoteGoneError';
  }
}

/**
 * Accepts a related note: a real `[[link]]` to `target` is written into
 * `note`, under its Related section at the end (`withRelatedLink`). Only the
 * new line's bytes are added — the frontmatter and every block stay as they
 * were (ADR-0003) — and the file is written against the modification time it
 * was read at, so an edit made in between is never overwritten. The link
 * names the note by its bare name when that opens it, else by its path.
 *
 * The caller has the note's editor saved first and reloads it after. False
 * when the section already links `target`: nothing is written twice.
 */
export async function acceptRelatedNote({
  fs,
  index,
  note,
  target,
}: {
  fs: Pick<VaultFsPort, 'readTextFile' | 'writeTextFile'>;
  index: Pick<IndexPort, 'manifest'>;
  note: VaultPath;
  target: VaultPath;
}): Promise<boolean> {
  // A template is edited on its own, never written into from a suggestion (ADR-0026).
  guardTemplateEdit([note]);
  // Never the note itself, nor what no link opens — a template, DFAI's own files.
  // A note in the Archive is never offered, but a link to one is still a link.
  if (target === note || !isEmbeddableNote(target)) throw new NotRelatableError(target);
  const notes = (await index.manifest()).map((entry) => entry.path as VaultPath);
  // Linking a note that has gone would write a link to nothing, which following makes anew.
  if (!notes.includes(target)) throw new RelatedNoteGoneError(target);
  const { text, modified } = await fs.readTextFile(note);
  const { bodyOffset } = splitFrontmatter(text);
  // The file's own line break, frontmatter counted: a body of one line has none to go by.
  const eol = lineBreakOf(text);
  const body = withRelatedLink(text.slice(bodyOffset), wikiLinkTargetFor(target, notes), eol);
  if (body === null) return false;
  const head = text.slice(0, bodyOffset);
  // Frontmatter closed on the file's last byte has no line break for the new section to start after.
  const joint = head !== '' && !head.endsWith('\n') ? eol : '';
  await fs.writeTextFile({
    path: note,
    contents: `${head}${joint}${body}`,
    expectedModified: modified,
  });
  return true;
}
