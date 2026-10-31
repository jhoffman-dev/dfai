import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  expectFile,
  expectSaved,
  installHost,
  saveNow,
  sidebarSection,
} from './host.ts';
import { caretAtLineEnd } from './caret.ts';

/**
 * Issue #16, ADR-0026: templates have a home. A type's template is edited
 * from the type, made when the type has none; every template is listed on
 * the Templates page, which makes, renames and deletes them; and a template
 * open for editing says so, so it is never taken for a note.
 */

const PERSON_TYPE = [
  '---',
  'name: person',
  'label: Person',
  'properties:',
  '  role: text',
  '---',
  '',
].join('\n');
const BOOK_TYPE = [
  '---',
  'name: book',
  'label: Book',
  'properties:',
  '  author: text',
  '---',
  '',
].join('\n');
const PERSON_TEMPLATE = ['---', 'type: person', 'role:', '---', '', 'Met at:', ''].join('\n');
const MEETING_TEMPLATE = ['---', 'attendees:', '---', '', '## Agenda', ''].join('\n');

async function openVault(page: Page, more: Readonly<Record<string, string>> = {}) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/templates');
  await vault.write('.atlas/types/person.md', PERSON_TYPE);
  await vault.write('.atlas/types/book.md', BOOK_TYPE);
  await vault.write('.atlas/templates/Person.md', PERSON_TEMPLATE);
  await vault.write('.atlas/templates/Meeting.md', MEETING_TEMPLATE);
  await vault.write('Ada.md', ['---', 'type: person', '---', '', 'Hello.', ''].join('\n'));
  for (const [path, text] of Object.entries(more)) await vault.write(path, text);
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

const typeRow = (page: Page, label: string) =>
  sidebarSection(page, 'types').getByRole('button', { name: new RegExp(`^${label}, `) });

/** The band over a template being edited, which no note wears. */
const templateBand = (page: Page) => page.getByRole('complementary', { name: 'Template' });

test('a type’s template is edited from the type, and says it is a template', async ({ page }) => {
  const { vault } = await openVault(page);

  await typeRow(page, 'Person').click();
  await page.getByRole('button', { name: 'Edit template' }).click();

  await expect(templateBand(page)).toContainText('Used for: New Person notes');
  await expect(page.getByRole('article', { name: 'Person' })).toBeVisible();
  // A template is never a favourite: the mark would be copied into every new note.
  await expect(page.getByRole('button', { name: 'Add Person to favorites' })).toHaveCount(0);

  await caretAtLineEnd(page.getByText('Met at:'));
  await page.keyboard.type(' the library');
  await saveNow(page);
  await expectSaved(page);
  await expectFile(vault, '.atlas/templates/Person.md').toBe(
    ['---', 'type: person', 'role:', '---', '', 'Met at: the library', ''].join('\n'),
  );

  // The band leads to every template.
  await page.getByRole('button', { name: 'All templates' }).click();
  await expect(page.getByRole('article', { name: 'Templates' })).toBeVisible();
});

test('a type without a template gets one, from its menu, holding its properties', async ({
  page,
}) => {
  const { vault } = await openVault(page);
  expect(await vault.exists('.atlas/templates/Book.md')).toBe(false);

  await typeRow(page, 'Book').click({ button: 'right' });
  await page
    .getByRole('menu', { name: 'Book' })
    .getByRole('menuitem', { name: 'Edit template' })
    .click();

  await expectFile(vault, '.atlas/templates/Book.md').toBe('---\ntype: book\nauthor:\n---\n');
  await expect(templateBand(page)).toContainText('Used for: New Book notes');

  // And the Templates page lists it, with what it is for.
  await page.getByRole('button', { name: 'All templates' }).click();
  const list = page.getByRole('article', { name: 'Templates' });
  const book = list
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: 'Book', exact: true }) });
  await expect(book).toContainText('New Book notes');
});

test('a new note of the type starts as the edited template', async ({ page }) => {
  const { vault } = await openVault(page);

  await typeRow(page, 'Person').click();
  await page.getByRole('button', { name: 'Edit template' }).click();
  await expect(templateBand(page)).toBeVisible();
  await caretAtLineEnd(page.getByText('Met at:'));
  await page.keyboard.type(' the park');
  await saveNow(page);
  await expectFile(vault, '.atlas/templates/Person.md').toContain('Met at: the park');

  await typeRow(page, 'Person').click();
  await page.getByRole('button', { name: 'New person' }).click();

  // Made in the person type's home folder (#214).
  await expectFile(vault, 'People/New Person.md').toBe(
    ['---', 'type: person', 'role:', '---', '', 'Met at: the park', ''].join('\n'),
  );
  // What opens is the new note, not the template.
  await expect(page.getByRole('article', { name: 'New Person' })).toBeVisible();
  await expect(templateBand(page)).toHaveCount(0);
  expect(await vault.read('.atlas/templates/Person.md')).toContain('Met at: the park');
});

test('a template is deleted from the Templates page, after asking, to the Trash', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);

  await page
    .getByRole('list', { name: 'Go to' })
    .getByRole('button', { name: 'Templates' })
    .click();
  const list = page.getByRole('article', { name: 'Templates' });
  await expect(list.getByRole('button', { name: 'Meeting', exact: true })).toBeVisible();

  await list.getByRole('button', { name: 'Delete Meeting template' }).click();
  const question = page.getByRole('alertdialog', { name: 'Move “Meeting template” to the Trash?' });
  await question.getByRole('button', { name: 'Move to Trash' }).click();

  await expect(list.getByRole('button', { name: 'Meeting', exact: true })).toHaveCount(0);
  await expect.poll(() => host.trashed()).toEqual(['.atlas/templates/Meeting.md']);
  expect(await vault.exists('.atlas/templates/Meeting.md')).toBe(false);
  // The others are untouched.
  await expect(list.getByRole('button', { name: 'Person', exact: true })).toBeVisible();
});

test('templates stay out of the vault’s notes: search and the tree do not list them', async ({
  page,
}) => {
  await openVault(page);

  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
  const palette = page.getByRole('dialog', { name: 'Search notes' });
  const search = page.getByRole('searchbox', { name: 'Search the vault' });
  // A note is found, so the search is working…
  await search.fill('Ada');
  await expect(palette.getByRole('option', { name: /Ada/ })).toBeVisible();
  // …and a template, whose name and text are right there, is not.
  await search.fill('Agenda');
  await expect(palette.getByRole('option')).toHaveCount(0);
  await page.keyboard.press('Escape');

  const userSpace = sidebarSection(page, 'userSpace');
  await userSpace.getByRole('treeitem', { name: 'System', exact: true }).click();
  await expect(userSpace.getByRole('treeitem', { name: 'types', exact: true })).toBeVisible();
  await expect(userSpace.getByRole('treeitem', { name: 'templates', exact: true })).toHaveCount(0);
});

const COMPANY_NOTE = [
  '---',
  'type: company',
  'industry: Payroll',
  '---',
  '',
  'Our client since 2019.',
  '',
].join('\n');

/** A vault where a company was written in the templates folder, and a note links it. */
function openVaultWithStrayNote(page: Page, more: Readonly<Record<string, string>> = {}) {
  return openVault(page, {
    '.atlas/templates/Larkspur Payroll.md': COMPANY_NOTE,
    'Deal.md': 'Signed with [[Larkspur Payroll]].\n',
    ...more,
  });
}

/** Opens the stray note from the Templates page and moves it to the notes from its band. */
async function moveStrayNoteToNotesFromItsBand(page: Page) {
  await page
    .getByRole('list', { name: 'Go to' })
    .getByRole('button', { name: 'Templates' })
    .click();
  const list = page.getByRole('article', { name: 'Templates' });
  await list.getByRole('button', { name: 'Larkspur Payroll', exact: true }).click();
  await expect(templateBand(page)).toBeVisible();
  await templateBand(page).getByRole('button', { name: 'Move to notes…' }).click();
  const question = page.getByRole('alertdialog', { name: 'Make “Larkspur Payroll” a note?' });
  await question.getByRole('button', { name: 'Move to notes' }).click();
}

test('a template that is really a note is moved back to the notes from its band', async ({
  page,
}) => {
  const { vault } = await openVaultWithStrayNote(page);

  await moveStrayNoteToNotesFromItsBand(page);

  // Its bytes are what they were, at the top of the vault, and it is a note again.
  await expectFile(vault, 'Larkspur Payroll.md').toBe(COMPANY_NOTE);
  expect(await vault.exists('.atlas/templates/Larkspur Payroll.md')).toBe(false);
  await expect(page.getByRole('article', { name: 'Larkspur Payroll' })).toBeVisible();
  await expect(templateBand(page)).toHaveCount(0);
  await expect(
    sidebarSection(page, 'userSpace').getByRole('treeitem', {
      name: 'Larkspur Payroll',
      exact: true,
    }),
  ).toBeVisible();
});

// Deal's body link, written while the template was out of the notes, is read
// again when the note it names comes back (#431).
test('a template moved back to the notes is reached again by the link that had nowhere to go', async ({
  page,
}) => {
  await openVaultWithStrayNote(page);
  // The move itself is held to account by the passing test above, which takes the same steps.
  await moveStrayNoteToNotesFromItsBand(page);

  const links = page.getByRole('region', { name: 'Links', exact: true });
  const toggle = links.getByRole('button', { name: /^Links/ });
  await expect(toggle).toContainText('1 linked here');
  await toggle.click();
  await expect(
    links.getByRole('region', { name: 'Links here' }).getByRole('button', { name: 'Deal' }),
  ).toBeVisible();
});

test('a template is moved to the notes from its row, numbered beside a note of its name', async ({
  page,
}) => {
  const { vault } = await openVaultWithStrayNote(page, { 'Meeting.md': 'Already a note.\n' });

  await page
    .getByRole('list', { name: 'Go to' })
    .getByRole('button', { name: 'Templates' })
    .click();
  const list = page.getByRole('article', { name: 'Templates' });
  await list.getByRole('button', { name: 'Move Meeting template to notes' }).click();
  await page
    .getByRole('alertdialog', { name: 'Make “Meeting” a note?' })
    .getByRole('button', { name: 'Move to notes' })
    .click();

  await expectFile(vault, 'Meeting 2.md').toBe(MEETING_TEMPLATE);
  expect(await vault.read('Meeting.md')).toBe('Already a note.\n');
  expect(await vault.exists('.atlas/templates/Meeting.md')).toBe(false);
  await expect(page.getByRole('article', { name: 'Meeting 2' })).toBeVisible();
});
