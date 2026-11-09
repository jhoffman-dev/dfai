/**
 * Lint rules for the three shapes most flaky e2e tests share (issue #798).
 * Each message names what to use instead; the helpers are in e2e/typing.ts,
 * e2e/caret.ts and e2e/scrolling.ts. Each rule's module says what it refuses.
 *
 * - `no-keys-after-focus`: a key the moment after focus() or a click.
 * - `no-one-shot-read`: a Locator's value read once and asserted on.
 * - `no-wait-for-timeout`: a wait by time instead of a condition.
 *
 * Its own plugin, not `no-restricted-syntax`: a file's `no-restricted-syntax`
 * is replaced by any later block that sets it, and the End/Home rule for e2e
 * already does, with its own ignores.
 */
import { noKeysAfterFocus } from './no-keys-after-focus.mjs';
import { noOneShotRead } from './no-one-shot-read.mjs';
import { noWaitForTimeout } from './no-wait-for-timeout.mjs';

export const e2eFlake = {
  rules: {
    'no-wait-for-timeout': noWaitForTimeout,
    'no-one-shot-read': noOneShotRead,
    'no-keys-after-focus': noKeysAfterFocus,
  },
};
