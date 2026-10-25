import { describe, expect, it } from 'vitest';
import { driveRetryDelay } from './index.ts';

describe('driveRetryDelay (#502)', () => {
  it('waits longer each time Google says to slow down or fails on its side, three times', () => {
    for (const status of [429, 500, 503]) {
      expect([1, 2, 3, 4].map((attempt) => driveRetryDelay({ attempt, status }))).toEqual([
        1_000,
        2_000,
        4_000,
        null,
      ]);
    }
  });

  it('never tries again what another try would not change', () => {
    for (const status of [400, 401, 403, 404, 413, null]) {
      expect(driveRetryDelay({ attempt: 1, status })).toBeNull();
    }
  });
});
