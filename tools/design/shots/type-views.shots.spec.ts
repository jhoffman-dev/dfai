// `pnpm shots`: a type's views as tabs. What the shots specs share, and why they assert
// nothing, is in kit.ts.
import { test } from '../../../e2e/fixtures.ts';
import type { Page } from '@playwright/test';
import { installHost, sidebarSection } from '../../../e2e/host.ts';
import { THEME_KEY, prepareVault, openVault, useTheme, shoot, open } from './kit.ts';

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

/**
 * Issue #11: a type opened from the sidebar, on its views as tabs — the repo's
 * Task, which has several — with "+" and the selected tab's options open.
 */
async function shootTypeViews(page: Page, theme: string): Promise<void> {
  const types = sidebarSection(page, 'types');
  if (!(await open('type views', [types.getByRole('button', { name: /^Task, / })]))) return;
  const tabs = page.getByRole('navigation', { name: 'Views' });
  await tabs.locator('.view-tabs__tab[aria-pressed="true"]').waitFor({ timeout: 10_000 });
  await shoot(page, `type-views-${theme}`);
  await tabs.getByRole('button', { name: 'Add a view' }).click();
  await page.getByRole('menu', { name: 'Add a view' }).waitFor({ timeout: 5_000 });
  await shoot(page, `type-views-add-${theme}`);
  await page.keyboard.press('Escape');
  await tabs.getByRole('button', { name: 'View options' }).click();
  await page.getByRole('menu', { name: 'View options' }).waitFor({ timeout: 5_000 });
  await shoot(page, `type-views-options-${theme}`);
  await page.keyboard.press('Escape');
  // The type editor in the right sidebar (slice 12), beside FlowType: from a
  // type with no views of its own, whose page bar carries Edit type.
  if (!(await open('type-editor', [types.getByRole('button', { name: /^Person, / })]))) return;
  const edit = page.getByRole('button', { name: 'Edit type', exact: true });
  await edit.waitFor({ timeout: 5_000 }).catch(() => undefined);
  if (await open('type-editor', [edit])) {
    await page
      .locator('.type-editor')
      .first()
      .waitFor({ timeout: 5_000 })
      .catch(() => console.warn('type-editor: it never opened'));
    await shoot(page, `type-editor-${theme}`);
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`type views shots, ${theme}`, async ({ page }) => {
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: THEME_KEY,
      value: theme,
    });
    await installHost(page, await prepareVault());
    await page.goto('/');
    await openVault(page);
    await useTheme(page, theme);
    await shootTypeViews(page, theme);
  });
}
