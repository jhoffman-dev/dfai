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

/** A module whose rendered code names built-ins, once per time it names one. */
export type NamingModule = { module: string; package: string | null; builtins: string[] };

export type NodeBuiltinsReport = {
  imports: BuiltinImport[];
  chunks: { file: string; packages: ChunkPackage[]; named?: NamingModule[] }[];
};

/** One output file's text, by its path under `dist`. */
export type ChunkSource = { file: string; source: string };

export type NodeBuiltinFinding =
  | { kind: 'import'; module: string; importer: string; pulledInBy: string; chunks: string[] }
  | { kind: 'polyfill'; module: string; chunk: string; pulledInBy: string }
  | { kind: 'external'; module: string; chunk: string; namedBy?: string[] };

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
  // Whole sets of stand-ins for Node's modules, for edge runtimes and the browser.
  'unenv',
  '@jspm/core',
]);

export function isNodePolyfill(name: string): boolean {
  return isBuiltin(name) || name.endsWith('-browserify') || POLYFILL_PACKAGES.has(name);
}

const escaped = (name: string) => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const BUILTIN_NAME =
  String.raw`node:[\w/]+|` +
  builtinModules
    .filter((name) => !name.startsWith('node:') && !name.startsWith('_'))
    .map(escaped)
    .join('|');

/**
 * `from"x"`, `import"x"`, `import("x")`, `require("x")` and
 * `process.getBuiltinModule("x")` (or its optional call, `?.(`), with any
 * quote, `x` a built-in. The last is how the SQLite test support reaches Node
 * without an import (#525), and how code that may run on either feature-detects it.
 */
const LEFT_IN_OUTPUT = new RegExp(
  String.raw`(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\(|\bgetBuiltinModule\s*(?:\?\.\s*)?\()\s*(["'\x60])(${BUILTIN_NAME})\1`,
  'g',
);

/**
 * A `require` hidden from the bundler, `eval("require")(…)` or
 * `new Function("return require")()(…)`, and the string it is called with, if any.
 */
const HIDDEN_REQUIRE = new RegExp(
  String.raw`(?:\beval\s*\(\s*(["'\x60])\s*require\s*\1\s*\)|\bFunction\s*\(\s*(["'\x60])[^"'\x60]*\brequire\b[^"'\x60]*\2\s*\)\s*\(\s*\))\s*\(\s*(?:(["'\x60])([^"'\x60]*)\3)?`,
  'g',
);

/** What a hidden require loads when it names no built-in: unknown, and failed as itself. */
export const HIDDEN = 'require';

/**
 * Every built-in `code` names for the runtime to load, once per time it does:
 * the import and require forms above, and a hidden require (as its built-in,
 * or as `HIDDEN` when it names none).
 *
 * It reads text, not code, so it is a backstop, not the check:
 * - it scans only `.js` and `.mjs` files, the scripts the webview runs;
 * - it can match a regex literal or a string that spells `require("path")`
 *   (a false alarm, let through by KNOWN_NODE_REFERENCES once understood);
 * - it cannot see a built-in named through a variable, such as an aliased
 *   `createRequire(import.meta.url)(name)` or a computed `globalThis['proc' + 'ess']`.
 *
 * The app's own code and its dependencies' imports are covered by the build's
 * record instead, which sees every import as it resolves, by name or through
 * Vite's stand-in. That record is loud too: a package whose `"browser"` field
 * maps a built-in to false (`{"fs": false}`) is reported though it is safe.
 */
export function builtinsNamedIn(code: string): string[] {
  const named = [...code.matchAll(LEFT_IN_OUTPUT)].map((match) => match[2]!);
  const hidden = [...code.matchAll(HIDDEN_REQUIRE)].map((match) =>
    match[4] !== undefined && isBuiltin(match[4]) ? match[4] : HIDDEN,
  );
  return [...named, ...hidden];
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
 * through by package: the package's own modules may name these, and only
 * these. The same name from any other module in the chunk fails as usual.
 */
export type KnownNodeReference = { package: string; modules: readonly string[]; why: string };

export const KNOWN_NODE_REFERENCES: readonly KnownNodeReference[] = [
  {
    package: 'pdfjs-dist',
    modules: ['fs', 'fs/promises', 'module', 'stream', 'url'],
    why: 'pdf.js asks for these through process.getBuiltinModule only behind its own isNodeJS check, which is false in the webview.',
  },
];

const lets = (known: readonly KnownNodeReference[], named: NamingModule, builtin: string) =>
  known.some((k) => named.package === k.package && k.modules.includes(builtin));

const count = (names: readonly string[], name: string) => names.filter((n) => n === name).length;

/**
 * The built-ins one output file names more often than its known modules
 * account for. The file's text is the truth; the modules' rendered code, as
 * the build recorded it, says whose each name is.
 */
function leftInOutput(
  { file, source }: ChunkSource,
  report: NodeBuiltinsReport,
  known: readonly KnownNodeReference[],
): LeftInOutput[] {
  const inFile = builtinsNamedIn(source);
  const modules = report.chunks.find((chunk) => chunk.file === file)?.named ?? [];
  const letThrough = (builtin: string) =>
    modules
      .filter((named) => lets(known, named, builtin))
      .reduce((sum, named) => sum + count(named.builtins, builtin), 0);
  return [...new Set(inFile)]
    .sort()
    .filter((builtin) => count(inFile, builtin) > letThrough(builtin))
    .map((builtin) => ({
      kind: 'external',
      module: builtin,
      chunk: file,
      namedBy: modules
        .filter((named) => named.builtins.includes(builtin) && !lets(known, named, builtin))
        .map((named) => named.module),
    }));
}

/** Everything of Node the build let into the bundle; empty when the bundle is clean. */
export function nodeBuiltinsInBundle(
  report: NodeBuiltinsReport,
  sources: readonly ChunkSource[],
  known: readonly KnownNodeReference[] = KNOWN_NODE_REFERENCES,
): NodeBuiltinFinding[] {
  return [
    ...report.imports.map((found) => ({ kind: 'import' as const, ...found })),
    ...polyfills(report),
    ...sources.flatMap((source) => leftInOutput(source, report, known)),
  ];
}

/** Each known module the package's own code no longer names, so the list cannot outlive its reason. */
export function staleKnownReferences(
  report: NodeBuiltinsReport,
  known: readonly KnownNodeReference[] = KNOWN_NODE_REFERENCES,
): { package: string; module: string }[] {
  const named = report.chunks.flatMap((chunk) => chunk.named ?? []);
  return known.flatMap((k) =>
    k.modules
      .filter(
        (module) => !named.some((n) => n.package === k.package && n.builtins.includes(module)),
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
      // Vite's stand-in names no module: the built-in was resolved before the report saw it.
      const what = finding.module.startsWith('__vite-browser-external')
        ? `A Node built-in, resolved out of sight (an alias or a subpath import) to ${finding.module},`
        : finding.module;
      return [
        `${what} is imported by ${finding.importer}${via} (${where}): the webview has no Node, and the build swaps it for an empty object.`,
        FIX,
      ].join('\n');
    }
    case 'polyfill':
      return [
        `${finding.module}, a polyfill of a Node built-in, is in ${finding.chunk}, pulled in by ${finding.pulledInBy}.`,
        FIX,
      ].join('\n');
    case 'external': {
      const by =
        finding.namedBy === undefined || finding.namedBy.length === 0
          ? ''
          : ` Named by ${finding.namedBy.join(', ')}.`;
      const loads =
        finding.module === HIDDEN
          ? `${finding.chunk} hides a require from the bundler (eval or Function): it loads a module at run time, and the webview has no Node to load it from.`
          : `${finding.chunk} still loads ${finding.module} itself, at run time: the webview has no Node to load it from.`;
      return [`${loads}${by}`, FIX].join('\n');
    }
  }
}
