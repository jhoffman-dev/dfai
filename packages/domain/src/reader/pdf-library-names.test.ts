import { describe, expect, it } from 'vitest';
import { MAX_NAME_BYTES, utf8Bytes } from '../vault/file-name-bytes.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { areaImageName, libraryFileName } from './pdf-library.ts';

/*
 * Regression tests for the PDF reader (#504, review of PR #515): the names the library gives
 * the files it writes.
 */

/** Room for the ` 9999` a second copy of one name is numbered with. */
const NUMBER_ROOM = utf8Bytes(' 9999');

describe('the name a PDF is copied into the library under', () => {
  it('fits a file name on disk, with room to be numbered, for a long Latin name', () => {
    const name = libraryFileName(`${'The Lantern Keepers of Brightwater '.repeat(10)}.pdf`, 'pdf');
    expect(name.endsWith('.pdf')).toBe(true);
    expect(utf8Bytes(name)).toBeLessThanOrEqual(MAX_NAME_BYTES - NUMBER_ROOM);
  });

  it('fits a file name on disk, with room to be numbered, for a CJK name past 255 bytes', () => {
    // 100 characters of 3 bytes each: 300 bytes, and well under 255 characters.
    const name = libraryFileName(`${'灯台守の物語'.repeat(17)}.pdf`, 'pdf');
    expect(utf8Bytes(name)).toBeLessThanOrEqual(MAX_NAME_BYTES - NUMBER_ROOM);
  });
});

describe("an area's picture is named so the note can embed it", () => {
  it('names the picture of a PDF whose own name holds # [ ] ^ | with none of them', () => {
    // A PDF the person put in the vault themselves: only "Add PDF…" names files safely.
    const name = areaImageName({ file: createVaultPath('Papers/Notes #3 [draft].pdf'), page: 2 });
    expect(name).not.toMatch(/[#^|[\]]/);
  });
});
