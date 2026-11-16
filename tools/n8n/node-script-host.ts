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

/**
 * What an n8n Code node defines beside its own code: the `$` helpers, the
 * legacy `items`, Luxon's date types, `console` and `Buffer`, which n8n
 * documents, and the web text helpers its Node runtime has (github-file.ts
 * falls back on them where `Buffer` is missing).
 * https://docs.n8n.io/code/builtin/overview/
 */
export const N8N_GLOBALS = [
  'declare function $(node: string): any;',
  ...[
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
    'items',
    'DateTime',
    'Duration',
    'Interval',
    'console',
    'Buffer',
    'atob',
    'btoa',
    'TextDecoder',
    'TextEncoder',
  ].map((name) => `declare const ${name}: any;`),
  '',
].join('\n');

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
