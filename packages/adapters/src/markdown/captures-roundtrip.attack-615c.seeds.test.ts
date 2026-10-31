// The third attack on PR #615 is split over four files: between them they run every seed, once.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SEED_PARTS, SEEDS } from './captures-roundtrip-615c.test-support.ts';

const FILE = /^captures-roundtrip\.attack-615c\.seeds-(\d+)\.property\.test\.ts$/;

describe('the seeds of the third attack on PR #615', () => {
  it('are each run by exactly one part, 1 to SEEDS', () => {
    const run = SEED_PARTS.flatMap(({ from, to }) =>
      Array.from({ length: to - from + 1 }, (_, at) => from + at),
    );
    expect(run).toEqual(Array.from({ length: SEEDS }, (_, at) => at + 1));
  });

  it('are split over one file per part, each running its own part', () => {
    const files = readdirSync(import.meta.dirname).filter((name) => FILE.test(name));
    expect(files.map((name) => Number(FILE.exec(name)![1])).sort((a, b) => a - b)).toEqual(
      SEED_PARTS.map((_, at) => at + 1),
    );
    for (const name of files) {
      const part = Number(FILE.exec(name)![1]) - 1;
      const calls = readFileSync(`${import.meta.dirname}/${name}`, 'utf8').match(
        /describeSeeds\([^)]*\)/g,
      );
      expect(calls, name).toEqual([`describeSeeds(SEED_PARTS[${part}])`]);
    }
  });
});
