/**
 * `no-wait-for-timeout`: a test that waits a time instead of a condition
 * fails when the machine is slow and wastes time when it is fast (#512).
 *
 * Refused everywhere in e2e/: `waitForTimeout`. Refused in specs only: a
 * sleep built from `setTimeout` inside a `new Promise`, and the sleeps of
 * `node:timers/promises`. The host stubs (host.ts, embedding-host.ts) use
 * timers on purpose, to play a slow host.
 */
import { findAll, methodName } from './ast.mjs';

const TIMER_MODULES = new Set(['node:timers/promises', 'timers/promises']);

/** Whether `callee` is `setTimeout`, bare or off `window` or `globalThis`. */
function isSetTimeout(callee) {
  if (callee.type === 'Identifier') return callee.name === 'setTimeout';
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.name === 'setTimeout' &&
    callee.object.type === 'Identifier' &&
    ['window', 'globalThis', 'self'].includes(callee.object.name)
  );
}

/** Each `setTimeout(…)` call in the executor of `new Promise(executor)`. */
function sleepsIn(newPromise) {
  const [executor] = newPromise.arguments;
  if (
    executor === undefined ||
    !['ArrowFunctionExpression', 'FunctionExpression'].includes(executor.type)
  )
    return [];
  return findAll(
    executor.body,
    (each) => each.type === 'CallExpression' && isSetTimeout(each.callee),
  );
}

export const noWaitForTimeout = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      byTime:
        'Wait for a condition, not a time: use a web-first assertion (await expect(locator).toHaveText(…)) or await expect.poll(() => …).toBe(…). To show that nothing happens, first wait for what would have made it happen.',
    },
  },
  create(context) {
    const inSpec = context.filename.endsWith('.spec.ts');
    const report = (node) => context.report({ node, messageId: 'byTime' });
    const timerModule = (source) => source?.type === 'Literal' && TIMER_MODULES.has(source.value);
    return {
      CallExpression(node) {
        if (methodName(node) === 'waitForTimeout') report(node);
      },
      NewExpression(node) {
        const isPromise = node.callee.type === 'Identifier' && node.callee.name === 'Promise';
        if (inSpec && isPromise) sleepsIn(node).forEach(report);
      },
      ImportDeclaration(node) {
        if (inSpec && timerModule(node.source)) report(node);
      },
      ImportExpression(node) {
        if (inSpec && timerModule(node.source)) report(node);
      },
    };
  },
};
