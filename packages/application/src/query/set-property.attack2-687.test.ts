/**
 * Second attack on PR #687 (#683): a note is never refused for a block that
 * opens and never closes — it gets a block of its own on top — so every line
 * it had must still be there, below, and still read as body.
 */
import { splitFrontmatter } from '@dfai/domain';
import { describe, expect, it } from 'vitest';
import { fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import {
  setNoteProperties,
  UnclosedFrontmatterError,
  writeFrontmatterChanges,
} from './set-property.ts';

function vault(text: string) {
  const writes: string[] = [];
  const fs = fakeVaultFs({
    readTextFile: async () => ({ text, modified: 17 }),
    writeTextFile: async ({ contents }) => {
      writes.push(contents);
      return 18;
    },
  });
  return { fs, writes };
}

const BOM = '﻿';
const ODD_NOTES: readonly [string, string][] = [
  ['just ---', '---'],
  ['--- and a newline', '---\n'],
  ['--- with a trailing space', '--- \n'],
  ['a BOM, then ---', `${BOM}---`],
  ['a BOM, then --- and a newline', `${BOM}---\n`],
  ['--- with CRLF and words', '---\r\nwords\r\n'],
  ['--- then a key, no close', '---\nstatus: doing\n'],
];

describe('setNoteProperties keeps every line of a note whose block never closes (attack 2 on #687)', () => {
  for (const [name, text] of ODD_NOTES) {
    it(`keeps the whole of a note that is ${name}, as body under the new block`, async () => {
      const { fs, writes } = vault(text);
      await setNoteProperties({
        today: '2026-10-08',
        fs,
        markdown: fakeMarkdown(),
        path: 'Odd.md',
        values: { status: 'done' },
      });
      const contents = writes[0] ?? '';
      const mark = text.startsWith(BOM) ? BOM : '';
      const split = splitFrontmatter(contents);
      expect(split.frontmatter).not.toBeNull();
      expect(contents.startsWith(mark)).toBe(true);
      expect(split.body).toBe(text.slice(mark.length));
    });
  }

  it('refuses a DFAI file that is a BOM then an unclosed block', async () => {
    const { fs, writes } = vault(`${BOM}---\nname: film\n`);
    await expect(
      writeFrontmatterChanges({
        fs,
        markdown: fakeMarkdown(),
        path: '.atlas/types/film.md',
        values: { label: 'Films' },
      }),
    ).rejects.toThrow(UnclosedFrontmatterError);
    expect(writes).toEqual([]);
  });
});
