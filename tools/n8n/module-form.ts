import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { exportedValues, transpiledModule } from './code-node.ts';

/*
 * One listed module as the build will inline it (#825). The build strips the
 * import lines of the transpiled JavaScript and hands on only names exported
 * by `export function/class/const/let`, so any other way of importing or
 * exporting breaks the Code node. The imports read here are the ones the
 * transpiler kept: an import used only as a type is gone, exactly as in the build.
 */

export interface ModuleForm {
  /** The modules it needs at run time, as resolved URLs. */
  readonly imports: readonly string[];
  /** The names it hands on to the rest of the node. */
  readonly exports: readonly string[];
  /** Each import or export the build cannot inline, and why. */
  readonly problems: readonly string[];
}

const INLINED = 'the build inlines only `import { name }` and `export function/class/const/let`';

const RUN_TIME_LOAD =
  'loads a module at run time (`import()`, `require`); the node is one script, with no module beside it';

/** A specifier with no extension names the `.ts` file, as the TypeScript sources here do. */
function resolved(specifier: string, from: URL): string {
  const named = /\.[cm]?[jt]sx?$/.test(specifier) ? specifier : `${specifier}.ts`;
  return new URL(named, from).href;
}

/** Why an import the transpiler kept cannot be inlined, or undefined if it can. */
function importProblem(statement: ts.ImportDeclaration): string | undefined {
  const clause = statement.importClause;
  if (clause === undefined) return 'an import for its side effects only, which the build drops';
  if (clause.name !== undefined) return 'a default import, which no module here hands on';
  const named = clause.namedBindings;
  if (named !== undefined && ts.isNamespaceImport(named)) {
    return 'a namespace import (`import * as`), whose name the build never defines';
  }
  if (named?.elements.some((each) => each.propertyName !== undefined)) {
    return 'a renamed import (`{ a as b }`), whose new name the build never defines';
  }
  return undefined;
}

/** Why a top-level export cannot be inlined, or undefined if it can. */
function exportProblem(statement: ts.Statement): string | undefined {
  if (ts.isExportDeclaration(statement)) {
    if (statement.moduleSpecifier !== undefined) return 're-export (`export … from`)';
    return /^export\s*\{\s*\};?$/.test(statement.getText()) ? undefined : 'an export list';
  }
  if (ts.isExportAssignment(statement)) return 'a default export';
  const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
  if (!modifiers.some((each) => each.kind === ts.SyntaxKind.ExportKeyword)) return undefined;
  if (modifiers.some((each) => each.kind === ts.SyntaxKind.DefaultKeyword)) {
    return 'a default export';
  }
  const inlined = /^export\s+(async\s+)?(function|class|const|let)\b/.test(statement.getText());
  return inlined ? undefined : 'an export the build does not strip (`export var`, an enum)';
}

/** `import()` and `require(…)` anywhere in the module: the node is one script, with nothing beside it. */
function loadsAtRunTime(source: ts.SourceFile): boolean {
  const loads = (node: ts.Node): boolean =>
    (ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) ||
    (ts.forEachChild(node, loads) ?? false);
  return loads(source);
}

function statementProblems(statement: ts.Statement): string[] {
  const problem = ts.isImportDeclaration(statement)
    ? importProblem(statement)
    : exportProblem(statement);
  return problem === undefined ? [] : [`${problem}; ${INLINED}`];
}

/** One module, read as the build reads it. */
export function moduleForm(url: URL): ModuleForm {
  const text = readFileSync(url, 'utf8');
  const javascript = transpiledModule(url.pathname, text);
  const output = ts.createSourceFile(url.pathname, javascript, ts.ScriptTarget.ES2022, true);
  const imports = output.statements
    .filter(ts.isImportDeclaration)
    .map((each) => resolved((each.moduleSpecifier as ts.StringLiteral).text, url));
  const problems = output.statements.flatMap(statementProblems);
  if (loadsAtRunTime(output)) problems.push(RUN_TIME_LOAD);
  const source = ts.createSourceFile(url.pathname, text, ts.ScriptTarget.ES2022, true);
  return { imports, exports: exportedValues(source), problems };
}
