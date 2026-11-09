import { expect, test } from './fixtures.ts';
import { signInOnTheWeb, webVaultOnGitHub } from './web-github.ts';
import { expectFocusIn } from './typing.ts';

/**
 * #667: the web build on an iPad, mostly online. A note opened once opens
 * again with the network gone; one never opened says it needs a connection.
 */

test('on the web, a note opened once opens again offline; another says it needs a connection', async ({
  page,
  context,
}) => {
  await webVaultOnGitHub(page, {
    'Garden plan.md': '# Garden plan\n\nFirst line.\n',
    'Seed list.md': '# Seed list\n\nBeans.\n',
  });
  await signInOnTheWeb(page);
  const note = page.getByLabel('Note', { exact: true });

  await test.step('online, a note opens from GitHub and is kept', async () => {
    await page.getByRole('treeitem', { name: 'Garden plan', exact: true }).tap();
    await expect(note.getByText('First line.')).toBeVisible();
  });

  await test.step('offline, the kept note opens again', async () => {
    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await page.getByRole('treeitem', { name: 'Seed list', exact: true }).tap();
    await expect(page.getByText(/not on this device yet; it needs a connection/)).toBeVisible();
    await page.getByRole('treeitem', { name: 'Garden plan', exact: true }).tap();
    await expect(note.getByText('First line.')).toBeVisible();
  });
});

test('on the web, a save refused because a Mac moved the note offers a copy or discard, never Overwrite', async ({
  page,
}) => {
  const { github } = await webVaultOnGitHub(page, {
    'Garden plan.md': '# Garden plan\n\nFirst line.\n',
  });
  await signInOnTheWeb(page);
  await page.getByRole('treeitem', { name: 'Garden plan', exact: true }).tap();
  const line = page.getByLabel('Note', { exact: true }).getByText('First line.');
  await expect(line).toBeVisible();
  await github.commitOutside({ 'Garden plan.md': '# Garden plan\n\nThe Mac’s line.\n' });

  const box = await line.boundingBox();
  if (box === null) throw new Error('The note’s first line is not on the page.');
  // The far right of the line's block, where a tap leaves the caret at its end.
  await line.tap({ position: { x: box.width - 1, y: box.height / 2 } });
  await expectFocusIn(line);
  await page.keyboard.type(' Tapped.');
  const keep = page.getByRole('button', { name: 'Keep mine as a copy' });
  await expect(keep).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Discard my changes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Overwrite the file' })).toHaveCount(0);

  await keep.tap();
  await expect.poll(() => github.paths()).toContainEqual(expect.stringMatching(/conflict from/));
  expect(await github.textAt('Garden plan.md')).toContain('The Mac’s line.');
});
