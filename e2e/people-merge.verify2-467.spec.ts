/**
 * verify2-467: the Person table's chosen rows after a merge (#464). The
 * merged people are in the Trash, so nothing may still offer to merge them.
 */
import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection, type FakeHost, type FakeVault } from './host.ts';

const PERSON_TYPE = '---\nname: person\nlabel: Person\nproperties:\n  role: text\n---\n';

const FILES: Record<string, string> = {
  '.atlas/types/person.md': PERSON_TYPE,
  'People/Mara Quill.md':
    '---\ntype: person\nemail: mara.quill@larkspur.example.com\nrole: Payroll lead\n---\n\nLeads payroll at Larkspur.\n',
  'Mara.md':
    '---\ntype: person\nemail: mara@larkspur.example.com\nrole: Analyst\n---\n\nMet at the kickoff.\n',
  'Kickoff.md':
    '---\nattendees:\n  - "[[Mara]]"\n  - "[[Tobias Fenn]]"\n---\n\n# Kickoff\n\nWith [[Mara|M]] and [[Mara Quill]].\n',
  'Tobias Fenn.md': '---\ntype: person\n---\n\nRoot copy.\n',
  'People/Tobias Fenn.md': '---\ntype: person\n---\n\nFiled copy.\n',
};

async function openVault(
  page: Page,
  extra: Record<string, string> = {},
): Promise<{ vault: FakeVault; host: FakeHost }> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', '.atlas/views', 'People']) await vault.mkdir(folder);
  for (const [path, text] of Object.entries({ ...FILES, ...extra })) await vault.write(path, text);
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

const mergeDialog = (page: Page) => page.getByRole('dialog', { name: /^Merge/ });

/** Ticks Mara and the root Tobias Fenn in the Person table and merges both into Mara Quill. */
async function mergeTwoFromTheTable(page: Page, host: FakeHost) {
  await sidebarSection(page, 'types')
    .getByRole('button', { name: /^Person/ })
    .click();
  const table = page.locator('.table');
  await table.getByRole('checkbox', { name: 'Select Mara', exact: true }).check();
  await table.getByRole('checkbox', { name: 'Select Tobias Fenn' }).first().check();
  await page
    .getByRole('toolbar', { name: 'Chosen notes' })
    .getByRole('button', { name: 'Merge 2 people into…' })
    .click();
  const picker = page.getByRole('dialog', { name: /^Merge Mara and Tobias Fenn into…/ });
  await picker.getByRole('searchbox', { name: 'Find the person to keep' }).fill('quill');
  await picker.getByRole('searchbox').press('Enter');
  await mergeDialog(page).getByRole('button', { name: 'Merge', exact: true }).click();
  await expect.poll(() => host.trashed().length).toBe(2);
}

test('after merging people chosen in the Person table, the selection bar no longer offers to merge the trashed people', async ({
  page,
}) => {
  const { host } = await openVault(page);
  await mergeTwoFromTheTable(page, host);
  await expect(page.getByRole('toolbar', { name: 'Chosen notes' })).toBeHidden();
});

test('after merging people chosen in the Person table, ⌘K "Merge selected people…" says none are selected', async ({
  page,
}) => {
  const { host } = await openVault(page);
  await mergeTwoFromTheTable(page, host);
  await page.keyboard.press('Escape');
  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('merge selected');
  await page.getByRole('option', { name: /Merge selected people/ }).click();
  await expect(page.getByText(/No people are selected/)).toBeVisible();
});

test('after merging people chosen in a People view, its selection bar no longer offers Merge or Archive for the trashed people', async ({
  page,
}) => {
  const { host } = await openVault(page, {
    '.atlas/views/Everyone.md': '---\natlas: view\ntype: person\nlimit: 50\n---\n\n# Everyone\n',
  });
  await sidebarSection(page, 'views')
    .getByRole('button', { name: 'Everyone', exact: true })
    .click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const table = page.locator('.table');
  await table.getByRole('checkbox', { name: 'Select Mara', exact: true }).check();
  await table.getByRole('checkbox', { name: 'Select Tobias Fenn' }).first().check();
  const bar = page.getByRole('toolbar', { name: 'Chosen notes' });
  await bar.getByRole('button', { name: 'Merge 2 people into…' }).click();
  const picker = page.getByRole('dialog', { name: /^Merge Mara and Tobias Fenn into…/ });
  await picker.getByRole('searchbox', { name: 'Find the person to keep' }).fill('quill');
  await picker.getByRole('searchbox').press('Enter');
  await mergeDialog(page).getByRole('button', { name: 'Merge', exact: true }).click();
  await expect.poll(() => host.trashed().length).toBe(2);
  await expect(bar).toBeHidden();
});
