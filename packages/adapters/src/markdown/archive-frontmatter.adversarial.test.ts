/**
 * Adversarial pass on the Archive merge (10c51a9): the frontmatter a note
 * already had, through archive → unarchive and through the writer every
 * property change uses. The invariants under attack: a round trip gives the
 * note back byte for byte, and removing properties never takes a comment the
 * person wrote with it.
 */
import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  movedPath,
  parentVaultPath,
  splitFrontmatter,
  vaultPathName,
  type EntryMove,
  type VaultEntry,
  type VaultPath,
} from '@dfai/domain';
import {
  archiveNotes,
  unarchiveNotes,
  type ArchivePorts,
  type IndexPort,
  type VaultFsPort,
} from '@dfai/application';
import { updateFrontmatter } from './frontmatter-write.ts';
import { remarkMarkdown } from './markdown-port.ts';

const TODAY = '2026-09-27';

function memoryVault(notes: Record<string, string>) {
  const files = new Map(Object.entries(notes));
  const dirs = new Set<string>();
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
      return { text, modified: 1 };
    },
    readNotes: async (paths) =>
      paths.flatMap((at) => {
        const text = files.get(at);
        return text === undefined ? [] : [{ path: at, text, modified: 1, size: text.length }];
      }),
    writeTextFile: async ({ path, contents }) => {
      files.set(path, contents);
      return 2;
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
  return { files, ports, notePaths };
}

async function roundTrip(path: string, text: string) {
  const vault = memoryVault({ [path]: text });
  const archived = await archiveNotes({
    ports: vault.ports,
    paths: [createVaultPath(path)],
    notePaths: vault.notePaths(),
    today: TODAY,
  });
  expect(archived.failed).toEqual([]);
  const [moved] = archived.moves;
  const restored = await unarchiveNotes({
    ports: vault.ports,
    paths: [moved!.move.to],
    notePaths: vault.notePaths(),
  });
  expect(restored.failed).toEqual([]);
  return vault.files;
}

describe('archive → unarchive keeps the stamped keys a note already had (adversarial)', () => {
  it('keeps a note’s own empty `archived:` property rather than deleting it', async () => {
    // A type whose template declares `archived:` leaves it blank on every new note.
    const text = '---\ntitle: Plan\narchived:\n---\nBody.\n';
    const files = await roundTrip('Projects/X.md', text);
    const props = remarkMarkdown.frontmatterProperties(
      splitFrontmatter(files.get('Projects/X.md') ?? '').frontmatter,
    );
    expect(Object.hasOwn(props, 'archived')).toBe(true);
  });

  it('keeps a note’s own empty `archivedFrom:` property rather than deleting it', async () => {
    const text = '---\narchivedFrom:\nstatus: open\n---\nBody.\n';
    const files = await roundTrip('Projects/X.md', text);
    const props = remarkMarkdown.frontmatterProperties(
      splitFrontmatter(files.get('Projects/X.md') ?? '').frontmatter,
    );
    expect(Object.hasOwn(props, 'archivedFrom')).toBe(true);
  });

  it.each([
    ['an inline list', '[a, b]'],
    ['a hex number', '0x1F'],
    ['an exponent', '1e3'],
    ['a capitalised boolean', 'True'],
  ])('gives back %s under `archived` as it was written', async (_, value) => {
    const text = `---\ntitle: Plan\narchived: ${value}\n---\nBody.\n`;
    const files = await roundTrip('Projects/X.md', text);
    expect(files.get('Projects/X.md')).toBe(text);
  });

  it('gives back a frontmatter block that held only a blank line', async () => {
    const text = '---\n\n---\nBody.\n';
    const files = await roundTrip('Projects/X.md', text);
    expect(files.get('Projects/X.md')).toBe(text);
  });
});

describe('archive → unarchive puts a note back under its own name (adversarial)', () => {
  it('keeps the leading space of a note’s name', async () => {
    // Finder and Obsidian both allow it; archivedFrom records it quoted.
    const files = await roundTrip(' Leading.md', 'Body.\n');
    expect([...files.keys()]).toEqual([' Leading.md']);
  });

  it('keeps the leading space of the folder a note was in', async () => {
    const files = await roundTrip(' Drafts/X.md', 'Body.\n');
    expect([...files.keys()]).toEqual([' Drafts/X.md']);
  });
});

describe('removing the last property keeps the comments around it (adversarial)', () => {
  it('keeps a comment line after the last key when that key is removed', () => {
    // PATCH properties { status: null }, or unarchive dropping the stamp: the comment is the person's.
    const written = updateFrontmatter('---\nstatus: open\n# keep me\n---\n', { status: null });
    expect(written).toContain('# keep me');
  });

  it('keeps a CRLF comment line after the last keys when they are all removed', () => {
    const written = updateFrontmatter('---\r\ntitle: [a, b]\r\ndue: 12\r\n# tail\r\n---\r\n', {
      title: null,
      due: null,
    });
    expect(written).toContain('# tail\r\n');
  });
});

/** A small seeded generator (mulberry32), so every failing case can be replayed by its seed. */
function seeded(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
}

const KEYS = ['title', 'status', 'tags', 'archived', 'archivedFrom', 'archivedPrior', 'due'];
/** The keys the archive stamp writes over, and so restores by their text as written. */
const STAMPED: readonly string[] = ['archived', 'archivedFrom', 'archivedPrior'];
const VALUES = [
  ' open',
  ' "quoted"',
  " 'single'",
  ' 12',
  ' 0x1F',
  ' 1e3',
  ' True',
  ' [a, b]',
  ' [ a,b ]',
  '',
  ' 2026-09-01',
  ' ~',
  ' null',
  '\n  - a\n  - b',
  '\n- a',
  ' >\n  folded\n  text',
  ' {x: 1}',
  ' open # trailing',
];

/**
 * An ordinary block frontmatter: unique keys, scalar, list or map values,
 * comments between. With it, what it holds that the property turns on, so
 * the run can show it drew every one.
 */
function ordinaryBlock(seed: number): { text: string; shapes: string[] } {
  const pick = seeded(seed);
  const count = pick([1, 2, 3, 4, 5, 6]);
  // Unique keys in a seeded order: draw each from what is left.
  const left = [...KEYS];
  const keys = Array.from({ length: count }, () => left.splice(left.indexOf(pick(left)), 1)[0]);
  const drawn = keys.map((key) => ({
    key,
    comment: pick(['', '', '', '# about it\n']),
    value: pick(VALUES),
  }));
  const tail = pick(['', '', '# tail\n']);
  const eol = pick(['\n', '\n', '\r\n']);
  const lines = drawn.map(({ key, comment, value }) => `${comment}${key}:${value}\n`);
  const text = `---\n${lines.join('')}${tail}---\nBody.\n`.replace(/\n/g, eol);
  const last = drawn[drawn.length - 1]!;
  const shapes = [
    `${count} keys`,
    `${JSON.stringify(last.value)} last, tail ${tail !== ''}`,
    `${last.key} last, ${JSON.stringify(eol)}`,
    `${last.key}:${JSON.stringify(last.value)} last, tail ${tail !== ''}`,
    ...drawn.flatMap(({ key, comment, value }) => [
      `${JSON.stringify(value)} with ${JSON.stringify(eol)}`,
      `${key} with ${JSON.stringify(eol)}`,
      `${key} commented ${comment !== ''}`,
      `${key}:${JSON.stringify(value)}`,
      ...(STAMPED.includes(key)
        ? [`${key}:${JSON.stringify(value)} with ${JSON.stringify(eol)}`]
        : []),
    ]),
  ];
  return { text, shapes };
}

/** Every shape the property turns on: what 300 seeds are shown below to draw. */
const EVERY_SHAPE = [
  ...[1, 2, 3, 4, 5, 6].map((count) => `${count} keys`),
  ...VALUES.flatMap((value) =>
    [true, false].map((tail) => `${JSON.stringify(value)} last, tail ${tail}`),
  ),
  ...['\n', '\r\n'].flatMap((eol) => [
    ...VALUES.map((value) => `${JSON.stringify(value)} with ${JSON.stringify(eol)}`),
    ...KEYS.flatMap((key) => [
      `${key} last, ${JSON.stringify(eol)}`,
      `${key} with ${JSON.stringify(eol)}`,
    ]),
  ]),
  ...KEYS.flatMap((key) => [true, false].map((commented) => `${key} commented ${commented}`)),
  // The stamp restores each key by its text as written, so what matters is
  // each key with each value — the stamped ones under each line ending — and
  // each key and value last, with and without what follows it.
  ...KEYS.flatMap((key) => VALUES.map((value) => `${key}:${JSON.stringify(value)}`)),
  ...STAMPED.flatMap((key) =>
    VALUES.flatMap((value) =>
      ['\n', '\r\n'].map((eol) => `${key}:${JSON.stringify(value)} with ${JSON.stringify(eol)}`),
    ),
  ),
  ...KEYS.flatMap((key) =>
    VALUES.flatMap((value) =>
      [true, false].map((tail) => `${key}:${JSON.stringify(value)} last, tail ${tail}`),
    ),
  ),
];

describe('archive → unarchive gives any ordinary block back byte for byte (property)', () => {
  // 300 seeds, not the 2000 this once ran: 247 already draw every value with
  // each line ending, every value as the last key with and without a tail
  // after it, every key last, commented and not, and one to six keys. The
  // rest drew more of the same, and cost seconds when the gate shared the
  // machine (#820).
  it('holds for 300 seeded blocks, which draw every shape the round trip turns on', async () => {
    const drawn = new Set<string>();
    for (let seed = 1; seed <= 300; seed += 1) {
      const { text, shapes } = ordinaryBlock(seed);
      for (const shape of shapes) drawn.add(shape);
      const files = await roundTrip('Projects/X.md', text);
      if (files.get('Projects/X.md') !== text) {
        expect({ seed, restored: files.get('Projects/X.md') }).toEqual({ seed, restored: text });
      }
    }
    expect(EVERY_SHAPE.filter((shape) => !drawn.has(shape))).toEqual([]);
  });
});
