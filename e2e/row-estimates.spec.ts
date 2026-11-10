import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';
import {
  GROUP_NAME_HEIGHT,
  INBOX_ROW_HEIGHT,
  TABLE_GROUP_HEIGHT,
  TABLE_HEADER_HEIGHT,
  TABLE_NEW_HEIGHT,
  TABLE_ROW_HEIGHT,
  TODAY_GROUP_GAP,
  TODAY_GROUP_NAME_GAP,
  TODAY_ROW_HEIGHT,
  TODAY_TABLE_EDGE,
} from './row-heights.ts';

/**
 * The virtualised lists place a row by an estimate until it is measured, and
 * a row measured at its estimate does not place the list again. The
 * estimates are pinned in row-heights.ts, one source for every spec that
 * reads one; this holds each to what the page draws. The table's sticky
 * header is held with them: a row the arrow keys focus is scrolled clear of
 * it by the sheet's `scroll-padding-top` (#244), which must be the header's
 * height.
 */

/**
 * Enough groups that a piece left out of the estimate shows against what
 * the list keeps of a group it placed while the page first laid out, which
 * can be a few pixels off in all (6px here) whatever the count: the table's
 * half-pixel edge alone is 0.44px a group over 94 unplaced, that noise 0.06.
 */
const TODAY_GROUPS = 100;
const TODAY_ESTIMATE_TOLERANCE = 0.25;

const NOW = new Date(2026, 9, 13, 12, 0, 0);

async function openVault(page: Page) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('Tasks');
  await vault.mkdir('Inbox');
  await vault.write(
    '.atlas/types/task.md',
    [
      '---',
      'name: task',
      'label: Task',
      'properties:',
      '  status:',
      '    kind: select',
      '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
      '    done: archive',
      '  due: date',
      '---',
      '',
    ].join('\n'),
  );
  await vault.write(
    'Tasks/Send the figures.md',
    ['---', 'type: task', 'status: next-action', 'due: 2026-10-13', '---', '', 'A task.', ''].join(
      '\n',
    ),
  );
  // Undated, so Today lists it under Next actions, grouped by project: the
  // group name is that sub-heading.
  await vault.write(
    'Tasks/Call the bank.md',
    ['---', 'type: task', 'status: next-action', '---', '', 'A task.', ''].join('\n'),
  );
  await vault.write('Inbox/Captured.md', 'A captured line.\n');
  await vault.mkdir('.atlas/views');
  await vault.write(
    '.atlas/views/Grouped.md',
    [
      '---',
      'atlas: view',
      'type: task',
      'layout: table',
      'groupBy: status',
      'columns: [status, due]',
      '---',
      '',
      '# Grouped',
      '',
    ].join('\n'),
  );
  await installHost(page, vault);
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
}

test('a Today group name is drawn at the height the list places it by', async ({ page }) => {
  await openVault(page);
  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Today' }).click();
  const name = page.locator('.today__group-name').first();
  await expect(name).toBeVisible();
  await expect
    .poll(async () => (await name.boundingBox())!.height)
    .toBeCloseTo(GROUP_NAME_HEIGHT, 1);
});

/**
 * More named groups than the window shows: the list stands in for those it
 * has not placed with a spacer of their estimates, and a named one-task
 * group it has placed measures what one of those estimates must be, or the
 * page's scroll height moves under every fast scroll.
 */
test('a Today group not yet placed is given the height a placed one measures', async ({ page }) => {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'Tasks', 'Projects']) await vault.mkdir(folder);
  await vault.write(
    '.atlas/types/task.md',
    [
      '---',
      'name: task',
      'label: Task',
      'properties:',
      '  status:',
      '    kind: select',
      '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
      '    done: archive',
      '---',
      '',
    ].join('\n'),
  );
  await vault.write('.atlas/types/project.md', '---\nname: project\nlabel: Project\n---\n');
  const pad = (n: number) => String(n).padStart(3, '0');
  const writes: Promise<void>[] = [];
  for (let n = 1; n <= TODAY_GROUPS; n += 1) {
    writes.push(
      vault.write(`Projects/Project ${pad(n)}.md`, '---\ntype: project\nstatus: active\n---\n'),
      vault.write(
        `Tasks/Task ${pad(n)}.md`,
        `---\ntype: task\nstatus: next-action\nproject: "[[Project ${pad(n)}]]"\n---\n`,
      ),
    );
  }
  await Promise.all(writes);
  await installHost(page, vault);
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Today' }).click();
  const next = page.getByRole('region', { name: 'Next actions', exact: true });
  await expect(next.locator('.review__count').first()).toHaveText(String(TODAY_GROUPS));

  const placed = next.locator('.today__group');
  await expect(placed.nth(1)).toBeVisible();
  const shown = await placed.count();
  expect(shown).toBeLessThan(TODAY_GROUPS);
  const measured = (await placed.nth(1).boundingBox())!.height;
  expect(measured).toBeCloseTo(
    TODAY_GROUP_GAP +
      GROUP_NAME_HEIGHT +
      TODAY_GROUP_NAME_GAP +
      TODAY_ROW_HEIGHT +
      TODAY_TABLE_EDGE,
    1,
  );

  // What stands in for the groups after the last one placed: their estimates, summed.
  const spacer = next.locator('.today__groups > div[aria-hidden="true"]').last();
  const after = await spacer.evaluate((element) =>
    parseFloat((element as HTMLElement).style.height),
  );
  const estimate = after / (TODAY_GROUPS - shown);
  expect(Math.abs(estimate - measured)).toBeLessThan(TODAY_ESTIMATE_TOLERANCE);
});

test('a Today row is drawn at the height the list places it by', async ({ page }) => {
  await openVault(page);
  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Today' }).click();
  const row = page.locator('.today [data-today-row]').first();
  await expect(row).toBeVisible();
  await expect.poll(async () => (await row.boundingBox())!.height).toBeCloseTo(TODAY_ROW_HEIGHT, 1);
});

test('a standard Inbox row is drawn at the height the list places it by', async ({ page }) => {
  await openVault(page);
  await page
    .getByRole('list', { name: 'Go to' })
    .getByRole('button', { name: /^Inbox/ })
    .click();
  const row = page.locator('.inbox__row').first();
  await expect(row).toBeVisible();
  await expect.poll(async () => (await row.boundingBox())!.height).toBeCloseTo(INBOX_ROW_HEIGHT, 1);
});

test('a table’s rows, group rows, "+ New" and sticky header are drawn at the heights the table places them by', async ({
  page,
}) => {
  await openVault(page);
  await sidebarSection(page, 'views').getByRole('button', { name: 'Grouped', exact: true }).click();
  const row = page.locator('.table__row').first();
  await expect(row).toBeVisible();
  const height = async (selector: string) =>
    (await page.locator(selector).first().boundingBox())!.height;
  expect(await height('.table__row')).toBeCloseTo(TABLE_ROW_HEIGHT, 1);
  expect(await height('tr.table__group')).toBeCloseTo(TABLE_GROUP_HEIGHT, 1);
  expect(await height('tr.table__group-new')).toBeCloseTo(TABLE_NEW_HEIGHT, 1);
  expect(await height('.table__grid thead th')).toBeCloseTo(TABLE_HEADER_HEIGHT, 1);

  // The header's bottom edge is where a focused row is scrolled clear to.
  const header = page.locator('.table__grid thead tr').first();
  const headerBottom = (await header.boundingBox())!.height;
  const padding = await page
    .locator('.table__sheet')
    .evaluate((sheet) => parseFloat(getComputedStyle(sheet).scrollPaddingTop));
  expect(padding).toBeGreaterThanOrEqual(headerBottom);
  expect(padding - headerBottom).toBeLessThan(2);
});
