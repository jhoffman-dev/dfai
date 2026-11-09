import { test, expect } from './fixtures.ts';
import { createVault, installHost } from './host.ts';

const TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, doing, done]',
  '---',
  '',
].join('\n');
const DASH = [
  '---',
  'atlas: dashboard',
  'widgets:',
  '  - title: Tasks',
  '    kind: number',
  '    type: task',
  '  - title: Share',
  '    kind: donut',
  '    type: task',
  '    groupBy: status',
  '    width: 2',
  '---',
  '',
  '# Progress',
  '',
].join('\n');

/**
 * A grid stretches every item to the height of the tallest in its row, which
 * turned a stat tile beside a chart into a mostly-empty card with one number
 * adrift at the top of it.
 */
test('a stat tile keeps its own height beside a taller chart', async ({ page }) => {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/dashboards');
  await vault.write('.atlas/types/task.md', TYPE);
  await vault.write('.atlas/dashboards/Progress.md', DASH);
  for (const [n, s] of [
    [1, 'doing'],
    [2, 'done'],
    [3, 'backlog'],
  ] as const) {
    await vault.write(
      `t${n}.md`,
      ['---', 'type: task', `status: ${s}`, '---', '', 'x', ''].join('\n'),
    );
  }
  await installHost(page, vault);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await page.getByText(/notes indexed/).waitFor();
  await page.getByRole('button', { name: 'Progress', exact: true }).first().click();
  await page.locator('.donut').waitFor();

  const tile = await page.getByLabel('Tasks').boundingBox();
  const chart = await page.getByLabel('Share').boundingBox();
  if (tile === null || chart === null) throw new Error('a widget has no box to measure');

  expect(tile.height).toBeLessThan(chart.height);
});

/**
 * A narrow donut gave its legend what the ring left over, and the labels were
 * cut to "D." and "B." beside their percentages. Whatever the width, a label
 * is read whole — and a legend dropped under its ring still fits its card,
 * even in a row a wider donut, legend beside its ring, set the height of.
 */
test('a narrow donut keeps its legend readable', async ({ page }) => {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/dashboards');
  await vault.write('.atlas/types/task.md', TYPE);
  const donut = (span: number) =>
    [
      `  - title: Span ${span}`,
      '    kind: donut',
      '    type: task',
      '    groupBy: status',
      `    span: ${span}`,
    ].join('\n');
  await vault.write(
    '.atlas/dashboards/Shares.md',
    ['---', 'atlas: dashboard', 'widgets:', ...[3, 4, 5, 6, 3].map(donut), '---', ''].join('\n'),
  );
  for (const [n, s] of [
    [1, 'doing'],
    [2, 'backlog'],
    [3, 'backlog'],
  ] as const) {
    await vault.write(
      `t${n}.md`,
      ['---', 'type: task', `status: ${s}`, '---', '', 'x', ''].join('\n'),
    );
  }
  await installHost(page, vault);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await page.getByText(/notes indexed/).waitFor();
  await page.getByRole('button', { name: 'Shares', exact: true }).first().click();

  // Three, four and five columns fill the first row; six and three the next.
  const spans = [3, 4, 5, 6, 3];
  const cards = page.getByLabel('Dashboard', { exact: true }).getByRole('region');
  await expect(cards).toHaveCount(spans.length);
  for (const [at, span] of spans.entries()) {
    const card = cards.nth(at);
    const legend = card.locator('.count-table__label');
    await expect(legend).toHaveText(['Backlog', 'Doing', 'Done']);
    await expect(async () => {
      const cut = await legend.evaluateAll((labels) =>
        labels
          .filter((label) => label.clientWidth === 0 || label.scrollWidth > label.clientWidth)
          .map((label) => label.textContent),
      );
      expect(cut, `span ${span}`).toEqual([]);
    }).toPass();
    await expect(async () => {
      const spill = await card.evaluate((element) => element.scrollHeight - element.clientHeight);
      expect(spill, `span ${span} spills out of its card`).toBeLessThanOrEqual(0);
    }).toPass();
  }
});
