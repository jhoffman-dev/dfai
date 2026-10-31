import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, type FakeHost } from './host.ts';

/*
 * The search palette's "By meaning" (P32-02): blocks found by what they mean,
 * through the host's model and embeddings cache (stood in for by
 * `embedding-host.ts`, whose vectors put a word and its synonyms together).
 */

async function openVault(page: Page): Promise<FakeHost> {
  const vault = await createVault();
  await vault.mkdir('Meetings');
  await vault.write(
    'Meetings/Standup.md',
    '# Standup\n\nMara Quill moves payday to Friday. ^k3x9a1\n\nThe printer is broken again.\n',
  );
  await vault.write('Garden.md', '# Garden\n\nTobias Fenn keeps bees behind the shed.\n');
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return host;
}

async function openPalette(page: Page) {
  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
  const palette = page.getByRole('dialog', { name: 'Search notes' });
  await expect(palette).toBeVisible();
  return palette;
}

test('by meaning finds a paraphrase the words miss, and opens the note', async ({ page }) => {
  const host = await openVault(page);
  const palette = await openPalette(page);
  const field = page.getByRole('searchbox', { name: 'Search the vault' });

  await field.fill('when are wages paid');
  await expect(palette.getByText('Nothing matches.')).toBeVisible();
  // Nothing is embedded until semantic search is first used.
  expect(host.callsTo('embed')).toBe(0);

  await palette.getByRole('switch', { name: 'By meaning' }).click();
  const hit = palette.getByRole('option').first();
  await expect(hit).toContainText('Standup');
  await expect(hit).toContainText('Mara Quill moves payday to Friday.');
  expect(host.embeddings.passages()).toContain('Standup\nMara Quill moves payday to Friday.');

  await hit.click();
  await expect(palette).toBeHidden();
  await expect(page.getByRole('article', { name: 'Standup' })).toBeVisible();
});

test('a relaunch keeps the cache of meanings and embeds nothing again', async ({ page }) => {
  const host = await openVault(page);
  let palette = await openPalette(page);
  await palette.getByRole('switch', { name: 'By meaning' }).click();
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('honey');
  await expect(palette.getByRole('option').first()).toContainText('Garden');
  await expect.poll(() => host.embeddings.passages().length).toBe(3);

  // The window is opened again: the cache is still there, and the vault was opted in.
  await page.reload();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await expect.poll(() => host.callsTo('embedding_cache_load')).toBe(1);
  palette = await openPalette(page);
  await palette.getByRole('switch', { name: 'By meaning' }).click();
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('beekeeping');
  await expect(palette.getByRole('option').first()).toContainText('Garden');
  expect(host.embeddings.passages()).toHaveLength(3);
});
