import { describe, expect, it } from 'vitest';
import { landedAsRefreshAsked, readAnswers, readyIndexKey } from './read-moment.ts';

/** #260: when a read of the index can stand for a page's own write. */
describe('readAnswers', () => {
  const landed = { at: 3, indexKey: 'ready:7' };

  it('waits while the write has not landed', () => {
    expect(readAnswers(null, { at: 9, indexKey: 'ready:9' })).toBe(false);
  });

  it('waits for a read begun before the write landed, whatever its index', () => {
    expect(readAnswers(landed, { at: 3, indexKey: 'ready:8' })).toBe(false);
    expect(readAnswers(landed, { at: 2, indexKey: 'ready:8' })).toBe(false);
  });

  it('waits for a read begun since, of an index that has not moved since the write (#239)', () => {
    expect(readAnswers(landed, { at: 4, indexKey: 'ready:7' })).toBe(false);
  });

  it('is answered by a read begun since, of an index that has moved', () => {
    expect(readAnswers(landed, { at: 4, indexKey: 'ready:8' })).toBe(true);
  });

  it('waits through an index whose refresh failed, or that is being built, and is answered once it is ready (#698)', () => {
    expect(readAnswers(landed, { at: 4, indexKey: 'failed:8' })).toBe(false);
    expect(readAnswers(landed, { at: 5, indexKey: 'building' })).toBe(false);
    expect(readAnswers(landed, { at: 6, indexKey: 'idle' })).toBe(false);
    expect(readAnswers(landed, { at: 7, indexKey: readyIndexKey(9) })).toBe(true);
  });

  it('is answered by a ready index past a write that landed while the index had failed', () => {
    const atFailure = { at: 3, indexKey: 'failed:7' };
    expect(readAnswers(atFailure, { at: 4, indexKey: 'failed:8' })).toBe(false);
    expect(readAnswers(atFailure, { at: 5, indexKey: 'ready:9' })).toBe(true);
  });
});

/** #698: a write lands as its refresh is asked, at the index's own key then. */
describe('landedAsRefreshAsked', () => {
  it('asks the refresh first, then takes the reads begun and the key as they stand after it', () => {
    const seen: string[] = [];
    const index = { key: 'ready:7', reads: 3 };
    const landed = landedAsRefreshAsked({
      refresh: () => {
        seen.push('refresh');
        // The ask itself moves nothing a read can see; whatever it does is taken after it.
        index.key = 'ready:8';
        index.reads = 4;
      },
      readsBegun: () => {
        seen.push('reads');
        return index.reads;
      },
      indexKeyNow: () => {
        seen.push('key');
        return index.key;
      },
      refreshFailed: () => seen.push('failed'),
    });
    expect(seen).toEqual(['refresh', 'reads', 'key']);
    expect(landed).toEqual({ at: 4, indexKey: 'ready:8' });
  });

  it('is not answered by a read of the key it landed at, only by one of an index moved past it', () => {
    const landed = landedAsRefreshAsked({
      refresh: () => {},
      readsBegun: () => 3,
      indexKeyNow: () => 'ready:8',
      refreshFailed: () => {},
    });
    expect(readAnswers(landed, { at: 4, indexKey: 'ready:8' })).toBe(false);
    expect(readAnswers(landed, { at: 4, indexKey: 'ready:9' })).toBe(true);
  });

  it('still lands a write whose refresh throws as it is asked, at the key after the ask, and says why', () => {
    const seen: string[] = [];
    const failures: unknown[] = [];
    const cause = new Error('the index is closed');
    const landed = landedAsRefreshAsked({
      refresh: () => {
        seen.push('refresh');
        throw cause;
      },
      readsBegun: () => {
        seen.push('reads');
        return 3;
      },
      indexKeyNow: () => {
        seen.push('key');
        return 'ready:8';
      },
      refreshFailed: (why) => {
        seen.push('failed');
        failures.push(why);
      },
    });
    expect(landed).toEqual({ at: 3, indexKey: 'ready:8' });
    expect(seen).toEqual(['refresh', 'reads', 'key', 'failed']);
    expect(failures).toEqual([cause]);
  });
});
