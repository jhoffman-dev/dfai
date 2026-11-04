import { describe, expect, it } from 'vitest';
import { bundleWorker, serviceWorker, shellVersion, type Bundler } from './service-worker.ts';

const PRECACHE = ['/assets/index-abc.js', '/index.html'];

/** Vite's build as the test stands in for it: records what it was asked, answers one chunk. */
function fakeBundler(code: string | null = 'built worker') {
  const asked: Parameters<Bundler>[0][] = [];
  const bundle: Bundler = async (options) => {
    asked.push(options);
    return [{ output: code === null ? [] : [{ code }] }];
  };
  return { bundle, asked };
}

describe('the shell version (#668)', () => {
  it('is the same for the same files and page, whatever their order', () => {
    expect(shellVersion(PRECACHE, '<html>')).toBe(shellVersion([...PRECACHE].reverse(), '<html>'));
    expect(shellVersion(PRECACHE, '<html>')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when a file changes, and when the page alone changes', () => {
    const was = shellVersion(PRECACHE, '<html>');
    expect(shellVersion(['/assets/index-xyz.js', '/index.html'], '<html>')).not.toBe(was);
    expect(shellVersion(PRECACHE, '<html lang="en">')).not.toBe(was);
  });
});

describe('bundling the worker (#668)', () => {
  it('hands the build the list as JSON and the version as a string, as one IIFE for the target', async () => {
    const { bundle, asked } = fakeBundler();
    const code = await bundleWorker({
      entry: '/src/pwa/service-worker.ts',
      precache: PRECACHE,
      version: 'abc',
      target: 'safari17',
      bundle,
    });
    expect(code).toBe('built worker');
    expect(asked).toHaveLength(1);
    expect(JSON.parse(JSON.parse(asked[0]?.define.__DFAI_PRECACHE__ ?? ''))).toEqual(PRECACHE);
    expect(asked[0]?.define.__DFAI_SHELL_VERSION__).toBe('"abc"');
    expect(asked[0]?.build).toMatchObject({
      target: 'safari17',
      write: false,
      lib: { formats: ['iife'] },
    });
  });

  it('refuses a build that wrote no code rather than emit an empty worker', async () => {
    const { bundle } = fakeBundler(null);
    await expect(
      bundleWorker({ entry: 'x', precache: [], version: 'v', target: 'safari17', bundle }),
    ).rejects.toThrow('wrote no code');
  });
});

describe('the plugin (#668)', () => {
  it('emits sw.js at the root with the hashed assets and the page precached, versioned by them', async () => {
    const { bundle, asked } = fakeBundler();
    const plugin = serviceWorker({ entry: 'entry.ts', target: 'safari17', bundle });
    const emitted: { fileName: string; source: string }[] = [];
    await plugin.generateBundle.call(
      { emitFile: (file) => emitted.push(file) },
      {},
      {
        'index.html': { type: 'asset', source: '<html>' },
        'assets/index-abc.js': { type: 'chunk' },
        'manifest.webmanifest': { type: 'asset', source: '{}' },
      },
    );
    expect(emitted).toEqual([{ type: 'asset', fileName: 'sw.js', source: 'built worker' }]);
    expect(JSON.parse(JSON.parse(asked[0]?.define.__DFAI_PRECACHE__ ?? ''))).toEqual(PRECACHE);
    expect(asked[0]?.define.__DFAI_SHELL_VERSION__).toBe(`"${shellVersion(PRECACHE, '<html>')}"`);
  });

  it('runs only in a build, after Vite’s own plugins, so the page is in the bundle it hashes', () => {
    const plugin = serviceWorker({
      entry: 'entry.ts',
      target: 'safari17',
      bundle: fakeBundler().bundle,
    });
    expect(plugin).toMatchObject({ apply: 'build', enforce: 'post' });
  });
});
