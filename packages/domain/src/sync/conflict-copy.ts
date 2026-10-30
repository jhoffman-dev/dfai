import { foldedPath } from './case-names.ts';
import type { ConflictCode, GitConflict } from './git-status.ts';
import { MAX_NAME_BYTES } from '../vault/file-name-bytes.ts';

/**
 * Where the other Mac's version of a file both Macs changed is kept (U-29).
 *
 * This Mac's version stays in place; the other's is saved as
 * `<name> (conflict from <Mac>).<ext>` beside it, numbered when that name is
 * taken. A copy of something under `.atlas` — a type, a view, an automation,
 * the settings — goes to {@link CONFLICTS_FOLDER} instead: beside the
 * original it would be read as a second live rule or view.
 */
export const CONFLICTS_FOLDER = 'Sync conflicts';

const ATLAS_PREFIX = '.atlas/';

/** Characters a Mac's name cannot carry into a file name. */
const UNSAFE_IN_NAME = /[/\\:\0\n\r\t]/g;

/** A Mac's name is cut to this many characters in a copy's name. */
const MAX_MAC_LABEL = 40;

export function macLabel(mac: string): string {
  const safe = [...mac.replace(UNSAFE_IN_NAME, '-').trim()].slice(0, MAX_MAC_LABEL).join('').trim();
  return safe === '' ? 'another Mac' : safe;
}

const bytesOf = (text: string) => new TextEncoder().encode(text).length;

/** The stem, cut by whole characters until the name with its suffix fits a file name. */
function fitStem(stem: string, suffix: string): string {
  const room = MAX_NAME_BYTES - bytesOf(suffix);
  const characters = [...stem];
  while (characters.length > 1 && bytesOf(characters.join('')) > room) characters.pop();
  return characters.join('');
}

/** The copy's path, free of every path in `taken`. */
export function conflictCopyPath({
  path,
  mac,
  taken,
}: {
  path: string;
  mac: string;
  taken: ReadonlySet<string>;
}): string {
  const placed = path.startsWith(ATLAS_PREFIX)
    ? `${CONFLICTS_FOLDER}/atlas/${path.slice(ATLAS_PREFIX.length)}`
    : path;
  const slash = placed.lastIndexOf('/');
  const folder = placed.slice(0, slash + 1);
  const file = placed.slice(slash + 1);
  // A leading dot names a file, not its extension: `.gitignore` has none.
  const dot = file.lastIndexOf('.');
  const [stem, extension] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ''];
  const used = new Set([...taken].map(foldedPath));
  for (let number = 1; ; number += 1) {
    const suffix = ` (conflict from ${macLabel(mac)})${number === 1 ? '' : ` ${number}`}${extension}`;
    const candidate = `${folder}${fitStem(stem, suffix)}${suffix}`;
    if (!used.has(foldedPath(candidate))) return candidate;
  }
}

/**
 * A name {@link conflictCopyPath} gives: ` (conflict from <Mac>)`, maybe
 * numbered, before the extension, in the file's own name. The Mac's part is
 * {@link macLabel}'s: up to {@link MAX_MAC_LABEL} characters of anything but
 * a slash — brackets included, as in "Mara's MacBook Pro (2)" — so it is
 * matched lazily and the end of the name decides where it stops (#627). A
 * name that ends in a dot keeps an empty extension.
 */
const CONFLICT_COPY_NAME = new RegExp(
  ` \\(conflict from [^/]{1,${MAX_MAC_LABEL}}?\\)(?: \\d+)?(?:\\.[^./]*)?$`,
  'u',
);

/** Whether a path is the other Mac's version of a file a merge could not settle, kept beside it. */
export function isConflictCopyPath(path: string): boolean {
  return CONFLICT_COPY_NAME.test(path);
}

/**
 * A copy under `Sync conflicts/atlas/`: its folder and stem there, the Mac it
 * came from, and its number, before a markdown extension. The stem is
 * matched greedily, so a Mac named with brackets (`Studio (work)`) still
 * reads as one Mac, and a second ` (conflict from …)` lands in the stem.
 */
const ATLAS_COPY = new RegExp(
  `^${CONFLICTS_FOLDER}/atlas/(.*[^/]) \\(conflict from [^/]+\\)(?: [1-9]\\d*)?(\\.[mM][dD])$`,
);

/**
 * The `.atlas/` file a conflict copy under {@link CONFLICTS_FOLDER} was made
 * of (#235); null for any other path — a copy of a note, a file that is not
 * markdown, or a copy of a copy, whose live file is the first copy and so a
 * person's to settle.
 */
export function settingsFileOfCopy(copy: string): string | null {
  const match = ATLAS_COPY.exec(copy);
  if (match === null) return null;
  const [, stem = '', extension = ''] = match;
  if (stem.includes(' (conflict from ')) return null;
  return `${ATLAS_PREFIX}${stem}${extension}`;
}

/**
 * What is done with one file a merge could not settle. Nothing is ever left
 * holding conflict markers, and no side's changes are thrown away:
 *
 * - both changed it: this Mac's stays, the other's is copied beside it;
 * - one changed it and the other deleted it, or only one side has it: the
 *   version that exists is kept, since deleting a changed file loses work;
 * - both deleted it: it stays deleted.
 */
export type ConflictStep =
  | { readonly kind: 'copy-theirs'; readonly path: string; readonly copy: string }
  | { readonly kind: 'keep'; readonly side: 'ours' | 'theirs'; readonly path: string }
  | { readonly kind: 'drop'; readonly path: string };

const KEEP: Readonly<Record<ConflictCode, 'copy' | 'ours' | 'theirs' | 'drop'>> = {
  UU: 'copy',
  AA: 'copy',
  UD: 'ours',
  AU: 'ours',
  DU: 'theirs',
  UA: 'theirs',
  DD: 'drop',
};

/** The steps that settle every conflict, with copy names free of the vault's paths and of each other. */
export function planConflictSteps({
  conflicts,
  mac,
  existing,
}: {
  conflicts: readonly Pick<GitConflict, 'path' | 'code'>[];
  mac: string;
  /** Every path in the vault now, so no copy lands on one. */
  existing: ReadonlySet<string>;
}): readonly ConflictStep[] {
  const taken = new Set(existing);
  return conflicts.map(({ path, code }): ConflictStep => {
    const keep = KEEP[code];
    if (keep === 'drop') return { kind: 'drop', path };
    if (keep !== 'copy') return { kind: 'keep', side: keep, path };
    const copy = conflictCopyPath({ path, mac, taken });
    taken.add(copy);
    return { kind: 'copy-theirs', path, copy };
  });
}

/**
 * Whether text still holds the markers git writes into a file both sides
 * changed. Only then is git's own copy of this Mac's side put back: any other
 * text in the file is this Mac's version — typing done since a sync stopped
 * part-way included — and is kept as it is.
 */
export function hasConflictMarkers(text: string): boolean {
  return /^<<<<<<< /m.test(text) && /^>>>>>>> /m.test(text);
}
