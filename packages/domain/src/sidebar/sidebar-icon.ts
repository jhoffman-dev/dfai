import type { ViewLayout } from '../query/saved-view.ts';
import type { VaultEntry } from '../vault/vault-entry.ts';
import { isSystemFolder } from '../vault/vault-visibility.ts';
import { isArchiveFolder } from '../archive/archive.ts';

/**
 * The glyphs a sidebar row can carry. Names of meanings rather than of
 * drawings, so the presentation layer is free to draw them however it likes.
 */
export type SidebarIcon =
  | 'doc'
  | 'folder'
  | 'system'
  | 'archive'
  | 'task'
  | 'person'
  | 'company'
  | 'event'
  | 'table'
  | 'board'
  | 'list'
  | 'grid'
  | 'feed'
  | 'calendar'
  | 'timeline'
  | 'chart'
  | 'graph'
  | 'tag'
  | 'artifact'
  | 'automation'
  | 'activity'
  | 'template'
  | 'term'
  | 'skill'
  | 'inbox'
  | 'today'
  | 'library'
  | 'ask';

/**
 * Words a type's name is recognised by, singular and plural. A vault defines
 * its own types, so this can only ever be a guess from the name — and a type it
 * does not recognise is a plain document, which is never wrong, only plain.
 */
const TYPE_WORDS: readonly (readonly [SidebarIcon, readonly string[]])[] = [
  ['task', ['task', 'tasks', 'todo', 'todos']],
  ['person', ['person', 'people', 'contact', 'contacts']],
  ['company', ['company', 'companies', 'organisation', 'organization', 'org']],
  ['event', ['event', 'events', 'meeting', 'meetings']],
  ['board', ['project', 'projects']],
  ['artifact', ['artifact', 'artifacts']],
  ['term', ['term', 'terms', 'glossary']],
];

/** The icon beside a type, guessed from its name. */
export function typeIcon(typeName: string): SidebarIcon {
  const word = typeName.trim().toLowerCase();
  return TYPE_WORDS.find(([, words]) => words.includes(word))?.[0] ?? 'doc';
}

const LAYOUT_ICONS: Readonly<Record<ViewLayout, SidebarIcon>> = {
  table: 'table',
  board: 'board',
  list: 'list',
  gallery: 'grid',
  feed: 'feed',
  calendar: 'calendar',
  timeline: 'timeline',
};

/** The icon beside a saved view: what it will look like when opened. */
export function viewIcon(layout: ViewLayout): SidebarIcon {
  return LAYOUT_ICONS[layout];
}

/** The icon beside a row in Pages: a folder, the system folder, the Archive, or a note. */
export function treeEntryIcon(entry: VaultEntry): SidebarIcon {
  if (entry.kind === 'file') return 'doc';
  if (isArchiveFolder(entry)) return 'archive';
  return isSystemFolder(entry) ? 'system' : 'folder';
}
