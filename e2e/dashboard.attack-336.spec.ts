import { expect, test, type Locator, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';
import { macOnly } from './platform.ts';

/**
 * Attack on PR #336 (UI v2 slice 10, the dashboard): the strip and the panels
 * at narrow widths, focus rings near the clipped edges, and a bar chart with
 * many bars.
 */

const TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, doing, done]',
  '  phase: number',
  '---',
  '',
].join('\n');

const task = (status: string, phase: number): string =>
  ['---', 'type: task', `status: ${status}`, `phase: ${phase}`, '---', '', 'A task.', ''].join(
    '\n',
  );

async function openDashboard(
  page: Page,
  widgets: readonly string[],
  tasks: readonly (readonly [string, number])[],
) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/dashboards');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write(
    '.atlas/dashboards/Progress.md',
    ['---', 'atlas: dashboard', 'widgets:', ...widgets, '---', '', '# Progress', ''].join('\n'),
  );
  for (const [at, [status, phase]] of tasks.entries()) {
    await vault.write(`task-${at}.md`, task(status, phase));
  }
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'dashboards')
    .getByRole('button', { name: 'Progress', exact: true })
    .click();
  const dashboard = page.getByLabel('Dashboard', { exact: true });
  await expect(dashboard).toBeVisible();
  return dashboard;
}

const numberWidget = (title: string) => [
  `  - title: ${title}`,
  '    kind: number',
  '    type: task',
];
const barWidget = (title: string, span = 6) => [
  `  - title: ${title}`,
  '    kind: bar',
  '    type: task',
  '    groupBy: phase',
  `    span: ${span}`,
];

const FEW_TASKS: readonly (readonly [string, number])[] = [
  ['doing', 1],
  ['done', 2],
  ['backlog', 2],
];

/** How far the dashboard's own scroll box overflows sideways. */
const sidewaysSpill = (dashboard: Locator) =>
  dashboard.evaluate((element) => element.scrollWidth - element.clientWidth);

test('a strip of many figures does not push the dashboard into a sideways scroll at 800px', async ({
  page,
}) => {
  const titles = [
    'Open',
    'Doing',
    'Done',
    'Backlog',
    'Waiting',
    'Review',
    'Inbox',
    'Next',
    'Larkspur',
    'Quill',
    'Fenn',
    'Total',
  ];
  const dashboard = await openDashboard(
    page,
    [...titles.flatMap(numberWidget), ...barWidget('Per phase')],
    FEW_TASKS,
  );
  // Opened wide, then squeezed: under 944px the sidebar is a drawer (#658).
  await page.setViewportSize({ width: 800, height: 800 });
  await expect(dashboard.locator('.kpi')).toHaveCount(titles.length);
  expect(await sidewaysSpill(dashboard)).toBeLessThanOrEqual(0);
});

test('every strip figure stays inside its own cell at 800px', async ({ page }) => {
  const titles = ['Open', 'Doing', 'Done', 'Backlog', 'Waiting', 'Review', 'Inbox', 'Next'];
  const dashboard = await openDashboard(page, titles.flatMap(numberWidget), FEW_TASKS);
  await page.setViewportSize({ width: 800, height: 800 });
  await expect(dashboard.locator('.kpi')).toHaveCount(titles.length);
  const spilled = await dashboard.locator('.kpi').evaluateAll((cells) =>
    cells
      .filter((cell) => {
        const box = cell.getBoundingClientRect();
        const value = cell.querySelector('.kpi__value')?.getBoundingClientRect();
        return value !== undefined && value.right > box.right + 0.5;
      })
      .map((cell) => cell.querySelector('.kpi__label')?.textContent),
  );
  expect(spilled).toEqual([]);
});

test('panels at 600px neither spill sideways nor leave the grid wider than the pane', async ({
  page,
}) => {
  const dashboard = await openDashboard(
    page,
    [...numberWidget('Open'), ...barWidget('Per phase', 5), ...barWidget('Again', 7)],
    FEW_TASKS,
  );
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(dashboard.getByRole('region', { name: 'Again' })).toBeVisible();
  expect(await sidewaysSpill(dashboard)).toBeLessThanOrEqual(0);
});

/** The focus ring (`--ring`) reaches 4px beyond the box; no clipping ancestor may cut it. */
async function ringClipped(target: Locator): Promise<string[]> {
  return target.evaluate((element) => {
    const RING = 4;
    const box = element.getBoundingClientRect();
    const cut: string[] = [];
    for (let at = element.parentElement; at !== null; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const clip = at.getBoundingClientRect();
      const left = clip.left + at.clientLeft;
      const top = clip.top + at.clientTop;
      const right = left + at.clientWidth;
      const bottom = top + at.clientHeight;
      if (
        box.left - RING < left - 0.5 ||
        box.top - RING < top - 0.5 ||
        box.right + RING > right + 0.5 ||
        box.bottom + RING > bottom + 0.5
      ) {
        cut.push(`${at.className} [${box.left},${box.top},${box.right},${box.bottom}]`);
      }
    }
    return cut;
  });
}

test('the table toggle and the widget menu keep their whole focus ring', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const dashboard = await openDashboard(
    page,
    [...numberWidget('Open'), ...barWidget('Per phase', 12)],
    FEW_TASKS,
  );
  const panel = dashboard.getByRole('region', { name: 'Per phase' });
  const toggle = panel.getByRole('button', { name: 'Show as table' });
  // WebKit does not Tab to buttons by default, so focus is placed directly.
  await toggle.focus();
  await expect(toggle).toBeFocused();
  expect(await ringClipped(toggle)).toEqual([]);

  const menu = panel.locator('.widget__menu');
  await menu.focus();
  await expect(menu).toBeFocused();
  expect(await ringClipped(menu)).toEqual([]);
});

test('the strip widget menu keeps its whole focus ring', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const dashboard = await openDashboard(page, numberWidget('Open'), FEW_TASKS);
  const menu = dashboard.locator('.widget__menu').first();
  await menu.focus();
  await expect(menu).toBeFocused();
  expect(await ringClipped(menu)).toEqual([]);
});

test(
  'fifty equal bars in a narrow panel neither spill out of it nor overprint their values',
  macOnly('laid out in macOS’s system font; Linux WebKit falls back to a wider one'),
  async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const tasks = Array.from({ length: 50 }, (_, at) => ['doing', at + 1] as const);
    const dashboard = await openDashboard(page, barWidget('Per phase', 3), tasks);
    const panel = dashboard.getByRole('region', { name: 'Per phase' });
    await expect(panel.locator('.bars__column')).toHaveCount(50);

    const spill = await panel.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(spill, 'the chart spills sideways out of its panel').toBeLessThanOrEqual(0);

    const overprinted = await panel.locator('.bars__value').evaluateAll((values) => {
      const boxes = values.map((value) => value.getBoundingClientRect());
      let clashes = 0;
      for (let at = 1; at < boxes.length; at += 1) {
        const [before, here] = [boxes[at - 1], boxes[at]];
        if (before !== undefined && here !== undefined && here.left < before.right - 0.5) {
          clashes += 1;
        }
      }
      return clashes;
    });
    expect(overprinted, 'bar values printed over one another').toBe(0);
  },
);
