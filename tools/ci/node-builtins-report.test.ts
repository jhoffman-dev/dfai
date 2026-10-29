import { describe, expect, it } from 'vitest';
import type { NodeBuiltinsReport } from './node-builtins.ts';
import {
  nodeBuiltinsReport,
  ownFileAbove,
  packageOf,
  type ReportPlugin,
} from './node-builtins-report.ts';

const ROOT = '/repo';
const MAIN = '/repo/apps/desktop/src/main.tsx';
const READER = '/repo/packages/adapters/src/vault/reader.ts';
const LIB = '/repo/node_modules/.pnpm/some-lib@1.0.0/node_modules/some-lib/index.js';
const INNER = '/repo/node_modules/.pnpm/some-lib@1.0.0/node_modules/some-lib/inner.js';
const WORKER = '/repo/packages/adapters/src/index/note-derivation.worker.ts';

/** Who imports whom, as the bundler's module info answers it. */
const IMPORTERS: Record<string, string[]> = {
  [INNER]: [LIB],
  [LIB]: [READER],
  [READER]: [MAIN],
  // Vite's stand-in for a built-in, as two modules import it.
  '__vite-browser-external': [MAIN, READER],
};

/** Runs a plugin's `generateBundle` over the chunks given, and returns what it wrote, if anything. */
function bundle(plugin: ReportPlugin, chunks: Record<string, string[]>): NodeBuiltinsReport | null {
  let written: NodeBuiltinsReport | null = null;
  const context = {
    getModuleInfo: (id: string) => ({ importers: IMPORTERS[id] ?? [] }),
    emitFile: (file: { fileName: string; source: string }) => {
      expect(file.fileName).toBe('.vite/node-builtins.json');
      written = JSON.parse(file.source) as NodeBuiltinsReport;
      return 'ref';
    },
  };
  const outputs = Object.fromEntries(
    Object.entries(chunks).map(([fileName, moduleIds]) => [
      fileName,
      { type: 'chunk' as const, fileName, moduleIds },
    ]),
  );
  plugin.generateBundle.call(context, {}, { ...outputs, 'style.css': { type: 'asset' } });
  return written;
}

describe('packageOf', () => {
  it.each([
    [LIB, 'some-lib'],
    ['/repo/node_modules/@tiptap/core/dist/index.js', '@tiptap/core'],
    [MAIN, null],
  ])('reads %s as %s', (id, name) => expect(packageOf(id)).toBe(name));
});

describe('ownFileAbove', () => {
  const importersOf = (id: string) => IMPORTERS[id] ?? [];

  it('is the module itself when it is the app’s own', () => {
    expect(ownFileAbove(READER, importersOf)).toBe(READER);
  });
  it('climbs through a dependency to the app’s file that drew it in', () => {
    expect(ownFileAbove(INNER, importersOf)).toBe(READER);
  });
  it('gives the module back when nothing of the app is above it', () => {
    expect(ownFileAbove(LIB, () => [])).toBe(LIB);
  });
});

describe('nodeBuiltinsReport', () => {
  it('records only built-ins, and leaves every resolution to Vite', () => {
    const { window } = nodeBuiltinsReport(ROOT);
    expect(window.resolveId('node:fs', MAIN)).toBeNull();
    expect(window.resolveId('react', MAIN)).toBeNull();
    expect(window.resolveId('node:fs', undefined)).toBeNull();
    expect(bundle(window, { 'assets/index-A1.js': [MAIN] })?.imports).toEqual([
      {
        module: 'node:fs',
        importer: 'apps/desktop/src/main.tsx',
        pulledInBy: 'apps/desktop/src/main.tsx',
        chunks: ['assets/index-A1.js'],
      },
    ]);
  });

  it('names the app file behind a dependency’s import, and each chunk’s dependencies', () => {
    const { window } = nodeBuiltinsReport(ROOT);
    window.resolveId('crypto', INNER);
    const report = bundle(window, { 'assets/index-A1.js': [MAIN, READER, LIB, INNER] });
    expect(report?.imports[0]).toMatchObject({
      importer: 'node_modules/.pnpm/some-lib@1.0.0/node_modules/some-lib/inner.js',
      pulledInBy: 'packages/adapters/src/vault/reader.ts',
    });
    expect(report?.chunks).toEqual([
      {
        file: 'assets/index-A1.js',
        packages: [{ name: 'some-lib', pulledInBy: 'packages/adapters/src/vault/reader.ts' }],
        named: [],
      },
    ]);
  });

  it('keeps an import the bundler shook out, in no chunk', () => {
    const { window } = nodeBuiltinsReport(ROOT);
    window.resolveId('node:sqlite', READER);
    expect(bundle(window, { 'assets/index-A1.js': [MAIN] })?.imports[0]?.chunks).toEqual([]);
  });

  it('takes the worker’s build into the report the window’s writes, each chunk once', () => {
    const { window, worker } = nodeBuiltinsReport(ROOT);
    worker.resolveId('node:path', WORKER);
    // Vite builds the worker once for each place that starts it.
    expect(bundle(worker, { 'assets/worker-C3.js': [WORKER] })).toBeNull();
    expect(bundle(worker, { 'assets/worker-C3.js': [WORKER] })).toBeNull();
    const report = bundle(window, { 'assets/index-A1.js': [MAIN] });
    expect(report?.imports).toEqual([
      {
        module: 'node:path',
        importer: 'packages/adapters/src/index/note-derivation.worker.ts',
        pulledInBy: 'packages/adapters/src/index/note-derivation.worker.ts',
        chunks: ['assets/worker-C3.js'],
      },
    ]);
    expect(report?.chunks.map((chunk) => chunk.file)).toEqual([
      'assets/worker-C3.js',
      'assets/index-A1.js',
    ]);
  });

  it('records an importer of Vite’s stand-in that no import by name accounts for', () => {
    const { window } = nodeBuiltinsReport(ROOT);
    window.resolveId('node:fs', MAIN);
    const report = bundle(window, {
      'assets/index-A1.js': [MAIN, READER, '__vite-browser-external'],
    });
    expect(report?.imports).toEqual([
      {
        module: 'node:fs',
        importer: 'apps/desktop/src/main.tsx',
        pulledInBy: 'apps/desktop/src/main.tsx',
        chunks: ['assets/index-A1.js'],
      },
      {
        module: '__vite-browser-external',
        importer: 'packages/adapters/src/vault/reader.ts',
        pulledInBy: 'packages/adapters/src/vault/reader.ts',
        chunks: ['assets/index-A1.js'],
      },
    ]);
  });

  it('records what each module’s rendered code names, for the check to say whose a name is', () => {
    const { window } = nodeBuiltinsReport(ROOT);
    let written: NodeBuiltinsReport | null = null;
    const context = {
      getModuleInfo: () => ({ importers: [] }),
      emitFile: (file: { source: string }) => {
        written = JSON.parse(file.source) as NodeBuiltinsReport;
        return 'ref';
      },
    };
    const modules = {
      [LIB]: {
        code: 'process.getBuiltinModule(`fs`);require("os");process.getBuiltinModule(`fs`);',
      },
      [MAIN]: { code: 'console.warn(1);' },
      [INNER]: { code: null },
    };
    window.generateBundle.call(
      context,
      {},
      {
        'assets/index-A1.js': {
          type: 'chunk',
          fileName: 'assets/index-A1.js',
          moduleIds: Object.keys(modules),
          modules,
        },
      },
    );
    expect(written!.chunks[0]?.named).toEqual([
      {
        module: 'node_modules/.pnpm/some-lib@1.0.0/node_modules/some-lib/index.js',
        package: 'some-lib',
        builtins: ['fs', 'os', 'fs'],
      },
    ]);
  });
});
