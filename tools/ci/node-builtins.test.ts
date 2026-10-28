import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KNOWN_NODE_REFERENCES,
  describeNodeBuiltin,
  describeStaleReference,
  isNodePolyfill,
  nodeBuiltinsInBundle,
  staleKnownReferences,
  type KnownNodeReference,
  type NodeBuiltinsReport,
} from './node-builtins.ts';

const CLEAN: NodeBuiltinsReport = {
  imports: [],
  chunks: [
    {
      file: 'assets/index-A1.js',
      packages: [{ name: 'react', pulledInBy: 'apps/desktop/src/main.tsx' }],
    },
  ],
};

/** Minified code that names Node's modules without importing one, as the real bundle does. */
const INNOCENT = 'const t={node:e,depth:0},k=`path`,m="fs";e.from(`x`);a.import(r);';

describe('nodeBuiltinsInBundle', () => {
  it('finds nothing in a clean bundle, even where code names a module without importing it', () => {
    expect(nodeBuiltinsInBundle(CLEAN, [{ file: 'assets/index-A1.js', source: INNOCENT }])).toEqual(
      [],
    );
  });

  it('finds each built-in the build resolved, with its chunks and the file that drew it in', () => {
    const report: NodeBuiltinsReport = {
      ...CLEAN,
      imports: [
        {
          module: 'node:sqlite',
          importer: 'packages/application/src/testing/sqlite-index.ts',
          pulledInBy: 'packages/application/src/testing/sqlite-index.ts',
          chunks: ['assets/index-A1.js'],
        },
      ],
    };
    expect(nodeBuiltinsInBundle(report, [])).toEqual([
      {
        kind: 'import',
        module: 'node:sqlite',
        importer: 'packages/application/src/testing/sqlite-index.ts',
        pulledInBy: 'packages/application/src/testing/sqlite-index.ts',
        chunks: ['assets/index-A1.js'],
      },
    ]);
  });

  it('finds a polyfill of a built-in among a chunk’s dependencies, and nothing else there', () => {
    const report: NodeBuiltinsReport = {
      imports: [],
      chunks: [
        {
          file: 'assets/later-parts-B2.js',
          packages: [
            { name: 'react', pulledInBy: 'apps/desktop/src/main.tsx' },
            { name: 'buffer', pulledInBy: 'packages/domain/src/activity/activity-file.ts' },
          ],
        },
      ],
    };
    expect(nodeBuiltinsInBundle(report, [])).toEqual([
      {
        kind: 'polyfill',
        module: 'buffer',
        chunk: 'assets/later-parts-B2.js',
        pulledInBy: 'packages/domain/src/activity/activity-file.ts',
      },
    ]);
  });

  it.each([
    ['a static import', 'import{readFileSync as e}from"node:fs";', 'node:fs'],
    ['a bare name', "import { join } from 'path';", 'path'],
    ['a subpath', 'const f=await import(`fs/promises`);', 'fs/promises'],
    ['a side-effect import', 'import"crypto";', 'crypto'],
    ['a require', 'var c=require("child_process");', 'child_process'],
    [
      'Node’s run-time lookup',
      'const{DatabaseSync:e}=process.getBuiltinModule(`node:sqlite`);',
      'node:sqlite',
    ],
  ])('finds %s left in a chunk for the runtime to load', (_case, source, module) => {
    expect(nodeBuiltinsInBundle(CLEAN, [{ file: 'assets/index-A1.js', source }])).toEqual([
      { kind: 'external', module, chunk: 'assets/index-A1.js' },
    ]);
  });

  it('names each module left in a chunk once, however often it is imported', () => {
    const source = 'import"node:fs";import"node:fs";require("os")';
    const found = nodeBuiltinsInBundle(CLEAN, [{ file: 'assets/a.js', source }]);
    expect(found.map((f) => f.module)).toEqual(['node:fs', 'os']);
  });
});

describe('isNodePolyfill', () => {
  it.each(['buffer', 'process', 'events', 'path-browserify', 'node-stdlib-browser'])(
    'counts %s',
    (name) => expect(isNodePolyfill(name)).toBe(true),
  );
  it.each(['react', '@tiptap/core', 'pathe', 'yaml'])('does not count %s', (name) =>
    expect(isNodePolyfill(name)).toBe(false),
  );
});

describe('describeNodeBuiltin', () => {
  it('names the module, the chunk, the importer and the app file behind it', () => {
    const message = describeNodeBuiltin({
      kind: 'import',
      module: 'fs',
      importer: 'node_modules/some-lib/index.js',
      pulledInBy: 'packages/adapters/src/vault/reader.ts',
      chunks: ['assets/index-A1.js'],
    });
    expect(message).toContain(
      'fs is imported by node_modules/some-lib/index.js, pulled in by packages/adapters/src/vault/reader.ts (in assets/index-A1.js)',
    );
  });

  it('says so when the import was shaken out of every chunk', () => {
    const message = describeNodeBuiltin({
      kind: 'import',
      module: 'node:sqlite',
      importer: 'packages/application/src/testing/sqlite-index.ts',
      pulledInBy: 'packages/application/src/testing/sqlite-index.ts',
      chunks: [],
    });
    expect(message).toContain('shaken out of every chunk');
    expect(message).not.toContain('pulled in by');
  });

  it('names the polyfill and the module left in a chunk', () => {
    expect(
      describeNodeBuiltin({
        kind: 'polyfill',
        module: 'buffer',
        chunk: 'assets/a.js',
        pulledInBy: 'x.ts',
      }),
    ).toMatch(/^buffer, a polyfill of a Node built-in, is in assets\/a\.js, pulled in by x\.ts/);
    expect(
      describeNodeBuiltin({ kind: 'external', module: 'node:fs', chunk: 'assets/a.js' }),
    ).toMatch(/^assets\/a\.js still loads node:fs itself/);
  });
});

describe('known references', () => {
  const KNOWN: KnownNodeReference[] = [
    { package: 'pdfjs-dist', modules: ['fs', 'url'], why: 'guarded' },
  ];
  const READERS = 'assets/readers-B2.js';
  const withPdfjs = (packages: string[]): NodeBuiltinsReport => ({
    imports: [],
    chunks: [{ file: READERS, packages: packages.map((name) => ({ name, pulledInBy: 'x.ts' })) }],
  });
  const source = (modules: string[]) => [
    { file: READERS, source: modules.map((m) => `process.getBuiltinModule(\`${m}\`);`).join('') },
  ];

  it('lets through what the package is known to name, in a chunk holding it', () => {
    expect(nodeBuiltinsInBundle(withPdfjs(['pdfjs-dist']), source(['fs', 'url']), KNOWN)).toEqual(
      [],
    );
    expect(staleKnownReferences(withPdfjs(['pdfjs-dist']), source(['fs', 'url']), KNOWN)).toEqual(
      [],
    );
  });

  it('fails a module the package is not known to name', () => {
    const found = nodeBuiltinsInBundle(
      withPdfjs(['pdfjs-dist']),
      source(['fs', 'child_process']),
      KNOWN,
    );
    expect(found.map((f) => f.module)).toEqual(['child_process']);
  });

  it('fails a known module in a chunk without the package', () => {
    const found = nodeBuiltinsInBundle(withPdfjs(['react']), source(['fs']), KNOWN);
    expect(found).toEqual([{ kind: 'external', module: 'fs', chunk: READERS }]);
  });

  it('names a known module no chunk names any more, so the exception goes', () => {
    const stale = staleKnownReferences(withPdfjs(['pdfjs-dist']), source(['fs']), KNOWN);
    expect(stale).toEqual([{ package: 'pdfjs-dist', module: 'url' }]);
    expect(describeStaleReference(stale[0]!)).toMatch(
      /^Stale exception, remove it: pdfjs-dist -> url/,
    );
  });
});

describe('pnpm check:node-builtins over a crafted dist', () => {
  const script = fileURLToPath(new URL('./check-node-builtins.mjs', import.meta.url));
  let dist = '';

  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'dfai-node-builtins-'));
    mkdirSync(join(dist, '.vite'));
    mkdirSync(join(dist, 'assets'));
  });
  afterEach(() => rmSync(dist, { recursive: true, force: true }));

  /** The PDF reader's chunk as the real build makes it: pdf.js naming what it is known to. */
  const readers = {
    file: 'assets/readers-B2.js',
    packages: KNOWN_NODE_REFERENCES.map(({ package: name }) => ({ name, pulledInBy: 'x.ts' })),
  };
  const readersSource = KNOWN_NODE_REFERENCES.flatMap((k) => k.modules)
    .map((module) => `process.getBuiltinModule(\`${module}\`);`)
    .join('');

  const write = (report: NodeBuiltinsReport, chunk: string, pdfjs = readersSource) => {
    const withReaders = { ...report, chunks: [...report.chunks, readers] };
    writeFileSync(join(dist, '.vite', 'node-builtins.json'), JSON.stringify(withReaders));
    writeFileSync(join(dist, 'assets', 'index-A1.js'), chunk);
    writeFileSync(join(dist, 'assets', 'readers-B2.js'), pdfjs);
  };
  const run = () => {
    try {
      return {
        code: 0,
        out: execFileSync('node', [script, dist], { encoding: 'utf8', stdio: 'pipe' }),
      };
    } catch (error) {
      const failed = error as { status: number; stderr: string };
      return { code: failed.status, out: failed.stderr };
    }
  };

  it('passes a clean bundle', () => {
    write(CLEAN, INNOCENT);
    expect(run()).toEqual({ code: 0, out: expect.stringContaining('No Node built-in') });
  });

  it('fails a bundle holding a Node import, naming the module and the chunk', () => {
    write(CLEAN, 'import{readFileSync as e}from"node:fs";console.warn(e);');
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain('assets/index-A1.js still loads node:fs itself');
  });

  it('fails a bundle whose build resolved a built-in, naming the source file', () => {
    write(
      {
        ...CLEAN,
        imports: [
          {
            module: 'crypto',
            importer: 'apps/desktop/src/main.tsx',
            pulledInBy: 'apps/desktop/src/main.tsx',
            chunks: ['assets/index-A1.js'],
          },
        ],
      },
      INNOCENT,
    );
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain(
      'crypto is imported by apps/desktop/src/main.tsx (in assets/index-A1.js)',
    );
  });

  it('fails when a known exception matches nothing any more', () => {
    write(CLEAN, INNOCENT, '');
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain('Stale exception, remove it: pdfjs-dist -> fs');
  });

  it('fails when the build wrote no report, rather than passing what it cannot see', () => {
    writeFileSync(join(dist, 'assets', 'index-A1.js'), INNOCENT);
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain('Run `pnpm build` first');
  });
});
