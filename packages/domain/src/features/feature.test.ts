import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import type { NavigationPlace } from '../panes/navigation-history.ts';
import {
  EVERY_FEATURE_ON,
  featureById,
  featureOfPlace,
  FEATURES,
  featuresOffAfter,
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
    expect(featuresOn(['reading']).reading).toBe(false);
  });

  // A registry of its own: DFAI's has nothing that requires another yet (slice 1 of #901).
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

  it('takes out a feature switched on', () => {
    expect(featuresOffAfter(['reading'], { id: 'reading', on: true })).toEqual([]);
    expect(featuresOffAfter([], { id: 'reading', on: true })).toEqual([]);
  });
});

describe('featureOfPlace', () => {
  const pdf = createVaultPath('Library/The Lantern Keepers.pdf');

  it("names Reading for the Library, All highlights and a document's reader", () => {
    const places: NavigationPlace[] = [
      { kind: 'library' },
      { kind: 'highlights' },
      { kind: 'document', path: pdf },
    ];
    expect(places.map(featureOfPlace)).toEqual(['reading', 'reading', 'reading']);
  });

  it('names no feature for a note, even one beside a PDF, or for pages no switch hides', () => {
    const places: NavigationPlace[] = [
      { kind: 'note', path: createVaultPath('Library/The Lantern Keepers.md') },
      { kind: 'today' },
      { kind: 'inbox' },
      { kind: 'tags', tag: null },
    ];
    expect(places.map(featureOfPlace)).toEqual([null, null, null, null]);
  });
});
