import { INDEX_SCHEMA } from './index-schema.ts';
import { DatabaseSync } from './node-sqlite.ts';

/**
 * What holds the inline copies of the index's tables and indexes in tests to
 * the one schema the host makes (#134), for `index-schema.test.ts`.
 *
 * A copy may leave out host columns (a test makes only what it reads), and a
 * table the host does not have is not a copy at all; both are deliberate. A
 * copy drifts when it says something the host's index does not: a column it
 * lacks or of another type, NOT NULL or a default where the host has none, a
 * primary key or UNIQUE of its own, an index of another shape or one the host
 * never makes, or a search table of other options. Test support only.
 */

interface Column {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

function columnsOf(database: DatabaseSync, table: string): Column[] {
  return (database.prepare(`PRAGMA table_xinfo("${table}")`).all() as unknown as Column[]).map(
    ({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }),
  );
}

/** A table's UNIQUE constraints, each as its columns. */
function uniquesOf(database: DatabaseSync, table: string): string[] {
  const indexes = database.prepare(`PRAGMA index_list("${table}")`).all() as {
    name: string;
    origin: string;
  }[];
  return indexes
    .filter((index) => index.origin === 'u')
    .map((index) =>
      (database.prepare(`PRAGMA index_info("${index.name}")`).all() as { name: string }[])
        .map((column) => column.name)
        .join(', '),
    )
    .sort();
}

/** A CREATE statement as the shape it makes: no `IF NOT EXISTS`, schema or quotes; case and spacing folded. */
const shapeOf = (sql: string) =>
  sql
    .replace(/\s+IF\s+NOT\s+EXISTS\s+/i, ' ')
    .replace(/["`[\]]/g, '')
    .replace(/\bmain\s*\.\s*/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),=])\s*/g, '$1')
    .trim()
    .toLowerCase();

const NAME = String.raw`(?:["\`[]?\w+["\`\]]?\s*\.\s*)?["\`[]?(\w+)["\`\]]?`;

/** Any CREATE of a table or index: temporary, unique, virtual, quoted or in a schema. Groups: virtual, kind, name. */
const CREATE = new RegExp(
  String.raw`CREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:UNIQUE\s+)?(VIRTUAL\s+)?(TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?` +
    NAME,
  'i',
);
const ON_TABLE = new RegExp(String.raw`\bON\s+` + NAME, 'i');

/** The tables full-text search keeps beside a virtual one, which are SQLite's rather than ours. */
const isShadowOf = (name: string, virtual: readonly string[]) =>
  virtual.some((table) => new RegExp(`^${table}_(data|idx|content|docsize|config)$`).test(name));

function schemaOf(sql: string) {
  const database = new DatabaseSync(':memory:');
  database.exec(sql);
  const entries = database
    .prepare('SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL')
    .all() as { type: string; name: string; sql: string }[];
  const virtual = entries
    .filter((entry) => CREATE.exec(entry.sql)?.[1] !== undefined)
    .map((entry) => entry.name);
  const ours = entries.filter((entry) => !isShadowOf(entry.name, virtual));
  const tables = new Map(
    ours
      .filter((entry) => entry.type === 'table')
      .map((entry) => [
        entry.name,
        { columns: columnsOf(database, entry.name), uniques: uniquesOf(database, entry.name) },
      ]),
  );
  // An index, or a virtual table's options, is held to its whole statement.
  const statements = new Map(
    ours
      .filter((entry) => entry.type === 'index' || virtual.includes(entry.name))
      .map((entry) => [entry.name, shapeOf(entry.sql)]),
  );
  return { tables, statements };
}

export const CANONICAL = schemaOf(INDEX_SCHEMA);

/** The index after the parenthesis closing at `from`, up to where the statement ends: its WHERE, say. */
function clausesAfter(text: string, from: number): string {
  const rest = /^[^;`]*/.exec(text.slice(from))![0];
  const [first = '', ...more] = rest.split('\n');
  const lines = [first];
  for (const line of more) {
    if (!/^\s*(WHERE|AND|OR|NOT|IS|WITHOUT|STRICT)\b/i.test(line)) break;
    lines.push(line);
  }
  let clauses = lines.join('\n');
  // Inside a quoted JavaScript string the statement stops at the string's closing quote.
  for (const quote of ["'", '"']) {
    if (clauses.split(quote).length % 2 === 0)
      clauses = clauses.slice(0, clauses.lastIndexOf(quote));
  }
  return clauses.trimEnd();
}

/** The statement from `start`: through the parenthesis closing the first one it opens, and its clauses. */
function statementAt(text: string, start: number): string | null {
  let depth = 0;
  for (let at = start; at < text.length; at += 1) {
    if (text[at] === '(') depth += 1;
    else if (text[at] === ')' && --depth === 0) {
      return text.slice(start, at + 1) + clausesAfter(text, at + 1);
    }
  }
  return null;
}

/** SQL written inside a JavaScript string, as the string holds it. */
const unescaped = (source: string) => source.replace(/\\n/g, '\n').replace(/\\(['"`\\])/g, '$1');

/**
 * A table copy without the parts the code builds (`${…}`), which are its own,
 * so the literal rest is still held to the index; null for an index built so.
 */
function literalPart(statement: string): string | null {
  if (!statement.includes('${')) return statement;
  if (CREATE.exec(statement)![2]!.toUpperCase() === 'INDEX') return null;
  const open = statement.indexOf('(');
  const close = statement.lastIndexOf(')');
  const parts: string[] = [];
  let depth = 0;
  let from = open + 1;
  for (let at = from; at <= close; at += 1) {
    if (statement[at] === '(') depth += 1;
    else if (statement[at] === ')') depth -= 1;
    if ((statement[at] === ',' && depth === 0) || at === close) {
      parts.push(statement.slice(from, at));
      from = at + 1;
    }
  }
  const literal = parts.filter((part) => !part.includes('${'));
  return `${statement.slice(0, open + 1)}${literal.join(',')})`;
}

/** Whether a statement is about the index: one of its tables, or an index on one. */
function isAboutTheIndex(statement: string, name: string): boolean {
  if (CANONICAL.tables.has(name) || CANONICAL.statements.has(name)) return true;
  const table = ON_TABLE.exec(statement)?.[1];
  return CREATE.exec(statement)![2]!.toUpperCase() === 'INDEX' && CANONICAL.tables.has(table ?? '');
}

/** The CREATE TABLE and CREATE INDEX statements in a file that copy the index's own. */
export function inlineCopies(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(new RegExp(CREATE.source, 'gi'))) {
    const statement = statementAt(text, match.index);
    if (statement === null || !isAboutTheIndex(statement, match[3]!)) continue;
    const literal = literalPart(unescaped(statement));
    if (literal !== null) found.push(literal);
  }
  return found;
}

/** A copy that is not SQL after all (a pattern that matches a statement, say): SQL a test runs fails that test. */
export const UNREADABLE: readonly string[] = ['unreadable'];

/** What a copy of a table or index says that the index's own does not. */
export function driftOf(statement: string): readonly string[] {
  const [, virtual, kind, name] = CREATE.exec(statement)!;
  if (kind!.toUpperCase() === 'INDEX' || virtual !== undefined) {
    const own = CANONICAL.statements.get(name!);
    if (own === undefined) return [`${name}: an index the host does not make`];
    const shape = shapeOf(statement);
    if (shape !== own) return [`${name}: ${shape}`];
    if (kind!.toUpperCase() === 'INDEX') return [];
  }
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(statement);
  } catch {
    return UNREADABLE;
  }
  const own = CANONICAL.tables.get(name!)!;
  const byName = new Map(own.columns.map((column) => [column.name, column]));
  const uniques = uniquesOf(database, name!).filter((unique) => !own.uniques.includes(unique));
  return [
    ...columnsOf(database, name!).flatMap((column) => columnDrift(name!, column, byName)),
    ...uniques.map((unique) => `${name}: UNIQUE (${unique}), which the index has not`),
  ];
}

function columnDrift(table: string, column: Column, own: ReadonlyMap<string, Column>): string[] {
  const theirs = own.get(column.name);
  const at = `${table}.${column.name}`;
  if (theirs === undefined) return [`${at}: not in the index`];
  if (theirs.type !== column.type) return [`${at}: ${column.type}, not ${theirs.type}`];
  // Without the host's key a REPLACE keeps both rows; with one of its own a copy refuses what the host takes.
  if (theirs.pk !== column.pk) return [`${at}: primary key ${column.pk}, not ${theirs.pk}`];
  // Looser than the host's is only a fixture that takes less care; stricter would hide a null the host can hold.
  if (column.notnull > theirs.notnull) return [`${at}: NOT NULL, and the index's is not`];
  // No default is a fixture that always says, and one on a column the host makes every row
  // name is only a convenience; another default, or one where the host leaves null, is not.
  const named = theirs.notnull === 1 && theirs.dflt_value === null;
  if (column.dflt_value !== null && column.dflt_value !== theirs.dflt_value && !named) {
    return [`${at}: DEFAULT ${column.dflt_value}, not ${theirs.dflt_value}`];
  }
  return [];
}

/** What the copies a file holds say that the index's own do not. */
export const driftIn = (text: string) => inlineCopies(text).flatMap(driftOf);

/** Rust source without its `#[cfg(test)]` modules, whose tables (an index of an older shape, say) are tests'. */
function withoutTestModules(source: string): string {
  let kept = source;
  for (;;) {
    const at = kept.search(/#\[cfg\(test\)\]\s*mod\s+\w+\s*\{/);
    if (at === -1) return kept;
    let depth = 0;
    let end = kept.indexOf('{', at);
    for (; end < kept.length; end += 1) {
      if (kept[end] === '{') depth += 1;
      else if (kept[end] === '}' && --depth === 0) break;
    }
    kept = kept.slice(0, at) + kept.slice(end + 1);
  }
}

/** The CREATE TABLE and CREATE INDEX statements the host's own code holds besides the schema file. */
export function hostCopies(rustSource: string): string[] {
  return [
    ...withoutTestModules(rustSource).matchAll(
      /CREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:UNIQUE\s+)?(?:VIRTUAL\s+)?(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?\w/gi,
    ),
  ].map((match) => match[0]);
}
