// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { fakeVaultFs } from '@dfai/application';
import { useAddToLibrary } from './use-add-to-library.ts';

/*
 * Adding PDFs or EPUBs when their reader, loaded on the first one added, cannot be loaded
 * (a chunk missing from the build, a disk that failed): said, and the dialog
 * is usable again rather than stuck on "Adding…".
 */

vi.mock('./app-pdf-reader.ts', () => {
  throw new Error('Importing a module script failed.');
});
vi.mock('./app-epub-reader.ts', () => {
  throw new Error('Importing a module script failed.');
});

describe('adding a PDF when the reader cannot be loaded', () => {
  it('says so and stops adding, adding nothing', async () => {
    const onAdded = vi.fn();
    const { result } = renderHook(() =>
      useAddToLibrary({
        kind: 'pdf',
        fs: fakeVaultFs(),
        types: [],
        today: () => '2026-10-22',
        onAdded,
      }),
    );
    await act(() =>
      result.current.add([new File(['%PDF-1.4'], 'lanterns.pdf', { type: 'application/pdf' })]),
    );
    expect(result.current.adding).toBe(false);
    expect(result.current.error).toContain('could not be loaded');
    expect(onAdded).not.toHaveBeenCalled();
  });

  it('says so for the EPUB reader too, naming it', async () => {
    const onAdded = vi.fn();
    const { result } = renderHook(() =>
      useAddToLibrary({
        kind: 'epub',
        fs: fakeVaultFs(),
        types: [],
        today: () => '2026-10-22',
        onAdded,
      }),
    );
    await act(() => result.current.add([new File(['PK'], 'fables.epub')]));
    expect(result.current.adding).toBe(false);
    expect(result.current.error).toContain('The EPUB reader could not be loaded');
    expect(onAdded).not.toHaveBeenCalled();
  });
});
