import { describe, expect, it } from 'vitest';
import {
  addUsage,
  inputTokens,
  shortTokens,
  sumUsage,
  usageWords,
  type ModelUsage,
} from './model-usage.ts';

const ROUND_ONE: ModelUsage = { input: 900, cacheCreation: 2100, cacheRead: 15_000, output: 640 };
const ROUND_TWO: ModelUsage = { input: 8100, cacheCreation: 0, cacheRead: 15_100, output: 1500 };

describe('addUsage', () => {
  it('adds each count to its own', () => {
    expect(addUsage(ROUND_ONE, ROUND_TWO)).toEqual({
      input: 9000,
      cacheCreation: 2100,
      cacheRead: 30_100,
      output: 2140,
    });
  });

  it('adds the cost when both say one', () => {
    const sum = addUsage({ ...ROUND_ONE, costUsd: 0.25 }, { ...ROUND_TWO, costUsd: 0.5 });
    expect(sum.costUsd).toBeCloseTo(0.75);
  });

  it('leaves the cost out when either does not say one: a part is not the whole', () => {
    expect(addUsage({ ...ROUND_ONE, costUsd: 0.25 }, ROUND_TWO)).not.toHaveProperty('costUsd');
    expect(addUsage(ROUND_ONE, { ...ROUND_TWO, costUsd: 0.5 })).not.toHaveProperty('costUsd');
  });
});

describe('sumUsage', () => {
  it('sums every reading', () => {
    expect(sumUsage([ROUND_ONE, ROUND_TWO, ROUND_ONE])).toEqual(
      addUsage(addUsage(ROUND_ONE, ROUND_TWO), ROUND_ONE),
    );
  });

  it('is unknown when one reading is unknown, never a total too low', () => {
    expect(sumUsage([ROUND_ONE, null, ROUND_TWO])).toBeNull();
  });

  it('is unknown with nothing to sum, never zero', () => {
    expect(sumUsage([])).toBeNull();
  });
});

describe('inputTokens', () => {
  it('counts every token the model read: new, written to the cache and read from it', () => {
    expect(inputTokens(ROUND_ONE)).toBe(18_000);
  });
});

describe('shortTokens', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1000, '1k'],
    [2140, '2.1k'],
    [9950, '10k'],
    [41_200, '41k'],
    [999_499, '999k'],
    [999_500, '1M'],
    [1_250_000, '1.3M'],
    [12_400_000, '12M'],
  ])('says %d as %s', (count, said) => {
    expect(shortTokens(count)).toBe(said);
  });
});

describe('usageWords', () => {
  it('says what was read, how much of it came from the cache, and what was written', () => {
    const usage = { input: 9000, cacheCreation: 2100, cacheRead: 30_100, output: 2140 };
    expect(usageWords(usage)).toBe('41k in (30k cached), 2.1k out');
  });

  it('leaves the cache out when none was read from it', () => {
    expect(usageWords({ input: 1200, cacheCreation: 300, cacheRead: 0, output: 80 })).toBe(
      '1.5k in, 80 out',
    );
  });

  it('says unknown for usage nobody reported', () => {
    expect(usageWords(null)).toBe('usage unknown');
  });
});
