import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import { rowAfterStep, rowKeyOf, type KeyPress } from './row-keys.ts';

/** #109: the keys every triage page's focused row answers to, whatever the row is. */

const press = (key: string, held: Partial<KeyPress> = {}): KeyPress => ({
  key,
  mod: false,
  alt: false,
  shift: false,
  ...held,
});

describe('rowKeyOf', () => {
  it('moves down on J and ↓, up on K and ↑', () => {
    expect(rowKeyOf(press('j'))).toBe('next');
    expect(rowKeyOf(press('ArrowDown'))).toBe('next');
    expect(rowKeyOf(press('k'))).toBe('previous');
    expect(rowKeyOf(press('ArrowUp'))).toBe('previous');
  });

  it('opens on Return and undoes on U or ⌘Z', () => {
    expect(rowKeyOf(press('Enter'))).toBe('open');
    expect(rowKeyOf(press('u'))).toBe('undo');
    expect(rowKeyOf(press('z', { mod: true }))).toBe('undo');
    expect(rowKeyOf(press('Z', { mod: true }))).toBe('undo');
  });

  it('leaves every other chord to the app or the browser: ⇧⌘Z, ⌥↓, ⇧↓, ⇧↵, ⌘J, ⌘↵', () => {
    expect(rowKeyOf(press('Enter', { shift: true }))).toBeNull();
    expect(rowKeyOf(press('ArrowUp', { shift: true }))).toBeNull();
    expect(rowKeyOf(press('z', { mod: true, shift: true }))).toBeNull();
    expect(rowKeyOf(press('ArrowDown', { alt: true }))).toBeNull();
    expect(rowKeyOf(press('ArrowDown', { shift: true }))).toBeNull();
    expect(rowKeyOf(press('j', { mod: true }))).toBeNull();
    expect(rowKeyOf(press('Enter', { mod: true }))).toBeNull();
  });

  it('reads a letter whatever its case, as the pages’ own keys do: Caps Lock and Shift are still J, K and U (PR #641 review)', () => {
    expect(rowKeyOf(press('J'))).toBe('next');
    expect(rowKeyOf(press('K', { shift: true }))).toBe('previous');
    expect(rowKeyOf(press('U', { shift: true }))).toBe('undo');
  });

  it('is not a row key otherwise: a plain Z, another letter, Space or Tab', () => {
    for (const key of ['z', 'x', 'n', ' ', 'Tab', 'Escape', '']) {
      expect(rowKeyOf(press(key)), key).toBeNull();
    }
  });
});

describe('rowAfterStep', () => {
  const [a, b, c] = ['a.md', 'b.md', 'c.md'].map(createVaultPath) as [
    ReturnType<typeof createVaultPath>,
    ReturnType<typeof createVaultPath>,
    ReturnType<typeof createVaultPath>,
  ];
  const order = [a, b, c];

  it('lands on the row below or above', () => {
    expect(rowAfterStep({ order, from: b, step: 'next' })).toBe(c);
    expect(rowAfterStep({ order, from: b, step: 'previous' })).toBe(a);
  });

  it('stays at either edge: no wrap from the last row to the first', () => {
    expect(rowAfterStep({ order, from: c, step: 'next' })).toBeNull();
    expect(rowAfterStep({ order, from: a, step: 'previous' })).toBeNull();
  });

  it('goes to the first row from one no longer listed, and nowhere on an empty list', () => {
    expect(rowAfterStep({ order, from: createVaultPath('gone.md'), step: 'previous' })).toBe(a);
    expect(rowAfterStep({ order: [], from: a, step: 'next' })).toBeNull();
  });
});
