import { describe, expect, it } from 'vitest';
import {
  EVERY_FEATURE_ON,
  featureById,
  FEATURES,
  featuresOffAfter,
  featuresOffAsWritten,
  featuresOn,
  isFeatureId,
  parseFeaturesOff,
  type Feature,
} from './feature.ts';

const IDS = FEATURES.map((feature) => feature.id);

describe('FEATURES', () => {
  it('names each feature once, with a label and a one-line summary', () => {
    expect(new Set(IDS).size).toBe(IDS.length);
    for (const feature of FEATURES) {
      expect(feature.label.trim()).not.toBe('');
      expect(feature.summary.trim()).not.toBe('');
      expect(feature.summary).not.toContain('\n');
    }
  });

  it('lists what each feature requires before it, so none can require itself round a loop', () => {
    FEATURES.forEach((feature, place) => {
      for (const required of feature.requires) {
        expect(IDS.slice(0, place)).toContain(required);
      }
    });
  });

  it('has Reading, which needs nothing', () => {
    expect(featureById('reading')).toMatchObject({ label: 'Reading', requires: [] });
  });

  it('has Kindle, which needs Reading, and Ask, Graph and Slack capture, which need nothing', () => {
    expect(featureById('kindle')).toMatchObject({ label: 'Kindle', requires: ['reading'] });
    expect(featureById('ask')).toMatchObject({ label: 'Ask and Claude chat', requires: [] });
    expect(featureById('graph')).toMatchObject({ label: 'Graph', requires: [] });
    expect(featureById('slack')).toMatchObject({ label: 'Slack capture', requires: [] });
  });
});

describe('parseFeaturesOff', () => {
  it('reads absent, null and anything not a list as nothing off', () => {
    for (const value of [undefined, null, 'reading', 3, { reading: true }]) {
      expect(parseFeaturesOff(value)).toEqual([]);
    }
  });

  it('keeps the ids it knows, once each, and ignores the rest', () => {
    expect(parseFeaturesOff(['telepathy', 'reading', 7, null, 'reading'])).toEqual(['reading']);
  });

  it('tells a feature id from anything else', () => {
    expect(isFeatureId('reading')).toBe(true);
    expect(isFeatureId('Reading')).toBe(false);
    expect(isFeatureId(undefined)).toBe(false);
  });
});

describe('featuresOn', () => {
  it('has every feature on when none is switched off', () => {
    expect(EVERY_FEATURE_ON).toEqual(Object.fromEntries(IDS.map((id) => [id, true])));
    expect(featuresOn([])).toEqual(EVERY_FEATURE_ON);
  });

  it('turns off only the feature switched off', () => {
    expect(featuresOn(['graph'])).toEqual({ ...EVERY_FEATURE_ON, graph: false });
    expect(featuresOn(['kindle'])).toEqual({ ...EVERY_FEATURE_ON, kindle: false });
  });

  it('has Kindle off whenever Reading is, whatever the list says of Kindle', () => {
    expect(featuresOn(['reading'])).toEqual({ ...EVERY_FEATURE_ON, reading: false, kindle: false });
    expect(featuresOn(['reading', 'kindle']).kindle).toBe(false);
    expect(featuresOn(['kindle']).reading).toBe(true);
  });

  // A registry of its own, deeper than DFAI's: what `requires` means, all the way down.
  type Id = 'books' | 'shelf' | 'loans' | 'maps';
  const LIBRARY: readonly Feature<Id>[] = [
    { id: 'books', label: 'Books', summary: 'Books.', requires: [] },
    { id: 'shelf', label: 'Shelf', summary: 'A shelf.', requires: ['books'] },
    { id: 'loans', label: 'Loans', summary: 'Loans.', requires: ['shelf'] },
    { id: 'maps', label: 'Maps', summary: 'Maps.', requires: [] },
  ];

  it('turns a feature off with what it requires, and what requires that, all the way down', () => {
    expect(featuresOn<Id>(['books'], LIBRARY)).toEqual({
      books: false,
      shelf: false,
      loans: false,
      maps: true,
    });
  });

  it('leaves what a feature requires on when only the feature is off', () => {
    expect(featuresOn<Id>(['shelf'], LIBRARY)).toEqual({
      books: true,
      shelf: false,
      loans: false,
      maps: true,
    });
  });
});

describe('featuresOffAfter', () => {
  it('adds a feature switched off, once', () => {
    expect(featuresOffAfter([], { id: 'reading', on: false })).toEqual(['reading']);
    expect(featuresOffAfter(['reading'], { id: 'reading', on: false })).toEqual(['reading']);
  });

  it('leaves a feature held off by what it requires out of the list: Reading off writes no Kindle', () => {
    expect(featuresOffAfter([], { id: 'reading', on: false })).toEqual(['reading']);
    expect(featuresOffAfter(['reading'], { id: 'reading', on: true })).toEqual([]);
  });

  it('takes out a feature switched on', () => {
    expect(featuresOffAfter(['reading'], { id: 'reading', on: true })).toEqual([]);
    expect(featuresOffAfter([], { id: 'reading', on: true })).toEqual([]);
  });
});

describe('featuresOffAsWritten', () => {
  it('keeps every entry as written, in order: unknown ids and entries that are not ids', () => {
    const odd = { hand: 'written' };
    expect(featuresOffAsWritten(['somethingNew', 'reading', 7, null, odd, 'later'])).toEqual([
      'somethingNew',
      'reading',
      7,
      null,
      odd,
      'later',
    ]);
  });

  it('flips one id among entries that are not ids and keeps every one of them', () => {
    const written = featuresOffAsWritten([7, 'reading', null, false]);
    expect(featuresOffAfter(written, { id: 'reading', on: true })).toEqual([7, null, false]);
    expect(featuresOffAfter(written, { id: 'graph', on: false })).toEqual([
      7,
      'reading',
      null,
      false,
      'graph',
    ]);
  });

  it('holds nothing to keep in what is not a list', () => {
    for (const value of [undefined, null, 'reading', { reading: true }]) {
      expect(featuresOffAsWritten(value)).toEqual([]);
    }
  });

  it('flips one id and leaves the others where they stand', () => {
    const written = featuresOffAsWritten(['somethingNew', 'reading']);
    expect(featuresOffAfter(written, { id: 'reading', on: true })).toEqual(['somethingNew']);
    expect(featuresOffAfter(['somethingNew'], { id: 'reading', on: false })).toEqual([
      'somethingNew',
      'reading',
    ]);
  });
});
