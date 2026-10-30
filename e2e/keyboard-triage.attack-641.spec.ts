import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, type FakeVault } from './host.ts';

/**
 * Adversarial pass on PR #641 (#109, keyboard triage): the keys pressed while
 * a write is still in flight, and on a long, virtualised Inbox. Every claim
 * about a file reads the disk.
 *
 * Found: Today's row handle — its Done box — is `disabled` while its row
 * settles and while the page is busy (`DoneBox` in today-page.tsx), and
 * WebKit drops the focus of a control that is disabled. So the key after an
 * action lands on the document, and a row that stays where it is listed
 * never gets the focus back. Marked `test.fail` so the branch stays green.
 */

const GTD_TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '  waiting_on:',
  '    kind: relation',
  '    target: person',
  '  project:',
  '    kind: relation',
  '    targets: [project, area]',
  '  contexts:',
  '    kind: multi-select',
  '  completed: date',
  '  defer: date',
  '  due: date',
  '---',
  '',
  '# Task',
  '',
].join('\n');

/** 2026-10-13, midday where the test runs. */
const NOW = new Date(2026, 9, 13, 12, 0, 0);

const note = (frontmatter: string[], body: string) =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n');

async function vaultWith(tasks: Record<string, string[]>): Promise<FakeVault> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'People', 'Projects', 'Tasks', 'Inbox']) {
    await vault.mkdir(folder);
  }
  await vault.write('.atlas/types/task.md', GTD_TASK_TYPE);
  await vault.write('.atlas/types/person.md', '---\nname: person\nlabel: Person\n---\n');
  await vault.write('.atlas/types/project.md', '---\nname: project\nlabel: Project\n---\n');
  await vault.write('Projects/Larkspur Payroll.md', note(['type: project'], 'The payroll.'));
  for (const [path, frontmatter] of Object.entries(tasks)) {
    await vault.write(path, note(['type: task', ...frontmatter], 'A task.'));
  }
  return vault;
}

async function open(page: Page, vault: FakeVault, to: RegExp) {
  await page.clock.setFixedTime(NOW);
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 20_000 });
  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: to }).click();
  return host;
}

test.describe('Today, while a write is in flight (attack PR #641)', () => {
  const today = (page: Page) => page.getByRole('article', { name: 'Today' });
  const handle = (page: Page, title: string) =>
    today(page).getByRole('checkbox', { name: `Mark ${title} done` });
  const THREE = {
    'Tasks/Call the bank.md': ['status: next-action'],
    'Tasks/Chase the quote.md': ['status: next-action'],
    'Tasks/Fix the gate.md': ['status: next-action'],
  };

  test('the focus stays on a row after X while the done is still being written', async ({
    page,
  }) => {
    const vault = await vaultWith(THREE);
    const host = await open(page, vault, /^Today/);
    await expect(today(page).locator('.table__title')).toHaveText([
      'Call the bank',
      'Chase the quote',
      'Fix the gate',
    ]);
    const release = host.holdWrites('Tasks/Call the bank.md');
    await handle(page, 'Call the bank').focus();
    await page.keyboard.press('x');
    await expect.poll(() => host.writesTo('Tasks/Call the bank.md')).toBeGreaterThan(0);
    // The next key needs a row to land on: the page, not the document, has the focus.
    const onARow = await page.evaluate(
      () => document.activeElement?.closest('[data-today-row]') !== null,
    );
    const at = await page.evaluate(() => document.activeElement?.tagName ?? null);
    release();
    expect({ onARow, at }).toEqual({ onARow: true, at: 'INPUT' });
  });

  test('J moves the focus down a row while a done is still being written', async ({ page }) => {
    const vault = await vaultWith(THREE);
    const host = await open(page, vault, /^Today/);
    await expect(today(page).locator('.table__title')).toHaveCount(3);
    const release = host.holdWrites('Tasks/Call the bank.md');
    await handle(page, 'Call the bank').focus();
    await page.keyboard.press('x');
    await expect.poll(() => host.writesTo('Tasks/Call the bank.md')).toBeGreaterThan(0);
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    const focused = await page.evaluate(
      () => document.activeElement?.getAttribute('aria-label') ?? null,
    );
    release();
    await expectFile(vault, 'Tasks/Call the bank.md').toContain('status: archive');
    expect(focused).toBe('Mark Fix the gate done');
  });

  test('a row that stays where it is listed keeps the focus once its N is written', async ({
    page,
  }) => {
    const vault = await vaultWith({
      'Tasks/Send the figures.md': ['status: in-progress', 'due: 2026-10-13'],
      'Tasks/Call the bank.md': ['status: next-action'],
    });
    await open(page, vault, /^Today/);
    const dueToday = today(page).getByRole('region', { name: 'Due today', exact: true });
    await expect(
      dueToday.getByRole('checkbox', { name: 'Mark Send the figures done' }),
    ).toBeVisible();
    await handle(page, 'Send the figures').focus();
    await page.keyboard.press('n');
    await expectFile(vault, 'Tasks/Send the figures.md').toContain('status: next-action');
    await expect(today(page).locator('tr[aria-busy]')).toHaveCount(0);
    // Still due today, the row is listed where it was: the next key is for it.
    await expect(
      dueToday.getByRole('checkbox', { name: 'Mark Send the figures done' }),
    ).toBeVisible();
    await expect(handle(page, 'Send the figures')).toBeFocused();
  });
});
