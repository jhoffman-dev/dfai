import { describe, expect, it } from 'vitest';
import { describeRefusal, isStorageRefusal } from './storage-refusal.ts';

describe('which failures mean the browser refused storage (#761)', () => {
  it.each([
    ['a SecurityError', new DOMException('The request is not allowed.', 'SecurityError')],
    ['an UnknownError', new DOMException('Something went wrong.', 'UnknownError')],
    ['a browser with no OPFS at all', new Error('Missing required OPFS APIs.')],
    ['a refusal from another realm, by its name', { name: 'SecurityError', message: '' }],
  ])('is %s', (_, error) => {
    expect(isStorageRefusal(error)).toBe(true);
  });

  it.each([
    ['another tab holding the file', new DOMException('busy', 'NoModificationAllowedError')],
    ['a full disk', new DOMException('full', 'QuotaExceededError')],
    ['a bug', new TypeError('pool.reserveMinimumCapacity is not a function')],
    ['an error with no name', 'transient'],
    ['nothing', undefined],
  ])('is not %s', (_, error) => {
    expect(isStorageRefusal(error)).toBe(false);
  });
});

describe('what a refusal is said as (#761)', () => {
  it('names the error and keeps its words', () => {
    expect(describeRefusal(new DOMException('Disk fault.', 'UnknownError'))).toBe(
      'UnknownError: Disk fault.',
    );
    expect(describeRefusal(new Error('Missing required OPFS APIs.'))).toBe(
      'Error: Missing required OPFS APIs.',
    );
  });
});
