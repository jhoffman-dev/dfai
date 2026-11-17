/*
 * #431: a body link to a note that does not exist yet is resolved when the
 * linking note is read. A refresh that has a manifest reads again only what
 * changed, so the note made later must send the refresh back to the notes
 * whose body links name it — or its Links panel says "No links yet".
 */
import { expect, test } from './fixtures.ts';
import { createVault, emitVaultChanged, installHost } from './host.ts';

test('a note made after a note linking to it is linked here', async ({ page }) => {
  const vault = await createVault();
  await vault.write('Deal.md', '# Deal\n\nSigned with [[Larkspur Payroll|the payroll firm]].\n');
  // The stand-in index lists what it holds, as the real one does, so a refresh reads only what changed.
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();

  await vault.write('Larkspur Payroll.md', '# Larkspur Payroll\n\nA payroll firm.\n');
  await emitVaultChanged(page, ['Larkspur Payroll.md']);
  await page.getByRole('treeitem', { name: 'Larkspur Payroll', exact: true }).click();

  const panel = page.getByRole('region', { name: 'Links', exact: true });
  await expect(panel.getByRole('button', { name: /^Links/ })).toContainText(
    '1 linked here · 0 linked from here',
  );
});
