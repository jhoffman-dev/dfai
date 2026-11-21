import { noteTitle, pathDepth, withoutExtension, type VaultPath } from '../vault/index.ts';

/** Anything but printable ASCII, which composes to itself. */
const NOT_PLAIN_ASCII = /[^ -~\t\n\r]/;

/**
 * A name as links compare it: accents composed one way. macOS keyboards type
 * `ë` as one character, and files synced from elsewhere often spell it as `e`
 * and a combining mark; both are the same name to the person.
 */
export const composed = (name: string): string =>
  // Most names are plain ASCII: skipping them keeps resolving a large vault quick.
  NOT_PLAIN_ASCII.test(name) ? name.normalize('NFC') : name;

/**
 * A link's target as links compare it loosely — extension dropped, accents
 * composed, case folded — or a note's name or path folded the same way. Two
 * spellings with one key may open the same note.
 */
export function foldedLinkName(target: string): string {
  return composed(withoutExtension(target.trim())).toLowerCase();
}

/** The keys a note answers to: its folded name, and its folded path for links written as one. */
export function linkKeysOf(path: VaultPath): readonly [byName: string, byPath: string] {
  return [foldedLinkName(noteTitle(path)), foldedLinkName(path)];
}

/** What a target is compared with in a note: its path when the target has a slash, else its name. */
function comparedPart(note: VaultPath, byPath: boolean): string {
  return composed(byPath ? withoutExtension(note) : noteTitle(note));
}

/**
 * The note a wiki link opens, the way Obsidian finds it: a target with a
 * slash is a path from the vault's root; anything else is a name that may
 * live anywhere. A name spelled exactly wins over one matching only once case
 * is folded; among equals the shallowest note wins, then the first by path,
 * so the same link always opens the same note. Null when nothing matches.
 */
export function resolveWikiLinkTarget(
  target: string,
  candidates: readonly VaultPath[],
): VaultPath | null {
  const wanted = target.trim();
  if (wanted === '') return null;
  const byPath = wanted.includes('/');
  const exact = composed(withoutExtension(wanted));
  const loose = exact.toLowerCase();
  return (
    best(candidates.filter((note) => comparedPart(note, byPath) === exact)) ??
    best(candidates.filter((note) => comparedPart(note, byPath).toLowerCase() === loose))
  );
}

/**
 * `resolveWikiLinkTarget` over one fixed set of notes, answered from a map
 * built once: drawing every link in a note must not search the vault per link.
 */
export function createWikiLinkResolver(
  notes: readonly VaultPath[],
): (target: string) => VaultPath | null {
  const byName = new Map<string, VaultPath[]>();
  const byPath = new Map<string, VaultPath[]>();
  for (const note of notes) {
    const [name, path] = linkKeysOf(note);
    push(byName, name, note);
    push(byPath, path, note);
  }
  return (target) => {
    const wanted = target.trim();
    if (wanted === '') return null;
    const index = wanted.includes('/') ? byPath : byName;
    return resolveWikiLinkTarget(wanted, index.get(foldedLinkName(wanted)) ?? []);
  };
}

function push(map: Map<string, VaultPath[]>, key: string, note: VaultPath): void {
  const group = map.get(key);
  if (group === undefined) map.set(key, [note]);
  else group.push(note);
}

function best(candidates: readonly VaultPath[]): VaultPath | null {
  let winner: VaultPath | null = null;
  for (const note of candidates) {
    if (winner === null || isBetter(note, winner)) winner = note;
  }
  return winner;
}

function isBetter(note: VaultPath, than: VaultPath): boolean {
  const depth = pathDepth(note) - pathDepth(than);
  return depth !== 0 ? depth < 0 : note < than;
}

/**
 * What to write inside `[[…]]` so the link opens `path` among `resolve`'s
 * notes: its bare name when that finds it, else its path without `.md`.
 */
export function wikiLinkTargetFor(
  path: VaultPath,
  resolve: (target: string) => VaultPath | null,
): string {
  const name = noteTitle(path);
  return resolve(name) === path ? name : withoutExtension(path);
}
