import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIndexSyncer,
  createNoteChanges,
  fakeVaultFs,
  recordingActivity,
  type NoteChangeNews,
} from '@dfai/application';
import { digestOf } from '@dfai/domain';

/**
 * The change feed end to end on this side of the boundary: notes written to a
 * real folder, listed and read through the vault adapter, indexed through the
 * index adapter into a real SQLite file that outlives the syncer — as the
 * index outlives the app between launches.
 *
 * The host is stood in for by what follows, which does what the Rust commands
 * do with the same `files` columns (`src-tauri/src/index.rs`, whose own tests
 * cover its SQL). It walks, reads and stores; it decides nothing.
 */

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { tauriIndex } = await import('./tauri-index.ts');
const { tauriVaultFs } = await import('../vault/tauri-vault-fs.ts');
const { remarkMarkdown } = await import('../markdown/markdown-port.ts');

const FILES_TABLE = `
  CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '', modified INTEGER, size INTEGER NOT NULL,
    digest TEXT NOT NULL DEFAULT '', note_type TEXT);
  CREATE TABLE IF NOT EXISTS relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
    target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);
  CREATE TABLE IF NOT EXISTS props (path TEXT NOT NULL, key TEXT NOT NULL,
    idx INTEGER NOT NULL DEFAULT 0, value_text TEXT, value_num REAL, value_date TEXT,
    value_json TEXT);
  CREATE TABLE IF NOT EXISTS links (src TEXT NOT NULL, dst TEXT, target TEXT NOT NULL,
    kind TEXT NOT NULL, leaf TEXT NOT NULL DEFAULT '');`;

interface SentNote {
  path: string;
  title: string;
  summary: string;
  modified: number;
  size: number;
  digest: string;
  type: string | null;
  relations: { key: string; index: number; target: string; name: string; path: string | null }[];
  properties: {
    key: string;
    index: number;
    text: string | null;
    number: number | null;
    date: string | null;
    json: string | null;
  }[];
}

/** The host's commands for one vault folder, its index in the folder's cache as the app keeps it. */
function hostFor(root: string) {
  let database: DatabaseSync | null = null;
  const indexFile = join(root, '.atlas-cache', 'index.sqlite');
  const opened = () => {
    if (database === null) throw new Error('the index is not open');
    return database;
  };

  const commands: Record<string, (args: Record<string, unknown>) => unknown> = {
    list_notes: ({ skipDirectories }) => walk(root, new Set(skipDirectories as string[])),
    read_notes: ({ paths }) => readAll(root, paths as string[]),
    index_open: () => {
      // Opening again replaces the connection, as the host's does, and says
      // whether the index had to be made — as it does when the file is gone.
      database?.close();
      const fresh = !existsSync(indexFile);
      database = new DatabaseSync(indexFile);
      database.exec(FILES_TABLE);
      return { fresh };
    },
    index_clear: () => {
      opened().exec('DROP TABLE files; DROP TABLE relations; DROP TABLE props;');
      opened().exec(FILES_TABLE);
      return null;
    },
    index_manifest: () =>
      opened()
        .prepare('SELECT path, modified, size, digest, note_type AS type FROM files')
        .all()
        .map((row) => ({ ...row })),
    index_put: ({ notes }) => {
      for (const note of notes as SentNote[]) putNote(opened(), note);
      return null;
    },
    index_remove: ({ paths }) => {
      for (const path of paths as string[]) {
        opened().prepare('DELETE FROM files WHERE path = ?').run(path);
        opened().prepare('DELETE FROM relations WHERE src = ?').run(path);
        opened().prepare('DELETE FROM props WHERE path = ?').run(path);
      }
      return null;
    },
    index_query: ({ sql, parameters }) => ({
      columns: ['path'],
      rows: opened()
        .prepare(sql as string)
        .all(...(parameters as string[]))
        .map((row) => Object.values(row)),
      truncated: false,
    }),
    index_stats: () => ({
      notes: (opened().prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n,
      properties: 0,
      links: 0,
    }),
  };

  return {
    invoke: async (command: string, args: Record<string, unknown> = {}) => {
      const run = commands[command];
      if (run === undefined) throw new Error(`no host command ${command}`);
      return run(args);
    },
    /** The app quitting: the database file stays where it is. */
    close: () => {
      database?.close();
      database = null;
    },
  };
}

function putNote(database: DatabaseSync, note: SentNote) {
  database
    .prepare(
      `INSERT INTO files (path, title, summary, modified, size, digest, note_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET title = excluded.title, summary = excluded.summary,
         modified = excluded.modified, size = excluded.size, digest = excluded.digest,
         note_type = excluded.note_type`,
    )
    .run(note.path, note.title, note.summary, note.modified, note.size, note.digest, note.type);
  database.prepare('DELETE FROM relations WHERE src = ?').run(note.path);
  for (const row of note.relations) {
    database
      .prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?)')
      .run(note.path, row.key, row.index, row.target, row.name, row.path);
  }
  database.prepare('DELETE FROM props WHERE path = ?').run(note.path);
  for (const row of note.properties) {
    database
      .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(note.path, row.key, row.index, row.text, row.number, row.date, row.json);
  }
}

async function walk(root: string, skip: ReadonlySet<string>, folder = root): Promise<unknown[]> {
  const found: unknown[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const full = join(folder, entry.name);
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) found.push(...(await walk(root, skip, full)));
    } else if (entry.name.endsWith('.md')) {
      const info = await stat(full);
      found.push({
        name: entry.name,
        path: relative(root, full).split(sep).join('/'),
        kind: 'file',
        modified: Math.floor(info.mtimeMs),
        size: info.size,
      });
    }
  }
  return found;
}

async function readAll(root: string, paths: readonly string[]) {
  return Promise.all(
    paths.map(async (path) => {
      const full = join(root, path);
      const [text, info] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
      return { path, text, modified: Math.floor(info.mtimeMs), size: info.size };
    }),
  );
}

let root: string;
let host: ReturnType<typeof hostFor>;
/** Each write is a second later than the last, whatever the disk's clock resolution. */
let second = 1_800_000_000;

async function writeNote(path: string, text: string) {
  const full = join(root, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, text);
  second += 1;
  await utimes(full, second, second);
}

/** The app being opened: a fresh syncer over the vault, its index whatever the last left. */
function launch() {
  host.close();
  const heard: NoteChangeNews[] = [];
  const changes = createNoteChanges({
    onError: (cause) => {
      throw cause;
    },
  });
  changes.subscribe((news) => heard.push(news));
  const syncer = createIndexSyncer({
    fs: fakeVaultFs({ listNotes: tauriVaultFs.listNotes, readNotes: tauriVaultFs.readNotes }),
    index: tauriIndex,
    markdown: remarkMarkdown,
    activity: recordingActivity(),
    changes,
    openVault: () => root,
  });
  return {
    sync: (fromScratch = false) => syncer.sync({ vault: root, fromScratch }),
    news: () => heard.splice(0).flatMap((each) => each.changes),
  };
}

const KICKOFF = 'meetings/Kickoff.md';
const KICKOFF_TEXT = '---\ntype: meeting\nattendees:\n  - Mara Quill\n---\n\nAgenda.\n';

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'atlas-note-changes-')));
  await mkdir(join(root, '.atlas-cache'));
  host = hostFor(root);
  invoke.mockReset();
  invoke.mockImplementation(host.invoke);
});

afterEach(async () => {
  host.close();
  await rm(root, { recursive: true, force: true });
});

describe('the index change feed over a real folder and a real SQLite index', () => {
  it('reports a written note as added, an edit as changed and a delete as removed', async () => {
    await writeNote('Idea.md', 'A spark.\n');
    const app = launch();
    await app.sync();
    app.news();

    await writeNote(KICKOFF, KICKOFF_TEXT);
    await app.sync();
    expect(app.news()).toEqual([
      { kind: 'added', path: KICKOFF, type: 'meeting', digest: digestOf(KICKOFF_TEXT) },
    ]);

    const edited = `${KICKOFF_TEXT}Decided: ship on Friday.\n`;
    await writeNote(KICKOFF, edited);
    await app.sync();
    expect(app.news()).toEqual([
      {
        kind: 'changed',
        path: KICKOFF,
        type: 'meeting',
        digest: digestOf(edited),
        before: digestOf(KICKOFF_TEXT),
      },
    ]);

    await rm(join(root, KICKOFF));
    await app.sync();
    expect(app.news()).toEqual([
      { kind: 'removed', path: KICKOFF, type: 'meeting', digest: digestOf(edited) },
    ]);
  });

  it('remembers across a relaunch: only a note that came while closed is news', async () => {
    await writeNote('Idea.md', 'A spark.\n');
    await launch().sync();

    await writeNote(KICKOFF, KICKOFF_TEXT);
    await writeNote('Idea.md', 'A spark.\n');
    const reopened = launch();
    await reopened.sync();

    expect(reopened.news()).toEqual([
      { kind: 'added', path: KICKOFF, type: 'meeting', digest: digestOf(KICKOFF_TEXT) },
    ]);
  });

  it('says how the meeting import settled a note, before and after, across a relaunch (#92)', async () => {
    const STANDUP = 'Inbox/Meetings/Standup.md';
    const plain = '---\ntype: meeting\n---\n\nAgenda.\n';
    const stamped = '---\ntype: meeting\natlas_import_outcome: imported\n---\n\nAgenda.\n';
    const edited = `${stamped}Decided: ship on Friday.\n`;
    await writeNote(STANDUP, plain);
    const app = launch();
    await app.sync();
    app.news();

    await writeNote(STANDUP, stamped);
    await app.sync();
    expect(app.news()).toEqual([
      {
        kind: 'changed',
        path: STANDUP,
        type: 'meeting',
        digest: digestOf(stamped),
        before: digestOf(plain),
        importOutcome: 'imported',
      },
    ]);

    await writeNote(STANDUP, edited);
    const reopened = launch();
    await reopened.sync();
    expect(reopened.news()).toEqual([
      {
        kind: 'changed',
        path: STANDUP,
        type: 'meeting',
        digest: digestOf(edited),
        before: digestOf(stamped),
        importOutcome: 'imported',
        beforeImportOutcome: 'imported',
        beforeArrivalHeard: true,
      },
    ]);
  });

  it('reports nothing for a rebuild, nor for a refresh that finds nothing new', async () => {
    await writeNote(KICKOFF, KICKOFF_TEXT);
    const app = launch();
    await app.sync();
    app.news();

    await app.sync();
    await app.sync(true);
    expect(app.news()).toEqual([]);

    const reopened = launch();
    await reopened.sync(true);
    expect(reopened.news()).toEqual([]);
    expect(await tauriIndex.manifest()).toEqual([
      expect.objectContaining({ path: KICKOFF, type: 'meeting', digest: digestOf(KICKOFF_TEXT) }),
    ]);
  });
});
