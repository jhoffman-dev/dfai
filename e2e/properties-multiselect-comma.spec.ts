/**
 * #50: a multi-select item holding a comma of its own — `Payroll, Larkspur` —
 * was cut in two the next time the property was edited in the panel, because
 * the box showed the list joined with commas and split it at every one.
 */
import { expect, test } from './fixtures.ts';
import { createVault, expectFile, installHost } from './host.ts';

const PROJECT_TYPE = [
  '---',
  'name: project',
  'label: Project',
  'properties:',
  '  clients:',
  '    kind: multiSelect',
  '---',
  '',
].join('\n');

const NOTE = [
  '---',
  'type: project',
  'clients:',
  '  - Payroll, Larkspur',
  '  - Quill',
  'aliases: ["Fenn, Tobias", Fenn]',
  '---',
  '',
  '# Onboarding',
  '',
].join('\n');

test('an item holding a comma stays one item when another is added in the panel, and in the file', async ({
  page,
}) => {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.write('.atlas/types/project.md', PROJECT_TYPE);
  await vault.write('Onboarding.md', NOTE);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await page.getByRole('treeitem', { name: 'Onboarding', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Onboarding' })).toBeVisible();

  const clients = page
    .getByRole('region', { name: 'Properties' })
    .getByRole('textbox', { name: 'Clients' });
  await expect(clients).toHaveValue('"Payroll, Larkspur", Quill');

  await clients.click();
  await clients.press('End');
  await page.keyboard.type(', Mara');

  // The untouched `aliases` line keeps its bytes; the edited list is three items, the first whole.
  await expectFile(vault, 'Onboarding.md').toBe(
    NOTE.replace('  - Quill\n', '  - Quill\n  - Mara\n'),
  );
  await clients.blur();
  await expect(clients).toHaveValue('"Payroll, Larkspur", Quill, Mara');
});
