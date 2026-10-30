import {
  classifySidebarNote,
  compileSidebarQuery,
  createVaultPath,
  findQuickViews,
  isSkillPath,
  isTemplateNote,
  noteTitle,
  orderSidebarEntries,
  pageTitle,
  queryViewSummary,
  savedViewSummary,
  sidebarEntry,
  SIDEBAR_QUERY_COLUMNS,
  splitFrontmatter,
  takenViewPaths,
  VIEWS_FOLDER,
  type QueryViewSummary,
  type QuickView,
  type SavedViewSummary,
  type SidebarEntry,
  type VaultPath,
} from '@dfai/domain';
import type { IndexPort } from '../index/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';

/** Where a vault keeps the notes DFAI itself put there. */
export const ATLAS_FOLDER = '.atlas';

/**
 * How far down `.atlas` is walked. Its own layout is two deep —
 * `views/Board.md` — and a folder someone nested by hand should cost a few
 * reads, not the sidebar.
 */
const MAX_ATLAS_DEPTH = 4;

/** What the derived sections of the sidebar hold. */
export interface SidebarCatalog {
  readonly views: readonly SidebarEntry[];
  readonly dashboards: readonly SidebarEntry[];
  readonly favorites: readonly SidebarEntry[];
  /** Today and Inbox, lifted to the top — whichever of them this vault has. */
  readonly quick: readonly QuickView[];
  /**
   * Every saved view with the type it lists — the lifted ones too — so a
   * view's page can offer the others over the same type as tabs.
   */
  readonly savedViews: readonly SavedViewSummary[];
  /** Every saved DFAI query, so a query's page can offer the others as tabs (ADR-0019). */
  readonly queryViews: readonly QueryViewSummary[];
  /**
   * Every path a new view cannot be written to (`takenViewPaths`): each file
   * in `.atlas/views`, read as a view or not, and every view found anywhere.
   */
  readonly takenViewPaths: readonly string[];
}

/** One note's frontmatter and the title it is listed under. */
export interface MarkedNote {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly title: string;
}

/** Each note the sidebar asked about, by where the note lives. */
export type MarkedNotes = ReadonlyMap<VaultPath, MarkedNote>;

/**
 * The views, dashboards and favourites in the vault.
 *
 * Read from two places, because one place cannot see everything: the index
 * covers user space, which leaves out the `.atlas` folders that have a section
 * here already, and those are exactly where DFAI keeps the views and
 * dashboards it makes. Both hand back frontmatter,
 * and one rule — {@link classifySidebarNote} — decides what each note is, so
 * there is no second list to keep in step and a view is a view wherever it is
 * kept.
 */
export async function loadSidebarCatalog({
  fs,
  markdown,
  index,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  index: IndexPort;
}): Promise<SidebarCatalog> {
  const [indexed, atlas] = await Promise.all([
    readSidebarMarks(index),
    readAtlasFolder({ fs, markdown }),
  ]);
  return sidebarCatalogOf({ indexed, atlas });
}

/**
 * The catalogue made of its two reads, which a window keeps apart: the marks
 * change with the index, the walk only with a file under `.atlas` (#293).
 */
export function sidebarCatalogOf({
  indexed,
  atlas,
}: {
  indexed: MarkedNotes;
  atlas: AtlasWalk;
}): SidebarCatalog {
  const views: SidebarEntry[] = [];
  const dashboards: SidebarEntry[] = [];
  const favorites: SidebarEntry[] = [];
  const savedViews: SavedViewSummary[] = [];
  const queryViews: QueryViewSummary[] = [];

  for (const [path, { properties, title }] of new Map([...indexed, ...atlas.notes])) {
    const { mark: marked, favorite, icon } = classifySidebarNote(properties);
    // A template wears the mark of what it makes; it is still only a template.
    // A skill's references may wear one too, and are only a skill's (ADR-0050).
    const mark = isTemplateNote(path) || isSkillPath(path) ? null : marked;
    const entry = sidebarEntry(path, icon, title);
    if (mark === 'view') views.push(entry);
    if (mark === 'dashboard') dashboards.push(entry);
    if (favorite) favorites.push(entry);
    const summary = mark === 'view' ? savedViewSummary(path, properties) : null;
    if (summary !== null) savedViews.push(summary);
    const asQuery = mark === 'view' ? queryViewSummary(path, properties) : null;
    if (asQuery !== null) queryViews.push(asQuery);
  }

  const orderedViews = orderSidebarEntries(views);
  const quick = findQuickViews(orderedViews);
  // A view lifted to the top is not listed again under Views: one row per view.
  const lifted = new Set(quick.map((view) => view.entry.path));
  return {
    views: orderedViews.filter((view) => !lifted.has(view.path)),
    dashboards: orderSidebarEntries(dashboards),
    favorites: orderSidebarEntries(favorites),
    quick,
    savedViews,
    queryViews,
    takenViewPaths: takenViewPaths({
      listed: atlas.inViewsFolder,
      views: [...views, ...savedViews],
    }),
  };
}

/**
 * The marks the index knows about, gathered back into frontmatter — one entry
 * per note, holding only the keys the sidebar asked about.
 */
export async function readSidebarMarks(index: IndexPort): Promise<MarkedNotes> {
  const marks = new Map<VaultPath, MarkedNote>();

  const { sql, parameters } = compileSidebarQuery();
  let result;
  try {
    result = await index.query(sql, parameters);
  } catch {
    // An index that is not open yet, or is mid-rebuild, means the sections fill
    // in a moment. Showing them empty is better than showing an error.
    return marks;
  }

  const [pathColumn, keyColumn, valueColumn, titleColumn] = SIDEBAR_QUERY_COLUMNS;
  const pathAt = result.columns.indexOf(pathColumn);
  const keyAt = result.columns.indexOf(keyColumn);
  const valueAt = result.columns.indexOf(valueColumn);
  const titleAt = result.columns.indexOf(titleColumn);
  if (pathAt === -1 || keyAt === -1 || valueAt === -1) return marks;

  for (const row of result.rows) {
    const found = String(row[pathAt] ?? '');
    const key = String(row[keyAt] ?? '');
    if (found === '' || key === '') continue;
    const path = createVaultPath(found);
    const title = String(row[titleAt] ?? '') || noteTitle(path);
    marks.set(path, { properties: { ...marks.get(path)?.properties, [key]: row[valueAt] }, title });
  }

  return marks;
}

/** Every markdown note under `.atlas`, with the frontmatter it declares. */
export async function atlasNotes(ports: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
}): Promise<MarkedNotes> {
  return (await readAtlasFolder(ports)).notes;
}

/** What one walk of `.atlas` finds: its notes, and every entry in the views folder. */
export interface AtlasWalk {
  readonly notes: MarkedNotes;
  readonly inViewsFolder: readonly VaultPath[];
}

/** Walks `.atlas` and reads every note in it, for the sidebar's catalogue. */
export async function readAtlasFolder({
  fs,
  markdown,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
}): Promise<AtlasWalk> {
  const found = new Map<VaultPath, MarkedNote>();
  const walked: Walked = { notes: [], inViewsFolder: [] };
  await walkAtlas({ fs, folder: createVaultPath(ATLAS_FOLDER), depth: 0, walked });
  const { notes: paths, inViewsFolder } = walked;
  if (paths.length === 0) return { notes: found, inViewsFolder };

  for (const file of await fs.readNotes(paths)) {
    const { frontmatter } = splitFrontmatter(file.text);
    if (frontmatter === null) continue;
    const path = createVaultPath(file.path);
    const properties = markdown.frontmatterProperties(frontmatter);
    const title = pageTitle({ fileTitle: noteTitle(path), properties }).text;
    found.set(path, { properties, title });
  }

  return { notes: found, inViewsFolder };
}

/** What the walk gathers as it goes. */
interface Walked {
  readonly notes: VaultPath[];
  readonly inViewsFolder: VaultPath[];
}

async function walkAtlas({
  fs,
  folder,
  depth,
  walked,
}: {
  fs: VaultFsPort;
  folder: VaultPath;
  depth: number;
  walked: Walked;
}): Promise<void> {
  if (depth >= MAX_ATLAS_DEPTH) return;

  let entries;
  try {
    entries = await fs.listDirectory(folder);
  } catch {
    // A vault with no `.atlas` folder has no views or dashboards yet.
    return;
  }

  // Read from the listing, not the notes: a file that is no view still holds its name.
  if (folder === VIEWS_FOLDER) walked.inViewsFolder.push(...entries.map((entry) => entry.path));
  for (const entry of entries) {
    // Skills are read only when their page or the API asks (ADR-0050): not at launch.
    if (isSkillPath(entry.path)) continue;
    if (entry.kind === 'directory') {
      await walkAtlas({ fs, folder: entry.path, depth: depth + 1, walked });
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      walked.notes.push(entry.path);
    }
  }
}
