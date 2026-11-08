/**
 * Pressing and typing only once the page is ready for the keys (#798).
 *
 * `page.keyboard` sends its keys to whatever holds the focus when they
 * arrive. Pressed the moment after `focus()` or a click, under load they can
 * arrive before the focus has landed, or after the app has moved it, and go
 * somewhere else (#445, #489, #698, #775). So each helper here waits until the
 * focus is where the keys are meant for, and only then sends them.
 *
 * In the editor, where the caret is matters as much as the focus: use
 * caretAtLineEnd, caretAtLineStart or caretAtNoteEnd from caret.ts, which wait
 * for the editor's own caret, then type.
 *
 * Lint rules for e2e/ (tools/eslint/e2e-flake.mjs) point here:
 * - `e2e-flake/no-keys-after-focus`: a key right after `focus()`, or typing
 *   right after a click. Use focusThenPress, focusThenType or clickThenType.
 * - `e2e-flake/no-one-shot-read`: `expect(await locator.textContent())` and
 *   the like read once. Use a web-first assertion, which waits
 *   (`await expect(locator).toHaveText(…)`, `toHaveCount`, `toHaveValue`,
 *   `toHaveAttribute`, `toBeVisible`), or `await expect.poll(() => read())`.
 * - `e2e-flake/no-wait-for-timeout`: wait for a condition, never a time.
 */
import { expect, type Locator } from '@playwright/test';

/** Focus `target`, wait until it holds the focus, then press each of `keys` in turn. */
export async function focusThenPress(target: Locator, ...keys: string[]): Promise<void> {
  await focusOn(target);
  for (const key of keys) await target.page().keyboard.press(key);
}

/** Focus `target`, wait until it holds the focus, then type `text`. */
export async function focusThenType(target: Locator, text: string): Promise<void> {
  await focusOn(target);
  await target.page().keyboard.type(text);
}

/**
 * Click `target`, wait until the focus is on it or in it, then type `text`.
 * Not for the editor's text, where the caret matters too: see caret.ts.
 */
export async function clickThenType(target: Locator, text: string): Promise<void> {
  await target.click();
  await expectFocusIn(target);
  await target.page().keyboard.type(text);
}

/**
 * Wait until the focus is on `target`, inside it, or on the element it is
 * inside: a click on a line of text focuses the editor around it.
 */
export async function expectFocusIn(target: Locator): Promise<void> {
  await expect
    .poll(
      () =>
        target.evaluate((element) => {
          const { activeElement: focused, body } = element.ownerDocument;
          // The body holds the focus when nothing does, and it holds every element.
          if (focused === null || focused === body) return false;
          return focused.contains(element) || element.contains(focused);
        }),
      { message: 'the focus to be on, in, or around the target' },
    )
    .toBe(true);
}

async function focusOn(target: Locator): Promise<void> {
  await target.focus();
  await expect(target).toBeFocused();
}
