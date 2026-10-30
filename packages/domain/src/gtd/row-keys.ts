import type { VaultPath } from '../vault/vault-path.ts';

/**
 * What a key does on any triage page's focused row, whatever the row is
 * (#109): move the focus to the row below or above, open the row's note, or
 * take back the page's last change. What a key does to the row itself is
 * each page's own (`triageActionOf`, `todayKeyActionOf`).
 */
export type RowKey = 'next' | 'previous' | 'open' | 'undo';

/** A key as it was pressed: its name, and the modifiers held. */
export interface KeyPress {
  readonly key: string;
  /** ⌘ on a Mac, or Ctrl. */
  readonly mod: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

/** The named keys, which Shift turns into another act: ⇧↓ extends a selection. */
const NAMED: Readonly<Record<string, RowKey>> = {
  ArrowDown: 'next',
  ArrowUp: 'previous',
  Enter: 'open',
};

/** The letters, read whatever their case — as the pages' own letters are. */
const LETTERS: Readonly<Record<string, RowKey>> = { j: 'next', k: 'previous', u: 'undo' };

/**
 * The row key a press stands for, or null when it is not one. Letters are
 * read whatever their case, so Caps Lock or Shift held is still the letter,
 * as every triage page's own letters are (`triageActionOf`,
 * `todayKeyActionOf`). Shift turns a named key into another act, so ⇧↓ and
 * ⇧↵ are not row keys. ⌘Z undoes as U does; any other chord belongs to the
 * app or the browser — ⇧⌘Z is redo.
 */
export function rowKeyOf({ key, mod, alt, shift }: KeyPress): RowKey | null {
  if (alt) return null;
  const letter = key.length === 1 ? key.toLowerCase() : null;
  if (mod) return letter === 'z' && !shift ? 'undo' : null;
  if (letter !== null) return LETTERS[letter] ?? null;
  return shift ? null : (NAMED[key] ?? null);
}

/**
 * The row a move lands on: the one below or above `from` in `order`, or null
 * at the edge, where the focus stays. A row no longer listed moves to the
 * first, so the keys always find their way back onto the list.
 */
export function rowAfterStep({
  order,
  from,
  step,
}: {
  order: readonly VaultPath[];
  from: VaultPath;
  step: 'next' | 'previous';
}): VaultPath | null {
  const at = order.indexOf(from);
  if (at === -1) return order[0] ?? null;
  return order[at + (step === 'next' ? 1 : -1)] ?? null;
}
