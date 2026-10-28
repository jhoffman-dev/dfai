import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, type FakeVault } from './host.ts';
import { pickSuggestion, suggestion } from './link-suggest.ts';

/**
 * P30-01: PARA, as #213 has it — one Project type, offered, never written
 * over the vault's own; capture lands in the Inbox; the Inbox files a note under
 * a project or an area — linked, and moved to its type's home folder, never
 * the project's (#214) — and offers nothing else to file it under.
 */

const TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, doing, done]',
  '---',
  '',
].join('\n');

/** James's own project type, with a property DFAI never wrote. */
const PROJECT_TYPE = [
  '---',
  'name: project',
  'label: Project',
  'properties:',
  '  budget:',
  '    kind: number',
  '    label: Budget',
  '---',
  '',
  '# Project',
  '',
].join('\n');

const TASK_TEMPLATE = ['---', 'type: task', 'status: backlog', '---', '', '# ', '', ''].join('\n');

// A filed Inbox task goes to the task type's home for today (#214).
const TODAY = new Date().toLocaleDateString('en-CA');
const [YEAR, MONTH] = [TODAY.slice(0, 4), TODAY.slice(5, 7)];
const FILED_TASK = `Tasks/${YEAR}/${MONTH}/Renew the passport.md`;

const note = (frontmatter: string[], body: string) =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n');

async function openParaVault(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/templates');
  await vault.mkdir('Projects');
  await vault.mkdir('Areas');
  await vault.mkdir('People');
  await vault.mkdir('Inbox/Meetings');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/types/project.md', PROJECT_TYPE);
  await vault.write('.atlas/templates/Task.md', TASK_TEMPLATE);
  await vault.write('Projects/DFAI.md', note(['type: project', 'budget: 10'], 'The app.'));
  await vault.write('Areas/Garden.md', note(['type: area'], 'Beds and seeds.'));
  await vault.write('People/Mara Quill.md', note(['type: person'], 'A neighbour.'));
  await vault.write(
    'Inbox/Meetings/2026-10-01 Seed swap.md',
    note(['type: meeting'], 'Who brings what.'),
  );

  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

const goTo = (page: Page) => page.getByRole('list', { name: 'Go to' });
const inboxPage = (page: Page) => page.getByRole('article', { name: 'Inbox' });

async function capture(page: Page, line: string) {
  await page.keyboard.down('Meta');
  await page.keyboard.down('Shift');
  await page.keyboard.press('n');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Meta');
  const field = page.getByRole('textbox', { name: 'What needs doing' });
  await field.fill(line);
  await field.press('Enter');
  await page.keyboard.press('Escape');
}

test('opening a vault writes no Area or Resource type, and only offers PARA on the project type James wrote (#213)', async ({
  page,
}) => {
  const vault = await openParaVault(page);
  await goTo(page)
    .getByRole('button', { name: /^Inbox/ })
    .click();

  const offer = inboxPage(page).getByRole('complementary', {
    name: 'Set your types up for the Inbox',
  });
  await expect(offer).toContainText('Project gains Area, linking area notes. Project gains PARA.');
  expect(await vault.exists('.atlas/types/area.md')).toBe(false);
  expect(await vault.exists('.atlas/types/resource.md')).toBe(false);
  expect(await vault.read('.atlas/types/project.md')).toBe(PROJECT_TYPE);
});

test('the Inbox offers to move Area notes onto the Project type, and moves them only when asked (#213)', async ({
  page,
}) => {
  const vault = await openParaVault(page);
  await goTo(page)
    .getByRole('button', { name: /^Inbox/ })
    .click();

  const move = inboxPage(page).getByRole('region', { name: 'Move notes onto the Project type' });
  await expect(move).toContainText('1 note would move onto it.');
  await move.getByRole('button', { name: 'Preview the move' }).click();
  await expect(move.getByRole('list', { name: 'Notes that move' })).toHaveText(
    'Garden: Area → Project, PARA Area',
  );
  expect(await vault.read('Areas/Garden.md')).toBe(note(['type: area'], 'Beds and seeds.'));

  await move.getByRole('button', { name: 'Move 1 note' }).click();
  await expectFile(vault, 'Areas/Garden.md').toBe(
    note(['type: project', 'para: area'], 'Beds and seeds.'),
  );
  await expect(move).toContainText('Moved 1 note onto the Project type, with PARA set.');
});

test('a captured task waits in the Inbox, and Process files it under its project and links it', async ({
  page,
}) => {
  const vault = await openParaVault(page);
  await capture(page, 'Renew the passport');
  await expectFile(vault, 'Inbox/Renew the passport.md').toContain('type: task');

  await goTo(page)
    .getByRole('button', { name: /^Inbox/ })
    .click();
  const inbox = inboxPage(page);
  await expect(inbox.getByRole('button', { name: 'Renew the passport' })).toBeVisible();
  // Whatever arrived, of any type, waits here — a meeting in Inbox/Meetings too.
  await expect(inbox.getByRole('button', { name: '2026-10-01 Seed swap' })).toBeVisible();
  await expect(inbox.getByText('Meeting · Meetings')).toBeVisible();

  const fileUnder = inbox.getByRole('combobox', { name: 'File Renew the passport under' });
  // Projects and areas are offered; a person is not something to file under.
  await fileUnder.click();
  await expect(suggestion(fileUnder, 'DFAI')).toHaveCount(1);
  await expect(suggestion(fileUnder, 'Garden')).toHaveCount(1);
  await expect(suggestion(fileUnder, 'Mara Quill')).toHaveCount(0);

  // A task's row holds what is picked until Done (#112).
  await pickSuggestion(fileUnder, 'DFAI');
  await inbox
    .getByRole('form', { name: 'Clarify Renew the passport' })
    .getByRole('button', { name: 'Save', exact: true })
    .click();

  await expectFile(vault, FILED_TASK).toContain('[[DFAI]]');
  const filed = await vault.read(FILED_TASK);
  expect(filed).toMatch(/^project: "?\[\[DFAI\]\]"?$/m);
  expect(filed).toContain('type: task');
  expect(await vault.exists('Inbox/Renew the passport.md')).toBe(false);
  expect(await vault.exists('Projects/DFAI/Renew the passport.md')).toBe(false);
  await expect(inbox.getByRole('button', { name: 'Renew the passport' })).toHaveCount(0);
  await expect(inbox.getByRole('button', { name: '2026-10-01 Seed swap' })).toBeVisible();
});

test('the Inbox files a meeting under an area, linked, into its home folder', async ({ page }) => {
  const vault = await openParaVault(page);
  await goTo(page)
    .getByRole('button', { name: /^Inbox/ })
    .click();

  await pickSuggestion(
    inboxPage(page).getByRole('combobox', { name: 'File 2026-10-01 Seed swap under' }),
    'Garden',
  );

  // Its home is the month its name starts with.
  const filed = 'Meetings/2026/10/2026-10-01 Seed swap.md';
  await expectFile(vault, filed).toContain('[[Garden]]');
  expect(await vault.read(filed)).toMatch(/^project: "?\[\[Garden\]\]"?$/m);
  expect(await vault.exists('Inbox/Meetings/2026-10-01 Seed swap.md')).toBe(false);
  expect(await vault.exists('Areas/Garden/2026-10-01 Seed swap.md')).toBe(false);
});

test('a task’s project, once its type is extended, offers projects and areas alike', async ({
  page,
}) => {
  const vault = await openParaVault(page);
  await goTo(page)
    .getByRole('button', { name: /^Inbox/ })
    .click();

  const offer = inboxPage(page).getByRole('complementary', {
    name: 'Set your types up for the Inbox',
  });
  await expect(offer).toContainText('task gains Project, linking project or area notes.');
  // Nothing of PARA's is written to a type the vault already has until James says so:
  // opening gave the Task type DFAI's own `focus` alone (#108).
  await expectFile(vault, '.atlas/types/task.md').toBe(
    TASK_TYPE.replace(
      '    options: [backlog, doing, done]\n',
      '    options: [backlog, doing, done]\n  focus:\n    kind: date\n    label: Chosen for\n',
    ),
  );
  await offer.getByRole('button', { name: 'Add to the types' }).click();
  await expectFile(vault, '.atlas/types/task.md').toContain('- area');
  expect(await vault.read('.atlas/types/task.md')).toContain(
    '    options: [backlog, doing, done]\n',
  );

  await capture(page, 'Order seeds');
  await expectFile(vault, 'Inbox/Order seeds.md').toContain('type: task');
  const picker = page.getByRole('region', { name: 'Properties' }).getByLabel('Project');
  await picker.click();
  await expect(suggestion(picker, 'DFAI')).toHaveAttribute('aria-label', /, Projects,/);
  await expect(suggestion(picker, 'Garden')).toHaveAttribute('aria-label', /, Areas,/);
  await expect(suggestion(picker, 'Mara Quill')).toHaveCount(0);
});
