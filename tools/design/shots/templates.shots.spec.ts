// `pnpm shots`: the Templates page. What the shots specs share, and why they assert
// nothing, is in kit.ts.
import { test } from '../../../e2e/fixtures.ts';
import type { Page } from '@playwright/test';
import { installHost, sidebarSection } from '../../../e2e/host.ts';
import { THEME_KEY, prepareVault, openVault, useTheme, shoot } from './kit.ts';

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

/**
 * Issue #16, ADR-0026: the Templates page, its New template form, a type's
 * Edit template beside its tabs, and a template open under its band.
 */
async function shootTemplates(page: Page, theme: string): Promise<void> {
  await page
    .getByRole('list', { name: 'Go to' })
    .getByRole('button', { name: 'Templates', exact: true })
    .click();
  const list = page.getByRole('article', { name: 'Templates' });
  await list.getByRole('row').nth(1).waitFor();
  await shoot(page, `templates-page-${theme}`);
  await page.getByRole('button', { name: 'New template' }).click();
  await page.getByRole('form', { name: 'New template' }).waitFor();
  await shoot(page, `templates-new-${theme}`);
  await page
    .getByRole('form', { name: 'New template' })
    .getByRole('button', { name: 'Cancel' })
    .click();

  await sidebarSection(page, 'types')
    .getByRole('button', { name: /^Person, / })
    .click();
  await page
    .getByRole('button', { name: 'Edit Person template' })
    .or(page.getByRole('button', { name: 'Edit template' }))
    .first()
    .waitFor();
  await shoot(page, `templates-type-${theme}`);
  await page
    .getByRole('button', { name: 'Edit Person template' })
    .or(page.getByRole('button', { name: 'Edit template' }))
    .first()
    .click();
  await page.getByRole('complementary', { name: 'Template' }).waitFor();
  await shoot(page, `templates-editing-${theme}`);
}

for (const theme of ['light', 'dark'] as const) {
  test(`templates shots, ${theme}`, async ({ page }) => {
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: THEME_KEY,
      value: theme,
    });
    await installHost(page, await prepareVault());
    await page.goto('/');
    await openVault(page);
    await useTheme(page, theme);
    await shootTemplates(page, theme);
  });
}
