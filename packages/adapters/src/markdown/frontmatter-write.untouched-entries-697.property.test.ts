/**
 * #697: a change to a map — a type file's `properties:` moved, added to,
 * deleted from or renamed in — writes only the entries it changes. Every
 * other entry comes back as the bytes it was found as: its hand-typed
 * spacing, inline comments, flow-map padding, the comment and blank line
 * above it. An entry the change does reach is written at the map's own
 * columns. Seeded (mulberry32), so every run draws the same maps and edits.
 */
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { updateFrontmatter } from './frontmatter-write.ts';

const block = (...lines: string[]) => `---\n${lines.join('\n')}\n---\n`;

const inner = (frontmatter: string) =>
  frontmatter
    .replace(/^﻿?---\r?\n/, '')
    .replace(/\r?\n?---(\r?\n)?$/, '')
    .replace(/\r\n/g, '\n');

const read = (frontmatter: string) => parse(inner(frontmatter)) as Record<string, unknown>;

/** The `properties` map of `frontmatter`, with `edit` applied to a copy of it. */
function changed(frontmatter: string, edit: (entries: [string, unknown][]) => [string, unknown][]) {
  const properties = read(frontmatter)['properties'] as Record<string, unknown>;
  return { properties: Object.fromEntries(edit(Object.entries(properties))) };
}

const moved = (from: number, to: number) => (entries: [string, unknown][]) => {
  const copy = [...entries];
  const [entry] = copy.splice(from, 1);
  copy.splice(to, 0, entry as [string, unknown]);
  return copy;
};

const AUTHOR = "  author:\n    kind: relation\n    targets:   'person'   # who wrote it\n";

describe('an untouched entry of a changed map keeps its bytes (#697)', () => {
  const text = block('name: book', 'properties:', '  rating: number', AUTHOR + '  pages: number');

  it('when another entry moves', () => {
    const written = updateFrontmatter(text, changed(text, moved(2, 0)));
    expect(written).toBe(
      block('name: book', 'properties:', '  pages: number', '  rating: number', AUTHOR.trimEnd()),
    );
  });

  it('when one is added, written at the map’s columns', () => {
    const written = updateFrontmatter(
      text,
      changed(text, (entries) => [...entries, ['isbn', { kind: 'text' }]]),
    );
    expect(written).toContain(AUTHOR);
    expect(written).toContain('  pages: number\n  isbn:\n    kind: text\n---\n');
  });

  it('when one is deleted', () => {
    const written = updateFrontmatter(
      text,
      changed(text, (entries) => entries.filter(([key]) => key !== 'rating')),
    );
    expect(written).toBe(block('name: book', 'properties:', AUTHOR + '  pages: number'));
  });

  it('when one is renamed', () => {
    const written = updateFrontmatter(
      text,
      changed(text, (entries) =>
        entries.map(([key, value]) => [key === 'pages' ? 'length' : key, value]),
      ),
    );
    expect(written).toBe(
      block('name: book', 'properties:', '  rating: number', AUTHOR + '  length: number'),
    );
  });

  it('keeps a flow map’s padding', () => {
    const flow = block(
      'properties:',
      '  rating:   number',
      '  author: { kind: x,  n: 1 }  # hand',
      '  pages: number',
    );
    const written = updateFrontmatter(flow, changed(flow, moved(2, 0)));
    expect(written).toBe(
      block(
        'properties:',
        '  pages: number',
        '  rating:   number',
        '  author: { kind: x,  n: 1 }  # hand',
      ),
    );
  });

  it('keeps the key line of the map itself, comment spacing and all', () => {
    const spaced = block('properties:    # the specs', '  a:  1', '  b:  2');
    const written = updateFrontmatter(spaced, changed(spaced, moved(1, 0)));
    expect(written).toBe(block('properties:    # the specs', '  b:  2', '  a:  1'));
  });

  it('writes at a map’s own four-column indent, around entries it keeps', () => {
    const deep = block('properties:', '    a:   1', '    b:', '        kind:   x', '    c:  3');
    const written = updateFrontmatter(
      deep,
      changed(deep, (entries) => [...moved(2, 0)(entries), ['d', { kind: 'y' }]]),
    );
    expect(written).toBe(
      block(
        'properties:',
        '    c:  3',
        '    a:   1',
        '    b:',
        '        kind:   x',
        '    d:',
        '        kind: y',
      ),
    );
  });

  it('keeps an entry’s untouched lines when another key inside it changes', () => {
    const written = updateFrontmatter(
      text,
      changed(text, (entries) =>
        entries.map(([key, value]) => [
          key,
          key === 'author' ? { ...(value as object), kind: 'person' } : value,
        ]),
      ),
    );
    expect(written).toBe(
      block(
        'name: book',
        'properties:',
        '  rating: number',
        "  author:\n    kind: person\n    targets:   'person'   # who wrote it",
        '  pages: number',
      ),
    );
  });

  it('keeps a comment and blank line above an entry with that entry', () => {
    const commented = block('properties:', '  a:  1', '', '  # about b', '  b:  2', '  c:  3');
    const written = updateFrontmatter(commented, changed(commented, moved(2, 0)));
    expect(written).toBe(block('properties:', '  c:  3', '  a:  1', '', '  # about b', '  b:  2'));
  });

  it('keeps CRLF endings and a byte-order mark', () => {
    const windows = `﻿${text.replace(/\n/g, '\r\n')}`;
    const written = updateFrontmatter(windows, changed(windows, moved(2, 0)));
    expect(written).toBe(
      `﻿${block('name: book', 'properties:', '  pages: number', '  rating: number', AUTHOR.trimEnd()).replace(/\n/g, '\r\n')}`,
    );
  });
});

/** mulberry32: a seeded RNG. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Entry {
  readonly key: string;
  /** The entry's whole text — what stands above it, its key and its value — each line ending in `\n`. */
  readonly text: string;
  /** Whether its value is a block map, which an edit can change inside. */
  readonly map: boolean;
}

/** A map's entries drawn with hand-typed spacing: scalars, flow and block maps and lists, comments, blank lines. */
function entriesOf(random: () => number, indent: string): Entry[] {
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)] as T;
  const spaces = () => ' '.repeat(1 + Math.floor(random() * 3));
  const comment = () => (random() < 0.3 ? `${spaces()}# c${Math.floor(random() * 100)}` : '');
  const deeper = indent + pick(['  ', '   ', '    ']);
  return Array.from({ length: 2 + Math.floor(random() * 6) }, (_, at): Entry => {
    const key = `p${at}`;
    const above = pick(['', '', '\n', `${indent}# about ${key}\n`, `\n${indent}# about ${key}\n`]);
    const roll = random();
    const head = `${indent}${key}:`;
    if (roll < 0.3) {
      const value = pick(['number', "'quoted'", '"double"', 'two  words', '42']);
      return { key, text: `${above}${head}${spaces()}${value}${comment()}\n`, map: false };
    }
    if (roll < 0.45) {
      const pad = pick(['', ' ', '  ']);
      const flow = `{${pad}kind:${spaces()}x,${spaces()}n:${spaces()}${at}${pad}}`;
      return { key, text: `${above}${head}${spaces()}${flow}${comment()}\n`, map: false };
    }
    if (roll < 0.55) {
      const list = `[${pick(['', ' '])}a,${spaces()}b${pick(['', ' '])}]`;
      return { key, text: `${above}${head}${spaces()}${list}${comment()}\n`, map: false };
    }
    if (roll < 0.65) {
      const items = `${deeper}-${spaces()}a${comment()}\n${deeper}-${spaces()}b\n`;
      return { key, text: `${above}${head}${comment()}\n${items}`, map: false };
    }
    const body =
      `${deeper}kind:${spaces()}relation${comment()}\n` +
      `${deeper}targets:${spaces()}'person'${spaces()}# who wrote it\n`;
    return { key, text: `${above}${head}${comment()}\n${body}`, map: true };
  });
}

type Operation = 'move' | 'add' | 'delete' | 'rename' | 'edit';

interface Drawn {
  readonly frontmatter: string;
  readonly entries: readonly Entry[];
  readonly indent: string;
  readonly eol: string;
}

function drawn(random: () => number): Drawn {
  const indent = ' '.repeat(2 + Math.floor(random() * 3));
  const entries = entriesOf(random, indent);
  const eol = random() < 0.3 ? '\r\n' : '\n';
  const bom = random() < 0.2 ? '﻿' : '';
  const opener = random() < 0.3 ? 'properties:   # specs\n' : 'properties:\n';
  const body = `name: book\n${opener}${entries.map((entry) => entry.text).join('')}label: Book\n`;
  return { frontmatter: `${bom}---\n${body}---\n`.replace(/\n/g, eol), entries, indent, eol };
}

/** The change `operation` makes to one entry, and the entries it leaves untouched. */
function editOf(random: () => number, { entries }: Drawn, operation: Operation) {
  const at = Math.floor(random() * entries.length);
  const target = entries[at] as Entry;
  const values = Object.entries(
    (parse(entries.map((entry) => entry.text).join('')) ?? {}) as Record<string, unknown>,
  );
  const untouched = entries.filter((entry) => entry !== target);
  let next: [string, unknown][];
  if (operation === 'move') {
    const to = (at + 1 + Math.floor(random() * (entries.length - 1))) % entries.length;
    next = moved(at, to)(values);
  } else if (operation === 'add') {
    next = [...values];
    next.splice(Math.floor(random() * (values.length + 1)), 0, ['added', { kind: 'text' }]);
    return { properties: Object.fromEntries(next), untouched: entries, touched: 'added' };
  } else if (operation === 'delete') {
    next = values.filter(([key]) => key !== target.key);
  } else if (operation === 'rename') {
    next = values.map(([key, value]) => [key === target.key ? 'renamed' : key, value]);
    return { properties: Object.fromEntries(next), untouched, touched: 'renamed' };
  } else {
    const map = entries.find((entry) => entry.map);
    if (map === undefined) return null;
    next = values.map(([key, value]) => [
      key,
      key === map.key ? { ...(value as object), kind: 'person' } : value,
    ]);
    return {
      properties: Object.fromEntries(next),
      untouched: entries.filter((e) => e !== map),
      touched: null,
    };
  }
  return { properties: Object.fromEntries(next), untouched, touched: null };
}

/** What is wrong with one seed's write, or nothing. */
function problemsOf(seed: number, operation: Operation): string[] {
  const random = seeded(seed);
  const map = drawn(random);
  const edit = editOf(random, map, operation);
  if (edit === null) return [];
  const written = updateFrontmatter(map.frontmatter, { properties: edit.properties });
  const problems: string[] = [];
  const values = read(written);
  if (JSON.stringify(values['properties']) !== JSON.stringify(edit.properties))
    problems.push('values');
  if (values['name'] !== 'book' || values['label'] !== 'Book') problems.push('other keys');
  for (const entry of edit.untouched) {
    // A blank line above an entry is the map's, not the entry's: only the rest is held to its bytes.
    const kept = entry.text.replace(/^\n/, '').replace(/\n/g, map.eol);
    if (!written.includes(kept)) problems.push(`bytes of ${entry.key}`);
  }
  if (edit.touched !== null && !inner(written).includes(`\n${map.indent}${edit.touched}:`)) {
    problems.push(`column of ${edit.touched}`);
  }
  if (!written.startsWith(map.frontmatter.slice(0, map.frontmatter.indexOf('properties:') + 11))) {
    problems.push('opening');
  }
  return problems.length === 0 ? [] : [`seed ${seed} ${operation}: ${problems.join(', ')}`];
}

describe('a changed map keeps its untouched entries’ bytes, as a property (#697)', () => {
  it.each<Operation>(['move', 'add', 'delete', 'rename', 'edit'])(
    'on a %s of another entry',
    (operation) => {
      const broken: string[] = [];
      for (let seed = 1; seed <= 400; seed += 1) broken.push(...problemsOf(seed, operation));
      expect(broken.slice(0, 5)).toEqual([]);
    },
    60_000,
  );
});
