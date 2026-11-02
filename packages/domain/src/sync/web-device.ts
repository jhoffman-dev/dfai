import { foldedPath } from './case-names.ts';
import { conflictCopyPath } from './conflict-copy.ts';
import { macOfCommit } from './sync-rules.ts';

/**
 * The web, as a device that writes the vault (#665): its conflict copies are
 * named for it as a Mac's are for that Mac, and its commits are authored by
 * it, so a copy's name and the history both say where an edit came from.
 */
export const WEB_DEVICE = 'DFAI web';

/** Who a web commit is by; the desktop's own are `DFAI on <Mac>` (git-steps). */
export const WEB_COMMIT_AUTHOR = { name: WEB_DEVICE, email: 'dfai@web.local' } as const;

/**
 * The device the other side of a merge came from, which the desktop names its
 * conflict copy for: the Mac a DFAI sync's subject names, the web for a commit
 * the web authored (so a web edit's copy is named as the web names its own),
 * or null for a commit DFAI did not make.
 */
export function deviceOfCommit({
  subject,
  author,
}: {
  subject: string;
  author: string;
}): string | null {
  return macOfCommit(subject) ?? (author.trim() === WEB_COMMIT_AUTHOR.name ? WEB_DEVICE : null);
}

/** A version kept as a file of its own, beside the note it could not be written over. */
export interface KeptCopy {
  readonly path: string;
  readonly contents: string;
}

/**
 * Where a write refused because the note moved on is kept (#665), so that
 * neither version is lost: the newer version stays in place, untouched, and
 * the refused one is kept whole beside it, named by the desktop's own rule
 * for its conflict copies (U-29) with `device` as the Mac. Nothing is kept
 * when the refused version is already what the note holds. A note deleted
 * elsewhere has no newer version to sit beside: the refused one is put back
 * at its own path, so an edit is never lost to a delete — the same as the
 * desktop's sync, which keeps the version that exists when one side
 * changed a file and the other deleted it. Where that path cannot take it
 * back — a folder is there now, or a name that differs only by case or
 * Unicode form — it is kept as the conflict copy beside, and what is there
 * is left alone.
 */
export function copyOfRefusedWrite({
  path,
  device,
  mine,
  newer,
  taken,
}: {
  path: string;
  device: string;
  /** The whole text the refused write would have written. */
  mine: string;
  /** The note's text now, or null when it is gone. */
  newer: string | null;
  /**
   * Every path in the copy's folder now, files and folders, so the copy lands
   * on none of them and a gone note is put back only where nothing is.
   */
  taken: ReadonlySet<string>;
}): KeptCopy | null {
  if (mine === newer) return null;
  const occupied = [...taken].some((there) => foldedPath(there) === foldedPath(path));
  if (newer === null && !occupied) return { path, contents: mine };
  return { path: conflictCopyPath({ path, mac: device, taken }), contents: mine };
}
