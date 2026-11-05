// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CapturePalette } from './capture-palette.tsx';
import { SearchPalette } from './search-palette.tsx';

/**
 * Adversarial: Enter while an input method is composing belongs to the IME — it
 * commits the characters being composed (Japanese, Chinese, Korean input). It is
 * not the palette's Enter. Base UI already waits out a composition before it
 * lets Escape close the dialog (`useDismiss`); the Enter the palettes handle
 * themselves does not.
 *
 * Two shapes of the same key, because engines differ:
 * - Chromium and Firefox: `keydown` with `isComposing: true`.
 * - WebKit (the macOS Tauri webview): `compositionend` fires first, then a
 *   `keydown` for Enter with `keyCode` 229.
 */

const hits = [{ path: 'b.md', title: 'Recipes', snippet: 'sourdough' }];

describe('CapturePalette, while an IME is composing', () => {
  it('does not capture on the Enter that commits a composition', () => {
    const onCapture = vi.fn(async () => ({ captured: true as const }));
    const onClose = vi.fn();
    render(<CapturePalette destination="a Task" onCapture={onCapture} onClose={onClose} />);
    const field = screen.getByRole('textbox', { name: 'What needs doing' });

    fireEvent.compositionStart(field);
    fireEvent.change(field, { target: { value: 'かいもの' } });
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true });

    expect(onCapture).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not capture on the WebKit commit Enter (keyCode 229)', () => {
    const onCapture = vi.fn(async () => ({ captured: true as const }));
    render(<CapturePalette destination="a Task" onCapture={onCapture} onClose={() => {}} />);
    const field = screen.getByRole('textbox', { name: 'What needs doing' });

    fireEvent.compositionStart(field);
    fireEvent.change(field, { target: { value: '買い物' } });
    fireEvent.compositionEnd(field);
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 });

    expect(onCapture).not.toHaveBeenCalled();
  });

  it('still captures on a plain Enter (control)', () => {
    const onCapture = vi.fn(async () => ({ captured: true as const }));
    render(<CapturePalette destination="a Task" onCapture={onCapture} onClose={() => {}} />);
    const field = screen.getByRole('textbox', { name: 'What needs doing' });

    fireEvent.change(field, { target: { value: '買い物' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(onCapture).toHaveBeenCalledWith('買い物');
  });
});

describe('SearchPalette, while an IME is composing', () => {
  const props = {
    query: 'さわ',
    hits,
    selected: 0,
    onQuery: () => {},
    onMove: () => {},
    onClose: () => {},
  };

  it('does not open a result on the Enter that commits a composition', () => {
    const onPick = vi.fn();
    render(<SearchPalette {...props} onPick={onPick} />);
    const field = screen.getByRole('searchbox');

    fireEvent.compositionStart(field);
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true });

    expect(onPick).not.toHaveBeenCalled();
  });

  it('still opens a result on a plain Enter (control)', () => {
    const onPick = vi.fn();
    render(<SearchPalette {...props} onPick={onPick} />);

    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });

    expect(onPick).toHaveBeenCalledWith('b.md');
  });
});
