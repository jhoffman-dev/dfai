import { describe, expect, it } from 'vitest';
import { describeTauriFinding, tauriInBundle } from './tauri-in-bundle.ts';

describe('Tauri in the web bundle (#656)', () => {
  it('finds each of Tauri’s markers, by the file that carries it', () => {
    const found = tauriInBundle([
      { file: 'assets/index.js', source: 'window.__TAURI_INTERNALS__.invoke("x")' },
      { file: 'assets/ipc.js', source: 'fetch("http://ipc.localhost/read")' },
      { file: 'assets/asset.js', source: 'const u = "tauri://localhost/a.png";' },
      { file: 'assets/plain.js', source: 'export const tauri = "a word, not Tauri’s runtime";' },
    ]);
    expect(found).toEqual([
      { file: 'assets/index.js', marker: '__TAURI' },
      { file: 'assets/ipc.js', marker: 'ipc.localhost' },
      { file: 'assets/asset.js', marker: 'tauri://' },
    ]);
  });

  it('finds nothing in a bundle with no Tauri', () => {
    expect(tauriInBundle([{ file: 'assets/index.js', source: 'export {}' }])).toEqual([]);
  });

  it('names the file and the marker when it fails', () => {
    expect(describeTauriFinding({ file: 'assets/index.js', marker: '__TAURI' })).toContain(
      'assets/index.js carries "__TAURI"',
    );
  });
});
