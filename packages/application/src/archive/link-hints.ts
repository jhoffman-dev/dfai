import {
  compileLinkHintsQuery,
  LINK_HINTS_KIND,
  LINK_HINTS_PAGE_SIZE,
  LINK_HINTS_QUERY_COLUMNS,
  type LinkHints,
  type LinkHintsPart,
  type LinkUse,
} from '@dfai/domain';
import type { IndexPort } from '../index/ports.ts';

const MARKDOWN = /\.(md|markdown)$/i;

/** What a link field's suggestions are read from, beyond a relation's own notes. */
export interface LinkHintsRead {
  /** Every note a link may be offered to, for `[[` and for "is a note already called that?". */
  readonly notes: readonly { readonly path: string; readonly title: string }[];
  readonly hints: LinkHints;
}

type Row = readonly unknown[];

/** Where each column is in the rows the index answered. */
type Columns = Readonly<Record<(typeof LINK_HINTS_QUERY_COLUMNS)[number], number>>;

/**
 * The notes a link field may suggest, their aliases and how much each is
 * linked (#465), read from the index only once a picker opens. Each part is
 * read a page at a time, a page no larger than the host ever answers whole,
 * until a page comes back short — so a vault past that many notes loses
 * none. A page the host still says it cut is refused, rather than passed off
 * as all there is. A row that cannot be read is skipped; an index that
 * cannot answer is passed on, for the picker to say so.
 */
export async function readLinkHints({
  index,
}: {
  index: Pick<IndexPort, 'query'>;
}): Promise<LinkHintsRead> {
  const [noteRows, aliasRows, useRows] = await Promise.all([
    readAll(index, 'notes'),
    readAll(index, 'aliases'),
    readAll(index, 'uses'),
  ]);
  const notes: { path: string; title: string }[] = [];
  for (const { path, row, at } of noteRows) {
    const title = row[at.text];
    if (typeof title === 'string' && MARKDOWN.test(path)) notes.push({ path, title });
  }
  const aliases = new Map<string, string[]>();
  for (const { path, row, at } of aliasRows) {
    const alias = row[at.text];
    if (typeof alias !== 'string') continue;
    const known = aliases.get(path);
    if (known === undefined) aliases.set(path, [alias]);
    else known.push(alias);
  }
  const uses = new Map<string, LinkUse>();
  for (const { path, row, at } of useRows) {
    const count = row[at.uses];
    const last = row[at.last];
    if (typeof count === 'number')
      uses.set(path, { count, last: typeof last === 'number' ? last : null });
  }
  return { notes, hints: { aliases, uses } };
}

/** Every row of one part, a page at a time: each of that part's kind, with a path. */
async function readAll(
  index: Pick<IndexPort, 'query'>,
  part: LinkHintsPart,
): Promise<{ path: string; row: Row; at: Columns }[]> {
  const rows: { path: string; row: Row; at: Columns }[] = [];
  for (let page = 0; ; page += 1) {
    const { sql, parameters } = compileLinkHintsQuery(part, page);
    const result = await index.query(sql, parameters);
    if (result.truncated || result.rows.length > LINK_HINTS_PAGE_SIZE) {
      throw new Error('The index cut its answer short, so the notes to suggest are not all there.');
    }
    const at = Object.fromEntries(
      LINK_HINTS_QUERY_COLUMNS.map((column) => [column, result.columns.indexOf(column)]),
    ) as Columns;
    for (const row of result.rows) {
      const path = row[at.path];
      if (row[at.kind] === LINK_HINTS_KIND[part] && typeof path === 'string') {
        rows.push({ path, row, at });
      }
    }
    if (result.rows.length < LINK_HINTS_PAGE_SIZE) return rows;
  }
}
