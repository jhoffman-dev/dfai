import { describe, expect, it } from 'vitest';
import { listAsInput, listFromInput } from './list-input.ts';

/*
 * Attack on PR #595 (#50): over seeded lists of awkward strings, the box's
 * line reads back as the list it was made from — trimmed and with blanks
 * dropped, as listFromInput promises, and with nothing else changed.
 */

const SEEDS = 2000;

/** mulberry32: a small seeded generator, so a failing seed can be replayed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  ',',
  '"',
  '""',
  ' ',
  '  ',
  '\t',
  '\n',
  '\r\n',
  '',
  'a',
  'Quill',
  'Mara',
  'Payroll, Larkspur',
  '[[Larkspur Payroll, Inc.]]',
  'é',
  'é',
  '\u{1F600}',
  '\u{1F469}‍\u{1F467}',
  '‏',
  '‎',
  ' ',
  '﻿',
  'שלום',
  ', ',
  ' ,',
  '"x"',
  'yes',
  '007',
  '#',
  ': ',
  '- ',
  '[',
  '{',
];

function randomItem(next: () => number): string {
  const length = Math.floor(next() * 5);
  let item = '';
  for (let i = 0; i < length; i += 1) item += PIECES[Math.floor(next() * PIECES.length)];
  return item;
}

function randomList(seed: number): string[] {
  const next = seededRandom(seed);
  return Array.from({ length: Math.floor(next() * 6) }, () => randomItem(next));
}

const promised = (items: readonly string[]): string[] =>
  items.map((item) => item.trim()).filter((item) => item !== '');

describe('the list codec over seeded lists (attack #595)', () => {
  it('reads back every list it shows, trimmed and without blanks, and nothing else changed', () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const items = randomList(seed);
      expect({ seed, read: listFromInput(listAsInput(items)) }).toEqual({
        seed,
        read: promised(items),
      });
    }
  });

  it('is stable: showing what it read gives the same line again', () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const once = listAsInput(listFromInput(listAsInput(randomList(seed))));
      expect({ seed, line: listAsInput(listFromInput(once)) }).toEqual({ seed, line: once });
    }
  });

  it('keeps NFC and NFD spellings apart, and keeps direction marks inside an item', () => {
    const items = ['café', 'café', 'a‏b', 'x‎y, z'];
    expect(listFromInput(listAsInput(items))).toEqual(items);
  });
});
