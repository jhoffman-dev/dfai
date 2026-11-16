import ts from 'typescript';

/*
 * The names a Code node's own lines take from outside them (#825): what they
 * read but never declare. Read from the syntax tree, so a name in a comment or
 * a string is not a use. Scopes are not tracked: a name declared anywhere in
 * the lines counts as theirs, which can only hide a use, never invent one.
 */

/** Where an identifier is a name rather than a use: `a.name`, `{ name: … }`, a label. */
function isUse(node: ts.Identifier): boolean {
  const { parent } = node;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
  return true;
}

/** What the lines declare: variables, functions, parameters, a caught error. */
function declaredName(node: ts.Identifier): boolean {
  const { parent } = node;
  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent)) &&
    parent.name === node
  );
}

/**
 * The names `run` uses and does not declare. The lines are a function body
 * in n8n (they `return` and `await`), so they are read as one.
 */
export function namesFromOutside(run: string): Set<string> {
  const body = `async function run() {\n${run}\n}`;
  const source = ts.createSourceFile('run.js', body, ts.ScriptTarget.ES2022, true);
  const used = new Set<string>();
  const declared = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (declaredName(node)) declared.add(node.text);
      else if (isUse(node)) used.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source.statements[0] as ts.FunctionDeclaration, visit);
  declared.add('run');
  return new Set([...used].filter((name) => !declared.has(name)));
}
