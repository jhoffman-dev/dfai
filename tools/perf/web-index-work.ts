import { readFile } from 'node:fs/promises';
import {
  createIndexSyncer,
  createNoteChanges,
  type ActivityLog,
  type NoteFile,
  type NoteListing,
  type VaultFsPort,
} from '../../packages/application/src/index.ts';
import {
  compileInboxCountQuery,
  compileInboxQuery,
  compileReviewProjectsQuery,
  compileReviewTasksQuery,
  createVaultPath,
} from '../../packages/domain/src/index.ts';
import { remarkMarkdown } from '../../packages/adapters/src/markdown/markdown-port.ts';
import {
  inMemoryWebIndex,
  sqliteWasm,
  type InMemoryWebIndex,
} from '../../packages/adapters/src/web-index/in-memory-web-index.ts';
import { memoryIndexFiles } from '../../packages/adapters/src/web-index/memory-index-files.ts';
import { fnv1a, webIndexShape } from '../../packages/adapters/src/web-index/web-index-shape.ts';
import type { WEB_INDEX_ACTIONS } from './budgeted-actions.ts';
import type { Times, Work } from './work-budgets.ts';
import { fixtureVault, type FixtureFile } from './fixture-vault.ts';

/**
 * The browser index's work budgets (#666): opening the 2,000-note fixture
 * vault the first time, opening it again with a few notes changed, and the
 * queries Today and the Inbox ask. Counted as notes read, host calls by name
 * and SQL statements run, on SQLite's WebAssembly build in Node — the same
 * host the index worker runs, its files in memory rather than OPFS. Counts,
 * not times; the times are reported only.
 */

export type WebIndexAction = (typeof WEB_INDEX_ACTIONS)[number];

const VAULT = 'github:example/fixture';
/** The notes the second open finds changed. */
const CHANGED = 3;

/** The host's schema file, read as the domain's SQLite tests read it. */
const HOST_SCHEMA = new URL('../../apps/desktop/src-tauri/src/index_schema.sql', import.meta.url);

/** What each action did, and how long it took on the wall clock. */
export interface WebIndexRun {
  readonly work: ReadonlyMap<WebIndexAction, Work>;
  readonly times: ReadonlyMap<WebIndexAction, Times>;
}

/** Does each action once, in order, each from where the last left the index. */
export async function runWebIndexActions(): Promise<WebIndexRun> {
  const shape = webIndexShape(await readFile(HOST_SCHEMA, 'utf8'));
  const sqlite3 = await sqliteWasm();
  const files = memoryIndexFiles(sqlite3);
  const statements = { count: 0 };
  const open = files.open.bind(files);
  files.open = (vault) => {
    const database = open(vault);
    // Each statement SQLite starts, the index's own and the queries'. The binding takes the
    // C call's four arguments, its context too, where its typings name three.
    const trace = sqlite3.capi.sqlite3_trace_v2 as (...args: unknown[]) => number;
    trace(
      database,
      sqlite3.capi.SQLITE_TRACE_STMT,
      () => {
        statements.count++;
        return 0;
      },
      0,
    );
    return database;
  };
  const notes = new Map(
    fixtureVault()
      .filter((file: FixtureFile) => file.path.endsWith('.md'))
      .map((file: FixtureFile) => [file.path, file.contents]),
  );
  const work = new Map<WebIndexAction, Work>();
  const times = new Map<WebIndexAction, Times>();
  const measure = async (action: WebIndexAction, act: (counted: Counted) => Promise<void>) => {
    const counted = await countedIndex({ files, shape, notes, statements });
    const started = performance.now();
    await act(counted);
    const took = performance.now() - started;
    work.set(action, counted.work());
    times.set(action, { inputToReady: Math.round(took), longestFrame: Math.round(took) });
    counted.web.close();
  };
  await measure('Open a 2,000-note vault in the browser', (counted) => counted.sync());
  for (const path of [...notes.keys()].slice(0, CHANGED)) {
    notes.set(path, `${notes.get(path) ?? ''}\nChanged since the last open.\n`);
  }
  await measure('Open it again in the browser, 3 notes changed', (counted) => counted.sync());
  await measure('Read Today and the Inbox in the browser', async ({ web }) => {
    await web.index.open();
    for (const { sql, parameters } of [
      compileReviewTasksQuery(),
      compileReviewProjectsQuery(),
      compileInboxQuery(),
      compileInboxCountQuery(),
    ]) {
      await web.index.query(sql, parameters);
    }
  });
  return { work, times };
}

interface Counted {
  readonly web: InMemoryWebIndex;
  sync(): Promise<void>;
  work(): Work;
}

/** A page's index over the kept files, its work counted from now. */
async function countedIndex({
  files,
  shape,
  notes,
  statements,
}: {
  files: ReturnType<typeof memoryIndexFiles>;
  shape: ReturnType<typeof webIndexShape>;
  notes: ReadonlyMap<string, string>;
  statements: { count: number };
}): Promise<Counted> {
  const web = await inMemoryWebIndex({ openVault: () => VAULT, files, shape });
  const vault = blobVault(notes);
  const from = statements.count;
  const syncer = createIndexSyncer({
    fs: vault.fs,
    index: web.index,
    markdown: remarkMarkdown,
    activity: quietActivity(),
    changes: createNoteChanges({ onError: () => undefined }),
    openVault: () => VAULT,
  });
  return {
    web,
    sync: async () => {
      await syncer.sync({ vault: VAULT, fromScratch: false });
    },
    work: () => ({
      commits: 0,
      renders: {},
      calls: {
        ...Object.fromEntries([...web.calls].map(([call, count]) => [`index_${call}`, count])),
        notes_read: vault.read.count,
        sql_statements: statements.count - from,
      },
    }),
  };
}

/**
 * A vault as the GitHub vault lists it: each note's version a fingerprint of
 * its text, as a blob id is, and no time (ADR-0053). Each note read is counted.
 */
function blobVault(notes: ReadonlyMap<string, string>): {
  fs: VaultFsPort;
  read: { count: number };
} {
  const read = { count: 0 };
  const version = (text: string) => fnv1a(text) * 0x100000 + (fnv1a(text, 0x050c5d1f) & 0xfffff);
  const listing = (path: string, text: string): NoteListing => ({
    path: createVaultPath(path),
    name: path.slice(path.lastIndexOf('/') + 1),
    modified: version(text),
    modifiedAt: null,
    size: new TextEncoder().encode(text).length,
  });
  const fs: Pick<VaultFsPort, 'listNotes' | 'readNotes'> = {
    listNotes: async () => [...notes].map(([path, text]) => listing(path, text)),
    readNotes: async (paths) => {
      read.count += paths.length;
      return paths.flatMap((path): NoteFile[] => {
        const text = notes.get(path);
        return text === undefined ? [] : [{ ...listing(path, text), text }];
      });
    },
  };
  // A refresh lists and reads notes, and nothing else of the vault.
  return { fs: fs as VaultFsPort, read };
}

/** Nothing is measured of the Activity log; the syncer only needs somewhere to say it. */
function quietActivity(): ActivityLog {
  const recorder = { record: () => undefined };
  return {
    ...recorder,
    inOpenVault: () => recorder,
    inVault: () => recorder,
    read: async () => [],
    subscribe: () => () => undefined,
  };
}
