import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';

/**
 * Where the focus goes when a dialog opened by a click closes (#658, PR #705):
 * WebKit does not focus a clicked button, so the dialog opened with nothing
 * holding the focus, and `useReturnFocus` hands it to the app's fallback — the
 * note being edited — rather than letting it fall to `<body>`. On the desktop,
 * with the sidebar beside the work, as on every width.
 */

const TODAY = ['# Today', '', 'First paragraph.', ''].join('\n');

async function openToday(page: Page): Promise<void> {
  const vault = await createVault();
  await vault.mkdir('Notes');
  await vault.write('Notes/today.md', TODAY);
  await vault.write('Notes/other.md', '# Other\n\nBody.\n');
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Notes' }).click();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'today', exact: true })
    .click();
  await expect(page.getByRole('article', { name: 'today' })).toBeVisible();
}

const focusHolder = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) return 'body';
    if (active.closest('[contenteditable="true"]') !== null) return 'the editor';
    return `${active.tagName.toLowerCase()} ${active.getAttribute('aria-label') ?? active.className}`;
  });

test('Settings opened by a click and closed with Escape leaves the focus in the note, not on the body', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openToday(page);
  // Settings sits in the sidebar's footer; the click focuses nothing in WebKit.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null))
    .toBe(true);

  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect.poll(() => focusHolder(page)).toBe('the editor');
});
