import { expect, type Page } from './fixtures.ts';

/**
 * Where the focus is with a modal dialog open (#827): in the dialog, on one of
 * the focus guards Base UI draws beside that dialog's popup, on a toast, on the
 * body, or in the app behind it, which it must never be.
 */
export type ModalFocus = 'dialog' | 'guard' | 'toast' | 'body' | `the app: ${string}`;

export function modalFocus(page: Page, dialog: string): Promise<ModalFocus> {
  return page.evaluate((name): ModalFocus => {
    const active = document.activeElement;
    if (active === null || active === document.body) return 'body';
    const popup = `[role="dialog"][aria-label="${name}"]`;
    if (active.closest(popup) !== null) return 'dialog';
    // Only a guard beside this dialog's popup is its own, not another layer's.
    const guard = active.matches('[data-base-ui-focus-guard]');
    if (guard && (active.parentElement?.querySelector(`:scope > ${popup}`) ?? null) !== null)
      return 'guard';
    if (active.closest('.toast') !== null) return 'toast';
    return `the app: ${active.tagName.toLowerCase()}.${String(active.className)}`;
  }, dialog);
}

/**
 * Presses Tab and waits for the focus to settle where it may: in the dialog,
 * or on a toast when `toast` is allowed. Tab from the body reaches the dialog's
 * leading guard, which hands the focus on a frame later; on a slow CI run it
 * once kept it. So a guard is only passed through: one more Tab from it must
 * land in the dialog itself. Returns where the focus settled.
 */
export async function tabWithin(
  page: Page,
  { dialog, toast = false }: { dialog: string; toast?: boolean },
): Promise<'dialog' | 'toast'> {
  const settled = toast ? /^(dialog|guard|toast)$/ : /^(dialog|guard)$/;
  await page.keyboard.press('Tab');
  await expect.poll(() => modalFocus(page, dialog)).toMatch(settled);
  const at = await modalFocus(page, dialog);
  if (at === 'toast' || at === 'dialog') return at;
  if (at !== 'guard') throw new Error(`the focus left the modal: ${at}`);
  await page.keyboard.press('Tab');
  await expect.poll(() => modalFocus(page, dialog)).toBe('dialog');
  return 'dialog';
}
