// `pnpm shots`: the query builder and a saved, grouped query. What the shots specs
// share, and why they assert nothing, is in kit.ts.
import { test } from '../../../e2e/fixtures.ts';
import type { Page } from '@playwright/test';
import { installHost } from '../../../e2e/host.ts';
import { THEME_KEY, prepareVault, openVault, useTheme, shoot } from './kit.ts';

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

/**
 * P24: a DFAI query in the builder, the same query as text with a mistake
 * pointed at, and a saved query grouped then sub-grouped.
 */
async function shootQueries(page: Page, theme: string): Promise<void> {
  await page.getByRole('button', { name: 'New in Views' }).click();
  await page.getByRole('menuitem', { name: 'New query' }).click();
  const modes = page.getByRole('radiogroup', { name: 'Edit the query as' });
  const editor = page.getByRole('textbox', { name: 'Query' });
  await modes.getByRole('radio', { name: 'Text' }).click();
  await editor.fill(
    'FROM task, project WHERE status != done AND title CONTAINS e SORT BY phase DESC GROUP BY type THEN status',
  );
  await modes.getByRole('radio', { name: 'Builder' }).click();
  await page.locator('.qresult__title').first().waitFor({ timeout: 10_000 });
  await shoot(page, `query-builder-${theme}`);

  await modes.getByRole('radio', { name: 'Text' }).click();
  await editor.fill('FROM task WHERE stauts != done GROUP BY phase THEN status');
  await page.getByRole('alert').waitFor({ timeout: 10_000 });
  await shoot(page, `query-text-error-${theme}`);

  await editor.fill('FROM task WHERE status != done SORT BY title GROUP BY phase THEN status');
  await page.getByRole('button', { name: 'Save as view' }).click();
  await page.getByRole('textbox', { name: 'View name' }).fill(`Open by phase ${theme}`);
  await page.getByRole('button', { name: 'Save view' }).click();
  // A saved view is drawn as its table (issue #6): a header row per group, its
  // sub-groups one step in. Waiting on a sub-group waits on both levels.
  const grouped = page.locator('.table__group-toggle[data-depth="1"]').first();
  await grouped.waitFor({ timeout: 10_000 });
  // The groups, not the builder above them, are what this shot is of. A saved
  // view may open with its query folded to one line (#341), with nothing to
  // shrink; open, its text is shorter than its builder.
  const editQuery = page.getByRole('button', { name: 'Edit query' });
  await editQuery.or(modes).first().waitFor();
  if (!(await editQuery.isVisible())) await modes.getByRole('radio', { name: 'Text' }).click();
  await grouped.scrollIntoViewIfNeeded();
  await shoot(page, `query-view-grouped-${theme}`);
  await page
    .getByRole('radiogroup', { name: 'Layout' })
    .getByRole('radio', { name: 'Board' })
    .click();
  // Sub-grouped, the board is drawn as swimlanes, one region per status.
  await page.getByRole('region', { name: /lane$/ }).first().waitFor({ timeout: 10_000 });
  await shoot(page, `query-view-board-${theme}`);
}

for (const theme of ['light', 'dark'] as const) {
  test(`query shots, ${theme}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: THEME_KEY,
      value: theme,
    });
    const vault = await prepareVault();
    await installHost(page, vault);
    await page.goto('/');
    await openVault(page);
    await useTheme(page, theme);
    await shootQueries(page, theme);
  });
}
