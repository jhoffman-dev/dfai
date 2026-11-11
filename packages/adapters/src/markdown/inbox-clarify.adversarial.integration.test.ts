/**
 * Adversarial pass on #112 (Inbox clarify): deciding a task on its row with
 * the real YAML writer, over an in-memory vault that behaves like the host.
 * The invariant under attack: a decision changes the keys it sets and not one
 * byte besides, and undo gives the vault back byte for byte.
 */
import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  movedPath,
  parentVaultPath,
  vaultPathName,
  type Clarification,
  type EntryMove,
  type VaultEntry,
  type VaultPath,
} from '@dfai/domain';
import {
  clarifyInboxItem,
  ClarifyRefusedError,
  undoClarifyInboxItem,
  type ArchivePorts,
  type IndexPort,
  type VaultFsPort,
} from '@dfai/application';
import { remarkMarkdown } from './markdown-port.ts';

const TODAY = '2026-10-12';
const TASK = 'Inbox/Call Tobias Fenn.md';
const PROJECT = 'Projects/Larkspur Payroll.md';
const PERSON = 'People/Mara Quill.md';

function memoryVault(notes: Record<string, string>) {
  const files = new Map(Object.entries(notes));
  const stamps = new Map<string, number>();
  let tick = 1;
  const dirs = new Set<string>();
  /** What happens on disk right after each of the next reads: an edit from outside, say. */
  const afterRead: ((at: string) => void)[] = [];
  const editOutside = (at: string, text: string) => {
    files.set(at, text);
    tick += 1;
    stamps.set(at, tick);
  };
  for (const at of files.keys()) {
    let folder = parentVaultPath(createVaultPath(at));
    while (folder !== '') {
      dirs.add(folder);
      folder = parentVaultPath(folder);
    }
  }
  const entry = (at: string, kind: VaultEntry['kind']): VaultEntry =>
    ({ kind, name: vaultPathName(createVaultPath(at)), path: createVaultPath(at) }) as VaultEntry;
  const used: Partial<VaultFsPort> = {
    listDirectory: async (parent) => [
      ...[...dirs]
        .filter((at) => parentVaultPath(createVaultPath(at)) === parent)
        .map((at) => entry(at, 'directory')),
      ...[...files.keys()]
        .filter((at) => parentVaultPath(createVaultPath(at)) === parent)
        .map((at) => entry(at, 'file')),
    ],
    createFolder: async ({ path }) => {
      if (dirs.has(path) || files.has(path)) throw new Error('already there');
      dirs.add(path);
    },
    moveEntry: async (move: EntryMove) => {
      if (!files.has(move.from)) throw new Error('no such entry');
      if (files.has(move.to) || dirs.has(move.to)) throw new Error('already there');
      for (const [at, text] of [...files]) {
        const to = movedPath(at as VaultPath, move);
        if (to !== null) {
          files.delete(at);
          files.set(to, text);
        }
      }
    },
    readTextFile: async (at) => {
      const text = files.get(at);
      if (text === undefined) throw new Error('no such note');
      const read = { text, modified: stamps.get(at) ?? 1 };
      afterRead.shift()?.(at);
      return read;
    },
    readNotes: async (paths) =>
      paths.flatMap((at) => {
        const text = files.get(at);
        return text === undefined ? [] : [{ path: at, text, modified: 1, size: text.length }];
      }),
    writeTextFile: async ({ path, contents }) => {
      files.set(path, contents);
      tick += 1;
      stamps.set(path, tick);
      return tick;
    },
  };
  const fs = new Proxy(used, {
    get: (target, name: string) => {
      const method = target[name as keyof VaultFsPort];
      if (method === undefined) throw new Error(`fs.${name} is not faked`);
      return method;
    },
  }) as VaultFsPort;
  const index = { remove: async () => {} } as unknown as IndexPort;
  const ports: ArchivePorts = {
    fs,
    markdown: remarkMarkdown,
    index,
    editors: {
      state: () => 'closed',
      flush: async () => {},
      follow: () => {},
      abandon: () => {},
      reload: () => {},
    },
  };
  const notePaths = () => [...files.keys()].map((at) => createVaultPath(at));
  const clarify = (at: string, clarification: Clarification) =>
    clarifyInboxItem({
      ports,
      path: createVaultPath(at),
      clarification,
      notePaths: notePaths(),
      today: TODAY,
    });
  return { files, ports, notePaths, clarify, afterRead, editOutside };
}

const OTHERS = {
  [PROJECT]: '---\ntype: project\n---\n\nThe payroll run.\n',
  [PERSON]: '---\ntype: person\n---\n\nA colleague.\n',
};

const person = createVaultPath(PERSON);
const project = createVaultPath(PROJECT);

/**
 * Seeded, so a failure names a vault that can be built again. The seed is
 * scrambled first: fed in as it is, seeds 1 to 200 all drew the same first
 * number, so no note was ever drawn without the first of OTHER_LINES (#820).
 */
function seeded(seed: number) {
  let mixed = (seed + 0x6d2b79f5) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
  mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
  let state = (mixed ^ (mixed >>> 14)) >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return {
    int: (below: number) => Math.floor(next() * below),
    pick: <T>(of: readonly T[]) => of[Math.floor(next() * of.length)]!,
  };
}

const OTHER_LINES = [
  '# captured in the hallway',
  "title: 'Call: Tobias Fenn'",
  'tags: [a,   b]',
  'estimate: "30"',
  'source:   https://example.com/a?b=c#d',
  'people:\n  - "[[Mara Quill]]"\n  - Tobias Fenn',
  'note: |\n  kept  \n  as written',
  'emoji: "📞 שלום"',
  'odd key: yes',
];

function randomTask(seed: number) {
  const random = seeded(seed);
  const lines = OTHER_LINES.filter(() => random.int(2) === 0);
  for (const line of ['type: task', 'status: inbox'])
    lines.splice(random.int(lines.length + 1), 0, line);
  const eol = random.pick(['\n', '\r\n']);
  const body = random.pick(BODIES);
  const text = `---\n${lines.join('\n')}\n---\n${body}`.replaceAll('\n', eol);
  const decision = random.pick(DECISIONS());
  const back: Clarification = {
    status: 'inbox',
    ...(decision.waitingOn !== undefined && { waitingOn: null }),
    ...(decision.defer !== undefined && { defer: null }),
    ...(decision.due !== undefined && { due: null }),
    ...(decision.contexts !== undefined && { contexts: [] }),
  };
  const at = lines.indexOf('status: inbox');
  const where = at === 0 ? 'first' : at === lines.length - 1 ? 'last' : 'between';
  const shapes = [
    `${JSON.stringify(decision)} with ${JSON.stringify(eol)}`,
    `${JSON.stringify(decision)} over ${JSON.stringify(body)}`,
    `status ${where} with ${JSON.stringify(eol)}`,
    ...OTHER_LINES.map((line) => `${JSON.stringify(line)} ${lines.includes(line)}`),
  ];
  return { text, eol, decision, back, shapes };
}

const BODIES = ['', 'Body.\n', '\n# Agenda\n\n---\nstatus: inbox\n---\n', 'No newline at the end'];
const DECISIONS = (): Clarification[] => [
  { status: 'next-action' },
  { status: 'someday', defer: '2026-11-02' },
  { status: 'waiting', waitingOn: person, due: '2026-10-20' },
  { status: 'archive' },
  { due: '2026-12-31', contexts: ['@phone', '@a: b'] },
];

/** Every shape a decision turns on: what the 100 seeds below are shown to draw. */
const EVERY_SHAPE = [
  ...DECISIONS().flatMap((decision) => [
    ...['\n', '\r\n'].map((eol) => `${JSON.stringify(decision)} with ${JSON.stringify(eol)}`),
    ...BODIES.map((body) => `${JSON.stringify(decision)} over ${JSON.stringify(body)}`),
  ]),
  ...['first', 'between', 'last'].flatMap((where) =>
    ['\n', '\r\n'].map((eol) => `status ${where} with ${JSON.stringify(eol)}`),
  ),
  ...OTHER_LINES.flatMap((line) => [
    `${JSON.stringify(line)} true`,
    `${JSON.stringify(line)} false`,
  ]),
];

/**
 * 100 seeds, not 200: 87 already draw every decision with each line ending
 * and over each body, the status key first, between and last, and every
 * other line kept and left out. The runs past that drew more of the same,
 * and cost seconds when the gate shared the machine (#820).
 */
const SEEDS = 100;

const SET_KEYS = /^(status|waiting_on|defer|due|contexts|completed):/;

/** A note's lines that a decision has no business with: everything but the keys it sets. */
const untouched = (text: string, eol: string) =>
  text.split(eol).filter((line) => !SET_KEYS.test(line) && !line.startsWith('  - "@'));

describe('deciding a task changes the keys it sets and nothing else (#112)', () => {
  it.each([
    [
      'comments, quotes and an odd key order',
      '---\n# captured in the hallway\ndue: "2026-11-02"\nstatus: inbox\ntitle: \'Call: Tobias Fenn\'\ntype: task\ntags: [a,   b]\n---\n\nBody.\n',
    ],
    [
      'CRLF line endings',
      '---\r\ntype: task\r\nstatus: inbox\r\ndue: 2026-11-02\r\n---\r\n\r\nBody.\r\n',
    ],
    ['a byte-order mark', '﻿---\ntype: task\nstatus: inbox\n---\n\nBody.\n'],
    ['trailing spaces', '---\ntype: task   \nstatus: inbox\ndue: 2026-11-02  \n---\n\nBody.  \n'],
    [
      'a waiting_on over several lines',
      '---\ntype: task\nstatus: inbox\nwaiting_on:\n  - "[[Mara Quill]]"\n  - "[[Tobias Fenn]]"\n---\n\nBody.\n',
    ],
    [
      'a body that looks like frontmatter',
      '---\ntype: task\nstatus: inbox\n---\n\nBody.\n\n---\nstatus: inbox\n---\n',
    ],
    ['no newline at the end', '---\ntype: task\nstatus: inbox\n---\nBody'],
    ['a comment after the last key', '---\ntype: task\nstatus: inbox\n# keep me\n---\n\nBody.\n'],
  ])('keeps every other byte: %s', async (_name, text) => {
    const vault = memoryVault({ ...OTHERS, [TASK]: text });
    await vault.clarify(TASK, { status: 'next-action' });
    expect(vault.files.get(TASK)).toBe(text.replace('status: inbox', 'status: next-action'));
  });

  // #129, fixed with #430: the shared YAML writer used to drop that line when the last key changed.
  it('keeps the blank line a note has between its last key and the closing fence', async () => {
    const text = '---\ntype: task\nstatus: inbox\n\n---\n\nBody.\n';
    const vault = memoryVault({ ...OTHERS, [TASK]: text });
    await vault.clarify(TASK, { status: 'next-action' });
    expect(vault.files.get(TASK)).toBe('---\ntype: task\nstatus: next-action\n\n---\n\nBody.\n');
  });

  it('refuses a status written twice, leaving the note as it was', async () => {
    const text = '---\ntype: task\nstatus: inbox\nstatus: backlog\n---\n\nBody.\n';
    const vault = memoryVault({ ...OTHERS, [TASK]: text });
    await expect(vault.clarify(TASK, { status: 'next-action' })).rejects.toBeInstanceOf(
      ClarifyRefusedError,
    );
    expect(vault.files.get(TASK)).toBe(text);
  });

  it('over 100 seeded notes: every line but the keys set is kept, and undo gives the note back', async () => {
    const drawn = new Set<string>();
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const { text, eol, decision, shapes } = randomTask(seed);
      for (const shape of shapes) drawn.add(shape);
      const vault = memoryVault({ ...OTHERS, [TASK]: text });
      const outcome = await vault.clarify(TASK, decision);
      const after = vault.files.get(TASK) ?? '';
      expect(untouched(after, eol), `seed ${seed}`).toEqual(untouched(text, eol));
      await undoClarifyInboxItem({
        ports: vault.ports,
        undo: outcome.undo,
        notePaths: vault.notePaths(),
      });
      expect(vault.files.get(TASK), `seed ${seed}`).toBe(text);
    }
    expect(EVERY_SHAPE.filter((shape) => !drawn.has(shape))).toEqual([]);
  });

  it('over 100 seeded notes: deciding and then deciding back to Inbox restores the note', async () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const { text, decision, back } = randomTask(seed);
      const vault = memoryVault({ ...OTHERS, [TASK]: text });
      await vault.clarify(TASK, decision);
      await vault.clarify(TASK, back);
      expect(vault.files.get(TASK), `seed ${seed}`).toBe(text);
    }
  });
});

describe('making a note a task (#112)', () => {
  it('keeps a byte-order mark at the start of the file, not in the middle of it', async () => {
    const vault = memoryVault({ ...OTHERS, [TASK]: '﻿Just words.\n' });
    await vault.clarify(TASK, { asTask: true });
    const text = vault.files.get(TASK) ?? '';
    expect(text.indexOf('﻿', 1)).toBe(-1);
  });

  it('writes the frontmatter it adds with the line endings the note has', async () => {
    const vault = memoryVault({ ...OTHERS, [TASK]: 'Just words.\r\nMore.\r\n' });
    await vault.clarify(TASK, { asTask: true });
    expect((vault.files.get(TASK) ?? '').replaceAll('\r\n', '')).not.toContain('\n');
  });

  it.each([
    ['a list', '---\n- a\n- b\n---\n\nBody.\n'],
    ['a bare string', '---\njust a string\n---\n\nBody.\n'],
  ])(
    'refuses a note whose frontmatter is %s with a reason, not a YAML error',
    async (_name, text) => {
      const vault = memoryVault({ ...OTHERS, [TASK]: text });
      await expect(vault.clarify(TASK, { asTask: true })).rejects.toBeInstanceOf(
        ClarifyRefusedError,
      );
      expect(vault.files.get(TASK)).toBe(text);
    },
  );

  it.each([
    ['a list', '---\ntype: [meeting]\n---\nBody.\n'],
    ['a number', '---\ntype: 5\n---\nBody.\n'],
  ])('never takes away a type the note already says, written as %s', async (_name, text) => {
    const vault = memoryVault({ ...OTHERS, [TASK]: text });
    await vault.clarify(TASK, { asTask: true }).catch(() => undefined);
    expect(vault.files.get(TASK)).toBe(text);
  });
});

describe('undo gives the vault back (#112)', () => {
  const LINKERS = {
    'Notes/Log.md':
      'See [[Call Tobias Fenn]], [[Inbox/Call Tobias Fenn|the call]] and ![[Call Tobias Fenn#Agenda]].\n',
    'Inbox/Other.md':
      '---\ntype: task\nstatus: inbox\nrelated: "[[Inbox/Call Tobias Fenn]]"\n---\n[[Call Tobias Fenn]]\n',
  };
  const SELF =
    '---\ntype: task\nstatus: inbox\n---\n\nSelf [[Call Tobias Fenn]] and [[Inbox/Call Tobias Fenn]].\n';

  async function filedAndUndone(files: Record<string, string>) {
    const vault = memoryVault(files);
    const outcome = await vault.clarify(TASK, { status: 'next-action', project });
    expect(outcome.failed).toEqual([]);
    expect(outcome.movedFrom).toBe(TASK);
    await undoClarifyInboxItem({
      ports: vault.ports,
      undo: outcome.undo,
      notePaths: vault.notePaths(),
    });
    return Object.fromEntries(vault.files);
  }

  it('puts back every link the filing rewrote, in the note and in the notes that link it', async () => {
    const files = { ...OTHERS, ...LINKERS, [TASK]: SELF };
    expect(await filedAndUndone(files)).toEqual(files);
  });

  it('puts them back when the place it was filed in was taken, and it was numbered', async () => {
    const files = {
      ...OTHERS,
      ...LINKERS,
      [TASK]: SELF,
      'Tasks/2026/10/Call Tobias Fenn.md': 'Already here.\n',
    };
    expect(await filedAndUndone(files)).toEqual(files);
  });

  // Left red on purpose (#129): the move back respells other notes' links by path.
  it.fails('puts them back as they were written when another note has the same name', async () => {
    const files = {
      ...OTHERS,
      ...LINKERS,
      [TASK]: SELF,
      'Notes/Call Tobias Fenn.md': 'Namesake.\n',
    };
    expect(await filedAndUndone(files)).toEqual(files);
  });

  it('keeps an edit made from outside between its check of the note and its write', async () => {
    const vault = memoryVault({
      ...OTHERS,
      [TASK]: '---\ntype: task\nstatus: inbox\n---\n\nBody.\n',
    });
    const outcome = await vault.clarify(TASK, { status: 'next-action' });
    const edited = `${vault.files.get(TASK) ?? ''}\nTyped in another editor.\n`;
    // Undo reads the note to see it is as clarifying left it; the edit lands right after that read.
    vault.afterRead.push(() => vault.editOutside(TASK, edited));

    await undoClarifyInboxItem({
      ports: vault.ports,
      undo: outcome.undo,
      notePaths: vault.notePaths(),
    }).catch(() => undefined);

    expect(vault.files.get(TASK)).toBe(edited);
  });
});

describe('two decisions at once (#112)', () => {
  it('leaves one of them whole on the same row, never a mix of the two', async () => {
    const text = '---\ntype: task\nstatus: inbox\n---\n\nBody.\n';
    const vault = memoryVault({ ...OTHERS, [TASK]: text });
    const settled = await Promise.allSettled([
      vault.clarify(TASK, { status: 'waiting', waitingOn: person, due: '2026-10-20' }),
      vault.clarify(TASK, { status: 'someday', defer: '2026-11-02' }),
    ]);
    expect(settled.some((each) => each.status === 'fulfilled')).toBe(true);
    expect([
      '---\ntype: task\nstatus: waiting\ndue: 2026-10-20\nwaiting_on: "[[Mara Quill]]"\n---\n\nBody.\n',
      '---\ntype: task\nstatus: someday\ndefer: 2026-11-02\n---\n\nBody.\n',
    ]).toContain(vault.files.get(TASK));
  });

  it('writes both when they are on two rows', async () => {
    const text = '---\ntype: task\nstatus: inbox\n---\n\nBody.\n';
    const other = 'Inbox/Write to Mara Quill.md';
    const vault = memoryVault({ ...OTHERS, [TASK]: text, [other]: text });
    await Promise.all([
      vault.clarify(TASK, { status: 'next-action', project }),
      vault.clarify(other, { status: 'someday', project }),
    ]);
    expect(vault.files.get('Tasks/2026/10/Call Tobias Fenn.md')).toContain('status: next-action');
    expect(vault.files.get('Tasks/2026/10/Write to Mara Quill.md')).toContain('status: someday');
  });

  it('refuses, keeping the edit, when the note changed on disk after it was read', async () => {
    const text = '---\ntype: task\nstatus: inbox\n---\n\nBody.\n';
    const vault = memoryVault({ ...OTHERS, [TASK]: text });
    const edited = `${text}\nTyped in another editor.\n`;
    vault.afterRead.push(() => vault.editOutside(TASK, edited));
    await expect(vault.clarify(TASK, { status: 'next-action' })).rejects.toThrow();
    expect(vault.files.get(TASK)).toBe(edited);
  });
});
