/**
 * Attack on PR #736 (#709): a seeded fuzz of the by-entry frontmatter writer
 * (mulberry32, seed 736, 3,000 cases) against main's writer. Each case below
 * is a minimised failure. The first three wrote a wrong value or a comment
 * twice, on main as well (#739); the rest are regressions where main kept the
 * entry's bytes and the branch rewrote the whole map.
 */
import { describe, expect, it } from 'vitest';
import { Lexer, parse } from 'yaml';
import { updateFrontmatter } from './frontmatter-write.ts';
import { parseFrontmatterProperties } from './frontmatter.ts';

const inner = (frontmatter: string) => frontmatter.replace(/^---\n/, '').replace(/---\n?$/, '');

const read = (frontmatter: string) => parse(inner(frontmatter)) as Record<string, unknown>;

/**
 * As DFAI reads a block: without the newline before the closing `---`
 * (frontmatter.ts, pinned by #454), so a blank line that ends the block is
 * no line of `|+` text. `read` above keeps that newline.
 */
const readAsDfai = (frontmatter: string) => parseFrontmatterProperties(frontmatter);

const commentsOf = (frontmatter: string) =>
  [...new Lexer().lex(inner(frontmatter))].filter((token) => token.startsWith('#'));

describe('values and comments survive a change (#736 attack)', () => {
  // #739: the attack read these two with the closing newline kept, where the
  // blank line ending the block is `a`'s own; DFAI reads the block without
  // it, and so does #454's 'a key added after it' test, which pins case one's
  // bytes. As DFAI reads them, the value stays.
  it('a key added after keep-chomped block text leaves its kept blank line in it', () => {
    const text = '---\na: |+\n  x\n\n---\n';
    const written = updateFrontmatter(text, { b: 1 });
    expect(readAsDfai(written)).toEqual({ ...readAsDfai(text), b: 1 });
  });

  it('keep-chomped block text moved to the end of a map does not take the blank line under it', () => {
    for (const blank of ['', '   ']) {
      const text = `---\nproperties:\n  a: |+\n    x\n  b: 1\n${blank}\n---\n`;
      const written = updateFrontmatter(text, { properties: { b: 1, a: 'x\n' } });
      expect(readAsDfai(written)).toEqual({ properties: { b: 1, a: 'x\n' } });
    }
  });

  it('keep-chomped block text ending the block is written with its blank lines (#739 comment)', () => {
    const changed = updateFrontmatter('---\na: |+\n  x\n\n---\n', { a: 'y\n\n' });
    expect(readAsDfai(changed)).toEqual({ a: 'y\n\n' });
    const added = updateFrontmatter('---\nb: 1\n---\n', { a: 'y\n\n' });
    expect(added).toBe('---\nb: 1\na: |+\n  y\n\n\n---\n');
    expect(readAsDfai(added)).toEqual({ b: 1, a: 'y\n\n' });
  });

  it('deleting an entry does not write the comment above the next key twice', () => {
    const text = '---\nproperties:\n  k0:\n    k0c0: |3\n  k3:\n# c6\ntail: x\n---\n';
    const written = updateFrontmatter(text, { properties: { k3: null } });
    expect(read(written)).toEqual({ properties: { k3: null }, tail: 'x' });
    expect(commentsOf(written)).toEqual(['# c6']);
  });
});

describe('untouched entries keep the bytes main kept (#736 attack)', () => {
  it('keep-chomped block text keeps its header when the entry after it is deleted', () => {
    const text = '---\nproperties:\n  k3: >1+\n   x\n  k4: |-4\n      y\n\ntail: x\n---\n';
    const written = updateFrontmatter(text, { properties: { k3: 'x\n' } });
    expect(read(written)).toEqual({ properties: { k3: 'x\n' }, tail: 'x' });
    expect(written).toContain('  k3: >1+\n   x\n');
  });

  it('empty keep-chomped block text keeps its header when another entry moves', () => {
    const text = '---\nproperties:\n  k2:\n  k3: >+3\ntail: x\n---\n';
    const written = updateFrontmatter(text, { properties: { k3: '', k2: null } });
    expect(read(written)).toEqual({ properties: { k3: '', k2: null }, tail: 'x' });
    expect(written).toContain('  k3: >+3\n');
  });

  it('a map at four columns stays at four when empty keep-chomped block text moves', () => {
    const text = '---\nproperties:\n    k1:\n    k4: |3+\n---\n';
    const written = updateFrontmatter(text, { properties: { k4: '', k1: null } });
    expect(read(written)).toEqual({ properties: { k4: '', k1: null } });
    expect(written).toContain('\n    k1:\n');
  });
});
