/**
 * `no-one-shot-read`: a Locator's value read once and asserted on races the
 * app (#517, #695, #719, #748). A web-first assertion or `expect.poll` reads
 * again until it holds.
 *
 * Refused: a read awaited in `expect(…)` or in its matcher's arguments, and a
 * read kept in a variable whose only use is as what an `expect(…)` is about,
 * whatever it is compared with: an "after" read can land before the action
 * does. Allowed: a baseline read before an action, kept as the value an
 * assertion expects (`toHaveCount(before + 1)`), and any read inside
 * `expect(async () => …).toPass()`, which runs again on each try.
 * `page.evaluate` is a question to the page, not a Locator read.
 */
import { findAll, isExpect, isOneShotExpect, isRetried, matcherOf, methodName } from './ast.mjs';

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
  evaluate: null,
  evaluateAll: null,
};

const EVALUATES = new Set(['evaluate', 'evaluateAll']);
/** What a page or a frame is called: its `evaluate` asks the page, not a Locator. */
const PAGE_LIKE = /(^|[a-z])(page|frame|Page|Frame)$/;

/** Whether `receiver`, the object a method is called on, is a page or frame rather than a Locator. */
function isPageLike(receiver) {
  if (receiver.type === 'Identifier') return PAGE_LIKE.test(receiver.name);
  if (receiver.type === 'CallExpression')
    return ['page', 'mainFrame'].includes(methodName(receiver));
  return (
    receiver.type === 'MemberExpression' &&
    !receiver.computed &&
    PAGE_LIKE.test(receiver.property.name ?? '')
  );
}

/** The read `call` makes of a Locator, or null when it makes none. */
function readOf(call) {
  const read = methodName(call);
  if (read === null || !Object.hasOwn(WAITING_ASSERTION, read)) return null;
  if (EVALUATES.has(read) && isPageLike(call.callee.object)) return null;
  return read;
}

/** Each `await x.<read>()` in `node`, outside functions. */
function awaitedReads(node) {
  return findAll(node, (each) => each.type === 'AwaitExpression' && readOf(each.argument) !== null);
}

/** The `expect(…)` that `identifier` is what it is about, through `.x`, `!`, `?.` and method calls; or null. */
function expectAbout(identifier) {
  let node = identifier;
  for (;;) {
    const { parent } = node;
    if (isOneShotExpect(parent) && parent.arguments[0] === node) return parent;
    const goesOn =
      (parent.type === 'MemberExpression' && parent.object === node) ||
      (parent.type === 'CallExpression' && parent.callee === node) ||
      parent.type === 'TSNonNullExpression' ||
      parent.type === 'ChainExpression';
    if (!goesOn) return null;
    node = parent;
  }
}

function report(context, node, read) {
  const instead = WAITING_ASSERTION[read];
  context.report({
    node,
    messageId: instead === null ? 'readOncePoll' : 'readOnce',
    data: { read, instead: instead ?? '' },
  });
}

const ONCE = 'reads once and races the app: use';

export const noOneShotRead = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      readOnce: `expect(await locator.{{read}}()) ${ONCE} await expect(locator).{{instead}}, or await expect.poll(() => locator.{{read}}()).`,
      readOncePoll: `expect(await locator.{{read}}()) ${ONCE} await expect.poll(() => locator.{{read}}()).`,
      keptOnce:
        '{{name}} keeps one read of locator.{{read}}() and is only asserted on, so it races the app: assert on the locator with a web-first assertion, or await expect.poll(() => locator.{{read}}()).',
    },
  },
  create(context) {
    const { sourceCode } = context;
    const retried = (node) => sourceCode.getAncestors(node).some(isRetried);

    /** Whether every use of the variable `declarator` names is what an `expect` is about. */
    function onlyAsserted(declarator) {
      const [variable] = sourceCode.getDeclaredVariables(declarator);
      const uses = (variable?.references ?? []).filter((reference) => !reference.init);
      if (uses.length === 0) return false;
      return uses.every((use) => {
        const assertion = expectAbout(use.identifier);
        const matcher = assertion === null ? null : matcherOf(assertion);
        return matcher !== null;
      });
    }

    return {
      CallExpression(node) {
        const inExpect = isOneShotExpect(node) && node.arguments.length > 0;
        const root = node.callee.type === 'MemberExpression' ? rootOf(node.callee) : null;
        const inMatcher = root !== null && isExpect(root);
        if ((!inExpect && !inMatcher) || retried(node)) return;
        const checked = inExpect ? [node.arguments[0]] : node.arguments;
        for (const at of checked.flatMap(awaitedReads)) report(context, at, readOf(at.argument));
      },
      VariableDeclarator(node) {
        const { id, init } = node;
        if (id.type !== 'Identifier' || init?.type !== 'AwaitExpression') return;
        const read = readOf(init.argument);
        if (read === null || retried(node) || !onlyAsserted(node)) return;
        context.report({ node: init, messageId: 'keptOnce', data: { name: id.name, read } });
      },
    };
  },
};

/** The call a matcher's chain starts from: the `expect(x)` of `expect(x).not.toBe`, or null. */
function rootOf(callee) {
  let object = callee.object;
  while (object.type === 'MemberExpression') object = object.object;
  return object.type === 'CallExpression' ? object : null;
}
