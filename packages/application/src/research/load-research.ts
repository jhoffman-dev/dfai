import {
  compileHighlightsQuery,
  compileLibraryQuery,
  createVaultPath,
  FILED_UNDER_TYPES,
  flattenHighlights,
  highlightChoices,
  HIGHLIGHTS_PAGE_SIZE,
  inDisplayOrder,
  LIBRARY_PAGE_SIZE,
  libraryChoices,
  libraryCover,
  LIST_SEPARATOR,
  PAIR_SEPARATOR,
  SOURCE_KINDS,
  type CompiledQuery,
  type HighlightChoices,
  type HighlightEntry,
  type LibraryChoices,
  type LibraryEntry,
  type LibraryProject,
  type NoteChange,
  type SourceHighlights,
} from '@dfai/domain';
import type { IndexPort, QueryResult } from '../index/ports.ts';
import { linkNameOf } from '../reads/index.ts';

/*
 * Rows are read by column index, in the order the statements select them
 * (`LIBRARY_QUERY_COLUMNS`, `HIGHLIGHTS_QUERY_COLUMNS`): a row object per
 * highlight, at 150,000 highlights, was a frame of its own.
 */

type Row = readonly unknown[];

const text = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value);

const textOrNull = (value: unknown): string | null => {
  const read = text(value).trim();
  return read === '' ? null : read;
};

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const listOf = (value: unknown): string[] =>
  text(value) === '' ? [] : text(value).split(LIST_SEPARATOR);

/**
 * Every page a paged statement answers, handed to `onPage` as it arrives,
 * until one comes back short, or `enough` says the rows wanted are all read
 * (a total that is an exact number of pages needs no empty page to end it).
 * `next` is the statement after a full page.
 */
async function eachPage(
  index: Pick<IndexPort, 'query'>,
  {
    first,
    size,
    next,
    onPage,
    enough = () => false,
  }: {
    first: CompiledQuery;
    size: number;
    next: (page: QueryResult, pageNumber: number) => CompiledQuery;
    onPage: (rows: readonly Row[]) => void;
    enough?: () => boolean;
  },
): Promise<void> {
  let statement = first;
  for (let pageNumber = 1; ; pageNumber += 1) {
    const page = await index.query(statement.sql, statement.parameters);
    onPage(page.rows);
    if ((page.rows.length < size && !page.truncated) || enough()) return;
    statement = next(page, pageNumber);
  }
}

function projectsOf(value: unknown): LibraryProject[] {
  return listOf(value).map((pair) => {
    const [path = '', name = ''] = pair.split(PAIR_SEPARATOR);
    return { path: path === '' ? null : createVaultPath(path), name };
  });
}

function libraryEntryOf(row: Row): LibraryEntry {
  const [path, title, modified, author, kind, cover, highlights, tags, projects] = row;
  const kindName = text(kind).trim().toLowerCase();
  return {
    path: createVaultPath(text(path)),
    title: text(title),
    author: textOrNull(author),
    kind: SOURCE_KINDS.find((known) => known === kindName) ?? null,
    highlights: Number(highlights ?? 0),
    // NULL when the vault cannot date the note (ADR-0053): unknown, not the epoch.
    modified: modified === null || modified === undefined ? null : Number(modified),
    tags: listOf(tags),
    projects: projectsOf(projects),
    cover: libraryCover(textOrNull(cover)),
  };
}

function highlightEntryOf(source: LibraryEntry, row: Row): HighlightEntry {
  const [, index, id, kind, quote, comment, mark, color, page, location] = row;
  return {
    path: source.path,
    source: source.title,
    modified: source.modified,
    index: Number(index ?? 0),
    id: text(id),
    kind: text(kind),
    quote: text(quote),
    comment: text(comment),
    mark: text(mark),
    color: text(color),
    page: numberOrNull(page),
    location: numberOrNull(location),
    tags: source.tags,
  };
}

/** Every literature note in use `paths` name (every one when none are named), in path order. */
async function readSources(
  index: Pick<IndexPort, 'query'>,
  paths?: readonly string[],
): Promise<LibraryEntry[]> {
  const sources: LibraryEntry[] = [];
  const statement = (page: number) =>
    compileLibraryQuery({ page, ...(paths !== undefined && { paths }) });
  await eachPage(index, {
    first: statement(0),
    size: LIBRARY_PAGE_SIZE,
    next: (_, pageNumber) => statement(pageNumber),
    onPage: (rows) => {
      for (const row of rows) sources.push(libraryEntryOf(row));
    },
  });
  return sources;
}

/**
 * Every highlight in the notes of `sources`, a page at a time, each joined to
 * its source as the page arrives (by the path as the index wrote it), and
 * grouped by source: the statement lists them by note, then in the order the
 * note holds them. Sources with none are left out.
 */
async function readSourceHighlights(
  index: Pick<IndexPort, 'query'>,
  sources: readonly LibraryEntry[],
  paths?: readonly string[],
): Promise<SourceHighlights[]> {
  const groups = new Map<string, { source: LibraryEntry; highlights: HighlightEntry[] }>();
  // The Library counted each source's highlights: a full page that reaches that many leaves nothing to ask for.
  let expected = 0;
  let read = 0;
  for (const source of sources) {
    groups.set(source.path, { source, highlights: [] });
    expected += source.highlights;
  }
  const statement = (after?: Row) =>
    compileHighlightsQuery({
      ...(after !== undefined && { after: { path: text(after[0]), index: Number(after[1]) } }),
      ...(paths !== undefined && { paths }),
    });
  await eachPage(index, {
    first: statement(),
    size: HIGHLIGHTS_PAGE_SIZE,
    next: (page) => statement(page.rows[page.rows.length - 1]),
    enough: () => expected > 0 && read === expected,
    onPage: (rows) => {
      read += rows.length;
      for (const row of rows) {
        const group = groups.get(text(row[0]));
        // A note that stopped being a source between the two reads has none to list.
        if (group !== undefined) group.highlights.push(highlightEntryOf(group.source, row));
      }
    },
  });
  return [...groups.values()].filter((group) => group.highlights.length > 0);
}

/** The Library as it is read and kept: its sources, and what its filters offer of them. */
export interface LibraryRead {
  /** In path order; the Library sorts. */
  readonly entries: readonly LibraryEntry[];
  readonly choices: LibraryChoices;
}

/** All highlights as it is read and kept: the sources with highlights, in the order listed, and what its filters offer. */
export interface HighlightsRead {
  readonly groups: readonly SourceHighlights[];
  readonly entries: readonly HighlightEntry[];
  readonly choices: HighlightChoices;
}

const libraryReadOf = (entries: readonly LibraryEntry[]): LibraryRead => ({
  entries,
  choices: libraryChoices(entries),
});

const highlightsReadOf = (unordered: Iterable<SourceHighlights>): HighlightsRead => {
  const groups = inDisplayOrder(unordered);
  const entries = flattenHighlights(groups);
  return { groups, entries, choices: highlightChoices(entries) };
};

/**
 * Every literature note in use (#507, ADR-0043), as the Library lists it,
 * read from the index a page at a time, with the choices its filters offer.
 */
export async function readLibrary({
  index,
}: {
  index: Pick<IndexPort, 'query'>;
}): Promise<LibraryRead> {
  return libraryReadOf(await readSources(index));
}

/** {@link readLibrary}'s sources alone. */
export async function loadLibrary({
  index,
}: {
  index: Pick<IndexPort, 'query'>;
}): Promise<LibraryEntry[]> {
  return readSources(index);
}

/**
 * Every highlight in a literature note in use (#507), as All highlights
 * lists it: the literature notes, then the highlights a page at a time,
 * matched to them — the most recently changed notes first, each note's in
 * the order it holds them — with the choices its filters offer.
 */
export async function readHighlights({
  index,
}: {
  index: Pick<IndexPort, 'query'>;
}): Promise<HighlightsRead> {
  const sources = await readSources(index);
  return highlightsReadOf(await readSourceHighlights(index, sources));
}

/** {@link readHighlights}'s highlights alone. */
export async function loadAllHighlights({
  index,
}: {
  index: Pick<IndexPort, 'query'>;
}): Promise<HighlightEntry[]> {
  return [...(await readHighlights({ index })).entries];
}

/** More changed notes than this are read again whole: the statements name each one. */
export const MAX_REFRESHED_PATHS = 100;

/** Whether the type a change's note declares, as `typesOf` reads one (comma-joined names, case aside), is one of `types`. */
const isOneOf = (types: readonly string[], type: string | null | undefined): boolean =>
  type?.split(',').some((name) => types.includes(name.trim().toLowerCase())) === true;

const isLiterature = (type: string | null | undefined): boolean => isOneOf(['literature'], type);

/**
 * The notes `changes` say changed, when that is all that a read of literature
 * notes has to read again: every change is to a note that is, or was, a
 * literature note, and there are few. Null otherwise — a project retitled
 * changes the Library's rows of every note filed under it, and a folder
 * renamed moves hundreds.
 */
function changedSourcePaths(changes: readonly NoteChange[]): string[] | null {
  if (!changes.every((change) => isLiterature(change.type) || isLiterature(change.beforeType))) {
    return null;
  }
  const paths = [...new Set(changes.map((change) => change.path))];
  return paths.length > MAX_REFRESHED_PATHS ? null : paths;
}

const withoutPaths = <Item>(
  items: readonly Item[],
  pathOf: (item: Item) => string,
  gone: Set<string>,
) => items.filter((item) => !gone.has(pathOf(item)));

/**
 * Paths in the order the index lists them: SQLite compares UTF-8 bytes,
 * which is code point order — not JavaScript's UTF-16 code units, which put
 * a character past U+FFFF (a surrogate pair) before U+E000–U+FFFF.
 */
function inPathOrder(left: string, right: string): number {
  let at = 0;
  for (;;) {
    const one = left.codePointAt(at);
    const other = right.codePointAt(at);
    if (one === undefined || other === undefined)
      return Number(one !== undefined) - Number(other !== undefined);
    if (one !== other) return one < other ? -1 : 1;
    at += one > 0xffff ? 2 : 1;
  }
}

/** A path as the Mac's disk compares it: case aside, accents composed. */
const foldedPath = (path: string) => path.normalize('NFC').toLowerCase();

/**
 * The sources of `entries` filed under the note at `path`: by the path their
 * `project:` resolved to, or, unresolved, by the name it waits for.
 */
function filedUnder(entries: readonly LibraryEntry[], path: string): string[] {
  const at = foldedPath(path);
  const name = linkNameOf(path);
  return entries
    .filter((entry) =>
      entry.projects.some((project) =>
        project.path === null ? linkNameOf(project.name) === name : foldedPath(project.path) === at,
      ),
    )
    .map((entry) => entry.path);
}

/**
 * The Library's sources `changes` say to read again: each literature note
 * that changed, and the sources filed under a note of no filed-under type
 * that changed (`libraryScope`) — its title is their project's name. Null
 * when the whole is to be read again: a project or area changed, whose
 * change can re-resolve any source's `project:`, or too many to name.
 */
function changedLibraryPaths(
  previous: LibraryRead,
  changes: readonly NoteChange[],
): string[] | null {
  const paths = new Set<string>();
  for (const change of changes) {
    if (isLiterature(change.type) || isLiterature(change.beforeType)) {
      paths.add(change.path);
      continue;
    }
    const filed = filedUnder(previous.entries, change.path);
    const project = [change.type, change.beforeType].some((type) =>
      isOneOf(FILED_UNDER_TYPES, type),
    );
    if (project || filed.length === 0) return null;
    for (const path of filed) paths.add(path);
  }
  return paths.size > MAX_REFRESHED_PATHS ? null : [...paths];
}

/**
 * The Library again after `changes`: only the sources they touch are read
 * again, and put in place of what was kept. Null when the whole is to be
 * read again (`changedLibraryPaths`).
 */
export async function refreshLibrary({
  index,
  previous,
  changes,
}: {
  index: Pick<IndexPort, 'query'>;
  previous: LibraryRead;
  changes: readonly NoteChange[];
}): Promise<LibraryRead | null> {
  const paths = changedLibraryPaths(previous, changes);
  if (paths === null) return null;
  if (paths.length === 0) return previous;
  const read = await readSources(index, paths);
  const kept = withoutPaths(previous.entries, (entry) => entry.path, new Set(paths));
  return libraryReadOf([...kept, ...read].sort((a, b) => inPathOrder(a.path, b.path)));
}

/** All highlights again after `changes`: as {@link refreshLibrary}, for the highlights of the notes they name. */
export async function refreshHighlights({
  index,
  previous,
  changes,
}: {
  index: Pick<IndexPort, 'query'>;
  previous: HighlightsRead;
  changes: readonly NoteChange[];
}): Promise<HighlightsRead | null> {
  const paths = changedSourcePaths(changes);
  if (paths === null) return null;
  if (paths.length === 0) return previous;
  const sources = await readSources(index, paths);
  const read = await readSourceHighlights(index, sources, paths);
  const kept = withoutPaths(previous.groups, (group) => group.source.path, new Set(paths));
  return highlightsReadOf([...kept, ...read]);
}
