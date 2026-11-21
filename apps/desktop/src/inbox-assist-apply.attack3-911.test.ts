/**
 * Third attack on #911 (#909): Inbox assist's apply and undo through the
 * real markdown adapter and the real vault adapter, on vault folders in the
 * OS temp folder, with the stand-in host of `inbox-assist-apply.integration.test.ts`
 * (copied, plus hooks around each host command and a crash after the k-th).
 * All names are made up.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyAssistRow,
  findUnfinishedAssist,
  inVault,
  previewInboxAssist,
  recordingActivity,
  undoAssistRow,
  type ApplyAssistPorts,
  type AssistApplied,
} from '@dfai/application';
import { automationVault } from '@dfai/application/testing/sqlite';
import { createVaultPath, inboxItem } from '@dfai/domain';
import { EVERY_ASSIST_KIND } from '@dfai/domain/testing';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { tauriVaultFs } = await import('@dfai/adapters/tauri');
const { remarkMarkdown } = await import('@dfai/adapters');

const TODAY = '2026-11-17';
/** The preview's notes were last changed hours before the clock's now: left alone. */
const LEFT_AT = new Date(`${TODAY}T08:00:00Z`);
/** Later than the preview: an edit made in a test has a file time of its own. */
const EDITED_AT = new Date(`${TODAY}T09:00:00Z`);

/** What the stand-in host is told to do around each command: a hook, or a crash after the k-th call. */
const HOST: {
  calls: { command: string; args: Record<string, unknown> }[];
  before: ((command: string, args: Record<string, unknown>) => void) | null;
  after: ((command: string, args: Record<string, unknown>) => void) | null;
  crashAt: number | null;
  frozen: boolean;
} = { calls: [], before: null, after: null, crashAt: null, frozen: false };

function resetHost() {
  Object.assign(HOST, { calls: [], before: null, after: null, crashAt: null, frozen: false });
}
const CLOCK = {
  now: () => Date.parse(`${TODAY}T12:00:00Z`),
  today: () => TODAY,
  localNow: () => `${TODAY}T12:00:00`,
};

const roots: string[] = [];
afterEach(() => {
  resetHost();
  for (const root of roots.splice(0)) {
    if (!existsSync(root)) continue;
    // Made writable again first, so a test that took a file's write away still leaves nothing.
    for (const path of walk(root)) chmodSync(join(root, path), 0o644);
    rmSync(root, { recursive: true, force: true });
  }
});

function walk(root: string, at = ''): string[] {
  return readdirSync(join(root, at), { withFileTypes: true }).flatMap((entry) => {
    const path = at === '' ? entry.name : `${at}/${entry.name}`;
    return entry.isDirectory() ? walk(root, path) : [path];
  });
}

const mtime = (file: string) => Math.floor(statSync(file).mtimeMs);
/** The host's words for a save refused as stale (`CHANGED_ON_DISK` in vault.rs). */
const CHANGED_ON_DISK = 'the note changed on disk since it was opened';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** The host's vault commands for one folder, and its Trash beside it, outside the vault. */
function hostFor(root: string, trash: string) {
  const at = (path: unknown) => join(root, String(path));
  const entry = (path: string) => {
    const stat = statSync(at(path));
    const name = path.split('/').pop()!;
    return {
      name,
      path,
      kind: stat.isDirectory() ? 'directory' : 'file',
      modified: Math.floor(stat.mtimeMs),
      size: stat.size,
    };
  };
  const commands: Record<string, (args: Record<string, unknown>) => unknown> = {
    list_directory: ({ path }) => {
      if (!existsSync(at(path))) throw new Error('no such folder');
      return readdirSync(at(path)).map((name) =>
        entry(path === '' ? name : `${String(path)}/${name}`),
      );
    },
    list_notes: () =>
      walk(root)
        .filter((path) => path.endsWith('.md'))
        .map(entry),
    read_notes: ({ paths }) =>
      (paths as string[])
        .filter((path) => existsSync(at(path)))
        .map((path) => ({
          path,
          text: readFileSync(at(path), 'utf8'),
          modified: mtime(at(path)),
          size: statSync(at(path)).size,
        })),
    read_text_file: ({ path }) => {
      if (!existsSync(at(path))) throw new Error('no such file');
      return { text: readFileSync(at(path), 'utf8'), modified: mtime(at(path)) };
    },
    create_note: ({ path, contents }) => {
      writeFileSync(at(path), String(contents), { flag: 'wx' });
      return mtime(at(path));
    },
    create_folder: ({ path }) => void mkdirSync(at(path)),
    move_entry: ({ from, to }) => {
      if (existsSync(at(to))) throw new Error('something with that name is already there');
      renameSync(at(from), at(to));
    },
    trash_entry: ({ path, unchanged }) => {
      for (const held of (unchanged as
        { path: string; modified: number; digest: string }[] | undefined) ?? []) {
        if (
          mtime(at(held.path)) !== held.modified ||
          sha(readFileSync(at(held.path), 'utf8')) !== held.digest
        ) {
          throw new Error(
            'a file changed on disk since it was read, so nothing was moved to the Trash',
          );
        }
      }
      mkdirSync(trash, { recursive: true });
      renameSync(at(path), join(trash, String(path).replaceAll('/', '__')));
    },
    // As `write_text` in vault.rs: a note that is not there cannot be saved; one whose time is
    // not the time it was read at, or — given a digest — whose bytes are not those it was read
    // as (a write within the disk's timestamp tick), is refused with the host's own words.
    write_text_file: ({ path, contents, expectedModified, expectedDigest }) => {
      if (!existsSync(at(path)))
        throw new Error('cannot read: No such file or directory (os error 2)');
      const changed =
        (expectedModified !== null &&
          expectedModified !== undefined &&
          mtime(at(path)) !== expectedModified) ||
        (typeof expectedDigest === 'string' &&
          sha(readFileSync(at(path), 'utf8')) !== expectedDigest);
      if (changed) throw new Error(CHANGED_ON_DISK);
      writeFileSync(at(path), String(contents));
      return mtime(at(path));
    },
  };
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (HOST.frozen) return new Promise(() => {});
    HOST.calls.push({ command, args });
    HOST.before?.(command, args);
    if (HOST.crashAt !== null && HOST.calls.length > HOST.crashAt) {
      HOST.frozen = true;
      return new Promise(() => {});
    }
    const run = commands[command];
    if (run === undefined) throw new Error(`the stand-in host has no ${command}`);
    const answer = run(args);
    HOST.after?.(command, args);
    return answer;
  });
}

const PROJECT = 'Projects/Larkspur Payroll.md';
const MARA = 'People/Mara Quill.md';
const KEPT = 'Tasks/Renew Larkspur contract.md';

const BASE: Record<string, string> = {
  [PROJECT]: '---\ntype: project\npara: project\n---\n\n# Larkspur Payroll\n',
  [MARA]: '---\ntype: person\nemail: mara.quill@example.com\n---\n',
  [KEPT]: '---\ntype: task\nstatus: next-action\n---\n\nRenew it.\n',
};

const entry = (item: string, extra: Record<string, unknown> = {}) => ({
  item,
  kind: 'task',
  projects: [],
  due: null,
  waitingOn: null,
  confidence: 'high',
  why: 'Something to do.',
  duplicateOf: null,
  people: [],
  ...extra,
});

/** A vault folder holding `notes`, the ports Apply is handed over it, and its row for `path`, previewed. */
async function vaultWith(
  notes: Record<string, string>,
  answers: readonly unknown[],
  /** Notes besides the Inbox items and the base: other notes in the vault. */
  others: Record<string, string> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'dfai-assist-apply-'));
  roots.push(root);
  const trash = join(root, '..', `${root.split('/').pop()!}-trash`);
  roots.push(trash);
  const all = { ...BASE, ...others, ...notes };
  for (const folder of ['.atlas', '.atlas/types', 'Inbox', 'Projects', 'People', 'Tasks'])
    mkdirSync(join(root, folder));
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
    utimesSync(join(root, path), LEFT_AT, LEFT_AT);
  }
  hostFor(root, trash);
  const markdown = remarkMarkdown;
  const index = automationVault({ notes: all, today: TODAY, markdown }).ports.index;
  const ports: ApplyAssistPorts = {
    fs: inVault({ fs: tauriVaultFs, vault: root }),
    markdown,
    editors: {
      state: () => 'closed',
      flush: async () => {},
      follow: () => {},
      abandon: () => {},
      reload: () => {},
    },
    index: {
      ...index,
      notesOfType: async (type) =>
        (
          await index.query(
            "SELECT f.path, f.title FROM files f JOIN props p ON p.path = f.path AND p.key = 'type' WHERE p.value_text = ?",
            [type],
          )
        ).rows.map(([path, title]) => ({ path: String(path), title: String(title) })),
    },
    clock: CLOCK,
    activity: recordingActivity(),
  };
  const items = Object.keys(notes).map((path) =>
    inboxItem({
      path: createVaultPath(path),
      title: path.split('/').pop()!.slice(0, -3),
      type: null,
    }),
  );
  const text = JSON.stringify({ items: answers });
  const outcome = await previewInboxAssist(
    {
      ...ports,
      provider: () => ({
        id: 'claude-code',
        status: async () => ({ ready: true }),
        stream: async function* () {
          yield { type: 'text' as const, text };
        },
      }),
      deadline: () => new AbortController().signal,
      unsaved: () => false,
      recordAsk: () => undefined,
    },
    { items, previewed: [] },
  );
  if (outcome.kind !== 'plan') throw new Error(outcome.message);
  const notePaths = () =>
    walk(root)
      .filter((path) => path.endsWith('.md'))
      .map((path) => createVaultPath(path));
  /** Every file's bytes, hashed, by path as the disk spells it (the log under .atlas aside). */
  const disk = () =>
    new Map(
      walk(root)
        .filter((path) => !path.startsWith('.atlas/'))
        .map((path) => [path, sha(readFileSync(join(root, path)).toString('latin1'))]),
    );
  const apply = async (path: string) => {
    const row = outcome.rows.find((each) => each.path === path)!;
    const evidence = outcome.evidence.find((each) => each.item.path === path);
    return (
      await applyAssistRow(ports, {
        appliable: EVERY_ASSIST_KIND,
        row,
        evidence,
        notePaths: notePaths(),
      })
    ).applied;
  };
  const undo = (applied: AssistApplied) => {
    if (applied.kind !== 'applied') throw new Error(`not applied: ${applied.words}`);
    return undoAssistRow(ports, { undo: applied.undo, notePaths: notePaths() });
  };
  const edit = (path: string, text: string) => {
    writeFileSync(join(root, path), text);
    utimesSync(join(root, path), EDITED_AT, EDITED_AT);
  };
  return {
    root,
    trash,
    ports,
    outcome,
    notePaths,
    edit,
    disk,
    apply,
    undo,
    read: (path: string) => readFileSync(join(root, path), 'utf8'),
  };
}

const applied = (outcome: AssistApplied) => {
  if (outcome.kind !== 'applied') throw new Error(`not applied: ${outcome.words}`);
  return outcome;
};

const ARTICLE = 'Inbox/Payroll article.md';
const ARTICLE_TEXT = 'https://example.com/payroll\n\nA piece on payroll.\n';
const FILE_IT = entry(ARTICLE, { kind: 'reference', projects: [PROJECT] });
const RENEW = 'Inbox/Renew Larkspur contract.md';
const CALL = 'Inbox/Call Tobias.md';
const TOBIAS_TEXT = 'Call Tobias Fenn <tobias.fenn@example.com> about Larkspur.\n';
const ADD_TOBIAS = entry(CALL, {
  people: [{ name: 'Tobias Fenn', email: 'tobias.fenn@example.com', person: null }],
});
const MINE = 'My own line, typed after the move.\n';

const until = async (done: () => boolean) => {
  for (let tries = 0; tries < 5000 && !done(); tries += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

const differing = (before: Map<string, string>, after: Map<string, string>) =>
  [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p));

/** Stops every host call after the one `when` names: the app quit there, nothing rolled back. */
function crashAfter(when: (command: string, args: Record<string, unknown>) => boolean) {
  HOST.after = (command, args) => {
    if (when(command, args)) HOST.frozen = true;
  };
}

const READING = 'Notes/Reading.md';
const SECOND = 'Notes/Second.md';
const SELF_LINKED = `${ARTICLE_TEXT}Itself: [[Inbox/Payroll article]].\n`;

interface RowKind {
  readonly notes: Record<string, string>;
  readonly answers: readonly unknown[];
  readonly others: Record<string, string>;
  readonly path: string;
}

const ROW_KINDS: Record<string, RowKind> = {
  file: {
    notes: { [ARTICLE]: SELF_LINKED },
    answers: [FILE_IT],
    others: {
      [READING]: 'Read [[Inbox/Payroll article]].\n',
      [SECOND]: 'Also [[Inbox/Payroll article|it]] and ![[Inbox/Payroll article]].\n',
    },
    path: ARTICLE,
  },
  add: { notes: { [CALL]: TOBIAS_TEXT }, answers: [ADD_TOBIAS], others: {}, path: CALL },
  dup: {
    notes: { [RENEW]: '' },
    answers: [entry(RENEW, { duplicateOf: KEPT })],
    others: { [READING]: 'See [[Inbox/Renew Larkspur contract]].\n' },
    path: RENEW,
  },
  link: {
    notes: { 'Inbox/Call Mara.md': 'Call Mara Quill <mara.quill@example.com> by 2026-12-01.\n' },
    answers: [
      entry('Inbox/Call Mara.md', {
        due: '2026-12-01',
        people: [{ name: 'Mara Quill', email: null, person: MARA }],
      }),
    ],
    others: {},
    path: 'Inbox/Call Mara.md',
  },
};

type Vault = Awaited<ReturnType<typeof vaultWith>>;

/** Where a target note is now: the item wherever the row moved it, a person in the Trash too. */
function whereNow(v: Vault, target: string, item: string): string | null {
  if (target === 'item') {
    const name = item.split('/').pop()!;
    const found = walk(v.root).filter(
      (path) => path.split('/').pop() === name && !path.startsWith('Tasks/'),
    );
    return found.length === 1 ? join(v.root, found[0]!) : null;
  }
  if (existsSync(join(v.root, target))) return join(v.root, target);
  const trashed = join(v.trash, target.replaceAll('/', '__'));
  return existsSync(trashed) ? trashed : null;
}

/** Appends MINE to `file`, keeping its file time (`tick`) or giving it a later one. */
function append(file: string, when: 'tick' | 'later') {
  const time = statSync(file).mtime;
  writeFileSync(file, readFileSync(file, 'utf8') + MINE);
  if (when === 'tick') utimesSync(file, time, time);
  else utimesSync(file, EDITED_AT, EDITED_AT);
}

/** Refuses the next `times` writes to `path`, as a permission the host was denied. */
function refuseWrites(path: string, times = 1) {
  let left = times;
  HOST.before = (command, args) => {
    if (command === 'write_text_file' && args.path === path && left > 0) {
      left -= 1;
      throw new Error('permission denied');
    }
  };
}

describe('attack3 #911: an edit while a filing moves is never lost', () => {
  it('keeps an edit to a self-linking item made after its move, whether the row stops or is undone', async () => {
    const kind = ROW_KINDS.file!;
    const v = await vaultWith(kind.notes, kind.answers, kind.others);
    HOST.after = (command, args) => {
      if (command !== 'move_entry') return;
      append(join(v.root, String(args.to)), 'later');
      HOST.after = null;
    };
    const outcome = await v.apply(kind.path);
    if (outcome.kind === 'applied') await v.undo(outcome);
    const file = whereNow(v, 'item', kind.path);
    expect(file === null ? '' : readFileSync(file, 'utf8')).toContain(MINE);
  });
});

describe('attack3 #911: an undo that stopped can always be finished, and is never lost', () => {
  it('finishes an undo after a note it already put back is edited', async () => {
    const kind = ROW_KINDS.file!;
    const v = await vaultWith(kind.notes, kind.answers, kind.others);
    const done = applied(await v.apply(kind.path));
    refuseWrites(SECOND);
    expect((await v.undo(done)).kind).toBe('partly');
    HOST.before = null;
    // Reading was put back by the first try; the person then writes in it.
    v.edit(READING, `${v.read(READING)}${MINE}`);
    const again = await v.undo(done);
    expect(again.kind).toBe('undone');
    expect(v.read(READING)).toContain(MINE);
  });

  it('shows a partly undone row at the next Suggest, once the in-memory undo is gone', async () => {
    const kind = ROW_KINDS.file!;
    const v = await vaultWith(kind.notes, kind.answers, kind.others);
    const done = applied(await v.apply(kind.path));
    refuseWrites(SECOND, 99);
    expect((await v.undo(done)).kind).toBe('partly');
    HOST.before = null;
    expect(await findUnfinishedAssist({ fs: v.ports.fs })).not.toEqual([]);
  });

  it('leaves a record when the app quits partway through an undo', async () => {
    const kind = ROW_KINDS.file!;
    const v = await vaultWith(kind.notes, kind.answers, kind.others);
    const done = applied(await v.apply(kind.path));
    const appliedState = v.disk();
    crashAfter((command, args) => command === 'write_text_file' && args.path === READING);
    void v.undo(done);
    await until(() => HOST.frozen);
    resetHost();
    expect(differing(appliedState, v.disk())).toEqual([READING]);
    expect(await findUnfinishedAssist({ fs: v.ports.fs })).not.toEqual([]);
  });
});
