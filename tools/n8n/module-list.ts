import ts from 'typescript';
import { moduleScript } from './code-node.ts';
import { compilerHost, N8N_GLOBALS, SCRIPT_OPTIONS } from './node-script-host.ts';

/*
 * A Code node's modules are a hand-kept list (#825): the order is the bytes of
 * the built workflow, so it is checked rather than derived. The check does not
 * predict what the build makes of a module: it assembles the node's script
 * with `moduleScript`, exactly as `pnpm n8n:build` does, and asks the
 * TypeScript compiler what in that one script would throw in n8n. A listed
 * module nothing uses is reported too.
 */

const SCRIPT = '/n8n-code-node.js';
const GLOBALS = '/n8n-code-node-globals.d.ts';

/** The run lines' place in the script, named for the author. */
const OWN_LINES = 'the node’s own lines';

interface Block {
  readonly label: string;
  readonly start: number;
  readonly end: number;
  /** Where the block hands its exports on: the module's `const { … } =` line. */
  readonly header?: { readonly start: number; readonly end: number } | undefined;
}

interface Script {
  readonly text: string;
  readonly blocks: readonly Block[];
}

/** Every node built from the list, as one script: the modules, then each node's lines as its own function. */
function nodeScript(modules: readonly string[], runs: readonly string[]): Script {
  const blocks: Block[] = [];
  let text = '(async function () {\n';
  const add = (label: string, code: string, header?: Block['header']) => {
    blocks.push({ label, start: text.length, end: text.length + code.length, header });
    text += `${code}\n`;
  };
  for (const name of modules) {
    const code = moduleScript(name);
    const first = code.indexOf('\n') + 1;
    const start = text.length + first;
    add(name, code, { start, end: start + code.indexOf('\n', first) - first });
  }
  for (const run of runs) add(OWN_LINES, `(async function () {\n${run}\n});`);
  return { text: `${text}});\n`, blocks };
}

/** `typeof name` of a name nothing declares is "undefined" in JavaScript, not an error. */
function underTypeof(source: ts.SourceFile, at: number): boolean {
  const find = (node: ts.Node): ts.Node | undefined =>
    node.getStart(source) === at && ts.isIdentifier(node)
      ? node
      : node.pos <= at && at < node.end
        ? ts.forEachChild(node, find)
        : undefined;
  const found = find(source);
  return found !== undefined && ts.isTypeOfExpression(found.parent);
}

/** Cannot find a name, in its forms; a name used before its declaration runs; a value missing for `{ name }`. */
const NAME_CODES = new Set([2304, 2448, 2449, 2552, 2580, 2581, 2582, 2583, 2584, 2591, 18004]);
/** A name declared twice in one scope. */
const TWICE_CODES = new Set([2300, 2451]);
/** All of a `const { … }` unused, or its one name. */
const UNUSED_CODES = new Set([6133, 6198]);

const HINT_NAME =
  'list the module that exports it, before any module that reads it while loading (the build defines only names imported as `import { name }`), or declare it in the node';
const HINT_TWICE = 'list each module once, and export each name from one listed module';
const HINT_FORM =
  'the build inlines only `import { name }` and `export function/class/const/let` declarations, run inside a plain function';

function hintFor(code: number): string | undefined {
  if (NAME_CODES.has(code)) return HINT_NAME;
  if (TWICE_CODES.has(code)) return HINT_TWICE;
  return code < 2000 ? HINT_FORM : undefined;
}

function blockAt(script: Script, at: number): Block | undefined {
  return script.blocks.find((each) => each.start <= at && at <= each.end);
}

function brokenProblems(script: Script, diagnostics: readonly ts.Diagnostic[]): string[] {
  return diagnostics.flatMap((diagnostic) => {
    const hint = hintFor(diagnostic.code);
    const at = diagnostic.start ?? 0;
    if (hint === undefined || diagnostic.file === undefined) return [];
    if (NAME_CODES.has(diagnostic.code) && underTypeof(diagnostic.file, at)) return [];
    const where = blockAt(script, at)?.label ?? 'the assembled node';
    const what = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
    return [`${where}: ${what} (${hint})`];
  });
}

/**
 * `import()`, `require(…)` and `import.meta`, which the compiler passes in a
 * script: the node is one function body, with no module beside it to load.
 */
function loadProblems(script: Script, source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const loads =
      (ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) ||
      (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword);
    if (loads) {
      const where = blockAt(script, node.getStart(source))?.label ?? 'the assembled node';
      found.push(
        `${where}: loads a module or reads \`import.meta\` at run time, but the node is one script with no module beside it; ${HINT_FORM}`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The names a module block hands on, read from its `const { … } =` line. */
function headerNames(script: Script, header: NonNullable<Block['header']>): string[] {
  const line = script.text.slice(header.start, header.end);
  const list = line.slice(line.indexOf('{') + 1, line.indexOf('}'));
  return list.split(',').filter((each) => each.trim() !== '');
}

/** A listed module none of whose names the rest of the script reads. */
function unusedModules(script: Script, diagnostics: readonly ts.Diagnostic[]): string[] {
  return script.blocks
    .filter(({ header }) => {
      if (header === undefined) return false;
      const unused = diagnostics.filter(
        ({ code, start = -1 }) =>
          UNUSED_CODES.has(code) && header.start <= start && start <= header.end,
      );
      const names = headerNames(script, header);
      return unused.some(({ code }) => code === 6198) || unused.length === names.length;
    })
    .map(({ label }) => `${label} is listed, but no listed module imports it and no node uses it`);
}

/**
 * What is wrong with one Code-node module list, given the `run` lines of
 * every node built from it and the names something other than a listed module
 * defines in the node (`provided`, such as a bundle's global). An empty answer
 * means the list is right.
 */
export function moduleListProblems(
  modules: readonly string[],
  runs: readonly string[],
  provided: readonly string[] = [],
): string[] {
  const script = nodeScript(modules, runs);
  const globals = `${N8N_GLOBALS}${provided.map((name) => `declare const ${name}: any;\n`).join('')}`;
  const host = compilerHost({ [SCRIPT]: script.text, [GLOBALS]: globals });
  const program = ts.createProgram([SCRIPT, GLOBALS], SCRIPT_OPTIONS, host);
  const source = program.getSourceFile(SCRIPT) as ts.SourceFile;
  const diagnostics = [
    ...program.getSyntacticDiagnostics(source),
    ...program.getSemanticDiagnostics(source),
  ];
  return [
    ...brokenProblems(script, diagnostics),
    ...loadProblems(script, source),
    ...unusedModules(script, diagnostics),
  ];
}
