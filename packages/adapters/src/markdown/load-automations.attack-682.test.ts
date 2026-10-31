/**
 * Attack on PR #682 (#679): a file in the rules folder is either loaded as a
 * rule or listed as broken, never silently dropped, through the real YAML
 * port. The `it.fails` cases are files that still vanish without a word.
 */
import { describe, expect, it } from 'vitest';
import { apiFixture, listVaultNotes, loadAutomations } from '@dfai/application';
import { remarkMarkdown } from './markdown-port.ts';

const VALID = [
  '---',
  'atlas: automation',
  'name: Tidy',
  'when: manually',
  'which: FROM task',
  'do: archive',
  '---',
  '',
].join('\n');

async function listingOf(files: Record<string, string>) {
  const { fs } = apiFixture({ files, markdown: remarkMarkdown });
  const notePaths = await listVaultNotes({ fs });
  return loadAutomations({ fs, markdown: remarkMarkdown, notePaths });
}

/** Every rules-folder file is accounted for: loaded or broken, never neither. */
async function accountedFor(path: string, text: string) {
  const listing = await listingOf({ [path]: text, '.atlas/automations/Tidy.md': VALID });
  expect(listing.automations.map(({ rule }) => rule.name)).toEqual(['Tidy']);
  return listing.broken.map((broken) => broken.path);
}

describe('loadAutomations through the real YAML port (attack #682)', () => {
  it.fails(
    'a rule file whose closing fence was deleted is listed as broken, not dropped',
    async () => {
      const path = '.atlas/automations/Digest.md';
      const text = ['---', 'atlas: automation', 'name: Digest', 'when: manually', '', 'Body.', ''];
      expect(await accountedFor(path, text.join('\n'))).toEqual([path]);
    },
  );

  it.fails(
    'a rule file whose readable frontmatter is a list, not a mapping, is listed as broken',
    async () => {
      const path = '.atlas/automations/Digest.md';
      const text = ['---', '- atlas: automation', '  name: Digest', '---', ''].join('\n');
      expect(await accountedFor(path, text)).toEqual([path]);
    },
  );

  it.fails('a rule file whose readable frontmatter is one scalar is listed as broken', async () => {
    const path = '.atlas/automations/Digest.md';
    const text = ['---', 'atlas automation', '---', ''].join('\n');
    expect(await accountedFor(path, text)).toEqual([path]);
  });

  // Guards for what the fix gets right; each was probed and holds.
  it('an alias bomb is listed as broken quickly and the rule beside it loads', async () => {
    const levels = ['a: &a [x,x,x,x,x,x,x,x,x]'];
    for (const [i, name] of ['b', 'c', 'd', 'e', 'f'].entries()) {
      const prev = 'abcde'[i] ?? 'a';
      levels.push(`${name}: &${name} [${Array(9).fill(`*${prev}`).join(',')}]`);
    }
    const path = '.atlas/automations/Bomb.md';
    expect(await accountedFor(path, ['---', ...levels, '---', ''].join('\n'))).toEqual([path]);
  });

  it('frontmatter nested past the stack is listed as broken, not thrown out of the listing', async () => {
    const path = '.atlas/automations/Deep.md';
    const deep = `a: ${'['.repeat(20000)}${']'.repeat(20000)}`;
    expect(await accountedFor(path, `---\n${deep}\n---\n`)).toEqual([path]);
  });

  it('a `---` with trailing spaces inside the YAML is the closing fence, so the rule reads', async () => {
    const listing = await listingOf({
      '.atlas/automations/Tidy.md': VALID.replace(/\n---\n$/, '\n---   \n'),
    });
    expect(listing.automations.map(({ rule }) => rule.name)).toEqual(['Tidy']);
    expect(listing.broken).toEqual([]);
  });

  it('a BOM and CRLF rule file loads and is not listed as broken', async () => {
    const listing = await listingOf({
      '.atlas/automations/Tidy.md': `\uFEFF${VALID.replace(/\n/g, '\r\n')}`,
    });
    expect(listing.automations.map(({ rule }) => rule.name)).toEqual(['Tidy']);
    expect(listing.broken).toEqual([]);
  });

  it('a `...` document end inside the block is listed as broken with the parser reason', async () => {
    const path = '.atlas/automations/Two.md';
    const listing = await listingOf({
      [path]: ['---', 'atlas: automation', '...', 'name: Two', '---', ''].join('\n'),
    });
    expect(listing.broken).toEqual([
      {
        path,
        name: 'Two',
        problem: expect.stringMatching(
          /^Its frontmatter is not valid YAML: Source contains multiple documents.*column 1$/,
        ),
      },
    ]);
  });
});
