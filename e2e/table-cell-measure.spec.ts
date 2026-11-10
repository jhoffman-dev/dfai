/**
 * A table cell keeps its measure (UI v2 slice 4, #296): a long select
 * option's pill is cut short inside its cell rather than spilling past it,
 * and the sticky header stays above a done box's tick when the sheet scrolls.
 */
import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';

const LONG_OPTION = 'waiting-for-the-quarterly-planning-review-to-be-scheduled-and-signed-off';

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  `    options: [backlog, ${LONG_OPTION}, done]`,
  '    done: done',
  '---',
  '',
].join('\n');

async function openTable(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.mkdir('Tasks');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write(
    '.atlas/views/Sheet.md',
    ['---', 'atlas: view', 'type: task', 'layout: table', 'columns: [status]', '---', ''].join(
      '\n',
    ),
  );
  await vault.write(
    'Tasks/Book the hall.md',
    ['---', 'type: task', `status: ${LONG_OPTION}`, '---', ''].join('\n'),
  );
  for (let at = 1; at <= 60; at += 1) {
    await vault.write(
      `Tasks/Chore ${String(at).padStart(2, '0')}.md`,
      ['---', 'type: task', 'status: done', '---', ''].join('\n'),
    );
  }
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 30_000 });
  await sidebarSection(page, 'views').getByRole('button', { name: 'Sheet', exact: true }).click();
  await expect(page.locator('.table__row').first()).toBeVisible();
}

test('a long option’s pill stays inside its cell, and the cell says the whole value', async ({
  page,
}) => {
  await openTable(page);
  const row = page.locator('tr.table__row', {
    has: page.getByRole('button', { name: 'Book the hall', exact: true }),
  });
  const pill = row.locator('.status-pill');
  await expect(pill).toBeVisible();
  // Proven to match: the pill holds the long option.
  await expect(pill).toHaveText(/waiting/i);
  await expect(async () => {
    const spill = await pill.evaluate((element) => {
      const cell = element.closest('td')!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return Math.max(0, box.right - cell.right);
    });
    expect(spill).toBeLessThanOrEqual(0.5);
  }).toPass();
  await expect(row.locator('button.table__cell')).toHaveAttribute('title', LONG_OPTION);
});

test('scrolled, the sticky header stays on top where a done box’s tick is drawn', async ({
  page,
}) => {
  await openTable(page);
  const sheet = page.locator('.table__sheet');
  await sheet.evaluate((element) => {
    element.scrollTop = 7 * 34 + 10;
  });
  await expect
    .poll(() =>
      sheet.evaluate((element) => {
        const head = element.querySelector('thead th.table__done')!.getBoundingClientRect();
        // Where the first drawn tick sits, if a row scrolled under the header: the heading must win.
        const hit = document.elementFromPoint(head.left + head.width / 2, head.top + 4);
        return hit?.closest('th') !== null ? 'header' : `${hit?.className}`;
      }),
    )
    .toBe('header');
});
