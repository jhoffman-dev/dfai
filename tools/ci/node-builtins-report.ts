/*
 * The build's half of `pnpm check:node-builtins` (#53): a Vite plugin that
 * records, and decides nothing. A production build swaps a Node built-in for
 * an empty object and leaves no trace of it in the output, so only the build
 * can say what was imported. `node-builtins.ts` holds the rule.
 *
 * The worker is a build of its own, so the report is a pair of plugins over
 * one record: the worker's adds to it, and the window's, which finishes last,
 * writes it to `.vite/node-builtins.json` beside the manifest.
 */
import { isBuiltin } from 'node:module';
import { relative, sep } from 'node:path';
import type { BuiltinImport, ChunkPackage, NodeBuiltinsReport } from './node-builtins.ts';

/** The few of the bundler's plugin types this uses: `tools/` does not depend on Vite. */
type ModuleInfo = { importers: readonly string[] };
type Output = { type: 'chunk'; fileName: string; moduleIds: readonly string[] } | { type: 'asset' };
type BundleContext = {
  getModuleInfo(id: string): ModuleInfo | null;
  emitFile(file: { type: 'asset'; fileName: string; source: string }): string;
};
export type ReportPlugin = {
  name: string;
  apply: 'build';
  enforce: 'pre';
  resolveId(source: string, importer: string | undefined): null;
  generateBundle(this: BundleContext, options: unknown, bundle: Record<string, Output>): void;
};

type Seen = {
  imports: Map<string, { module: string; importer: string; pulledInBy?: string; chunks: string[] }>;
  chunks: Map<string, ChunkPackage[]>;
};

const NODE_MODULES = '/node_modules/';

/** `react-dom` or `@tiptap/core`, from a module's path; null for the app's own files. */
export function packageOf(id: string): string | null {
  const at = id.lastIndexOf(NODE_MODULES);
  if (at < 0) return null;
  const [first = '', second = ''] = id.slice(at + NODE_MODULES.length).split('/');
  return first.startsWith('@') ? `${first}/${second}` : first;
}

/** The nearest module above `id` that is the app's own: the file that drew it in. */
export function ownFileAbove(id: string, importersOf: (id: string) => readonly string[]): string {
  const seen = new Set([id]);
  for (const next of seen) {
    if (packageOf(next) === null) return next;
    for (const importer of importersOf(next)) seen.add(importer);
  }
  return id;
}

/** Each dependency of one chunk, once, with the app's file that drew it in. */
function packagesIn(moduleIds: readonly string[], ownFile: (id: string) => string): ChunkPackage[] {
  const first = new Map<string, string>();
  for (const id of moduleIds) {
    const name = packageOf(id);
    if (name !== null && !first.has(name)) first.set(name, id);
  }
  return [...first].map(([name, id]) => ({ name, pulledInBy: ownFile(id) }));
}

function recordChunk(
  seen: Seen,
  chunk: { fileName: string; moduleIds: readonly string[] },
  ownFile: (id: string) => string,
): void {
  const ids = new Set(chunk.moduleIds);
  for (const found of seen.imports.values()) {
    if (!ids.has(found.importer)) continue;
    found.pulledInBy ??= ownFile(found.importer);
    if (!found.chunks.includes(chunk.fileName)) found.chunks.push(chunk.fileName);
  }
  seen.chunks.set(chunk.fileName, packagesIn(chunk.moduleIds, ownFile));
}

function reportOf(
  seen: Seen,
  fromRepo: (id: string) => string,
  ownFile: (id: string) => string,
): NodeBuiltinsReport {
  const imports: BuiltinImport[] = [...seen.imports.values()].map((found) => ({
    module: found.module,
    importer: fromRepo(found.importer),
    pulledInBy: fromRepo(found.pulledInBy ?? ownFile(found.importer)),
    chunks: found.chunks,
  }));
  const chunks = [...seen.chunks].map(([file, packages]) => ({
    file,
    packages: packages.map(({ name, pulledInBy }) => ({ name, pulledInBy: fromRepo(pulledInBy) })),
  }));
  return { imports, chunks };
}

/** The window's plugin and the worker's, over one record; paths in the report are from `repoRoot`. */
export function nodeBuiltinsReport(repoRoot: string): {
  window: ReportPlugin;
  worker: ReportPlugin;
} {
  const seen: Seen = { imports: new Map(), chunks: new Map() };
  const fromRepo = (id: string) => relative(repoRoot, id.split('?')[0]!).split(sep).join('/');
  const plugin = (writes: boolean): ReportPlugin => ({
    name: 'atlas-node-builtins-report',
    apply: 'build',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer !== undefined && isBuiltin(source)) {
        seen.imports.set(`${source}\0${importer}`, { module: source, importer, chunks: [] });
      }
      // Recorded only: resolving is left to Vite.
      return null;
    },
    generateBundle(_options, bundle) {
      const ownFile = (id: string) =>
        ownFileAbove(id, (i) => this.getModuleInfo(i)?.importers ?? []);
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') recordChunk(seen, output, ownFile);
      }
      if (!writes) return;
      this.emitFile({
        type: 'asset',
        fileName: '.vite/node-builtins.json',
        source: JSON.stringify(reportOf(seen, fromRepo, ownFile)),
      });
    },
  });
  return { window: plugin(true), worker: plugin(false) };
}
