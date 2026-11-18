/**
 * #909, end to end on this side of the boundary: Inbox assist's rows applied
 * and undone through the real markdown adapter (YAML, byte-preserving) and
 * the real vault adapter, on a vault folder in the OS temp folder. The host
 * is stood in for by what follows, which does what the Rust commands do with
 * files: reads, writes held to the time it was read at, creates that refuse
 * to overwrite, moves, and a Trash that keeps what it is given and refuses a
 * file that is not exactly as read. It walks, reads and stores; it decides
 * nothing. The index answers from the notes as they were at the preview,
 * through real SQL. All names are made up.
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
  inVault,
  previewInboxAssist,
  recordingActivity,
  undoAssistRow,
  type ApplyAssistPorts,
  type AssistApplied,
} from '@dfai/application';
import { automationVault } from '@dfai/application/testing/sqlite';
import { createVaultPath, inboxItem } from '@dfai/domain';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { tauriVaultFs } = await import('@dfai/adapters/tauri');
const { remarkMarkdown } = await import('@dfai/adapters');

const TODAY = '2026-11-17';
/** The preview's notes were last changed hours before the clock's now: left alone. */
const LEFT_AT = new Date(`${TODAY}T08:00:00Z`);
const CLOCK = {
  now: () => Date.parse(`${TODAY}T12:00:00Z`),
  today: () => TODAY,
  localNow: () => `${TODAY}T12:00:00`,
};

const roots: string[] = [];
afterEach(() => {
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
    const run = commands[command];
    if (run === undefined) throw new Error(`the stand-in host has no ${command}`);
    return run(args);
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
  const disk = () =>
    new Map(
      walk(root)
        .filter((path) => !path.startsWith('.atlas/'))
        .map((path) => [path, readFileSync(join(root, path), 'utf8')]),
    );
  const apply = async (path: string) => {
    const row = outcome.rows.find((each) => each.path === path)!;
    const evidence = outcome.evidence.find((each) => each.item.path === path);
    return (await applyAssistRow(ports, { row, evidence, notePaths: notePaths() })).applied;
  };
  const undo = (applied: AssistApplied) => {
    if (applied.kind !== 'applied') throw new Error(`not applied: ${applied.words}`);
    return undoAssistRow(ports, { undo: applied.undo, notePaths: notePaths() });
  };
  return {
    root,
    ports,
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

describe('Inbox assist, applied and undone through the real adapters', () => {
  it('keeps a YAML block’s formatting, comments and all, and undoes it to the byte', async () => {
    const CALL = 'Inbox/Call Mara.md';
    const text =
      '---\n# kept by the web clipper\nsource:   "https://example.com/a"   \ntags: [inbox, call]\n---\n\nCall Mara Quill <mara.quill@example.com> by 2026-12-01.\n';
    const v = await vaultWith({ [CALL]: text }, [
      entry(CALL, {
        due: '2026-12-01',
        people: [{ name: 'Mara Quill', email: null, person: MARA }],
      }),
    ]);
    const before = v.disk();
    const done = applied(await v.apply(CALL));
    const after = v.read(done.path);
    expect(after).toContain(
      '# kept by the web clipper\nsource:   "https://example.com/a"   \ntags: [inbox, call]\n',
    );
    expect(after).toMatch(/\ndue: 2026-12-01\n/u);
    expect(after).toMatch(/\npeople:\n {2}- "\[\[Mara Quill\]\]"\n/u);
    expect(after.endsWith('\n\nCall Mara Quill <mara.quill@example.com> by 2026-12-01.\n')).toBe(
      true,
    );
    expect(await v.undo(done)).toMatchObject({ kind: 'undone' });
    expect(v.disk()).toEqual(before);
  });

  it('files a CRLF note with no frontmatter under its project, and undoes it to the byte', async () => {
    const ARTICLE = 'Inbox/Payroll article.md';
    const v = await vaultWith(
      { [ARTICLE]: 'https://example.com/payroll\r\n\r\nA piece on payroll.\r\n' },
      [entry(ARTICLE, { kind: 'reference', projects: [PROJECT] })],
    );
    const before = v.disk();
    const done = applied(await v.apply(ARTICLE));
    expect(done.path).toMatch(/^Notes\/2026\//u);
    expect(
      v.read(done.path).endsWith('https://example.com/payroll\r\n\r\nA piece on payroll.\r\n'),
    ).toBe(true);
    await v.undo(done);
    expect(v.disk()).toEqual(before);
  });

  it('adds a person with a name beyond ASCII, links them, and undoing takes them out', async () => {
    const CAFE = 'Inbox/Café with Zoë.md';
    const v = await vaultWith({ [CAFE]: 'Café with Zoë Ångström <zoe@example.com> on Friday.\n' }, [
      entry(CAFE, { people: [{ name: 'Zoë Ångström', email: 'zoe@example.com', person: null }] }),
    ]);
    const before = v.disk();
    const done = applied(await v.apply(CAFE));
    expect(done.words).toBe('Made it a task. Added Zoë Ångström.');
    expect(v.read('People/Zoë Ångström.md')).toMatch(/\nemail: zoe@example.com\n/u);
    expect(v.read(CAFE)).toContain('"[[Zoë Ångström]]"');
    expect(await v.undo(done)).toMatchObject({ kind: 'undone' });
    expect(v.disk()).toEqual(before);
  });

  it('archives a duplicate, leaving the kept task’s bytes alone, and puts it back exactly where it was', async () => {
    const RENEW = 'Inbox/Renew Larkspur contract.md';
    const v = await vaultWith({ [RENEW]: '' }, [entry(RENEW, { duplicateOf: KEPT })]);
    const before = v.disk();
    const done = applied(await v.apply(RENEW));
    expect(done.path).toBe(`Archive/${RENEW}`);
    expect(v.read(done.path)).toMatch(
      /atlas_duplicate_of: "\[\[Tasks\/Renew Larkspur contract\]\]"/u,
    );
    expect(v.read(KEPT)).toBe(BASE[KEPT]);
    await v.undo(done);
    expect(v.disk()).toEqual(before);
  });

  it('writes nothing when the item cannot be written: permission denied', async () => {
    const CALL = 'Inbox/Call Mara.md';
    const v = await vaultWith({ [CALL]: 'Call Mara Quill <mara.quill@example.com>.\n' }, [
      entry(CALL, {
        projects: [PROJECT],
        people: [{ name: 'Mara Quill', email: null, person: MARA }],
      }),
    ]);
    chmodSync(join(v.root, CALL), 0o444);
    const before = v.disk();
    const outcome = await v.apply(CALL);
    expect(outcome).toMatchObject({
      kind: 'failed',
      words: expect.stringMatching(/Nothing was left changed\.$/u),
    });
    expect(v.disk()).toEqual(before);
  });

  it('refuses to undo once another note has taken the item’s old place, touching neither', async () => {
    const CALL = 'Inbox/Call Mara.md';
    const v = await vaultWith({ [CALL]: 'Call Mara Quill <mara.quill@example.com>.\n' }, [
      entry(CALL, {
        projects: [PROJECT],
        people: [{ name: 'Mara Quill', email: null, person: MARA }],
      }),
    ]);
    const done = applied(await v.apply(CALL));
    writeFileSync(join(v.root, CALL), 'A new capture.\n');
    const taken = v.disk();
    expect(await v.undo(done)).toMatchObject({
      kind: 'refused',
      words: expect.stringContaining('taken its place'),
    });
    expect(v.disk()).toEqual(taken);
  });

  it('the host refuses a save held to text the note no longer says, in the same file time', async () => {
    const CALL = 'Inbox/Call Mara.md';
    const v = await vaultWith({ [CALL]: 'Call Mara Quill.\n' }, [entry(CALL)]);
    const read = await v.ports.fs.readTextFile(createVaultPath(CALL));
    // Another program's edit, landing within the disk's timestamp tick: the time stays.
    writeFileSync(join(v.root, CALL), 'Edited elsewhere.\n');
    utimesSync(join(v.root, CALL), new Date(read.modified), new Date(read.modified));
    expect(mtime(join(v.root, CALL))).toBe(read.modified);
    const save = v.ports.fs.writeTextFile({
      path: createVaultPath(CALL),
      contents: 'Mine.\n',
      expectedModified: read.modified,
      expectedText: read.text,
    });
    await expect(save).rejects.toThrow(CHANGED_ON_DISK);
    expect(v.read(CALL)).toBe('Edited elsewhere.\n');
  });

  it('stamps no duplicate whose text changed within the same file time after the check', async () => {
    const RENEW = 'Inbox/Renew Larkspur contract.md';
    const v = await vaultWith({ [RENEW]: '' }, [entry(RENEW, { duplicateOf: KEPT })]);
    const read = invoke.getMockImplementation()!;
    let reads = 0;
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      const answer = await read(command, args);
      if (command === 'read_text_file' && args['path'] === RENEW && ++reads === 1) {
        const file = join(v.root, RENEW);
        const time = statSync(file).mtime;
        writeFileSync(file, 'Ask them about the price first.\n');
        utimesSync(file, time, time);
      }
      return answer;
    });
    const outcome = await v.apply(RENEW);
    expect(outcome.kind).toBe('failed');
    expect(v.read(RENEW)).toBe('Ask them about the price first.\n');
    expect(existsSync(join(v.root, 'Archive'))).toBe(false);
  });

  it('puts back every other note a filing rewrote: a bare link to a shared title, a path link with an alias', async () => {
    const CALL = 'Inbox/Call Mara.md';
    const WEEK = 'Notes/Week.md';
    const week =
      'See [[Call Mara]], [[Inbox/Call Mara|the call]] and [[Tasks/Call Mara|the task]].\n';
    const v = await vaultWith(
      { [CALL]: 'Call Mara Quill <mara.quill@example.com>.\n' },
      [
        entry(CALL, {
          projects: [PROJECT],
          people: [{ name: 'Mara Quill', email: null, person: MARA }],
        }),
      ],
      { 'Reference/Call Mara.md': 'Notes on calling Mara.\n', [WEEK]: week },
    );
    const before = v.disk();
    const done = applied(await v.apply(CALL));
    expect(v.read(WEEK)).not.toBe(week);
    expect(done.undo.item.relinked?.map((note) => note.path)).toEqual([WEEK]);
    expect(await v.undo(done)).toMatchObject({ kind: 'undone' });
    expect(v.read(WEEK)).toBe(week);
    expect(v.disk()).toEqual(before);
  });

  it('adds a person with their address spelled as the item spells it', async () => {
    const LUNCH = 'Inbox/Lunch with Tobias.md';
    const v = await vaultWith(
      { [LUNCH]: 'Lunch with Tobias Fenn <Tobias.Fenn@Example.org> on Friday.\n' },
      [
        entry(LUNCH, {
          people: [{ name: 'Tobias Fenn', email: 'tobias.fenn@example.org', person: null }],
        }),
      ],
    );
    applied(await v.apply(LUNCH));
    expect(v.read('People/Tobias Fenn.md')).toMatch(/\nemail: Tobias\.Fenn@Example\.org\n/u);
  });

  it('archives a duplicate under a numbered name when the Archive has its name, and puts it back exactly', async () => {
    const RENEW = 'Inbox/Renew Larkspur contract.md';
    const taken = `Archive/${RENEW}`;
    const v = await vaultWith({ [RENEW]: '' }, [entry(RENEW, { duplicateOf: KEPT })], {
      [taken]: '---\narchived: 2026-10-01\n---\nAn older copy.\n',
    });
    const before = v.disk();
    const done = applied(await v.apply(RENEW));
    expect(done.path).not.toBe(taken);
    expect(done.path).toMatch(/^Archive\/Inbox\/Renew Larkspur contract.+\.md$/u);
    expect(v.read(taken)).toBe(before.get(taken));
    await v.undo(done);
    expect(v.disk()).toEqual(before);
  });
});
