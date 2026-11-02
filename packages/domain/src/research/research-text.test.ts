import { describe, expect, it } from 'vitest';
import {
  byName,
  changedOn,
  countBy,
  foldedWords,
  matchesEvery,
  usesTag,
  withParentTags,
  withToggled,
} from './research-text.ts';

describe('foldedWords and matchesEvery', () => {
  it('folds accents and case and cuts on any space', () => {
    expect(foldedWords('  Zoë\tÉCOLE  ')).toEqual(['zoe', 'ecole']);
    expect(foldedWords('')).toEqual([]);
  });

  it('folds the letters that have no combining mark to the plain ones typed for them', () => {
    expect(foldedWords('Søren Łódź Ærø Straße Đorđe Þór Œuvre')).toEqual([
      'soren',
      'lodz',
      'aero',
      'strasse',
      'dorde',
      'thor',
      'oeuvre',
    ]);
  });

  it('matches when every word is somewhere in the fields, and anything for no words', () => {
    expect(matchesEvery(['zoe', 'quill'], ['Zoë', 'Mara Quill'])).toBe(true);
    expect(matchesEvery(['zoe', 'fenn'], ['Zoë', 'Mara Quill'])).toBe(false);
    expect(matchesEvery([], [])).toBe(true);
  });
});

describe('byName', () => {
  it('reads numbers by value and case aside', () => {
    expect(['Part 10', 'part 2', 'Part 1'].sort(byName)).toEqual(['Part 1', 'part 2', 'Part 10']);
    expect(byName('abc', 'ABD')).toBeLessThan(0);
  });

  it('tells two names the collator reads as one apart, the same either way round', () => {
    expect(Math.sign(byName('Resume', 'Résumé'))).toBe(-Math.sign(byName('Résumé', 'Resume')));
    expect(byName('Resume', 'Résumé')).not.toBe(0);
    expect(byName('same', 'same')).toBe(0);
  });
});

describe('countBy', () => {
  it('counts an item once per value however often it gives it', () => {
    expect(countBy(['a b b', 'b'], (text) => text.split(' '))).toEqual(
      new Map([
        ['a', 1],
        ['b', 2],
      ]),
    );
  });
});

describe('withToggled', () => {
  it('takes a value out when it is in, puts it at the end when not, and leaves the list as it was', () => {
    const kinds = ['pdf', 'epub'];
    expect(withToggled(kinds, 'pdf')).toEqual(['epub']);
    expect(withToggled(kinds, 'kindle')).toEqual(['pdf', 'epub', 'kindle']);
    expect(kinds).toEqual(['pdf', 'epub']);
  });
});

describe('changedOn', () => {
  it('says the day in UTC, whatever the time', () => {
    expect(changedOn(Date.UTC(2026, 8, 22, 23, 59))).toBe('Tue, Sep 22, 2026');
    expect(changedOn(Date.UTC(2026, 8, 23, 0, 0))).toBe('Wed, Sep 23, 2026');
  });

  it('says the epoch for a time that is not one, rather than throwing', () => {
    expect(changedOn(Number.NaN)).toBe('Thu, Jan 1, 1970');
  });
});

describe('usesTag and withParentTags', () => {
  it('counts a nested tag as used under each of its parents, and not a tag that merely starts the same', () => {
    expect(usesTag(['reading/fiction/scifi'], 'reading')).toBe(true);
    expect(usesTag(['reading/fiction/scifi'], 'reading/fiction')).toBe(true);
    expect(usesTag(['reading'], 'reading')).toBe(true);
    expect(usesTag(['readings'], 'reading')).toBe(false);
    expect(usesTag([], 'reading')).toBe(false);
  });

  it('adds every parent of a nested tag, each once', () => {
    expect(withParentTags(['a/b/c', 'a/d', 'e'])).toEqual(['a', 'a/b', 'a/b/c', 'a/d', 'e']);
    expect(withParentTags([])).toEqual([]);
  });
});

describe('changedOn, for a note the index cannot date (ADR-0053)', () => {
  it('says nothing, never the epoch', () => {
    expect(changedOn(null)).toBe('');
  });
});
