import { describe, expect, it } from 'vitest';
import { assistOwnWords } from './assist-own-words.ts';

/**
 * #909 (rule 6 of #899): what counts as the person's own words in a capture,
 * pinned line by line. Quoted and forwarded text is someone else's.
 */
describe('assistOwnWords', () => {
  it('keeps plain lines as they are', () => {
    expect(assistOwnWords('Call Mara Quill.\n\nAbout the renewal.')).toBe(
      'Call Mara Quill.\n\nAbout the renewal.',
    );
  });

  it('leaves out quoted lines, however indented or nested', () => {
    const text = 'Yes, let us.\n> Lunch with Tobias Fenn?\n  >> tobias@example.com\nThanks';
    expect(assistOwnWords(text)).toBe('Yes, let us.\nThanks');
  });

  it('leaves out the line a mail client puts above a quote', () => {
    const text = 'Agreed.\nOn Tue, 17 Nov 2026, Tobias Fenn <tobias@example.com> wrote:\n> Lunch?';
    expect(assistOwnWords(text)).toBe('Agreed.');
  });

  it('leaves out header lines, in any case', () => {
    const text =
      'TO: Mara Quill\ncc: tobias@example.com\nSubject: Renewal\nSent: today\nDate: Friday\nReply-To: x@example.com\nBcc: y@example.com\nMine.';
    expect(assistOwnWords(text)).toBe('Mine.');
  });

  it('leaves out everything from a forwarded message’s separator to the end', () => {
    for (const separator of [
      '---------- Forwarded message ---------',
      '-----Original Message-----',
      'Begin forwarded message:',
    ]) {
      const text = `Worth a look.\n${separator}\nThe Larkspur team says hello.\nCall Tobias Fenn.`;
      expect(assistOwnWords(text)).toBe('Worth a look.');
    }
  });

  it('leaves out everything from the first From: header to the end, a single header too', () => {
    const text = 'FYI\nFrom: Tobias Fenn <tobias@example.com>\nLunch on Friday with Mara Quill?';
    expect(assistOwnWords(text)).toBe('FYI');
  });

  it('reads CRLF lines as lines', () => {
    expect(assistOwnWords('Mine.\r\n> theirs\r\nMine too.')).toBe('Mine.\nMine too.');
  });

  it('keeps a line that only mentions a header word inside it', () => {
    expect(assistOwnWords('Ask her where it came from: the bank.')).toBe(
      'Ask her where it came from: the bank.',
    );
  });
});
