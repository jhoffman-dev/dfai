/**
 * `bytesFromBase64`: strict base64, with an optional size limit that is
 * judged from the text's length before the text is read through.
 */

import { bytesFromBase64 } from './artifact-upload.ts';

const LIMIT = { bytes: 5, refusal: 'x.bin is too large' };

describe('bytesFromBase64', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['no padding', 'eHl6', 'xyz'],
    ['one =', 'eHk=', 'xy'],
    ['two =', 'eA==', 'x'],
    ['nothing', '', ''],
    ['whitespace and newlines between groups', ' eHl6\neHk=\r\n', 'xyzxy'],
  ])('decodes base64 with %s', (_why, text, decoded) => {
    expect(bytesFromBase64('x.bin', text).toString('utf8')).toBe(decoded);
  });

  it.each([
    ['a length that is not whole groups of four', 'eHl'],
    ['three =', 'eA==='],
    ['= before the end', 'eA=6eHl6'],
    ['a character outside the alphabet', 'eH-6'],
    ['a character past ASCII', 'eHé6'],
  ])('refuses %s', (_why, text) => {
    expect(() => bytesFromBase64('x.bin', text)).toThrow('x.bin: base64 is not valid');
  });

  it('takes bytes exactly at the limit, padding included', () => {
    expect(bytesFromBase64('x.bin', Buffer.from('abcde').toString('base64'), LIMIT)).toHaveLength(
      5,
    );
  });

  it('refuses one byte past the limit with its own refusal', () => {
    const text = Buffer.from('abcdef').toString('base64');
    expect(() => bytesFromBase64('x.bin', text, LIMIT)).toThrow('x.bin is too large');
  });

  it('refuses by size without copying the text to strip its whitespace', () => {
    const replace = vi.spyOn(String.prototype, 'replace');
    const text = 'eHl6\r\n'.repeat(8);

    expect(() => bytesFromBase64('x.bin', text, LIMIT)).toThrow('x.bin is too large');
    // Vitest itself calls replace while it checks; only a call on this text is a copy of it.
    expect(replace.mock.contexts).not.toContain(text);
  });

  it('counts padding before trailing whitespace, taking bytes exactly at the limit', () => {
    expect(bytesFromBase64('x.bin', 'YWJj\nZGU=\n \t', LIMIT).toString('utf8')).toBe('abcde');
  });

  it('refuses megabytes of base64 that are not valid as invalid, rather than overflowing', () => {
    // Whole groups of four, so it is refused by reading every character, not by its length.
    const text = `${'A'.repeat(28 * 1024 * 1024 - 1)}!`;
    expect(() => bytesFromBase64('x.bin', text)).toThrow('x.bin: base64 is not valid');
  });

  it('refuses by size before it looks at the characters', () => {
    expect(() => bytesFromBase64('x.bin', '!!!!!!!!!!!!', LIMIT)).toThrow('x.bin is too large');
  });
});
