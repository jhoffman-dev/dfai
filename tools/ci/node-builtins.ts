/*
 * Whether a Node built-in reached the app's bundle (#53).
 *
 * The app runs in Tauri's webview, where there is no Node. Vite does not fail
 * a build that imports one: it prints "Module "node:sqlite" has been
 * externalized for browser compatibility" and swaps the module for an empty
 * object, so the code fails only when it runs, in WebKit. That warning scrolled
 * past every gate run while `@dfai/application`'s barrel re-exported a test
 * helper that opens SQLite.
 *
 * The build records what it saw (`node-builtins-report.ts`, written to
 * `dist/.vite/node-builtins.json`); this decides. Three ways Node gets in:
 * an import of a built-in the bundler resolved (to its empty object, or to a
 * package of the same name), a dependency that is a polyfill of one, and an
 * import left in the output for the runtime to load, which only the chunk's
 * text shows.
 */
import { builtinModules, isBuiltin } from 'node:module';

/** An import of a Node built-in the build resolved, by repo-relative paths. */
export type BuiltinImport = {
  /** As written: `node:fs`, `path`, `fs/promises`. */
  module: string;
  importer: string;
  /** The app's own file that drew `importer` in: itself, unless it is a dependency's. */
  pulledInBy: string;
  /** Every chunk `importer` landed in; none when the bundler shook it out. */
  chunks: string[];
};

/** A dependency in one chunk, and the app's own file that drew it in. */
export type ChunkPackage = { name: string; pulledInBy: string };

export type NodeBuiltinsReport = {
  imports: BuiltinImport[];
  chunks: { file: string; packages: ChunkPackage[] }[];
};

/** One output file's text, by its path under `dist`. */
export type ChunkSource = { file: string; source: string };

export type NodeBuiltinFinding =
  | { kind: 'import'; module: string; importer: string; pulledInBy: string; chunks: string[] }
  | { kind: 'polyfill'; module: string; chunk: string; pulledInBy: string }
  | { kind: 'external'; module: string; chunk: string };

type LeftInOutput = Extract<NodeBuiltinFinding, { kind: 'external' }>;

/**
 * Packages that stand in for a Node built-in in a browser, beyond those named
 * after one (`buffer`, `events`, `process`) and the `*-browserify` family.
 */
const POLYFILL_PACKAGES: ReadonlySet<string> = new Set([
  'node-stdlib-browser',
  'node-libs-browser',
  'vite-plugin-node-polyfills',
  'rollup-plugin-node-polyfills',
  'rollup-plugin-polyfill-node',
  '@esbuild-plugins/node-globals-polyfill',
  '@esbuild-plugins/node-modules-polyfill',
  'browserify-zlib',
  'stream-http',
  'https-browserify',
  'querystring-es3',
  'domain-browser',
]);

export function isNodePolyfill(name: string): boolean {
  return isBuiltin(name) || name.endsWith('-browserify') || POLYFILL_PACKAGES.has(name);
}

const escaped = (name: string) => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * `from"x"`, `import"x"`, `import("x")`, `require("x")` and
 * `process.getBuiltinModule("x")`, with any quote, `x` a built-in. The last is
 * how the SQLite test support reaches Node without an import (#525).
 */
const LEFT_IN_OUTPUT = new RegExp(
  String.raw`(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\(|\bgetBuiltinModule\s*\()\s*(["'\x60])(node:[\w/]+|` +
    builtinModules
      .filter((name) => !name.startsWith('node:') && !name.startsWith('_'))
      .map(escaped)
      .join('|') +
    String.raw`)\1`,
  'g',
);

/** Every built-in still named in a chunk's text, for the runtime to load. */
function leftInOutput({ file, source }: ChunkSource): LeftInOutput[] {
  const modules = new Set([...source.matchAll(LEFT_IN_OUTPUT)].map((match) => match[2]!));
  return [...modules].sort().map((module) => ({ kind: 'external', module, chunk: file }));
}

function polyfills(report: NodeBuiltinsReport): NodeBuiltinFinding[] {
  return report.chunks.flatMap(({ file, packages }) =>
    packages
      .filter(({ name }) => isNodePolyfill(name))
      .map(({ name, pulledInBy }) => ({
        kind: 'polyfill' as const,
        module: name,
        chunk: file,
        pulledInBy,
      })),
  );
}

/**
 * Built-ins a dependency names in the output for when it runs on Node, let
 * through by package: a chunk holding the package may name these, and only
 * these. Any other module, or the package in a chunk where its guard is gone,
 * fails as usual.
 */
export type KnownNodeReference = { package: string; modules: readonly string[]; why: string };

export const KNOWN_NODE_REFERENCES: readonly KnownNodeReference[] = [
  {
    package: 'pdfjs-dist',
    modules: ['fs', 'fs/promises', 'module', 'stream', 'url'],
    why: 'pdf.js asks for these through process.getBuiltinModule only behind its own isNodeJS check, which is false in the webview.',
  },
];

const packagesOf = (report: NodeBuiltinsReport, chunk: string) =>
  report.chunks.find(({ file }) => file === chunk)?.packages.map(({ name }) => name) ?? [];

const lets = (k: KnownNodeReference, module: string, packages: readonly string[]) =>
  packages.includes(k.package) && k.modules.includes(module);

/** Every built-in a chunk's text still names, before any known one is let through. */
const everyLeftInOutput = (sources: readonly ChunkSource[]) => sources.flatMap(leftInOutput);

/** Everything of Node the build let into the bundle; empty when the bundle is clean. */
export function nodeBuiltinsInBundle(
  report: NodeBuiltinsReport,
  sources: readonly ChunkSource[],
  known: readonly KnownNodeReference[] = KNOWN_NODE_REFERENCES,
): NodeBuiltinFinding[] {
  const unknown = everyLeftInOutput(sources).filter(
    (found) => !known.some((k) => lets(k, found.module, packagesOf(report, found.chunk))),
  );
  return [
    ...report.imports.map((found) => ({ kind: 'import' as const, ...found })),
    ...polyfills(report),
    ...unknown,
  ];
}

/** Each known module no chunk names any more, so the list cannot outlive its reason. */
export function staleKnownReferences(
  report: NodeBuiltinsReport,
  sources: readonly ChunkSource[],
  known: readonly KnownNodeReference[] = KNOWN_NODE_REFERENCES,
): { package: string; module: string }[] {
  const named = everyLeftInOutput(sources);
  return known.flatMap((k) =>
    k.modules
      .filter(
        (module) =>
          !named.some(
            (found) => found.module === module && lets(k, module, packagesOf(report, found.chunk)),
          ),
      )
      .map((module) => ({ package: k.package, module })),
  );
}

export function describeStaleReference({
  package: name,
  module,
}: {
  package: string;
  module: string;
}): string {
  return `Stale exception, remove it: ${name} -> ${module} matches nothing in the build (KNOWN_NODE_REFERENCES, tools/ci/node-builtins.ts).`;
}

const FIX =
  '  Fix: keep Node-only code out of what the app imports (test support under `testing/`, tools in `tools/`), or use a Web API.';

/** What the check prints for one finding: the module, the chunk, and the source that drew it in. */
export function describeNodeBuiltin(finding: NodeBuiltinFinding): string {
  switch (finding.kind) {
    case 'import': {
      const where =
        finding.chunks.length > 0
          ? `in ${finding.chunks.join(', ')}`
          : 'in the module graph, shaken out of every chunk for now';
      const via =
        finding.pulledInBy === finding.importer ? '' : `, pulled in by ${finding.pulledInBy}`;
      return [
        `${finding.module} is imported by ${finding.importer}${via} (${where}): the webview has no Node, and the build swaps it for an empty object.`,
        FIX,
      ].join('\n');
    }
    case 'polyfill':
      return [
        `${finding.module}, a polyfill of a Node built-in, is in ${finding.chunk}, pulled in by ${finding.pulledInBy}.`,
        FIX,
      ].join('\n');
    case 'external':
      return [
        `${finding.chunk} still loads ${finding.module} itself, at run time: the webview has no Node to load it from.`,
        FIX,
      ].join('\n');
  }
}
