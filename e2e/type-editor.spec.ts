/**
 * P17-02: types made and edited in the app. A new type from the sidebar, with a
 * relation to another; a select's option renamed with its notes brought along,
 * which the board's columns follow; and a board grouped by a relation.
 */
import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  expectFile,
  installHost,
  sidebarSection,
  type FakeHost,
  type FakeVault,
} from './host.ts';
import { pickSuggestion, suggestedTitles } from './link-suggest.ts';

const PERSON_TYPE = [
  '---',
  'name: person',
  'label: Person',
  'properties:',
  '  role: text',
  '---',
  '',
].join('\n');

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, next, doing, review, done]',
  '  project:',
  '    kind: relation',
  '    target: project',
  '---',
  '',
  '# Task',
  '',
].join('\n');

const PROJECT_TYPE = [
  '---',
  'name: project',
  'label: Project',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [planned, active, paused, done]',
  '---',
  '',
].join('\n');

const board = (title: string, groupBy: string) =>
  [
    '---',
    'atlas: view',
    'type: task',
    'layout: board',
    `groupBy: ${groupBy}`,
    `columns: [${[...new Set([groupBy, 'status'])].join(', ')}]`,
    'limit: 50',
    '---',
    '',
    `# ${title}`,
    '',
  ].join('\n');

/** A task added from a board goes to the task type's home for today (#214). */
const TODAY = new Date().toLocaleDateString('en-CA');
const TASKS = `Tasks/${TODAY.slice(0, 4)}/${TODAY.slice(5, 7)}`;

const task = (title: string, lines: string[]) =>
  ['---', 'type: task', ...lines, '---', '', `# ${title}`, ''].join('\n');

async function open(
  page: Page,
  files: Record<string, string>,
): Promise<FakeVault & { host: FakeHost }> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.mkdir('.atlas/templates');
  for (const [path, text] of Object.entries(files)) await vault.write(path, text);
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return Object.assign(vault, { host });
}

test('a new type with a relation to Person, and a note of it pointing at someone', async ({
  page,
}) => {
  const vault = await open(page, {
    '.atlas/types/person.md': PERSON_TYPE,
    'Ada Lovelace.md': '---\ntype: person\nrole: Engineer\n---\n\n# Ada Lovelace\n',
  });

  // Beside the Types heading, not inside the list it opens and shuts.
  await page
    .getByRole('region', { name: 'Types' })
    .getByRole('button', { name: 'New type' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'New type' });
  await dialog.getByRole('textbox', { name: 'Type name' }).fill('Book');
  await dialog.getByRole('button', { name: 'grid icon' }).click();
  await dialog.getByRole('button', { name: 'Create type' }).click();

  await expect(dialog).toBeHidden();
  await expectFile(vault, '.atlas/types/book.md').toMatch(/name: book\nlabel: Book\nicon: grid/);
  // It opens with its editor in the right sidebar, and the sidebar lists it.
  await expect(page.getByRole('button', { name: 'Edit type' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    sidebarSection(page, 'types').getByRole('button', { name: /^Book, 0 notes$/ }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Add property' }).click();
  await page.getByRole('textbox', { name: 'Name of Property' }).fill('Author');
  await page.getByRole('textbox', { name: 'Name of Property' }).press('Enter');
  const key = page.getByRole('textbox', { name: 'Key of Author' });
  await key.fill('author');
  await key.press('Enter');
  await page.getByRole('combobox', { name: 'Kind of Author' }).selectOption('relation');
  await page.getByRole('combobox', { name: 'Type Author points at' }).selectOption('person');
  await expectFile(vault, '.atlas/types/book.md').toMatch(
    // The label is the one its key reads as, so it is not written again.
    / {2}author:\n {4}kind: relation\n {4}target: person\n---/,
  );

  // The type's notes are on its page beside the editor all along.
  await page.getByRole('button', { name: 'New book' }).click();
  const author = page
    .getByRole('region', { name: 'Properties' })
    .getByRole('combobox', { name: 'Author', exact: true });
  await author.click();
  await expect.poll(() => suggestedTitles(author).allTextContents()).toContain('Ada Lovelace');
  await pickSuggestion(author, 'Ada Lovelace');
  await expectFile(vault, 'New Book.md').toMatch(/type: book\nauthor: "\[\[Ada Lovelace\]\]"/);
});

test('renaming a status option brings the tasks along, and the board column follows', async ({
  page,
}) => {
  const vault = await open(page, {
    '.atlas/types/task.md': TASK_TYPE,
    '.atlas/views/Board.md': board('Board', 'status'),
    'first.md': task('First', ['status: review']),
    'second.md': task('Second', ['status: review']),
    'third.md': task('Third', ['status: done']),
  });

  await sidebarSection(page, 'types')
    .getByRole('button', { name: /^Task, / })
    .click();
  // Task has a view, so the type opens on it; the type itself is a press away.
  await page.getByRole('button', { name: 'Edit Task type' }).click();
  await page.getByRole('button', { name: 'Edit Status' }).click();
  const rename = page.getByRole('textbox', { name: 'Rename review' });
  await rename.fill('in review');
  await rename.press('Enter');

  const confirm = page.getByRole('alertdialog', { name: 'Confirm change' });
  await expect(confirm).toContainText('2 notes use “review”');
  await confirm.getByRole('button', { name: 'Rename and update 2 notes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Updated 2 notes.' })).toBeVisible();

  await expectFile(vault, '.atlas/types/task.md').toContain(
    'options: [backlog, next, doing, in review, done]',
  );
  // The option kept the colour its old name gave it.
  await expectFile(vault, '.atlas/types/task.md').toMatch(/colors:\n\s+in review: review/);
  await expectFile(vault, 'first.md').toContain('status: in review');
  await expectFile(vault, 'second.md').toContain('status: in review');
  await expectFile(vault, 'third.md').toContain('status: done');
  // The body of the type file is left as it was.
  await expectFile(vault, '.atlas/types/task.md').toMatch(/---\n\n# Task\n$/);

  await sidebarSection(page, 'views').getByRole('button', { name: 'Board', exact: true }).click();
  const inReview = page.getByRole('region', { name: 'In review' });
  await expect(inReview.getByRole('button', { name: 'first', exact: true })).toBeVisible();
  await expect(inReview.getByRole('button', { name: 'second', exact: true })).toBeVisible();
  await expect(inReview.locator('.status-pill')).toHaveAttribute('data-tone', 'review');
  await expect(page.getByRole('region', { name: 'Done' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Review', exact: true })).toHaveCount(0);
});

test('a board grouped by project has a column per project', async ({ page }) => {
  const vault = await open(page, {
    '.atlas/types/task.md': TASK_TYPE,
    '.atlas/types/project.md': PROJECT_TYPE,
    '.atlas/views/Projects.md': board('Projects', 'project'),
    'DFAI.md': '---\ntype: project\nstatus: active\n---\n\n# DFAI\n',
    'Garden.md': '---\ntype: project\nstatus: planned\n---\n\n# Garden\n',
    'Taxes.md': '---\ntype: project\nstatus: paused\n---\n\n# Taxes\n',
    '.atlas/templates/Project.md': '---\ntype: project\nstatus: planned\n---\n\n# \n',
    'first.md': task('First', ['status: next', 'project: "[[DFAI]]"']),
    'second.md': task('Second', ['status: doing', 'project: "[[DFAI]]"']),
    'third.md': task('Third', ['status: next', 'project: "[[Garden]]"']),
    'fourth.md': task('Fourth', ['status: next']),
  });

  await sidebarSection(page, 'views')
    .getByRole('button', { name: 'Projects', exact: true })
    .click();

  const atlas = page.getByRole('region', { name: 'DFAI', exact: true });
  await expect(atlas.getByRole('button', { name: 'first', exact: true })).toBeVisible();
  await expect(atlas.getByRole('button', { name: 'second', exact: true })).toBeVisible();
  await expect(atlas.getByLabel('2 cards')).toBeVisible();
  const garden = page.getByRole('region', { name: 'Garden', exact: true });
  await expect(garden.getByRole('button', { name: 'third', exact: true })).toBeVisible();
  // A template says it is a project without being one.
  await expect(page.getByRole('region', { name: 'Project', exact: true })).toHaveCount(0);
  // A project with no tasks yet still has a column to add one to.
  const taxes = page.getByRole('region', { name: 'Taxes', exact: true });
  await expect(taxes.getByLabel('0 cards')).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'No value' }).getByRole('button', { name: 'Fourth' }),
  ).toBeVisible();
  // Named for the project, never shown as a link.
  await expect(page.getByText('[[DFAI]]')).toHaveCount(0);

  // A card added to a project's column is filed under that project.
  await taxes.getByRole('button', { name: 'Add to Taxes' }).click();
  await expect(page.getByRole('textbox', { name: 'New card in Taxes' })).toBeFocused();
  await page.keyboard.type('File returns');
  await page.keyboard.press('Enter');
  await expectFile(vault, `${TASKS}/File returns.md`).toContain('project: "[[Taxes]]"');
});

test('switching type while notes are being migrated edits the type now open (R17-01)', async ({
  page,
}) => {
  // Found in review: the editor kept Task after Project was opened, and the
  // next change wrote Task's status select over project.md.
  const project = [
    '---',
    'name: project',
    'label: Project',
    'properties:',
    '  owner: text',
    '  budget: number',
    '---',
    '',
  ].join('\n');
  const vault = await open(page, {
    '.atlas/types/task.md': TASK_TYPE,
    '.atlas/types/project.md': project,
    'first.md': task('First', ['status: review']),
    'second.md': task('Second', ['status: review']),
  });
  const release = vault.host.holdWrites('first.md');

  const types = sidebarSection(page, 'types');
  await types.getByRole('button', { name: /^Task, / }).click();
  await page.getByRole('button', { name: 'Edit type' }).click();
  await page.getByRole('button', { name: 'Edit Status' }).click();
  const rename = page.getByRole('textbox', { name: 'Rename review' });
  await rename.fill('checking');
  await rename.press('Enter');
  const confirm = page.getByRole('alertdialog', { name: 'Confirm change' });
  await confirm.getByRole('button', { name: 'Rename and update 2 notes' }).click();
  await expectFile(vault, '.atlas/types/task.md').toContain('checking');

  // While first.md's write is held, open Project and rename it.
  await types.getByRole('button', { name: /^Project, / }).click();
  await page.getByTitle('Rename this type').click();
  const title = page.getByRole('textbox', { name: 'Type name' });
  await title.fill('Projects');
  await title.press('Enter');
  release();

  await expectFile(vault, '.atlas/types/project.md').toContain('label: Projects');
  expect(await vault.read('.atlas/types/project.md')).toBe(
    project.replace('label: Project', 'label: Projects'),
  );
  await expectFile(vault, 'first.md').toContain('status: checking');
  await expectFile(vault, '.atlas/types/task.md').toContain('label: Task');
});

test('the type editor in the right sidebar writes a change to the type file, every other byte kept', async ({
  page,
}) => {
  // Hand-written, as a person would: a comment, odd spacing, a body. None of it
  // is the editor's to touch; only the property changed is written again.
  const session = [
    '---',
    'name: session',
    'label:   Session',
    '# Kept for the weekly sync with Larkspur Payroll.',
    'properties:',
    '  date: date',
    '  people:',
    '    kind: relation',
    '    target: person',
    '---',
    '',
    '# Session',
    '',
    'What a session note holds.',
    '',
  ].join('\n');
  const vault = await open(page, {
    '.atlas/types/person.md': PERSON_TYPE,
    '.atlas/types/session.md': session,
    'Standup.md': '---\ntype: session\ndate: 2026-10-16\n---\n\n# Standup\n',
  });

  await sidebarSection(page, 'types')
    .getByRole('button', { name: /^Session, / })
    .click();
  const editType = page.getByRole('button', { name: 'Edit type' });
  await expect(editType).toHaveAttribute('aria-pressed', 'false');
  await editType.click();
  await expect(editType).toHaveAttribute('aria-pressed', 'true');

  // The editor is the right sidebar's Type tab, 340px wide, beside the type's notes.
  const aside = page.getByRole('complementary', { name: 'Right sidebar' });
  await expect(aside.getByRole('tab', { name: 'Type' })).toHaveAttribute('aria-selected', 'true');
  await expect
    .poll(() => aside.evaluate((element) => element.getBoundingClientRect().width))
    .toBe(340);
  await expect(page.getByRole('article', { name: 'Session' }).getByRole('table')).toBeVisible();
  await expect(aside.getByText('Saved · edits apply to every Session note')).toBeVisible();

  await aside.getByRole('button', { name: 'Edit People' }).click();
  await aside.getByRole('checkbox', { name: 'Allow many' }).check();
  await expectFile(vault, '.atlas/types/session.md').toBe(
    session.replace('    target: person\n', '    target: person\n    many: true\n'),
  );
  await aside.getByRole('checkbox', { name: 'Required on new notes' }).check();
  await expectFile(vault, '.atlas/types/session.md').toBe(
    session.replace(
      '    target: person\n',
      '    target: person\n    many: true\n    required: true\n',
    ),
  );

  // Pressed again, the editor goes, and the aside with it.
  await editType.click();
  await expect(aside).toBeHidden();
  await expect(editType).toHaveAttribute('aria-pressed', 'false');
});
