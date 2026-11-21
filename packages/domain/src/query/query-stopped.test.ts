import { describe, expect, it } from 'vitest';
import { failureWords, QUERY_STOPPED, QUERY_STOPPED_WORDS } from './query-stopped.ts';

describe('failureWords (#919)', () => {
  it('says a query stopped by the budget in plain words, from either host', () => {
    // The desktop host rejects with SQLite's word; the web host throws it as an Error.
    expect(failureWords(QUERY_STOPPED)).toBe(QUERY_STOPPED_WORDS);
    expect(failureWords(new Error('interrupted'))).toBe(QUERY_STOPPED_WORDS);
  });

  it('tells the person what happened, that nothing is lost, what to try, and to report it', () => {
    expect(QUERY_STOPPED_WORDS).toMatch(/stopped this view/);
    expect(QUERY_STOPPED_WORDS).toMatch(/nothing in your notes is lost/);
    expect(QUERY_STOPPED_WORDS).toMatch(/fewer columns or adding a filter/);
    expect(QUERY_STOPPED_WORDS).toMatch(/report it as a bug/);
    expect(QUERY_STOPPED_WORDS).not.toMatch(/interrupted/);
  });

  it('leaves every other failure as it was said', () => {
    expect(failureWords(new Error('no such column: due'))).toBe('no such column: due');
    expect(failureWords('the index is not open')).toBe('the index is not open');
    expect(failureWords(new Error('interrupted by the user'))).toBe('interrupted by the user');
  });
});
