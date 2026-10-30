/*
 * Attack on PR #596 (#53): ways a dependency can carry a Node built-in into
 * the bundle, each through a real `vite build` with the report plugin on the
 * window and the worker, as the app's config has it. The cases that hold are
 * kept as guards; the ones that fail are shapes real packages ship.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeBuiltinsReport } from './node-builtins-report.ts';
import { describeNodeBuiltin, nodeBuiltinsInBundle } from './node-builtins.ts';

const fromDesktop = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
type Vite = { build(config: Record<string, unknown>): Promise<unknown> };
const vite = async () => (await import(pathToFileURL(fromDesktop.resolve('vite')).href)) as Vite;

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dfai-node-builtins-attack-596-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Writes each file under the project, beside an index.html that loads `main.js`. */
function project(files: Record<string, string>): void {
  writeFileSync(join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A dependency under node_modules, its code in `index.js`. */
function dependency(name: string, code: string, pkg: Record<string, unknown> = {}) {
  return {
    [`node_modules/${name}/package.json`]: JSON.stringify({
      name,
      type: 'module',
      main: 'index.js',
      ...pkg,
    }),
    [`node_modules/${name}/index.js`]: code,
  };
}

/** `main.js` calls `some-lib`'s `read`, whose code is `lib`. */
const usesLib = (lib: string) => ({
  'main.js': "import { read } from 'some-lib';\nconsole.warn(read());\n",
  ...dependency('some-lib', lib),
});

type Build = { config?: Record<string, unknown>; withKnown?: boolean };

/** Builds the project as the app does (window + worker plugins) and returns what the check prints. */
async function buildAndCheck({ config = {}, withKnown = false }: Build = {}): Promise<string[]> {
  const plugins = nodeBuiltinsReport(root);
  await (
    await vite()
  ).build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [plugins.window],
    worker: { format: 'es', plugins: () => [plugins.worker] },
    build: { outDir: join(root, 'dist'), emptyOutDir: true, target: 'esnext' },
    ...config,
  });
  const dist = join(root, 'dist');
  const report = JSON.parse(readFileSync(join(dist, '.vite', 'node-builtins.json'), 'utf8'));
  // As check-node-builtins.mjs reads them: every script under dist.
  const sources = readdirSync(dist, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.m?js$/.test(file))
    .map((file) => ({ file, source: readFileSync(join(dist, file), 'utf8') }));
  const found = withKnown
    ? nodeBuiltinsInBundle(report, sources)
    : nodeBuiltinsInBundle(report, sources, []);
  return found.map(describeNodeBuiltin);
}

describe('a built-in a dependency names at run time (#53, attack on PR #596)', () => {
  // Node added getBuiltinModule in 22.3, so code that may run on older Nodes
  // or in a browser feature-detects it with an optional call.
  it('fails process.getBuiltinModule?.("fs"), the optional call', async () => {
    project(usesLib("export const read = () => globalThis.process?.getBuiltinModule?.('fs');\n"));
    const found = await buildAndCheck();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/still loads fs itself, at run time/);
  }, 60_000);

  // The idiom for hiding a require from a bundler: protobufjs's inquire, and
  // many isomorphic packages, reach `require` this way.
  it('fails eval("require")("fs"), a require hidden from the bundler', async () => {
    project(usesLib("export const read = () => eval('require')('fs');\n"));
    const found = await buildAndCheck();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/still loads fs itself, at run time/);
  }, 60_000);

  it('fails new Function("return require")()("fs"), the same through a Function', async () => {
    project(usesLib("export const read = () => new Function('return require')()('fs');\n"));
    const found = await buildAndCheck();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/still loads fs itself, at run time/);
  }, 60_000);

  it('fails process.getBuiltinModule("fs") reached through a computed global', async () => {
    project(
      usesLib("export const read = () => globalThis['proc' + 'ess'].getBuiltinModule('fs');\n"),
    );
    const found = await buildAndCheck();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/still loads fs itself, at run time/);
  }, 60_000);
});

describe('the pdf.js exception (#53, attack on PR #596)', () => {
  const pdfjs = dependency(
    'pdfjs-dist',
    "export const open = () => process.getBuiltinModule('fs');\n",
  );

  // The exception is by chunk, not by module: any package that lands in
  // pdf.js's chunk may name pdf.js's built-ins unseen.
  it('fails another package naming fs in the chunk pdf.js shares with it', async () => {
    project({
      'main.js':
        "import { open } from 'pdfjs-dist';\nimport { read } from 'other-lib';\nconsole.warn(open(), read());\n",
      ...pdfjs,
      ...dependency('other-lib', "export const read = () => process.getBuiltinModule('fs');\n"),
    });
    const found = await buildAndCheck({ withKnown: true });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/still loads fs itself, at run time/);
  }, 60_000);

  it('fails another package naming fs in a chunk of its own', async () => {
    project({
      'main.js':
        "import { open } from 'pdfjs-dist';\nconsole.warn(open());\nimport('./lazy.js').then(console.warn);\n",
      'lazy.js': "import { read } from 'other-lib';\nexport const text = read();\n",
      ...pdfjs,
      ...dependency('other-lib', "export const read = () => process.getBuiltinModule('fs');\n"),
    });
    const found = await buildAndCheck({ withKnown: true });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/lazy-.*\.js still loads fs itself/);
  }, 60_000);

  it('fails app code in pdf.js’s chunk naming a built-in pdf.js does not', async () => {
    project({
      'main.js':
        "import { open } from 'pdfjs-dist';\nconsole.warn(open(), process.getBuiltinModule('path'));\n",
      ...pdfjs,
    });
    const found = await buildAndCheck({ withKnown: true });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/still loads path itself/);
  }, 60_000);
});

describe('a built-in the build resolves by another road (#53, attack on PR #596)', () => {
  it('fails a resolve.alias onto a built-in', async () => {
    project({ 'main.js': "import fs from 'my-fs';\nconsole.warn(fs.readFileSync);\n" });
    const found = await buildAndCheck({ config: { resolve: { alias: { 'my-fs': 'node:fs' } } } });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('node:fs is imported by main.js');
  }, 60_000);

  it('passes a dependency whose exports send Node to one file and the browser to another', async () => {
    project({
      'main.js': "import { read } from 'some-lib';\nconsole.warn(read);\n",
      'node_modules/some-lib/package.json': JSON.stringify({
        name: 'some-lib',
        type: 'module',
        exports: { node: './node.js', default: './browser.js' },
      }),
      'node_modules/some-lib/node.js':
        "import fs from 'fs';\nexport const read = fs.readFileSync;\n",
      'node_modules/some-lib/browser.js': 'export const read = 1;\n',
    });
    expect(await buildAndCheck()).toEqual([]);
  }, 60_000);

  it('fails a CommonJS require of a built-in inside a try/catch', async () => {
    project({
      'main.js': "import lib from 'some-lib';\nconsole.warn(lib);\n",
      ...dependency(
        'some-lib',
        "let fs;\ntry { fs = require('fs'); } catch (e) {}\nmodule.exports = { fs };\n",
        { type: 'commonjs' },
      ),
    });
    const found = await buildAndCheck();
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('fs is imported by node_modules/some-lib/index.js');
  }, 60_000);

  it('fails a built-in an inline worker imports', async () => {
    project({
      'main.js': "import Reader from './reader.js?worker&inline';\nconsole.warn(new Reader());\n",
      'reader.js': "import fs from 'node:fs';\npostMessage(String(fs.readFileSync));\n",
    });
    const found = await buildAndCheck();
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('node:fs is imported by reader.js');
  }, 60_000);

  it('fails a built-in an inline worker’s dependency names at run time', async () => {
    project({
      'main.js': "import Reader from './reader.js?worker&inline';\nconsole.warn(new Reader());\n",
      'reader.js': "import { read } from 'some-lib';\npostMessage(String(read()));\n",
      ...dependency('some-lib', "export const read = () => process.getBuiltinModule('fs');\n"),
    });
    const found = await buildAndCheck();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/still loads fs itself/);
  }, 60_000);

  it('fails a built-in imported by a chunk behind a top-level await', async () => {
    project({
      'main.js': "const lazy = await import('./lazy.js');\nconsole.warn(lazy.read);\n",
      'lazy.js': "const fs = await import('node:fs');\nexport const read = fs.readFileSync;\n",
    });
    const found = await buildAndCheck();
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('node:fs is imported by lazy.js');
  }, 60_000);

  it('fails WebAssembly glue that loads Node’s module behind its Node check', async () => {
    project({
      'main.js': "import init from 'some-lib';\nconsole.warn(init);\n",
      ...dependency(
        'some-lib',
        [
          "const ON_NODE = typeof process == 'object' && typeof process.versions == 'object';",
          'export default async function init() {',
          '  if (!ON_NODE) return null;',
          "  const { createRequire } = await import('module');",
          "  return createRequire(import.meta.url)('fs');",
          '}',
        ].join('\n'),
      ),
    });
    const found = await buildAndCheck();
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('module is imported by node_modules/some-lib/index.js');
  }, 60_000);
});
