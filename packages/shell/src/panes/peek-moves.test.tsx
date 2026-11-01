// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import type { OpenNoteState } from '@dfai/application';
import { createOverlayStore, openPeek, peekNow } from '../overlay-store.ts';
import { leavePeek, leavingPeek, useHoldersFlushed } from './peek-moves.ts';

const NOTE = createVaultPath('Tasks/a.md');

/** A write the test lets land when it chooses. */
function heldWrite() {
  let land = () => {};
  const flush = vi.fn(() => new Promise<void>((resolve) => (land = resolve)));
  return { flush, land: () => land() };
}

describe('leavePeek', () => {
  it('writes what was typed, then closes the peek, then acts, in that order', async () => {
    const overlays = createOverlayStore();
    openPeek(overlays, { path: NOTE, from: null });
    const write = heldWrite();
    const act = vi.fn(() => expect(peekNow(overlays)).toBeNull());
    leavePeek(overlays, { flush: write.flush, act });
    expect(act).not.toHaveBeenCalled();
    expect(peekNow(overlays)).not.toBeNull();
    write.land();
    await vi.waitFor(() => expect(act).toHaveBeenCalledTimes(1));
    expect(leavingPeek(overlays)).toBe(false);
  });

  it('acts once for a second press while the write is still under way', async () => {
    const overlays = createOverlayStore();
    openPeek(overlays, { path: NOTE, from: null });
    const write = heldWrite();
    const first = vi.fn();
    const second = vi.fn();
    leavePeek(overlays, { flush: write.flush, act: first });
    leavePeek(overlays, { flush: write.flush, act: second });
    expect(leavingPeek(overlays)).toBe(true);
    write.land();
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    expect(second).not.toHaveBeenCalled();
    expect(write.flush).toHaveBeenCalledTimes(1);
  });

  it('acts at once with no peek up', () => {
    const overlays = createOverlayStore();
    const flush = vi.fn(async () => {});
    const act = vi.fn();
    leavePeek(overlays, { flush, act });
    expect(act).toHaveBeenCalledTimes(1);
    expect(flush).not.toHaveBeenCalled();
  });
});

describe('useHoldersFlushed', () => {
  const editorsWith = (state: OpenNoteState) => {
    const write = heldWrite();
    return {
      write,
      editors: { stateOf: () => state, flushHolding: write.flush },
    };
  };

  it('is ready at once when no pane holds the note with unsaved typing', () => {
    const { editors, write } = editorsWith('clean');
    const { result } = renderHook(() => useHoldersFlushed(editors, NOTE));
    expect(result.current).toBe(true);
    expect(write.flush).not.toHaveBeenCalled();
  });

  it('waits for a pane’s unsaved typing to be written first, then reads', async () => {
    const { editors, write } = editorsWith('dirty');
    const { result } = renderHook(() => useHoldersFlushed(editors, NOTE));
    expect(result.current).toBe(false);
    expect(write.flush).toHaveBeenCalledWith([NOTE]);
    await act(async () => write.land());
    expect(result.current).toBe(true);
  });

  it('stays ready once the peek’s own typing makes the note unsaved', () => {
    let state: OpenNoteState = 'clean';
    const editors = { stateOf: () => state, flushHolding: vi.fn(async () => {}) };
    const { result, rerender } = renderHook(() => useHoldersFlushed(editors, NOTE));
    state = 'dirty';
    rerender();
    expect(result.current).toBe(true);
    expect(editors.flushHolding).not.toHaveBeenCalled();
  });
});
