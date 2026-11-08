/**
 * Lint rules for the three shapes most flaky e2e tests share (issue #798).
 * Each message names what to use instead; the helpers are in e2e/typing.ts and
 * e2e/caret.ts.
 *
 * - `no-wait-for-timeout`: a test that waits a time instead of a condition
 *   fails when the machine is slow and wastes time when it is fast (#512).
 * - `no-one-shot-read`: `expect(await locator.textContent())` reads once and
 *   races the app; a web-first assertion or `expect.poll` waits (#517, #695).
 * - `no-keys-after-focus`: a key pressed the moment after `focus()` or a click
 *   can land before the focus or the caret does (#445, #489, #775).
 *
 * Its own plugin, not `no-restricted-syntax`: a file's `no-restricted-syntax`
 * is replaced by any later block that sets it, and the End/Home rule for e2e
 * already does, with its own ignores.
 */

/** A Locator's one-shot reads, each with the assertion that waits instead, or null for none. */
const WAITING_ASSERTION = {
  textContent: 'toHaveText / toContainText',
  innerText: 'toHaveText / toContainText',
  allTextContents: 'toHaveText([…])',
  allInnerTexts: 'toHaveText([…])',
  innerHTML: null,
  inputValue: 'toHaveValue',
  getAttribute: 'toHaveAttribute',
  count: 'toHaveCount',
  isVisible: 'toBeVisible',
  isHidden: 'toBeHidden',
  isChecked: 'toBeChecked',
  isEnabled: 'toBeEnabled',
  isDisabled: 'toBeDisabled',
  isEditable: 'toBeEditable',
  boundingBox: null,
};

/** The name of the method `node` calls, or null when it calls no method. */
function methodName(node) {
  if (node?.type !== 'CallExpression') return null;
  const { callee } = node;
  if (callee.type !== 'MemberExpression' || callee.computed) return null;
  return callee.property.type === 'Identifier' ? callee.property.name : null;
}

/** The call `statement` awaits, as `await x.y(…);`, or null. */
function awaitedCall(statement) {
  if (statement.type !== 'ExpressionStatement') return null;
  const { expression } = statement;
  return expression.type === 'AwaitExpression' && expression.argument.type === 'CallExpression'
    ? expression.argument
    : null;
}

/** Whether `call` is `<…>.keyboard.<method>(…)` for one of `methods`. */
function isKeyboard(call, methods) {
  const { callee } = call;
  const on = callee.object;
  return (
    methods.has(methodName(call)) &&
    on.type === 'MemberExpression' &&
    !on.computed &&
    on.property.type === 'Identifier' &&
    on.property.name === 'keyboard'
  );
}

const ANY_KEY = new Set(['press', 'type', 'insertText', 'down']);
const TEXT = new Set(['type', 'insertText']);

/** Whether `next` is a key that may land before `previous`'s focus or caret. */
function keysTooSoon(previous, next) {
  const before = awaitedCall(previous);
  const after = awaitedCall(next);
  if (before === null || after === null) return false;
  const moved = methodName(before);
  // A click before a shortcut or Escape is fine; a click before typing is not.
  if (moved === 'focus') return isKeyboard(after, ANY_KEY);
  if (moved === 'click') return isKeyboard(after, TEXT);
  return false;
}

const noKeysAfterFocus = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      tooSoon:
        'A key pressed right after focus() or a click can land before the focus or the caret does: use focusThenPress, focusThenType or clickThenType from e2e/typing.ts, or caretAtLineEnd / caretAtNoteEnd from e2e/caret.ts in the editor.',
    },
  },
  create(context) {
    function check(statements) {
      for (let i = 1; i < statements.length; i += 1) {
        if (keysTooSoon(statements[i - 1], statements[i]))
          context.report({ node: statements[i], messageId: 'tooSoon' });
      }
    }
    return {
      Program: (node) => check(node.body),
      BlockStatement: (node) => check(node.body),
      SwitchCase: (node) => check(node.consequent),
    };
  },
};

const noWaitForTimeout = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      byTime:
        'Wait for a condition, not a time: use a web-first assertion (await expect(locator).toHaveText(…)) or await expect.poll(() => …).toBe(…). To show that nothing happens, first wait for what would have made it happen.',
    },
  },
  create: (context) => ({
    CallExpression(node) {
      if (methodName(node) === 'waitForTimeout') context.report({ node, messageId: 'byTime' });
    },
  }),
};

/** Whether `node` is `expect(…)` or `expect.soft(…)`, the assertions that do not retry. */
function isOneShotExpect(node) {
  const { callee } = node;
  if (callee.type === 'Identifier') return callee.name === 'expect';
  return (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'expect' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'soft'
  );
}

const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression']);

/** Each `await x.<read>()` in `node`, not counting inside a function, which may retry. */
function awaitedReads(node, found = []) {
  if (node === null || typeof node !== 'object' || FUNCTIONS.has(node.type)) return found;
  if (node.type === 'AwaitExpression') {
    const read = methodName(node.argument);
    if (read !== null && Object.hasOwn(WAITING_ASSERTION, read)) found.push({ node, read });
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(child)) child.forEach((each) => awaitedReads(each, found));
    else if (child !== null && typeof child === 'object' && 'type' in child)
      awaitedReads(child, found);
  }
  return found;
}

/** Whether `node` is the block of `expect(async () => …).toPass()`, which reads again on each try. */
function isRetried(node) {
  const { parent } = node;
  return (
    FUNCTIONS.has(node.type) &&
    parent?.type === 'CallExpression' &&
    parent.callee.type === 'Identifier' &&
    parent.callee.name === 'expect' &&
    parent.arguments[0] === node
  );
}

const noOneShotRead = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      readOnce:
        'expect(await locator.{{read}}()) reads once and races the app: use await expect(locator).{{instead}}, or await expect.poll(() => locator.{{read}}()).',
      readOncePoll:
        'expect(await locator.{{read}}()) reads once and races the app: use await expect.poll(() => locator.{{read}}()).',
    },
  },
  create: (context) => ({
    CallExpression(node) {
      if (!isOneShotExpect(node) || node.arguments.length === 0) return;
      if (context.sourceCode.getAncestors(node).some(isRetried)) return;
      for (const { node: at, read } of awaitedReads(node.arguments[0]))
        context.report({
          node: at,
          messageId: WAITING_ASSERTION[read] === null ? 'readOncePoll' : 'readOnce',
          data: { read, instead: WAITING_ASSERTION[read] ?? '' },
        });
    },
  }),
};

export const e2eFlake = {
  rules: {
    'no-wait-for-timeout': noWaitForTimeout,
    'no-one-shot-read': noOneShotRead,
    'no-keys-after-focus': noKeysAfterFocus,
  },
};
