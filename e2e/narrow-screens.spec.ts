import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection, splitWindow, type FakeVault } from './host.ts';
import { caretAtLineEnd } from './caret.ts';

/**
 * Narrow screens (#658): under 944px — an iPad held upright, a phone — the
 * sidebar is a drawer over the work and one pane shows. At 1180, an iPad on
 * its side, and on the desktop, nothing changes. The widths here are the
 * devices', not the rule's: the rule's own edge is held in the domain's test.
 */

const IPAD_PORTRAIT = { width: 820, height: 1180 };
const IPAD_LANDSCAPE = { width: 1180, height: 820 };
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

const TODAY = ['# Today', '', 'First paragraph.', ''].join('\n');
const ANOTHER = ['# Another Note', '', 'The target.', ''].join('\n');

async function openVault(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('Notes');
  await vault.write('Notes/today.md', TODAY);
  await vault.write('Notes/Another Note.md', ANOTHER);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

const drawer = (page: Page) => page.getByRole('dialog', { name: 'Vault' });
const sidebarNav = (page: Page) => page.getByRole('navigation', { name: 'Vault' });
const showSidebar = (page: Page) => page.getByRole('button', { name: 'Show sidebar' });
const pane = (page: Page, which: 1 | 2) => page.getByRole('region', { name: `Pane ${which}` });
const tabsOf = (page: Page, which: 1 | 2) =>
  page.getByRole('tablist', { name: `Pane ${which} tabs` }).getByRole('tab');

/** Opens the drawer and, in it, the Notes folder, so its notes are rows. */
async function openDrawerOnNotes(page: Page): Promise<void> {
  await showSidebar(page).click();
  await expect(drawer(page)).toBeVisible();
  const folder = sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Notes' });
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.click();
  await expect(
    sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'today', exact: true }),
  ).toBeVisible();
}

/** Nothing scrolls sideways: not the page, not the work's column. */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.documentElement;
        const main = document.querySelector('.shell__main');
        return {
          page: root.scrollWidth - root.clientWidth,
          main: main === null ? null : main.scrollWidth - main.clientWidth,
        };
      }),
    )
    .toEqual({ page: 0, main: 0 });
}

test.describe('an iPad held upright', () => {
  test.use({ viewport: IPAD_PORTRAIT });

  test('the sidebar is a drawer: opened by its button, kept to the keyboard, closed by Escape', async ({
    page,
  }) => {
    await openVault(page);
    // Not in the flow: the way in is the page's own button.
    await expect(sidebarNav(page)).toHaveCount(0);
    await expect(showSidebar(page)).toBeVisible();

    await showSidebar(page).click();
    await expect(drawer(page)).toBeVisible();
    await expect(drawer(page).getByRole('navigation', { name: 'Vault' })).toBeVisible();
    await expect(drawer(page).getByRole('button', { name: 'Hide sidebar' })).toBeVisible();

    // The focus stays in the drawer however far it is tabbed. Polled: the
    // trap's guard takes the focus for a tick before handing it back inside.
    const focusHolder = () =>
      page.evaluate(() => {
        const active = document.activeElement;
        if (active === null) return 'nothing';
        if (document.querySelector('.shell__drawer')?.contains(active)) return 'the drawer';
        return `${active.tagName.toLowerCase()} ${active.getAttribute('aria-label') ?? active.className}`;
      });
    await expect.poll(focusHolder).toBe('the drawer');
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press('Tab');
      await expect.poll(focusHolder, { message: `tab ${step + 1}` }).toBe('the drawer');
    }
    // The work behind it is out of a reader's reach.
    await expect(
      page.locator('.shell[aria-hidden="true"], [aria-hidden="true"] .shell'),
    ).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);
    // Back to the way in, whatever WebKit focused for the click that opened it.
    await expect(showSidebar(page)).toBeFocused();

    // ⌘\ is the drawer's key, as it is the sidebar's.
    await page.keyboard.press('Meta+\\');
    await expect(drawer(page)).toBeVisible();
    await page.keyboard.press('Meta+\\');
    await expect(drawer(page)).toHaveCount(0);
  });

  test('a page picked in the drawer opens, and the drawer closes behind it', async ({ page }) => {
    await openVault(page);
    await openDrawerOnNotes(page);
    await sidebarSection(page, 'userSpace')
      .getByRole('treeitem', { name: 'today', exact: true })
      .click();
    await expect(drawer(page)).toHaveCount(0);
    await expect(pane(page, 1).getByRole('article', { name: 'today' })).toBeVisible();

    // Its own Hide button closes it too.
    await showSidebar(page).click();
    await drawer(page).getByRole('button', { name: 'Hide sidebar' }).click();
    await expect(drawer(page)).toHaveCount(0);
  });

  test('one pane only: no split is offered, the key does nothing, ⌘⇧-click opens a tab', async ({
    page,
  }) => {
    await openVault(page);
    await openDrawerOnNotes(page);
    await sidebarSection(page, 'userSpace')
      .getByRole('treeitem', { name: 'today', exact: true })
      .click();
    await expect(pane(page, 1).getByRole('article', { name: 'today' })).toBeVisible();

    await expect(page.getByRole('button', { name: /^Split right/ })).toHaveCount(0);
    await pane(page, 1).getByRole('button', { name: 'More' }).click();
    await expect(page.getByRole('menuitem', { name: /^Save now/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /^Split right/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.keyboard.press('Meta+Shift+\\');
    await expect(pane(page, 2)).toHaveCount(0);
    await expect(pane(page, 1)).toBeVisible();

    await openDrawerOnNotes(page);
    await sidebarSection(page, 'userSpace')
      .getByRole('treeitem', { name: 'Another Note', exact: true })
      .click({ modifiers: ['Meta', 'Shift'] });
    await expect(pane(page, 2)).toHaveCount(0);
    await expect(tabsOf(page, 1)).toHaveCount(2);
    await expect(pane(page, 1).getByRole('article', { name: 'Another Note' })).toBeVisible();
    await expectNoSidewaysScroll(page);
  });
});

test('a split made on a wide window folds to the focused pane and comes back whole', async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await openVault(page);
  await sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Notes' }).click();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'today', exact: true })
    .click();
  await expect(pane(page, 1).getByRole('article', { name: 'today' })).toBeVisible();
  await splitWindow(page);
  await expect(pane(page, 2)).toBeVisible();
  await pane(page, 2).click();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Another Note', exact: true })
    .click();
  await expect(pane(page, 2).getByRole('article', { name: 'Another Note' })).toBeVisible();
  // Typing in the pane that is about to be hidden, left unsaved on purpose.
  await caretAtLineEnd(pane(page, 2).getByText('The target.'));
  await page.keyboard.type(' Kept while narrow.');
  await expect(pane(page, 2).getByText('The target. Kept while narrow.')).toBeVisible();
  // Back to the first pane: that is the one a narrow window will keep showing.
  await pane(page, 1).getByRole('article', { name: 'today' }).click();

  await page.setViewportSize(IPAD_PORTRAIT);
  await expect(pane(page, 1)).toBeVisible();
  await expect(pane(page, 2)).toBeHidden();
  // Hidden, not gone: the pane is still in the page with its note.
  await expect(page.locator('section.pane[hidden]')).toHaveCount(1);
  await expect(sidebarNav(page)).toHaveCount(0);
  await expectNoSidewaysScroll(page);

  await page.setViewportSize(DESKTOP);
  await expect(pane(page, 2)).toBeVisible();
  await expect(pane(page, 2).getByText('The target. Kept while narrow.')).toBeVisible();
  await expect(sidebarNav(page)).toBeVisible();
  await expect(drawer(page)).toHaveCount(0);
});

test('an iPad on its side keeps the sidebar beside the work and may split', async ({ page }) => {
  await page.setViewportSize(IPAD_LANDSCAPE);
  await openVault(page);
  await expect(sidebarNav(page)).toBeVisible();
  await expect(showSidebar(page)).toHaveCount(0);
  await sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Notes' }).click();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'today', exact: true })
    .click();
  await expect(page.getByRole('button', { name: /^Split right/ })).toBeVisible();
  await expectNoSidewaysScroll(page);
});

test('a phone shows one pane and the drawer, with nothing scrolling sideways', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openVault(page);
  await expectNoSidewaysScroll(page);
  await openDrawerOnNotes(page);
  await expectNoSidewaysScroll(page);
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'today', exact: true })
    .click();
  await expect(drawer(page)).toHaveCount(0);
  await expect(pane(page, 1).getByRole('article', { name: 'today' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Split right/ })).toHaveCount(0);
  await expectNoSidewaysScroll(page);
});
