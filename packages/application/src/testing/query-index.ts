import { INDEX_SCHEMA } from './index-schema.ts';
import { DatabaseSync } from './node-sqlite.ts';
import {
  createVaultPath,
  indexablePropertiesOf,
  noteTags,
  relationsOf,
  resolveWikiLinkTarget,
  splitFrontmatter,
  splitWikiLinks,
  TAGS_KEY,
} from '@dfai/domain';
import type { IndexPort, QueryResult } from '../index/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';

/**
 * The index, made from the host's own schema, with the tables a DFAI query
 * reads (`files`, `props`, `relations`, `tags`, `blocks`, and `links` from the
 * body's wiki links) filled from notes the way refreshing the index fills
 * them, so a compiled query runs for real. Titles are the note's name without its folder
 * and `.md`; a note's frontmatter `title:` renames it, as the index's does.
 * Test support only.
 */
export function atlasQueryIndex({
  files,
  markdown,
  modified = {},
}: {
  files: Readonly<Record<string, string>>;
  markdown: MarkdownPort;
  /** When each note last changed, in milliseconds; 1 for a note not named. */
  modified?: Readonly<Record<string, number>>;
}): IndexPort['query'] {
  const database = new DatabaseSync(':memory:');
  database.exec(INDEX_SCHEMA);
  const paths = Object.keys(files).map(createVaultPath);
  for (const [path, text] of Object.entries(files)) {
    addNote(database, {
      path,
      text,
      modified: modified[path] ?? 1,
      markdown,
      resolve: (target) => resolveWikiLinkTarget(target, paths),
    });
  }
  return async (sql, parameters): Promise<QueryResult> => {
    const statement = database.prepare(sql);
    const rows = statement.all(...parameters) as Record<string, unknown>[];
    const columns = statement.columns().map((column) => column.name);
    return {
      columns,
      rows: rows.map((row) => columns.map((column) => row[column])),
      truncated: false,
    };
  };
}

function addNote(
  database: DatabaseSync,
  {
    path,
    text,
    modified,
    markdown,
    resolve,
  }: {
    path: string;
    text: string;
    modified: number;
    markdown: MarkdownPort;
    resolve: (target: string) => string | null;
  },
): void {
  const document = splitFrontmatter(text);
  const properties = markdown.frontmatterProperties(document.frontmatter);
  const named = typeof properties['title'] === 'string' ? properties['title'] : null;
  const title = named ?? path.replace(/^.*\//, '').replace(/\.md$/i, '');
  database
    .prepare('INSERT INTO files (path, title, summary, modified, size) VALUES (?, ?, ?, ?, 1)')
    .run(path, title, '', modified);
  addBlocks(database, path, document.body);
  for (const row of indexablePropertiesOf(properties)) {
    database
      .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(path, row.key, row.index, row.text, row.number, row.date, row.json);
  }
  for (const row of relationsOf(properties, resolve)) {
    database
      .prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?)')
      .run(path, row.key, row.index, row.target, row.name, row.path);
  }
  const tags = noteTags({
    tagsProperty: properties[TAGS_KEY],
    body: document.body,
    ranges: markdown.textRanges(document.body),
  });
  tags.forEach((tag, at) =>
    database.prepare('INSERT INTO tags VALUES (?, ?, ?, ?)').run(path, at, tag.key, tag.name),
  );
  for (const piece of splitWikiLinks(document.body)) {
    if (piece.kind !== 'wikiLink') continue;
    database
      .prepare("INSERT INTO links (src, dst, target, kind) VALUES (?, ?, ?, 'wikilink')")
      .run(path, resolve(piece.target), piece.target);
  }
}

/** The note's blocks that carry an id: a line ending in `^id` (the first of a repeated id is the one a link opens). */
function addBlocks(database: DatabaseSync, path: string, body: string): void {
  const seen = new Set<string>();
  body.split('\n').forEach((line, idx) => {
    const id = /\s\^([A-Za-z0-9-]+)\s*$/.exec(line)?.[1];
    if (id === undefined || seen.has(id)) return;
    seen.add(id);
    database.prepare('INSERT INTO blocks VALUES (?, ?, ?, ?)').run(path, idx, id, line);
  });
}
