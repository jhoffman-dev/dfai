/**
 * #697: a change to a map — a type file's `properties:` moved, added to,
 * deleted from or renamed in — writes only the entries it changes. Every
 * other entry comes back as the bytes it was found as: its hand-typed
 * spacing, inline comments, flow-map padding, the comment and blank line
 * above it. An entry the change does reach is written at the map's own
 * columns. Seeded (mulberry32), so every run draws the same maps and edits.
 */
import { describe, expect, it } from 'vitest';
import { parse, parseDocument } from 'yaml';
import { checkedBody, updateFrontmatter, type Edit } from './frontmatter-write.ts';

const block = (...lines: string[]) => `---\n${lines.join('\n')}\n---\n`;

const inner = (frontmatter: string) =>
  frontmatter
    .replace(/^\uFEFF?---\r?\n/, '')
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
        // A new entry is written at the map's column; what is under it, the
        // library's two deeper — the file has no column of its own for it.
        '    d:',
        '      kind: y',
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

  // A rename cannot be told from a key deleted and another added with the
  // same value (review of PR #707), so the new key is written as the library
  // writes it, and what stood above the old one goes with it.
  it('writes a renamed entry as a new one, keeping the rest', () => {
    const named = block(
      'properties:',
      '  a:  1',
      '',
      '  # about b',
      '  b:   {kind:   x}',
      '  c:  3',
    );
    const written = updateFrontmatter(
      named,
      changed(named, (entries) =>
        entries.map(([key, value]) => [key === 'b' ? 'bee' : key, value]),
      ),
    );
    expect(written).toBe(block('properties:', '  a:  1', '  bee:', '    kind: x', '  c:  3'));
  });

  it('never gives a deleted key’s comments to a new key holding the same value', () => {
    const dated = block(
      'properties:',
      '  # when it is due',
      '  due: {kind: date}   # deadline',
      '  start: {kind: date}',
    );
    const written = updateFrontmatter(dated, {
      properties: { start: { kind: 'date' }, end: { kind: 'date' } },
    });
    expect(read(written)['properties']).toEqual({ start: { kind: 'date' }, end: { kind: 'date' } });
    expect(written).not.toContain('# deadline');
    expect(written).toContain('  start: {kind: date}\n');
  });

  it('never gives a deleted key’s comments to a new one inside a list item', () => {
    const listed = block(
      'items:',
      '  - name: x',
      '    # note on old',
      '    old: 1 # OLD',
      '    k: 2',
    );
    const written = updateFrontmatter(listed, { items: [{ name: 'x', k: 2, new: 1 }] });
    expect(read(written)['items']).toEqual([{ name: 'x', k: 2, new: 1 }]);
    expect(written).not.toContain('# OLD');
    expect(written).not.toContain('# note on old');
  });

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])('writes no line of only spaces where a moved entry stood (%s)', (_label, eol) => {
    const spaced = block('properties:', '  a: 1', '', '  b:  2').replace(/\n/g, eol);
    const written = updateFrontmatter(spaced, changed(spaced, moved(1, 0)));
    expect(written).toBe(block('properties:', '', '  b:  2', '  a: 1').replace(/\n/g, eol));
  });

  it('writes no line of only spaces above a moved entry’s comment', () => {
    const spaced = block('properties:', '  a: 1', '', '  # about b', '  b:  2');
    const written = updateFrontmatter(spaced, changed(spaced, moved(1, 0)));
    expect(written).toBe(block('properties:', '', '  # about b', '  b:  2', '  a: 1'));
  });

  it('takes a key gone and a new one holding another value as two changes, not a rename', () => {
    const swapped = block('properties:', '  a:  1', '', '  # about b', '  b:  2');
    const written = updateFrontmatter(swapped, { properties: { a: 1, c: 3 } });
    expect(written).toBe(block('properties:', '  a:  1', '  c: 3'));
  });

  it('keeps an anchor and its alias when another entry moves', () => {
    const linked = block('properties:', '  a: &spec {kind:  x}', '  b: *spec', '  c:  3');
    const written = updateFrontmatter(linked, changed(linked, moved(2, 0)));
    expect(written).toBe(block('properties:', '  c:  3', '  a: &spec {kind:  x}', '  b: *spec'));
  });

  it('keeps text that keeps its trailing lines, and those lines, when it moves', () => {
    const kept = block('properties:', '  a: |+', '    keep', '', '  b:  2', '  c:  3');
    const written = updateFrontmatter(kept, changed(kept, moved(0, 1)));
    expect(written).toBe(block('properties:', '  b:  2', '  a: |+', '    keep', '', '  c:  3'));
  });

  it('writes no blank line under such text, where it would be read as the text', () => {
    const kept = block('properties:', '  a: |+', '    keep', '', '  b:  2', '', '  c:  3');
    const written = updateFrontmatter(kept, changed(kept, moved(1, 2)));
    expect(read(written)['properties']).toEqual({ a: 'keep\n\n', c: 3, b: 2 });
    expect(written).toBe(block('properties:', '  a: |+', '    keep', '', '  c:  3', '  b:  2'));
  });

  it('leaves the rest of the block as it was', () => {
    const around = block(
      'name:   book   # the name',
      'properties:',
      '  a:  1',
      '  b:  2',
      'label:  Book',
    );
    const written = updateFrontmatter(around, changed(around, moved(1, 0)));
    expect(written).toBe(
      block('name:   book   # the name', 'properties:', '  b:  2', '  a:  1', 'label:  Book'),
    );
  });

  it('keeps entries of a map nested deeper than one level', () => {
    const nested = block(
      'properties:',
      '  a:',
      '    spec:',
      '      kind:   x',
      '      n:    1',
      '  b:  2',
    );
    const written = updateFrontmatter(nested, {
      properties: { a: { spec: { kind: 'y', n: 1 } }, b: 2 },
    });
    expect(written).toBe(
      block('properties:', '  a:', '    spec:', '      kind: y', '      n:    1', '  b:  2'),
    );
  });

  it('keeps a comment under an entry’s map when that entry moves to the end', () => {
    const noted = block('properties:', '  a:', '    kind:  x', '    # under a', '  b:  2');
    const written = updateFrontmatter(noted, changed(noted, moved(0, 1)));
    expect(read(written)['properties']).toEqual({ b: 2, a: { kind: 'x' } });
    expect(written).toContain('    # under a\n');
  });

  it('keeps the comment above an entry when the one before it, and a comment under that, go', () => {
    const noted = block(
      'properties:',
      '  a:',
      '    kind:  x',
      '    # under a',
      '  # about b',
      '  b:  2',
    );
    const written = updateFrontmatter(
      noted,
      changed(noted, (entries) => entries.filter(([key]) => key !== 'a')),
    );
    expect(written).toBe(block('properties:', '  # about b', '  b:  2'));
  });

  it('moves an anchor off a changed entry’s key line when another key refers to it', () => {
    const linked = block('properties:', '  a: &x # c', '    kind:  x', '  b:  2', 'other: *x');
    const written = updateFrontmatter(linked, { properties: { a: { kind: 'y' }, b: 2 } });
    expect(read(written)).toEqual({ properties: { a: { kind: 'y' }, b: 2 }, other: { kind: 'x' } });
    expect(written).toContain('properties:\n  a:\n    # c\n    kind: y\n  b:  2\n');
  });

  it('keeps an anchor on a changed entry’s key line, once', () => {
    const anchored = block('properties:', '  a: &x', '    kind:  x', '    n:  1', '  b:  2');
    const written = updateFrontmatter(anchored, {
      properties: { a: { kind: 'y', n: 1 }, b: 2 },
    });
    expect(read(written)['properties']).toEqual({ a: { kind: 'y', n: 1 }, b: 2 });
    expect(written.match(/&x/g)).toHaveLength(1);
    expect(written).toContain('    n:  1\n  b:  2\n');
  });

  it('keeps entries of a block whose keys are indented', () => {
    const indented = block('  name: x', '  properties:', '    a:  1', '    b:  2');
    const written = updateFrontmatter(indented, changed(indented, moved(1, 0)));
    expect(written).toBe(block('  name: x', '  properties:', '    b:  2', '    a:  1'));
  });

  it('keeps a comment standing left of an indented block at its column', () => {
    const loose = block('  properties:', '    a:  1', '# loose', '    b:  2', '    c:  3');
    const written = updateFrontmatter(loose, changed(loose, moved(2, 0)));
    expect(written).toBe(block('  properties:', '    c:  3', '    a:  1', '# loose', '    b:  2'));
  });

  it('keeps an anchor the library writes under a comment, once', () => {
    const anchored = block(
      'properties:',
      '  a: &x',
      '    # c',
      '    kind:  x',
      '    n:  1',
      '  b:  2',
    );
    const written = updateFrontmatter(anchored, {
      properties: { a: { kind: 'y', n: 1 }, b: 2 },
    });
    expect(read(written)['properties']).toEqual({ a: { kind: 'y', n: 1 }, b: 2 });
    expect(written.match(/&x/g)).toHaveLength(1);
    expect(written).toContain('    n:  1\n  b:  2\n');
  });

  it('keeps CRLF endings and a byte-order mark', () => {
    const windows = `\uFEFF${text.replace(/\n/g, '\r\n')}`;
    const written = updateFrontmatter(windows, changed(windows, moved(2, 0)));
    expect(written).toBe(
      `\uFEFF${block('name: book', 'properties:', '  pages: number', '  rating: number', AUTHOR.trimEnd()).replace(/\n/g, '\r\n')}`,
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
  /** What stands above its key: a blank line, a comment, or nothing. */
  readonly above: string;
  /** Whether it is text that keeps its trailing lines (`|+`). */
  readonly keeps?: boolean;
}

/** A map's entries drawn with hand-typed spacing: scalars, block text, flow and block maps and lists, comments, blank lines. */
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
      return { key, above, text: `${above}${head}${spaces()}${value}${comment()}\n`, map: false };
    }
    if (roll < 0.45) {
      const pad = pick(['', ' ', '  ']);
      const flow = `{${pad}kind:${spaces()}x,${spaces()}n:${spaces()}${at}${pad}}`;
      return { key, above, text: `${above}${head}${spaces()}${flow}${comment()}\n`, map: false };
    }
    if (roll < 0.55) {
      const list = `[${pick(['', ' '])}a,${spaces()}b${pick(['', ' '])}]`;
      return { key, above, text: `${above}${head}${spaces()}${list}${comment()}\n`, map: false };
    }
    if (roll < 0.6) {
      const chomp = pick(['', '-', '+']);
      const tail = chomp === '+' ? '\n' : '';
      const lines = `${deeper}first  line\n${deeper}  deeper${spaces()}\n${tail}`;
      return {
        key,
        above,
        text: `${above}${head}${spaces()}|${chomp}${comment()}\n${lines}`,
        map: false,
        keeps: chomp === '+',
      };
    }
    if (roll < 0.7) {
      const items = `${deeper}-${spaces()}a${comment()}\n${deeper}-${spaces()}b\n`;
      return { key, above, text: `${above}${head}${comment()}\n${items}`, map: false };
    }
    const body =
      `${deeper}kind:${spaces()}relation${comment()}\n` +
      `${deeper}targets:${spaces()}'person'${spaces()}# who wrote it\n`;
    // Some name their map with an anchor nothing refers to.
    const anchor = random() < 0.2 ? ` &m${at}` : '';
    return { key, above, text: `${above}${head}${anchor}${comment()}\n${body}`, map: true };
  });
}

type Operation = 'move' | 'add' | 'delete' | 'rename' | 'replace' | 'edit';

interface Drawn {
  readonly frontmatter: string;
  readonly entries: readonly Entry[];
  readonly indent: string;
  readonly eol: string;
  /** The map's own key line. */
  readonly opener: string;
}

function drawn(random: () => number, notes: boolean): Drawn {
  const indent = ' '.repeat(2 + Math.floor(random() * 3));
  const entries = entriesOf(random, indent);
  const eol = random() < 0.3 ? '\r\n' : '\n';
  const bom = random() < 0.2 ? '\uFEFF' : '';
  const opener = random() < 0.3 ? 'properties:   # specs\n' : 'properties:\n';
  // With `notes`, comments no entry's text holds: one deeper than the keys
  // under an entry (never under block text, which would read it as text),
  // one closing the map.
  const note = (entry: Entry) =>
    notes && !/: *\|/.test(entry.text) && random() < 0.2
      ? `${indent}    # deep under ${entry.key}\n`
      : '';
  const closing = notes && random() < 0.3 ? `${indent}# end of the specs\n` : '';
  const lines = entries.map((entry) => `${entry.text}${note(entry)}`).join('');
  const body = `name: book\n${opener}${lines}${closing}label: Book\n`;
  return {
    frontmatter: `${bom}---\n${body}---\n`.replace(/\n/g, eol),
    entries,
    indent,
    eol,
    opener,
  };
}

/** The change `operation` makes to one entry, and the entries it leaves untouched. */
function editOf(
  random: () => number,
  { entries }: Drawn,
  operation: Operation,
): {
  properties: Record<string, unknown>;
  untouched: readonly Entry[];
  touched: string | null;
  edited?: Entry;
} | null {
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
  } else if (operation === 'replace') {
    // A key deleted, and another added holding the value it held.
    next = values.filter(([key]) => key !== target.key);
    next.splice(Math.floor(random() * (next.length + 1)), 0, ['added', values[at]?.[1]]);
    return { properties: Object.fromEntries(next), untouched, touched: 'added' };
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
      edited: map,
    };
  }
  return { properties: Object.fromEntries(next), untouched, touched: null };
}

/**
 * What is wrong with one seed's write, or nothing. With `notes` — comments
 * the library places by its own rules — an entry may be written as the
 * library writes it, so only what may never change is held: the values,
 * every comment and anchor once, and the rest of the block.
 */
function problemsOf(seed: number, operation: Operation, notes = false): string[] {
  const random = seeded(seed);
  const map = drawn(random, notes);
  const edit = editOf(random, map, operation);
  if (edit === null) return [];
  const written = updateFrontmatter(map.frontmatter, { properties: edit.properties });
  const problems: string[] = [];
  const values = read(written);
  if (JSON.stringify(values['properties']) !== JSON.stringify(edit.properties))
    problems.push('values');
  if (values['name'] !== 'book' || values['label'] !== 'Book') problems.push('other keys');
  const eol = (text: string) => text.replace(/\n/g, map.eol);
  for (const entry of notes ? [] : edit.untouched) {
    // The comments over a map's first entry are the map's own (as the library
    // reads them): they stay at its top, as found, whichever entry comes first.
    const first = entry === map.entries[0] && entry.above.includes('#');
    // A blank line above an entry moves with it; only the rest is held to its bytes.
    const kept = first ? entry.text.slice(entry.above.length) : entry.text.replace(/^\n/, '');
    if (!written.includes(eol(kept))) problems.push(`bytes of ${entry.key}`);
    if (first && !written.includes(eol(`${map.opener}${entry.above}`))) problems.push('lead');
  }
  // A line of only spaces counts as blank, and is never written where there was none.
  const lines = (text: string) => inner(text).split('\n');
  const blanks = (text: string) => lines(text).filter((line) => /^[ \t]*$/.test(line)).length;
  const spaced = (text: string) => lines(text).filter((line) => /^[ \t]+$/.test(line)).length;
  if (spaced(written) > spaced(map.frontmatter)) problems.push('line of only spaces');
  // A blank line goes only with the entry deleted, or when it would stand
  // under text that keeps its trailing lines (`|+`) and be read as that text.
  const removed = map.entries.find((entry) => !edit.untouched.includes(entry));
  const lost =
    (operation === 'delete' || operation === 'rename' || operation === 'replace'
      ? (removed?.text
          .split('\n')
          .slice(0, -1)
          .filter((line) => /^[ \t]*$/.test(line)).length ?? 0)
      : 0) + map.entries.filter((entry) => entry.keeps).length;
  // Where the library writes an entry among comments it places, it may move
  // a blank line, as it always has.
  if (
    !notes &&
    (blanks(written) < blanks(map.frontmatter) - lost || blanks(written) > blanks(map.frontmatter))
  ) {
    problems.push('blank lines');
  }
  // No comment is lost or written twice — but those of an entry deleted (or
  // renamed, which is one deleted and one added), and one under it, which
  // may go with it.
  const comments = (text: string) => (inner(text).match(/#[^\n]*/g) ?? []).map((c) => c.trimEnd());
  const had = comments(map.frontmatter);
  const has = comments(written);
  const going = new Set(
    operation !== 'move' && operation !== 'add' && operation !== 'edit' && removed
      ? [...comments(removed.text), `# deep under ${removed.key}`]
      : [],
  );
  const missing = had.filter((comment) => !going.has(comment));
  const count = (all: string[], one: string) => all.filter((other) => other === one).length;
  if (
    missing.some((comment) => count(has, comment) < count(missing, comment)) ||
    has.some((comment) => count(has, comment) > count(had, comment))
  ) {
    problems.push('comments');
  }
  // Inside the entry edited, the line the edit did not reach keeps its bytes too.
  const targets = edit.edited?.text.split('\n').find((line) => line.includes('targets:'));
  if (!notes && targets !== undefined && !written.includes(eol(`${targets}\n`)))
    problems.push('inner bytes');
  if (
    !notes &&
    edit.touched !== null &&
    !inner(written).includes(`\n${map.indent}${edit.touched}:`)
  ) {
    problems.push(`column of ${edit.touched}`);
  }
  if (!written.startsWith(map.frontmatter.slice(0, map.frontmatter.indexOf('properties:') + 11))) {
    problems.push('opening');
  }
  // Every anchor once: never dropped, never written twice.
  const anchors = (text: string) => (text.match(/&m\d+/g) ?? []).sort().join();
  const gone =
    operation !== 'move' && operation !== 'add' && operation !== 'edit'
      ? (removed?.text.match(/&m\d+/)?.[0] ?? null)
      : null;
  const left = (map.frontmatter.match(/&m\d+/g) ?? []).filter((anchor) => anchor !== gone);
  if (anchors(written) !== left.sort().join()) problems.push('anchors');
  return problems.length === 0 ? [] : [`seed ${seed} ${operation}: ${problems.join(', ')}`];
}

describe('a changed map keeps its untouched entries’ bytes, as a property (#697)', () => {
  it.each<Operation>(['move', 'add', 'delete', 'rename', 'replace', 'edit'])(
    'on a %s of another entry',
    (operation) => {
      const broken: string[] = [];
      for (let seed = 1; seed <= 500; seed += 1) broken.push(...problemsOf(seed, operation));
      expect(broken.slice(0, 5)).toEqual([]);
    },
    60_000,
  );

  it.each<Operation>(['move', 'add', 'delete', 'rename', 'replace', 'edit'])(
    'never loses a value or comment on a %s, among comments the library places',
    (operation) => {
      const broken: string[] = [];
      for (let seed = 1; seed <= 300; seed += 1) broken.push(...problemsOf(seed, operation, true));
      expect(broken.slice(0, 5)).toEqual([]);
    },
    60_000,
  );
});

describe('the map written entry by entry, checked against it written whole (#697)', () => {
  /** `m.a` changed from 1 to 2, with a writer that writes `bodies` entry by entry or whole. */
  function check(bodies: { byEntry: string; whole: string }) {
    const document = parseDocument('m:\n  a: 1\n');
    document.set('m', document.createNode({ a: 2 }));
    const edit: Edit = {
      touched: new Set(),
      asWritten: new Map(),
      cleared: new Map(),
      keys: new Set(['m']),
    };
    const tried: string[] = [];
    const body = checkedBody({
      document,
      before: null,
      edit,
      was: { m: { a: 1 } },
      blank: '',
      lists: {},
      found: 'm:\n  a: 1',
      compose: ({ rules, found }) => {
        tried.push(`${rules} ${found === null ? 'whole' : 'by entry'}`);
        return found === null ? bodies.whole : bodies.byEntry;
      },
    });
    return { body, tried };
  }

  it('takes it entry by entry when that reads back right with every comment', () => {
    const { body, tried } = check({ byEntry: 'm:\n  a:  2 # n', whole: 'm:\n  a: 2 # n' });
    expect(body).toBe('m:\n  a:  2 # n');
    expect(tried).toEqual(['kept whole', 'kept by entry']);
  });

  it('takes it whole, under the same rules, when entry by entry reads back wrong', () => {
    const { body, tried } = check({ byEntry: 'm:\n  a: 3', whole: 'm:\n  a: 2' });
    expect(body).toBe('m:\n  a: 2');
    expect(tried).toEqual(['kept whole', 'kept by entry']);
  });

  it('takes it whole when entry by entry leaves a comment out', () => {
    expect(check({ byEntry: 'm:\n  a: 2', whole: 'm:\n  a: 2 # n' }).body).toBe('m:\n  a: 2 # n');
  });

  it('takes it whole when entry by entry writes a key twice', () => {
    const { body } = check({ byEntry: 'm:\n  a: 2\n  a: 2', whole: 'm:\n  a: 2' });
    expect(body).toBe('m:\n  a: 2');
  });

  it('takes it whole when entry by entry writes a comment twice', () => {
    const { body } = check({ byEntry: 'm: # n\n  a: 2 # n', whole: 'm:\n  a: 2 # n' });
    expect(body).toBe('m:\n  a: 2 # n');
  });
});
