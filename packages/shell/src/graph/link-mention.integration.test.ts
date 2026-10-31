import { describe, expect, it } from 'vitest';
import { remarkMarkdown } from '@dfai/adapters';
import { createVaultPath } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, linkUnlinkedMention } from '@dfai/application';

/**
 * Linking a mention through the real markdown parser: the block ranges it
 * reports are what decide where a mention may be, and every byte outside the
 * mention must come back exactly as it was.
 */
async function linkIn(text: string): Promise<string | null> {
  let written: string | null = null;
  const fs = fakeVaultFs({
    readTextFile: async () => ({ text, modified: 3 }),
    writeTextFile: async ({ contents }) => {
      written = contents;
      return 4;
    },
  });
  await linkUnlinkedMention({
    index: fakeIndexPort({
      manifest: async () => [
        { path: 'projects/Atlas.md', modified: 1, size: 1, digest: '', type: null },
      ],
    }),
    fs,
    markdown: remarkMarkdown,
    openNotes: { state: () => 'closed', reload: () => {} },
    source: createVaultPath('source.md'),
    target: { path: createVaultPath('projects/Atlas.md'), title: 'Atlas' },
  });
  return written;
}

const messy = [
  '---',
  'title: "Notes"   ',
  'tags: [a,  b]',
  '---',
  '# Heading  ',
  '',
  '```ts',
  'const Atlas = 1;',
  '```',
  '',
  '|  a  | Atlas |',
  '|---|---|',
  '',
  '> [!note] Atlas callout',
  '',
  '* item one',
  '* uses `Atlas` and [Atlas](x.md) then atlas for real  ',
  '',
  '\t\tTrailing   ',
  '',
].join('\n');

describe('linking a mention, with the real markdown parser', () => {
  it('changes only the mention: frontmatter, code, tables, callouts and spacing stay byte for byte', async () => {
    const written = await linkIn(messy);
    expect(written).toBe(messy.replace('then atlas for real', 'then [[Atlas|atlas]] for real'));
  });

  it('writes nothing when every mention is in code, a table or a callout', async () => {
    const onlyShielded = messy.replace('then atlas for real', 'then nothing');
    expect(await linkIn(onlyShielded)).toBeNull();
  });

  it('keeps a Windows line ending and a missing final newline as they were', async () => {
    const text = 'first line\r\nsee Atlas here\r\nlast';
    expect(await linkIn(text)).toBe('first line\r\nsee [[Atlas]] here\r\nlast');
  });

  it.each([
    ['a tag', 'filed under #Atlas today\n'],
    ['a shortcut reference with no definition', 'see [Atlas] there\n'],
    ['a defined shortcut reference', 'see [Atlas] there\n\n[Atlas]: https://x.dev\n'],
    ['a footnote reference with no definition', 'see [^Atlas] there\n'],
    ['a defined footnote reference', 'see [^Atlas] there\n\n[^Atlas]: a note\n'],
    ['an email address', 'mail atlas@example.com now\n'],
    ['an email autolink', 'mail <atlas@example.com> now\n'],
    ['a path', 'open src/Atlas/x.md now\n'],
    ['inline HTML', 'a <b title="x">Atlas</b> tag\n'],
    ['a link reference definition', '[Atlas]: https://x.dev/Atlas\n'],
  ])('leaves a mention inside %s alone', async (_, text) => {
    expect(await linkIn(text)).toBeNull();
  });

  it('links a plain mention that sits beside markup it must not touch', async () => {
    const text = '#Atlas, [^Atlas], atlas@x.dev, src/Atlas/x.md and then Atlas itself\n';
    expect(await linkIn(text)).toBe(text.replace('then Atlas itself', 'then [[Atlas]] itself'));
  });

  it('links a mention inside emphasis without breaking the emphasis', async () => {
    expect(await linkIn('an *Atlas* day\n')).toBe('an *[[Atlas]]* day\n');
  });
});
