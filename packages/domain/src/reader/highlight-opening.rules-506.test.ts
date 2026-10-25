import { describe, expect, it } from 'vitest';
import type { LiteratureNote } from '../highlights/literature-note.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import { highlightOpening, documentLinkTarget, readerLinkLabel } from './highlight-opening.ts';

/*
 * Regression (#506): where a followed highlight opens, and which PDF
 * `[[…pdf]]` names. Each test is one rule the PR's own tests leave open.
 */

const NOTE = createVaultPath('Library/The Lantern Keepers.md');

const source = (file: VaultPath | null): LiteratureNote => ({
  kind: 'pdf',
  title: 'The Lantern Keepers',
  author: 'Mara Quill',
  file,
  asin: null,
});

describe('a PDF literature note whose file: is no PDF', () => {
  // `file:` is hand-editable; a note saying kind: pdf but naming a Markdown
  // note (or a .pptx) has no file the PDF reader can open.
  const MARKDOWN = createVaultPath('Library/Lantern summary.md');

  it('opens the note at the highlight, not a "reader" on a Markdown file', () => {
    expect(
      highlightOpening({
        note: NOTE,
        blockId: 'k3x9q2',
        literature: { source: source(MARKDOWN), highlightIds: ['k3x9q2'] },
      }),
    ).toEqual({ kind: 'note', note: NOTE, blockId: 'k3x9q2' });
  });

  it('offers no "Open in PDF" for a file that is not a PDF', () => {
    expect(readerLinkLabel(source(MARKDOWN))).toBeNull();
  });
});

describe('[[name.pdf]] when the name alone is ambiguous', () => {
  const FIRST = createVaultPath('Courses/Spring/reading.pdf');
  const SECOND = createVaultPath('Courses/Autumn/reading.pdf');

  it('names one of the PDFs called so, never a vault-root path no file has', () => {
    // Neither literature note's PDF sits at the root, so `reading.pdf` opens
    // a reader on a file that is not there.
    const named = documentLinkTarget('reading.pdf', [FIRST, SECOND]);
    expect([FIRST, SECOND]).toContain(named);
  });
});

describe('[[folder/name.pdf]] written as a trailing part of the path', () => {
  it('names the known PDF whose path ends with what the link writes, as Obsidian does', () => {
    const known = createVaultPath('Library/Courses/reading.pdf');
    expect(documentLinkTarget('Courses/reading.pdf', [known])).toBe(known);
  });
});

/*
 * Verification (#506, PR #522 after 54f53fc3). A name with an accent can be
 * written to disk decomposed (NFD: a file copied from an older Mac disk, a
 * zip, a sync) while the link is typed composed (NFC). Note links already
 * compare both composed (`resolveWikiLinkTarget`); a PDF link must too.
 */

describe('the PDF a link names, by a name with an accent', () => {
  it('is found though the file is written decomposed and the link composed', () => {
    const decomposed = createVaultPath('Reading/Résumé of the keepers.pdf');
    expect(documentLinkTarget('Résumé of the keepers.pdf', [decomposed])).toBe(decomposed);
  });

  it('is found though the file is written composed and the link decomposed', () => {
    const composed = createVaultPath('Reading/Café lanterns.pdf');
    expect(documentLinkTarget('Café lanterns.pdf', [composed])).toBe(composed);
  });
});
