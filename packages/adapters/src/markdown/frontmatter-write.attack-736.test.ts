/**
 * Attack on PR #736 (#709): a seeded fuzz of the by-entry frontmatter writer
 * (mulberry32, seed 736, 3,000 cases) against main's writer. Each case below
 * is a minimised regression: main kept the entry's bytes and the branch
 * rewrote the whole map.
 */
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { updateFrontmatter } from './frontmatter-write.ts';

const inner = (frontmatter: string) => frontmatter.replace(/^---\n/, '').replace(/---\n?$/, '');

const read = (frontmatter: string) => parse(inner(frontmatter)) as Record<string, unknown>;

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
