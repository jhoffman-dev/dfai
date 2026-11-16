import ts from 'typescript';

/*
 * The compiler setup the module-list check (#825) asks about a Code node's
 * script: plain JavaScript checked as JavaScript, with ECMAScript's globals
 * and n8n's, and nothing of Node's or the test runner's.
 */

export const SCRIPT_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  noUnusedLocals: true,
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2022.d.ts'],
  types: [],
  noResolve: true,
  skipLibCheck: true,
};

/** How n8n runs a Code node: once for all its input items, or once for each. */
export type NodeMode = 'runOnceForAllItems' | 'runOnceForEachItem';

/*
 * What an n8n Code node defines beside its own code, as n8n's JavaScript task
 * runner builds the node's context (packages/@n8n/task-runner/src/js-task-runner/
 * js-task-runner.ts, `buildContext` and `getNativeVariables`):
 * - `console` and `$getWorkflowStaticData`;
 * - the Node.js globals it exposes (`Buffer`, the timers) and the "missing JS
 *   natives" (`atob`, `btoa`, `TextDecoder`, `TextEncoder`, their streams,
 *   `FormData`), but not `fetch` or `process`;
 * - the workflow data proxy (packages/workflow/src/workflow-data-proxy.ts),
 *   which defines `$`, `$json`, `$binary`, `$input` and the rest, and Luxon's
 *   `DateTime`, `Duration` and `Interval`, in both modes;
 * - `$execution`, `$vars` and `$secrets`, the proxy's additional keys;
 * - `items` when the node runs once for all items, `item` when it runs once for each.
 * `require` is defined too, but nothing listed here can be loaded by it, so it is left out.
 */
const N8N_NAMES = [
  '$input',
  '$json',
  '$binary',
  '$node',
  '$items',
  '$now',
  '$today',
  '$env',
  '$execution',
  '$workflow',
  '$prevNode',
  '$runIndex',
  '$itemIndex',
  '$vars',
  '$secrets',
  '$jmespath',
  '$getWorkflowStaticData',
  '$nodeVersion',
  '$parameter',
  'DateTime',
  'Duration',
  'Interval',
  'console',
  'Buffer',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'clearTimeout',
  'clearInterval',
  'clearImmediate',
  'atob',
  'btoa',
  'TextDecoder',
  'TextDecoderStream',
  'TextEncoder',
  'TextEncoderStream',
  'FormData',
];

const MODE_NAMES: Readonly<Record<NodeMode, string>> = {
  runOnceForAllItems: 'items',
  runOnceForEachItem: 'item',
};

/**
 * The declaration file of what a node in `mode` defines, and `provided`.
 * Each is `any`: the check asks only whether a name exists, never its type.
 */
export function n8nGlobals(mode: NodeMode, provided: readonly string[]): string {
  const names = [...N8N_NAMES, MODE_NAMES[mode], ...provided];
  return [
    'declare function $(node: string): any;',
    ...names.map((name) => `declare const ${name}: any;`),
    '',
  ].join('\n');
}

const base = ts.createCompilerHost(SCRIPT_OPTIONS);

/** The lib files, parsed once per process: every check reads the same ones, and parsing them is most of a check. */
const libFiles = new Map<string, ts.SourceFile | undefined>();

function libFile(name: string, version: ts.ScriptTarget): ts.SourceFile | undefined {
  if (!libFiles.has(name)) libFiles.set(name, base.getSourceFile(name, version));
  return libFiles.get(name);
}

/** A host that serves `files` from memory and the lib files from TypeScript, cached. */
export function compilerHost(files: Readonly<Record<string, string>>): ts.CompilerHost {
  const own = (name: string) => Object.hasOwn(files, name);
  return {
    ...base,
    getSourceFile: (name, version) =>
      own(name)
        ? ts.createSourceFile(name, files[name] ?? '', version, true)
        : libFile(name, typeof version === 'object' ? version.languageVersion : version),
    fileExists: (name) => own(name) || base.fileExists(name),
    readFile: (name) => (own(name) ? files[name] : base.readFile(name)),
    writeFile: () => undefined,
  };
}
