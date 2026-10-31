// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import type { NoteReveal } from '@dfai/ui';
import { useHeldReveal } from './held-reveal.ts';

/*
 * The highlight a reader tab is asked to show (#504, #506). A link to a
 * highlight opens the reader's tab and asks it in the same step, so the ask
 * is there before the tab is first drawn: it must be held from the start,
 * not only when a later ask arrives.
 */

const PATH = createVaultPath('Library/the-lantern-keepers.pdf');

const ask = (id: string, key: number, done = vi.fn()): NoteReveal => ({
  fragment: { kind: 'block', id },
  key,
  done,
});

describe('the highlight a reader tab holds to show', () => {
  it('is the one already asked when the tab is first drawn, and the ask is spent', () => {
    const asked = ask('k3x9q2', 1);
    const { result } = renderHook(() => useHeldReveal(asked, PATH));
    expect(result.current).toEqual({ id: 'k3x9q2', key: 1 });
    expect(asked.done).toHaveBeenCalledTimes(1);
  });

  it('is a later ask, kept after it is spent, until another replaces it', () => {
    const { result, rerender } = renderHook(({ asked }) => useHeldReveal(asked, PATH), {
      initialProps: { asked: null as NoteReveal | null },
    });
    expect(result.current).toBeNull();
    rerender({ asked: ask('a1b2c3', 2) });
    expect(result.current).toEqual({ id: 'a1b2c3', key: 2 });
    rerender({ asked: null });
    expect(result.current).toEqual({ id: 'a1b2c3', key: 2 });
    rerender({ asked: ask('d4e5f6', 3) });
    expect(result.current).toEqual({ id: 'd4e5f6', key: 3 });
  });

  it('is none for an ask of a heading, which a document has none of', () => {
    const heading: NoteReveal = { fragment: { kind: 'heading', heading: 'Goals' }, key: 4 };
    const { result } = renderHook(() => useHeldReveal(heading, PATH));
    expect(result.current).toBeNull();
  });

  it('is a page for an ask of `page=3`, a page a document has', () => {
    const page: NoteReveal = { fragment: { kind: 'heading', heading: 'page=3' }, key: 5 };
    const { result } = renderHook(() => useHeldReveal(page, PATH));
    expect(result.current).toEqual({ page: 3, key: 5 });
  });

  it('is none for a page that is no number', () => {
    const page: NoteReveal = { fragment: { kind: 'heading', heading: 'page=three' }, key: 6 };
    const { result } = renderHook(() => useHeldReveal(page, PATH));
    expect(result.current).toBeNull();
  });
});
