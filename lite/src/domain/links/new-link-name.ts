import { cleanNoteName, INBOX_FOLDER, joinPath, type VaultPath } from '../vault/index.ts';
import { linkBreakingCharacter } from './wikilink.ts';

/**
 * What following (or picking "Create" for) a link to a missing note does:
 * open the note that already answers to it, make a new one, or refuse.
 */
export type NoteFromLink =
  | { readonly kind: 'existing'; readonly path: VaultPath }
  | {
      readonly kind: 'create';
      readonly path: VaultPath;
      /** What to write inside `[[…]]` so the link opens the new note. */
      readonly linkTarget: string;
    }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Where a note made from a link goes and what it is called.
 *
 * A bare name goes to `Inbox/`, where notes with no obvious home go; a
 * target with a slash is a path from the vault's root and is made there.
 * Each part is made a safe file name (`Q3: plan` is `Q3 plan`). When a note
 * already answers to the link as typed, or to the name its file would get,
 * that note is opened rather than a second one made. Refused when nothing is
 * typed, when a heading or alias in it means it is no plain name, or when
 * nothing usable is left of it.
 */
export function noteFromLink(
  typed: string,
  resolve: (target: string) => VaultPath | null,
): NoteFromLink {
  const target = typed.trim();
  if (target === '') return { kind: 'refused', reason: 'Type a name to make a note of it.' };
  const breaking = linkBreakingCharacter(target);
  if (breaking !== null) {
    return { kind: 'refused', reason: `“${target}” cannot be a note’s name: it holds ${breaking}` };
  }
  const parts = target.replace(/\.md$/i, '').split('/').map(cleanNoteName);
  if (parts.some((part) => part === '')) {
    return { kind: 'refused', reason: 'Give the new note a name.' };
  }
  const linkTarget = parts.join('/');
  const existing = resolve(target) ?? resolve(linkTarget);
  if (existing !== null) return { kind: 'existing', path: existing };
  const path = parts.length === 1 ? joinPath(INBOX_FOLDER, `${linkTarget}.md`) : `${linkTarget}.md`;
  return { kind: 'create', path, linkTarget };
}
