// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createVaultPath, type VaultPath } from '@dfai/domain';
import {
  EDITORS_CLOSE_WAIT_MS,
  PANES_WRITE_GAVE_UP,
  SWITCH_WRITE_GAVE_UP,
  useOpenEditors,
  writtenWithin,
  type OpenEditor,
} from './open-editors.ts';

const today = createVaultPath('today.md');
const board = createVaultPath('.atlas/views/Board.md');

/** A pane's editor, with every call recorded. */
function fakeEditor(path: VaultPath, dirty = false) {
  return {
    path,
    setProperties: vi.fn(async () => {}),
    save: vi.fn(),
    flush: vi.fn(async () => {}),
    reload: vi.fn(),
    isDirty: () => dirty,
    repoint: vi.fn(),
    abandon: vi.fn(),
  } satisfies OpenEditor;
}

const editors = () => renderHook(() => useOpenEditors()).result.current;

describe('the panes an app can reach into', () => {
  it('writes properties through the pane that holds the note', async () => {
    const registry = editors();
    const pane = fakeEditor(today);
    registry.register('t0', pane);

    const handled = await registry.setPropertiesIfOpen({
      path: today,
      values: { favorite: true },
    });

    expect(handled).toBe(true);
    expect(pane.setProperties).toHaveBeenCalledWith({ favorite: true });
  });

  it('finds the note in whichever pane holds it, not only the first', async () => {
    const registry = editors();
    const left = fakeEditor(board);
    const right = fakeEditor(today);
    registry.register('t0', left);
    registry.register('t1', right);

    expect(await registry.setPropertiesIfOpen({ path: today, values: { favorite: true } })).toBe(
      true,
    );
    expect(right.setProperties).toHaveBeenCalled();
    expect(left.setProperties).not.toHaveBeenCalled();
  });

  it('says so when no pane holds the note, so the caller writes the file itself', async () => {
    const registry = editors();
    registry.register('t0', fakeEditor(board));

    expect(await registry.setPropertiesIfOpen({ path: today, values: { favorite: true } })).toBe(
      false,
    );
  });

  it('forgets a pane that has gone', async () => {
    const registry = editors();
    const pane = fakeEditor(today);
    registry.register('t0', pane);
    registry.register('t0', null);

    expect(await registry.setPropertiesIfOpen({ path: today, values: { favorite: true } })).toBe(
      false,
    );
    expect(pane.setProperties).not.toHaveBeenCalled();
  });

  it("answers only once the pane's write has landed", async () => {
    const registry = editors();
    let land = () => {};
    const pane = {
      ...fakeEditor(today),
      setProperties: vi.fn(() => new Promise<void>((resolve) => (land = resolve))),
    };
    registry.register('t0', pane);

    let answered = false;
    const asked = registry
      .setPropertiesIfOpen({ path: today, values: { favorite: true } })
      .then(() => (answered = true));

    await Promise.resolve();
    expect(answered).toBe(false);
    land();
    await asked;
    expect(answered).toBe(true);
  });

  it('saves the pane it is asked to save, and no other', () => {
    const registry = editors();
    const left = fakeEditor(board);
    const right = fakeEditor(today);
    registry.register('t0', left);
    registry.register('t1', right);

    registry.savePane('t1');

    expect(right.save).toHaveBeenCalled();
    expect(left.save).not.toHaveBeenCalled();
  });

  it('re-reads the same note in the other pane after one pane writes it', () => {
    const registry = editors();
    const writer = fakeEditor(today);
    const other = fakeEditor(today);
    registry.register('t0', writer);
    registry.register('t1', other);

    registry.reloadOthers({ tabId: 't0', path: today });

    expect(other.reload).toHaveBeenCalled();
    // The pane that wrote already holds the new modification time.
    expect(writer.reload).not.toHaveBeenCalled();
  });

  it('leaves a pane showing a different note alone', () => {
    const registry = editors();
    const other = fakeEditor(board);
    registry.register('t0', fakeEditor(today));
    registry.register('t1', other);

    registry.reloadOthers({ tabId: 't0', path: today });

    expect(other.reload).not.toHaveBeenCalled();
  });

  it('does not throw away unsaved typing to pick up someone else’s write', () => {
    const registry = editors();
    const other = fakeEditor(today, true);
    registry.register('t0', fakeEditor(today));
    registry.register('t1', other);

    registry.reloadOthers({ tabId: 't0', path: today });

    expect(other.reload).not.toHaveBeenCalled();
  });
});

describe('leaving the vault', () => {
  it('writes every pane, and settles only once every write has', async () => {
    const registry = editors();
    let landLeft = () => {};
    const left = fakeEditor(today, true);
    left.flush.mockImplementation(() => new Promise<void>((resolve) => (landLeft = resolve)));
    const right = fakeEditor(board, true);
    registry.register('t0', left);
    registry.register('t1', right);

    let settled = false;
    const flushing = registry.flushAll().then(() => void (settled = true));
    await Promise.resolve();

    expect(left.flush).toHaveBeenCalledOnce();
    expect(right.flush).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    landLeft();
    await flushing;
    expect(settled).toBe(true);
  });

  it('does not reach a pane that has gone away', async () => {
    const registry = editors();
    const gone = fakeEditor(today, true);
    registry.register('t0', gone);
    registry.register('t0', null);

    await registry.flushAll();

    expect(gone.flush).not.toHaveBeenCalled();
  });
});

describe('the panes a move or a delete reaches', () => {
  const plan = createVaultPath('Projects/plan.md');

  it('re-points every pane on a note a folder move carries, and no other', () => {
    const registry = editors();
    const left = fakeEditor(plan);
    const right = fakeEditor(today);
    registry.register('t0', left);
    registry.register('t1', right);

    registry.follow({ from: createVaultPath('Projects'), to: createVaultPath('Archive/Projects') });

    expect(left.repoint).toHaveBeenCalledWith('Archive/Projects/plan.md');
    expect(right.repoint).not.toHaveBeenCalled();
  });

  it('writes the unsaved typing of only the panes holding the notes being moved', async () => {
    const registry = editors();
    const left = fakeEditor(plan, true);
    const right = fakeEditor(today, true);
    registry.register('t0', left);
    registry.register('t1', right);

    await registry.flushHolding([plan]);

    expect(left.flush).toHaveBeenCalledOnce();
    expect(right.flush).not.toHaveBeenCalled();
  });

  it('drops the unsaved edits of only the panes holding deleted notes', () => {
    const registry = editors();
    const left = fakeEditor(plan, true);
    const right = fakeEditor(today, true);
    registry.register('t0', left);
    registry.register('t1', right);

    registry.abandon([plan]);

    expect(left.abandon).toHaveBeenCalledOnce();
    expect(right.abandon).not.toHaveBeenCalled();
  });
});

/*
 * Verification pass 2 on ba80bef2 (#534): a vault switch and a sync wait for
 * every pane's work, a comment's write among it. A write that hangs must not
 * hold either forever: after the same 10 s the window's close waits, they go
 * on, and the person is told; the panes keep their work.
 */
describe('every pane’s work, waited for by a vault switch or a sync', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is waited for no longer than the cap, and saying so', async () => {
    vi.useFakeTimers();
    const onGaveUp = vi.fn();
    let done = false;
    void writtenWithin({ flushAll: () => new Promise<void>(() => {}), onGaveUp })().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(EDITORS_CLOSE_WAIT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(onGaveUp).toHaveBeenCalledTimes(1);
  });

  it('says nothing when the work is written in time', async () => {
    vi.useFakeTimers();
    const onGaveUp = vi.fn();
    await writtenWithin({ flushAll: async () => {}, onGaveUp })();
    await vi.advanceTimersByTimeAsync(EDITORS_CLOSE_WAIT_MS * 2);
    expect(onGaveUp).not.toHaveBeenCalled();
  });

  it('lets a write that fails say so to whoever waited', async () => {
    const failing = writtenWithin({
      flushAll: () => Promise.reject(new Error('The disk is full.')),
      onGaveUp: vi.fn(),
    });
    await expect(failing()).rejects.toThrow('The disk is full.');
  });

  /* Regression (#534, found on f4c54b6b): after a switch the panes are gone, so their work is not "in their panes". */
  it('tells of a switch that stopped waiting without sending the person to panes that are gone', () => {
    expect(SWITCH_WRITE_GAVE_UP).not.toMatch(/in their panes/);
    expect(SWITCH_WRITE_GAVE_UP).toMatch(/kept/);
    expect(PANES_WRITE_GAVE_UP).toMatch(/in their panes/);
  });
});
