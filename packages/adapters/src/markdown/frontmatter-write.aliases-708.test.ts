/**
 * #708: a block whose aliases do not resolve — an alias with no anchor, one
 * above its anchor, or a change that would leave one so — is refused with a
 * FrontmatterRefusedError, not the YAML library's own error, and the note's
 * block is handed back unwritten. The writer is string in, string out: a
 * throw means no new block exists for a caller to save, so the file stays.
 */
import { FrontmatterRefusedError } from '@dfai/application';
import { describe, expect, it } from 'vitest';
import { updateFrontmatter } from './frontmatter-write.ts';

const block = (...lines: string[]) => `---\n${lines.join('\n')}\n---\n`;

/** Asserts `change` on `text` is refused on `key`, with the library's error as its cause. */
function expectRefused(text: string, change: Readonly<Record<string, unknown>>, key: string) {
  let thrown: unknown;
  try {
    updateFrontmatter(text, change);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(FrontmatterRefusedError);
  expect((thrown as FrontmatterRefusedError).key).toBe(key);
  expect((thrown as Error).message).toMatch(/cannot be read.*Unresolved alias/);
  expect(((thrown as Error).cause as Error).message).toMatch(/^Unresolved alias/);
}

const ANCHORED = block('title: Old', 'properties:', '  a: &x {kind: t}', '  b: *x');

describe('a block whose aliases do not resolve is refused (#708)', () => {
  it('an alias with no anchor', () => {
    expectRefused(block('x: *nope', 'title: Old'), { title: 'New' }, 'title');
  });

  it('an alias written above its anchor', () => {
    expectRefused(block('b: *x', 'a: &x 1', 'title: Old'), { title: 'New' }, 'title');
  });

  it('moving the alias above its anchor', () => {
    expectRefused(ANCHORED, { properties: { b: { kind: 't' }, a: { kind: 't' } } }, 'properties');
  });

  it('renaming the anchored entry', () => {
    expectRefused(ANCHORED, { properties: { c: { kind: 't' }, b: { kind: 't' } } }, 'properties');
  });

  it('deleting the anchored entry', () => {
    expectRefused(ANCHORED, { properties: { b: { kind: 't' } } }, 'properties');
  });

  it('deleting an anchored nested entry something still aliases', () => {
    const text = block('properties:', '  a:', '    inner: &y {kind: t}', '  b: *y');
    expectRefused(text, { properties: { a: {}, b: { kind: 't' } } }, 'properties');
  });
});

describe('a change that would rename a key aliasing it is refused (#708)', () => {
  it('names the key being changed and keeps its message', () => {
    let thrown: unknown;
    try {
      updateFrontmatter(block('a: &k [1, 2]', '? *k', ': v'), { a: 'x' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FrontmatterRefusedError);
    expect((thrown as FrontmatterRefusedError).key).toBe('a');
    expect((thrown as Error).message).toBe(
      'Cannot change "a": the key "*k" is an alias of it, and would be renamed',
    );
  });
});
