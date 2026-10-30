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

const PLAIN: Readonly<Record<string, RowKey>> = {
  j: 'next',
  ArrowDown: 'next',
  k: 'previous',
  ArrowUp: 'previous',
  Enter: 'open',
  u: 'undo',
};

/**
 * The row key a press stands for, or null when it is not one. ⌘Z undoes as U
 * does; any other chord belongs to the app or the browser — ⇧⌘Z is redo, and
 * Shift with an arrow extends a selection.
 */
export function rowKeyOf({ key, mod, alt, shift }: KeyPress): RowKey | null {
  if (alt || shift) return null;
  if (mod) return key.toLowerCase() === 'z' ? 'undo' : null;
  return PLAIN[key] ?? null;
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
