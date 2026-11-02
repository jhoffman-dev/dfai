import { describe, expect, it } from 'vitest';
import { HOST_CHANGED_ON_DISK, VaultAccessError } from '../vault/ports.ts';
import { isStaleWriteRefusal, NoteChangedError } from './note-changed-error.ts';

describe('isStaleWriteRefusal', () => {
  it('is a write refused because the note moved on: the host’s refusal, or a changed note', () => {
    expect(isStaleWriteRefusal(new VaultAccessError(HOST_CHANGED_ON_DISK))).toBe(true);
    expect(isStaleWriteRefusal(new NoteChangedError('Plan.md'))).toBe(true);
  });

  it('is a save of a note that was opened and is gone now, as each host says so', () => {
    expect(isStaleWriteRefusal(new VaultAccessError('no such entry'))).toBe(true);
    expect(
      isStaleWriteRefusal(new VaultAccessError('no such entry: No such file (os error 2)')),
    ).toBe(true);
    // Only the host's refusal, not any error that happens to say so.
    expect(isStaleWriteRefusal(new Error('no such entry'))).toBe(false);
  });

  it('is not any other failure, which a conflict copy would not answer', () => {
    expect(isStaleWriteRefusal(new VaultAccessError('GitHub answered 502'))).toBe(false);
    expect(isStaleWriteRefusal(new TypeError('Failed to fetch'))).toBe(false);
  });
});
