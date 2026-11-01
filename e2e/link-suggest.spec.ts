import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  expectFile,
  expectSaved,
  installHost,
  saveNow,
  type FakeVault,
} from './host.ts';
import { caretAtLineEnd } from './caret.ts';
import { createFromSuggestion, suggestion } from './link-suggest.ts';

/**
 * #465: a link field suggests notes as you type — here the Inbox's project
 * field, where James otherwise had to remember what a project is called and
 * how it is written. Every claim about a file reads the disk.
 */

const TASK_TYPE = [
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
  '    target: [project, area]',
  '  due: date',
  '---',
  '',
  '# Task',
  '',
].join('\n');

const PROJECT_TYPE = ['---', 'name: project', 'label: Project', '---', '', '# Project', ''].join(
  '\n',
);

const note = (frontmatter: string[], body: string) =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n');

// A fixed day, so the folder a task is filed into does not move with the real one.
const NOW = new Date(2026, 9, 14, 12);
const TODAY = NOW.toLocaleDateString('en-CA');
const FILED = `Tasks/${TODAY.slice(0, 4)}/${TODAY.slice(5, 7)}/Call the bank.md`;

async function vaultWithProjects(): Promise<FakeVault> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'Projects', 'Tasks', 'Inbox']) await vault.mkdir(folder);
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write(
    'Projects/Larkspur Payroll migration.md',
    note(['type: project', 'aliases: [LPM]'], 'Moving payroll.'),
  );
  await vault.write('Projects/Larkspur onboarding.md', note(['type: project'], 'New starters.'));
  await vault.write('Projects/Atlas.md', note(['type: project'], 'The app.'));
  await vault.write('Inbox/Call the bank.md', note(['type: task', 'status: inbox'], 'The loan.'));
  return vault;
}

async function openInbox(page: Page, vault: FakeVault) {
  await page.clock.setFixedTime(NOW);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 20_000 });
  await page
    .getByRole('list', { name: 'Go to' })
    .getByRole('button', { name: /^Inbox/ })
    .click();
  const inbox = page.getByRole('article', { name: 'Inbox' });
  await expect(inbox.getByRole('table')).toBeVisible();
  return inbox;
}

test('in the Inbox, a task’s project is set by typing a few letters and picking the suggestion', async ({
  page,
}) => {
  const vault = await vaultWithProjects();
  const inbox = await openInbox(page, vault);
  const project = inbox.getByRole('combobox', { name: 'File Call the bank under' });

  await project.click();
  await page.keyboard.type('lark');
  // Both Larkspur projects meet "lark"; Atlas does not.
  await expect(suggestion(project, 'Larkspur Payroll migration')).toBeVisible();
  await expect(suggestion(project, 'Larkspur onboarding')).toBeVisible();
  await expect(suggestion(project, 'Atlas')).toHaveCount(0);

  // An alias finds its note too, and says so.
  await project.fill('lpm');
  const byAlias = suggestion(project, 'Larkspur Payroll migration');
  await expect(byAlias).toHaveAttribute('aria-label', /also LPM/);
  await byAlias.click();
  await expect(project).toHaveValue('Larkspur Payroll migration');

  // Nothing is written until Save; then the file holds the exact link.
  expect(await vault.read('Inbox/Call the bank.md')).not.toContain('project');
  await inbox
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: 'Call the bank', exact: true }) })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expectFile(vault, FILED).toContain('project: "[[Larkspur Payroll migration]]"');
});

test('the P key opens the project field: three letters and Enter file the task', async ({
  page,
}) => {
  const vault = await vaultWithProjects();
  const inbox = await openInbox(page, vault);
  await inbox
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: 'Call the bank', exact: true }) })
    .focus();
  await page.keyboard.press('p');
  const project = inbox.getByRole('combobox', { name: 'File Call the bank under' });
  await expect(project).toBeFocused();
  await page.keyboard.type('atl');
  await expect(suggestion(project, 'Atlas')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expectFile(vault, FILED).toContain('project: "[[Atlas]]"');
  expect(await vault.read(FILED)).toContain('status: inbox');
});

test('in the Inbox, a project no note has yet is made from what was typed and the task filed under it', async ({
  page,
}) => {
  const vault = await vaultWithProjects();
  await vault.write('.atlas/types/project.md', PROJECT_TYPE);
  const inbox = await openInbox(page, vault);
  const project = inbox.getByRole('combobox', { name: 'File Call the bank under' });
  await createFromSuggestion(project, 'project', 'Kitchen refit');
  // Where a new project goes: beside the vault's other projects.
  await expectFile(vault, 'Projects/Kitchen refit.md').toContain('type: project');
  await inbox
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: 'Call the bank', exact: true }) })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expectFile(vault, FILED).toContain('project: "[[Kitchen refit]]"');
});

test('[[ in a note offers to make a note no note is called yet, writes the link and makes the note', async ({
  page,
}) => {
  const vault = await createVault();
  await vault.write('Plans.md', '# Plans\n\nPacking list.\n');
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 20_000 });
  await page.getByRole('treeitem', { name: 'Plans', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Plans' })).toBeVisible();

  await caretAtLineEnd(page.getByText('Packing list.'));
  await page.keyboard.press('Enter');
  await page.keyboard.type('[[Mara Quill');
  const list = page.getByRole('listbox', { name: 'Link to note' });
  await list.getByRole('option', { name: /Create ‘Mara Quill’/ }).click();

  // A blank note, beside the one in view, as a new note is made.
  await expect.poll(() => vault.exists('Mara Quill.md')).toBe(true);
  await saveNow(page);
  await expectSaved(page);
  await expectFile(vault, 'Plans.md').toContain('[[Mara Quill]]');
});

test('a name a file cannot hold is made cleaned, and linked as made', async ({ page }) => {
  const vault = await createVault();
  await vault.write('Plans.md', '# Plans\n\nPacking list.\n');
  await vault.mkdir('Archive');
  await vault.write('Archive/Offsite.md', '# Offsite\n\nLast year.\n');
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 20_000 });
  await page.getByRole('treeitem', { name: 'Plans', exact: true }).click();
  await caretAtLineEnd(page.getByText('Packing list.'));
  await page.keyboard.press('Enter');
  const list = page.getByRole('listbox', { name: 'Link to note' });

  // An archived note already answers to "Offsite": nothing to make.
  await page.keyboard.type('[[Offsite');
  await expect(list.getByRole('option', { name: /^Create/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');

  await page.keyboard.type('[[Q3: plan');
  await list.getByRole('option', { name: /Create ‘Q3: plan’/ }).click();
  await expect.poll(() => vault.exists('Q3 plan.md')).toBe(true);
  await saveNow(page);
  await expectSaved(page);
  await expectFile(vault, 'Plans.md').toContain('[[Q3 plan]]');
  expect(await vault.exists('Archive/Offsite.md')).toBe(true);
});
