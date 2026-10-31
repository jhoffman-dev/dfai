import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection, splitWindow } from './host.ts';

/*
 * #412: whenever the shown tab changes — opened, switched to from the
 * keyboard, left after a close, or brought back with ⌘⇧T — the tab strip
 * scrolls it fully into view. With fourteen long-titled tabs at 1280px the
 * strip scrolls, and before the fix the shown tab could sit out of sight.
 */

const NOTES = [
  'alpha notes from the quarterly planning meeting',
  'bravo notes on the garden shed rebuild plans',
  'charlie notes for the weekly review and backlog',
  'delta notes about the school fete volunteers',
  'echo notes from the reading group on Thursday',
  'foxtrot notes on the allotment watering rota',
  'golf notes for the bicycle repair workshop',
  'hotel notes about the summer holiday packing',
  'india notes from the choir rehearsal schedule',
  'juliet notes on the kitchen cupboard clear-out',
  'kilo notes for the neighbourhood litter pick',
  'lima notes about the library book returns',
  'mike notes from the swimming club meeting',
  'november notes on the birthday party plans',
] as const;

async function openVault(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  const vault = await createVault();
  for (const name of NOTES) await vault.write(`${name}.md`, `# ${name}\n\nA note.\n`);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
}

const row = (page: Page, name: string) =>
  sidebarSection(page, 'userSpace').getByRole('treeitem', { name, exact: true });
const strip = (page: Page, which: 1 | 2 = 1) =>
  page.getByRole('tablist', { name: `Pane ${which} tabs` });
const pane = (page: Page, which: 1 | 2) => page.getByRole('region', { name: `Pane ${which}` });
const tab = (page: Page, name: string) => strip(page).getByRole('tab', { name, exact: true });

/** The shown tab, its × and borders included, lies inside the strip's visible part. */
async function expectShownTabInView(page: Page, name: string) {
  await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
  await expect
    .poll(() =>
      strip(page).evaluate((list) => {
        const item = list.querySelector('[aria-selected="true"]')?.closest('[data-tab]');
        if (!item) return 'no shown tab';
        const outer = list.getBoundingClientRect();
        const inner = item.getBoundingClientRect();
        // Half a pixel either way for sub-pixel layout.
        return inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5
          ? 'in view'
          : `out of view: tab ${inner.left}–${inner.right}, strip ${outer.left}–${outer.right}`;
      }),
    )
    .toBe('in view');
}

test('the shown tab is scrolled into view when opened, switched to, left after a close, or reopened', async ({
  page,
}) => {
  await openVault(page);
  await row(page, NOTES[0]).click();
  for (const name of NOTES.slice(1)) await row(page, name).click({ modifiers: ['Meta'] });
  await expect(strip(page).getByRole('tab')).toHaveCount(NOTES.length);
  const scrolls = await strip(page).evaluate((list) => list.scrollWidth > list.clientWidth);
  expect(scrolls, 'fourteen tabs at 1280px overflow the strip').toBe(true);
  // Opened: the newest, last, tab.
  await expectShownTabInView(page, NOTES[13]);

  // Switched to from the keyboard: the first, then round to the last again.
  await page.keyboard.press('Meta+1');
  await expectShownTabInView(page, NOTES[0]);
  await page.keyboard.press('Control+Shift+Tab');
  await expectShownTabInView(page, NOTES[13]);

  // Left after a close: ⌘W on the last shows its neighbour.
  await page.keyboard.press('Meta+w');
  await expectShownTabInView(page, NOTES[12]);

  // Reopened: back to the start of the strip, then ⌘⇧T brings the last back.
  await page.keyboard.press('Meta+1');
  await expectShownTabInView(page, NOTES[0]);
  await page.keyboard.press('Meta+Shift+t');
  await expectShownTabInView(page, NOTES[13]);
});

test('a shown tab already in view does not scroll the strip', async ({ page }) => {
  await openVault(page);
  await row(page, NOTES[0]).click();
  for (const name of NOTES.slice(1)) await row(page, name).click({ modifiers: ['Meta'] });
  await page.keyboard.press('Meta+1');
  await expectShownTabInView(page, NOTES[0]);
  await page.keyboard.press('Meta+2');
  await expectShownTabInView(page, NOTES[1]);
  expect(await strip(page).evaluate((list) => list.scrollLeft)).toBe(0);
});

test('the strip stays where it was scrolled when the other pane takes the focus', async ({
  page,
}) => {
  await openVault(page);
  await row(page, NOTES[0]).click();
  for (const name of NOTES.slice(1)) await row(page, name).click({ modifiers: ['Meta'] });
  await expectShownTabInView(page, NOTES[13]);
  await splitWindow(page);
  await expect(strip(page, 2)).toBeVisible();
  // Pane 1 focused, its shown tab the last, then its strip scrolled back to the start by hand.
  await pane(page, 1).getByRole('heading', { name: NOTES[13] }).first().click();
  await expect(pane(page, 1)).toHaveClass(/pane--focused/);
  await strip(page).evaluate((list) => {
    list.scrollLeft = 0;
  });
  // The other pane takes the focus: pane 1's strip is drawn again, its shown tab unchanged.
  await pane(page, 2).getByRole('heading', { name: NOTES[13] }).first().click();
  await expect(pane(page, 2)).toHaveClass(/pane--focused/);
  await expect(pane(page, 1)).not.toHaveClass(/pane--focused/);
  expect(await strip(page).evaluate((list) => list.scrollLeft)).toBe(0);
});
