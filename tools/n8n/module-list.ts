import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { exportedValues } from './code-node.ts';

/*
 * A Code node's modules are a hand-kept list (#825): the order is the bytes of
 * the built workflow, so it is checked rather than derived. A module missing
 * from the list is a ReferenceError in n8n; one nothing uses is dead weight.
 */

/** Where list entries resolve from: tools/n8n, as `moduleScript` reads them. */
const BASE = new URL('./', import.meta.url);

interface ParsedModule {
  readonly imports: readonly string[];
  readonly exports: readonly string[];
}

/** The modules a source needs at run time: type-only imports leave nothing behind. */
function valueImports(source: ts.SourceFile): string[] {
  return source.statements.flatMap((statement) => {
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) {
      return statement.isTypeOnly ? [] : [(statement.moduleSpecifier as ts.StringLiteral).text];
    }
    if (!ts.isImportDeclaration(statement)) return [];
    const clause = statement.importClause;
    const named = clause?.namedBindings;
    const typeOnly =
      clause !== undefined &&
      (clause.isTypeOnly ||
        (clause.name === undefined &&
          named !== undefined &&
          ts.isNamedImports(named) &&
          named.elements.every((each) => each.isTypeOnly)));
    return typeOnly ? [] : [(statement.moduleSpecifier as ts.StringLiteral).text];
  });
}

function parseModule(url: URL): ParsedModule {
  const text = readFileSync(url, 'utf8');
  const source = ts.createSourceFile(url.pathname, text, ts.ScriptTarget.ES2022, true);
  return {
    imports: valueImports(source).map((each) => new URL(each, url).href),
    exports: exportedValues(source),
  };
}

/** A module's place, as a list here would name it: from tools/n8n. */
const shown = (url: string) => relative(fileURLToPath(BASE), fileURLToPath(url));

function usedByRun(names: readonly string[], runs: readonly string[]): boolean {
  return names.some((name) => runs.some((run) => new RegExp(`\\b${name}\\b`).test(run)));
}

/**
 * What is wrong with one Code-node module list, given the `run` lines of
 * every node built from it: each import a module needs must be listed before
 * it, and each listed module must be imported by another or used by a node.
 * An empty answer means the list is right.
 */
export function moduleListProblems(modules: readonly string[], runs: readonly string[]): string[] {
  const listed = modules.map((name) => {
    const url = new URL(name, BASE);
    return { name, url: url.href, ...parseModule(url) };
  });
  const missing = listed.flatMap(({ name, imports }, at) =>
    imports
      .filter((dep) => !listed.slice(0, at).some((each) => each.url === dep))
      .map((dep) => `${name} imports ${shown(dep)}, which is not listed before it`),
  );
  const imported = new Set(listed.flatMap(({ imports }) => imports));
  const extra = listed
    .filter(({ url, exports }) => !imported.has(url) && !usedByRun(exports, runs))
    .map(({ name }) => `${name} is listed, but no listed module imports it and no node uses it`);
  return [...missing, ...extra];
}
