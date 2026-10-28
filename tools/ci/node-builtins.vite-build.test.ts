/*
 * The report plugin and the check together, over a real `vite build` of a
 * tiny project (#53): the fake-context tests cannot see how Vite and Rolldown
 * actually resolve a built-in, and a change in either would pass them.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeBuiltinsReport } from './node-builtins-report.ts';
import { describeNodeBuiltin, nodeBuiltinsInBundle } from './node-builtins.ts';

/** Vite as the app builds with it: `tools/` has no dependency of its own on it. */
const fromDesktop = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
type Vite = { build(config: Record<string, unknown>): Promise<unknown> };
const vite = async () => (await import(pathToFileURL(fromDesktop.resolve('vite')).href)) as Vite;

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dfai-node-builtins-build-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A project whose entry uses `some-lib`, a dependency whose own code is `lib`. */
function project(lib: string, libImports: Record<string, unknown> = {}): void {
  writeFileSync(join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
  writeFileSync(join(root, 'main.js'), "import { read } from 'some-lib';\nconsole.warn(read);\n");
  const dir = join(root, 'node_modules', 'some-lib');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'some-lib', type: 'module', main: 'index.js', imports: libImports }),
  );
  writeFileSync(join(dir, 'index.js'), lib);
}

/** Builds the project with the report plugin, and returns what the check would print. */
async function buildAndCheck(): Promise<string[]> {
  const plugins = nodeBuiltinsReport(root);
  await (
    await vite()
  ).build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [plugins.window],
    build: { outDir: join(root, 'dist'), emptyOutDir: true },
  });
  const dist = join(root, 'dist');
  const report = JSON.parse(readFileSync(join(dist, '.vite', 'node-builtins.json'), 'utf8'));
  const sources = readdirSync(join(dist, 'assets'))
    .filter((file) => file.endsWith('.js'))
    .map((file) => ({
      file: `assets/${file}`,
      source: readFileSync(join(dist, 'assets', file), 'utf8'),
    }));
  // No known exceptions: they are the app's, and this project has none of its dependencies.
  return nodeBuiltinsInBundle(report, sources, []).map(describeNodeBuiltin);
}

describe('a real vite build', () => {
  it('passes a project that uses no Node', async () => {
    project('export const read = (text) => text.length;\n');
    expect(await buildAndCheck()).toEqual([]);
  }, 60_000);

  it('fails a direct import of a built-in, naming the dependency and the file behind it', async () => {
    project("import fs from 'node:fs';\nexport const read = fs.readFileSync;\n");
    const found = await buildAndCheck();
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(
      'node:fs is imported by node_modules/some-lib/index.js, pulled in by main.js',
    );
  }, 60_000);

  it('fails a built-in reached through a subpath import, which Vite resolves out of sight', async () => {
    project("import fs from '#fsx';\nexport const read = fs.readFileSync;\n", {
      '#fsx': { node: 'fs', default: 'fs' },
    });
    const found = await buildAndCheck();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(
      /swapped for an empty object.*node_modules\/some-lib\/index\.js, pulled in by main\.js/s,
    );
  }, 60_000);
});
