import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  archiveNotes,
  createIndexSyncer,
  createMeetingImporter,
  createNoteChanges,
  inVault,
  recordingActivity,
  type ArchivePorts,
  type IndexedNote,
} from '@dfai/application';
import { createVaultPath } from '@dfai/domain';

/**
 * Meeting import on arrival end to end on this side of the boundary: meeting
 * files written into a real folder, found by the index's refresh, heard on
 * the change feed and imported — read with the YAML reader every note is read
 * with, written and moved through the vault adapter, the duplicate's holders
 * asked of a real SQLite index.
 *
 * The host is stood in for by what follows, which does what the Rust commands
 * do with the same tables (`src-tauri/src/index.rs` and `vault.rs`, whose own
 * tests cover them). It walks, reads, writes, moves and stores; it decides nothing.
 */

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { tauriIndex } = await import('./tauri-index.ts');
const { tauriVaultFs } = await import('../vault/tauri-vault-fs.ts');
const { remarkMarkdown } = await import('../markdown/markdown-port.ts');

const TABLES = `
  CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '', modified INTEGER, size INTEGER NOT NULL,
    digest TEXT NOT NULL DEFAULT '', note_type TEXT);
  CREATE TABLE IF NOT EXISTS props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
    value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
  CREATE TABLE IF NOT EXISTS relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
    target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);
  CREATE TABLE IF NOT EXISTS links (src TEXT NOT NULL, dst TEXT, target TEXT NOT NULL,
    kind TEXT NOT NULL, leaf TEXT NOT NULL DEFAULT '');`;

/** The host's commands for one vault folder. */
function hostFor(root: string) {
  const database = new DatabaseSync(':memory:');
  let made = false;
  const full = (path: string) => join(root, path);
  const statOf = async (path: string) => Math.floor((await stat(full(path))).mtimeMs);

  const commands: Record<string, (args: Record<string, unknown>) => unknown> = {
    list_notes: () => walk(root),
    list_directory: async ({ path }) => listDirectory(root, path as string),
    read_notes: ({ paths }) => readAll(root, paths as string[]),
    read_text_file: async ({ path }) => ({
      text: await readFile(full(path as string), 'utf8'),
      modified: await statOf(path as string),
    }),
    write_text_file: async ({ path, contents, expectedModified }) => {
      const at = path as string;
      if (expectedModified !== null && (await statOf(at)) !== expectedModified) {
        throw new Error('the note changed on disk since it was read');
      }
      await writeFile(full(at), contents as string);
      return statOf(at);
    },
    create_folder: async ({ path }) => {
      if (existsSync(full(path as string))) throw new Error('something has that name already');
      await mkdir(full(path as string));
      return null;
    },
    move_entry: async ({ from, to }) => {
      if (existsSync(full(to as string))) throw new Error('something has that name already');
      await rename(full(from as string), full(to as string));
      return null;
    },
    index_open: () => {
      database.exec(TABLES);
      const fresh = !made;
      made = true;
      return { fresh };
    },
    index_clear: () => {
      database.exec('DELETE FROM files; DELETE FROM props; DELETE FROM relations;');
      return null;
    },
    index_manifest: () =>
      database
        .prepare('SELECT path, modified, size, digest, note_type AS type FROM files')
        .all()
        .map((row) => ({ ...row })),
    index_put: ({ notes }) => {
      for (const note of notes as IndexedNote[]) putNote(database, note);
      return null;
    },
    index_remove: ({ paths }) => {
      for (const path of paths as string[]) {
        database.prepare('DELETE FROM files WHERE path = ?').run(path);
        database.prepare('DELETE FROM props WHERE path = ?').run(path);
        database.prepare('DELETE FROM relations WHERE src = ?').run(path);
      }
      return null;
    },
    index_query: ({ sql, parameters }) => {
      const statement = database.prepare(sql as string);
      const columns = statement.columns().map((column) => column.name);
      const rows = statement.all(...(parameters as (string | number | null)[]));
      return { columns, rows: rows.map((row) => columns.map((key) => row[key])), truncated: false };
    },
    index_stats: () => ({
      notes: (database.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n,
      properties: 0,
      links: 0,
    }),
  };

  return async (command: string, args: Record<string, unknown> = {}) => {
    const run = commands[command];
    if (run === undefined) throw new Error(`no host command ${command}`);
    return run(args);
  };
}

function putNote(database: DatabaseSync, note: IndexedNote) {
  database
    .prepare(
      `INSERT INTO files (path, title, summary, modified, size, digest, note_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET title = excluded.title, modified = excluded.modified,
         size = excluded.size, digest = excluded.digest, note_type = excluded.note_type`,
    )
    .run(note.path, note.title, note.summary, note.modified, note.size, note.digest, note.type);
  database.prepare('DELETE FROM props WHERE path = ?').run(note.path);
  for (const row of note.properties) {
    database
      .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(note.path, row.key, row.index, row.text, row.number, row.date, row.json);
  }
  database.prepare('DELETE FROM relations WHERE src = ?').run(note.path);
  for (const row of note.relations) {
    database
      .prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?)')
      .run(note.path, row.key, row.index, row.target, row.name, row.path);
  }
}

async function walk(root: string, folder = root): Promise<unknown[]> {
  const found: unknown[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const at = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(root, at)));
    else if (entry.name.endsWith('.md')) found.push(await entryOf(root, at, 'file'));
  }
  return found;
}

async function listDirectory(root: string, path: string): Promise<unknown[]> {
  const folder = join(root, path);
  const entries = await readdir(folder, { withFileTypes: true });
  return Promise.all(
    entries.map((entry) =>
      entryOf(root, join(folder, entry.name), entry.isDirectory() ? 'directory' : 'file'),
    ),
  );
}

async function entryOf(root: string, at: string, kind: 'file' | 'directory') {
  const info = await stat(at);
  return {
    name: at.slice(at.lastIndexOf(sep) + 1),
    path: relative(root, at).split(sep).join('/'),
    kind,
    modified: Math.floor(info.mtimeMs),
    size: info.size,
  };
}

async function readAll(root: string, paths: readonly string[]) {
  return Promise.all(
    paths.map(async (path) => {
      const at = join(root, path);
      const [text, info] = await Promise.all([readFile(at, 'utf8'), stat(at)]);
      return { path, text, modified: Math.floor(info.mtimeMs), size: info.size };
    }),
  );
}

const fixtures = new URL('../../../domain/src/meetings/fixtures/', import.meta.url);
const VALID = readFileSync(new URL('valid/gemini-platform-sync.md', fixtures), 'utf8');
const MISSING = readFileSync(new URL('invalid/missing-required.md', fixtures), 'utf8');

/** A meeting file as the import leaves one it let in: the same bytes, and the stamp after its contract line. */
function stampedAsImported(text: string): string {
  return text.replace(/^(atlas_import: .*\n)/m, '$1atlas_import_outcome: imported\n');
}

const FIRST = 'Inbox/Meetings/2026-09-29 Platform weekly sync.md';
const SECOND = 'Inbox/Meetings/2026-09-29 Platform weekly sync (gemini 7f3a9c21).md';
const BROKEN = 'Inbox/Meetings/2026-10-02 Untitled.md';

let root: string;
/** Each write is a second later than the last, whatever the disk's clock resolution. */
let second = 1_800_000_000;

async function drop(path: string, text: string) {
  const at = join(root, path);
  await mkdir(dirname(at), { recursive: true });
  await writeFile(at, text);
  second += 1;
  await utimes(at, second, second);
}

/** The app opened on the vault: the index synced, and meetings imported as it hears of them. */
async function launch() {
  const activity = recordingActivity();
  const changes = createNoteChanges({
    onError: (cause) => {
      throw cause;
    },
  });
  const fs = inVault({ fs: tauriVaultFs, vault: root });
  const ports: ArchivePorts = {
    fs,
    index: tauriIndex,
    markdown: remarkMarkdown,
    editors: {
      state: () => 'closed',
      flush: async () => undefined,
      follow: () => undefined,
      abandon: () => undefined,
      reload: () => undefined,
    },
  };
  const syncer = createIndexSyncer({
    fs,
    index: tauriIndex,
    markdown: remarkMarkdown,
    activity,
    changes,
    openVault: () => root,
  });
  const importer = createMeetingImporter({
    ports: () => ports,
    clock: { today: () => '2026-10-08' },
    activity,
    openVault: () => root,
    active: () => true,
    onWritten: () => undefined,
  });
  const imports: Promise<unknown>[] = [];
  changes.subscribe((news) => imports.push(importer.hear(news)));
  await syncer.sync({ vault: root, fromScratch: false });
  return {
    activity,
    ports,
    /** A sync, as a pull or the watcher sets off, and the import it leads to. */
    sync: async () => {
      await syncer.sync({ vault: root, fromScratch: false });
      await Promise.all(imports.splice(0));
    },
  };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'atlas-meeting-import-')));
  invoke.mockReset();
  invoke.mockImplementation(hostFor(root));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('meeting import over a real folder and a real SQLite index', () => {
  it('lets a meeting in with only its stamp written, and archives a second copy of it', async () => {
    const app = await launch();

    await drop(FIRST, VALID);
    await app.sync();
    await drop(SECOND, VALID);
    await app.sync();

    expect(await readFile(join(root, FIRST), 'utf8')).toBe(stampedAsImported(VALID));
    expect(existsSync(join(root, SECOND))).toBe(false);
    const archived = await readFile(join(root, 'Archive', SECOND), 'utf8');
    expect(archived).toMatch(
      /^atlas_duplicate_of: (["'])\[\[Inbox\/Meetings\/2026-09-29 Platform weekly sync\]\]\1$/m,
    );
    expect(archived).toContain(`archivedFrom: ${SECOND}`);
    expect(archived.slice(archived.indexOf('## Summary'))).toBe(
      VALID.slice(VALID.indexOf('## Summary')),
    );
    expect(app.activity.reports.filter((report) => report.kind === 'meeting')).toEqual([
      expect.objectContaining({ level: 'info', message: expect.stringContaining('arrived') }),
      expect.objectContaining({ level: 'info', message: expect.stringContaining('second copy') }),
    ]);
  });

  it('marks a broken file where it landed, and leaves it marked through the next sync', async () => {
    const app = await launch();

    await drop(BROKEN, MISSING);
    await app.sync();
    const marked = await readFile(join(root, BROKEN), 'utf8');
    await app.sync();

    expect(marked).toMatch(/^atlas_import_error: .*title is required/m);
    expect(marked.slice(marked.indexOf('## Summary'))).toBe(
      MISSING.slice(MISSING.indexOf('## Summary')),
    );
    expect(await readFile(join(root, BROKEN), 'utf8')).toBe(marked);
    expect(app.activity.reports.filter((report) => report.kind === 'meeting')).toHaveLength(1);
  });
});

describe('meeting import over a real folder: where the import writes', () => {
  it('rewrites an error in place, its outcome kept after the contract line', async () => {
    const app = await launch();
    await drop(BROKEN, MISSING);
    await app.sync();
    const first = await readFile(join(root, BROKEN), 'utf8');
    const fixedTitle = first.replace(
      "date: '2026-10-02'",
      "date: '2026-10-02'\ntitle: 'Vendor call'",
    );
    await drop(BROKEN, fixedTitle);
    await app.sync();
    const second = await readFile(join(root, BROKEN), 'utf8');

    const lines = second.split('\n');
    expect(lines.slice(1, 4)).toEqual([
      'type: meeting',
      'atlas_import: meeting/v1',
      'atlas_import_outcome: error',
    ]);
    expect(second).not.toContain('title is required');
    expect(second.match(/^atlas_import_error:/gm)).toHaveLength(1);
  });
});

describe('meeting import over a real folder: adversarial', () => {
  const NO_ID = readFileSync(new URL('invalid/turn-without-block-id.md', fixtures), 'utf8');
  const UNREADABLE = readFileSync(new URL('invalid/unreadable-yaml.md', fixtures), 'utf8');
  const meetingReports = (app: {
    activity: { reports: readonly { kind: string; message: string }[] };
  }) => app.activity.reports.filter((report) => report.kind === 'meeting');

  it('marks a file with a body error once, however many syncs follow its own mark', async () => {
    const app = await launch();

    await drop(BROKEN, NO_ID);
    await app.sync();
    const marked = await readFile(join(root, BROKEN), 'utf8');
    await app.sync();
    await app.sync();

    expect(marked).toMatch(/^atlas_import_error: .*line \d+/im);
    expect(await readFile(join(root, BROKEN), 'utf8')).toBe(marked);
    expect(meetingReports(app)).toHaveLength(1);
  });

  it('archives a second copy whose external_id carries the same trailing space', async () => {
    const spaced = VALID.replace(
      "external_id: 'gemini-7f3a9c21'",
      "external_id: 'gemini-7f3a9c21 '",
    );
    expect(spaced).not.toBe(VALID);
    const app = await launch();

    await drop(FIRST, spaced);
    await app.sync();
    await drop(SECOND, spaced);
    await app.sync();

    expect(await readFile(join(root, FIRST), 'utf8')).toBe(stampedAsImported(spaced));
    expect(existsSync(join(root, SECOND))).toBe(false);
    expect(existsSync(join(root, 'Archive', SECOND))).toBe(true);
  });

  it('imports a copy whose unreadable YAML is fixed later, and archives it as the duplicate it is', async () => {
    const app = await launch();

    await drop(FIRST, VALID);
    await app.sync();
    await drop(SECOND, UNREADABLE);
    await app.sync();
    expect(await readFile(join(root, SECOND), 'utf8')).toBe(UNREADABLE);
    await drop(SECOND, VALID);
    await app.sync();

    expect(existsSync(join(root, SECOND))).toBe(false);
    expect(existsSync(join(root, 'Archive', SECOND))).toBe(true);
    expect(meetingReports(app).map((report) => report.message)).toEqual([
      expect.stringContaining('arrived'),
      expect.stringContaining('could not be imported'),
      expect.stringContaining('second copy'),
    ]);
  });

  /**
   * Two Macs pull the same repository (ADR-0025) and both import (ADR-0027).
   * One awake hears the first copy, then the resend a minute later; one that
   * wakes in between hears both in one sync, in whatever order its disk lists
   * them. Each archives the copy it thinks is second; if they disagree, the
   * merge archives both and the meeting leaves the Inbox altogether.
   */
  it.each(['ascending', 'descending'] as const)(
    'keeps the same copy whether the two arrive in one sync or two (host lists %s)',
    async (order) => {
      const inInbox = async () => [FIRST, SECOND].filter((path) => existsSync(join(root, path)));

      const awake = await launch();
      await drop(FIRST, VALID);
      await awake.sync();
      await drop(SECOND, VALID);
      await awake.sync();
      const keptByAwake = await inInbox();

      await rm(root, { recursive: true, force: true });
      root = await realpath(await mkdtemp(join(tmpdir(), 'atlas-meeting-import-')));
      const host = hostFor(root);
      invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
        const answer = await host(command, args);
        if (command !== 'list_notes') return answer;
        const sorted = [...(answer as { path: string }[])].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        );
        return order === 'ascending' ? sorted : sorted.reverse();
      });
      const asleep = await launch();
      await drop(FIRST, VALID);
      await drop(SECOND, VALID);
      await asleep.sync();
      const keptByAsleep = await inInbox();

      expect(keptByAwake).toEqual([FIRST]);
      expect(keptByAsleep).toEqual(keptByAwake);
    },
  );
});

describe('meeting import over a real folder: adversarial, round 2', () => {
  const meetingReports = (app: {
    activity: { reports: readonly { kind: string; message: string }[] };
  }) => app.activity.reports.filter((report) => report.kind === 'meeting');

  /**
   * Both Macs edited the meeting; the merge keeps this Mac's version in place
   * and the other's beside it (U-29). The conflict copy is a valid holder that
   * ranks with the path the mapping writes first and wins the tie on path, so
   * the file in place — this Mac's version, the one links name — is archived.
   */
  it('keeps the meeting in place when a sync conflict copy of it arrives beside it', async () => {
    const conflict =
      'Inbox/Meetings/2026-09-29 Platform weekly sync (conflict from Tobias’s Mac).md';
    const app = await launch();
    await drop(FIRST, VALID);
    await app.sync();

    await drop(conflict, VALID.replace('before Friday.', 'before Thursday.'));
    await app.sync();

    expect(existsSync(join(root, 'Archive', FIRST))).toBe(false);
    expect(existsSync(join(root, FIRST)) && (await readFile(join(root, FIRST), 'utf8'))).toBe(
      stampedAsImported(VALID),
    );
  });

  /**
   * James renames an imported meeting and adds a line to its transcript on
   * one Mac. That Mac hears two changes — the edit, left alone, then a move.
   * The other Mac pulls both in one sync: a removed note and an added one
   * with other bytes, which is an arrival, so it writes an import error into
   * his note and commits it.
   */
  it('leaves a renamed and edited meeting alone whether the two come in one sync or two', async () => {
    const renamed = 'Inbox/Meetings/2026-09-29 Platform weekly sync - cache.md';
    const edited = `${stampedAsImported(VALID)}\nTobias left early; follow up on the flag.\n`;

    const thisMac = await launch();
    await drop(FIRST, VALID);
    await thisMac.sync();
    await drop(FIRST, edited);
    await thisMac.sync();
    await rename(join(root, FIRST), join(root, renamed));
    await thisMac.sync();
    const keptByThisMac = await readFile(join(root, renamed), 'utf8');

    await rm(root, { recursive: true, force: true });
    root = await realpath(await mkdtemp(join(tmpdir(), 'atlas-meeting-import-')));
    invoke.mockImplementation(hostFor(root));
    const otherMac = await launch();
    await drop(FIRST, VALID);
    await otherMac.sync();
    await rm(join(root, FIRST));
    await drop(renamed, edited);
    await otherMac.sync();
    const keptByOtherMac = await readFile(join(root, renamed), 'utf8');

    expect(keptByThisMac).toBe(edited);
    expect(keptByOtherMac).toBe(keptByThisMac);
    expect(meetingReports(otherMac)).toHaveLength(1);
  });

  /**
   * The original is archived; the mapping resends the meeting and, its path
   * being free, writes it there with the same bytes. The importer has heard
   * that path and those bytes before — the original's arrival — so the resend
   * is never looked at: it stays in the Inbox, a live second copy of an
   * archived meeting, and Activity says nothing.
   */
  it('archives an identical resend that lands where the archived original arrived', async () => {
    const app = await launch();
    await drop(FIRST, VALID);
    await app.sync();
    const notePaths = (await tauriIndex.manifest()).map((entry) => createVaultPath(entry.path));
    await archiveNotes({
      ports: app.ports,
      paths: [createVaultPath(FIRST)],
      notePaths,
      today: '2026-10-08',
    });
    await app.sync();

    await drop(FIRST, VALID);
    await app.sync();

    expect(existsSync(join(root, FIRST))).toBe(false);
    expect(meetingReports(app).map((report) => report.message)).toEqual([
      expect.stringContaining('arrived'),
      expect.stringContaining('second copy'),
    ]);
  });
});
