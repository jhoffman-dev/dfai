import { useEffect, useState } from 'react';
import type { VaultPath } from '@dfai/domain';
import type { NoteReveal, ReaderReveal } from '@dfai/ui';

/**
 * The last highlight or page the tab was asked to show in the document at
 * `path`, held here once the ask is spent: the reader may still be loading,
 * or its highlights still being placed, and shows it when it can. It is the
 * document's own: a tab that moves on to another PDF drops it, and coming
 * back does not bring it again.
 */
export function useHeldReveal(asked: NoteReveal | null, path: VaultPath): ReaderReveal | null {
  // An ask made as the tab opened — a link to a highlight — is held from the first draw.
  const [held, setHeld] = useState<Held>(() => ({ path, reveal: heldOf(asked) }));
  const [seen, setSeen] = useState(asked);
  if (held.path !== path) setHeld({ path, reveal: null });
  if (asked !== seen) {
    setSeen(asked);
    const next = heldOf(asked);
    if (next !== null) setHeld({ path, reveal: next });
  }
  // Spent once held, so the tab opened on this file again later is not brought there again.
  useEffect(() => asked?.done?.(), [asked]);
  return held.path === path ? held.reveal : null;
}

interface Held {
  readonly path: VaultPath;
  readonly reveal: ReaderReveal | null;
}

/** `[[file.pdf#page=3]]` asks for page 3. */
const PAGE_FRAGMENT = /^page=(\d+)$/;

function heldOf(asked: NoteReveal | null): ReaderReveal | null {
  const fragment = asked?.fragment;
  if (asked === null || fragment === undefined) return null;
  const key = Number(asked.key);
  if (fragment.kind === 'block') return { id: fragment.id, key };
  const page = PAGE_FRAGMENT.exec(fragment.heading)?.[1];
  return page === undefined ? null : { page: Number(page), key };
}
