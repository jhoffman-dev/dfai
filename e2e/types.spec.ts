import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection } from './host.ts';
import { pickSuggestion, suggestedTitles } from './link-suggest.ts';

const COMPANY_TYPE = [
  '---',
  'name: company',
  'label: Company',
  'properties:',
  '  stage:',
  '    kind: select',
  '    options: [seed, series-a]',
  '  ceo:',
  '    kind: relation',
  '    target: person',
  '---',
  '',
].join('\n');

const PERSON_TYPE = [
  '---',
  'name: person',
  'label: Person',
  'properties:',
  '  role: text',
  '---',
  '',
].join('\n');

const COMPANY_TEMPLATE = ['---', 'type: company', 'stage:', 'ceo:', '---', '', '# ', '', ''].join(
  '\n',
);

async function openTypedVault(page: Page) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/templates');
  await vault.write('.atlas/types/company.md', COMPANY_TYPE);
  await vault.write('.atlas/types/person.md', PERSON_TYPE);
  await vault.write('.atlas/templates/Company.md', COMPANY_TEMPLATE);

  await vault.write(
    'Ada Lovelace.md',
    '---\ntype: person\nrole: Engineer\n---\n\n# Ada Lovelace\n',
  );
  await vault.write('Grace Hopper.md', '---\ntype: person\nrole: Admiral\n---\n\n# Grace Hopper\n');
  await vault.write('Acme.md', '---\ntype: company\nstage: seed\n---\n\n# Acme\n');

  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

test('a typed note shows its properties', async ({ page }) => {
  await openTypedVault(page);
  await page.getByRole('treeitem', { name: 'Acme', exact: true }).click();

  const panel = page.getByRole('region', { name: 'Properties' });
  await expect(panel).toBeVisible();
  // The type is worn by the page's icon tile now, not printed as a chip.
  await expect(panel.getByText('company')).toHaveCount(0);
  await expect(panel.getByLabel('stage')).toHaveValue('seed');
  await expect(panel.getByLabel('ceo')).toBeVisible();
});

test('a relation offers only notes of the type it points at', async ({ page }) => {
  await openTypedVault(page);
  await page.getByRole('treeitem', { name: 'Acme', exact: true }).click();

  const ceo = page.getByRole('region', { name: 'Properties' }).getByLabel('ceo');

  // The choices arrive from the index, so wait for them rather than reading the
  // list the moment the note opens.
  await ceo.click();
  await expect.poll(() => suggestedTitles(ceo).allTextContents()).toContain('Ada Lovelace');

  const offered = await suggestedTitles(ceo).allTextContents();
  expect(offered).toContain('Grace Hopper');
  // Not Acme: it is a company, and this relation points at people.
  expect(offered.join(' ')).not.toContain('Acme');
});

test('choosing a relation writes a wiki link into the frontmatter', async ({ page }) => {
  const vault = await openTypedVault(page);
  await page.getByRole('treeitem', { name: 'Acme', exact: true }).click();

  await pickSuggestion(
    page.getByRole('region', { name: 'Properties' }).getByLabel('ceo'),
    'Ada Lovelace',
  );

  // Quoted, and it has to be: unquoted, `[[Ada Lovelace]]` is a nested YAML
  // array rather than a link. Obsidian writes it the same way.
  await expectFile(vault, 'Acme.md').toContain('ceo: "[[Ada Lovelace]]"');
  // And nothing else about the file changed.
  const saved = await vault.read('Acme.md');
  expect(saved).toContain('type: company');
  expect(saved).toContain('stage: seed');
  expect(saved).toContain('# Acme');
});

test('changing a select writes it through and leaves the body alone', async ({ page }) => {
  const vault = await openTypedVault(page);
  await page.getByRole('treeitem', { name: 'Acme', exact: true }).click();

  await page
    .getByRole('region', { name: 'Properties' })
    .getByLabel('stage')
    .selectOption('series-a');

  await expectFile(vault, 'Acme.md').toContain('stage: series-a');
  expect(await vault.read('Acme.md')).toContain('# Acme');
});

test('a new note from a template arrives with its type and properties', async ({ page }) => {
  const vault = await openTypedVault(page);

  await page.getByRole('button', { name: 'New note' }).click();
  await page.getByRole('menuitem', { name: 'Company' }).click();

  await expect(page.getByRole('article', { name: 'New Company' })).toBeVisible();
  const panel = page.getByRole('region', { name: 'Properties' });
  await expect(panel.getByLabel('ceo')).toBeVisible();

  // Made in the company type's home folder (#214).
  expect(await vault.read('Companies/New Company.md')).toContain('type: company');
});

test('a note with no type shows no properties panel', async ({ page }) => {
  const vault = await openTypedVault(page);
  await vault.write('plain.md', '# Plain\n');
  await page.getByRole('button', { name: 'New note' }).click();
  await page.getByRole('menuitem', { name: 'Blank note' }).click();

  await expect(page.getByRole('article', { name: 'Untitled', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Properties' })).toHaveCount(0);
});

test("a type's table draws its values as the views do: a choice as a status pill", async ({
  page,
}) => {
  await openTypedVault(page);
  await sidebarSection(page, 'types')
    .getByRole('button', { name: /^Company, / })
    .click();

  const table = page.getByRole('article', { name: 'Company', exact: true });
  await expect(table.getByRole('button', { name: 'Acme' })).toBeVisible();
  // The type declares `stage` a select, so its value is a pill with its label,
  // as in a saved view's table — not the raw word in plain text.
  await expect(table.locator('.status-pill')).toHaveText('Seed');
});

test('a new note of a type is listed by the name typed at the top of its page', async ({
  page,
}) => {
  const vault = await openTypedVault(page);
  const companies = sidebarSection(page, 'types').getByRole('button', { name: /^Company, / });
  await companies.click();
  await page.getByRole('button', { name: 'New company' }).click();

  await page
    .getByRole('article', { name: 'New Company', exact: true })
    .getByRole('button', { name: 'New Company', exact: true })
    .click();
  const name = page.getByRole('textbox', { name: 'Note name' });
  await name.fill('Globex');
  await name.press('Enter');
  await expect(page.getByRole('article', { name: 'Globex', exact: true })).toBeVisible();
  await expectFile(vault, 'Companies/Globex.md').toContain('type: company');

  // The type's table names it as its page does, not by a heading it was made with.
  await companies.click();
  const table = page.getByRole('article', { name: 'Company', exact: true });
  await expect(table.getByRole('button', { name: 'Acme' })).toBeVisible();
  await expect(table.getByRole('button', { name: 'Globex', exact: true })).toBeVisible();
  await expect(table.getByRole('button', { name: /^New Company/ })).toHaveCount(0);

  // And search finds it under the same name.
  await page.keyboard.press('Meta+k');
  const search = page.getByRole('searchbox', { name: 'Search the vault' });
  await search.fill('Globex');
  await expect(page.getByRole('option', { name: /Globex/ }).first()).toBeVisible();
  await search.fill('New Company');
  await expect(page.getByRole('option', { name: /New Company/ })).toHaveCount(0);
});
