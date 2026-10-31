// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import { fakeVaultFs } from '@dfai/application';
import { useImages, useVaultImages } from './use-images.ts';

/** A vault holding only `files`; any other path cannot be read. */
function vaultWith(...files: string[]) {
  const readBinaryFile = vi.fn(async (path: string) => {
    if (!files.includes(path)) throw new Error(`No such file: ${path}`);
    return new TextEncoder().encode(path).buffer;
  });
  return { fs: fakeVaultFs({ readBinaryFile }), readBinaryFile };
}

afterEach(() => vi.unstubAllGlobals());

describe('useImages', () => {
  it('shows an image from the vault root when the note folder has no such file', async () => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:found',
      revokeObjectURL: () => {},
    });
    const { fs, readBinaryFile } = vaultWith('attachments/x.png');
    const { result } = renderHook(() => useImages({ fs, notePath: createVaultPath('Notes/a.md') }));

    expect(await result.current('attachments/x.png')).toBe('blob:found');
    expect(readBinaryFile.mock.calls.map(([path]) => path)).toEqual([
      'Notes/attachments/x.png',
      'attachments/x.png',
    ]);
  });

  it('shows nothing for an image that is in neither place', async () => {
    const { fs } = vaultWith();
    const { result } = renderHook(() => useImages({ fs, notePath: createVaultPath('Notes/a.md') }));
    expect(await result.current('attachments/x.png')).toBeNull();
  });
});

describe('useVaultImages', () => {
  const note = { path: 'Library/A.md', src: 'https://example.test/cover.jpg' };

  it('hands back an image off the vault as it is, unless it is told to read the vault only', async () => {
    const { fs } = vaultWith();
    const open = renderHook(() => useVaultImages({ fs, resetKey: 'v' }));
    expect(await open.result.current(note)).toBe('https://example.test/cover.jpg');
    const closed = renderHook(() => useVaultImages({ fs, resetKey: 'v', vaultOnly: true }));
    expect(await closed.result.current(note)).toBeNull();
  });

  it('still reads an image the vault holds when it reads the vault only', async () => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:cover',
      revokeObjectURL: () => {},
    });
    const { fs } = vaultWith('Library/covers/a.jpg');
    const { result } = renderHook(() => useVaultImages({ fs, resetKey: 'v', vaultOnly: true }));
    expect(await result.current({ path: 'Library/A.md', src: 'covers/a.jpg' })).toBe('blob:cover');
  });
});
