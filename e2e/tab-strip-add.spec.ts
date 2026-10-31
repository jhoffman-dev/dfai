import { expect, test, type Locator, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection, splitWindow } from './host.ts';

/*
 * #410: the tab strip's + (new tab) sits right after the last tab at every
 * window width. Titles longer than a tab used to size the tab list by their
 * text while the tabs themselves stayed 176px, so on a wide window the + sat
 * out in the strip with empty space before it. Real notes have long titles,
 * so these do too.
 */

const WIDTHS = [1280, 1920, 2560] as const;
const NOTES = [
  'alpha notes from the quarterly planning meeting',
  'beta notes on the garden shed rebuild plans',
  'gamma notes for the weekly review and the backlog',
] as const;
/** How far the + may sit from the last tab's right edge (its border, rounding). */
const SNUG_PX = 8;

async function openVault(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  const vault = await createVault();
  for (const name of NOTES) await vault.write(`${name}.md`, `# ${name}\n\nA note.\n`);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
}

const row = (page: Page, name: string) =>
  sidebarSection(page, 'userSpace').getByRole('treeitem', { name, exact: true });
const pane = (page: Page, which: 1 | 2) => page.getByRole('region', { name: `Pane ${which}` });
const strip = (page: Page, which: 1 | 2) =>
  page.getByRole('tablist', { name: `Pane ${which} tabs` });
const tabsOf = (page: Page, which: 1 | 2) => strip(page, which).getByRole('tab');
const addOf = (page: Page, which: 1 | 2) =>
  pane(page, which).getByRole('button', { name: 'New tab', exact: true });

/** Opens the first `count` notes, each in a tab of its own, in pane 1. */
async function openTabs(page: Page, count: 1 | 3) {
  await row(page, NOTES[0]).click();
  for (const name of NOTES.slice(1, count)) {
    await row(page, name).click({ modifiers: ['Meta'] });
  }
  await expect(tabsOf(page, 1)).toHaveCount(count);
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error('expected a laid-out element');
  return found;
}

/** The + must start where the last tab ends, give or take its border. */
async function expectAddSnugAfterLastTab(page: Page, which: 1 | 2) {
  const lastTab = await box(tabsOf(page, which).last());
  const add = await box(addOf(page, which));
  const gap = add.x - (lastTab.x + lastTab.width);
  expect(gap, `pane ${which}: + is ${gap}px from the last tab`).toBeGreaterThanOrEqual(-1);
  expect(gap, `pane ${which}: + is ${gap}px from the last tab`).toBeLessThanOrEqual(SNUG_PX);
}

for (const width of WIDTHS) {
  for (const count of [1, 3] as const) {
    test(`at ${width}px with ${count} tab(s), the + sits right after the last tab`, async ({
      page,
    }) => {
      await openVault(page, width);
      await openTabs(page, count);
      await expectAddSnugAfterLastTab(page, 1);
    });
  }

  test(`at ${width}px in a split, each pane's + sits right after its own last tab`, async ({
    page,
  }) => {
    await openVault(page, width);
    await openTabs(page, 3);
    await splitWindow(page);
    await expect(pane(page, 2)).toBeVisible();
    await expect(tabsOf(page, 2)).toHaveCount(1);
    await expectAddSnugAfterLastTab(page, 1);
    await expectAddSnugAfterLastTab(page, 2);
  });
}

test('with more tabs than fit, the + stays visible, clear of the tabs, and still opens one', async ({
  page,
}) => {
  await openVault(page, 1280);
  await openTabs(page, 1);
  for (let opened = 2; opened <= 14; opened += 1) {
    await page.keyboard.press('Meta+t');
    await expect(tabsOf(page, 1)).toHaveCount(opened);
  }
  const list = await box(strip(page, 1));
  const add = await box(addOf(page, 1));
  const paneBox = await box(pane(page, 1));
  // Beside the scrolling list, never over a tab, and inside the pane.
  expect(add.x).toBeGreaterThanOrEqual(list.x + list.width - 1);
  expect(add.x + add.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 1);
  // The list scrolls rather than pushing the + out.
  const scrolls = await strip(page, 1).evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(scrolls).toBe(true);
  await addOf(page, 1).click();
  await expect(tabsOf(page, 1)).toHaveCount(15);
});
