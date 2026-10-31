import { INDEX_SCHEMA } from './index-schema.ts';
import { DatabaseSync } from './node-sqlite.ts';
import {
  createVaultPath,
  digestOf,
  indexablePropertiesOf,
  KeyAsWritten,
  movedPath,
  parentVaultPath,
  parseObjectType,
  splitFrontmatter,
  vaultPathName,
  type EntryMove,
  type ObjectType,
  type VaultEntry,
  type VaultPath,
} from '@dfai/domain';
import type { ArchivePorts } from '../archive/archive-notes.ts';
import type { RuleQueryPorts } from '../automations/plan-run.ts';
import type { ClaudeStepPorts } from '../automations/claude-step.ts';
import type { AutomationPorts } from '../automations/run-automation.ts';
import type { IndexEntry, QueryResult } from '../index/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { VaultAccessError } from '../vault/ports.ts';
import { fakeClaudeStepPorts } from './fake-claude-step.ts';
import { fakeIndexPort, fakeVaultFs } from './fake-ports.ts';
import { jsonMarkdown } from './settings-vault.ts';

const DAY_MS = 86_400_000;

/** The task type the automation tests ask about. */
export const TASK_TYPES: readonly ObjectType[] = [
  parseObjectType({
    name: 'task',
    label: 'Task',
    properties: {
      status: { kind: 'select', options: ['doing', 'done'] },
      flagged: 'checkbox',
      due: 'date',
    },
  }),
];

/** A note whose frontmatter is JSON, as `jsonMarkdown` reads it. */
export const jsonNote = (frontmatter: Record<string, unknown>, body = 'Body.\n'): string =>
  `---\n${JSON.stringify(frontmatter)}\n---\n${body}`;

/**
 * A vault held in memory that answers as the host does — a move refuses to
 * overwrite and needs its folder, a write is refused against a note changed
 * since it was read — with an index that answers queries with real SQL over
 * what the vault holds at the moment it is asked — its manifest too, each
 * note's type and digest as they are then. Each note is dated `ageDays`
 * before `today`, noon UTC, so `modified` is the same day anywhere.
 */
export function automationVault({
  notes,
  today,
  ageDays = {},
  dirty = [],
  types = TASK_TYPES,
  claude = fakeClaudeStepPorts(),
  markdown = droppingMarkdown(),
}: {
  notes: Record<string, string>;
  today: string;
  ageDays?: Record<string, number>;
  dirty?: string[];
  /** The vault's types; the task type alone unless given. */
  types?: readonly ObjectType[];
  /** What a Claude step asks; a model with nothing scripted unless given. */
  claude?: ClaudeStepPorts;
  /** How frontmatter is read and written: JSON unless given — the real YAML port, in an adapters test. */
  markdown?: MarkdownPort;
}) {
  const files = new Map(Object.entries(notes));
  const dirs = new Set<string>();
  for (const path of files.keys()) addParents(dirs, path);
  const noon = Date.parse(`${today}T12:00:00Z`);
  const modified = new Map(
    [...files.keys()].map((path) => [path, noon - (ageDays[path] ?? 0) * DAY_MS]),
  );
  const unsaved = new Set(dirty);
  const log: string[] = [];
  const exists = (at: string) => dirs.has(at) || files.has(at);

  const fs = fakeVaultFs({
    listNotes: async () =>
      [...files.keys()].map((at) => {
        const path = createVaultPath(at);
        return { name: vaultPathName(path), path, modified: modified.get(at)!, size: 1 };
      }),
    listDirectory: async (parent) => [
      ...[...dirs]
        .filter((at) => parentVaultPath(at as VaultPath) === parent)
        .map((at) => entry(at, 'directory')),
      ...[...files.keys()]
        .filter((at) => parentVaultPath(at as VaultPath) === parent)
        .map((at) => entry(at, 'file')),
    ],
    readNotes: async (paths) =>
      paths.flatMap((at) => {
        const text = files.get(at);
        return text === undefined
          ? []
          : [{ path: at, text, modified: modified.get(at)!, size: text.length }];
      }),
    readTextFile: async (at) => {
      const text = files.get(at);
      if (text === undefined) throw new VaultAccessError('no such note');
      return { text, modified: modified.get(at)! };
    },
    createFolder: async ({ path: at }) => {
      if (exists(at)) throw new VaultAccessError('something with that name is already there');
      dirs.add(at);
    },
    createNote: async ({ path: at, contents }) => {
      if (exists(at)) throw new VaultAccessError('something with that name is already there');
      files.set(at, contents);
      modified.set(at, noon);
      log.push(`create ${at}`);
      return noon;
    },
    moveEntry: async (move: EntryMove) => {
      if (!files.has(move.from)) throw new VaultAccessError('no such entry');
      if (exists(move.to)) throw new VaultAccessError('something with that name is already there');
      if (parentVaultPath(move.to) !== '' && !dirs.has(parentVaultPath(move.to))) {
        throw new VaultAccessError('no such folder');
      }
      for (const [at, text] of [...files]) {
        const to = movedPath(at as VaultPath, move);
        if (to === null) continue;
        files.delete(at);
        files.set(to, text);
        modified.set(to, modified.get(at)!);
      }
      log.push(`move ${move.from} -> ${move.to}`);
    },
    trashEntry: async ({ path: at }) => {
      if (!files.delete(at)) throw new VaultAccessError('no such entry');
      modified.delete(at);
      log.push(`trash ${at}`);
    },
    writeTextFile: async ({ path: at, contents, expectedModified }) => {
      if (expectedModified !== null && modified.get(at) !== expectedModified) {
        throw new VaultAccessError('the note changed on disk');
      }
      files.set(at, contents);
      const next = (modified.get(at) ?? noon) + 1;
      modified.set(at, next);
      log.push(`write ${at}`);
      return next;
    },
  });

  const ports: AutomationPorts & Pick<RuleQueryPorts, 'notePaths'> = {
    fs,
    markdown,
    index: fakeIndexPort({
      query: async (sql, parameters) => answer(sql, parameters),
      manifest: async () => manifestOf(),
    }),
    editors: editorsFor(unsaved, log),
    types,
    claude,
    get notePaths() {
      return [...files.keys()];
    },
  };

  function answer(sql: string, parameters: readonly (string | number | null)[]): QueryResult {
    const database = indexOf(files, modified, markdown);
    const statement = database.prepare(sql);
    const rows = statement.all(...parameters) as Record<string, unknown>[];
    const columns = statement.columns().map((column) => column.name);
    return {
      columns,
      rows: rows.map((row) => columns.map((column) => row[column])),
      truncated: false,
    };
  }

  function manifestOf(): IndexEntry[] {
    return [...files].map(([path, text]) => {
      const type = markdown.frontmatterProperties(splitFrontmatter(text).frontmatter)['type'];
      return {
        path,
        modified: modified.get(path)!,
        size: text.length,
        type: typeof type === 'string' ? type : null,
        digest: digestOf(text),
      };
    });
  }

  return {
    ports,
    files,
    log,
    unsaved,
    /** What a note's frontmatter says now. */
    properties: (at: string) =>
      markdown.frontmatterProperties(splitFrontmatter(files.get(at) ?? '').frontmatter),
  };
}

function addParents(dirs: Set<string>, path: string): void {
  for (
    let parent = parentVaultPath(path as VaultPath);
    parent !== '';
    parent = parentVaultPath(parent)
  ) {
    dirs.add(parent);
  }
}

function entry(at: string, kind: VaultEntry['kind']): VaultEntry {
  const path = createVaultPath(at);
  return { kind, name: vaultPathName(path), path } as VaultEntry;
}

function editorsFor(unsaved: Set<string>, log: string[]): ArchivePorts['editors'] {
  return {
    state: (at) => (unsaved.has(at) ? 'dirty' : 'closed'),
    flush: async () => {},
    follow: (move) => {
      for (const at of [...unsaved]) {
        const to = movedPath(at as VaultPath, move);
        if (to === null) continue;
        unsaved.delete(at);
        unsaved.add(to);
      }
    },
    abandon: () => {},
    reload: (at) => void log.push(`reload ${at}`),
  };
}

/** The index's tables, filled from the vault as it is now. */
function indexOf(
  files: ReadonlyMap<string, string>,
  modified: ReadonlyMap<string, number>,
  markdown: MarkdownPort,
): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(INDEX_SCHEMA);
  for (const [path, text] of files) {
    const title = path.replace(/^.*\//, '').replace(/\.md$/i, '');
    database
      .prepare('INSERT INTO files (path, title, summary, modified, size) VALUES (?, ?, ?, ?, 1)')
      .run(path, title, '', modified.get(path) ?? 0);
    const frontmatter = markdown.frontmatterProperties(splitFrontmatter(text).frontmatter);
    for (const row of indexablePropertiesOf(frontmatter)) {
      database
        .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(path, row.key, row.index, row.text, row.number, row.date, row.json);
    }
  }
  return database;
}

/** JSON frontmatter in which a null change takes the key out, as the real port's does. */
function droppingMarkdown(): MarkdownPort {
  const json = jsonMarkdown();
  return {
    ...json,
    updateFrontmatter: (frontmatter, changes) => {
      const merged: Record<string, unknown> = { ...json.frontmatterProperties(frontmatter) };
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === undefined) delete merged[key];
        // As the real writer does, text given as written is that key's value: here only `key:`, empty.
        else if (value instanceof KeyAsWritten) merged[key] = null;
        else merged[key] = value;
      }
      return `---\n${JSON.stringify(merged)}\n---\n`;
    },
  };
}
