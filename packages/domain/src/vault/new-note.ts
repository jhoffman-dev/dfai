import { joinVaultPath, VAULT_ROOT, type VaultPath } from './vault-path.ts';
import { foldedVaultPath } from './vault-spelling.ts';

/** What a note is called before it is given a name. */
export const DEFAULT_NOTE_NAME = 'Untitled';

const MARKDOWN = /\.(md|markdown)$/i;

/**
 * Turns what someone typed into a usable filename.
 *
 * Path separators would silently put the note somewhere else, and a name that is
 * only dots or spaces is not a name at all, so both fall back to the default.
 * The extension is added unless one is already there.
 */
export function noteFileName(name: string): string {
  const cleaned = cleanEntryName(name);
  if (cleaned === '') return `${DEFAULT_NOTE_NAME}.md`;
  return MARKDOWN.test(cleaned) ? cleaned : `${cleaned}.md`;
}

/** Whether what was typed cleans away to nothing, so the note gets the default name. */
export function isUnnamed(name: string): boolean {
  return cleanEntryName(name) === '';
}

/** A name with what no filesystem accepts taken out; empty when nothing usable is left. */
export function cleanEntryName(name: string): string {
  return (
    name
      // Separators, the characters Finder and Windows both refuse, and control
      // characters (\p{Cc}) — all of which would make a name no filesystem accepts.
      .replace(/[/\\:*?"<>|]|\p{Cc}/gu, ' ')
      .replace(/\s+/g, ' ')
      // A leading dot would hide the note; a trailing one confuses some
      // filesystems. Dots and spaces go together, or `. .env` trims to `.env`.
      .replace(/^[\s.]+/, '')
      .replace(/[\s.]+$/, '')
  );
}

/** What `[[`, `]]`, `#`, `^` and `|` mean inside a wiki link: a note named with one cannot be linked. */
const WIKI_LINK_SYNTAX = /[#^[\]|]/g;

/**
 * A name a file and a wiki link can both hold: cleaned as {@link cleanEntryName}
 * is, with the characters a link reads as its own syntax made spaces too.
 * Empty when nothing usable is left.
 */
export function linkableEntryName(name: string): string {
  return cleanEntryName(name.replace(WIKI_LINK_SYNTAX, ' '));
}

/**
 * The room a numbered name needs after a title: ` 9999.md`. A title that
 * names a file is cut (`fitFileNameStem`) until its name, numbered past the
 * names taken, still fits what a disk takes.
 */
export const NUMBERED_NOTE_ENDING = ' 9999.md';

/**
 * The paths taken, as a disk compares names: in any case. Folding each path
 * of a large vault takes about a millisecond, so what makes many notes at a
 * time folds them once here and adds each note it makes.
 */
export class TakenNotePaths {
  readonly #folded: Set<string>;

  constructor(paths: Iterable<string>) {
    this.#folded = new Set([...paths].map(foldedVaultPath));
  }

  has(path: string): boolean {
    return this.#folded.has(foldedVaultPath(path));
  }

  add(path: string): void {
    this.#folded.add(foldedVaultPath(path));
  }
}

/**
 * A path for a new note in `folder`, adding a number if that name is taken.
 * `Untitled.md`, then `Untitled 2.md`, and so on, the way Finder numbers copies.
 *
 * A name taken in another case counts as taken: APFS and NTFS refuse to create
 * `call sam.md` beside `Call Sam.md`.
 */
export function nextAvailableNotePath({
  folder,
  name,
  taken,
}: {
  folder: VaultPath;
  name: string;
  taken: ReadonlySet<string> | TakenNotePaths;
}): VaultPath {
  const fileName = noteFileName(name);
  const extension = MARKDOWN.exec(fileName)?.[0] ?? '.md';
  const base = fileName.slice(0, fileName.length - extension.length);
  const takenInAnyCase = taken instanceof TakenNotePaths ? taken : new TakenNotePaths(taken);

  for (let attempt = 1; ; attempt += 1) {
    const candidate = attempt === 1 ? fileName : `${base} ${attempt}${extension}`;
    const path =
      folder === VAULT_ROOT
        ? joinVaultPath(VAULT_ROOT, candidate)
        : joinVaultPath(folder, candidate);
    if (!takenInAnyCase.has(path)) return path;
  }
}

/**
 * The starting content of a new note: nothing. Its name is its filename, shown
 * and edited at the top of the page; a `# heading` repeating it would be a
 * second title that goes stale the moment the note is renamed (U-09).
 */
export const NEW_NOTE_CONTENTS = '';

/** What a folder is called before it is given a name. */
export const DEFAULT_FOLDER_NAME = 'New folder';

/**
 * A path for a folder in `parent`, cleaned the way a note's name is and
 * numbered if the name is taken — `New folder`, then `New folder 2`. A name
 * taken by a note counts too, and in any case, as the disk would refuse both.
 */
export function nextAvailableFolderPath({
  parent,
  name,
  taken,
}: {
  parent: VaultPath;
  name: string;
  taken: ReadonlySet<string>;
}): VaultPath {
  const base = cleanEntryName(name) === '' ? DEFAULT_FOLDER_NAME : cleanEntryName(name);
  const takenInAnyCase = new Set([...taken].map(foldedVaultPath));

  for (let attempt = 1; ; attempt += 1) {
    const path = joinVaultPath(parent, attempt === 1 ? base : `${base} ${attempt}`);
    if (!takenInAnyCase.has(foldedVaultPath(path))) return path;
  }
}
