import {
  ATLAS_DIRECTORY,
  INDEX_FACETS,
  PROMPTS_DIRECTORY,
  PROPOSALS_FOLDER,
  SKILLS_DIRECTORY,
  TEMPLATES_DIRECTORY,
  TYPES_DIRECTORY,
  VAULT_SETTINGS_PATH,
  type IndexFacet,
  type NoteChange,
} from '@dfai/domain';

/**
 * A whole-vault read the window keeps until something it is made from
 * changes (ADR-0040): the graph and the tags from the index, the type
 * definitions, the templates, the skills and the prompt notes from their folders
 * (the skills and the prompts read only when a page asks for them, never at
 * launch), the vault's settings
 * from their note, and the sidebar's catalogue and counts (#293) — the
 * notes under `.atlas` it walks, the marks the index holds (a view, a
 * dashboard, a star), how many notes each type has, the Today and Inbox
 * counts, and what the Inbox's own row counts: the notes waiting to be
 * filed and the proposals still open.
 */
export type VaultRead =
  | IndexFacet
  | 'types'
  | 'templates'
  | 'skills'
  | 'prompts'
  | 'settings'
  | 'sidebar-atlas'
  | 'sidebar-marks'
  | 'type-counts'
  | 'quick-counts'
  | 'inbox-waiting';

export const VAULT_READS: readonly VaultRead[] = [
  ...INDEX_FACETS,
  'types',
  'templates',
  'skills',
  'prompts',
  'settings',
  'sidebar-atlas',
  'sidebar-marks',
  'type-counts',
  'quick-counts',
  'inbox-waiting',
];

/**
 * The files and folders the file reads are made from, each with the reads
 * made from it. The sidebar walks the whole of `.atlas`, so any change in it
 * reaches the walk; the Today and Inbox counts read their views' files,
 * which DFAI keeps there.
 */
const PATH_READS: readonly (readonly [string, readonly VaultRead[]])[] = [
  [TYPES_DIRECTORY, ['types']],
  [TEMPLATES_DIRECTORY, ['templates']],
  [SKILLS_DIRECTORY, ['skills']],
  [PROMPTS_DIRECTORY, ['prompts']],
  [VAULT_SETTINGS_PATH, ['settings']],
  [ATLAS_DIRECTORY, ['sidebar-atlas', 'quick-counts']],
  [PROPOSALS_FOLDER, ['inbox-waiting']],
];

/**
 * The reads made again whenever the index has news, whatever it was: the
 * sidebar's marks are any note's `atlas` or `favorite`, a type's count its
 * notes' `type` and also their `para` (an archived project is not counted),
 * and the Today and Inbox counts any property a view filters on, none of
 * which a facet holds whole. When unsure, read again.
 */
export const READS_ON_INDEX_NEWS: ReadonlySet<VaultRead> = new Set<VaultRead>([
  'sidebar-marks',
  'type-counts',
  'quick-counts',
  'inbox-waiting',
]);

/**
 * Whether a change at `path` can reach what is made from `source`: the file
 * itself, a file in it, or a folder holding it (moving `.atlas` moves all of
 * it). Case aside, as the Mac's disk reads a name.
 */
function reaches(path: string, source: string): boolean {
  const at = path.toLowerCase().replace(/\/+$/, '');
  const within = source.toLowerCase();
  return at === within || at.startsWith(`${within}/`) || at === '' || within.startsWith(`${at}/`);
}

/**
 * The file reads a change at these paths makes stale: what another program
 * wrote, as the watcher reports it, or what the app wrote itself. Only the
 * files and folders the reads are made from count. The graph, the tags and
 * the counts are the index's, and a change reaches them only once the index
 * has taken it in, which `reportingIndexWrites` (a facet is its own read) and
 * `READS_ON_INDEX_NEWS` say.
 */
export function readsTouchedByPaths(paths: readonly string[]): ReadonlySet<VaultRead> {
  return new Set(
    PATH_READS.filter(([source]) => paths.some((path) => reaches(path, source))).flatMap(
      ([, reads]) => reads,
    ),
  );
}

/**
 * The file reads a sync of the index found changes to: a type definition is
 * a note the index holds, so a change to one shows up here even when the
 * watcher missed it.
 */
export function readsTouchedByNoteChanges(changes: readonly NoteChange[]): ReadonlySet<VaultRead> {
  return readsTouchedByPaths(changes.map((change) => change.path));
}
