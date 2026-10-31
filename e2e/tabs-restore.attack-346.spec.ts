import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection, type FakeVault } from './host.ts';

/*
 * Attack on #346: what a restart brings back, and what a bad or stale
 * remembered workspace costs. A reload stands in for quitting.
 */

const NAMES = ['alpha', 'beta', 'gamma', 'delta'] as const;
const bodyOf = (name: string) => `# ${name}\n\nLine of ${name}.\n`;

async function openVault(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  for (const name of NAMES) await vault.write(`${name}.md`, bodyOf(name));
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

async function restart(page: Page): Promise<void> {
  await page.reload();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
}

const row = (page: Page, name: string) =>
  sidebarSection(page, 'userSpace').getByRole('treeitem', { name, exact: true });
const pane = (page: Page, which: 1 | 2) => page.getByRole('region', { name: `Pane ${which}` });
const strip = (page: Page, which: 1 | 2) =>
  page.getByRole('tablist', { name: `Pane ${which} tabs` });
const tab = (page: Page, which: 1 | 2, name: string) =>
  strip(page, which).getByRole('tab', { name, exact: true });
const tabsOf = (page: Page, which: 1 | 2) => strip(page, which).getByRole('tab');
const article = (page: Page, which: 1 | 2, name: string) =>
  pane(page, which).getByRole('article', { name, exact: true });
const backIn = (page: Page, which: 1 | 2) =>
  pane(page, which).getByRole('button', { name: 'Back', exact: true });

/** Plants what is remembered for this vault, then restarts on it. */
async function plantAndRestart(page: Page, vault: FakeVault, stored: string): Promise<void> {
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [
    `atlas.workspace:${vault.root}`,
    stored,
  ] as const);
  await restart(page);
}

const history = (current: string, back: string[] = []) => ({
  back: back.map((path) => ({ kind: 'note', path })),
  current: { kind: 'note', path: current },
  forward: [],
});

test('a restart brings back both panes, the focused one, and each pane tab’s own Back', async ({
  page,
}) => {
  await openVault(page);
  await row(page, 'alpha').click();
  await row(page, 'beta').click();
  await expect(article(page, 1, 'beta')).toBeVisible();
  await row(page, 'gamma').click({ modifiers: ['Meta', 'Shift'] });
  await expect(article(page, 2, 'gamma')).toBeVisible();
  await row(page, 'delta').click();
  await expect(article(page, 2, 'delta')).toBeVisible();
  // Focus back on pane 1 by clicking into its note.
  await article(page, 1, 'beta').getByText('Line of beta.').click();
  await expect(strip(page, 1).locator('..')).toHaveClass(/tab-strip--focused/);

  await restart(page);

  await expect(tabsOf(page, 1)).toHaveText(['beta']);
  await expect(tabsOf(page, 2)).toHaveText(['delta']);
  await expect(strip(page, 1).locator('..')).toHaveClass(/tab-strip--focused/);
  await expect(strip(page, 2).locator('..')).not.toHaveClass(/tab-strip--focused/);
  await expect(backIn(page, 1)).toHaveAttribute('title', /Back to alpha/);
  await expect(backIn(page, 2)).toHaveAttribute('title', /Back to gamma/);
});

test('remembered tabs that are not JSON cost the layout, not the window: one empty tab', async ({
  page,
}) => {
  const vault = await openVault(page);
  await plantAndRestart(page, vault, '{"version":1,"panes":[{');
  await expect(tabsOf(page, 1)).toHaveText(['New tab']);
  await expect(sidebarSection(page, 'userSpace')).toBeVisible();
  // And the app still works: a click opens a note.
  await row(page, 'alpha').click();
  await expect(article(page, 1, 'alpha')).toBeVisible();
});

test('another vault’s workspace under this vault’s key is not restored', async ({ page }) => {
  const vault = await openVault(page);
  const stored = {
    version: 1,
    vault: '/Users/someone-else/Other Vault',
    focused: 0,
    nextId: 2,
    panes: [{ active: 't1', tabs: [{ id: 't1', pinned: false, history: history('alpha.md') }] }],
  };
  await plantAndRestart(page, vault, JSON.stringify(stored));
  await expect(tabsOf(page, 1)).toHaveText(['New tab']);
});

test('a huge remembered history starts the app, and is trimmed as it is written back', async ({
  page,
}) => {
  const vault = await openVault(page);
  const back = Array.from({ length: 20_000 }, (_, at) => NAMES[at % 3] as string).map(
    (name) => `${name}.md`,
  );
  const stored = {
    version: 1,
    vault: vault.root,
    focused: 0,
    nextId: 2,
    panes: [
      { active: 't1', tabs: [{ id: 't1', pinned: false, history: history('delta.md', back) }] },
    ],
  };
  await plantAndRestart(page, vault, JSON.stringify(stored));
  await expect(article(page, 1, 'delta')).toBeVisible();
  await expect(backIn(page, 1)).toBeEnabled();
  await page.keyboard.press('Meta+t');
  await expect(tabsOf(page, 1)).toHaveText(['delta', 'New tab']);
  const written = await page.evaluate(
    (key) => window.localStorage.getItem(key) ?? '',
    `atlas.workspace:${vault.root}`,
  );
  expect(written.length).toBeLessThan(100_000);
});

test('a remembered tab whose note was deleted while the app was closed opens on nothing, not an error', async ({
  page,
}) => {
  const vault = await openVault(page);
  await row(page, 'alpha').click();
  await row(page, 'beta').click({ modifiers: ['Meta'] });
  await expect(tabsOf(page, 1)).toHaveText(['alpha', 'beta']);
  await rm(join(vault.root, 'beta.md'));
  await restart(page);
  // The tab on beta is gone, or empty; it is never an error page on a note that is not there.
  await expect(tabsOf(page, 1)).not.toHaveText(['alpha', 'beta']);
  await expect(pane(page, 1).getByRole('alert')).toHaveCount(0);
});

test('a note renamed while hidden in a tab is followed by its tab, and the tab opens it after a restart', async ({
  page,
}) => {
  const vault = await openVault(page);
  await row(page, 'alpha').click();
  await row(page, 'beta').click({ modifiers: ['Meta'] });
  await expect(article(page, 1, 'beta')).toBeVisible();
  // Rename alpha from the sidebar while its tab is hidden.
  const pages = sidebarSection(page, 'userSpace');
  await row(page, 'alpha').hover();
  await pages.getByRole('button', { name: 'Options for alpha', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Rename/ }).click();
  const name = pages.getByRole('textbox', { name: 'Name for alpha' });
  await name.fill('omega');
  await name.press('Enter');
  await expect.poll(() => vault.exists('omega.md')).toBe(true);
  await expect(tabsOf(page, 1)).toHaveText(['omega', 'beta']);
  await tab(page, 1, 'omega').click();
  await expect(article(page, 1, 'omega')).toBeVisible();
  await restart(page);
  await expect(tabsOf(page, 1)).toHaveText(['omega', 'beta']);
  await expect(article(page, 1, 'omega')).toBeVisible();
});

test('a note deleted in the app while hidden in a tab leaves no tab on it after a restart', async ({
  page,
}) => {
  const vault = await openVault(page);
  await row(page, 'alpha').click();
  await row(page, 'beta').click({ modifiers: ['Meta'] });
  await expect(article(page, 1, 'beta')).toBeVisible();
  const pages = sidebarSection(page, 'userSpace');
  await row(page, 'alpha').hover();
  await pages.getByRole('button', { name: 'Options for alpha', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Delete…/ }).click();
  await page.getByRole('button', { name: 'Move to Trash' }).click();
  await expect.poll(() => vault.exists('alpha.md')).toBe(false);
  await expect(tab(page, 1, 'alpha')).toHaveCount(0);
  await restart(page);
  await expect(tab(page, 1, 'alpha')).toHaveCount(0);
  await expect(article(page, 1, 'beta')).toBeVisible();
});

test('the old split is upgraded once: after a change, the old key no longer decides the layout', async ({
  page,
}) => {
  const vault = await openVault(page);
  await page.evaluate(
    ([root]) => {
      window.localStorage.removeItem(`atlas.workspace:${root}`);
      window.localStorage.setItem(
        'atlas.panes',
        JSON.stringify({ vault: root, paths: ['alpha.md', 'beta.md'], focused: 1 }),
      );
    },
    [vault.root] as const,
  );
  await restart(page);
  await expect(tabsOf(page, 1)).toHaveText(['alpha']);
  await expect(tabsOf(page, 2)).toHaveText(['beta']);
  await expect(strip(page, 2).locator('..')).toHaveClass(/tab-strip--focused/);
  // One change, then the new record is what a restart reads.
  await row(page, 'gamma').click();
  await expect(tabsOf(page, 2)).toHaveText(['gamma']);
  await restart(page);
  await expect(tabsOf(page, 2)).toHaveText(['gamma']);
});

test('an upgraded split restored without any change is still restored the same way next time', async ({
  page,
}) => {
  const vault = await openVault(page);
  await page.evaluate(
    ([root]) => {
      window.localStorage.removeItem(`atlas.workspace:${root}`);
      window.localStorage.setItem(
        'atlas.panes',
        JSON.stringify({ vault: root, paths: ['alpha.md', 'beta.md'], focused: 0 }),
      );
    },
    [vault.root] as const,
  );
  await restart(page);
  await expect(tabsOf(page, 2)).toHaveText(['beta']);
  await restart(page);
  await expect(tabsOf(page, 1)).toHaveText(['alpha']);
  await expect(tabsOf(page, 2)).toHaveText(['beta']);
});
