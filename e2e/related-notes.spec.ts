import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, type FakeHost, type FakeVault } from './host.ts';

/*
 * Related notes and trails (P32-03): notes close in meaning and not linked
 * yet, under a note, through the host's model and cache of meanings (stood in
 * for by `embedding-host.ts`, whose vectors put a word and its synonyms
 * together); a link written only when one is accepted; and a trail stepped
 * along and saved as a note of links.
 */

const STANDUP = '# Standup\n\nMara Quill moves payday to Friday.\n';

async function openVault(page: Page): Promise<{ host: FakeHost; vault: FakeVault }> {
  const vault = await createVault();
  await vault.mkdir('Meetings');
  await vault.mkdir('Payroll');
  await vault.write('Meetings/Standup.md', STANDUP);
  await vault.write('Payroll/Wages.md', '# Wages\n\nWages are paid on the last Friday.\n');
  await vault.write('Garden.md', '# Garden\n\nTobias Fenn keeps bees behind the shed.\n');
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { host, vault };
}

/** Turns search by meaning on from ⌘K, as only the person can, and opens Standup from it. */
async function openStandupByMeaning(page: Page, host: FakeHost) {
  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
  const palette = page.getByRole('dialog', { name: 'Search notes' });
  await palette.getByRole('switch', { name: 'By meaning' }).click();
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('payday');
  await palette
    .getByRole('option', { name: /Standup/ })
    .first()
    .click();
  await expect(page.getByRole('article', { name: 'Standup' })).toBeVisible();
  // Every note read for meaning, so each can be related.
  await expect
    .poll(() => host.embeddings.passages().filter((text) => text.includes('Tobias')).length)
    .toBe(1);
  await expect
    .poll(() => host.embeddings.passages().filter((text) => text.includes('Wages are')).length)
    .toBe(1);
}

test('accepting a related note writes a real link into the file; until then it is not one', async ({
  page,
}) => {
  const { host, vault } = await openVault(page);
  await openStandupByMeaning(page, host);

  await page.getByRole('button', { name: 'Related notes' }).click();
  const related = page.getByRole('list', { name: 'Related notes' });
  await expect(related.getByRole('listitem').first()).toContainText('Wages');
  await expect(related.getByRole('listitem')).toHaveCount(2);
  // Offered, not linked: the file is as it was.
  expect(await vault.read('Meetings/Standup.md')).toBe(STANDUP);

  await page.getByRole('button', { name: 'Dismiss Garden' }).click();
  await expect(related.getByRole('listitem')).toHaveCount(1);

  await page.getByRole('button', { name: 'Link Wages from this note' }).click();
  await expectFile(vault, 'Meetings/Standup.md').toBe(`${STANDUP}\n## Related\n\n- [[Wages]]\n`);
  await expect(
    page.getByText('Nothing else is close in meaning that is not linked already.'),
  ).toBeVisible();
  await expect(page.getByRole('article', { name: 'Standup' })).toContainText('Wages');
});

test('a trail is stepped along by links and meaning, and saved as an ordinary note of links', async ({
  page,
}) => {
  const { host, vault } = await openVault(page);
  await openStandupByMeaning(page, host);

  await page.getByRole('button', { name: 'Related notes' }).click();
  await page.getByRole('button', { name: 'Walk a trail from here' }).click();
  const trail = page.getByRole('region', { name: 'Trail' });
  await expect(trail.getByRole('list', { name: 'Steps' })).toHaveText('Standup');

  await trail
    .getByRole('group', { name: 'Next by related' })
    .getByRole('button', { name: 'Step to Wages' })
    .click();
  await expect(page.getByRole('article', { name: 'Wages' })).toBeVisible();
  const steps = trail.getByRole('list', { name: 'Steps' }).getByRole('button');
  await expect(steps).toHaveText(['Standup', 'Wages']);

  await trail.getByRole('button', { name: 'Step back' }).click();
  await expect(page.getByRole('article', { name: 'Standup' })).toBeVisible();
  await trail.getByRole('button', { name: 'Step forward' }).click();
  await expect(page.getByRole('article', { name: 'Wages' })).toBeVisible();

  await trail.getByRole('button', { name: 'Save trail' }).click();
  await expect(trail.getByRole('status')).toHaveText('Saved as Trail from Standup');
  await expectFile(vault, 'Meetings/Trail from Standup.md').toBe('1. [[Standup]]\n2. [[Wages]]\n');
  // Walking it wrote nothing into the notes walked.
  expect(await vault.read('Meetings/Standup.md')).toBe(STANDUP);
});
