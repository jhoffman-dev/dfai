import { describe, expect, it } from 'vitest';
import { TITLE_WORDS_MAX, titleLikeness } from './task-similarity.ts';

/**
 * Second attack on #906 (PR #907). The cost cap reads only the first
 * {@link TITLE_WORDS_MAX} words, so two long titles that differ after them
 * are called the same title, the one likeness a duplicate is planned on.
 */

describe('attack2-907: the word cap never makes two titles the same', () => {
  it('does not call titles that differ after the cap the same title', () => {
    const shared = Array.from({ length: TITLE_WORDS_MAX }, (_, at) => `clause${at}`).join(' ');
    expect(titleLikeness(`${shared} pay Mara`, `${shared} cancel Tobias`)).not.toBe('same-title');
  });
});
