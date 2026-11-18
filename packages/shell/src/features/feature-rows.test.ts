import { describe, expect, it } from 'vitest';
import { FEATURES } from '@dfai/domain';
import { featureRows } from './feature-rows.ts';

describe('featureRows (#901)', () => {
  it('lists every feature, in the registry order, all on when none is off', () => {
    const rows = featureRows([]);
    expect(rows.map((row) => row.id)).toEqual(FEATURES.map((feature) => feature.id));
    expect(rows.every((row) => row.on && row.needs === null)).toBe(true);
  });

  it('shows Reading off, with its own label and line', () => {
    expect(featureRows(['reading']).find((row) => row.id === 'reading')).toEqual({
      id: 'reading',
      label: 'Reading',
      summary: FEATURES.find((feature) => feature.id === 'reading')?.summary,
      on: false,
      needs: null,
    });
  });
});
