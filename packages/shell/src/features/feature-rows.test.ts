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

  it('shows Kindle held off by Reading, saying so, without a switch of its own being flipped', () => {
    const rows = featureRows(['reading']);
    expect(rows.find((row) => row.id === 'kindle')).toMatchObject({ on: false, needs: 'Reading' });
    expect(rows.filter((row) => row.needs !== null).map((row) => row.id)).toEqual(['kindle']);
  });

  it('shows Kindle off by its own switch with nothing held, and back on with Reading', () => {
    expect(featureRows(['kindle']).find((row) => row.id === 'kindle')).toMatchObject({
      on: false,
      needs: null,
    });
    expect(featureRows([]).find((row) => row.id === 'kindle')).toMatchObject({
      on: true,
      needs: null,
    });
  });
});
