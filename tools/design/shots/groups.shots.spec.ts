// `pnpm shots`: grouped tables and swimlanes. What the shots specs share, and why they assert
// nothing, is in kit.ts.
import { test } from '../../../e2e/fixtures.ts';
import type { Page } from '@playwright/test';
import { createVault, installHost, type FakeVault } from '../../../e2e/host.ts';
import { THEME_KEY, openVault, useTheme, shoot, open, view } from './kit.ts';

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

/** Tasks in areas, for a table grouped then sub-grouped and a board with swimlanes (issue #6). */
async function groupsVault(): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write(
    '.atlas/types/task.md',
    [
      '---',
      'name: task',
      'properties:',
      '  status:',
      '    kind: select',
      '    options: [backlog, doing, review, done]',
      '  area:',
      '    kind: select',
      '    options: [home, work, garden]',
      '  hours: number',
      '  urgent: checkbox',
      '---',
      '',
    ].join('\n'),
  );
  const shown = 'columns: [status, area, hours, urgent]';
  const viewNote = (name: string, layout: string) =>
    [
      '---',
      'atlas: view',
      'type: task',
      layout,
      'groupBy: status',
      'subGroupBy: area',
      shown,
      'limit: 100',
      '---',
      '',
      `# ${name}`,
      '',
    ].join('\n');
  await vault.write('.atlas/views/Grouped.md', viewNote('Grouped', 'layout: table'));
  await vault.write('.atlas/views/Swimlanes.md', viewNote('Swimlanes', 'layout: board'));
  const tasks: readonly [string, string, string, number, boolean][] = [
    ['Fix the gate latch', 'backlog', 'home', 2, false],
    ['Order seed potatoes', 'backlog', 'garden', 1, true],
    ['Draft the Q4 plan', 'doing', 'work', 6, true],
    ['Review the API keys', 'doing', 'work', 3, false],
    ['Paint the hallway', 'doing', 'home', 8, false],
    ['Prune the apple tree', 'doing', 'garden', 3, false],
    ['Hiring loop notes', 'review', 'work', 2, true],
    ['Book the boiler service', 'done', 'home', 1, false],
    ['Ship the release notes', 'done', 'work', 4, false],
  ];
  for (const [title, status, area, hours, urgent] of tasks) {
    await vault.write(
      `${title}.md`,
      [
        '---',
        'type: task',
        `status: ${status}`,
        `area: ${area}`,
        `hours: ${hours}`,
        `urgent: ${urgent}`,
        '---',
        '',
        `# ${title}`,
        '',
      ].join('\n'),
    );
  }
  return vault;
}

async function shootGroups(page: Page, theme: string): Promise<void> {
  if (await open('grouped table', view(page, 'Grouped'))) {
    await page.locator('.table__group').first().waitFor({ timeout: 10_000 });
    // One sub-group folded, to show a folded header beside open ones.
    await page
      .locator('.table__group-toggle[data-depth="1"]')
      .filter({ hasText: /^Garden/ })
      .first()
      .click();
    await shoot(page, `groups-table-${theme}`);
  }
  if (await open('swimlanes', view(page, 'Swimlanes'))) {
    await page.locator('.board__lane').first().waitFor({ timeout: 10_000 });
    await shoot(page, `groups-board-${theme}`);
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`group shots, ${theme}`, async ({ page }) => {
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: THEME_KEY,
      value: theme,
    });
    const vault = await groupsVault();
    await installHost(page, vault);
    await page.goto('/');
    await openVault(page);
    await useTheme(page, theme);
    await shootGroups(page, theme);
  });
}
