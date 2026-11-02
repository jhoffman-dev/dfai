/**
 * Attack on PR #736 (#709): a seeded fuzz of the by-entry frontmatter writer
 * (mulberry32, seed 736, 3,000 cases) against main's writer. Each case below
 * is a minimised failure, marked `it.fails` until it is fixed.
 *
 * The first three write a wrong value or a comment twice, on main as well as
 * on the branch. The last three are regressions: main kept the entry's bytes
 * and the branch rewrites it.
 */
import { describe, expect, it } from 'vitest';
import { Lexer, parse } from 'yaml';
import { updateFrontmatter } from './frontmatter-write.ts';

const inner = (frontmatter: string) => frontmatter.replace(/^---\n/, '').replace(/---\n?$/, '');

const read = (frontmatter: string) => parse(inner(frontmatter)) as Record<string, unknown>;

const commentsOf = (frontmatter: string) =>
  [...new Lexer().lex(inner(frontmatter))].filter((token) => token.startsWith('#'));

describe('values and comments survive a change (#736 attack)', () => {
  it.fails('a key added after keep-chomped block text leaves its kept blank line in it', () => {
    const text = '---\na: |+\n  x\n\n---\n';
    const written = updateFrontmatter(text, { b: 1 });
    expect(read(written)).toEqual({ a: 'x\n\n', b: 1 });
  });

  it.fails(
    'keep-chomped block text moved to the end of a map does not take the blank line under it',
    () => {
      const text = '---\nproperties:\n  a: |+\n    x\n  b: 1\n\n---\n';
      const written = updateFrontmatter(text, { properties: { b: 1, a: 'x\n' } });
      expect(read(written)).toEqual({ properties: { b: 1, a: 'x\n' } });
    },
  );

  it.fails('deleting an entry does not write the comment above the next key twice', () => {
    const text = '---\nproperties:\n  k0:\n    k0c0: |3\n  k3:\n# c6\ntail: x\n---\n';
    const written = updateFrontmatter(text, { properties: { k3: null } });
    expect(read(written)).toEqual({ properties: { k3: null }, tail: 'x' });
    expect(commentsOf(written)).toEqual(['# c6']);
  });
});

describe('untouched entries keep the bytes main kept (#736 attack)', () => {
  it.fails('keep-chomped block text keeps its header when the entry after it is deleted', () => {
    const text = '---\nproperties:\n  k3: >1+\n   x\n  k4: |-4\n      y\n\ntail: x\n---\n';
    const written = updateFrontmatter(text, { properties: { k3: 'x\n' } });
    expect(read(written)).toEqual({ properties: { k3: 'x\n' }, tail: 'x' });
    expect(written).toContain('  k3: >1+\n   x\n');
  });

  it.fails('empty keep-chomped block text keeps its header when another entry moves', () => {
    const text = '---\nproperties:\n  k2:\n  k3: >+3\ntail: x\n---\n';
    const written = updateFrontmatter(text, { properties: { k3: '', k2: null } });
    expect(read(written)).toEqual({ properties: { k3: '', k2: null }, tail: 'x' });
    expect(written).toContain('  k3: >+3\n');
  });

  it.fails('a map at four columns stays at four when empty keep-chomped block text moves', () => {
    const text = '---\nproperties:\n    k1:\n    k4: |3+\n---\n';
    const written = updateFrontmatter(text, { properties: { k4: '', k1: null } });
    expect(read(written)).toEqual({ properties: { k4: '', k1: null } });
    expect(written).toContain('\n    k1:\n');
  });
});
