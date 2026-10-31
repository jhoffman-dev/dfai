/**
 * Adversarial pass on #394 (#377): a frontmatter block whose keys are
 * indented. A change or an added key is written at the block's own indent;
 * every key the change did not reach keeps its bytes (ADR-0003); and a key
 * given back as the text `frontmatterKeyTexts` read it as is written as that
 * text — which is how archiving and the Today page's undo give a key back.
 *
 * Failing tests prove a bug; passing ones stay as guards.
 */
import { describe, expect, it } from 'vitest';
import { FrontmatterRefusedError } from '@dfai/application';
import { KeyAsWritten } from '@dfai/domain';
import { frontmatterKeyTexts, updateFrontmatter } from './frontmatter-write.ts';
import { frontmatterProblem, parseFrontmatterProperties } from './frontmatter.ts';

const block = (...lines: string[]) => `---\n${lines.join('\n')}\n---\n`;
const at = (indent: number, ...lines: string[]) =>
  block(...lines.map((line) => (line === '' ? '' : `${' '.repeat(indent)}${line}`)));

/** mulberry32: a small seeded generator, so a failing case can be replayed. */
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

/** What a written block must be: readable, and read as `expected`. */
function expectReadsAs(written: string, expected: Record<string, unknown>) {
  expect(frontmatterProblem(written)).toBeNull();
  expect(parseFrontmatterProperties(written)).toEqual(expected);
}

describe('#394 a key given back as the text it was read as is written, not removed', () => {
  it.each([1, 2, 4])('an unchanged key given back as its own text, at an indent of %i', (n) => {
    const original = at(n, 'type: task', 'status: next-action', 'due: 2026-10-20');
    const text = frontmatterKeyTexts(original)['status'];
    expect(text).toBe(`${' '.repeat(n)}status: next-action\n`);
    expect(updateFrontmatter(original, { status: new KeyAsWritten(text!) })).toBe(original);
  });

  it.each([1, 2, 4])('a changed key undone with the text it had, at an indent of %i', (n) => {
    const original = at(n, 'type: task', 'status: next-action # set by Mara', 'due: 2026-10-20');
    const text = frontmatterKeyTexts(original)['status']!;
    const changed = updateFrontmatter(original, { status: 'done' });
    expect(parseFrontmatterProperties(changed)).toMatchObject({ status: 'done' });
    expect(updateFrontmatter(changed, { status: new KeyAsWritten(text) })).toBe(original);
  });

  it('the first key, with the comment that opens it, given back as its own text', () => {
    const original = at(2, '# Mara keeps this one', 'archived: false', 'title: Plan');
    const text = frontmatterKeyTexts(original)['archived']!;
    expect(updateFrontmatter(original, { archived: new KeyAsWritten(text) })).toBe(original);
  });

  it('a key whose value is a nested list, given back as its own text', () => {
    const original = at(2, 'title: Plan', 'tags:', '  - home', '  - garden', 'due: 2026-10-20');
    const text = frontmatterKeyTexts(original)['tags']!;
    const changed = updateFrontmatter(original, { tags: ['work'] });
    expect(updateFrontmatter(changed, { tags: new KeyAsWritten(text) })).toBe(original);
  });

  it('guard: column-0 text written into an indented block lands at the block indent', () => {
    const written = updateFrontmatter(at(2, 'a: 1', 't: T'), {
      t: new KeyAsWritten('# about t\nt: V\n'),
    });
    expect(written).toBe(at(2, 'a: 1', '# about t', 't: V'));
  });

  it('guard: a column-0 block scalar with a blank line is indented, its blank line kept empty', () => {
    const written = updateFrontmatter(at(2, 'a: 1'), {
      t: new KeyAsWritten('t: |\n  x\n\n  y\n'),
    });
    expect(written).toBe(at(2, 'a: 1', 't: |', '  x', '', '  y'));
    expectReadsAs(written, { a: 1, t: 'x\n\ny\n' });
  });
});

describe('#394 comments heading the block are kept when the first key changes', () => {
  it.each([
    [
      'indented block, comment deeper than the keys',
      at(2, '  # owner: Mara Quill', 'a: 1', 't: T'),
    ],
    ['unindented block, comment at column 2', block('  # owner: Mara Quill', 'a: 1', 't: T')],
    [
      'indented block, comments at 0, 2 and 4 over the first key',
      block('# owner: Mara Quill', '  # reviewed', '    # by Tobias', '  a: 1', '  t: T'),
    ],
  ])('a change to the first key keeps every head comment: %s', (_, original) => {
    const written = updateFrontmatter(original, { a: 9 });
    const comments = (text: string) => text.split('\n').filter((line) => /^\s*#/.test(line));
    expect(comments(written)).toEqual(comments(original));
  });

  it('removing the first key keeps a head comment that does not open it', () => {
    const original = at(2, '  # owner: Mara Quill', 'a: 1', 't: T');
    expect(updateFrontmatter(original, { a: null })).toBe(at(2, '  # owner: Mara Quill', 't: T'));
  });

  it('a head comment the change did not reach keeps its column', () => {
    const original = at(2, '# owner: Mara Quill', '', 'a: 1', 't: T');
    expect(updateFrontmatter(original, { a: 9 })).toBe(
      at(2, '# owner: Mara Quill', '', 'a: 9', 't: T'),
    );
  });

  it('guard: a head comment at the keys’ column opens the first key and travels with it', () => {
    const original = at(2, '# owner: Mara Quill', 'a: 1', 't: T');
    expect(updateFrontmatter(original, { a: 9 })).toBe(
      at(2, '# owner: Mara Quill', 'a: 9', 't: T'),
    );
  });
});

describe('#394 comments under a changed key are not lost', () => {
  it.each([
    ['indented, at 0 then 4', ['# zero', '    # four']],
    ['indented, at 0, 1, 2 and 4', ['# zero', ' # one', '  # two', '    # four']],
  ])('a change to the key above them keeps every comment line: %s', (_, between) => {
    const original = block('  a: 1', ...between, '  b: 2');
    const written = updateFrontmatter(original, { a: 9 });
    const comments = (text: string) => text.split('\n').filter((line) => /^\s*#/.test(line));
    expect(comments(written)).toEqual(between);
  });

  it('control: an unindented block loses them the same way (column 0, then 2)', () => {
    const between = ['# zero', '  # two'];
    const written = updateFrontmatter(block('a: 1', ...between, 'b: 2'), { a: 9 });
    const comments = (text: string) => text.split('\n').filter((line) => /^\s*#/.test(line));
    expect(comments(written)).toEqual(between);
  });
});

describe('#394 guards: writes on an indented block', () => {
  it.each([1, 2, 4])('changes one key at an indent of %i, every other line kept', (n) => {
    expect(updateFrontmatter(at(n, 'a: 1', 't: T', 'b: 2'), { t: 'U' })).toBe(
      at(n, 'a: 1', 't: U', 'b: 2'),
    );
  });

  it.each([1, 2, 4])('adds a key at an indent of %i', (n) => {
    expect(updateFrontmatter(at(n, 'a: 1'), { n: 'new' })).toBe(at(n, 'a: 1', 'n: new'));
  });

  it.each([1, 2, 4])('removes a key at an indent of %i, byte for byte', (n) => {
    expect(updateFrontmatter(at(n, 'a: 1', 't: T', 'b: 2'), { t: null })).toBe(
      at(n, 'a: 1', 'b: 2'),
    );
  });

  it('a nested map under an indented key', () => {
    const written = updateFrontmatter(at(4, 'a: 1', 'm:', '  x: 1', '  y: 2', 'b: 2'), {
      m: { x: 1, y: 3 },
    });
    expect(written).toBe(at(4, 'a: 1', 'm:', '  x: 1', '  y: 3', 'b: 2'));
  });

  it('a list under an indented key, at its own depth or at none', () => {
    expect(updateFrontmatter(at(2, 'tags:', '  - a', 'b: 2'), { tags: ['a', 'c'] })).toBe(
      at(2, 'tags:', '  - a', '  - c', 'b: 2'),
    );
    expect(updateFrontmatter(at(2, 'tags:', '- a', 'b: 2'), { tags: ['a', 'c'] })).toBe(
      at(2, 'tags:', '- a', '- c', 'b: 2'),
    );
  });

  it('an added deep value stays under the block indent and reads back', () => {
    const value = { n: { o: [{ p: 1 }, 'q'] } };
    const written = updateFrontmatter(at(2, 'a: 1'), { m: value });
    expectReadsAs(written, { a: 1, m: value });
    expect(written.startsWith(at(2, 'a: 1').replace(/---\n$/, ''))).toBe(true);
  });

  it.each([
    ['literal with a blank line', ['d: |', '  line1', '', '  line2']],
    ['keep indicator', ['d: |+', '  x', '']],
    ['folded', ['d: >', '  x', '  y']],
    ['explicit indentation indicator', ['d: |2', '    x']],
  ])('an untouched block scalar (%s) keeps its bytes', (_, scalar) => {
    const original = at(2, ...scalar, 'b: 2');
    expect(updateFrontmatter(original, { b: 3 })).toBe(at(2, ...scalar, 'b: 3'));
  });

  it('a changed block scalar is written at the block indent and reads back', () => {
    const written = updateFrontmatter(at(2, 'd: |', '  one', 'b: 2'), { d: 'x\n\ny\n' });
    expect(written).toBe(at(2, 'd: |', '  x', '', '  y', 'b: 2'));
  });

  it('comments at columns 0, 1, 2 and 4 above a changed key keep their bytes', () => {
    const between = ['# zero', ' # one', '  # two', '    # four'];
    const original = block('  a: 1', ...between, '  b: 2', '  t: T');
    expect(updateFrontmatter(original, { b: 9, t: 'U' })).toBe(
      block('  a: 1', ...between, '  b: 9', '  t: U'),
    );
  });

  it('an alias to a changed anchor still reads what it read', () => {
    const written = updateFrontmatter(at(2, 'a: &x 1', 'b: *x', 'c: 3'), { a: 2 });
    expectReadsAs(written, { a: 2, b: 1, c: 3 });
  });

  it('an anchor and alias the change does not reach keep their bytes', () => {
    const original = at(2, 'base: &b', '  x: 1', 'use: *b', 'c: 3');
    expect(updateFrontmatter(original, { c: 4 })).toBe(
      at(2, 'base: &b', '  x: 1', 'use: *b', 'c: 4'),
    );
  });

  it('CRLF and a byte-order mark are kept, the change at the indent', () => {
    const original = '﻿---\r\n  a: 1\r\n  t: T\r\n---\r\n';
    expect(updateFrontmatter(original, { t: 'U', n: 'new' })).toBe(
      '﻿---\r\n  a: 1\r\n  t: U\r\n  n: new\r\n---\r\n',
    );
  });

  it('an empty value is filled in place, at the indent', () => {
    expect(updateFrontmatter(at(2, 'a:', 't: T'), { a: 'v' })).toBe(at(2, 'a: v', 't: T'));
  });

  it('a key listed twice (#376) refuses a change to it, and lets another key change alone', () => {
    const original = at(2, 'a: 1', 'tags: [x]', 'tags: [y]', 't: T');
    expect(() => updateFrontmatter(original, { tags: ['z'] })).toThrow(FrontmatterRefusedError);
    expect(updateFrontmatter(original, { t: 'U' })).toBe(
      at(2, 'a: 1', 'tags: [x]', 'tags: [y]', 't: U'),
    );
  });
});

/** Values a property can be given that read back as given. */
const VALUES: readonly unknown[] = [
  'plain',
  'two words',
  42,
  true,
  '',
  'line one\nline two',
  ['home', 'garden'],
  { owner: 'Mara Quill', at: [1, 2] },
  null,
];

/** A seeded indented block: keys `k0…`, some opened by a comment, some holding nested values. */
function seededBlock(random: () => number) {
  const indent = [1, 2, 4][Math.floor(random() * 3)]!;
  const lines: string[] = [];
  const model: Record<string, unknown> = {};
  const size = 2 + Math.floor(random() * 6);
  for (let i = 0; i < size; i += 1) {
    const shape = Math.floor(random() * 4);
    if (i > 0 && random() < 0.3) lines.push(`# about k${i}`);
    if (shape === 0) {
      lines.push(`k${i}: v${i}`);
      model[`k${i}`] = `v${i}`;
    } else if (shape === 1) {
      lines.push(`k${i}:`, '  - a', '  - b');
      model[`k${i}`] = ['a', 'b'];
    } else if (shape === 2) {
      lines.push(`k${i}:`, '  x: 1', '  y: z');
      model[`k${i}`] = { x: 1, y: 'z' };
    } else {
      lines.push(`k${i}: |`, '  one', '', '  two');
      model[`k${i}`] = 'one\n\ntwo\n';
    }
  }
  return { text: at(indent, ...lines), model, size };
}

describe('#394 seeded round trips over indented blocks', () => {
  // 120 rounds of 8 edits: 0.4 s on a Mac, up to ~5 s on a loaded 4-core CI runner (main reached 4.1 s, #648).
  it('N random edits: the block stays readable, reads as edited, and untouched keys keep their bytes', () => {
    const random = seeded(394);
    for (let round = 0; round < 120; round += 1) {
      const start = seededBlock(random);
      let text = start.text;
      const model = { ...start.model };
      for (let edit = 0; edit < 8; edit += 1) {
        const key = `k${Math.floor(random() * (start.size + 2))}`;
        const value = VALUES[Math.floor(random() * VALUES.length)];
        const before = frontmatterKeyTexts(text);
        const written = updateFrontmatter(text, { [key]: value });
        if (value === null) delete model[key];
        else model[key] = value;
        const context = `round ${round}, edit ${edit}: ${key} = ${JSON.stringify(value)}\n${text}`;
        expect(frontmatterProblem(written), context).toBeNull();
        expect(parseFrontmatterProperties(written), context).toEqual(model);
        const after = frontmatterKeyTexts(written);
        for (const other of Object.keys(before).filter((name) => name !== key)) {
          expect(after[other], `${context}\nkey ${other}`).toBe(before[other]);
        }
        text = written;
      }
    }
  }, 15_000);

  it('N random edits, each undone with the key texts read before it: the block comes back byte for byte', () => {
    const random = seeded(3940);
    const broken: string[] = [];
    for (let round = 0; round < 120; round += 1) {
      const { text, size } = seededBlock(random);
      const key = `k${Math.floor(random() * size)}`;
      const value = VALUES[Math.floor(random() * (VALUES.length - 1))];
      const texts = frontmatterKeyTexts(text);
      const changed = updateFrontmatter(text, { [key]: value });
      const undone = updateFrontmatter(changed, { [key]: new KeyAsWritten(texts[key]!) });
      if (undone !== text)
        broken.push(`${key} = ${JSON.stringify(value)} in ${JSON.stringify(text)}`);
    }
    expect(broken).toEqual([]);
  });
});
