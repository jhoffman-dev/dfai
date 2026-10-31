import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  expectFile,
  installHost,
  sidebarSection,
  type FakeVault,
  splitWindow,
  closePane,
} from './host.ts';

// U-03: two views side by side. Which pane a click lands in is the thing to get
// right, so most of this is about where a note ends up rather than about how
// the window looks.

const TODAY = ['# Today', '', 'see [[Another Note]] for more', ''].join('\n');
const ANOTHER = ['# Another Note', '', 'The target.', ''].join('\n');
const THIRD = ['# Third Note', '', 'Something else again.', ''].join('\n');

async function openVault(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('Notes');
  await vault.write('Notes/today.md', TODAY);
  await vault.write('Notes/Another Note.md', ANOTHER);
  await vault.write('Notes/Third Note.md', THIRD);

  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Notes' }).click();
  return vault;
}

const pane = (page: Page, which: 1 | 2) => page.getByRole('region', { name: `Pane ${which}` });

const openFromSidebar = (page: Page, name: string) =>
  sidebarSection(page, 'userSpace').getByRole('treeitem', { name, exact: true }).click();

/** Opens today.md and splits, which is where most of these start. */
async function splitOnToday(page: Page): Promise<void> {
  await openFromSidebar(page, 'today');
  await expect(pane(page, 1).getByRole('article', { name: 'today' })).toBeVisible();
  await splitWindow(page);
  await expect(pane(page, 2)).toBeVisible();
}

test('splitting opens a second pane on the note the first one holds', async ({ page }) => {
  await openVault(page);
  await splitOnToday(page);

  await expect(pane(page, 1).getByRole('article', { name: 'today' })).toBeVisible();
  await expect(pane(page, 2).getByRole('article', { name: 'today' })).toBeVisible();
  // The control is a command, not only a shortcut — and there is nowhere to put
  // a third pane, so each pane's menu offers closing instead.
  await pane(page, 1).getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('menuitem', { name: /^Close pane/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^Split right/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('the two panes are side by side, sharing the window between them', async ({ page }) => {
  await openVault(page);
  await splitOnToday(page);

  const measured = await page.evaluate(() => {
    const panes = [...document.querySelectorAll('.pane')].map((element) =>
      element.getBoundingClientRect(),
    );
    const main = document.querySelector('.shell__main');
    if (panes.length !== 2 || main === undefined || main === null) return null;
    const [left, right] = panes as [DOMRect, DOMRect];
    return {
      leftWidth: Math.round(left.width),
      rightWidth: Math.round(right.width),
      leftRight: Math.round(left.right),
      rightLeft: Math.round(right.left),
      available: Math.round(main.getBoundingClientRect().width),
    };
  });

  expect(measured).not.toBeNull();
  // Beside, not stacked and not one over the other.
  expect(measured?.rightLeft ?? 0).toBeGreaterThanOrEqual(measured?.leftRight ?? 0);
  // Half the window each, give or take the line between them.
  expect(measured?.leftWidth ?? 0).toBeGreaterThan((measured?.available ?? 0) * 0.45);
  expect(measured?.rightWidth ?? 0).toBeGreaterThan((measured?.available ?? 0) * 0.45);
});

test('each pane holds its own note', async ({ page }) => {
  await openVault(page);
  await splitOnToday(page);

  // The split moved the focus to the new pane, so this lands there.
  await openFromSidebar(page, 'Another Note');
  await expect(pane(page, 2).getByRole('article', { name: 'Another Note' })).toBeVisible();
  await expect(pane(page, 1).getByRole('article', { name: 'today' })).toBeVisible();

  // Clicking into the left pane makes it the one being worked in.
  await pane(page, 1).getByRole('article', { name: 'today' }).click();
  await openFromSidebar(page, 'Third Note');
  await expect(pane(page, 1).getByRole('article', { name: 'Third Note' })).toBeVisible();
  await expect(pane(page, 2).getByRole('article', { name: 'Another Note' })).toBeVisible();
});

test('a link followed in one pane does not move the other', async ({ page }) => {
  await openVault(page);
  await splitOnToday(page);
  await openFromSidebar(page, 'Another Note');
  await expect(pane(page, 2).getByRole('article', { name: 'Another Note' })).toBeVisible();

  // A plain click peeks the note (slice 6b); expanding it follows the link in this pane.
  await pane(page, 1).getByRole('link', { name: 'Another Note' }).click();
  await page.locator('.peek').getByRole('button', { name: 'Open as full page' }).click();

  await expect(pane(page, 1).getByRole('article', { name: 'Another Note' })).toBeVisible();
  await expect(pane(page, 2).getByRole('article', { name: 'Another Note' })).toBeVisible();

  // And back the other way: the pane that was clicked in is the one that moves.
  await pane(page, 2).getByRole('article', { name: 'Another Note' }).click();
  await openFromSidebar(page, 'today');
  await expect(pane(page, 2).getByRole('article', { name: 'today' })).toBeVisible();
  await expect(pane(page, 1).getByRole('article', { name: 'Another Note' })).toBeVisible();
});

test('the sidebar marks the note in the focused pane, and only that one', async ({ page }) => {
  await openVault(page);
  await splitOnToday(page);
  await openFromSidebar(page, 'Another Note');
  await expect(pane(page, 2).getByRole('article', { name: 'Another Note' })).toBeVisible();

  const userSpace = sidebarSection(page, 'userSpace');
  const todayRow = userSpace.getByRole('treeitem', { name: 'today', exact: true });
  const anotherRow = userSpace.getByRole('treeitem', { name: 'Another Note', exact: true });
  await expect(anotherRow).toHaveAttribute('aria-selected', 'true');
  await expect(todayRow).toHaveAttribute('aria-selected', 'false');

  // Working in the other pane moves the mark with you.
  await pane(page, 1).getByRole('article', { name: 'today' }).click();
  await expect(todayRow).toHaveAttribute('aria-selected', 'true');
  await expect(anotherRow).toHaveAttribute('aria-selected', 'false');
});

test('closing a pane leaves the note the other one was holding', async ({ page }) => {
  await openVault(page);
  await splitOnToday(page);
  await openFromSidebar(page, 'Another Note');
  await expect(pane(page, 2).getByRole('article', { name: 'Another Note' })).toBeVisible();

  await closePane(page, 2);

  await expect(pane(page, 2)).toHaveCount(0);
  await expect(pane(page, 1).getByRole('article', { name: 'today' })).toBeVisible();
  // Back to one pane, so there is room to split again.
  await pane(page, 1).getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('menuitem', { name: /^Split right/ })).toBeVisible();
});

test('closing the first pane keeps what the second one held', async ({ page }) => {
  await openVault(page);
  await splitOnToday(page);
  await openFromSidebar(page, 'Another Note');
  await expect(pane(page, 2).getByRole('article', { name: 'Another Note' })).toBeVisible();

  await closePane(page, 1);

  await expect(pane(page, 2)).toHaveCount(0);
  await expect(pane(page, 1).getByRole('article', { name: 'Another Note' })).toBeVisible();
});

test("the pane bar's split button splits, and gives way to a close button on each pane", async ({
  page,
}) => {
  await openVault(page);
  await openFromSidebar(page, 'today');
  await expect(pane(page, 1).getByRole('article', { name: 'today' })).toBeVisible();
  await expect(pane(page, 1).getByRole('button', { name: 'Close pane' })).toHaveCount(0);

  const splitButton = pane(page, 1).getByRole('button', { name: 'Split right' });
  await expect(splitButton).toHaveAttribute('title', 'Split right (⇧⌘\\)');
  await splitButton.click();

  await expect(pane(page, 2).getByRole('article', { name: 'today' })).toBeVisible();
  // No room for a third, so neither pane offers splitting; both offer closing.
  for (const which of [1, 2] as const) {
    await expect(pane(page, which).getByRole('button', { name: 'Close pane' })).toBeVisible();
    await expect(pane(page, which).getByRole('button', { name: 'Split right' })).toHaveCount(0);
  }
});

test("a pane's close button closes that pane and keeps the other's note", async ({ page }) => {
  await openVault(page);
  await splitOnToday(page);
  await openFromSidebar(page, 'Another Note');
  await expect(pane(page, 2).getByRole('article', { name: 'Another Note' })).toBeVisible();

  // The left one: the right pane takes its place, holding what it held.
  await pane(page, 1).getByRole('button', { name: 'Close pane' }).click();

  await expect(pane(page, 2)).toHaveCount(0);
  await expect(pane(page, 1).getByRole('article', { name: 'Another Note' })).toBeVisible();
  await expect(pane(page, 1).getByRole('button', { name: 'Close pane' })).toHaveCount(0);
  await expect(pane(page, 1).getByRole('button', { name: 'Split right' })).toBeVisible();
});

test('the split is still there after a restart', async ({ page }) => {
  await openVault(page);
  await splitOnToday(page);
  await openFromSidebar(page, 'Another Note');
  await expect(pane(page, 2).getByRole('article', { name: 'Another Note' })).toBeVisible();

  // A reload stands in for quitting and relaunching.
  await page.reload();

  await expect(pane(page, 1).getByRole('article', { name: 'today' })).toBeVisible();
  await expect(pane(page, 2).getByRole('article', { name: 'Another Note' })).toBeVisible();
});

test('an edit in one pane is in the file the other pane reads', async ({ page }) => {
  const vault = await openVault(page);
  await splitOnToday(page);

  // The same note in both panes: starring it from one must go through that
  // pane's own save, or the write would land underneath the editor holding it.
  await pane(page, 1).getByRole('button', { name: 'Add today to favorites' }).click();

  await expectFile(vault, 'Notes/today.md').toContain('favorite: true');
  await expectFile(vault, 'Notes/today.md').toContain('[[Another Note]]');
  await expect(
    pane(page, 2).getByRole('button', { name: 'Remove today from favorites' }),
  ).toBeVisible();
});

test('the window can be split and closed again from the keyboard', async ({ page }) => {
  await openVault(page);
  await openFromSidebar(page, 'today');
  await expect(pane(page, 1).getByRole('article', { name: 'today' })).toBeVisible();

  await page.keyboard.press('Shift+Meta+Backslash');
  await expect(pane(page, 2)).toBeVisible();

  await page.keyboard.press('Shift+Meta+Backslash');
  await expect(pane(page, 2)).toHaveCount(0);
  // Plain Cmd+backslash still belongs to the sidebar.
  await page.keyboard.press('Meta+Backslash');
  await expect(sidebarSection(page, 'userSpace')).toHaveCount(0);
});

/**
 * The theme toggle used to float over the top right of the main pane, where it
 * sat on top of the second pane's close button — so the pane you could see
 * could not be closed. It now lives in the sidebar's foot, and the Show sidebar
 * button sits in the first pane's own bar, beside what is there rather than over it. Overlap
 * is the assertion, because "it looks fine" is what it looked like.
 */
const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function expectClearOfPaneControls(page: Page, chrome: ReturnType<Page['locator']>) {
  const box = await chrome.boundingBox();
  if (box === null) throw new Error('the app chrome has no box to measure');

  // What a pane's bar holds: where it is, its star, its menu and its close button.
  const controls = page.locator(
    '.page-bar__crumbs, .page-bar .star, .page-bar [aria-label="More"], .page-bar [aria-label="Close pane"]',
  );
  await expect(controls).not.toHaveCount(0);
  for (let at = 0; at < (await controls.count()); at += 1) {
    const control = await controls.nth(at).boundingBox();
    if (control === null) throw new Error('a pane control has no box to measure');
    expect(overlaps(control, box)).toBe(false);
  }
}

test('app chrome does not sit on top of a pane control', async ({ page }) => {
  await openVault(page);
  await splitOnToday(page);

  await expectClearOfPaneControls(
    page,
    page.getByRole('button', { name: /^Switch to (light|dark) theme$/ }),
  );

  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await expectClearOfPaneControls(page, page.getByRole('button', { name: 'Show sidebar' }));
});
