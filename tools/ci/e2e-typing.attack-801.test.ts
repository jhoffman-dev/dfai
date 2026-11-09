// @vitest-environment jsdom
/*
 * Attack on PR #801: e2e/typing.ts's expectFocusIn, run against a DOM in
 * jsdom through a stand-in Locator that only evaluates. clickThenType relies
 * on it to say the focus is where the typing is meant to go.
 */
import type { Locator } from '@playwright/test';
import { afterEach, describe, expect, it } from 'vitest';
import { expectFocusIn } from '../../e2e/typing.ts';

/** A Locator for `element` that can only run a function on it, as expectFocusIn does. */
function locatorFor(element: Element): Locator {
  const evaluate = (run: (target: Element) => unknown) => Promise.resolve(run(element));
  return { evaluate } as unknown as Locator;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('expectFocusIn (attack #801)', () => {
  it('passes when the target itself holds the focus', async () => {
    document.body.innerHTML = '<div role="row" tabindex="0"><input aria-label="Project"></div>';
    const field = document.querySelector('input')!;
    field.focus();
    await expectFocusIn(locatorFor(field));
  });

  // A focusable row or list around a field holds the focus before the click on
  // the field lands: keys typed then go to the row's shortcuts, not the field.
  it('does not pass while a focusable ancestor, not the field, holds the focus', async () => {
    document.body.innerHTML = '<div role="row" tabindex="0"><input aria-label="Project"></div>';
    const row = document.querySelector<HTMLElement>('[role="row"]')!;
    const field = document.querySelector('input')!;
    row.focus();
    await expect(expectFocusIn(locatorFor(field))).rejects.toThrow();
  }, 15_000);
});
