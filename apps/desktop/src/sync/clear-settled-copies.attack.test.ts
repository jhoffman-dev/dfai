/**
 * Attack on #235 (PR #599): a conflict copy of a `.atlas` file goes to the
 * Trash only when it holds nothing its live file lacks. Seeded property runs
 * over random live/copy pairs with the real markdown adapter, the record of
 * shipped properties, path mapping, a write racing the trash, and volume.
 */
import { describe, expect, it } from 'vitest';
import { clearSettledCopies, recordingActivity, type NoteContents } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { SHIPPED_PROPERTIES_RECORD_PATH, settingsFileOfCopy, type VaultPath } from '@dfai/domain';

const OID = 'b'.repeat(40);

/** A small seeded RNG (mulberry32), so every run draws the same pairs. */
function rng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (below: number) => Math.floor(next() * below);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
  const chance = (p: number) => next() < p;
  return { int, pick, chance };
}
type Rng = ReturnType<typeof rng>;

interface Options {
  onRead?: (path: string, reads: number, held: Map<string, NoteContents>) => void;
  /** Trash refuses these paths. */
  refuse?: ReadonlySet<string>;
}

/** The vault's files, every one tracked at stage 0, read and trashed as the host does. */
function vault(files: Record<string, string>, { onRead, refuse }: Options = {}) {
  const held = new Map(Object.entries(files).map(([path, text]) => [path, { text, modified: 1 }]));
  const trashed: string[] = [];
  const reads = new Map<string, number>();
  const index = Object.keys(files)
    .map((path) => `100644 ${OID} 0\t${path}\0`)
    .join('');
  let indexReads = 0;
  return {
    trashed,
    held,
    indexReads: () => indexReads,
    git: {
      indexEntries: async () => {
        indexReads += 1;
        return { code: 0, stdout: index, stderr: '' };
      },
    },
    fs: {
      readTextFile: async (path: VaultPath) => {
        const read = held.get(path);
        if (read === undefined) throw new Error(`${path}: no such file`);
        const count = (reads.get(path) ?? 0) + 1;
        reads.set(path, count);
        onRead?.(path, count, held);
        return read;
      },
      // As the host does (#235): nothing moves unless every file named is still as it was read.
      trashEntry: async ({
        path,
        unchanged = [],
      }: {
        path: VaultPath;
        unchanged?: readonly { path: VaultPath; modified: number; text: string }[];
      }) => {
        for (const file of unchanged) {
          const now = held.get(file.path);
          if (now?.modified !== file.modified || now.text !== file.text) {
            throw new Error(`${file.path} changed on disk since it was read`);
          }
        }
        if (refuse?.has(path)) throw new Error('the Trash refused');
        if (!held.delete(path)) throw new Error(`${path}: no such file`);
        trashed.push(path);
      },
    },
  };
}

async function clear(world: ReturnType<typeof vault>) {
  const activity = recordingActivity();
  const cleared = await clearSettledCopies({
    ports: { git: world.git, fs: world.fs, markdown: remarkMarkdown, activity },
    keep: new Set(),
  });
  return { cleared, reports: activity.reports };
}

// ---- Random `.atlas` files -------------------------------------------------

const SCALARS = [
  'foo',
  '"foo"',
  "'foo'",
  '~',
  'null',
  '',
  '1',
  '1.0',
  '01',
  'true',
  'yes',
  'héllo ✓',
  'foo # a note',
  '"two  spaces"',
  'Ünïcödé',
  '"é"',
  '"\\u00e9"',
  '0x1F',
  '2026-10-28',
  '-0',
  '.nan',
  '.inf',
];

const MAP_ENTRY_NAMES = ['date', 'tasks', 'status', 'attendees', 'due', 'summary'];
const TOP_KEYS = ['name', 'label', 'icon', 'sort', 'atlas', 'color', 'filter', 'limit', 'mode'];

/** One top-level key as text lines, in one of the styles a person or DFAI writes. */
function keyText(r: Rng, key: string): string[] {
  const comment = r.chance(0.15) ? [r.pick(['# why this', '# ✓ checked', '#'])] : [];
  switch (r.int(7)) {
    case 0:
    case 1:
      return [...comment, `${key}: ${r.pick(SCALARS)}`.trimEnd()];
    case 2: {
      const items = [...MAP_ENTRY_NAMES].slice(0, 1 + r.int(3));
      const indent = r.pick(['  ', '']);
      return [...comment, `${key}:`, ...items.map((item) => `${indent}- ${item}`)];
    }
    case 3:
      return [...comment, `${key}: [${MAP_ENTRY_NAMES.slice(0, 1 + r.int(3)).join(', ')}]`];
    case 4:
      return [...comment, `${key}: ${r.pick(['|', '>', '|-'])}`, '  line one', '  line two'];
    default: {
      const names = MAP_ENTRY_NAMES.filter(() => r.chance(0.6));
      const lines = [...comment, `${key}:`];
      for (const name of names.length === 0 ? ['date'] : names) {
        if (r.chance(0.1)) lines.push('  # entry note');
        lines.push(
          `  ${name}:`,
          `    kind: ${r.pick(['date', 'text', 'relation', '~', '"text"'])}`,
        );
        if (r.chance(0.3)) lines.push(`    label: ${r.pick(['Date', 'Due ✓', "'Due'"])}`);
      }
      return lines;
    }
  }
}

interface Parts {
  keys: { key: string; lines: string[] }[];
  body: string;
}

function randomParts(r: Rng): Parts {
  const keys = TOP_KEYS.filter(() => r.chance(0.5)).map((key) => ({ key, lines: keyText(r, key) }));
  if (r.chance(0.5)) keys.push({ key: 'properties', lines: keyText(r, 'properties') });
  const body = r.pick([
    '',
    '\n',
    '\nA view for Mara Quill.\n',
    '\n- one\n- two\n',
    '\n# Héading\n',
  ]);
  return { keys, body };
}

const textOf = ({ keys, body }: Parts, { crlf = false } = {}) => {
  const text = ['---', ...keys.flatMap(({ lines }) => lines), '---'].join('\n') + '\n' + body;
  return crlf ? text.replace(/\n/g, '\r\n') : text;
};

/** The copy drawn from the live file by one or more edits, or drawn fresh. */
function mutate(r: Rng, live: Parts): { parts: Parts; crlf: boolean } {
  const parts: Parts = {
    keys: live.keys.map((k) => ({ ...k, lines: [...k.lines] })),
    body: live.body,
  };
  let crlf = false;
  for (let edits = 1 + r.int(3); edits > 0; edits -= 1) {
    const at = parts.keys.length === 0 ? -1 : r.int(parts.keys.length);
    switch (r.int(12)) {
      case 0: // drop a key
        if (at >= 0) parts.keys.splice(at, 1);
        break;
      case 1: // drop a line inside a key
        if (at >= 0 && parts.keys[at]!.lines.length > 1) {
          parts.keys[at]!.lines.splice(1 + r.int(parts.keys[at]!.lines.length - 1), 1);
        }
        break;
      case 2: // a value restyled or changed
        if (at >= 0) parts.keys[at]!.lines = keyText(r, parts.keys[at]!.key);
        break;
      case 3: // a key added
        parts.keys.push({ key: r.pick(['extra', 'zeta', 'ünï']), lines: keyText(r, 'extra') });
        break;
      case 4: // a comment added
        if (at >= 0) parts.keys[at]!.lines.unshift('# a note of mine');
        break;
      case 5: // reordered
        parts.keys.reverse();
        break;
      case 6: // the body
        parts.body = r.pick([
          '',
          '\nA note only on the copy.\n',
          `${live.body} `,
          '\n- two\n- one\n',
        ]);
        break;
      case 7:
        crlf = true;
        break;
      case 8: // a key listed twice
        if (at >= 0)
          parts.keys.push({ ...parts.keys[at]!, lines: keyText(r, parts.keys[at]!.key) });
        break;
      case 9: // anchor and alias
        parts.keys.push({ key: 'alias', lines: ['base: &shared 1', 'alias: *shared'] });
        break;
      case 10: // a trailing comment at the end of the block
        parts.keys.push({ key: '#', lines: ['# trailing note'] });
        break;
      default: // the list order changed
        if (at >= 0) parts.keys[at]!.lines = [...parts.keys[at]!.lines].reverse();
    }
  }
  return { parts, crlf };
}

// ---- The oracle -------------------------------------------------------------

/** Whether every value in `copy` is in `live`: maps by key, everything else equal. */
function contained(copy: unknown, live: unknown): boolean {
  if (copy !== null && typeof copy === 'object' && !Array.isArray(copy)) {
    if (live === null || typeof live !== 'object' || Array.isArray(live)) return false;
    return Object.entries(copy).every(
      ([key, value]) =>
        Object.hasOwn(live, key) && contained(value, (live as Record<string, unknown>)[key]),
    );
  }
  return JSON.stringify(copy) === JSON.stringify(live) || Object.is(copy, live);
}

const linesOf = (text: string) => text.split('\n');

/** Why trashing `copy` lost something `live` lacks; null when nothing. */
function loss(copy: string, live: string): string | null {
  const have = new Set(linesOf(live));
  const missing = linesOf(copy).filter((line) => !have.has(line));
  if (missing.length > 0) return `lines only in the copy: ${JSON.stringify(missing)}`;
  const props = (text: string) => {
    const match = /^---\r?\n[\s\S]*?\n---\r?\n?/.exec(text);
    return remarkMarkdown.frontmatterProperties(match?.[0] ?? null);
  };
  if (!contained(props(copy), props(live))) return 'a value only in the copy';
  return null;
}

const SETTINGS_FILES = [
  '.atlas/settings.md',
  '.atlas/types/meeting.md',
  '.atlas/views/Board ✓.md',
  '.atlas/automations/weekly.md',
  '.atlas/templates/daily.md',
];

const copyOf = (live: string, mac = 'Laptop') =>
  `Sync conflicts/atlas/${live.slice('.atlas/'.length).replace(/\.md$/, '')} (conflict from ${mac}).md`;

describe('attack #235: a trashed .atlas copy holds nothing its live file lacks', () => {
  it('holds over 8000 seeded random live and copy pairs, with the real markdown adapter', async () => {
    const violations: string[] = [];
    let trashedCount = 0;
    // 8000 seeds (#235 fix round): the stricter rule trashes fewer pairs, and the run
    // must still reach the trashing path over 100 times.
    for (let seed = 1; seed <= 8000; seed += 1) {
      const r = rng(seed);
      const livePath = r.pick(SETTINGS_FILES);
      const liveParts = randomParts(r);
      const liveText = textOf(liveParts, { crlf: r.chance(0.05) });
      const drawn = r.chance(0.15) ? { parts: randomParts(r), crlf: false } : mutate(r, liveParts);
      const copyText = textOf(drawn.parts, { crlf: drawn.crlf });
      const copy = copyOf(livePath);
      const world = vault({ [livePath]: liveText, [copy]: copyText });
      const { cleared } = await clear(world);
      if (cleared.length === 0) continue;
      trashedCount += 1;
      const lost = loss(copyText, liveText);
      if (lost !== null) violations.push(`seed ${seed}: ${lost}`);
    }
    expect(violations).toEqual([]);
    // The run must reach the trashing path, or it proves nothing.
    expect(trashedCount).toBeGreaterThan(100);
  });

  it('keeps a record copy whose JSON names a type twice, the first listing a key the live file lacks', async () => {
    const record = (json: string) =>
      [
        '---',
        'atlas: migration',
        '---',
        '',
        '# Properties added to built-in types',
        '',
        'DFAI adds a property it ships on a built-in type once, to a type file written before it',
        'shipped, and never changes one the file has. A settled key is not added again: one taken',
        'off since stays off.',
        '',
        '```json',
        json,
        '```',
        '',
      ].join('\n');
    const live = record('{"settled":{"meeting":["date"]},"added":{}}');
    // A hand edit left `meeting` listed twice: JSON.parse keeps only the last, dropping `attendees`.
    const copyText = record('{"settled":{"meeting":["attendees"],"meeting":["date"]},"added":{}}');
    const copy = copyOf(SHIPPED_PROPERTIES_RECORD_PATH);
    const world = vault({ [SHIPPED_PROPERTIES_RECORD_PATH]: live, [copy]: copyText });
    const { cleared } = await clear(world);
    expect(cleared).toEqual([]);
    expect(world.held.get(copy)?.text).toBe(copyText);
  });
});

describe('attack #235: a copy maps only to the .atlas file it was made of', () => {
  it.each([
    ['Sync conflicts/atlas/settings (conflict from Studio (work)).md', '.atlas/settings.md'],
    ['Sync conflicts/atlas/settings (conflict from Mac [2] 🍎).md', '.atlas/settings.md'],
    ['Sync conflicts/atlas/settings (conflict from Laptop) 2.md', '.atlas/settings.md'],
    ['Sync conflicts/atlas/settings (conflict from Laptop) 10.md', '.atlas/settings.md'],
    ['Sync conflicts/atlas/atlas/views/x (conflict from Laptop).md', '.atlas/atlas/views/x.md'],
    ['Sync conflicts/atlas/views/Café (conflict from Laptop).md', '.atlas/views/Café.md'],
    ['Sync conflicts/atlas/views/a (b) (conflict from Laptop).md', '.atlas/views/a (b).md'],
  ])('%s → %s', (copy, live) => {
    expect(settingsFileOfCopy(copy)).toBe(live);
  });

  it.each([
    'Sync conflicts/atlas/settings (conflict from Laptop) 0.md',
    'Sync conflicts/atlas/settings (conflict from Laptop).md.txt',
    'Sync conflicts/atlas/settings (conflict from Laptop (conflict from Studio)).md',
    'Sync conflicts/atlas/ (conflict from Laptop).md',
    'Sync conflicts/notes/settings (conflict from Laptop).md',
    'sync conflicts/atlas/settings (conflict from Laptop).md',
  ])('%s maps to nothing', (copy) => {
    expect(settingsFileOfCopy(copy)).toBeNull();
  });

  it('keeps a copy whose path climbs out of .atlas with ..', async () => {
    const copy = 'Sync conflicts/atlas/../../notes/plan (conflict from Laptop).md';
    const text = '---\nname: plan\n---\n';
    const world = vault({
      [copy]: text,
      '.atlas/../../notes/plan.md': text,
      'notes/plan.md': text,
    });
    expect((await clear(world)).cleared).toEqual([]);
  });

  it('keeps a copy whose live file is missing', async () => {
    const copy = copyOf('.atlas/views/gone.md');
    const world = vault({ [copy]: '---\nname: gone\n---\n' });
    expect((await clear(world)).cleared).toEqual([]);
  });
});

describe('attack #235: the check and the trash are one step', () => {
  it('keeps a copy a person edits after it was last read, before it goes to the Trash', async () => {
    const live = '.atlas/settings.md';
    const copy = copyOf(live);
    const text = '---\nname: settings\n---\n';
    const edited = '---\nname: settings\nmine: a note only here\n---\n';
    // The second read of the copy is the last check: the person's save lands right after it.
    const world = vault(
      { [live]: text, [copy]: text },
      {
        onRead: (path, reads, held) => {
          if (path === copy && reads === 2) {
            queueMicrotask(() => held.set(copy, { text: edited, modified: 2 }));
          }
        },
      },
    );
    await clear(world);
    // Whatever is trashed must be what was checked: the edited copy holds a key the live file lacks.
    expect(world.trashed).toEqual([]);
  });
});

describe('attack #235: volume', () => {
  it('clears 500 settled copies in one index read, and a refused one does not stop the rest', async () => {
    const files: Record<string, string> = {};
    const refuse = new Set<string>();
    for (let n = 0; n < 500; n += 1) {
      const live = `.atlas/views/view ${n}.md`;
      files[live] = `---\nname: v${n}\nlimit: ${n}\n---\n`;
      // The same as its live file (#235 fix round): a view's live file may hold nothing the
      // copy lacks, since `limit` there could be a person's deletion on the copy's Mac.
      files[copyOf(live)] = files[live];
      if (n % 50 === 7) refuse.add(copyOf(live));
    }
    const world = vault(files, { refuse });
    const started = performance.now();
    const { cleared, reports } = await clear(world);
    const took = performance.now() - started;
    expect(cleared).toHaveLength(500 - refuse.size);
    expect(reports.filter(({ level }) => level === 'warning')).toHaveLength(refuse.size);
    expect(world.indexReads()).toBe(1);
    expect(took).toBeLessThan(15_000);
  });
});
