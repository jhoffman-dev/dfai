// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createVaultPath, type VaultPath } from '@dfai/domain';
import { useOpenEditors, type OpenEditor } from './open-editors.ts';
import { movingEditorsIn, openNotesIn } from './open-notes.ts';

/**
 * The panes as the local API sees them: whether a note is open and has typing
 * the file does not, writes through the pane that holds it, and catching up
 * after something outside the panes wrote it.
 */

const call = createVaultPath('Call.md');
const other = createVaultPath('Other.md');

function fakeEditor(path: VaultPath, { dirty = false } = {}) {
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

function panes(...open: OpenEditor[]) {
  const registry = renderHook(() => useOpenEditors()).result.current;
  open.forEach((editor, pane) => registry.register(`t${pane}`, editor));
  return openNotesIn(registry);
}

describe('the open notes, as the API reaches them', () => {
  it('reads a note no pane holds as closed', () => {
    expect(panes(fakeEditor(other)).state(call)).toBe('closed');
  });

  it('reads a note held with nothing unsaved as clean', () => {
    expect(panes(fakeEditor(other), fakeEditor(call)).state(call)).toBe('clean');
  });

  it('reads a note as dirty when any pane holding it has unsaved edits', () => {
    const notes = panes(fakeEditor(call), fakeEditor(call, { dirty: true }));
    expect(notes.state(call)).toBe('dirty');
  });

  it('is not made dirty by unsaved edits to another note', () => {
    const notes = panes(fakeEditor(other, { dirty: true }), fakeEditor(call));
    expect(notes.state(call)).toBe('clean');
  });

  it('writes properties through the pane that holds the note', async () => {
    const pane = fakeEditor(call);
    const notes = panes(pane);

    await expect(
      notes.setPropertiesIfOpen({ path: call, values: { status: 'done' } }),
    ).resolves.toBe(true);
    expect(pane.setProperties).toHaveBeenCalledWith({ status: 'done' });
  });

  it('writes properties through the pane with unsaved edits when two panes hold the note', async () => {
    // Its save carries the typing with the properties; the clean pane then
    // re-reads. Through the clean pane instead, the dirty one's next save
    // would be refused as changed underneath (R15-01).
    const clean = fakeEditor(call);
    const typing = fakeEditor(call, { dirty: true });
    const notes = panes(clean, typing);

    await notes.setPropertiesIfOpen({ path: call, values: { status: 'done' } });

    expect(typing.setProperties).toHaveBeenCalledWith({ status: 'done' });
    expect(clean.setProperties).not.toHaveBeenCalled();
  });

  it('rejects, rather than claiming the write, when the pane refuses its save', async () => {
    const pane = fakeEditor(call);
    pane.setProperties.mockRejectedValue(new Error('the note changed on disk since it was opened'));
    const notes = panes(pane);

    await expect(
      notes.setPropertiesIfOpen({ path: call, values: { status: 'done' } }),
    ).rejects.toThrow('the note changed on disk since it was opened');
  });

  it('answers false when no pane holds the note, so the caller writes the file', async () => {
    const notes = panes(fakeEditor(other));
    await expect(
      notes.setPropertiesIfOpen({ path: call, values: { status: 'done' } }),
    ).resolves.toBe(false);
  });

  it('re-reads the note in every pane that holds it with nothing unsaved', () => {
    const left = fakeEditor(call);
    const right = fakeEditor(call);
    const elsewhere = fakeEditor(other);

    panes(left, right, elsewhere).reload(call);

    expect(left.reload).toHaveBeenCalledOnce();
    expect(right.reload).toHaveBeenCalledOnce();
    expect(elsewhere.reload).not.toHaveBeenCalled();
  });

  it('leaves a pane with unsaved edits alone when re-reading', () => {
    const clean = fakeEditor(call);
    const typing = fakeEditor(call, { dirty: true });

    panes(clean, typing).reload(call);

    expect(clean.reload).toHaveBeenCalledOnce();
    expect(typing.reload).not.toHaveBeenCalled();
  });
});

describe('the panes as a move or a delete reaches them', () => {
  function registry(...open: OpenEditor[]) {
    const editors = renderHook(() => useOpenEditors()).result.current;
    open.forEach((editor, pane) => editors.register(`t${pane}`, editor));
    return editors;
  }

  it('re-points the editors and the layout together on a move', () => {
    const holding = fakeEditor(call);
    const layout = vi.fn();
    const move = { from: call, to: createVaultPath('Archive/Call.md') };

    movingEditorsIn(registry(holding), layout).follow(move);

    expect(holding.repoint).toHaveBeenCalledWith('Archive/Call.md');
    expect(layout).toHaveBeenCalledWith(move);
  });

  it('says which notes have unsaved typing, for the question before a delete', () => {
    const port = movingEditorsIn(registry(fakeEditor(call, { dirty: true })), vi.fn());
    expect(port.state(call)).toBe('dirty');
    expect(port.state(other)).toBe('closed');
  });

  it('flushes and lets go of only the notes it is given', async () => {
    const moving = fakeEditor(call, { dirty: true });
    const staying = fakeEditor(other, { dirty: true });
    const port = movingEditorsIn(registry(moving, staying), vi.fn());

    await port.flush([call]);
    port.abandon([call]);

    expect(moving.flush).toHaveBeenCalledOnce();
    expect(moving.abandon).toHaveBeenCalledOnce();
    expect(staying.flush).not.toHaveBeenCalled();
    expect(staying.abandon).not.toHaveBeenCalled();
  });
});
