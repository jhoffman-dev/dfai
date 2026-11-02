import { describe, expect, it } from 'vitest';
import { writtenAt } from './written-at.ts';

/** #720 (ADR-0053): the one reading of a file's time. */
describe('writtenAt', () => {
  it('is the host’s `modified` where the host gives no other time: the desktop’s mtime', () => {
    expect(writtenAt({ modified: 1_761_998_400_000 })).toBe(1_761_998_400_000);
  });

  it('is unknown where the vault says so, whatever its version', () => {
    expect(writtenAt({ modified: 0x9f3a_1c2b_4d5e6, modifiedAt: null })).toBeNull();
  });

  it('is the time the vault gives beside its version', () => {
    expect(writtenAt({ modified: 0x9f3a_1c2b_4d5e6, modifiedAt: 1_000 })).toBe(1_000);
  });
});
