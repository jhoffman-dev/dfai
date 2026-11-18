/**
 * Attack on #911 (#909): Inbox assist's apply and undo through the real
 * markdown adapter and the real vault adapter, on vault folders in the OS
 * temp folder, with the stand-in host of `inbox-assist-apply.integration.test.ts`
 * (copied, plus a hook to cut in before any host command). Every file's
 * bytes and the full file list are compared. All names are made up.
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
const LEFT_AT = new Date(`${TODAY}T08:00:00Z`);
/** Later than the preview, so an edit made in a test has a new file time. */
const EDITED_AT = new Date(`${TODAY}T09:00:00Z`);
const CLOCK = {
  now: () => Date.parse(`${TODAY}T12:00:00Z`),
  today: () => TODAY,
  localNow: () => `${TODAY}T12:00:00`,
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!existsSync(root)) continue;
    chmodSync(root, 0o755);
    for (const path of walkAll(root)) chmodSync(join(root, path), 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

function walk(root: string, at = ''): string[] {
  return readdirSync(join(root, at), { withFileTypes: true }).flatMap((entry) => {
    const path = at === '' ? entry.name : `${at}/${entry.name}`;
    return entry.isDirectory() ? walk(root, path) : [path];
  });
}

function walkAll(root: string, at = ''): string[] {
  return readdirSync(join(root, at), { withFileTypes: true }).flatMap((entry) => {
    const path = at === '' ? entry.name : `${at}/${entry.name}`;
    return entry.isDirectory() ? [path, ...walkAll(root, path)] : [path];
  });
}

const mtime = (file: string) => Math.floor(statSync(file).mtimeMs);
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

type Hook = (command: string, args: Record<string, unknown>) => void;

function hostFor(root: string, trash: string, hooks: { before: Hook | null }) {
  const at = (path: unknown) => join(root, String(path));
  const entry = (path: string) => {
    const stat = statSync(at(path));
    return {
      name: path.split('/').pop()!,
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
          throw new Error('a file changed on disk since it was read');
        }
      }
      mkdirSync(trash, { recursive: true });
      renameSync(at(path), join(trash, String(path).replaceAll('/', '__')));
    },
    write_text_file: ({ path, contents, expectedModified }) => {
      if (
        expectedModified !== null &&
        existsSync(at(path)) &&
        mtime(at(path)) !== expectedModified
      ) {
        throw new Error('the note changed on disk since it was read');
      }
      writeFileSync(at(path), String(contents));
      return mtime(at(path));
    },
  };
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    hooks.before?.(command, args);
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

async function vaultWith(
  notes: Record<string, string>,
  answers: readonly unknown[],
  others: Record<string, string> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'dfai-attack-911-'));
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
  const hooks: { before: Hook | null } = { before: null };
  hostFor(root, trash, hooks);
  const markdown = remarkMarkdown;
  const index = automationVault({ notes: all, today: TODAY, markdown }).ports.index;
  const activity = recordingActivity();
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
    activity,
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
  /** Every file's bytes, by path as the disk spells it (the log under .atlas aside). */
  const disk = () =>
    new Map(
      walk(root)
        .filter((path) => !path.startsWith('.atlas/'))
        .map((path) => [path, sha(readFileSync(join(root, path)))]),
    );
  const rowOf = (path: string) => outcome.rows.find((each) => each.path === path)!;
  const evidenceOf = (path: string) => outcome.evidence.find((each) => each.item.path === path);
  const apply = async (path: string) =>
    (
      await applyAssistRow(ports, {
        row: rowOf(path),
        evidence: evidenceOf(path),
        notePaths: notePaths(),
      })
    ).applied;
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
    ports,
    hooks,
    activity,
    outcome,
    rowOf,
    evidenceOf,
    notePaths,
    disk,
    apply,
    undo,
    edit,
    read: (path: string) => readFileSync(join(root, path), 'utf8'),
  };
}

const applied = (outcome: AssistApplied) => {
  if (outcome.kind !== 'applied') throw new Error(`not applied: ${outcome.words}`);
  return outcome;
};

const CALL = 'Inbox/Call Tobias.md';
const TOBIAS_TEXT = 'Call Tobias Fenn <tobias.fenn@example.com> about Larkspur.\n';
const ADD_TOBIAS = entry(CALL, {
  people: [{ name: 'Tobias Fenn', email: 'tobias.fenn@example.com', person: null }],
});

describe('attack #911: apply then undo, every byte and path', () => {
  it('leaves a third note’s bare link to a same-titled task as it was after undoing a duplicate', async () => {
    const RENEW = 'Inbox/Renew Larkspur contract.md';
    const REF = 'Notes/Week.md';
    const said = 'See [[Inbox/Renew Larkspur contract]] and [[Renew Larkspur contract]].\n';
    const v = await vaultWith({ [RENEW]: '' }, [entry(RENEW, { duplicateOf: KEPT })], {
      [REF]: said,
    });
    const before = v.disk();
    const done = applied(await v.apply(RENEW));
    expect(await v.undo(done)).toMatchObject({ kind: 'undone' });
    expect(v.read(REF)).toBe(said);
    expect(v.disk()).toEqual(before);
  });
});

describe('attack #911: undo after an edit in between touches nothing', () => {
  it('refuses to undo an added person a third note now links to, and trashes nothing', async () => {
    const v = await vaultWith({ [CALL]: TOBIAS_TEXT }, [ADD_TOBIAS]);
    const done = applied(await v.apply(CALL));
    expect(existsSync(join(v.root, 'People/Tobias Fenn.md'))).toBe(true);
    v.edit('Projects/Larkspur Payroll.md', `${BASE[PROJECT]}\nOwner: [[Tobias Fenn]]\n`);
    const linked = v.disk();
    const undone = await v.undo(done);
    expect(undone.kind).toBe('refused');
    expect(v.disk()).toEqual(linked);
  });
});

describe('attack #911: hostile plans are refused', () => {
  it('refuses a row whose evidence is for a different item before writing to it', async () => {
    const A = 'Inbox/Book the venue.md';
    const B = 'Inbox/Pay the invoice.md';
    const v = await vaultWith({ [A]: 'Book the venue.\n', [B]: 'Pay the invoice.\n' }, [
      entry(A),
      entry(B),
    ]);
    // B is edited after the preview: its own row would ask. Handed A's evidence, it must too.
    v.edit(B, 'Pay the invoice. Actually, keep this as a note, not a task.\n');
    utimesSync(join(v.root, B), LEFT_AT, LEFT_AT);
    const writes: string[] = [];
    v.hooks.before = (command, args) => {
      if (command === 'write_text_file' || command === 'move_entry')
        writes.push(String(args.path ?? args.from));
    };
    const before = v.disk();
    const outcome = await applyAssistRow(v.ports, {
      row: v.rowOf(B),
      evidence: v.evidenceOf(A),
      notePaths: v.notePaths(),
    });
    expect(outcome.applied.kind).not.toBe('applied');
    expect(v.disk()).toEqual(before);
    // The re-check read A; nothing may be opened for write on B, which it never checked.
    expect(writes.filter((path) => path.endsWith(B))).toEqual([]);
  });
});

describe('attack #911: the person’s own words', () => {
  it('never applies a due date that is only part of a URL', async () => {
    const LINK = 'Inbox/Notes link.md';
    const v = await vaultWith({ [LINK]: 'Read https://example.com/2026-12-01/notes later.\n' }, [
      entry(LINK, { due: '2026-12-01' }),
    ]);
    const before = v.disk();
    expect((await v.apply(LINK)).kind).toBe('asked');
    expect(v.disk()).toEqual(before);
  });

  it('asks rather than add a person named only in a mail client’s wrapped attribution', async () => {
    const FWD = 'Inbox/Re payroll.md';
    const text =
      'Sounds good, will do.\n\nOn Tue, Nov 17, 2026 at 9:02 AM Tobias Fenn <tobias.fenn@example.com>\nwrote:\n> Can you renew the Larkspur contract?\n';
    const v = await vaultWith({ [FWD]: text }, [
      entry(FWD, {
        people: [{ name: 'Tobias Fenn', email: 'tobias.fenn@example.com', person: null }],
      }),
    ]);
    const before = v.disk();
    const outcome = await v.apply(FWD);
    expect(outcome.kind).toBe('asked');
    expect(v.disk()).toEqual(before);
  });
});

/** A small seeded generator (mulberry32): the same seed gives the same vaults. */
function seeded(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return <T>(choices: readonly T[]): T => choices[Math.floor(next() * choices.length)]!;
}

const FRONTMATTERS: Record<string, string[] | null> = {
  none: null,
  empty: [],
  comment: ['# clipped', 'source:   "https://example.com/a"   # where'],
  anchors: ['base: &b larkspur', 'copy: *b'],
  quoted: ['"source": \'https://example.com/q\'', 'tags: [inbox, "a b"]'],
  tabs: ['note: "a\tb"', 'tags:', '  - inbox'],
  order: ['zeta: 1', 'alpha: 2', 'Mid: x'],
  unicode: ['titre: Café crème', 'nfd: Café'],
};

const KINDS = ['due-link', 'file', 'add', 'dup', 'task'] as const;

function generatedCase(pick: ReturnType<typeof seeded>) {
  const kind = pick(KINDS);
  const name =
    kind === 'dup'
      ? 'Renew Larkspur contract'
      : pick(['Call about Larkspur', 'Café plan', 'Café plan NFD', 'Ünïcödé note']);
  const path = `Inbox/${name}.md`;
  const eol = pick(['\n', '\r\n', 'mixed']);
  const fm = pick(Object.keys(FRONTMATTERS));
  const extra = kind === 'dup' ? 'none' : pick(['none', 'rule', 'long', 'unicode']);
  const said: Record<(typeof KINDS)[number], string[]> = {
    'due-link': ['Call Mara Quill <mara.quill@example.com> by 2026-12-01.'],
    file: ['https://example.com/payroll', '', 'A piece on payroll.'],
    add: ['Call Tobias Fenn <tobias.fenn@example.com> about Larkspur.'],
    dup: [],
    task: ['Book the venue for the offsite.'],
  };
  const extras: Record<string, string[]> = {
    none: [],
    rule: ['', '---', '', 'After a rule.'],
    long: ['', 'x'.repeat(5000)],
    unicode: ['', 'Zoë’s “notes” — ünïcödé 🌿.'],
  };
  const block = FRONTMATTERS[fm]!;
  const lines = [
    ...(block === null ? [] : ['---', ...block, '---', '']),
    ...said[kind],
    ...extras[extra]!,
  ];
  const ending = (at: number) => (eol === 'mixed' ? (at % 2 === 0 ? '\r\n' : '\n') : eol);
  const trailing = pick([true, false]);
  let text = lines
    .map((line, at) => line + (at < lines.length - 1 || trailing ? ending(at) : ''))
    .join('');
  if (pick([true, false])) text = `\uFEFF${text}`;
  const answer: Record<(typeof KINDS)[number], Record<string, unknown>> = {
    'due-link': { due: '2026-12-01', people: [{ name: 'Mara Quill', email: null, person: MARA }] },
    file: { kind: 'reference', projects: [PROJECT] },
    add: { people: [{ name: 'Tobias Fenn', email: 'tobias.fenn@example.com', person: null }] },
    dup: { duplicateOf: KEPT },
    task: {},
  };
  const title = name;
  return {
    label: JSON.stringify({ kind, name, eol, fm, extra, trailing, bom: text.startsWith('\uFEFF') }),
    path,
    text,
    answer: entry(path, answer[kind]),
    ref: { 'Notes/Ref.md': `See [[Inbox/${title}]], [[${title}]] and [[${title}|it]].\n` },
  };
}

describe('attack #911: seeded apply-then-undo over hostile formatting', () => {
  it('leaves every byte and path as before, and never writes the kept task', async () => {
    const seed = 4242;
    const cases = 60;
    console.log(`apply-then-undo property: seed ${seed}, ${cases} cases`);
    const pick = seeded(seed);
    const broken: string[] = [];
    const tally: Record<string, number> = {};
    for (let n = 0; n < cases; n += 1) {
      const c = generatedCase(pick);
      const v = await vaultWith({ [c.path]: c.text }, [c.answer], c.ref);
      const touched: string[] = [];
      v.hooks.before = (command, args) => {
        if (['write_text_file', 'move_entry', 'trash_entry'].includes(command))
          touched.push(String(args.path ?? args.from));
      };
      const before = v.disk();
      const outcome = await v.apply(c.path);
      tally[outcome.kind] = (tally[outcome.kind] ?? 0) + 1;
      if (touched.includes(KEPT)) broken.push(`${c.label}: wrote the kept task`);
      if (outcome.kind === 'applied') {
        const undone = await v.undo(outcome);
        if (undone.kind !== 'undone') broken.push(`${c.label}: undo ${undone.words}`);
      }
      const after = v.disk();
      const same = [...before].every(([p, h]) => after.get(p) === h) && after.size === before.size;
      if (!same) {
        const diff = [...new Set([...before.keys(), ...after.keys()])].filter(
          (p) => before.get(p) !== after.get(p),
        );
        broken.push(`${c.label} (${outcome.kind}): differs at ${diff.join(', ')}`);
      }
    }
    console.log('outcomes', tally);
    expect(broken).toEqual([]);
  }, 120_000);
});
