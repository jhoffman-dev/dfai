/** Reading the syntax tree, shared by the e2e-flake rules. */

export const FUNCTIONS = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
  'FunctionDeclaration',
]);

/** The name of the method `node` calls, or null when it calls no method. */
export function methodName(node) {
  if (node?.type !== 'CallExpression') return null;
  const { callee } = node;
  if (callee.type !== 'MemberExpression' || callee.computed) return null;
  return callee.property.type === 'Identifier' ? callee.property.name : null;
}

/** The call `statement` awaits, as `await x.y(…);`, or null. */
export function awaitedCall(statement) {
  if (statement?.type !== 'ExpressionStatement') return null;
  const { expression } = statement;
  return expression.type === 'AwaitExpression' && expression.argument.type === 'CallExpression'
    ? expression.argument
    : null;
}

/** Each child node of `node`. */
export function childrenOf(node) {
  const children = [];
  for (const [key, child] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(child)) children.push(...child.filter(isNode));
    else if (isNode(child)) children.push(child);
  }
  return children;
}

function isNode(value) {
  return value !== null && typeof value === 'object' && typeof value.type === 'string';
}

/** Each node in `node` that `matches`, not looking inside functions, which run later. */
export function findAll(node, matches, found = []) {
  if (!isNode(node) || FUNCTIONS.has(node.type)) return found;
  if (matches(node)) found.push(node);
  for (const child of childrenOf(node)) findAll(child, matches, found);
  return found;
}

/** Whether `node` awaits anything, outside the functions in it. */
export function awaits(node) {
  return findAll(node, (each) => each.type === 'AwaitExpression').length > 0;
}

/** Whether `node` is `expect(…)` or `expect.soft(…)`, the assertions that do not retry. */
export function isOneShotExpect(node) {
  if (node?.type !== 'CallExpression') return false;
  const { callee } = node;
  if (callee.type === 'Identifier') return callee.name === 'expect';
  return isExpectMember(callee, 'soft');
}

/** Whether `node` is any assertion call: `expect(…)`, `expect.soft(…)` or `expect.poll(…)`. */
export function isExpect(node) {
  return (
    isOneShotExpect(node) ||
    (node?.type === 'CallExpression' && isExpectMember(node.callee, 'poll'))
  );
}

function isExpectMember(callee, name) {
  return (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'expect' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    callee.property.name === name
  );
}

/** The matcher call on `expectCall`: the `.toBe(…)` of `expect(x).not.toBe(…)`, or null. */
export function matcherOf(expectCall) {
  let chain = expectCall;
  while (chain.parent?.type === 'MemberExpression' && chain.parent.object === chain)
    chain = chain.parent;
  const call = chain.parent;
  return chain !== expectCall && call?.type === 'CallExpression' && call.callee === chain
    ? call
    : null;
}

/** Whether `node` is the block of `expect(async () => …).toPass()`, which runs again on each try. */
export function isRetried(node) {
  const { parent } = node;
  return (
    FUNCTIONS.has(node.type) &&
    parent?.type === 'CallExpression' &&
    parent.callee.type === 'Identifier' &&
    parent.callee.name === 'expect' &&
    parent.arguments[0] === node
  );
}

/** The variable `identifier` names, looked up from its own scope outwards, or null. */
export function variableOf(sourceCode, identifier) {
  for (let scope = sourceCode.getScope(identifier); scope !== null; scope = scope.upper) {
    const found = scope.set.get(identifier.name);
    if (found !== undefined) return found;
  }
  return null;
}
