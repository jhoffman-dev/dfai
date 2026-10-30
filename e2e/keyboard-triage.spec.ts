import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, type FakeVault } from './host.ts';

/**
 * #109: keyboard triage on the Inbox and on Today — a keyboard-only pass over
 * five rows on each: J and K move a visible focus, a letter acts on the row
 * and the focus moves on, U takes the last change back to the row it changed,
 * Return opens the note, and a hint strip says the keys. Every claim about a
 * file reads the disk.
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

const FIVE = [
  'Call the bank',
  'Chase the quote',
  'Learn the cello',
  'Renew the passport',
  'Fix the gate',
];

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
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 20_000 });
  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: to }).click();
}

test.describe('the Inbox', () => {
  const inbox = (page: Page) => page.getByRole('article', { name: 'Inbox' });
  const row = (page: Page, title: string) =>
    inbox(page)
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: title, exact: true }) });

  test('five rows by keys alone: J moves past one, N W X S act and move the focus on, U brings the last back, Return opens it', async ({
    page,
  }) => {
    const vault = await vaultWith(
      Object.fromEntries(FIVE.map((title) => [`Inbox/${title}.md`, ['status: inbox']])),
    );
    await open(page, vault, /^Inbox/);
    const tasks = inbox(page)
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: 'Save', exact: true }) });
    await expect(tasks).toHaveCount(5);
    const titles = await tasks.locator('.table__title').allTextContents();
    const [first = '', ...rest] = titles;

    const strip = inbox(page).getByRole('note', { name: 'Keys for the Inbox' });
    await expect(strip).toBeVisible();
    await expect(strip).toContainText('Move');
    await expect(strip).toContainText('Undo');

    await row(page, first).focus();
    await page.keyboard.press('j');
    await expect(row(page, rest[0] ?? '')).toBeFocused();
    await expect(row(page, rest[0] ?? '')).toHaveClass(/inbox__row--focused/);
    await expect(row(page, first)).not.toHaveClass(/inbox__row--focused/);

    const written = ['next-action', 'waiting', 'archive', 'someday'];
    for (const [at, key] of ['n', 'w', 'x', 's'].entries()) {
      const title = rest[at] ?? '';
      await page.keyboard.press(key);
      await expect(row(page, title)).toHaveCount(0);
      // The last one hands the focus back up, to the one row J moved past.
      await expect(row(page, rest[at + 1] ?? first)).toBeFocused();
      await expectFile(vault, `Inbox/${title}.md`).toContain(`status: ${written[at]}`);
    }

    const last = rest[3] ?? '';
    await page.keyboard.press('u');
    await expectFile(vault, `Inbox/${last}.md`).toContain('status: inbox');
    await expect(row(page, last)).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.getByRole('article', { name: last })).toBeVisible();
  });

  test('a letter typed in the project picker is typed, and fires no key', async ({ page }) => {
    const vault = await vaultWith({ 'Inbox/Call the bank.md': ['status: inbox'] });
    await open(page, vault, /^Inbox/);
    const picker = inbox(page).getByRole('combobox', { name: 'File Call the bank under' });
    await picker.focus();
    await page.keyboard.type('xjnu');
    await expect(picker).toHaveValue('xjnu');
    await expect(picker).toBeFocused();
    expect(await vault.read('Inbox/Call the bank.md')).toContain('status: inbox');
  });
});

test.describe('Today', () => {
  const today = (page: Page) => page.getByRole('article', { name: 'Today' });
  const handle = (page: Page, title: string) =>
    today(page).getByRole('checkbox', { name: `Mark ${title} done` });

  test('five rows by keys alone: X, D, a status, T, each moving the focus on, then U and Return', async ({
    page,
  }) => {
    const vault = await vaultWith({
      'Tasks/Send the figures.md': ['status: next-action', 'due: 2026-10-13'],
      'Tasks/Draft the plan.md': ['status: in-progress'],
      'Tasks/Ship the page.md': ['status: next-action', 'project: "[[Larkspur Payroll]]"'],
      'Tasks/Write the guide.md': ['status: next-action', 'project: "[[Larkspur Payroll]]"'],
      'Tasks/Call the bank.md': ['status: next-action'],
    });
    await open(page, vault, /^Today/);
    await expect(today(page).getByRole('note', { name: 'Keys for Today' })).toBeVisible();
    await expect(today(page).locator('.table__title')).toHaveText([
      'Send the figures',
      'Draft the plan',
      'Ship the page',
      'Write the guide',
      'Call the bank',
    ]);

    await handle(page, 'Send the figures').focus();
    await page.keyboard.press('x');
    await expectFile(vault, 'Tasks/Send the figures.md').toContain('status: archive');
    await expect(handle(page, 'Draft the plan')).toBeFocused();

    await page.keyboard.press('d');
    await expectFile(vault, 'Tasks/Draft the plan.md').toContain('defer: 2026-10-14');
    await expect(handle(page, 'Ship the page')).toBeFocused();

    await page.keyboard.press('j');
    await expect(handle(page, 'Write the guide')).toBeFocused();
    await page.keyboard.press('s');
    await expectFile(vault, 'Tasks/Write the guide.md').toContain('status: someday');
    await expect(handle(page, 'Call the bank')).toBeFocused();

    // Chosen, the row moves up to Chosen for today: the focus goes to the row that was next.
    await page.keyboard.press('k');
    await expect(handle(page, 'Ship the page')).toBeFocused();
    await page.keyboard.press('t');
    await expectFile(vault, 'Tasks/Ship the page.md').toContain('focus: 2026-10-13');
    await expect(
      today(page)
        .getByRole('region', { name: 'Chosen for today', exact: true })
        .getByRole('checkbox', { name: 'Mark Ship the page done' }),
    ).toBeVisible();
    await expect(handle(page, 'Call the bank')).toBeFocused();

    await page.keyboard.press('u');
    await expectFile(vault, 'Tasks/Ship the page.md').not.toContain('focus:');
    await expect(handle(page, 'Ship the page')).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.getByRole('article', { name: 'Ship the page' })).toBeVisible();
  });
});
