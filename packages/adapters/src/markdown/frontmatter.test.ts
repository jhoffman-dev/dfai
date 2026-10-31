import { describe, expect, it } from 'vitest';
import { frontmatterProblem, parseFrontmatterProperties } from './frontmatter.ts';

describe('frontmatterProblem', () => {
  it('says nothing of a readable block, an empty one, or none', () => {
    expect(frontmatterProblem('---\ntitle: Today\ntags: [a, b]\n---\n')).toBeNull();
    expect(frontmatterProblem('---\n---\n')).toBeNull();
    expect(frontmatterProblem(null)).toBeNull();
  });

  it('says nothing of a block holding only a comment or an empty map', () => {
    expect(frontmatterProblem('---\n# a comment\n---\n')).toBeNull();
    expect(frontmatterProblem('---\n{}\n---\n')).toBeNull();
  });

  it('says why YAML that is a list or one value is not a set of properties (#679)', () => {
    expect(frontmatterProblem('---\n- atlas: automation\n  name: Digest\n---\n')).toBe(
      'it is a list',
    );
    expect(frontmatterProblem('---\natlas automation\n---\n')).toBe('it is one value');
  });

  it('says why a block with a key given twice cannot be read', () => {
    const problem = frontmatterProblem('---\nsidebarOrder: [views]\nsidebarOrder: [types]\n---\n');
    expect(problem).toMatch(/unique/i);
    // One line, fit for a notice, rather than YAML's pointer at the column.
    expect(problem).not.toContain('\n');
  });

  it('says why a block that is not YAML at all cannot be read', () => {
    expect(frontmatterProblem('---\ntags: [a, b\n---\n')).not.toBeNull();
  });
});

describe('parseFrontmatterProperties', () => {
  it('gives up on a block that lists a key twice, but reads its last copy for writing', () => {
    const twice = '---\na: 1\nt: T\na: 2\n---\n';
    expect(parseFrontmatterProperties(twice)).toEqual({});
    expect(parseFrontmatterProperties(twice, { forWriting: true })).toEqual({ a: 2, t: 'T' });
  });

  it('reads simple keys', () => {
    expect(parseFrontmatterProperties('---\ntitle: Today\ncount: 3\n---\n')).toEqual({
      title: 'Today',
      count: 3,
    });
  });

  it('reads a list', () => {
    expect(parseFrontmatterProperties('---\ntags: [a, b]\n---\n')).toEqual({ tags: ['a', 'b'] });
  });

  it('reads a block list', () => {
    expect(parseFrontmatterProperties('---\ntags:\n  - a\n  - b\n---\n')).toEqual({
      tags: ['a', 'b'],
    });
  });

  it('reads a nested map', () => {
    expect(parseFrontmatterProperties('---\nmeta:\n  a: 1\n---\n')).toEqual({ meta: { a: 1 } });
  });

  it('reads a boolean and a null', () => {
    expect(parseFrontmatterProperties('---\ndone: true\nempty:\n---\n')).toEqual({
      done: true,
      empty: null,
    });
  });

  it('handles CRLF line endings', () => {
    expect(parseFrontmatterProperties('---\r\ntitle: Today\r\n---\r\n')).toEqual({
      title: 'Today',
    });
  });

  it.each([
    ['no frontmatter', null],
    ['an empty block', '---\n---\n'],
    ['only whitespace', '---\n   \n---\n'],
  ])('returns nothing for %s', (_label, input) => {
    expect(parseFrontmatterProperties(input)).toEqual({});
  });

  it('returns nothing rather than failing on malformed YAML', () => {
    expect(parseFrontmatterProperties('---\n: : :\nbroken: [unclosed\n---\n')).toEqual({});
  });

  it('returns nothing when the block is a list rather than a map', () => {
    expect(parseFrontmatterProperties('---\n- one\n- two\n---\n')).toEqual({});
  });
});

describe('a block behind a byte-order mark (A20-05)', () => {
  it('reads its properties and finds no problem', () => {
    const block = '\uFEFF---\ntitle: Plan\n---\n';
    expect(parseFrontmatterProperties(block)).toEqual({ title: 'Plan' });
    expect(frontmatterProblem(block)).toBeNull();
  });
});
