import { expect, type Page } from './fixtures.ts';
import { createVault, openVaultByTouch, sidebarSection } from './host.ts';

// #902 on a touch screen, as a first run has it: the sidebar is a drawer, and
// its header's "Sidebar options" is the one visible way to Pages. Shared by
// the ipad and phone specs, which differ only in the window.

export async function openFirstRunByTouch(page: Page): Promise<void> {
  const vault = await createVault();
  await vault.mkdir('Notes');
  await vault.write('Garden.md', '# Garden\n\nBeds and paths.\n');
  await vault.write('Notes/Seed list.md', '# Seed list\n');
  await openVaultByTouch(page, vault, { sidebarAsFirstRun: true });
}

/** Opens the drawer, shows Pages from its header by touch, and checks it held. */
export async function showPagesInTheDrawerByTouch(page: Page): Promise<void> {
  const drawer = page.getByRole('dialog', { name: 'Sidebar' });
  await page.getByRole('button', { name: 'Show sidebar' }).first().tap();
  await expect(drawer).toBeVisible();
  await expect(sidebarSection(page, 'userSpace')).toHaveCount(0);

  const options = drawer.getByRole('button', { name: 'Sidebar options' });
  await expect(options).toBeVisible();
  // 44px to the finger, as every control under a coarse pointer.
  await expect
    .poll(async () => {
      const box = await options.boundingBox();
      return box === null ? 0 : Math.min(box.width, box.height);
    })
    .toBeGreaterThanOrEqual(44);

  await expectHeaderFitsWithALongName(page);

  await options.tap();
  const showPages = page.getByRole('menuitemcheckbox', { name: 'Show Pages' });
  await expect(showPages).toHaveAttribute('aria-checked', 'false');
  await showPages.tap();
  await expect(showPages).toHaveAttribute('aria-checked', 'true');

  // The drawer stays open, and the tree is drawn in it.
  await expect(drawer).toBeVisible();
  await expect(
    sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Garden', exact: true }),
  ).toBeVisible();
}

/**
 * The header's three 44px buttons stay inside the drawer however long the
 * vault's name: the name gives way. The name is lengthened in place, as a
 * temp folder's cannot be chosen; the layout is what is measured.
 */
async function expectHeaderFitsWithALongName(page: Page): Promise<void> {
  const drawer = page.getByRole('dialog', { name: 'Sidebar' });
  await drawer.locator('.vault-header__label').evaluate((label) => {
    label.textContent = 'The Larkspur Payroll field notes, kept since the very first season';
  });
  await expect
    .poll(() =>
      drawer.evaluate((popup) => {
        const edge = popup.getBoundingClientRect().right;
        const buttons = [...popup.querySelectorAll('.vault-header .icon-button')];
        return (
          buttons.length === 3 && buttons.every((b) => b.getBoundingClientRect().right <= edge)
        );
      }),
    )
    .toBe(true);
}
