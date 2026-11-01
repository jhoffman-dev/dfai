import type { HighlightRow, NoteVersion, VaultPath } from '@dfai/domain';
import type { WrittenAt } from '../vault/ports.ts';

/**
 * A type's SQL view as the index is told to make it: its name and the
 * `SELECT` it holds (`typeViewSelectSql`). The index only runs the text, so
 * how a cell is read stays TypeScript's (ADR-0005).
 */
export interface ViewTypeSpec {
  readonly name: string;
  readonly select: string;
}

export interface QueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  /** True when the row cap stopped the result short. */
  readonly truncated: boolean;
}

/**
 * What the index knows about a file: enough to tell whether it needs reading
 * again, and — its version — whether its text changed and what it was (P28-03).
 */
export interface IndexEntry extends NoteVersion {
  readonly path: string;
  readonly modified: number;
  readonly size: number;
}

export interface IndexedLinkRow {
  /** The link exactly as written. */
  readonly target: string;
  /** The last part of the target as links fold it (`linkLeaf`), for finding the link again (#431). */
  readonly leaf: string;
  /** The note it resolves to, or null when it points nowhere yet. */
  readonly path: string | null;
  readonly kind: 'wikilink' | 'markdown';
}

export interface IndexedNote extends NoteVersion, WrittenAt {
  readonly path: string;
  readonly title: string;
  /** Its file's version, as the vault reports it; when it was written is `writtenAt` of it (ADR-0053). */
  readonly modified: number;
  readonly size: number;
  /** Words with the markup removed, for searching. */
  readonly body: string;
  /** The opening line, for showing what a note is about without opening it. */
  readonly summary: string;
  readonly properties: readonly {
    readonly key: string;
    readonly index: number;
    readonly text: string | null;
    readonly number: number | null;
    readonly date: string | null;
    readonly json: string | null;
  }[];
  readonly links: readonly IndexedLinkRow[];
  /** Every use of a tag, frontmatter first, in the order written. */
  readonly tags: readonly IndexedTagRow[];
  /** Every link a property holds, resolved here so the host only stores it (ADR-0019). */
  readonly relations: readonly IndexedRelationRow[];
  /** Every block with an id (P26-01), read here so the host only stores it. */
  readonly blocks: readonly IndexedBlockRow[];
  /** Every checklist box (P30-03), in the order written, read here so the host only stores it. */
  readonly checks: readonly IndexedCheckRow[];
  /** How far through its checklist the note is, worked out here (`checklistProgress`); null with no box. */
  readonly progress: number | null;
  /** A literature note's highlights (#503), in the order written, read here so the host only stores them. */
  readonly highlights: readonly IndexedHighlightRow[];
}

/** A highlight in a literature note (ADR-0043), as the research views and search ask for it. */
export type IndexedHighlightRow = HighlightRow;

/** A box in a note's checklist: ticked or not, and the words on its line. */
export interface IndexedCheckRow {
  readonly done: boolean;
  readonly text: string;
}

/** A block a `#^id` can name: its id, and a line of what it says. */
export interface IndexedBlockRow {
  readonly id: string;
  readonly text: string;
}

export interface IndexedRelationRow {
  readonly key: string;
  readonly index: number;
  /** The link's target as written. */
  readonly target: string;
  /** The target as links compare it loosely — composed, no extension, case folded. */
  readonly name: string;
  /** The note it resolves to, or null when it points nowhere yet. */
  readonly path: string | null;
}

export interface IndexedTagRow {
  /** What makes it the same tag as another, case aside. */
  readonly key: string;
  /** As written here. */
  readonly name: string;
}

export interface SearchHit {
  readonly path: string;
  readonly title: string;
  /** The matching text with `<<` and `>>` around the words that matched. */
  readonly snippet: string;
  /** For a highlight in the note that matched (#507), its block id: the hit opens there. */
  readonly block?: string;
}

/**
 * Which notes a search leaves out, by where they are. The host is handed the
 * prefix and obeys it; which prefix, and when, is decided here (ADR-0014).
 */
export interface SearchScope {
  /** Notes whose path starts with this, compared in lower case, are not searched. */
  readonly skipPrefix?: string;
  /** Whether the highlights in literature notes are searched too, after the notes (#507). */
  readonly highlights?: boolean;
}

export interface IndexStats {
  readonly notes: number;
  readonly properties: number;
  readonly links: number;
}

/**
 * The derived index. Everything in it restates what the markdown files already
 * say, so it can be thrown away and rebuilt at any time.
 */
/** What opening the index found. */
export interface IndexOpening {
  /**
   * True when the host made the index just now — there was none, or it threw
   * away one of an older shape — so it holds nothing of the vault yet.
   */
  readonly fresh: boolean;
}

/**
 * Which vault a write to the index was meant for. The host holds one index,
 * the open vault's; a batch read from a vault that has since been switched
 * away from names that vault, and is refused rather than written to the next
 * one's index (#135).
 */
export interface IndexWriteScope {
  readonly vault: string;
}

export interface IndexPort {
  open(): Promise<IndexOpening>;
  clear(): Promise<void>;
  manifest(): Promise<readonly IndexEntry[]>;
  /** With a `scope`, refused once the index open is another vault's than the notes were read from. */
  put(notes: readonly IndexedNote[], scope?: IndexWriteScope): Promise<void>;
  remove(paths: readonly VaultPath[], scope?: IndexWriteScope): Promise<void>;
  search(query: string, limit: number, scope?: SearchScope): Promise<readonly SearchHit[]>;
  /** Notes whose frontmatter declares this type — what a relation may point at. */
  notesOfType(type: string): Promise<readonly { path: string; title: string }[]>;
  /** Rebuilds the SQL view behind each type, after a type definition changes. */
  rebuildViews(types: readonly ViewTypeSpec[]): Promise<void>;
  /** Runs a query on a read-only connection. Cannot change anything. */
  query(sql: string, parameters: readonly (string | number | null)[]): Promise<QueryResult>;
  backlinks(path: VaultPath): Promise<readonly string[]>;
  stats(): Promise<IndexStats>;
}
