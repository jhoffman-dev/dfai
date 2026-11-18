/** Attack on #911: what counts as the person's own words. All names are made up. */
import { describe, expect, it } from 'vitest';
import { assistOwnWords } from './assist-own-words.ts';

describe('assistOwnWords (attack #911)', () => {
  it('leaves out a quote attribution a mail client wrapped onto two lines', () => {
    const text = [
      'Sounds good, will do.',
      '',
      'On Tue, Nov 17, 2026 at 9:02 AM Tobias Fenn <tobias.fenn@example.com>',
      'wrote:',
      '> Can you renew the Larkspur contract?',
    ].join('\n');
    expect(assistOwnWords(text)).not.toContain('tobias.fenn@example.com');
  });
});
