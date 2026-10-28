import type { VaultEntry } from './vault-entry.ts';
import type { VaultPath } from './vault-path.ts';

/**
 * Directories that are never worth showing in the tree. `.atlas-cache` is our own
 * derived index; the rest are other tools' machinery that would only add noise.
 *
 * This list is exported because the host is handed it when it walks the vault,
 * so it can stop at `node_modules` instead of carrying tens of thousands of
 * paths across IPC for this rule to throw away. That is safe *only* because the
 * names below are rejected unconditionally, on any segment, by the first line of
 * `isVisibleEntry`: pruning them removes exactly the entries this rule would
 * have removed. The host is obeying a list it was given, not deciding what a
 * dotted directory means — see ADR-0014. Anything whose visibility depends on
 * where it sits, like `.atlas`, must not go in here.
 */
export const HIDDEN_DIRECTORY_NAMES: readonly string[] = [
  '.atlas-cache',
  '.git',
  '.obsidian',
  '.trash',
  'node_modules',
  '.DS_Store',
];

/**
 * Folded, because the disk a Mac vault lives on ignores case: a note filed at
 * `Node_Modules/x.md` lands in the `node_modules` the host never walks.
 */
const HIDDEN_DIRECTORIES = new Set<string>(
  HIDDEN_DIRECTORY_NAMES.map((name) => name.toLowerCase()),
);

/**
 * How many folders down the host's walk reads notes: a note at the root is at
 * depth 0, so a note path holds at most this many folders. Handed to the host
 * with the names to skip (ADR-0014); a cap because a symlink can otherwise make
 * the tree appear endless.
 */
export const VAULT_WALK_DEPTH = 32;

/** Whether the walk reads a note at `path`: it is no more than {@link VAULT_WALK_DEPTH} folders down. */
export function isWithinWalk(path: string): boolean {
  return path.split('/').length - 1 <= VAULT_WALK_DEPTH;
}

/** Where DFAI keeps the notes that configure it. */
export const ATLAS_DIRECTORY = '.atlas';

/**
 * Whether a note is one DFAI keeps for itself — a template, a type
 * definition, a view — rather than one of the vault's own notes.
 *
 * A Task template declares `type: task` so that a task can be made from it; it
 * is not a task, so no view, count or board may list it (A15-03).
 */
export function isAtlasNote(path: string): boolean {
  return path.split('/')[0] === ATLAS_DIRECTORY;
}

/** Where a vault keeps the templates new notes are made from. */
export const TEMPLATES_DIRECTORY = `${ATLAS_DIRECTORY}/templates`;

/** Where a vault keeps its skills, one folder each holding a `SKILL.md` (ADR-0050). */
export const SKILLS_DIRECTORY = `${ATLAS_DIRECTORY}/skills`;

/** Where a vault keeps its type definitions, one note per type. */
export const TYPES_DIRECTORY = `${ATLAS_DIRECTORY}/types`;

/** Where a vault keeps its saved views. */
export const VIEWS_DIRECTORY = `${ATLAS_DIRECTORY}/views`;

/** Where a vault keeps its dashboards. */
export const DASHBOARDS_DIRECTORY = `${ATLAS_DIRECTORY}/dashboards`;

/** Where a vault keeps the source notes it trusts with a secret or a file outside it. */
export const SOURCES_DIRECTORY = `${ATLAS_DIRECTORY}/sources`;

/** Where a vault keeps its automations (P25-01), and each one's run log under `log/`. */
export const AUTOMATIONS_DIRECTORY = `${ATLAS_DIRECTORY}/automations`;

/**
 * Whether a note is a template. A template carries the frontmatter of what it
 * makes — the Dashboard template says `atlas: dashboard` — so it looks like a
 * view or a dashboard without being one, and nothing may list it as one.
 */
export function isTemplateNote(path: string): boolean {
  // In any case: the Mac's disk takes `.atlas/Templates` for the templates folder.
  return path.toLowerCase().startsWith(`${TEMPLATES_DIRECTORY}/`);
}

/**
 * Why a note flow — a rename, a new note — may not change `path`: a template
 * is what every new note of its type is made from, so it is renamed, made and
 * deleted only on the Templates page, whose use-cases do not come this way
 * (issue #15, where renaming what looked like a new company renamed the
 * Company template; ADR-0026).
 */
export function templateEditRefusal(path: string): string | null {
  if (!isTemplateNote(path)) return null;
  return 'That is a template, which new notes are made from: it is changed on the Templates page.';
}

/**
 * Whether this is the vault's own `.atlas` folder — the one at the root, not a
 * folder somebody happened to give the same name further down.
 */
export function isSystemFolder(entry: VaultEntry): boolean {
  return entry.kind === 'directory' && entry.path === ATLAS_DIRECTORY;
}

/**
 * The parts of `.atlas` another place in the app already lists: the Views and
 * Dashboards sections, the Templates page (ADR-0026), and the skills
 * (ADR-0050), which their own page and the API list.
 *
 * These, and only these, are left out of user space — showing them in both
 * places would list every view and dashboard twice, and a template among the
 * vault's notes is a note that is not one: a link to it, a search hit on it or
 * a rename of it changes what every new note starts as. Everything else
 * `.atlas` holds (type definitions, sources, settings) has no place of its
 * own, so hiding it would leave those notes with nowhere to be clicked.
 *
 * Adding a section for something in `.atlas` means adding its path here. A new
 * subfolder that no section shows stays visible by default, which is the safe
 * direction to fail in: a note you can reach and did not expect beats a note
 * you cannot reach at all.
 */
const SECTIONED_ATLAS_PATHS = new Set([
  VIEWS_DIRECTORY,
  DASHBOARDS_DIRECTORY,
  TEMPLATES_DIRECTORY,
  SKILLS_DIRECTORY,
]);

/**
 * Whether an entry belongs in user space — the vault as it is on disk, minus
 * what the sidebar's other sections already show.
 *
 * Dotfiles stay hidden, with one deliberate exception: `.atlas` is DFAI's own
 * configuration, written as ordinary notes you are meant to be able to open and
 * edit. It is listed, minus the subfolders that already have sections.
 *
 * The judgement is on the whole path, not on the entry's own name: a note is
 * hidden by the folder holding it as well as by what it is called. The tree can
 * stop at the hidden folder, but `listVaultNotes` asks this about a flat list of
 * every note in the vault, where nothing has already ruled the folder out — and
 * a rule that needed the caller to have done that would be a second copy of it.
 */
export function isVisibleEntry(entry: VaultEntry): boolean {
  const segments = entry.path.split('/');
  if (segments.some((segment) => HIDDEN_DIRECTORIES.has(segment.toLowerCase()))) return false;
  // In any case, as the Mac's disk reads a folder's name: `.atlas/Templates`
  // is the folder the Templates page lists, and must not be a note as well.
  const sectioned = (ancestor: string) => SECTIONED_ATLAS_PATHS.has(ancestor.toLowerCase());
  if (ancestorPaths(segments).some(sectioned)) return false;
  if (segments[0] === ATLAS_DIRECTORY) return true;

  return !segments.some((segment) => segment.startsWith('.'));
}

/**
 * Whether a note is one of the vault's own: not one DFAI keeps in `.atlas`,
 * and not in a hidden folder at any depth. What a query, a view, a widget and
 * the local API may read — as a row, or one relation away.
 */
export function isUserSpaceNote(path: VaultPath): boolean {
  return !isAtlasNote(path) && isVisibleEntry({ kind: 'file', name: '', path });
}

/**
 * {@link isUserSpaceNote} as a SQL condition on a path column, derived from the
 * same list. A dotted segment anywhere covers `.atlas` and every dotted name
 * in {@link HIDDEN_DIRECTORY_NAMES}; the rest are matched as whole segments,
 * folded. SQLite's `lower()` folds ASCII only; that agrees with TypeScript's
 * fold for these names, since none holds a `k` — the one ASCII letter a
 * non-ASCII character (the Kelvin sign) lowers to. The names are the app's
 * own constants, so they are written into the text.
 */
export function userSpaceNoteSql(column: string): string {
  const dotted = `instr('/' || ${column}, '/.') = 0`;
  const named = HIDDEN_DIRECTORY_NAMES.filter((name) => !name.startsWith('.')).map(
    (name) => `instr('/' || lower(${column}) || '/', '/${name.toLowerCase()}/') = 0`,
  );
  return [dotted, ...named].join(' AND ');
}

/** Every path from the first segment down to the entry itself. */
function ancestorPaths(segments: readonly string[]): string[] {
  return segments.map((_, depth) => segments.slice(0, depth + 1).join('/'));
}
