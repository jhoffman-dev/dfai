/**
 * Which notes an Inbox assist undo would leave with a link to nowhere (#911):
 * moving the item back from where the row filed it breaks every wiki link
 * that opens it there and would not open it where it goes back to — a link
 * by the path it was filed at, say. A link by its title still opens it. Only
 * wiki links are read: a markdown link to the note is not seen.
 */

import { resolveWikiLinkTarget } from '../markdown/resolve-wikilink.ts';
import { splitWikiLinks } from '../markdown/wikilink.ts';
import type { VaultPath } from '../vault/vault-path.ts';

export function assistLinksBrokenByMoveBack({
  notes,
  from,
  to,
  notePaths,
  ignoring,
}: {
  /** The notes to look in, as they say now. */
  notes: readonly { readonly path: VaultPath; readonly text: string }[];
  /** Where the item goes back to. */
  from: VaultPath;
  /** Where it is now. */
  to: VaultPath;
  /** The vault's notes now. */
  notePaths: readonly VaultPath[];
  /** Notes the undo puts back itself: their links are its own to restore. */
  ignoring: ReadonlySet<string>;
}): VaultPath[] {
  if (from === to) return [];
  const after = notePaths.map((path) => (path === to ? from : path));
  return notes
    .filter((note) => note.path !== to && !ignoring.has(note.path))
    .filter((note) =>
      splitWikiLinks(note.text).some(
        (piece) =>
          piece.kind === 'wikiLink' &&
          resolveWikiLinkTarget(piece.target, notePaths) === to &&
          resolveWikiLinkTarget(piece.target, after) !== from,
      ),
    )
    .map((note) => note.path);
}
