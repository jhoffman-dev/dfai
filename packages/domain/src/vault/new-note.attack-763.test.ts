import { describe, expect, it } from 'vitest';
import { MAX_NAME_BYTES, utf8Bytes } from './file-name-bytes.ts';
import { VAULT_ROOT } from './vault-path.ts';
import { nextAvailableNotePath, noteFileName } from './new-note.ts';

// One grapheme cluster longer than a whole file name: a letter carrying 200
// combining acute accents (2 bytes each), as "zalgo" text pastes arrive.
const ONE_HUGE_GRAPHEME = `e${'́'.repeat(200)}`;

describe('noteFileName on a paste whose first character is longer than a name (#672 attack)', () => {
  it('never names the note with nothing before the extension (a hidden ".md")', () => {
    const name = noteFileName(`${ONE_HUGE_GRAPHEME} rest of the line`);
    expect(name).not.toBe('.md');
    expect(name.startsWith('.')).toBe(false);
    expect(utf8Bytes(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
  });

  it('numbers such a note with a name, not a bare " 2.md"', () => {
    const first = nextAvailableNotePath({
      folder: VAULT_ROOT,
      name: ONE_HUGE_GRAPHEME,
      taken: new Set<string>(),
    });
    const second = nextAvailableNotePath({
      folder: VAULT_ROOT,
      name: ONE_HUGE_GRAPHEME,
      taken: new Set<string>([first]),
    });
    expect(second.startsWith(' ')).toBe(false);
    expect(first.startsWith('.')).toBe(false);
  });
});
