/**
 * #464: merging duplicate people. From a person's page, "Merge into…" asks
 * who to keep, says what the merge changes, then rewrites every link to the
 * merged person, merges their properties and text into the kept one, and puts
 * them in the Trash. "Possible duplicates" lists the people who may be one,
 * and a pair said not to be is remembered. Every assertion about a file
 * reads the disk.
 */
import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  expectFile,
  installHost,
  pageCommand,
  sidebarSection,
  type FakeHost,
  type FakeVault,
} from './host.ts';
import { toastSaying } from './toasts.ts';

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

async function openVault(page: Page): Promise<{ vault: FakeVault; host: FakeHost }> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'People']) await vault.mkdir(folder);
  for (const [path, text] of Object.entries(FILES)) await vault.write(path, text);
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

async function openNote(page: Page, name: string, folder?: string) {
  const pages = sidebarSection(page, 'userSpace');
  if (folder !== undefined)
    await pages.getByRole('treeitem', { name: folder, exact: true }).click();
  await pages.getByRole('treeitem', { name, exact: true }).first().click();
  await expect(page.getByRole('article', { name })).toBeVisible();
}

const mergeDialog = (page: Page) => page.getByRole('dialog', { name: /^Merge/ });

async function askToMergeMara(page: Page) {
  await openNote(page, 'Mara');
  await pageCommand(page, /^Merge into…/);
  const picker = page.getByRole('dialog', { name: 'Merge Mara into…' });
  await picker.getByRole('searchbox', { name: 'Find the person to keep' }).fill('quill');
  await expect(picker.getByRole('option')).toHaveText([/Mara Quill/]);
  await picker.getByRole('searchbox').press('Enter');
  await expect(
    mergeDialog(page).getByRole('heading', { name: 'Merge Mara into Mara Quill?' }),
  ).toBeVisible();
}

async function openDuplicates(page: Page) {
  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('possible duplicate');
  await page.getByRole('option', { name: /Possible duplicate people/ }).click();
  const list = page.getByRole('dialog', { name: 'Possible duplicates' });
  await expect(list).toBeVisible();
  return list;
}

test('merging a person into another rewrites every link to them, merges them in, and puts them in the Trash', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  await askToMergeMara(page);

  const dialog = mergeDialog(page);
  await expect(dialog.getByRole('list', { name: 'What the merge changes' })).toContainText(
    '2 links in 1 note will open Mara Quill.',
  );
  await expect(dialog.getByRole('region', { name: 'Values kept as they are' })).toContainText(
    'role Payroll lead (not Analyst, from Mara)',
  );
  await dialog.getByRole('button', { name: 'Merge', exact: true }).click();

  await expect(
    toastSaying(page, 'Merged Mara into Mara Quill: 2 links now open Mara Quill.'),
  ).toBeVisible();
  await expectFile(vault, 'Kickoff.md').toBe(
    '---\nattendees:\n  - "[[Mara Quill]]"\n  - "[[Tobias Fenn]]"\n---\n\n# Kickoff\n\nWith [[Mara Quill|M]] and [[Mara Quill]].\n',
  );
  await expectFile(vault, 'People/Mara Quill.md').toMatch(
    /^---\ntype: person\nemail: mara\.quill@larkspur\.example\.com\nrole: Payroll lead\n(?:other_emails:\n {2}- mara@larkspur\.example\.com\naliases:\n {2}- Mara\n|aliases:\n {2}- Mara\nother_emails:\n {2}- mara@larkspur\.example\.com\n)---\n\nLeads payroll at Larkspur\.\n\n## Merged from Mara\n\nMet at the kickoff\.\n$/,
  );
  await expect.poll(() => host.trashed()).toEqual(['Mara.md']);
});

test('ticking people in the Person table and choosing Merge into… merges them all into the one picked', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  await sidebarSection(page, 'types')
    .getByRole('button', { name: /^Person/ })
    .click();
  const table = page.locator('.table');
  await table.getByRole('checkbox', { name: 'Select Mara', exact: true }).check();
  await table.getByRole('checkbox', { name: 'Select Tobias Fenn' }).first().check();
  const bar = page.getByRole('toolbar', { name: 'Chosen notes' });
  await bar.getByRole('button', { name: 'Merge 2 people into…' }).click();

  const picker = page.getByRole('dialog', { name: /^Merge Mara and Tobias Fenn into…/ });
  await picker.getByRole('searchbox', { name: 'Find the person to keep' }).fill('quill');
  await picker.getByRole('searchbox').press('Enter');
  const dialog = mergeDialog(page);
  await expect(
    dialog.getByRole('heading', { name: /^Merge Mara and Tobias Fenn into Mara Quill\?$/ }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Merge', exact: true }).click();

  await expect.poll(() => host.trashed().length).toBe(2);
  await expectFile(vault, 'Kickoff.md').toContain('"[[Mara Quill]]"');
  await expectFile(vault, 'People/Mara Quill.md').toContain(
    '## Merged from Mara\n\nMet at the kickoff.\n',
  );
});

test('the right sidebar of a person offers Merge into… too', async ({ page }) => {
  await openVault(page);
  await openNote(page, 'Mara');
  await page.keyboard.press('Alt+Meta+Backslash');
  const aside = page.getByRole('complementary', { name: 'Right sidebar' });
  await aside.getByRole('tab', { name: 'Properties' }).click();
  await aside.getByRole('button', { name: 'Merge into…' }).click();
  await expect(page.getByRole('dialog', { name: 'Merge Mara into…' })).toBeVisible();
});

test('possible duplicates lists people who may be one, merges a pair, and remembers one that is not', async ({
  page,
}) => {
  const { vault } = await openVault(page);
  const list = await openDuplicates(page);
  const tobias = list.getByRole('listitem', { name: 'Tobias Fenn and Tobias Fenn' });
  await expect(tobias.locator('.status-pill')).toHaveText(['Same name']);
  const mara = list.getByRole('listitem', { name: 'Mara and Mara Quill' });
  await expect(mara).toBeVisible();

  await tobias.getByRole('button', { name: 'Not the same' }).click();
  await expect(tobias).toHaveCount(0);
  await expectFile(vault, '.atlas/settings.md').toContain('notDuplicatePeople');

  // Merged from the list, keeping the other one: then back to the list.
  await mara.getByRole('button', { name: 'Merge…' }).click();
  const dialog = mergeDialog(page);
  await expect(dialog.getByRole('heading', { name: 'Merge Mara Quill into Mara?' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep Mara Quill instead' }).click();
  await expect(dialog.getByRole('heading', { name: 'Merge Mara into Mara Quill?' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
  const again = page.getByRole('dialog', { name: 'Possible duplicates' });
  await expect(again.getByText('No two people look alike.')).toBeVisible();
  await expect.poll(() => vault.exists('Mara.md')).toBe(false);
});

test('screenshots: the menu, the merge question and the possible duplicates, light and dark', async ({
  page,
}) => {
  await openVault(page);
  // A theme switched under a button would be caught mid-fade by the shot.
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
  const out = process.env['SHOTS_DIR'] ?? 'design/out/shots';
  await mkdir(out, { recursive: true });
  const both = async (name: string) => {
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((chosen) => {
        document.documentElement.dataset['theme'] = chosen;
      }, theme);
      await page.screenshot({ path: `${out}/people-merge-${name}-${theme}.png` });
    }
  };
  await openNote(page, 'Mara');
  await page.getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('menuitem', { name: /^Merge into…/ })).toBeVisible();
  await both('menu');
  await page.keyboard.press('Escape');
  await pageCommand(page, /^Merge into…/);
  await page.getByRole('searchbox', { name: 'Find the person to keep' }).fill('quill');
  await page.getByRole('searchbox', { name: 'Find the person to keep' }).press('Enter');
  await expect(mergeDialog(page).getByRole('button', { name: 'Merge', exact: true })).toBeVisible();
  await both('preview');
  await page.keyboard.press('Escape');
  const list = await openDuplicates(page);
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await both('duplicates');
  await page.keyboard.press('Escape');
  await sidebarSection(page, 'types')
    .getByRole('button', { name: /^Person/ })
    .click();
  await page.locator('.table').getByRole('checkbox', { name: 'Select Mara', exact: true }).check();
  await expect(page.getByRole('button', { name: 'Merge into…' })).toBeVisible();
  await both('table');
});
