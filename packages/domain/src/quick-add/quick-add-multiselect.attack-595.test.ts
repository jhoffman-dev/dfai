import { describe, expect, it } from 'vitest';
import type { PropertyDef } from '../types/property-def.ts';
import { listFromInput } from '../types/list-input.ts';
import { quickAddProperties } from './quick-add-note.ts';

/*
 * Attack on PR #595 (#50): a multi-select typed into quick add is stored as
 * the properties panel would store the same line.
 */

const clients: PropertyDef = {
  key: 'clients',
  kind: 'multiSelect',
  label: 'Clients',
  required: false,
  options: [],
  target: null,
  many: false,
};

const stored = (typed: string): unknown =>
  quickAddProperties({ type: { name: 'task' }, fields: [clients], values: { clients: typed } })[
    'clients'
  ];

const TYPED = [
  'Quill',
  'Payroll, Larkspur',
  '"Payroll, Larkspur", Quill',
  ' "Payroll, Larkspur" , "say ""hi""" ',
  '"Payroll, Larkspur',
  '"a"b, c',
  'yes, no, null, ~, 007',
  '"007", "#", "- x"',
  'Ma"ra, Quill',
  'café, café, \u{1F600}',
];

describe('quick add multi-select (attack #595)', () => {
  it('stores what the panel would store for the same line', () => {
    for (const typed of TYPED) {
      expect({ typed, stored: stored(typed) }).toEqual({ typed, stored: listFromInput(typed) });
    }
  });

  it('stores nothing for a line that holds no item, quoted or not', () => {
    for (const typed of ['"', '""', '" "', ', ,', '"", ""']) {
      expect({ typed, stored: stored(typed) }).toEqual({ typed, stored: undefined });
    }
  });
});
