import { mkdir, rename, writeFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve as resolvePath, sep } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { createGitStub, type GitStub } from './git-host.ts';
import { makeTempFolder, removeWithTempFolders } from './temp-folders.ts';

/** The host commands sync runs through (`git_process.rs`), answered by the git stub. */
/** What a stubbed command answers to reject with a value, as Tauri does for a command's `Err`. */
const REJECT = '__atlasReject';

const SYNC_COMMANDS = new Set([
  'git_run',
  'git_run_in',
  'gh_repo_create',
  'gh_repo_list',
  'git_sync_file_read',
  'git_sync_file_write',
  'this_mac_name',
]);

/**
 * A stand-in for the Rust host, backed by a real directory on disk. It answers the
 * same four commands over the same IPC shape, so the frontend under test is the
 * real one. The production implementation and its guards live in src-tauri/vault.rs.
 */
export interface FakeVault {
  root: string;
  write(relativePath: string, contents: string): Promise<void>;
  mkdir(relativePath: string): Promise<void>;
  read(relativePath: string): Promise<string>;
  /** Whether anything — a note or a folder — is at this path. */
  exists(relativePath: string): Promise<boolean>;
  isFolder(relativePath: string): Promise<boolean>;
}

export async function createVault(): Promise<FakeVault> {
  const root = await makeTempFolder('atlas-e2e-');
  return {
    root,
    async write(relativePath, contents) {
      // Beside the file, then over it, as the Rust host writes: a plain
      // writeFile truncates first, so an app read landing in between would see
      // an empty file the real host never produces. Its own suffix so it never
      // collides with the app's temporary for the same note.
      const file = join(root, relativePath);
      const temporary = join(dirname(file), `.${basename(file)}.e2e-tmp`);
      await writeFile(temporary, contents, 'utf8');
      await rename(temporary, file);
    },
    async mkdir(relativePath) {
      await mkdir(join(root, relativePath), { recursive: true });
    },
    async read(relativePath) {
      const { readFile } = await import('node:fs/promises');
      try {
        return await readFile(join(root, relativePath), 'utf8');
      } catch {
        // Empty rather than thrown: expect.poll stops at the first throw, so a
        // file that has not been written *yet* would fail instead of retrying.
        return '';
      }
    },
    async exists(relativePath) {
      return (await stat(join(root, relativePath)).catch(() => null)) !== null;
    },
    async isFolder(relativePath) {
      return (await stat(join(root, relativePath)).catch(() => null))?.isDirectory() === true;
    },
  };
}

function containedPath(root: string, relative: string): string {
  const target = resolvePath(root, relative);
  if (target !== root && !target.startsWith(root + sep)) throw new Error('path escapes the vault');
  return target;
}

interface StoredNote {
  path: string;
  title: string;
  summary: string;
  /** When the file last changed, which the real view carries for a feed's order. */
  modified?: number;
  /** How far through its checklist the note is, as the app worked it out (P30-03). */
  progress?: number | null;
  size?: number;
  /** What the app digested of its text, which the manifest hands back (ADR-0012). */
  digest?: string;
  /** The type its frontmatter declares, which the manifest hands back. */
  type?: string | null;
  body: string;
  links: { target: string; leaf: string; path: string | null }[];
  /** Every use of a tag, as the app found it. */
  tags?: { key: string; name: string }[];
  /** Every link a property holds, and the note the app resolved it to. */
  relations?: { key: string; index: number; target: string; name: string; path: string | null }[];
  properties: {
    key: string;
    index?: number;
    text: string | null;
    number?: number | null;
    date?: string | null;
  }[];
  /** A literature note's highlights, as the app read them (#503). */
  highlights?: {
    id: string;
    kind: string;
    quote: string;
    comment: string;
    mark: string;
    color: string;
    anchor: string;
  }[];
}

/** A declared property as the index is told it, to become a column of its type's view. */
interface ViewColumn {
  key: string;
  kind: string;
  many: boolean;
}

/** A type's view as the index is told to build it. */
interface ViewSpec {
  columns: readonly ViewColumn[];
  /** Whether it carries each note's checklist progress. */
  progress: boolean;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A statement written by hand, run for real by SQLite over what was indexed.
 *
 * The tables are the real index's (`files`, `props`, `relations`), and each `v_<type>` view
 * is built the way `rebuild_views` in `src-tauri/src/index.rs` builds it: its
 * own `path`, `title`, `summary` and `modified` (and `progress`, when told
 * to carry it), then a column per declared
 * property — a number's from `value_num`, a date's from `value_date`, the rest
 * from `value_text`, several values joined with ", ". A key the type does not
 * declare is not a column, as in the app. The read-only guard is reduced to
 * "reads only" — the real guard (the authorizer and `readonly`) is the Rust
 * tests' to prove. A compiled view that reads `relations` runs here too, with
 * what it binds.
 */
function runHandWrittenSql(
  statement: string,
  notes: Iterable<StoredNote>,
  types: ReadonlyMap<string, ViewSpec>,
  bound: readonly unknown[] = [],
): { columns: string[]; rows: unknown[][]; truncated: boolean } {
  if (!/^\s*(SELECT|WITH|PRAGMA)\b/i.test(statement)) {
    throw new Error('only a statement that reads the index can run here');
  }
  const stored = [...notes];
  const database = filesAndProps(stored);
  database.exec(`CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                                         target TEXT NOT NULL, name TEXT NOT NULL, dst TEXT);`);
  const relation = database.prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?)');
  for (const note of stored) {
    for (const row of note.relations ?? []) {
      relation.run(note.path, row.key, row.index, row.target, row.name, row.path);
    }
  }
  for (const [type, spec] of types) {
    if (!IDENTIFIER.test(type)) continue;
    const progress = spec.progress ? ', files.progress AS "progress"' : '';
    const columns = spec.columns
      .filter((column) => IDENTIFIER.test(column.key))
      .map((column) => {
        const source =
          column.kind === 'number'
            ? 'props.value_num'
            : column.kind === 'date'
              ? 'props.value_date'
              : 'props.value_text';
        const picked = `CASE WHEN props.key = '${column.key}' THEN ${source} END`;
        const aggregate = column.many ? `group_concat(${picked}, ', ')` : `MAX(${picked})`;
        return `, ${aggregate} AS "${column.key}"`;
      })
      .join('');
    database.exec(`
      CREATE VIEW "v_${type}" AS
      SELECT files.path AS "path",
             COALESCE(MAX(CASE WHEN props.key = 'title' THEN props.value_text END), files.title) AS "title",
             files.summary AS "summary",
             files.modified AS "modified"${progress}${columns}
      FROM files JOIN props ON props.path = files.path
      WHERE files.path IN (SELECT path FROM props WHERE key = 'type' AND value_text = '${type}')
      GROUP BY files.path;`);
  }
  const prepared = database.prepare(statement);
  const columns = prepared.columns().map((column) => column.name);
  const rows = (
    prepared.all(...(bound as (string | number | null)[])) as Record<string, unknown>[]
  ).map((row) => columns.map((column) => row[column] ?? null));
  database.close();
  return { columns, rows, truncated: false };
}

/** The index's `files` and `props` tables, filled from what the app indexed, in SQLite. */
function filesAndProps(notes: Iterable<StoredNote>): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER NOT NULL, size INTEGER NOT NULL, progress INTEGER);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);`);
  const file = database.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?)');
  const prop = database.prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, NULL)');
  for (const note of notes) {
    file.run(
      note.path,
      note.title,
      note.summary ?? '',
      note.modified ?? 0,
      note.size ?? 0,
      note.progress ?? null,
    );
    for (const property of note.properties ?? []) {
      prop.run(
        note.path,
        property.key,
        property.index ?? 0,
        property.text,
        property.number ?? null,
        property.date ?? null,
      );
    }
  }
  return database;
}

/** A compiled statement over `files` and `props` — the Archive's, a meeting's, the Inbox's — run for real by SQLite with what it binds. */
function runArchiveQuery(
  statement: string,
  bound: readonly unknown[],
  notes: Iterable<StoredNote>,
): { columns: string[]; rows: unknown[][]; truncated: boolean } {
  const database = filesAndProps(notes);
  const prepared = database.prepare(statement);
  const columns = prepared.columns().map((column) => column.name);
  const rows = (
    prepared.all(...(bound as (string | number | null)[])) as Record<string, unknown>[]
  ).map((row) => columns.map((column) => row[column] ?? null));
  database.close();
  return { columns, rows, truncated: false };
}

/**
 * A DFAI query the app compiled (`/* atlas-query *\/`), run for real by
 * SQLite over the tables `src-tauri/src/index.rs` makes — files, props,
 * relations, links and tags — filled from what the app indexed.
 */
function runAtlasQuery(
  statement: string,
  bound: readonly unknown[],
  notes: Iterable<StoredNote>,
): { columns: string[]; rows: unknown[][]; truncated: boolean } {
  const database = atlasDatabase([...notes]);
  try {
    return answerFrom(database, statement, bound);
  } finally {
    database.close();
  }
}

/** The tables `src-tauri/src/index.rs` makes — files, props, relations, links, tags — filled from what the app indexed. */
function atlasDatabase(stored: readonly StoredNote[]): DatabaseSync {
  const database = filesAndProps(stored);
  database.exec(`
    CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                            target TEXT NOT NULL, name TEXT NOT NULL, dst TEXT);
    CREATE TABLE links (src TEXT NOT NULL, dst TEXT, target TEXT NOT NULL, kind TEXT NOT NULL,
                        leaf TEXT NOT NULL DEFAULT '');
    CREATE TABLE tags (path TEXT NOT NULL, idx INTEGER NOT NULL, tag TEXT NOT NULL,
                       name TEXT NOT NULL);`);
  const relation = database.prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?)');
  const link = database.prepare("INSERT INTO links VALUES (?, ?, ?, 'wikilink', ?)");
  const tag = database.prepare('INSERT INTO tags VALUES (?, ?, ?, ?)');
  for (const note of stored) {
    for (const row of note.relations ?? []) {
      relation.run(note.path, row.key, row.index, row.target, row.name, row.path);
    }
    for (const row of note.links ?? []) link.run(note.path, row.path, row.target, row.leaf);
    (note.tags ?? []).forEach((use, at) => tag.run(note.path, at, use.key, use.name));
  }
  return database;
}

/** A compiled statement's answer from `database`, run for real with what it binds. */
function answerFrom(
  database: DatabaseSync,
  statement: string,
  bound: readonly unknown[],
): { columns: string[]; rows: unknown[][]; truncated: boolean } {
  const prepared = database.prepare(statement);
  const columns = prepared.columns().map((column) => column.name);
  const rows = (
    prepared.all(...(bound as (string | number | null)[])) as Record<string, unknown>[]
  ).map((row) => columns.map((column) => row[column] ?? null));
  return { columns, rows, truncated: false };
}

/**
 * The research views' tables (#507) — the index's, and its `highlights` —
 * made once for what the app has indexed and kept until it indexes again:
 * the views read a page at a time, and remaking 20,000 highlights for each
 * page would time the stand-in rather than the app.
 */
function researchTables(): (writes: number, notes: Iterable<StoredNote>) => DatabaseSync {
  let kept: { writes: number; database: DatabaseSync } | null = null;
  return (writes, notes) => {
    if (kept?.writes === writes) return kept.database;
    kept?.database.close();
    const stored = [...notes];
    const database = atlasDatabase(stored);
    fillHighlights(database, stored);
    // The indexes `src-tauri/src/index.rs` makes on what these views read by note.
    database.exec(`
      CREATE INDEX props_path ON props(path, key, value_text);
      CREATE INDEX tags_path ON tags(path);
      CREATE INDEX relations_src ON relations(src, key);
      CREATE INDEX highlights_path_idx ON highlights(path, idx);`);
    kept = { writes, database };
    return database;
  };
}

/** The words around the last term searched for, marked as the index marks them. */
function snippetOf(text: string, terms: readonly string[]): string {
  const last = terms[terms.length - 1] ?? '';
  const at = text.toLowerCase().indexOf(last);
  return at === -1
    ? text.slice(0, 60)
    : `${text.slice(Math.max(0, at - 20), at)}<<${text.slice(at, at + last.length)}>>${text.slice(at + last.length, at + last.length + 30)}`;
}

/** A term of a search as `toSearchQuery` writes it: quoted, and a prefix when it ends in `*`. */
interface SearchTerm {
  readonly word: string;
  readonly prefix: boolean;
}

/** The words of `text` as the index folds them: accents off, case folded, split off anything that is not a letter or digit. */
const searchWords = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');

/**
 * The highlights whose quote or comment hold every term, each naming its note
 * and block, as index.rs answers them: whole words, and only the term marked
 * as a prefix may be the start of one (FTS5 has no "contains"), at most `limit`.
 */
function highlightHits(
  notes: readonly StoredNote[],
  { terms, skip, limit }: { terms: readonly SearchTerm[]; skip: string | null; limit: number },
): { path: string; title: string; snippet: string; block: string }[] {
  const words = terms.map((term) => ({ ...term, word: searchWords(term.word).join(' ') }));
  return notes
    .filter((note) => skip === null || !note.path.toLowerCase().startsWith(skip))
    .flatMap((note) =>
      (note.highlights ?? []).flatMap((each) => {
        const text = `${each.quote} ${each.comment}`;
        const held = searchWords(text);
        const found = words.every(({ word, prefix }) =>
          held.some((have) => (prefix ? have.startsWith(word) : have === word)),
        );
        if (!found) return [];
        return [
          {
            path: note.path,
            title: note.title,
            snippet: snippetOf(
              text,
              terms.map((term) => term.word.toLowerCase()),
            ),
            block: each.id,
          },
        ];
      }),
    )
    .slice(0, limit);
}

/** The index's `highlights` table, filled from what the app indexed (#503): what the research views read. */
function fillHighlights(database: DatabaseSync, notes: readonly StoredNote[]): void {
  database.exec(`
    CREATE TABLE highlights (path TEXT NOT NULL, idx INTEGER NOT NULL, id TEXT NOT NULL,
                             kind TEXT NOT NULL, quote TEXT NOT NULL, comment TEXT NOT NULL,
                             mark TEXT NOT NULL, color TEXT NOT NULL, anchor TEXT NOT NULL);`);
  const row = database.prepare('INSERT INTO highlights VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const note of notes) {
    (note.highlights ?? []).forEach((each, at) =>
      row.run(
        note.path,
        at,
        each.id,
        each.kind,
        each.quote,
        each.comment,
        each.mark,
        each.color,
        each.anchor,
      ),
    );
  }
}

/**
 * A tag query the app compiled (`/* tags:… *\/`), run for real by SQLite over
 * the tags the app indexed — the same tables `src-tauri/src/index.rs` makes.
 */
function runTagQuery(
  statement: string,
  bound: readonly unknown[],
  notes: Iterable<StoredNote>,
): { columns: string[]; rows: unknown[][]; truncated: boolean } {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER NOT NULL, size INTEGER NOT NULL);
    CREATE TABLE tags (path TEXT NOT NULL, idx INTEGER NOT NULL, tag TEXT NOT NULL,
                       name TEXT NOT NULL);`);
  const file = database.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?)');
  const tag = database.prepare('INSERT INTO tags VALUES (?, ?, ?, ?)');
  for (const note of notes) {
    file.run(note.path, note.title, note.summary ?? '', note.modified ?? 0, note.size ?? 0);
    (note.tags ?? []).forEach((use, at) => tag.run(note.path, at, use.key, use.name));
  }
  const prepared = database.prepare(statement);
  const columns = prepared.columns().map((column) => column.name);
  const rows = (
    prepared.all(...(bound as (string | number | null)[])) as Record<string, unknown>[]
  ).map((row) => columns.map((column) => row[column] ?? null));
  database.close();
  return { columns, rows, truncated: false };
}

/**
 * One of the sidebar's five sections, for opening what it lists. Rows are
 * looked up inside a section so a view called Board and a note called Board.md
 * are told apart by where they are shown rather than by their names.
 */
export function sidebarSection(
  page: Page,
  section: 'favorites' | 'types' | 'views' | 'dashboards' | 'userSpace',
) {
  return page.locator(`#sidebar-${section}`);
}

/** A request as a tool would send it to the local API, before the host gives it an id. */
export interface ApiCall {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

/** What the app answered over `api_respond`. */
export interface ApiAnswer {
  status: number;
  body: Record<string, unknown>;
}

/** The port the stub host reports while the API is on. */
export const STUB_API_PORT = 47_310;

/** What a test can do to the host once it is installed. */
export interface FakeHost {
  /** Makes the folder picker answer with this vault from now on, for switching vaults. */
  offer(vault: FakeVault): void;
  /** Makes the folder picker answer with any folder: where a clone from GitHub goes. */
  offerFolder(folder: string): void;
  /** GitHub and the Mac's git, for sync (U-29): real git, against bare repositories on disk. */
  readonly git: GitStub;
  /**
   * The local API, as the Rust host would drive it: `send` emits `api-request`
   * and settles with what the app answered through `api_respond`. Refused while
   * the API is off, as the real server is not listening then, and waits (then
   * fails) while no router has said it listens, as the server refuses then.
   */
  readonly api: {
    send(call: ApiCall): Promise<ApiAnswer>;
    enabled(): boolean;
    token(): string;
  };
  /** How many times the app has asked the host to write this file, creates and refused writes included. */
  writesTo(relativePath: string): number;
  /** How many times the app has asked the host for this command. */
  callsTo(command: string): number;
  /** How many `vault-changed` events `echoWrites` has sent of the app's own writes. */
  echoesSent(): Promise<number>;
  /**
   * Keeps the echo of the app's own writes from being sent, in the page now
   * open, until the returned function is called: a test can let the app
   * finish what it asked for its own writes before the watcher reports them.
   */
  holdEchoes(): Promise<() => Promise<void>>;
  /** Makes the next call of this command fail with this message, as the Rust host would answer `Err`. */
  failNext(command: string, message: string): void;
  /**
   * The Activity log's file for the vault open now, as `activity.rs` keeps it
   * in the app's data folder — here, in memory, one per vault.
   */
  activityLog(): string;
  /** Puts lines in a vault's Activity log before the app reads it, as an earlier session would have. */
  seedActivity(root: string, text: string): void;
  /**
   * Lets this many more batches into the index and holds the next in flight
   * until the returned function is called, so a test can act on a window whose
   * vault is still being indexed without racing the build (#135).
   */
  holdIndexAfter(batches: number): () => void;
  /**
   * Holds every write to this file in flight until the returned function is
   * called, so an editor's save can be caught mid-way without racing a timer.
   * Called with `{ fail }`, the writes held are refused with that message, as
   * the Rust host answers `Err`, and write nothing.
   */
  holdWrites(relativePath: string): (outcome?: { readonly fail: string }) => void;
  /**
   * Holds every read of this file in flight — on its own or in a batch —
   * until the returned function is called, so a test can make one of the
   * app's reads land late without racing a timer (#130). A batch that also
   * reads `except` is let through: held from before the vault opens, the
   * index's own read of every note (which reads `except` too) goes ahead.
   * With `alone`, only a read of this file by itself is held: the index reads
   * notes in batches, in the walk's order, so no one note is sure to share its.
   */
  holdReads(
    relativePath: string,
    options?: { readonly except?: string; readonly alone?: boolean },
  ): () => void;
  /** What the app has put in the Trash, by vault path, in order. */
  trashed(): readonly string[];
  /** Every link the app asked the host to open in the browser, in order. */
  openedLinks(): readonly string[];
  /**
   * Exports (#501), as `export.rs` makes them: the save dialog answers with
   * a file of the name it offered — or a new folder, for several notes — in
   * `root`, a folder beside the vault; `cancelNext` makes it answer as a
   * person cancelling would. A PDF is the stub's (`%PDF-` and the page's
   * length); the real one is WebKit's, tested in `tests/pdf_export.rs`.
   */
  readonly exports: {
    readonly root: string;
    cancelNext(): void;
    /** Every page the app asked to be made a PDF, in order. */
    pdfPages(): readonly string[];
  };
  /**
   * Every page the app asked the host to picture (`snapshot_page`), in order.
   * The stub pictures each as `STUB_THUMBNAIL`, or refuses with `failWith`.
   */
  readonly snapshots: {
    pages(): readonly string[];
    failWith(reason: string | null): void;
    /** Holds every picture until the returned function is called, to catch one being made. */
    hold(): () => void;
  };
  /**
   * The Keychain, as `secrets.rs` keeps it for the open vault. `answers` is
   * every reply the stub has sent the app since the first secret was set, so a
   * test can check that no value ever came back across the boundary.
   */
  readonly secrets: {
    names(): readonly string[];
    answers(): string;
    /** Every request `http_get` was handed, exactly as the app sent it. */
    requests(): readonly unknown[];
  };
  /**
   * Claude Code, as `model_process.rs` runs it: `auth status` answers whether
   * it is logged in, and each turn (`-p`) streams the next scripted reply as
   * stream-json, split into small pieces so a tool call arrives across
   * several. The host's own guards — the fixed argument shape, finding the
   * program — are Rust's and tested there.
   */
  readonly claude: {
    reply(...texts: string[]): void;
    loggedIn(yes: boolean): void;
    runs(): readonly { args: readonly string[]; stdin: string }[];
    /**
     * Settles once every run's output has reached the page, or stopped
     * because the window closed; rejects if sending it failed otherwise.
     */
    delivered(): Promise<void>;
  };
  /**
   * Google Calendar, as `google.rs` answers for it: a sign-in kept per vault,
   * and the Calendar API's calendar list and calendar insert. The sign-in
   * itself — the browser, PKCE, the Keychain — is Rust's and tested there
   * against a fake Google. `refuseNext` makes the next connect fail the way
   * the host reports a failure: rejected with `{ kind, code, message }`.
   */
  readonly google: {
    refuseNext(failure: { kind: string; code?: string; message: string }): void;
    connected(): boolean;
    calendars(): readonly string[];
  };
  /**
   * Granola, as `granola.rs` answers for it: an API key kept per vault, and a
   * GET under `/v1/` answered with what a test served at that path (404 where
   * nothing was). The last answer is the word on the key, as the host keeps
   * it: a 401 marks the key refused and any other answer clears that.
   * Setting a key clears it and then checks the key with one
   * `GET /v1/notes?page_size=1`, recorded among the requests, whose answer
   * stands. The Keychain item, the pinned origin and the key struck from
   * every answer are Rust's and tested there against a fake Granola.
   */
  readonly granola: {
    serve(path: string, answer: { status: number; body: string }): void;
    hasKey(): boolean;
    requests(): readonly { path: string; query: Readonly<Record<string, string>> }[];
  };
  /**
   * Kindle, as `kindle.rs` answers for it (#508): Connect makes the session
   * at once (the sign-in window, its own WebKit store and the hidden window
   * are AppKit's and checked by hand), Disconnect deletes it, and each
   * notebook fetch is answered with the page served for its address: the
   * library, or a book's annotations by ASIN and next-page token (`''` for
   * the first). With no session a fetch is refused as `not_connected`; after
   * `signOut` every page is Amazon's sign-in, as a lapsed session is sent.
   */
  readonly kindle: {
    serveLibrary(html: string): void;
    serveAnnotations(asin: string, token: string, html: string): void;
    signOut(): void;
    connected(): boolean;
    /** Every address the app asked the host to fetch, in order. */
    fetches(): readonly string[];
  };
  /**
   * The global capture shortcut, as `global_capture.rs` holds it: what the app
   * asked to register, and a press, delivered as the host's `global-capture`
   * event after it has brought the window forward. Raising the window and the
   * system's own registration are Rust's, and tested and checked there.
   */
  readonly globalCapture: {
    registered(): string | null;
    press(): Promise<void>;
  };
  /**
   * How long this Mac has slept since it booted, as `sleep_clock.rs` reads it
   * (#172). It moves only when `sleep` says the Mac slept, as a real sleep
   * moves it; the reading itself, from the kernel's clocks, is Rust's and
   * tested there.
   */
  readonly sleepClock: {
    sleep(milliseconds: number): void;
  };
  /** SQLite files a source may read, by the name the note gives, and what the picker offers. */
  readonly sqlite: {
    serve(file: string, rows: { columns: string[]; rows: unknown[][] }): void;
    offer(path: string | null): void;
    queries(): readonly { file: string; sql: string }[];
  };
}

/** A request part as `secrets.rs` reads it: text, or the name of a secret. */
type RequestPart = { text: string } | { secret: string };

/**
 * A real PNG of one flat colour, as the snapshot stub answers with: the
 * picture itself is the Rust host's (`page_snapshot.rs`, tested there); this
 * stands in for it so the app's handling of one can be driven end to end.
 */
export function solidPng(width: number, height: number, [r, g, b]: readonly number[]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.byteLength);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill([r, g, b]).flat())]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** What the stub pictures every page as: 16 × 10, a colour no page in the tests uses. */
export const STUB_THUMBNAIL = solidPng(16, 10, [214, 40, 160]);

export async function installHost(
  page: Page,
  vault: FakeVault,
  {
    feeds = {},
    echoWrites = false,
    coarseTickSeconds,
  }: {
    /**
     * Canned feeds by URL, for sources that fetch rather than read a file. The
     * object is read on every call, so a test can change what a feed says between
     * refreshes by writing to it.
     */
    feeds?: Record<string, string>;
    /**
     * Reports the app's own writes back as `vault-changed`, as the real
     * watcher does: the paths a write touched (a save's temporary beside its
     * note as well), collected until 400 ms pass with none, then sent once
     * (`watcher.rs`). Off by default: the e2e suite was written against a
     * host whose watcher heard only what a test said changed.
     */
    echoWrites?: boolean;
    /**
     * A disk whose clock is coarse (#245): every note the app saves is left at
     * this one second, as a save within the same tick of HFS+ leaves it. Off
     * by default.
     */
    coarseTickSeconds?: number;
  } = {},
): Promise<FakeHost> {
  /** What the picker answers with. */
  let offered = vault.root;
  // One current root, as `VaultState` holds, and every path is resolved against
  // it. Resolving against the vault a test started with instead is what hid
  // writes that arrive after a switch and land in the other vault (R14-01).
  let open: string | null = null;
  const openRoot = (): string => {
    if (open === null) throw new Error('no vault is open');
    return open;
  };
  /** Where a write lands: refused when it names a vault that is no longer open, as `root_for_write` does. */
  const writeRoot = (args: unknown): string => {
    const root = openRoot();
    const meant = (args as { vault?: string } | undefined)?.vault;
    if (meant !== undefined && meant !== root) {
      throw new Error('another vault was opened before this could be written');
    }
    return root;
  };
  // A stand-in for the SQLite index: enough behaviour to drive the interface.
  // The real queries are covered by the Rust tests.
  const indexed = new Map<string, StoredNote>();
  // How many times what was indexed changed, so a table made from it knows when it is stale.
  let indexWrites = 0;
  const research = researchTables();
  const views = new Map<string, ViewSpec>();
  // A build of the index stopped part-way (`holdIndexAfter`), so a test can act while one is under way.
  let indexPuts = 0;
  let indexPutsBeforeHold = Infinity;
  let indexHeld: Promise<void> = Promise.resolve();

  // The local API's switch and token, as src-tauri/src/api keeps them. The
  // server itself — authentication, the Host and Origin checks, the port — is
  // Rust's and is tested there; this answers the commands the app calls.
  const api = { enabled: false, token: 'token-1', rotations: 0, file: '/stub/api.json' };
  /**
   * The routers that said they listen (`api_router_ready`), by the id each
   * named. The real host refuses every request while this is empty (#158).
   */
  const routerListeners = new Set<unknown>();
  const apiStatus = () => ({
    enabled: api.enabled,
    port: api.enabled ? STUB_API_PORT : null,
    running: api.enabled,
    file: api.file,
  });
  /** Requests sent to the app and not yet answered, by id. */
  const waiting = new Map<string, (answer: ApiAnswer) => void>();
  let nextRequest = 0;
  const writes = new Map<string, number>();
  /** Files whose writes wait, and what lets them go. */
  const held = new Map<string, Promise<void>>();
  /** Files whose reads wait, and what lets them go. */
  const heldReads = new Map<
    string,
    { until: Promise<void>; except: string | undefined; alone: boolean }
  >();
  /** What a read of these files waits for: each held one's release, unless the batch is excepted. */
  const readsHeld = (paths: readonly string[]) =>
    Promise.all(
      paths.map((relative) => {
        const hold = heldReads.get(relative);
        return hold === undefined ||
          (hold.except !== undefined && paths.includes(hold.except)) ||
          (hold.alone && paths.length > 1)
          ? undefined
          : hold.until;
      }),
    );
  const countWrite = (relative: string) => writes.set(relative, (writes.get(relative) ?? 0) + 1);
  /** The last text write, which the next one waits for. */
  let textWriteTail: Promise<unknown> = Promise.resolve();
  /**
   * Runs one text write at a time, whatever file it names. The host's
   * `write_text_file` is a synchronous command on the main thread, so it never
   * interleaves with another: the second of two writes to a note — under any
   * spelling or link that reaches the same file — sees what the first wrote,
   * and its time check refuses it.
   */
  const oneTextWriteAtATime = <T>(write: () => Promise<T>): Promise<T> => {
    const turn = textWriteTail.then(write);
    // The next write waits for this one to finish, not to succeed; a refusal
    // still reaches this write's caller through `turn`.
    textWriteTail = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  };
  /** Numbers each text write's temporary, so no two writes ever share one. */
  let temporaries = 0;
  /** The fake Trash: a folder beside the vault, never inside it. */
  const trashRoot = `${vault.root}.trash`;
  const trashed: string[] = [];
  const openedLinks: string[] = [];
  const pictured: string[] = [];
  /** Where the fake save dialog puts exports: beside the vault, never in it. */
  const exportsRoot = `${vault.root}.exports`;
  const exportGrants = new Map<
    string,
    { root: string; file: string | null; companion: string | null }
  >();
  /** The files each export made that were not there before, for a failed one to take back. */
  const exportMade = new Map<string, string[]>();
  let cancelExport = false;
  const pdfPages: string[] = [];
  let snapshotFailure: string | null = null;
  let snapshotHeld: Promise<void> = Promise.resolve();
  /** Each vault's Activity log, by vault root, as `activity.rs` keeps them outside the vault. */
  const activityFiles = new Map<string, string>();
  /** Commands told to fail once, and why. */
  const failures = new Map<string, string>();
  const secrets = new Map<string, string>();
  /** The sites each secret may be sent to, as `secrets.rs` keeps them beside it. */
  const bindings = new Map<string, readonly string[]>();
  const answers: string[] = [];
  const requests: unknown[] = [];
  /** Google sign-ins by vault root, and the calendars DFAI made on the account. */
  const googleSignIns = new Map<string, { clientId: string; scopes: string[] }>();
  const googleCalendars: { id: string; summary: string }[] = [];
  let googleRefusal: { kind: string; code?: string; message: string } | null = null;
  /** Granola keys and refusals by vault root, what each path answers, and every request. */
  const kindlePages = new Map<string, string>();
  const kindleFetches: string[] = [];
  let kindleSession = false;
  let kindleSignedOut = false;
  const kindleFetch = (url: string) => {
    kindleFetches.push(url);
    if (!kindleSession) {
      return { [REJECT]: { kind: 'not_connected', message: 'Kindle is not connected' } };
    }
    if (kindleSignedOut) {
      // As the host answers when Amazon sends the notebook to its sign-in page (`kindle.rs`, `redirected`).
      return { status: 302, html: '', redirectedTo: 'https://www.amazon.com/ap/signin' };
    }
    const asked = new URL(url);
    const asin = asked.searchParams.get('asin');
    const key = asin === null ? 'library' : `${asin}|${asked.searchParams.get('token') ?? ''}`;
    const html = kindlePages.get(key);
    return html === undefined
      ? { status: 404, html: '', redirectedTo: null }
      : { status: 200, html, redirectedTo: null };
  };
  const granolaKeys = new Map<string, string>();
  const granolaRefusals = new Map<string, number>();
  const granolaAnswers = new Map<string, { status: number; body: string }>();
  const granolaRequests: { path: string; query: Readonly<Record<string, string>> }[] = [];
  const granolaStatus = (root: string) => ({
    hasKey: granolaKeys.has(root),
    lastRefusal: granolaRefusals.get(root) ?? null,
  });
  /** One GET to the fake Granola, whose answer is the last word on the key. */
  const granolaGet = (root: string, path: string, query: Record<string, string>) => {
    granolaRequests.push({ path, query });
    const answer = granolaAnswers.get(path) ?? { status: 404, body: '{"message":"Not found"}' };
    if (answer.status === 401) {
      granolaRefusals.set(root, answer.status);
    } else {
      granolaRefusals.delete(root);
    }
    return answer;
  };
  const databases = new Map<string, { columns: string[]; rows: unknown[][] }>();
  const sqliteQueries: { file: string; sql: string }[] = [];
  let offeredDatabase: string | null = null;
  /** The global capture shortcut the app asked the host to register, if any. */
  let globalShortcut: string | null = null;
  /** The Mac's time asleep since boot, in milliseconds: a Mac that has slept before. */
  let asleepMs = 457_335_000;
  const claudeReplies: string[] = [];
  const claudeRuns: { args: readonly string[]; stdin: string }[] = [];
  let claudeLoggedIn = true;
  /** git and gh (`git_process.rs`), as a real git against bare repositories on disk. */
  const gitStub = await createGitStub();
  /** Each run's output still on its way to the page. */
  const deliveries = new Set<Promise<void>>();
  /** Emits a run's output after its start has been answered, as the host's reader thread does. */
  const emitModel = (payloads: readonly unknown[]) => {
    const delivery = new Promise<void>((started) => setTimeout(started, 0)).then(() =>
      deliverModelOutput(page, payloads),
    );
    deliveries.add(delivery);
    // Left unawaited, a failure still surfaces as an unhandled rejection.
    void delivery.finally(() => deliveries.delete(delivery));
  };
  /**
   * A scripted reply as Claude Code 2.x prints it with `--include-partial-messages`
   * (captured from a real run): the init and status lines, a thinking block
   * first, the whole assistant message repeated between the stream events,
   * then the text as deltas of a dozen characters in the second block, and
   * the result.
   */
  const streamed = (run: string, text: string): unknown[] => {
    const line = (payload: unknown) => ({ run, kind: 'line', text: JSON.stringify(payload) });
    const event = (payload: unknown) => line({ type: 'stream_event', event: payload });
    const lines: unknown[] = [
      line({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] }),
      line({ type: 'system', subtype: 'status', status: 'requesting' }),
      event({ type: 'message_start', message: { role: 'assistant', content: [] } }),
      event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      line({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50 }),
      event({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '' },
      }),
      event({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig' },
      }),
      line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } }),
      event({ type: 'content_block_stop', index: 0 }),
      event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    ];
    for (let at = 0; at < text.length; at += 12) {
      const delta = text.slice(at, at + 12);
      lines.push(
        event({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: delta },
        }),
      );
    }
    lines.push(
      line({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
      event({ type: 'content_block_stop', index: 1 }),
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      event({ type: 'message_stop' }),
      line({ type: 'result', subtype: 'success', is_error: false, result: text }),
    );
    lines.push({ run, kind: 'exit', code: 0, stderr: '' });
    return lines;
  };
  /**
   * Fills a part list as the host does, remembering each value that went in.
   * The stub stands in for `secrets.rs`, whose own tests prove the real thing.
   */
  const fill = (parts: readonly RequestPart[], used: string[], names: string[]): string =>
    parts
      .map((part) => {
        if ('text' in part) return part.text;
        const value = secrets.get(part.secret);
        if (value === undefined)
          throw new Error(`the secret "${part.secret}" is not set for this vault`);
        used.push(value);
        names.push(part.secret);
        return value;
      })
      .join('');
  /** Refuses as the host does when a secret is not bound to where it is going. */
  const checkBound = (names: readonly string[], url: string): void => {
    const origin = new URL(url).origin;
    for (const name of names) {
      const bound = bindings.get(name) ?? [];
      if (bound.length === 0) {
        throw new Error(
          `the secret "${name}" is not bound to a site yet — choose where it may be sent in Settings → Secrets`,
        );
      }
      if (!bound.includes(origin)) {
        throw new Error(`the secret "${name}" is only sent to ${bound.join(', ')}, not ${origin}`);
      }
    }
  };

  const answer = async (command: string, args: unknown): Promise<unknown> => {
    const path = (args as { path?: string } | undefined)?.path ?? '';
    const failure = failures.get(command);
    if (failure !== undefined) {
      failures.delete(command);
      throw new Error(failure);
    }
    if (SYNC_COMMANDS.has(command)) return gitStub.answer(command, args, openRoot);
    switch (command) {
      // The host's own folder dialog for a clone (`git_process.rs`), which grants the folder.
      case 'git_pick_clone_folder':
      case 'pick_vault':
        return { absolutePath: offered, name: offered.split(sep).at(-1) };
      // The host resolves the open vault or a picked folder as the disk spells it.
      case 'git_folder_on_disk':
        return realpath((args as { folder: string }).folder);
      case 'open_vault':
        open = (args as { location: { absolutePath: string } }).location.absolutePath;
        return null;
      case 'current_vault':
        return open === null ? null : { absolutePath: open, name: open.split(sep).at(-1) };
      case 'list_notes': {
        const { readdir } = await import('node:fs/promises');
        // Like the real host: everything on disk except the folders the frontend
        // named. It has no opinion about a dot — deciding that is what the
        // frontend does with what this returns.
        const asked = args as { skipDirectories?: string[]; maxDepth?: number } | undefined;
        const skip = new Set(asked?.skipDirectories);
        const maxDepth = asked?.maxDepth ?? Number.POSITIVE_INFINITY;
        const root = openRoot();
        const walk = async (dir: string, prefix: string, depth = 0): Promise<unknown[]> => {
          if (depth > maxDepth) return [];
          const found: unknown[] = [];
          // Like the real host's walk (`NoteWalk::collect`), a folder or entry
          // gone between the listing and the look at it is left out, not an
          // error: a save's temporary file is renamed, a filed note moved.
          const names = await readdir(join(root, dir)).catch(() => null);
          for (const name of names ?? []) {
            if (skip.has(name)) continue;
            const relative = prefix === '' ? name : `${prefix}/${name}`;
            const info = await stat(join(root, relative)).catch(() => null);
            if (info === null) continue;
            if (info.isDirectory()) found.push(...(await walk(relative, relative, depth + 1)));
            else if (name.toLowerCase().endsWith('.md'))
              found.push({
                name,
                path: relative,
                kind: 'file',
                modified: Math.floor(info.mtimeMs),
                size: info.size,
              });
          }
          return found;
        };
        return walk('', '');
      }
      case 'list_vault_files': {
        // Like the real host (`FileWalk::list`): one walk, the told folders
        // skipped, a link to a folder not walked, a folder that cannot be read
        // left out, and the vault that cannot be read an error.
        const asked = args as { extension: string; skipDirectories: string[]; maxDepth: number };
        const skip = new Set(asked.skipDirectories);
        const suffix = `.${asked.extension.toLowerCase()}`;
        const root = openRoot();
        const found: string[] = [];
        const walk = async (dir: string, depth: number): Promise<void> => {
          const listed = await readdir(join(root, dir), { withFileTypes: true }).catch(
            (error: unknown) => {
              if (dir === '') throw error;
              return null;
            },
          );
          for (const entry of listed ?? []) {
            if (skip.has(entry.name)) continue;
            const relative = dir === '' ? entry.name : `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
              if (depth < asked.maxDepth) await walk(relative, depth + 1);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) {
              found.push(relative);
            }
          }
        };
        await walk('', 0);
        return found.sort();
      }
      // What @tauri-apps/api/app asks for; without these the status bar reports
      // a failure on every page, which shows up as an alert in every test.
      case 'plugin:app|name':
        return 'DFAI';
      case 'plugin:app|version':
        return '0.1.0';
      case 'create_note': {
        const { writeFile, stat: statFile } = await import('node:fs/promises');
        const { contents } = args as { contents: string };
        const file = containedPath(writeRoot(args), path);
        // Making a file is a write to it, and is held as one (`holdWrites`).
        await held.get(path);
        try {
          await writeFile(file, contents, { encoding: 'utf8', flag: 'wx' });
        } catch {
          throw new Error('a note with that name already exists');
        }
        countWrite(path);
        // The new note's time, as `create_note` reports it (#258).
        return Math.floor((await statFile(file)).mtimeMs);
      }
      case 'create_folder': {
        const { mkdir: makeDirectory } = await import('node:fs/promises');
        const folder = containedPath(writeRoot(args), path);
        try {
          await makeDirectory(folder);
        } catch {
          throw new Error('something with that name is already there');
        }
        return null;
      }
      case 'move_entry': {
        // As vault_entries.rs does: refuses to write over anything, and a
        // folder into itself, and lets a case-only rename through.
        const { from, to } = args as { from: string; to: string };
        const { rename, lstat } = await import('node:fs/promises');
        const root = writeRoot(args);
        const source = containedPath(root, from);
        const target = containedPath(root, to);
        if (source === target) return null;
        if (target.startsWith(source + sep))
          throw new Error('a folder cannot be moved into itself');
        const [was, there] = await Promise.all([lstat(source), lstat(target).catch(() => null)]);
        if (there !== null && there.ino !== was.ino) {
          throw new Error('something with that name is already there');
        }
        await rename(source, target);
        return null;
      }
      case 'trash_entry': {
        // A fake Trash beside the vault, so a test can see what went there and
        // that it went nowhere else. Never a permanent delete.
        const { rename, mkdir: makeDirectory } = await import('node:fs/promises');
        const entry = containedPath(writeRoot(args), path);
        // Removed with the test's folders, whichever test bins first (#486).
        removeWithTempFolders(trashRoot);
        await makeDirectory(trashRoot, { recursive: true });
        const binned = join(trashRoot, `${trashed.length}-${path.split('/').at(-1) ?? ''}`);
        await rename(entry, binned);
        trashed.push(path);
        return null;
      }
      case 'read_notes': {
        const { readFile, stat: statFile } = await import('node:fs/promises');
        const wanted = (args as { paths: string[] }).paths;
        await readsHeld(wanted);
        const files = [];
        for (const relative of wanted) {
          try {
            const file = containedPath(openRoot(), relative);
            const [text, info] = await Promise.all([readFile(file, 'utf8'), statFile(file)]);
            files.push({
              path: relative,
              text,
              modified: Math.floor(info.mtimeMs),
              size: info.size,
            });
          } catch {
            // Skipped, exactly as the host does.
          }
        }
        return files;
      }
      case 'index_open':
        // This stand-in keeps nothing between windows, so every index it opens
        // is one made just now.
        return { fresh: true };
      case 'index_clear':
        indexed.clear();
        indexWrites += 1;
        return null;
      case 'index_manifest':
        // Lists what was indexed, as the real index does: a refresh re-reads
        // only the notes that changed, and removes a note that is gone (#408).
        return [...indexed.values()].map((note) => ({
          path: note.path,
          modified: note.modified ?? 0,
          size: note.size ?? 0,
          digest: note.digest ?? '',
          type: note.type ?? null,
        }));
      case 'index_put': {
        indexPuts += 1;
        if (indexPuts > indexPutsBeforeHold) await indexHeld;
        for (const note of (args as { notes: StoredNote[] }).notes) indexed.set(note.path, note);
        indexWrites += 1;
        return null;
      }
      case 'index_remove': {
        for (const target of (args as { paths: string[] }).paths) indexed.delete(target);
        indexWrites += 1;
        return null;
      }
      case 'index_stats':
        return { notes: indexed.size, properties: 0, links: 0 };
      case 'index_rebuild_views': {
        // The real index creates one SQL view per declared type, and querying a
        // type it never created fails. Remembering the names is what lets a
        // widget pointing at nothing fail the way it would in the app.
        views.clear();
        const specs = (args as { types: ({ name: string } & ViewSpec)[] }).types;
        for (const spec of specs) views.set(spec.name, spec);
        return null;
      }
      case 'index_query': {
        const { sql: statement, parameters: bound } = args as {
          sql: string;
          parameters: unknown[];
        };

        // The graph reads the index's own tables, a page at a time. Answered
        // from what was indexed; the SQL itself runs against SQLite in
        // packages/domain/src/graph/graph-query.sqlite.test.ts.
        const graphPart = /\/\* graph:(\w+) \*\//.exec(statement)?.[1];
        if (graphPart !== undefined) {
          const [limit, offset] = bound.slice(-2).map(Number) as [number, number];
          const notes = [...indexed.values()].sort((a, b) => a.path.localeCompare(b.path));
          const all: unknown[][] =
            graphPart === 'notes'
              ? notes.map((note) => [
                  note.path,
                  note.title,
                  (note.properties ?? []).find((property) => property.key === 'type')?.text ?? null,
                ])
              : graphPart === 'links'
                ? notes.flatMap((note) =>
                    note.links.flatMap((link) =>
                      link.path === null ? [] : [[note.path, link.path]],
                    ),
                  )
                : notes.flatMap((note) =>
                    (note.properties ?? [])
                      .filter((p) => p.key !== 'type' && /^\[\[.*\]\]/.test(p.text ?? ''))
                      .map((p) => [note.path, p.key, p.text]),
                  );
          const columns = {
            notes: ['path', 'title', 'type'],
            links: ['source', 'target'],
            relations: ['source', 'key', 'value'],
          }[graphPart as 'notes' | 'links' | 'relations'];
          return { columns, rows: all.slice(offset, offset + limit), truncated: false };
        }
        // Which notes hold a link, a relation or in the body, to a note just made or gone:
        // asked of the real tables too (#431).
        if (
          statement.startsWith('/* atlas-query */') ||
          statement.includes(' FROM relations WHERE ')
        ) {
          return runAtlasQuery(statement, bound, indexed.values());
        }
        if (statement.startsWith('/* tags:')) {
          return runTagQuery(statement, bound, indexed.values());
        }
        // What a write changed of the graph and the tags (#259): the notes' own rows, run for real.
        if (statement.startsWith('/* index facets */')) {
          return runAtlasQuery(statement, bound, indexed.values());
        }
        // The weekly review (P30-07): tasks and projects, over files, props and relations, run for real.
        if (statement.startsWith('/* weekly review:')) {
          return runAtlasQuery(statement, bound, indexed.values());
        }
        // What a link field suggests beyond titles (#465): every note, aliases and use,
        // over files, props and relations, run for real.
        if (statement.startsWith('/* link hints:')) {
          return runAtlasQuery(statement, bound, indexed.values());
        }
        // The Inbox (P30-01, #112): what waits, each task with its project and who it
        // waits on — over files, props and relations, run for real.
        if (statement.startsWith('/* inbox */')) {
          return runAtlasQuery(statement, bound, indexed.values());
        }
        // The sidebar's count beside each type (#217): over files and props, run for real.
        if (statement.startsWith('/* type counts */')) {
          return runArchiveQuery(statement, bound, indexed.values());
        }
        // The vocabulary's notes (P28-05) read the same files and props tables
        // the Archive does, so they run for real by SQLite the same way.
        if (statement.startsWith('/* terms:')) {
          return runArchiveQuery(statement, bound, indexed.values());
        }
        // The Inbox's quick look before reading every task (P30-02): its statuses, run for
        // real; so are the notes dated a day, which the chat lists (#211).
        if (
          statement.startsWith('/* task statuses */') ||
          statement.startsWith('/* notes on day */')
        ) {
          return runArchiveQuery(statement, bound, indexed.values());
        }
        // PARA as a property (#213): what each project's PARA says, for pickers and counts,
        // and which notes the move onto the Project type reads — over props, run for real.
        if (
          statement.startsWith('/* PARA values */') ||
          statement.startsWith('/* PARA candidates */')
        ) {
          return runArchiveQuery(statement, bound, indexed.values());
        }
        // Linking a meeting (P29-04): its people, companies and likely projects, and the
        // proposals already made — by a link or by a rule's Claude step (P29-03) — over
        // files, props and relations, run for real. So are the tasks made from a meeting's
        // items (`atlas_item`, ADR-0036), which Accept and the After a meeting step look up.
        if (
          statement.startsWith('/* meeting links:') ||
          statement.startsWith('/* proposals: ids */') ||
          statement.startsWith('/* meeting items: made */')
        ) {
          return runAtlasQuery(statement, bound, indexed.values());
        }
        // A task's schedule (P31-01): the tasks and the blocks linking them, run for real.
        if (statement.startsWith('/* task schedule */')) {
          return runAtlasQuery(statement, bound, indexed.values());
        }
        // The Library and All highlights (#507): the literature notes and their highlights,
        // over files, props, tags, relations and highlights, run for real.
        if (statement.startsWith('/* research:')) {
          return answerFrom(research(indexWrites, indexed.values()), statement, bound);
        }
        // SQL written by hand — the query page, a SQL view or widget — binds
        // nothing, where everything the app compiles binds at least its LIMIT.
        if (bound.length === 0) return runHandWrittenSql(statement, indexed.values(), views);
        // A view filtered by a link compares by the note it opens, through the
        // relations table (#212): run for real, as SQL written by hand is.
        if (statement.includes(' FROM relations AS r WHERE ')) {
          return runHandWrittenSql(statement, indexed.values(), views, bound);
        }

        // The sidebar asks the properties table directly rather than a type's
        // view: which notes carry `atlas: view`, `atlas: dashboard` or
        // `favorite: true`, wherever they are. Answered here the same shallow
        // way as the rest; the real SQL is covered by the Rust tests.
        // The Archive: archived notes with the two keys archiving wrote, newest
        // first, narrowed by the words it binds — run for real by SQLite.
        if (statement.includes('"archivedFrom"')) {
          return runArchiveQuery(statement, bound, indexed.values());
        }
        // A meeting's holders and the meetings list (P28-04): the compiled
        // statement, run for real by SQLite the same way.
        if (statement.startsWith('/* meetings */')) {
          return runArchiveQuery(statement, bound, indexed.values());
        }

        if (statement.includes('FROM files')) {
          const wanted: [string, string][] = [];
          for (let at = 0; at + 1 < bound.length; at += 2) {
            wanted.push([String(bound[at]), String(bound[at + 1])]);
          }
          const found: unknown[][] = [];
          const outsideArchive = statement.includes("<> 'archive/'");
          for (const note of indexed.values()) {
            if (outsideArchive && note.path.toLowerCase().startsWith('archive/')) continue;
            for (const property of note.properties ?? []) {
              if (wanted.some(([key, value]) => property.key === key && property.text === value)) {
                found.push([note.path, property.key, property.text, note.title]);
              }
            }
          }
          return { columns: ['path', 'key', 'value', 'title'], rows: found, truncated: false };
        }

        /**
         * A deliberately shallow stand-in. It reads the type out of `FROM "v_x"`
         * and serves rows from what was indexed, honouring ORDER BY and LIMIT and
         * ignoring everything else. It exists to drive the table's wiring; the SQL
         * itself is covered by the Rust tests, which run the real database.
         */
        const sql = statement;
        const parameters = bound;
        const type = /FROM "v_([A-Za-z_][A-Za-z0-9_]*)"/.exec(sql)?.[1] ?? '';
        if (!views.has(type)) throw new Error(`no such table: v_${type}`);
        const columns = [...(/SELECT (.+)/.exec(sql)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map(
          (match) => match[1] ?? '',
        );
        // The real view always carries a summary column for cards.
        if (!columns.includes('summary')) columns.push('summary');

        const valueOf = (note: StoredNote, column: string): unknown => {
          if (column === 'path') return note.path;
          if (column === 'summary') return note.summary ?? '';
          // Milliseconds since the epoch are all 13 digits wide, so ordering them
          // as text below orders them in time.
          if (column === 'modified') return note.modified ?? 0;
          if (column === 'progress' && views.get(type)?.progress === true) {
            return note.progress ?? null;
          }
          if (column === 'title') {
            // The real view prefers the title the note gives itself.
            const declared = (note.properties ?? []).find((item) => item.key === 'title');
            return declared?.text ?? note.title;
          }
          // A property holding several values is one cell, joined as the real
          // view's group_concat joins it.
          const items = (note.properties ?? []).filter((item) => item.key === column);
          const many =
            views.get(type)?.columns.find((declared) => declared.key === column)?.many ?? false;
          if (many && items.length > 0) return items.map((item) => item.text).join(', ');
          return items[0]?.text ?? null;
        };

        // Every view leaves out a path prefix it writes into the statement —
        // `.atlas/`, where templates declare the type they make (A15-03).
        const excluded = /substr\("path", 1, \d+\) <> '([^']+)'/.exec(sql)?.[1];
        // And, unless asked to include them, what is archived — in lower case.
        const archived = /lower\(substr\("path", 1, \d+\)\) <> '([^']+)'/.exec(sql)?.[1];
        const ofType = [...indexed.values()].filter(
          (note) =>
            (note.properties ?? []).some((p) => p.key === 'type' && p.text === type) &&
            (excluded === undefined || !note.path.startsWith(excluded)) &&
            (archived === undefined || !note.path.toLowerCase().startsWith(archived)),
        );

        // WHERE, shallowly: IS and IS NOT against a bound value, which is what
        // the filter controls and the dashboards produce. Anything else is
        // ignored here and covered by the Rust tests against the real database.
        const conditions = [
          ...(/WHERE (.+)/.exec(sql)?.[1] ?? '').matchAll(/"([^"]+)" IS( NOT)? \?/g),
        ];
        const matching = ofType.filter((note) =>
          conditions.every(([, column, negated], position) => {
            const same = String(valueOf(note, column ?? '') ?? '') === String(parameters[position]);
            return negated === undefined ? same : !same;
          }),
        );

        const groupBy = /GROUP BY COALESCE\("([^"]+)"/.exec(sql)?.[1];
        if (groupBy !== undefined) {
          const counts = new Map<string, number>();
          for (const note of matching) {
            const label = String(valueOf(note, groupBy) ?? '');
            counts.set(label, (counts.get(label) ?? 0) + 1);
          }
          const bars = [...counts.entries()].sort(
            ([leftLabel, left], [rightLabel, right]) =>
              right - left || leftLabel.localeCompare(rightLabel),
          );
          return {
            columns: ['label', 'count'],
            rows: bars.map(([label, count]) => [label, count]),
            truncated: false,
          };
        }

        const aggregate = /SELECT (COUNT|SUM|AVG|MIN|MAX)\((\*|"[^"]+")\) AS "value"/.exec(sql);
        if (aggregate !== null) {
          const [, fn, target] = aggregate;
          const numbers = matching
            .map((note) =>
              target === '*' ? 1 : Number(valueOf(note, (target ?? '').replaceAll('"', ''))),
            )
            .filter((value) => Number.isFinite(value));
          const total = numbers.reduce((sum, value) => sum + value, 0);
          const value =
            fn === 'COUNT'
              ? matching.length
              : numbers.length === 0
                ? null
                : fn === 'SUM'
                  ? total
                  : fn === 'AVG'
                    ? total / numbers.length
                    : fn === 'MIN'
                      ? Math.min(...numbers)
                      : Math.max(...numbers);
          return { columns: ['value'], rows: [[value]], truncated: false };
        }

        const order = [...(/ORDER BY (.+)/.exec(sql)?.[1] ?? '').matchAll(/"([^"]+)" (ASC|DESC)/g)];
        matching.sort((left, right) => {
          for (const [, column, direction] of order) {
            const a = String(valueOf(left, column ?? '') ?? '');
            const b = String(valueOf(right, column ?? '') ?? '');
            if (a !== b) return (a < b ? -1 : 1) * (direction === 'DESC' ? -1 : 1);
          }
          return 0;
        });

        const limit = Number(parameters[parameters.length - 1] ?? 50);
        return {
          columns,
          rows: matching.slice(0, limit).map((note) => columns.map((c) => valueOf(note, c))),
          truncated: false,
        };
      }
      case 'index_notes_of_type': {
        const wanted = (args as { type: string }).type;
        return [...indexed.values()]
          .filter((note) =>
            (note.properties ?? []).some(
              (property) => property.key === 'type' && property.text === wanted,
            ),
          )
          .map((note) => ({ path: note.path, title: note.title }))
          .sort((left, right) => left.title.localeCompare(right.title));
      }
      case 'index_backlinks': {
        const wanted = (args as { path: string }).path;
        return [...indexed.values()]
          .filter((note) => note.path !== wanted && note.links.some((link) => link.path === wanted))
          .map((note) => note.path)
          .sort();
      }
      case 'index_search': {
        const searched = [...String((args as { query: string }).query).matchAll(/"([^"]+)"(\*)?/g)];
        const terms = searched.map((match) => (match[1] ?? '').toLowerCase());
        if (terms.length === 0) return [];
        const limit = Number((args as { limit?: number }).limit ?? 20);
        // As index.rs does: the prefix it is handed is left out, in lower case.
        const skip = (args as { skipPrefix?: string | null }).skipPrefix ?? null;
        return [...indexed.values()]
          .filter((note) => skip === null || !note.path.toLowerCase().startsWith(skip))
          .filter((note) => {
            // As index.rs searches: the path, the title and the body (#211).
            const haystack = `${note.path} ${note.title} ${note.body}`.toLowerCase();
            return terms.every((term) => haystack.includes(term));
          })
          .slice(0, limit)
          .map((note) => ({
            path: note.path,
            title: note.title,
            snippet: snippetOf(note.body, terms),
          }))
          .concat(
            // As index.rs does when asked (#507): then the highlights whose quote or comment match.
            (args as { highlights?: boolean }).highlights === true
              ? highlightHits([...indexed.values()], {
                  terms: searched.map((match) => ({
                    word: match[1] ?? '',
                    prefix: match[2] === '*',
                  })),
                  skip,
                  limit,
                })
              : [],
          );
      }
      case 'http_get': {
        /**
         * A deliberately shallow stand-in, like `index_query` above. It serves
         * the canned text for a URL and refuses everything else. The guards that
         * matter — which schemes are allowed, the size cap, the timeout, the
         * redirect rule — live in src-tauri/http.rs and are tested there.
         */
        const { request } = args as {
          request: { url: RequestPart[]; headers: { name: string; value: RequestPart[] }[] };
        };
        requests.push(request);
        const used: string[] = [];
        const names: string[] = [];
        const url = fill(request.url, used, names);
        for (const header of request.headers) fill(header.value, used, names);
        checkBound(names, url);
        const text = feeds[url];
        if (text === undefined) throw new Error('the feed answered 404 Not Found');
        return used.reduce(
          (redacted, value) => redacted.split(value).join('[secret removed]'),
          text,
        );
      }
      case 'secret_list':
        return [...secrets.keys()].sort().map((name) => ({
          name,
          origins: bindings.get(name) ?? [],
        }));
      case 'secret_set': {
        const { name, value, origins } = args as {
          name: string;
          value: string;
          origins?: string[];
        };
        secrets.set(name, value);
        if (origins !== undefined) bindings.set(name, origins);
        return null;
      }
      case 'secret_bind': {
        const { name, origins } = args as { name: string; origins: string[] };
        if (!secrets.has(name)) throw new Error(`the secret "${name}" is not set for this vault`);
        bindings.set(name, origins);
        return null;
      }
      case 'secret_delete': {
        const { name } = args as { name: string };
        secrets.delete(name);
        bindings.delete(name);
        return null;
      }
      case 'google_status': {
        const signIn = googleSignIns.get(writeRoot(args));
        return {
          connected: signIn !== undefined,
          clientId: signIn?.clientId ?? null,
          scopes: signIn?.scopes ?? [],
        };
      }
      case 'google_connect': {
        const root = writeRoot(args);
        const { clientId, scopes } = args as { clientId: string; scopes: string[] };
        if (googleRefusal !== null) {
          const refusal = googleRefusal;
          googleRefusal = null;
          return { [REJECT]: refusal };
        }
        googleSignIns.set(root, { clientId, scopes });
        return { connected: true, clientId, scopes };
      }
      case 'google_connect_cancel':
        return null;
      case 'google_disconnect':
        googleSignIns.delete(writeRoot(args));
        return { revoked: true, shared: false };
      case 'google_calendar_request': {
        if (!googleSignIns.has(writeRoot(args))) {
          return { [REJECT]: { kind: 'not_connected', message: 'not connected' } };
        }
        const { call } = args as { call: { method: string; path: string } };
        if (call.method === 'POST' && call.path === '/calendar/v3/calendars') {
          const made = { id: 'atlas-blocks@group.calendar.example.com', summary: 'DFAI blocks' };
          googleCalendars.push(made);
          return { status: 200, body: JSON.stringify(made) };
        }
        const items = googleCalendars.map((calendar) => ({ ...calendar, accessRole: 'owner' }));
        return { status: 200, body: JSON.stringify({ items }) };
      }
      case 'granola_status':
        return granolaStatus(writeRoot(args));
      case 'granola_set_key': {
        const root = writeRoot(args);
        const { key } = args as { key: string };
        if (!/^grn_[\x21-\x7e]+$/.test(key)) {
          return { [REJECT]: { kind: 'invalid', message: 'that is not a Granola API key' } };
        }
        granolaKeys.set(root, key);
        granolaRefusals.delete(root);
        granolaGet(root, '/v1/notes', { page_size: '1' });
        return granolaStatus(root);
      }
      case 'granola_forget_key': {
        const root = writeRoot(args);
        granolaKeys.delete(root);
        granolaRefusals.delete(root);
        return granolaStatus(root);
      }
      case 'granola_request': {
        const root = writeRoot(args);
        if (!granolaKeys.has(root)) {
          return { [REJECT]: { kind: 'no_key', message: 'no Granola API key is kept' } };
        }
        const { path, query } = args as { path: string; query: Record<string, string> };
        return granolaGet(root, path, query);
      }
      case 'kindle_connect':
        kindleSession = true;
        return null;
      case 'kindle_disconnect':
        kindleSession = false;
        return null;
      case 'kindle_fetch_notebook':
        return kindleFetch((args as { url: string }).url);
      case 'sqlite_source_query': {
        const { file, sql } = args as { file: string; sql: string };
        sqliteQueries.push({ file, sql });
        const found = databases.get(file);
        if (found === undefined) throw new Error('no such file');
        return { ...found, truncated: false };
      }
      case 'pick_sqlite_file':
        return offeredDatabase;
      case 'watch_vault':
        return null;
      case 'host_asleep_ms':
        return asleepMs;
      case 'read_binary_file': {
        const { readFile } = await import('node:fs/promises');
        const bytes = await readFile(containedPath(openRoot(), path));
        // Bytes cannot cross `exposeFunction` either; they go as base64 and the
        // init script below makes an ArrayBuffer of them again. Not as a list of
        // numbers: a 30 MB book as one ran the test's worker out of memory (#505).
        return { base64: bytes.toString('base64') };
      }
      case 'list_directory': {
        const directory = containedPath(openRoot(), path);
        const names = await readdir(directory);
        const entries = await Promise.all(
          names.map(async (name) => {
            // Gone between the listing and the look at it — a save's temporary
            // file, renamed over its note — is skipped, as `list_entries` does.
            const info = await stat(join(directory, name)).catch(() => null);
            if (info === null) return null;
            return {
              name,
              path: path === '' ? name : `${path}/${name}`,
              kind: info.isDirectory() ? 'directory' : 'file',
              modified: Math.floor(info.mtimeMs),
              size: info.size,
            };
          }),
        );
        return entries.filter((entry) => entry !== null);
      }
      case 'read_text_file': {
        await readsHeld([path]);
        const file = containedPath(openRoot(), path);
        const { readFile, stat: statFile } = await import('node:fs/promises');
        // A note that is not there is refused with a message, as the real
        // command's `Err` string is: the app reads it as a vault access failure.
        if (!existsSync(file)) return { [REJECT]: `cannot read ${path}: no such file` };
        const [text, info] = await Promise.all([readFile(file, 'utf8'), statFile(file)]);
        return { text, modified: Math.floor(info.mtimeMs) };
      }
      case 'write_text_file': {
        const { contents, expectedModified, expectedDigest } = args as {
          contents: string;
          expectedModified: number | null;
          expectedDigest?: string;
        };
        // Counted as asked for, landed or not: a second save that the host
        // refuses is still a second write the app tried to make.
        countWrite(path);
        await held.get(path);
        const file = containedPath(writeRoot(args), path);
        const { rename, writeFile, stat: statFile } = await import('node:fs/promises');
        return oneTextWriteAtATime(async () => {
          if (expectedModified !== null) {
            const info = await statFile(file);
            if (Math.floor(info.mtimeMs) !== expectedModified) {
              throw new Error('the note changed on disk since it was opened');
            }
          }
          // As `vault.rs` does, once the time has matched: the bytes the save
          // was read from, by their SHA-256, for a coarse clock's sake (#245).
          if (expectedDigest !== undefined) {
            const { readFile } = await import('node:fs/promises');
            const { createHash } = await import('node:crypto');
            const onDisk = createHash('sha256')
              .update(await readFile(file))
              .digest('hex');
            if (onDisk !== expectedDigest) {
              throw new Error('the note changed on disk since it was opened');
            }
          }
          // Beside the file, then over it, as the Rust host does: a read while
          // the write is under way sees the old file or the new one, never an
          // empty one — which would read as a type file with no type in it.
          // Its own temporary per write, so no other write can land in it.
          const temporary = join(dirname(file), `.${basename(file)}.atlas-tmp-${++temporaries}`);
          await writeFile(temporary, contents, 'utf8');
          await rename(temporary, file);
          if (coarseTickSeconds !== undefined) {
            const { utimes } = await import('node:fs/promises');
            await utimes(file, coarseTickSeconds, coarseTickSeconds);
          }
          return Math.floor((await statFile(file)).mtimeMs);
        });
      }
      case 'write_binary_file': {
        // As `vault_files.rs` does: offset 0 creates and never overwrites; past
        // 0 appends to a file that must be exactly that long. The bytes and
        // headers arrive as the init script below repackages the raw body.
        const { bytes, headers } = args as { bytes: number[]; headers: Record<string, string> };
        const target = decodeURIComponent(headers['atlas-path'] ?? '');
        const offset = Number(headers['atlas-offset'] ?? '0');
        const meant = headers['atlas-vault'];
        const file = containedPath(
          writeRoot(meant === undefined ? {} : { vault: decodeURIComponent(meant) }),
          target,
        );
        const { writeFile, appendFile, rename, stat: statFile } = await import('node:fs/promises');
        const data = Uint8Array.from(bytes);
        countWrite(target);
        if (headers['atlas-replace'] === '1') {
          // Beside it, then over it, as `replace_binary_at` does.
          const temporary = join(dirname(file), `.${basename(file)}.atlas-tmp`);
          await writeFile(temporary, data);
          await rename(temporary, file);
          return data.byteLength;
        }
        if (offset === 0) {
          try {
            await writeFile(file, data, { flag: 'wx' });
          } catch {
            throw new Error('a file with that name already exists');
          }
        } else {
          const size = (await statFile(file).catch(() => null))?.size;
          if (size !== offset) throw new Error('the file is not the length the write expected');
          await appendFile(file, data);
        }
        return offset + data.byteLength;
      }
      case 'open_url':
        openedLinks.push((args as { url: string }).url);
        return null;
      case 'export_choose_destination': {
        const { request } = args as {
          request:
            | { kind: 'file'; suggestedName: string; companionSuffix: string | null }
            | { kind: 'folder'; folderName: string };
        };
        if (cancelExport) {
          cancelExport = false;
          return null;
        }
        // Removed with the test's folders (#486).
        removeWithTempFolders(exportsRoot);
        const { mkdir: makeDirectory } = await import('node:fs/promises');
        const id = `grant-${exportGrants.size + 1}`;
        if (request.kind === 'folder') {
          const folder = join(exportsRoot, request.folderName);
          await makeDirectory(folder, { recursive: true });
          exportGrants.set(id, { root: folder, file: null, companion: null });
          return { id, path: folder, companion: null };
        }
        await makeDirectory(exportsRoot, { recursive: true });
        const file = join(exportsRoot, request.suggestedName);
        const stem = request.suggestedName.replace(/\.[^.]*$/, '');
        const companion =
          request.companionSuffix === null
            ? null
            : join(exportsRoot, `${stem}${request.companionSuffix}`);
        exportGrants.set(id, { root: exportsRoot, file, companion });
        return { id, path: file, companion };
      }
      case 'export_write_file': {
        const { bytes, headers } = args as { bytes: number[]; headers: Record<string, string> };
        const grant = exportGrants.get(headers['atlas-export-destination'] ?? '');
        if (grant === undefined) {
          return { [REJECT]: "this export's destination is no longer open; export again" };
        }
        const relative = decodeURIComponent(headers['atlas-export-path'] ?? '');
        const target =
          relative === '' && grant.file !== null ? grant.file : containedPath(grant.root, relative);
        const { mkdir: makeDirectory } = await import('node:fs/promises');
        await makeDirectory(dirname(target), { recursive: true });
        if (!existsSync(target)) {
          const id = headers['atlas-export-destination'] ?? '';
          exportMade.set(id, [...(exportMade.get(id) ?? []), target]);
        }
        await writeFile(target, Buffer.from(bytes));
        return bytes.length;
      }
      case 'export_finish': {
        // As `export.rs`: a failed export takes back the files it made, then the folders.
        const { id, discard } = args as { id: string; discard?: boolean };
        const made = exportMade.get(id) ?? [];
        exportGrants.delete(id);
        exportMade.delete(id);
        if (discard === true) {
          const { rm } = await import('node:fs/promises');
          for (const path of made.reverse()) await rm(path, { recursive: false, force: true });
        }
        return null;
      }
      case 'export_render_pdf': {
        const { bytes } = args as { bytes: number[] };
        const html = Buffer.from(bytes).toString('utf8');
        pdfPages.push(html);
        return Array.from(
          Buffer.from(`%PDF-1.7\n% stub of a ${html.length}-character page\n%%EOF\n`),
        );
      }
      case 'snapshot_page': {
        // The page arrives as the raw body; the picture goes back as numbers,
        // which the init script below makes an ArrayBuffer again.
        const { bytes } = args as { bytes: number[] };
        pictured.push(Buffer.from(bytes).toString('utf8'));
        await snapshotHeld;
        if (snapshotFailure !== null) throw new Error(snapshotFailure);
        return Array.from(STUB_THUMBNAIL);
      }
      case 'api_status':
        return apiStatus();
      case 'api_set_enabled':
        api.enabled = (args as { enabled: boolean }).enabled;
        return apiStatus();
      case 'api_token':
        return api.token;
      case 'api_rotate_token':
        api.rotations += 1;
        api.token = `token-${api.rotations + 1}`;
        return api.token;
      case 'api_router_ready': {
        const { listener, ready } = args as { listener: unknown; ready: boolean };
        if (ready) routerListeners.add(listener);
        else routerListeners.delete(listener);
        return null;
      }
      case 'global_capture_status':
        return { shortcut: globalShortcut, registered: globalShortcut !== null, problem: null };
      case 'global_capture_set':
        globalShortcut = (args as { shortcut: string | null }).shortcut;
        return { shortcut: globalShortcut, registered: globalShortcut !== null, problem: null };
      case 'model_process_start': {
        const { run, args: argv, stdin } = args as { run: string; args: string[]; stdin: string };
        claudeRuns.push({ args: argv, stdin });
        if (argv[0] === 'auth') {
          emitModel([
            { run, kind: 'line', text: JSON.stringify({ loggedIn: claudeLoggedIn }) },
            { run, kind: 'exit', code: claudeLoggedIn ? 0 : 1, stderr: '' },
          ]);
          return null;
        }
        emitModel(streamed(run, claudeReplies.shift() ?? 'Nothing more was scripted.'));
        return null;
      }
      case 'model_process_cancel': {
        const { run } = args as { run: string };
        emitModel([{ run, kind: 'exit', code: null, stderr: '' }]);
        return null;
      }
      case 'activity_append': {
        const { vault: root, text } = args as { vault: string; text: string };
        const kept = (activityFiles.get(root) ?? '') + text;
        activityFiles.set(root, kept);
        return Buffer.byteLength(kept, 'utf8');
      }
      case 'activity_read':
        return activityFiles.get((args as { vault: string }).vault) ?? '';
      case 'activity_replace': {
        const { vault: root, text } = args as { vault: string; text: string };
        activityFiles.set(root, text);
        return null;
      }
      case 'api_respond': {
        const { id, status, body } = args as ApiAnswer & { id: string };
        // As the broker does: an answer nobody is waiting on is dropped.
        waiting.get(id)?.({ status, body });
        waiting.delete(id);
        return null;
      }
      default:
        throw new Error(`unexpected command ${command}`);
    }
  };

  /** Every command the app has asked the host for, by name. */
  const calls = new Map<string, number>();
  await page.exposeFunction('__atlasInvoke', async (command: string, args: unknown) => {
    calls.set(command, (calls.get(command) ?? 0) + 1);
    const answered = await answer(command, args);
    // Logged only once a secret exists: before that there is nothing to leak,
    // and the replies that carry whole files would only slow every test.
    if (secrets.size > 0) answers.push(JSON.stringify(answered) ?? '');
    return answered;
  });

  await page.addInitScript((echoing: boolean) => {
    // Tauri injects its IPC into the main frame only (`for_main_frame_only`),
    // so a frame the app shows — an artifact's sandboxed copy — gets none of
    // it. Playwright runs init scripts in every frame; this keeps the stub true
    // to the host, or a frame would be handed an IPC the real one never has.
    if (window !== window.top) return;
    // What @tauri-apps/api checks for, and what it calls.
    (globalThis as unknown as { isTauri: boolean }).isTauri = true;

    // Enough of the event system for `listen` to work. Without it the file
    // watcher is silently disabled in tests, which is exactly where a bug hid.
    const callbacks = new Map<number, (payload: unknown) => void>();
    const listeners = new Map<string, number[]>();
    let nextId = 1;

    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      // Which window this is, as Tauri tells its pages: the close button is watched through it.
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback(callback: (payload: unknown) => void) {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      invoke: (command: string, args: unknown, options?: { headers?: Record<string, string> }) => {
        const answered = invokeHost(command, args, options);
        if (echoing) echoOnceWritten(answered, touchedBy(command, args, options));
        return answered;
      },
    };

    /** What the real watcher would report of a write: every path it touched. */
    function touchedBy(
      command: string,
      args: unknown,
      options?: { headers?: Record<string, string> },
    ): string[] {
      const named = (args ?? {}) as { path?: string; from?: string; to?: string };
      // A note is saved beside itself and renamed over (`temporary_beside` in vault.rs).
      const savedBeside = (path: string) => {
        const slash = path.lastIndexOf('/');
        return [`${path.slice(0, slash + 1)}.${path.slice(slash + 1)}.atlas-tmp`, path];
      };
      switch (command) {
        case 'write_text_file':
        case 'create_note':
          return savedBeside(named.path ?? '');
        case 'create_folder':
        case 'trash_entry':
          return [named.path ?? ''];
        case 'move_entry':
          return [named.from ?? '', named.to ?? ''];
        case 'write_binary_file':
          return [decodeURIComponent(options?.headers?.['atlas-path'] ?? '')];
        default:
          return [];
      }
    }

    // As `watcher.rs`: paths are collected until 400 ms pass with no more, then sent once.
    // Its timer is the page's own, so on the work clock the echo arrives on virtual time.
    let echoPending: string[] = [];
    let echoTimer: ReturnType<typeof setTimeout> | null = null;
    let echoesSent = 0;
    Object.defineProperty(window, '__atlasEchoesSent', { get: () => echoesSent });
    // Held (`holdEchoes`), a report due is kept until let go, as a watcher slower than the app would.
    let echoesHeld = false;
    let echoDue = false;
    function sendEcho() {
      const sent = echoPending;
      echoPending = [];
      echoesSent += 1;
      emit('vault-changed', sent);
    }
    Object.assign(window, {
      __atlasHoldEchoes(held: boolean) {
        echoesHeld = held;
        if (held || !echoDue) return;
        echoDue = false;
        sendEcho();
      },
    });
    function echoOnceWritten(answered: Promise<unknown>, paths: string[]) {
      if (paths.length === 0) return;
      answered.then(
        () => {
          for (const path of paths)
            if (path !== '' && !echoPending.includes(path)) echoPending.push(path);
          if (echoTimer !== null) clearTimeout(echoTimer);
          echoTimer = setTimeout(() => {
            echoTimer = null;
            if (echoesHeld) echoDue = true;
            else sendEcho();
          }, 400);
        },
        // A refused write changed nothing on disk, so the watcher has nothing to say.
        () => undefined,
      );
    }

    function invokeHost(
      command: string,
      args: unknown,
      options?: { headers?: Record<string, string> },
    ): Promise<unknown> {
      if (command === 'plugin:event|listen') {
        const { event, handler } = args as { event: string; handler: number };
        listeners.set(event, [...(listeners.get(event) ?? []), handler]);
        return Promise.resolve(handler);
      }
      if (command === 'plugin:event|unlisten') return Promise.resolve(null);
      // A raw body (`write_binary_file`) cannot cross `exposeFunction` as
      // bytes; it goes as numbers, with the headers that name it.
      if (args instanceof Uint8Array) {
        const answer = (
          window as unknown as { __atlasInvoke: (c: string, a: unknown) => Promise<unknown> }
        ).__atlasInvoke(command, { bytes: Array.from(args), headers: options?.headers ?? {} });
        return command === 'snapshot_page' || command === 'export_render_pdf'
          ? answer.then((numbers) => new Uint8Array(numbers as number[]).buffer)
          : answer;
      }
      const answer = (
        window as unknown as { __atlasInvoke: (c: string, a: unknown) => Promise<unknown> }
      )
        .__atlasInvoke(command, args)
        // A command that rejects with a value rather than a message, as
        // Tauri hands the webview whatever a command's `Err` serializes to.
        .then((value) =>
          typeof value === 'object' && value !== null && '__atlasReject' in value
            ? Promise.reject((value as { __atlasReject: unknown }).__atlasReject)
            : value,
        );
      return command === 'read_binary_file'
        ? answer.then((read) => bytesOfBase64((read as { base64: string }).base64).buffer)
        : answer;
    }

    function bytesOfBase64(base64: string): Uint8Array {
      const typed = Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array };
      if (typed.fromBase64 !== undefined) return typed.fromBase64(base64);
      const text = atob(base64);
      const bytes = new Uint8Array(text.length);
      for (let at = 0; at < text.length; at += 1) bytes[at] = text.charCodeAt(at);
      return bytes;
    }

    // What `unlisten` in @tauri-apps/api calls before it tells the host. Missing,
    // every unlisten threw, and the page reported the rejection as an error.
    (
      window as unknown as {
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (e: string, id: number) => void };
      }
    ).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(event, id) {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((handler) => handler !== id),
        );
        callbacks.delete(id);
      },
    };

    // The system clipboard, as a list a test can read: WebKit under Playwright
    // grants no clipboard permission, and a test must not touch the real one.
    const copied: string[] = [];
    (window as unknown as { __atlasClipboard: string[] }).__atlasClipboard = copied;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });

    // What the tests call to pretend the vault changed underneath the app.
    function emit(event: string, payload: unknown) {
      for (const id of listeners.get(event) ?? []) {
        callbacks.get(id)?.({ event, id, payload });
      }
    }
    (window as unknown as { __atlasEmit: (event: string, payload: unknown) => void }).__atlasEmit =
      emit;
  }, echoWrites);

  return {
    offer(next) {
      offered = next.root;
    },
    offerFolder(folder) {
      offered = folder;
    },
    git: gitStub,
    api: {
      async send(call) {
        if (!api.enabled) throw new Error('the local API is off, so nothing is listening');
        // The real host answers "DFAI is still starting" until a router listens.
        await expect
          .poll(() => routerListeners.size, {
            message: 'DFAI is still starting: no router said it listens',
          })
          .toBeGreaterThan(0);
        nextRequest += 1;
        const id = `e2e-${nextRequest}`;
        const answered = new Promise<ApiAnswer>((resolve, reject) => {
          waiting.set(id, resolve);
          // The real host answers `timeout` after this long; failing here says
          // which request went unanswered rather than timing the test out.
          setTimeout(() => reject(new Error(`the app never answered ${id}`)), 10_000);
        });
        await page.evaluate(
          ([payload]) =>
            (
              window as unknown as { __atlasEmit: (event: string, payload: unknown) => void }
            ).__atlasEmit('api-request', payload),
          [{ id, query: {}, body: null, ...call }],
        );
        return answered;
      },
      enabled: () => api.enabled,
      token: () => api.token,
    },
    writesTo: (relativePath) => writes.get(relativePath) ?? 0,
    callsTo: (command) => calls.get(command) ?? 0,
    echoesSent: () =>
      page.evaluate(
        () => (window as unknown as { __atlasEchoesSent?: number }).__atlasEchoesSent ?? 0,
      ),
    holdEchoes: async () => {
      const hold = (holding: boolean) =>
        page.evaluate(
          (holding) =>
            (window as unknown as { __atlasHoldEchoes: (held: boolean) => void }).__atlasHoldEchoes(
              holding,
            ),
          holding,
        );
      await hold(true);
      return () => hold(false);
    },
    failNext: (command, message) => void failures.set(command, message),
    activityLog: () => activityFiles.get(openRoot()) ?? '',
    seedActivity: (root, text) => void activityFiles.set(root, text),
    trashed: () => [...trashed],
    openedLinks: () => [...openedLinks],
    exports: {
      root: exportsRoot,
      cancelNext: () => {
        cancelExport = true;
      },
      pdfPages: () => [...pdfPages],
    },
    snapshots: {
      pages: () => [...pictured],
      failWith: (reason) => {
        snapshotFailure = reason;
      },
      hold: () => {
        let release = () => {};
        snapshotHeld = new Promise((resolve) => (release = resolve));
        return () => release();
      },
    },
    secrets: {
      names: () => [...secrets.keys()].sort(),
      answers: () => answers.join('\n'),
      requests: () => [...requests],
    },
    claude: {
      reply: (...texts) => void claudeReplies.push(...texts),
      loggedIn: (yes) => {
        claudeLoggedIn = yes;
      },
      runs: () => [...claudeRuns],
      delivered: async () => {
        await Promise.all(deliveries);
      },
    },
    google: {
      refuseNext: (failure) => {
        googleRefusal = failure;
      },
      connected: () => googleSignIns.size > 0,
      calendars: () => googleCalendars.map((calendar) => calendar.summary),
    },
    granola: {
      serve: (path, answer) => {
        granolaAnswers.set(path, answer);
      },
      hasKey: () => granolaKeys.size > 0,
      requests: () => [...granolaRequests],
    },
    kindle: {
      serveLibrary: (html) => void kindlePages.set('library', html),
      serveAnnotations: (asin, token, html) => void kindlePages.set(`${asin}|${token}`, html),
      signOut: () => {
        kindleSignedOut = true;
      },
      connected: () => kindleSession,
      fetches: () => [...kindleFetches],
    },
    sleepClock: {
      sleep: (milliseconds) => {
        asleepMs += milliseconds;
      },
    },
    globalCapture: {
      registered: () => globalShortcut,
      async press() {
        await page.evaluate(() =>
          (
            window as unknown as { __atlasEmit: (event: string, payload: unknown) => void }
          ).__atlasEmit('global-capture', null),
        );
      },
    },
    sqlite: {
      serve: (file, rows) => {
        databases.set(file, rows);
      },
      offer: (path) => {
        offeredDatabase = path;
      },
      queries: () => [...sqliteQueries],
    },
    holdIndexAfter(batches) {
      let release: () => void = () => {};
      indexPutsBeforeHold = indexPuts + batches;
      indexHeld = new Promise<void>((resolve) => (release = resolve));
      return () => {
        indexPutsBeforeHold = Infinity;
        release();
      };
    },
    holdWrites(relativePath) {
      let release: () => void = () => {};
      let refuse: (cause: Error) => void = () => {};
      const holding = new Promise<void>((resolve, reject) => {
        release = resolve;
        refuse = reject;
      });
      // Handled here as well, so a refusal with no write waiting on it is not an unhandled rejection.
      holding.catch(() => {});
      held.set(relativePath, holding);
      return (outcome) => {
        held.delete(relativePath);
        if (outcome === undefined) release();
        else refuse(new Error(outcome.fail));
      };
    },
    holdReads(relativePath, options) {
      let release: () => void = () => {};
      const until = new Promise<void>((resolve) => (release = resolve));
      heldReads.set(relativePath, {
        until,
        except: options?.except,
        alone: options?.alone === true,
      });
      return () => {
        heldReads.delete(relativePath);
        release();
      };
    },
  };
}

/** Everything the app has put on the clipboard, oldest first. */
export async function copiedText(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...(window as unknown as { __atlasClipboard: string[] }).__atlasClipboard,
  ]);
}

/**
 * Sends a run's output to the page piece by piece, as the host's reader thread
 * emits it, and stops once the window has closed: the host has nowhere to send
 * the rest either. A test closes the window when it ends, often with a reply
 * still arriving — its assertions met by the text before the run's last lines.
 */
async function deliverModelOutput(page: Page, payloads: readonly unknown[]): Promise<void> {
  for (const payload of payloads) {
    if (page.isClosed()) return;
    try {
      await page.evaluate(
        ([item]) =>
          (
            window as unknown as { __atlasEmit: (event: string, payload: unknown) => void }
          ).__atlasEmit('model-process', item),
        [payload],
      );
    } catch (error) {
      if (await windowGone(page)) return;
      throw error;
    }
  }
}

/**
 * Whether the window has gone, asked of the window itself. Playwright refuses
 * a call to a closing page before it reports the page closed, and its refusal
 * is no public error type, so a page that still answers is one whose failure
 * was real.
 */
async function windowGone(page: Page): Promise<boolean> {
  if (page.isClosed()) return true;
  return page.evaluate(() => false).catch(() => true);
}

/** Pretends something outside the app changed these files. */
export async function emitVaultChanged(page: Page, paths: readonly string[]): Promise<void> {
  await page.evaluate(
    ([changed]) =>
      (window as unknown as { __atlasEmit: (event: string, payload: unknown) => void }).__atlasEmit(
        'vault-changed',
        changed,
      ),
    [paths],
  );
}

/**
 * A file on disk, polled until it says what it should.
 *
 * A write travels through the editor, the host and the filesystem, and under
 * parallel workers that can outlast the default assertion timeout — which is
 * how the suite came to have a test that failed roughly once in thirty runs.
 * The wait is generous because a passing assertion never spends it, and a
 * flaky test is a bug rather than something to retry.
 */
export function expectFile(vault: FakeVault, path: string) {
  return expect.poll(() => vault.read(path), { timeout: 15_000 });
}

/**
 * A note's save indicator: the live region that reads Saved, Unsaved or
 * Saving…. The window has other status regions (the index count), so it is
 * the one saying one of those three.
 */
export function saveStatus(scope: Page | Locator): Locator {
  return scope.getByRole('status').filter({ hasText: /^(Saved|Unsaved|Saving…)$/ });
}

/**
 * The note's save indicator reads Saved — the whole of it.
 *
 * The indicator reads Unsaved, Saving… or Saved, and `getByText('Saved')` is a
 * case-insensitive substring match, so it also found "Unsaved" and passed on a
 * note that had never been written. `toHaveText` with a string matches the
 * full text, case and all. Pass a pane when more than one note is open. Boxed, so
 * a failure points at the line in the spec rather than at this one.
 */
export async function expectSaved(scope: Page | Locator): Promise<void> {
  await test.step(
    'the note reads Saved',
    async () => {
      await expect(saveStatus(scope)).toHaveText('Saved');
    },
    { box: true },
  );
}

/**
 * Runs a command from a page's "…" menu. The menu is portalled to the body, so
 * the item is found on the page; `scope` picks whose menu when two panes are open.
 */
export async function pageCommand(
  page: Page,
  command: RegExp,
  scope: Page | Locator = page,
): Promise<void> {
  await test.step(
    `page menu: ${command.source}`,
    async () => {
      await scope.getByRole('button', { name: 'More' }).click();
      await page.getByRole('menuitem', { name: command }).click();
    },
    { box: true },
  );
}

/**
 * Saves the note now, as the Save button used to — or finds it saved already.
 * The autosave can write the note before a slow runner reaches the menu, and
 * then Save now is disabled, rightly: nothing is unsaved. So the item is
 * clicked while it is enabled, and a disabled one is accepted only once
 * every save indicator in `scope` reads Saved. Saving… is waited out.
 */
export async function saveNow(page: Page, scope: Page | Locator = page): Promise<void> {
  await test.step(
    'page menu: Save now',
    async () => {
      await scope.getByRole('button', { name: 'More' }).click();
      const item = page.getByRole('menuitem', { name: /^Save now/ });
      await expect(async () => {
        if (await item.isEnabled()) {
          // Short, so an autosave that disables it meanwhile is looked at again.
          await item.click({ timeout: 1_000 });
          return;
        }
        const shown = await saveStatus(scope).allTextContents();
        expect(shown.length).toBeGreaterThan(0);
        expect(shown.every((each) => each === 'Saved')).toBe(true);
        await page.keyboard.press('Escape');
      }).toPass({ timeout: 15_000 });
    },
    { box: true },
  );
}

/** Splits the window from a pane's menu, as the split button used to. */
export const splitWindow = (page: Page, scope: Page | Locator = page) =>
  pageCommand(page, /^Split right/, scope);

/** Closes the given pane from its own menu. */
export const closePane = (page: Page, which: 1 | 2) =>
  pageCommand(page, /^Close pane/, page.getByRole('region', { name: `Pane ${which}` }));
