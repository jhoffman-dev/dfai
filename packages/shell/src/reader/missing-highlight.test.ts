import { describe, expect, it } from 'vitest';
import { missingHighlightNotice } from './missing-highlight.ts';

/*
 * Regression (#506, PR #522 verification): `[[file.pdf#^id]]` whose id the
 * PDF's literature note does not have opened the reader and waited for a
 * highlight that would never be placed, saying nothing.
 */

describe('the notice over a reader asked to show a highlight', () => {
  it('says the highlight was not found once the note is read without it', () => {
    expect(missingHighlightNotice({ id: 'gone99', key: 1 }, ['lamp03'])).toBe(
      "Couldn't find the highlight ^gone99 in this PDF's note.",
    );
  });

  it('says nothing while the note is still being read', () => {
    expect(missingHighlightNotice({ id: 'gone99', key: 1 }, null)).toBeNull();
  });

  it('says nothing when the note has the highlight, though it is not placed yet', () => {
    expect(missingHighlightNotice({ id: 'lamp03', key: 1 }, ['lamp03'])).toBeNull();
  });

  it('says nothing for a page asked, or nothing asked', () => {
    expect(missingHighlightNotice({ page: 4, key: 1 }, [])).toBeNull();
    expect(missingHighlightNotice(null, [])).toBeNull();
  });
});
