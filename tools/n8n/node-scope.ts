import ts from 'typescript';

/*
 * What decides whether a list's module code can be checked once for all its
 * nodes (#825). The modules' code runs in the node's scope, so a node's own
 * lines can change what a name in that code means only by declaring it. When
 * no node declares a name the module code takes from outside itself, every
 * node sees that code the same way, and one check of it is enough.
 */

/** Where an identifier names a member or a key rather than reading a variable. */
function isMemberName(node: ts.Identifier): boolean {
  const { parent } = node;
  return (
    ((ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
      parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node)
  );
}

/** The variable an identifier reads: for `{ name }`, the value, not the property it makes. */
function variableRead(checker: ts.TypeChecker, node: ts.Identifier): ts.Symbol | undefined {
  const { parent } = node;
  return ts.isShorthandPropertyAssignment(parent) && parent.name === node
    ? checker.getShorthandAssignmentValueSymbol(parent)
    : checker.getSymbolAtLocation(node);
}

/**
 * The names the code in `[start, end)` reads from outside that range: names
 * nothing declares, and names declared elsewhere (another module's
 * `const { … }`, n8n's globals, the language's own).
 */
export function namesFromOutside(
  checker: ts.TypeChecker,
  source: ts.SourceFile,
  range: { readonly start: number; readonly end: number },
): Set<string> {
  const outside = new Set<string>();
  const inRange = (each: ts.Declaration) =>
    each.getSourceFile() === source && range.start <= each.pos && each.end <= range.end;
  const visit = (node: ts.Node): void => {
    if (node.end <= range.start || node.pos >= range.end) return;
    if (ts.isIdentifier(node) && !isMemberName(node) && node.getStart(source) >= range.start) {
      const declarations = variableRead(checker, node)?.declarations ?? [];
      if (!declarations.some(inRange)) outside.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return outside;
}

/**
 * Every name a node's own lines declare, at any depth except as a
 * parameter: more than the names in their top scope, which can only send a
 * list to the full check, never let one through.
 */
export function namesDeclared(run: string): Set<string> {
  const source = ts.createSourceFile(
    'run.js',
    `async function run() {\n${run}\n}`,
    ts.ScriptTarget.ES2022,
    true,
  );
  const declared = new Set<string>();
  const visit = (node: ts.Node): void => {
    const named =
      ts.isVariableDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      (ts.isBindingElement(node) && !ts.isParameter(node.parent.parent));
    if (named && node.name !== undefined && ts.isIdentifier(node.name))
      declared.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source.statements[0] as ts.FunctionDeclaration, visit);
  return declared;
}
