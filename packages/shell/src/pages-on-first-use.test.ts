import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { preloadAll } from './pages-on-first-use.ts';

describe('preloadAll', () => {
  afterEach(() => vi.restoreAllMocks());

  it('runs every preload, and warns of each that fails without stopping the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ran: string[] = [];
    const fine = (name: string) => () => {
      ran.push(name);
      return Promise.resolve();
    };
    const broken = new Error('chunk missing');
    await expect(
      preloadAll([fine('graph'), () => Promise.reject(broken), fine('terms')]),
    ).resolves.toBeUndefined();
    expect(ran).toEqual(['graph', 'terms']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('A part of DFAI could not preload:', broken);
  });

  it('warns of nothing when every preload succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await preloadAll([() => Promise.resolve()]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the chunks the parts come from', () => {
  // The build names a chunk after the file it is imported from, and writes it into
  // index.html by that name (`chunkFilesMeta` in vite.config.ts); a fresh copy of a
  // chunk is found by it (`chunk-files.ts`). A name that drifts from its file finds none.
  const source = readFileSync(new URL('./pages-on-first-use.ts', import.meta.url), 'utf8');
  const chunks = [...source.matchAll(/chunk\(\s*'([^']+)',[^;]*?import\('([^']+)'\)/g)];

  it('are each named after the file they import, as the build names them', () => {
    expect(chunks.length).toBeGreaterThan(0);
    for (const [, name, file] of chunks) {
      expect(name).toBe(basename(file ?? '', extname(file ?? '')));
    }
  });

  it('are every import the parts are loaded from', () => {
    const imports = source.match(/=> import\('/g) ?? [];
    expect(chunks).toHaveLength(imports.length);
  });
});
