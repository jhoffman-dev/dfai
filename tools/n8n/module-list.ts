import ts from 'typescript';
import { moduleScript, moduleValueImports } from './code-node.ts';
import { compilerHost, n8nGlobals, type NodeMode, SCRIPT_OPTIONS } from './node-script-host.ts';
import { namesDeclared, namesFromOutside } from './node-scope.ts';

/*
 * A Code node's modules are a hand-kept list (#825): the order is the bytes of
 * the built workflow, so it is checked rather than derived. The check does not
 * predict what the build makes of a module: it assembles the node's script
 * with `moduleScript`, exactly as `pnpm n8n:build` does, and asks the
 * TypeScript compiler what in that one script would throw in n8n. A listed
 * module nothing uses is reported too.
 *
 * Order is held only where it matters at run time: a module whose name is read
 * while the modules load, listed after the reader, is reported. One read
 * through the reader's own function called at load (`export const TWO = h()`)
 * is not: the compiler does not follow calls, so that limit is the compiler's.
 */

const GLOBALS = '/n8n-code-node-globals.d.ts';

/** The run lines' place in the script, named for the author. */
const OWN_LINES = 'the node’s own lines';

interface Block {
  readonly label: string;
  readonly start: number;
  readonly end: number;
  /** Where the block hands its exports on: the module's `const { … } =` line. */
  readonly header?: { readonly start: number; readonly end: number } | undefined;
  /** The names the module imports as values, which the build strips with their imports. */
  readonly imported?: ReadonlySet<string> | undefined;
}

interface Script {
  readonly file: string;
  readonly text: string;
  readonly blocks: readonly Block[];
}

/**
 * A module's block with its body left out: the same `const { … } =` line, so
 * the same names in the same scope, for checking a node's own lines without
 * checking the modules' code again.
 */
function declarationOnly(code: string): string {
  const headerEnd = code.indexOf('\n', code.indexOf('\n') + 1) + 1;
  return `${code.slice(0, headerEnd)}return /** @type {any} */ ({});\n})();`;
}

interface NodeSpec {
  readonly file: string;
  readonly run: string;
  /** Whether the modules' bodies are checked here, or only the names they hand on. */
  readonly bodies: boolean;
}

/** One node as n8n runs it: the modules, then its own lines, in one function body and one scope. */
function nodeScript(modules: readonly string[], { file, run, bodies }: NodeSpec): Script {
  const blocks: Block[] = [];
  let text = '(async function () {\n';
  const add = (label: string, code: string, module?: Pick<Block, 'header' | 'imported'>) => {
    blocks.push({ label, start: text.length, end: text.length + code.length, ...module });
    text += `${code}\n`;
  };
  for (const name of modules) {
    const code = bodies ? moduleScript(name) : declarationOnly(moduleScript(name));
    const first = code.indexOf('\n') + 1;
    const start = text.length + first;
    const header = { start, end: start + code.indexOf('\n', first) - first };
    add(name, code, { header, imported: moduleValueImports(name) });
  }
  add(OWN_LINES, run);
  return { file, text: `${text}});\n`, blocks };
}

/**
 * A name probed for with `typeof`, such as a platform global (`Buffer`): of a
 * name nothing declares, `typeof` is "undefined" in JavaScript, not an error.
 * A name the module imports as a value is no probe: its module is missing, and
 * `typeof` would only hide that. So it is reported.
 */
function probedFor(source: ts.SourceFile, at: number, block: Block | undefined): boolean {
  const find = (node: ts.Node): ts.Identifier | undefined =>
    node.getStart(source) === at && ts.isIdentifier(node)
      ? node
      : node.pos <= at && at < node.end
        ? ts.forEachChild(node, find)
        : undefined;
  const found = find(source);
  if (found === undefined || !ts.isTypeOfExpression(found.parent)) return false;
  return !(block?.imported?.has(found.text) ?? false);
}

/** Cannot find a name, in its forms. `typeof` of such a name is "undefined", not an error. */
const NOT_FOUND_CODES = new Set([2304, 2552, 2580, 2581, 2582, 2583, 2584]);
/**
 * Every name that throws a ReferenceError: not found, a member or a type read
 * as a bare name, read before its declaration runs, missing for `{ name }`.
 */
const NAME_CODES = new Set([...NOT_FOUND_CODES, 2448, 2449, 2591, 2662, 2663, 2693, 18004]);
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
    const block = blockAt(script, at);
    if (NOT_FOUND_CODES.has(diagnostic.code) && probedFor(diagnostic.file, at, block)) return [];
    const where = block?.label ?? 'the assembled node';
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

/** The listed modules none of whose names the rest of this node's script reads. */
function unusedIn(script: Script, diagnostics: readonly ts.Diagnostic[]): string[] {
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
    .map(({ label }) => label);
}

interface ListCheck {
  /** Names something other than a listed module defines in the node, such as a bundle's global. */
  readonly provided?: readonly string[];
  /** How n8n runs the nodes, which decides whether `items` or `item` is defined. */
  readonly mode?: NodeMode;
}

interface NodeCheck {
  readonly broken: readonly string[];
  readonly unused: readonly string[];
}

function nodeProblems(program: ts.Program, script: Script): NodeCheck {
  const source = program.getSourceFile(script.file) as ts.SourceFile;
  const diagnostics = [
    ...program.getSyntacticDiagnostics(source),
    ...program.getSemanticDiagnostics(source),
  ];
  return {
    broken: [...brokenProblems(script, diagnostics), ...loadProblems(script, source)],
    unused: unusedIn(script, diagnostics),
  };
}

function programOf(scripts: readonly Script[], globals: string): ts.Program {
  const files = Object.fromEntries(scripts.map(({ file, text }) => [file, text]));
  const host = compilerHost({ ...files, [GLOBALS]: globals });
  return ts.createProgram([...Object.keys(files), GLOBALS], SCRIPT_OPTIONS, host);
}

/** What the modules' code reads from outside itself, in a script that holds it in full. */
function modulesReadFromOutside(program: ts.Program, script: Script): Set<string> {
  const modules = script.blocks.filter(({ header }) => header !== undefined);
  const first = modules[0];
  const last = modules[modules.length - 1];
  if (first === undefined || last === undefined) return new Set();
  const source = program.getSourceFile(script.file) as ts.SourceFile;
  return namesFromOutside(program.getTypeChecker(), source, { start: first.start, end: last.end });
}

/**
 * Each node's check. The modules' code is checked once, beside no node's
 * lines, and each node's lines beside only the names the modules hand on,
 * unless some node declares a name that code reads from outside itself: then
 * that node could change what the code means, and every node is checked with
 * the modules' code in full. Either way the answer does not depend on the
 * order of the nodes.
 */
function checkNodes(
  modules: readonly string[],
  runs: readonly string[],
  globals: string,
): NodeCheck[] {
  const full = (run: string, at: number) =>
    nodeScript(modules, { file: `/n8n-code-node-${at}.js`, run, bodies: true });
  const code = nodeScript(modules, { file: '/n8n-modules.js', run: '', bodies: true });
  const lines = runs.map((run, at) =>
    nodeScript(modules, { file: `/n8n-code-node-${at}.js`, run, bodies: false }),
  );
  const program = programOf([code, ...lines], globals);
  const fromOutside = modulesReadFromOutside(program, code);
  const declares = runs.some((run) =>
    [...namesDeclared(run)].some((name) => fromOutside.has(name)),
  );
  if (!declares) return [code, ...lines].map((script) => nodeProblems(program, script));
  const scripts = runs.map(full);
  const each = programOf(scripts, globals);
  return scripts.map((script) => nodeProblems(each, script));
}

/**
 * What is wrong with one Code-node module list, given the `run` lines of
 * every node built from it. A module is unused when no node reads it. An
 * empty answer means the list is right.
 */
export function moduleListProblems(
  modules: readonly string[],
  runs: readonly string[],
  { provided = [], mode = 'runOnceForAllItems' }: ListCheck = {},
): string[] {
  const distinct = runs.length === 0 ? [''] : [...new Set(runs)];
  const checked = checkNodes(modules, distinct, n8nGlobals(mode, provided));
  const unused = modules.filter((name) => checked.every((node) => node.unused.includes(name)));
  return [
    ...new Set(checked.flatMap(({ broken }) => broken)),
    ...unused.map(
      (name) => `${name} is listed, but no listed module imports it and no node uses it`,
    ),
  ];
}
