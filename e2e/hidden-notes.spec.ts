import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';

/**
 * What `list_notes` means since A13-09: the host returns what is on disk and the
 * frontend decides what counts as a note. These tests hold the seam from the
 * outside — a note in a hidden folder must be invisible everywhere at once, and
 * an `.atlas` note must be a real note everywhere at once.
 */

const LINKING_NOTE = ['# Today', '', 'A link to [[deleted]] and a link to [[task]].', ''].join(
  '\n',
);

async function openVault(page: Page) {
  const vault = await createVault();
  await vault.write('today.md', LINKING_NOTE);

  // Hidden: other tools' machinery, and a dotted folder nothing was told about.
  await vault.mkdir('.trash');
  await vault.write('.trash/deleted.md', '# Deleted\n\nGraveyard text nobody should find.\n');
  await vault.mkdir('node_modules/pkg');
  await vault.write('node_modules/pkg/readme.md', '# Readme\n\nGraveyard text in a dependency.\n');
  await vault.mkdir('.secret');
  await vault.write('.secret/private.md', '# Private\n\nGraveyard text kept back.\n');

  // DFAI's own configuration: ordinary notes, meant to be opened and edited.
  await vault.mkdir('.atlas/types');
  await vault.write(
    '.atlas/types/task.md',
    '---\nname: task\n---\n\n# Task\n\nA type definition, written as a note.\n',
  );
  await vault.mkdir('.atlas/views');
  await vault.write(
    '.atlas/views/Board.md',
    ['---', 'atlas: view', 'type: task', 'layout: board', '---', '', '# Board', ''].join('\n'),
  );

  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

test('a note in a hidden directory is not listed, linked or indexed', async ({ page }) => {
  await openVault(page);

  // Not in the tree.
  for (const name of ['.trash', 'node_modules', '.secret']) {
    await expect(page.getByRole('treeitem').filter({ hasText: name })).toHaveCount(0);
  }

  // Not a link target: the link says there is no such note rather than opening it.
  await page.getByRole('treeitem', { name: 'today', exact: true }).click();
  await page.getByRole('link', { name: 'deleted' }).click();
  await expect(page.getByRole('alert')).toHaveText('No note called "deleted"');
  await expect(page.getByRole('article', { name: 'deleted' })).toHaveCount(0);

  // Not in the index: three notes reach it — today, the type definition, and
  // the record of the property DFAI gave that type as the vault opened
  // (`focus`, #108). The board has a section of its own, so user space leaves it out.
  await expect(page.getByText('3 notes indexed')).toBeVisible();

  // Not a search result.
  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('graveyard');
  await expect(page.getByText('Nothing matches.')).toBeVisible();
});

test('an .atlas note is an ordinary note: listed, linkable and searchable', async ({ page }) => {
  await openVault(page);

  // The host used to prune .atlas before the list crossed IPC, so a link to a
  // type definition could not resolve. Now it can.
  await page.getByRole('treeitem', { name: 'today', exact: true }).click();
  await page.getByRole('link', { name: 'task' }).click();
  await expect(page.getByRole('article', { name: 'task', exact: true })).toBeVisible();
  await expect(page.getByText('A type definition, written as a note.')).toBeVisible();

  // And it is in the index, so search reaches it.
  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
  const palette = page.getByRole('dialog', { name: 'Search notes' });
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('definition');
  await expect(palette.getByRole('option', { name: /task/i })).toBeVisible();
});

test('a view stays out of user space, where its own section already lists it', async ({ page }) => {
  await openVault(page);

  // .atlas/views has a section of its own; listing it twice is the thing
  // isVisibleEntry rules out, and it survives the host no longer pruning .atlas.
  await expect(sidebarSection(page, 'views').getByRole('listitem')).toHaveCount(1);
  await expect(
    sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Board', exact: true }),
  ).toHaveCount(0);
});
