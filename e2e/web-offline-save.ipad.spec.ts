import { expect, test, type Page } from './fixtures.ts';
import { signInOnTheWeb, webVaultOnGitHub } from './web-github.ts';

/**
 * #667: a save made on the web with no network waits on the iPad, says
 * "Not saved yet", and is committed once the connection is back — even
 * across a reload of the page in between.
 */

const PLAN = '# Garden plan\n\nFirst line.\n';

async function typeAtTheEnd(page: Page, text: string) {
  const line = page.getByLabel('Note', { exact: true }).getByText('First line.');
  const box = await line.boundingBox();
  if (box === null) throw new Error('The note’s first line is not on the page.');
  // The far right of the line's block, where a tap leaves the caret at its end.
  await line.tap({ position: { x: box.width - 1, y: box.height / 2 } });
  await page.keyboard.type(text);
}

const status = (page: Page) => page.getByRole('status').filter({ hasText: /Sav|Not saved/ });

test('on the web, a save made offline says Not saved yet, and is committed once back online', async ({
  page,
  context,
}) => {
  const { github } = await webVaultOnGitHub(page, { 'Garden plan.md': PLAN });
  await signInOnTheWeb(page);
  await page.getByRole('treeitem', { name: 'Garden plan', exact: true }).tap();
  await expect(page.getByLabel('Note', { exact: true }).getByText('First line.')).toBeVisible();

  await test.step('offline, the edit waits on the device', async () => {
    await context.setOffline(true);
    await typeAtTheEnd(page, ' Offline.');
    await expect(status(page)).toHaveText('Not saved yet', { timeout: 10_000 });
    expect(await github.textAt('Garden plan.md')).toBe(PLAN);
  });

  await test.step('back online, it is committed', async () => {
    await context.setOffline(false);
    await expect.poll(() => github.textAt('Garden plan.md')).toContain('First line. Offline.');
    await expect(status(page)).toHaveText('Saved');
  });
});

test('on the web, a save waiting on the device outlives a reload, and is committed after it', async ({
  page,
  context,
}) => {
  const { github, unreachable } = await webVaultOnGitHub(page, { 'Garden plan.md': PLAN });
  await signInOnTheWeb(page);
  const plan = page.getByRole('treeitem', { name: 'Garden plan', exact: true });
  await plan.tap();
  await expect(page.getByLabel('Note', { exact: true }).getByText('First line.')).toBeVisible();

  // Reads get through, commits do not: the save waits, and GitHub can still say who is signed in.
  unreachable('writes');
  await typeAtTheEnd(page, ' Waited.');
  await expect(status(page)).toHaveText('Not saved yet', { timeout: 10_000 });

  await page.reload();
  await page.getByRole('button', { name: 'Sign out' }).waitFor();
  await plan.tap();
  await expect(
    page.getByLabel('Note', { exact: true }).getByText('First line. Waited.'),
  ).toBeVisible();
  await expect(status(page)).toHaveText('Not saved yet');
  expect(await github.textAt('Garden plan.md')).toBe(PLAN);

  unreachable(false);
  await context.setOffline(true);
  await context.setOffline(false);
  await expect.poll(() => github.textAt('Garden plan.md')).toContain('First line. Waited.');
  await expect(status(page)).toHaveText('Saved');
});

test('on the web, a save made offline and refused because a Mac moved the note goes to the conflict choices', async ({
  page,
  context,
}) => {
  const { github } = await webVaultOnGitHub(page, { 'Garden plan.md': PLAN });
  await signInOnTheWeb(page);
  await page.getByRole('treeitem', { name: 'Garden plan', exact: true }).tap();
  await expect(page.getByLabel('Note', { exact: true }).getByText('First line.')).toBeVisible();
  await context.setOffline(true);
  await typeAtTheEnd(page, ' Mine.');
  await expect(status(page)).toHaveText('Not saved yet', { timeout: 10_000 });
  await github.commitOutside({ 'Garden plan.md': '# Garden plan\n\nThe Mac’s line.\n' });

  await context.setOffline(false);
  const keep = page.getByRole('button', { name: 'Keep mine as a copy' });
  await expect(keep).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Discard my changes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Overwrite the file' })).toHaveCount(0);
  expect(await github.textAt('Garden plan.md')).toContain('The Mac’s line.');

  await keep.tap();
  await expect
    .poll(async () => (await github.paths()).find((path) => path.includes('conflict')))
    .toBeDefined();
  const copy = (await github.paths()).find((path) => path.includes('conflict'))!;
  expect(await github.textAt(copy)).toContain('First line. Mine.');
  expect(await github.textAt('Garden plan.md')).toContain('The Mac’s line.');
  await expect(page.getByLabel('Note', { exact: true }).getByText('The Mac’s line.')).toBeVisible();
});

test('on the web, signing out with typing not yet saved asks first, and keeps it on a no', async ({
  page,
  context,
}) => {
  const { github } = await webVaultOnGitHub(page, { 'Garden plan.md': PLAN });
  await signInOnTheWeb(page);
  await page.getByRole('treeitem', { name: 'Garden plan', exact: true }).tap();
  await expect(page.getByLabel('Note', { exact: true }).getByText('First line.')).toBeVisible();
  await context.setOffline(true);
  await typeAtTheEnd(page, ' Just typed.');
  // At once, inside the autosave's wait: the sign-out writes it into the queue before it counts.
  let asked = '';
  page.once('dialog', (dialog) => {
    asked = dialog.message();
    void dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Sign out' }).tap();
  await expect.poll(() => asked).toContain('A save has not reached GitHub yet');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(status(page)).toHaveText('Not saved yet');

  await context.setOffline(false);
  await expect.poll(() => github.textAt('Garden plan.md')).toContain('First line. Just typed.');
});
