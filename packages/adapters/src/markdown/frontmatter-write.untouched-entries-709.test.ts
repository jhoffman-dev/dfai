/**
 * #709: the shapes PR #707's by-entry writing still wrote whole. A comment
 * line under a key with no value — which the library reads as that value's
 * own — and block text with an explicit indent (`|2`, `>2-`) next to the entry the
 * change reaches: every untouched entry keeps its bytes, and the map reads
 * back as the change asked.
 */
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { updateFrontmatter } from './frontmatter-write.ts';

const block = (...lines: string[]) => `---\n${lines.join('\n')}\n---\n`;

const propertiesOf = (frontmatter: string) =>
  (parse(frontmatter.replace(/^---\n/, '').replace(/---\n$/, '')) as Record<string, unknown>)[
    'properties'
  ] as Record<string, unknown>;

type Change = (properties: Record<string, unknown>) => Record<string, unknown>;

const renamed =
  (from: string): Change =>
  (properties) =>
    Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key === from ? 'renamed' : key, value]),
    );

const deleted =
  (gone: string): Change =>
  (properties) =>
    Object.fromEntries(Object.entries(properties).filter(([key]) => key !== gone));

const added: Change = (properties) => ({ ...properties, added: { kind: 'text' } });

/** The block written for `change`, after checking it reads back as asked. */
function written(frontmatter: string, change: Change): string {
  const properties = change(propertiesOf(frontmatter));
  const text = updateFrontmatter(frontmatter, { properties });
  expect(propertiesOf(text)).toEqual(properties);
  return text;
}

describe('a comment line under a key with no value (#709)', () => {
  const empty = block('properties:', '    a:', '    # about b', '    b:   1', '    c:  2');

  it('stays, with every other entry’s bytes, when the entry under it is deleted', () => {
    expect(written(empty, deleted('b'))).toBe(
      block('properties:', '    a:', '    # about b', '    c:  2'),
    );
  });

  it('stays when the entry under it is renamed, the new one at the map’s columns', () => {
    expect(written(empty, renamed('b'))).toBe(
      block('properties:', '    a:', '    # about b', '    renamed: 1', '    c:  2'),
    );
  });

  it('keeps the ones the library reads as the key’s own when the entry under it is deleted', () => {
    const two = block('properties:', '  a:', '  # one', '  # two', '  b: 1', '  c: 2');
    // The library reads `# one` as a's and `# two` as b's: that one goes with b.
    expect(written(two, deleted('b'))).toBe(block('properties:', '  a:', '  # one', '  c: 2'));
  });

  it('stays under a key with only a comment, before a quoted key holding a list', () => {
    const commented = block(
      'properties:',
      '    a:   # empty',
      '    # about b',
      '    "b c":   [x,  y]',
      '    c:  2',
    );
    expect(written(commented, deleted('b c'))).toBe(
      block('properties:', '    a:   # empty', '    # about b', '    c:  2'),
    );
  });
});

describe('block text next to the entry a change reaches (#709)', () => {
  const indented = block(
    'properties:',
    '  a:  |2',
    '      lead',
    '    x',
    '',
    '  # about b',
    '  b: 1',
  );

  it('keeps an explicit indent and its spacing when the entry under it is deleted', () => {
    expect(written(indented, deleted('b'))).toBe(
      block('properties:', '  a:  |2', '      lead', '    x'),
    );
  });

  it('keeps it, and the blank line under it, when an entry is added', () => {
    expect(written(indented, added)).toBe(
      block(
        'properties:',
        '  a:  |2',
        '      lead',
        '    x',
        '',
        '  # about b',
        '  b: 1',
        '  added:',
        '    kind: text',
      ),
    );
  });

  it('keeps folded text with an explicit indent when the entry under it is renamed', () => {
    const folded = block('properties:', '  k:   >2-', '     text', '    more', '', '  b: 1');
    expect(written(folded, renamed('b'))).toBe(
      block('properties:', '  k:   >2-', '     text', '    more', '  renamed: 1'),
    );
  });

  it('keeps the blank line `+` text ends in, beside text with an explicit indent', () => {
    const lines = ['  a:', '    x: |2', '        lead', '    y: |+', '      kept', ''];
    const both = block('properties:', ...lines, '  b: 1', '  c:   2');
    expect(written(both, deleted('b'))).toBe(block('properties:', ...lines, '  c:   2'));
  });

  // A last line of spaces deeper than the text is the text's own, not a blank line of the map's.
  const spaced = (header: string) =>
    block('properties:', `  a: ${header}`, '     x', '       ', '  b: 1', '  c: 2');

  it.each([
    ['|2-', deleted('b')],
    ['|2', deleted('b')],
    ['>2', deleted('b')],
    ['|2', added],
    ['|2', renamed('b')],
  ] as const)('keeps `%s` text ending in a line of spaces', (header, change) => {
    const text = written(spaced(header), change);
    expect(text).toContain(`\n  a: ${header}\n     x\n       \n`);
    expect(text).toContain('\n  c: 2\n');
  });
});
