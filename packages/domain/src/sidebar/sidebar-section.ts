/**
 * The sidebar's five sections.
 *
 * Peers, in this order, rather than views and dashboards nested under types or
 * folded into one another: each answers a different question about the vault,
 * and the point of the sidebar is that all five can be found without knowing
 * where anything lives on disk.
 */
export type SidebarSectionId = 'favorites' | 'types' | 'views' | 'dashboards' | 'userSpace';

export interface SidebarSection {
  readonly id: SidebarSectionId;
  readonly label: string;
}

/** Every section has a name, and the type says so. */
export const SIDEBAR_SECTION_LABELS: Readonly<Record<SidebarSectionId, string>> = {
  favorites: 'Favorites',
  types: 'Types',
  views: 'Views',
  dashboards: 'Dashboards',
  userSpace: 'Pages',
};

const ORDER: readonly SidebarSectionId[] = [
  'favorites',
  'types',
  'views',
  'dashboards',
  'userSpace',
];

export const SIDEBAR_SECTIONS: readonly SidebarSection[] = ORDER.map((id) => ({
  id,
  label: SIDEBAR_SECTION_LABELS[id],
}));

const IDS: ReadonlySet<string> = new Set(ORDER);

export function isSidebarSectionId(value: unknown): value is SidebarSectionId {
  return typeof value === 'string' && IDS.has(value);
}

/**
 * Which sections a viewer has collapsed, out of whatever was remembered.
 *
 * Collapsed rather than expanded is stored, so a section added in a later
 * version shows up open instead of hidden behind a setting nobody set. Anything
 * unrecognised is dropped: this is a convenience, and a stale or hand-edited
 * value should cost nothing more than an open section.
 */
export function parseCollapsedSections(remembered: unknown): SidebarSectionId[] {
  if (!Array.isArray(remembered)) return [];
  return [...new Set(remembered.filter(isSidebarSectionId))];
}

/** Hidden on a first run (#902): Pages is there to be found, not to fill the sidebar. */
const HIDDEN_AT_FIRST: readonly SidebarSectionId[] = ['userSpace'];

/**
 * Which sections a viewer has hidden from the sidebar, out of whatever was
 * remembered.
 *
 * Unlike collapsed, hidden has a default: nothing remembered, or anything that
 * is not a list (a corrupt or hand-edited value), hides Pages. An empty list
 * is a choice — every section shown — and is kept. Ids that name no section
 * are dropped. A list that would hide every section is taken as corrupt too,
 * since no control in the app can make one and it would leave the sidebar
 * without a section to show.
 */
export function parseHiddenSections(remembered: unknown): SidebarSectionId[] {
  if (!Array.isArray(remembered)) return [...HIDDEN_AT_FIRST];
  const hidden = [...new Set(remembered.filter(isSidebarSectionId))];
  return hidden.length === ORDER.length ? [...HIDDEN_AT_FIRST] : hidden;
}
