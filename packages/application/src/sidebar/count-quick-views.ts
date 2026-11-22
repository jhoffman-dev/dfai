import {
  compileViewQuery,
  parseQueryView,
  parseSavedView,
  queryRowLimit,
  splitFrontmatter,
  type ObjectType,
  type QuickView,
  type QuickViewId,
  type ViewQuery,
} from '@dfai/domain';
import type { IndexPort } from '../index/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { runAtlasQuery } from '../query/run-atlas-query.ts';
import { viewColumnsOf } from '../query/run-view.ts';
import type { VaultFsPort } from '../vault/ports.ts';

/**
 * How many notes each quick view holds right now, for the count beside it.
 *
 * Each view is read from its file rather than from what the catalogue kept:
 * the index only hands back a view's marks, and counting a view without its
 * filters would count the wrong thing. A view that cannot be read or run gets
 * no count — the row still opens it, which is where its error belongs.
 *
 * The index counts a saved view, rather than handing back every row to be
 * counted here, and the count stops at the view's limit: the number beside a
 * view is how many it shows when opened. A DFAI query view (ADR-0019) — an
 * Inbox over tasks and meetings, say — is run as it is opened, and its rows
 * counted: its own LIMIT already stops it there.
 */
export async function countQuickViews({
  fs,
  markdown,
  index,
  quick,
  types,
  notePaths,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  index: IndexPort;
  quick: readonly QuickView[];
  /** The vault's types, which a query view is checked against. */
  types: readonly ObjectType[];
  /** Every note in the vault, so a link in a query view names the note it means. */
  notePaths: readonly string[];
}): Promise<ReadonlyMap<QuickViewId, number>> {
  if (quick.length === 0) return new Map();

  let files;
  try {
    files = await fs.readNotes(quick.map((view) => view.entry.path));
  } catch {
    // Unreadable right now — mid-rename, say. No counts is the honest answer.
    return new Map();
  }
  const textOf = new Map(files.map((file) => [file.path, file.text]));

  const counted = await Promise.all(
    quick.map(async ({ id, entry }) => {
      const text = textOf.get(entry.path);
      if (text === undefined) return null;
      const properties = markdown.frontmatterProperties(splitFrontmatter(text).frontmatter);
      const saved = parseSavedView(properties);
      const queryText = parseQueryView(properties);
      try {
        if (saved !== null) return [id, await countView({ index, query: saved, types })] as const;
        if (queryText === null) return null;
        const answer = await runAtlasQuery({ index, text: queryText, types, notePaths });
        return [id, answer.result.rows.length] as const;
      } catch {
        // The view's own page reports why it cannot run or read; the count just stays off.
        return null;
      }
    }),
  );

  return new Map(counted.filter((pair) => pair !== null));
}

async function countView({
  index,
  query,
  types,
}: {
  index: IndexPort;
  query: ViewQuery;
  types: readonly ObjectType[];
}): Promise<number> {
  const { sql, parameters } = compileViewQuery(
    query,
    { aggregate: { kind: 'count', column: null } },
    { viewColumns: viewColumnsOf(types, query.type) },
  );
  const result = await index.query(sql, parameters);
  const counted = Number(result.rows[0]?.[0] ?? 0);
  return Math.min(counted, queryRowLimit(query.limit));
}
