import { describe, expect, it } from 'vitest';
import { durationsOf, mergeDurations } from './e2e-shards.ts';

describe('recording what the e2e spec files took', () => {
  it("adds up each file's tests, in seconds to a tenth", () => {
    expect(
      durationsOf([
        { file: 'e2e/inbox.spec.ts', ms: 1_240 },
        { file: 'e2e/archive.spec.ts', ms: 78_000 },
        { file: 'e2e/inbox.spec.ts', ms: 2_330 },
      ]),
    ).toEqual({ 'e2e/archive.spec.ts': 78, 'e2e/inbox.spec.ts': 3.6 });
  });

  it('leaves out a file whose tests took under a second between them', () => {
    expect(
      durationsOf([
        { file: 'e2e/quick.spec.ts', ms: 400 },
        { file: 'e2e/quick.spec.ts', ms: 540 },
        { file: 'e2e/second.spec.ts', ms: 1_000 },
      ]),
    ).toEqual({ 'e2e/second.spec.ts': 1 });
  });

  it('lists the files by path, so a new record changes only the lines that moved', () => {
    const recorded = durationsOf([
      { file: 'e2e/b.spec.ts', ms: 2_000 },
      { file: 'e2e/a.spec.ts', ms: 3_000 },
      { file: 'e2e/c.spec.ts', ms: 1_000 },
    ]);
    expect(Object.keys(recorded)).toEqual(['e2e/a.spec.ts', 'e2e/b.spec.ts', 'e2e/c.spec.ts']);
  });

  it("puts the shards' records together, by path", () => {
    expect(
      mergeDurations([{ 'e2e/z.spec.ts': 4 }, { 'e2e/a.spec.ts': 12.5, 'e2e/m.spec.ts': 2 }]),
    ).toEqual({ 'e2e/a.spec.ts': 12.5, 'e2e/m.spec.ts': 2, 'e2e/z.spec.ts': 4 });
    expect(Object.keys(mergeDurations([{ 'e2e/z.spec.ts': 4 }, { 'e2e/a.spec.ts': 1 }]))).toEqual([
      'e2e/a.spec.ts',
      'e2e/z.spec.ts',
    ]);
  });

  it('keeps the longer time of a file two shards both recorded', () => {
    expect(mergeDurations([{ 'e2e/a.spec.ts': 3 }, { 'e2e/a.spec.ts': 9 }])).toEqual({
      'e2e/a.spec.ts': 9,
    });
    expect(mergeDurations([{ 'e2e/a.spec.ts': 9 }, { 'e2e/a.spec.ts': 3 }])).toEqual({
      'e2e/a.spec.ts': 9,
    });
  });
});
