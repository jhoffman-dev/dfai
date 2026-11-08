import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost } from './host.ts';
import { focusThenPress } from './typing.ts';

/**
 * Adversarial pass on #236 (Performance 1), in WebKit: the `<fieldset>` the
 * Today sections now sit in must not change how they are laid out, and a
 * row's Move to… menu, built on its first press, must take the keyboard the
 * way it does once built.
 */

const NOW = new Date(2026, 9, 13, 12, 0, 0);

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '  due: date',
  '  defer: date',
  '---',
  '',
].join('\n');

const task = (status: string, extra: string[] = []) =>
  ['---', 'type: task', `status: ${status}`, ...extra, '---', '', 'A task.', ''].join('\n');

async function openToday(page: Page) {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'Tasks']) await vault.mkdir(folder);
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('Tasks/Renew the licence.md', task('backlog', ['due: 2026-10-10']));
  await vault.write('Tasks/Draft the plan.md', task('in-progress'));
  await vault.write('Tasks/Call the bank.md', task('next-action'));
  await installHost(page, vault);
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Today' }).click();
  const today = page.getByRole('article', { name: 'Today' });
  await expect(today.getByRole('region', { name: 'Next actions', exact: true })).toBeVisible();
  return today;
}

test('the Today sections are spaced by the page’s gap and their own margin, as before the fieldset', async ({
  page,
}) => {
  const today = await openToday(page);
  const spacing = await today.evaluate((article) => {
    const sections = [...article.querySelectorAll<HTMLElement>('section.review__section')];
    const [first, second] = sections;
    if (first === undefined || second === undefined) return null;
    const gap = Number.parseFloat(getComputedStyle(article).rowGap) || 0;
    const margin = Number.parseFloat(getComputedStyle(second).marginTop) || 0;
    const between = second.getBoundingClientRect().top - first.getBoundingClientRect().bottom;
    return { expected: gap + margin, between: Math.round(between) };
  });

  expect(spacing).not.toBeNull();
  expect(spacing!.expected).toBeGreaterThan(0);
  expect(spacing!.between).toBe(Math.round(spacing!.expected));
});

test('a Move to… menu opened by Enter on its first press puts focus on its first item, as on a later press', async ({
  page,
}) => {
  const today = await openToday(page);
  const trigger = today.getByRole('button', { name: 'Move Call the bank to…' });
  await focusThenPress(trigger, 'Enter');
  const menu = page.getByRole('menu', { name: 'Move Call the bank to' });
  await expect(menu).toBeVisible();
  const items = menu.getByRole('menuitem');
  await expect(items.first()).toBeFocused();
});
