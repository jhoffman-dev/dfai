import { describe, expect, it } from 'vitest';
import { HOST_CHANGED_ON_DISK, isChangedOnDiskRefusal, VaultAccessError } from './ports.ts';

describe('isChangedOnDiskRefusal', () => {
  it('is the host refusing a write over a file changed since it was read, in its exact words', () => {
    expect(isChangedOnDiskRefusal(new VaultAccessError(HOST_CHANGED_ON_DISK))).toBe(true);
  });

  it('is no other refusal, however close its words', () => {
    expect(isChangedOnDiskRefusal(new VaultAccessError('no such file'))).toBe(false);
    expect(isChangedOnDiskRefusal(new VaultAccessError(`${HOST_CHANGED_ON_DISK}!`))).toBe(false);
    expect(isChangedOnDiskRefusal(new VaultAccessError('changed on disk'))).toBe(false);
  });

  it('is not the words alone, from anything but the host', () => {
    expect(isChangedOnDiskRefusal(new Error(HOST_CHANGED_ON_DISK))).toBe(false);
    expect(isChangedOnDiskRefusal(HOST_CHANGED_ON_DISK)).toBe(false);
  });
});
