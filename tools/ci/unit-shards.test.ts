import { describe, expect, it } from 'vitest';
import {
  costOf,
  durationsFromReport,
  filesNotRun,
  filesOfShard,
  FILE_START_S,
  longestFirst,
  partition,
} from './unit-shards.ts';

const FILES = Array.from({ length: 40 }, (_, at) => `packages/p${at % 4}/src/f${at}.test.ts`);
const DURATIONS = {
  'packages/p0/src/f0.test.ts': 290,
  'packages/p1/src/f1.test.ts': 150,
  'packages/p2/src/f2.test.ts': 120,
  'packages/p3/src/f3.test.ts': 110,
  'packages/p0/src/f4.test.ts': 40,
  'packages/p1/src/f5.test.ts': 12.5,
};

const total = (files: readonly string[]) =>
  files.reduce((sum, file) => sum + costOf(file, DURATIONS), 0);

describe('splitting the unit tests over CI machines by duration', () => {
  it('runs every file on exactly one shard', () => {
    for (const count of [1, 2, 3, 5, 6, 7]) {
      const shards = partition(FILES, DURATIONS, count);
      expect(shards).toHaveLength(count);
      expect(shards.flat().sort()).toEqual([...FILES].sort());
    }
  });

  it('runs a file listed twice once', () => {
    expect(partition([...FILES, FILES[0]!], DURATIONS, 3).flat()).toHaveLength(FILES.length);
  });

  it('keeps the slowest files apart and the shards close to even', () => {
    const shards = partition(FILES, DURATIONS, 4);
    const slowest = Object.keys(DURATIONS).slice(0, 4);
    expect(slowest.map((file) => shards.findIndex((shard) => shard.includes(file))).sort()).toEqual(
      [0, 1, 2, 3],
    );
    const costs = shards.map(total);
    // No shard waits on another by more than the slowest file it could have been given instead.
    expect(Math.max(...costs) - Math.min(...costs)).toBeLessThan(290);
    expect(Math.max(...costs)).toBe(costOf('packages/p0/src/f0.test.ts', DURATIONS));
  });

  it('splits alike whatever order the files are listed in', () => {
    const reversed = [...FILES].reverse();
    expect(partition(reversed, DURATIONS, 5)).toEqual(partition(FILES, DURATIONS, 5));
  });

  it('costs a file it has no duration for only the start', () => {
    expect(costOf('packages/new/src/new.test.ts', DURATIONS)).toBe(FILE_START_S);
    expect(costOf('packages/p0/src/f0.test.ts', DURATIONS)).toBe(FILE_START_S + 290);
  });

  it('orders a shard slowest first, equal ones by path', () => {
    expect(
      longestFirst(['b.test.ts', 'packages/p1/src/f1.test.ts', 'a.test.ts'], DURATIONS),
    ).toEqual(['packages/p1/src/f1.test.ts', 'a.test.ts', 'b.test.ts']);
  });

  it('hands shard n of a count the nth part, counted from 1', () => {
    const shards = partition(FILES, DURATIONS, 3);
    expect(filesOfShard(FILES, DURATIONS, { index: 1, count: 3 })).toEqual(shards[0]);
    expect(filesOfShard(FILES, DURATIONS, { index: 3, count: 3 })).toEqual(shards[2]);
  });

  it('refuses a shard that is not one of the count, and a count that is not whole', () => {
    expect(() => filesOfShard(FILES, DURATIONS, { index: 0, count: 3 })).toThrow(/not one of/);
    expect(() => filesOfShard(FILES, DURATIONS, { index: 4, count: 3 })).toThrow(/not one of/);
    expect(() => partition(FILES, DURATIONS, 0)).toThrow(/whole number/);
    expect(() => partition(FILES, DURATIONS, 2.5)).toThrow(/whole number/);
  });
});

describe('recording durations from a run', () => {
  const root = '/home/runner/work/dfai/dfai';

  it('records each file of a second or more by its path from the root, in tenths', () => {
    expect(
      durationsFromReport(
        [
          { name: `${root}/z/slow.test.ts`, startTime: 1_000, endTime: 291_149 },
          { name: `${root}/a/quick.test.ts`, startTime: 0, endTime: 940 },
          { name: `${root}/a/second.test.ts`, startTime: 50, endTime: 1_050 },
        ],
        `${root}/`,
      ),
    ).toEqual({ 'a/second.test.ts': 1, 'z/slow.test.ts': 290.1 });
  });

  it('lists the files by path, so a new record changes only the lines that moved', () => {
    const recorded = durationsFromReport(
      [
        { name: `${root}/b.test.ts`, startTime: 0, endTime: 5_000 },
        { name: `${root}/a.test.ts`, startTime: 0, endTime: 5_000 },
      ],
      root,
    );
    expect(Object.keys(recorded)).toEqual(['a.test.ts', 'b.test.ts']);
  });
});

describe('checking every file ran', () => {
  it('names the listed files no shard reported, and nothing when all ran', () => {
    expect(filesNotRun(['/r/b.test.ts', '/r/a.test.ts', '/r/c.test.ts'], ['/r/b.test.ts'])).toEqual(
      ['/r/a.test.ts', '/r/c.test.ts'],
    );
    expect(filesNotRun(['/r/a.test.ts'], ['/r/a.test.ts', '/r/extra.test.ts'])).toEqual([]);
  });
});
