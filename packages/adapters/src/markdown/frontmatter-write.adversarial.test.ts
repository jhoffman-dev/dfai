/**
 * Adversarial (#200): updateFrontmatter must name a key the way the reader
 * does — an alias key `*k` by the key `&k` anchors, a null key `~` as "" — or
 * a change adds a second key that shadows the one already there. And a value
 * that refers to itself must not make the write throw. Mirrors
 * frontmatter-add.adversarial.test.ts (#193).
 */
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { updateFrontmatter } from './frontmatter-write.ts';
import { parseFrontmatterProperties } from './frontmatter.ts';

const block = (...lines: string[]) => `---\n${lines.join('\n')}\n---\n`;

/** The block as YAML values, with cycles kept (JSON cannot hold them). */
const valuesOf = (frontmatter: string) =>
  parseDocument(frontmatter.replace(/^---\n/, '').replace(/\n---\n$/, '\n')).toJS() as Record<
    string,
    unknown
  >;

describe('updateFrontmatter, on a key written as an alias', () => {
  const before = block('k: &k tasks', '*k : old', 'title: Plan');

  it('the reader names it by the key its anchor holds', () => {
    expect(parseFrontmatterProperties(before)).toEqual({ k: 'tasks', tasks: 'old', title: 'Plan' });
  });

  it('changes that key in its place rather than adding one that shadows it', () => {
    // The changed key is the library's to write, and it writes an alias key
    // in explicit form; the lines around it keep their bytes.
    const written = updateFrontmatter(before, { tasks: 'new' });
    expect(written).toBe(block('k: &k tasks', '? *k', ': new', 'title: Plan'));
    expect(parseFrontmatterProperties(written)).toEqual({
      k: 'tasks',
      tasks: 'new',
      title: 'Plan',
    });
  });

  it('a value it already holds is no change', () => {
    expect(updateFrontmatter(before, { tasks: 'old' })).toBe(before);
  });

  it('removes it when cleared, leaving the other lines as they were', () => {
    expect(updateFrontmatter(before, { tasks: null })).toBe(block('k: &k tasks', 'title: Plan'));
  });

  it('another key changed leaves the alias line as it was', () => {
    expect(updateFrontmatter(before, { title: 'Next' })).toBe(
      block('k: &k tasks', '*k : old', 'title: Next'),
    );
  });
});

describe('updateFrontmatter, on a null key', () => {
  const before = block('~: old', 'title: Plan');

  it('the reader names it ""', () => {
    expect(parseFrontmatterProperties(before)).toEqual({ '': 'old', title: 'Plan' });
  });

  it('changes that key in its place rather than adding one that shadows it', () => {
    expect(updateFrontmatter(before, { '': 'new' })).toBe(block('~: new', 'title: Plan'));
  });

  it('a value it already holds is no change', () => {
    expect(updateFrontmatter(before, { '': 'old' })).toBe(before);
  });

  it('removes it when cleared, leaving the other lines as they were', () => {
    expect(updateFrontmatter(before, { '': null })).toBe(block('title: Plan'));
  });

  it('another key changed leaves the null key line as it was', () => {
    expect(updateFrontmatter(before, { title: 'Next' })).toBe(block('~: old', 'title: Next'));
  });
});

describe('updateFrontmatter, with a value that refers to itself', () => {
  // YAML allows `&e` / `*e` cycles; `toJS` builds a circular object, which
  // JSON.stringify — the "already holds it?" check — throws on.
  it.each([
    // A map written into a map keeps its node, and with it the anchor `&e`.
    ['through a map', block('extra: &e', '  me: *e', 'title: Plan'), 'extra: &e'],
    ['through a list', block('extra: &e', '  - *e', 'title: Plan'), 'extra:'],
  ])('%s: the cyclic key is changed, the others keep their bytes', (_, before, head) => {
    let written = '';
    expect(() => {
      written = updateFrontmatter(before, { extra: { a: 1 } });
    }).not.toThrow();
    expect(written).toBe(block(head, '  a: 1', 'title: Plan'));
  });

  it('a key beside the cycle changes and the cycle keeps its bytes', () => {
    const before = block('extra: &e', '  me: *e', 'title: Plan');
    expect(updateFrontmatter(before, { title: 'Next' })).toBe(
      block('extra: &e', '  me: *e', 'title: Next'),
    );
  });

  it('a JavaScript object cycle is written as an anchor, the other keys keep their bytes', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    const before = block('# kept', 'title: Plan', 'extra: old');
    let written = '';
    expect(() => {
      written = updateFrontmatter(before, { extra: cyclic });
    }).not.toThrow();
    expect(written.startsWith('---\n# kept\ntitle: Plan\n')).toBe(true);
    const extra = valuesOf(written)['extra'] as Record<string, unknown>;
    expect(extra['a']).toBe(1);
    expect(extra['self']).toBe(extra);
    expect(valuesOf(written)['title']).toBe('Plan');
  });

  it.each([
    ['through a map', block('extra: &e', '  me: *e', 'title: Plan')],
    ['through a list', block('extra: &e', '  - *e', 'title: Plan')],
  ])('%s: written back as it was read, the block keeps every byte', (_, before) => {
    // Counted as changed, the value was written again one level deeper on
    // every save, and the file grew with each round trip.
    const extra = parseFrontmatterProperties(before)['extra'];
    expect(updateFrontmatter(before, { extra })).toBe(before);
  });
});

describe('updateFrontmatter, on two spellings of one key, keeps the shadowed one', () => {
  const before = block('~: e', '"": z', 't: T');

  it('setting the key writes the pair the reader reads; the other keeps its bytes', () => {
    expect(updateFrontmatter(before, { '': 'f' })).toBe(block('~: e', '"": f', 't: T'));
  });

  it('changing another key leaves both spellings as they were', () => {
    expect(updateFrontmatter(before, { t: 'U' })).toBe(block('~: e', '"": z', 't: U'));
  });
});

describe('updateFrontmatter, on a list used as a key', () => {
  const before = block('? [a, b]', ': x', 't: T');

  it('names it as the reader does, and changes it in its place', () => {
    expect(Object.keys(parseFrontmatterProperties(before))).toEqual(['[ a, b ]', 't']);
    const written = updateFrontmatter(before, { '[ a, b ]': 'y' });
    expect(written).toBe(block('? [a, b]', ': y', 't: T'));
  });

  it('an alias of it as a key is named as the reader names it', () => {
    const aliased = block('k: &k [a, b]', '*k : x', 't: T');
    expect(parseFrontmatterProperties(aliased)).toEqual({ k: ['a', 'b'], '*k': 'x', t: 'T' });
    expect(parseFrontmatterProperties(updateFrontmatter(aliased, { '*k': 'y' }))).toEqual({
      k: ['a', 'b'],
      '*k': 'y',
      t: 'T',
    });
  });

  it('refuses to change the list an alias key names, rather than rename that key', () => {
    // Written out in the alias's place, the key would read as "[ a, b ]", not "*k".
    const aliased = block('k: &k [a, b]', '*k : x', 't: T');
    expect(() => updateFrontmatter(aliased, { k: [1] })).toThrow(/would be renamed/);
  });
});

describe('updateFrontmatter, given a cycle of another length than the one stored', () => {
  // `x = [x]` and `y = [[y]]` read the same at every depth. Comparing them by
  // one partner per object alternated between pairings and never ended.
  const listOfItself = (depth: number) => {
    const outer: unknown[] = [];
    let inner = outer;
    for (let at = 1; at < depth; at += 1) {
      const next: unknown[] = [];
      inner.push(next);
      inner = next;
    }
    inner.push(outer);
    return outer;
  };
  const mapOfItself = (depth: number) => {
    const outer: Record<string, unknown> = {};
    let inner = outer;
    for (let at = 1; at < depth; at += 1) {
      const next: Record<string, unknown> = {};
      inner['m'] = next;
      inner = next;
    }
    inner['m'] = outer;
    return outer;
  };

  it.each([
    ['a one-list cycle, given two', block('a: &e [*e]', 't: T'), listOfItself(2)],
    ['a two-list cycle, given one', block('a: &e [[*e]]', 't: T'), listOfItself(1)],
    ['a two-list cycle, given three', block('a: &e [[*e]]', 't: T'), listOfItself(3)],
    ['a one-map cycle, given two', block('a: &e', '  m: *e', 't: T'), mapOfItself(2)],
    ['a two-map cycle, given one', block('a: &e', '  m:', '    m: *e', 't: T'), mapOfItself(1)],
  ])('%s: reads the same, so the block keeps every byte', (_, before, given) => {
    expect(updateFrontmatter(before, { a: given })).toBe(before);
  });
});

describe('updateFrontmatter, on two spellings of one key inside a map', () => {
  const before = block('m:', '  1: one', '  "1": two', 't: T');

  it('a set edits the spelling the reader reads, the other keeps its bytes', () => {
    const written = updateFrontmatter(before, { m: { '1': 'three' } });
    expect(parseFrontmatterProperties(written)).toEqual({ m: { '1': 'three' }, t: 'T' });
    expect(written).toBe(block('m:', '  1: one', '  "1": three', 't: T'));
  });

  it('a remove removes every spelling', () => {
    const written = updateFrontmatter(before, { m: { x: 1 } });
    expect(parseFrontmatterProperties(written)).toEqual({ m: { x: 1 }, t: 'T' });
  });
});

/**
 * #284: a key written twice makes the block a YAML document with errors. A
 * change to any other key writes only that key's bytes (ADR-0003); a change to
 * the duplicated key — removing it included — is refused with a reason the
 * person can act on, never the library's "cannot be stringified".
 */
describe('updateFrontmatter, on a block that lists a key twice', () => {
  const refusedFor = (key: string, message: string) =>
    expect.objectContaining({ name: 'FrontmatterRefusedError', key, message });
  const twice = (key: string) =>
    `This note's properties list "${key}" twice; fix it in the source before changing it.`;

  it('changes another key by its own bytes alone, every other byte as it was', () => {
    const before = block('# head', 'a:   1  # one', 't: T', 'list:  [x,  y]', 'a: 2', '# tail');
    expect(updateFrontmatter(before, { t: 'U' })).toBe(
      block('# head', 'a:   1  # one', 't: U', 'list:  [x,  y]', 'a: 2', '# tail'),
    );
  });

  it('removes another key, the duplicated lines kept byte for byte', () => {
    const before = block('a: 1', 't: T', 'a:  2');
    expect(updateFrontmatter(before, { t: null })).toBe(block('a: 1', 'a:  2'));
  });

  it('keeps CRLF line endings when changing another key', () => {
    const before = '---\r\na: 1\r\nt: T\r\na: 2\r\n---\r\n';
    expect(updateFrontmatter(before, { t: 'U' })).toBe('---\r\na: 1\r\nt: U\r\na: 2\r\n---\r\n');
  });

  it('refuses a change to the duplicated key, with the reason', () => {
    const before = block('a: 1', 't: T', 'a: 2');
    expect(() => updateFrontmatter(before, { a: 3 })).toThrowError(refusedFor('a', twice('a')));
  });

  it('refuses a change to the duplicated key even when given with another key', () => {
    const before = block('a: 1', 't: T', 'a: 2');
    expect(() => updateFrontmatter(before, { t: 'U', a: 3 })).toThrowError(
      refusedFor('a', twice('a')),
    );
  });

  it.each([null, undefined])('refuses removing the duplicated key (%s)', (removal) => {
    const before = block('a: 1', 't: T', 'a: 2');
    expect(() => updateFrontmatter(before, { a: removal })).toThrowError(
      refusedFor('a', twice('a')),
    );
  });

  it('adds a new key after the others, every line already there kept', () => {
    const before = block('a: 1', 't: T', 'a:  2');
    expect(updateFrontmatter(before, { n: 'N' })).toBe(block('a: 1', 't: T', 'a:  2', 'n: N'));
  });

  it('with two keys each listed twice, changes a third and refuses either', () => {
    const before = block('a: 1', 'b: x', 't: T', 'a: 2', 'b:  y');
    expect(updateFrontmatter(before, { t: 'U' })).toBe(
      block('a: 1', 'b: x', 't: U', 'a: 2', 'b:  y'),
    );
    expect(() => updateFrontmatter(before, { a: 3 })).toThrowError(refusedFor('a', twice('a')));
    expect(() => updateFrontmatter(before, { b: null })).toThrowError(refusedFor('b', twice('b')));
  });

  it('a key listed twice inside a key written as a map refuses every change', () => {
    const before = block('? {x: 1, x: 2}', ': v', 't: T');
    expect(() => updateFrontmatter(before, { t: 'U' })).toThrowError(
      refusedFor(
        't',
        "This note's properties list a key twice; fix it in the source before changing them.",
      ),
    );
  });

  it('a key listed twice inside a map refuses only that property', () => {
    const before = block('m:', '  x: 1', '  x: 2', 't: T');
    expect(updateFrontmatter(before, { t: 'U' })).toBe(block('m:', '  x: 1', '  x: 2', 't: U'));
    expect(() => updateFrontmatter(before, { m: { x: 3 } })).toThrowError(
      refusedFor(
        'm',
        `This note's property "m" lists "x" twice; fix it in the source before changing it.`,
      ),
    );
  });
});

/**
 * #377: a block whose keys are all indented is still a block map — the keys
 * only have to line up. A rewritten or added key takes the block's own indent,
 * and every line nothing changed keeps its bytes (ADR-0003).
 */
describe('updateFrontmatter, on a block whose keys are indented (#377)', () => {
  const unreadable = (key: string, problem: string) =>
    expect.objectContaining({
      name: 'FrontmatterRefusedError',
      key,
      message: `This note's properties cannot be read (${problem}); fix them in the source before changing them.`,
    });

  it('changing a key keeps the block indent', () => {
    const written = updateFrontmatter(block('  a: 1', '  t: T', '  b: 2'), { t: 'U' });
    expect(written).toBe(block('  a: 1', '  t: U', '  b: 2'));
    expect(parseFrontmatterProperties(written)).toEqual({ a: 1, t: 'U', b: 2 });
  });

  it('a changed list or map is written at the block indent, its items as deep as they were', () => {
    const before = block('  a: 1', '  tags:', '    - x', '  m:', '    k: 1');
    expect(updateFrontmatter(before, { tags: ['x', 'y'], m: { k: 2 } })).toBe(
      block('  a: 1', '  tags:', '    - x', '    - y', '  m:', '    k: 2'),
    );
  });

  it('a changed value written over several lines stays inside the block', () => {
    const written = updateFrontmatter(block('  a: 1', '  t: T'), { t: 'one\ntwo' });
    expect(parseFrontmatterProperties(written)).toEqual({ a: 1, t: 'one\ntwo' });
    const lines = written.split('\n').slice(1, -2);
    // The library folds the value over a blank line, which needs no indent.
    expect(lines.filter((line) => line !== '' && !line.startsWith('  '))).toEqual([]);
  });

  it('adding a key uses the block indent', () => {
    const written = updateFrontmatter(block('  a: 1', '  t: T'), { n: 'N' });
    expect(written).toBe(block('  a: 1', '  t: T', '  n: N'));
  });

  it('removing a key leaves the other lines byte-identical', () => {
    const before = block('  a:   1   # spaced', '  t: T', "  b: 'q'");
    expect(updateFrontmatter(before, { t: null })).toBe(block('  a:   1   # spaced', "  b: 'q'"));
  });

  it("a key's comment, at the block indent, goes where the key goes", () => {
    const before = block('  a: 1', '  # about t', '  t: T', '  b: 2');
    expect(updateFrontmatter(before, { t: 'U' })).toBe(
      block('  a: 1', '  # about t', '  t: U', '  b: 2'),
    );
    expect(updateFrontmatter(before, { t: null })).toBe(block('  a: 1', '  b: 2'));
  });

  // Mixed indents. Keys at different columns are not one block map, so the
  // block cannot be read and a change to it is refused rather than guessed at.
  // Comments may stand at any column: each keeps its own, and only a
  // rewritten key line takes the keys' indent.
  it('mixed indents: keys at different columns are refused, not rewritten', () => {
    const before = block('  a: 1', '    t: T');
    expect(() => updateFrontmatter(before, { t: 'U' })).toThrowError(
      unreadable('t', 'Nested mappings are not allowed in compact mappings at line 1, column 6'),
    );
  });

  // A remove-property step on a key the note lacks writes nothing, so it has
  // nothing to refuse; a change that would write is refused on that key.
  it('an unreadable block: removing a key it lacks is no change', () => {
    const before = block('  a: 1', '    t: T');
    expect(updateFrontmatter(before, { missing: null })).toBe(before);
    expect(updateFrontmatter(before, { missing: undefined, gone: null })).toBe(before);
  });

  it('an unreadable block: a change is refused on the key it would write', () => {
    const before = block('  a: 1', '    t: T');
    expect(() => updateFrontmatter(before, { missing: null, n: 'N' })).toThrowError(
      unreadable('n', 'Nested mappings are not allowed in compact mappings at line 1, column 6'),
    );
  });

  // A comment set apart by blank lines under a key goes with that key, the
  // first as any other: removing the key removes it.
  it('removing the first key drops a comment set apart under it, as for any other key', () => {
    expect(updateFrontmatter(block('a: 1', '', '# c', '', 'b: 2'), { a: null })).toBe(
      block('b: 2'),
    );
    expect(updateFrontmatter(block('x: 0', 'a: 1', '', '# c', '', 'b: 2'), { a: null })).toBe(
      block('x: 0', 'b: 2'),
    );
  });

  it('mixed indents: comments at other columns keep their own', () => {
    const before = block('# head', '  a: 1', '      # deep', '# about t', '  t: T', '  b: 2');
    expect(updateFrontmatter(before, { t: 'U' })).toBe(
      block('# head', '  a: 1', '      # deep', '# about t', '  t: U', '  b: 2'),
    );
  });

  it('tab indents are refused (YAML allows no tab as indentation); a tab after the indent is kept', () => {
    expect(() => updateFrontmatter(block('\ta: 1', '\tt: T'), { t: 'U' })).toThrowError(
      unreadable('t', 'Tabs are not allowed as indentation at line 1, column 1'),
    );
    expect(updateFrontmatter(block('  a:\t1', '  t: T'), { t: 'U' })).toBe(
      block('  a:\t1', '  t: U'),
    );
  });

  it('CRLF: the changed and the added key keep the indent and the line ending', () => {
    const before = '---\r\n  a: 1\r\n  t: T\r\n---\r\n';
    expect(updateFrontmatter(before, { t: 'U', n: 'N' })).toBe(
      '---\r\n  a: 1\r\n  t: U\r\n  n: N\r\n---\r\n',
    );
  });
});
