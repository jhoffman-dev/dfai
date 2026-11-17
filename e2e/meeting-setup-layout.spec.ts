import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from './fixtures.ts';
import { createVault, installHost } from './host.ts';

/**
 * #812: on the Automations page, the meeting setup's preview takes its own
 * room above an open "After a meeting" rule's editor. It was squeezed to the
 * notice bar's 40px minimum by the page's column, its lines spilling over the
 * editor's Name and When rows.
 */

const shipped = (path: string) =>
  readFileSync(new URL(`../vault/${path}`, import.meta.url), 'utf8');

/** How far two boxes overlap, in px of height: 0 when they do not, -1 when either is not drawn. */
async function overlap(a: Locator, b: Locator): Promise<number> {
  const [one, two] = await Promise.all([a.boundingBox(), b.boundingBox()]);
  if (one === null || two === null) return -1;
  const across = Math.min(one.x + one.width, two.x + two.width) - Math.max(one.x, two.x);
  const down = Math.min(one.y + one.height, two.y + two.height) - Math.max(one.y, two.y);
  return across > 0 && down > 0 ? down : 0;
}

async function openRuleWithPreview(page: Page) {
  // Opened at a normal width, where the sidebar holds the Automations button.
  await page.setViewportSize({ width: 1440, height: 900 });
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.write('.atlas/types/meeting.md', shipped('.atlas/types/meeting.md'));
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  const screen = page.getByRole('article', { name: 'Automations' });
  await page.getByRole('button', { name: 'After a meeting' }).click();
  const editor = screen.getByRole('region', { name: 'Automation' });
  await editor.getByRole('button', { name: 'Create automation' }).click();
  await expect(screen.getByRole('status')).toHaveText('Saved “After a meeting”.');
  await screen.getByRole('button', { name: 'After a meeting', exact: true }).click();
  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveValue('After a meeting');

  const setup = screen.getByRole('region', { name: 'Process meetings when they arrive' });
  await setup.getByRole('button', { name: 'Preview' }).click();
  await expect(setup.getByRole('button', { name: 'Set up' })).toBeVisible();
  await expect(setup.getByRole('heading', { name: 'Skipped' })).toBeVisible();
  return { setup, editor };
}

for (const [label, width, height] of [
  ['a normal window', 1440, 900],
  ['the minimum window', 720, 480],
] as const) {
  test(`the meeting setup preview never overlaps the open rule's editor, at ${label} (#812)`, async ({
    page,
  }) => {
    const { setup, editor } = await openRuleWithPreview(page);
    await page.setViewportSize({ width, height });
    // The bar's own box was squeezed, so what overflows it is measured too.
    for (const part of [
      setup,
      setup.getByRole('heading', { name: 'Skipped' }),
      setup.getByRole('list').last(),
      setup.getByRole('button', { name: 'Set up' }),
      setup.getByRole('button', { name: 'Cancel' }),
    ]) {
      await expect.poll(() => overlap(part, editor)).toBe(0);
    }

    // Cancel puts the preview away; the offer's one line still sits above the editor.
    await setup.getByRole('button', { name: 'Cancel' }).click();
    await expect(setup.getByRole('button', { name: 'Preview' })).toBeVisible();
    await expect.poll(() => overlap(setup, editor)).toBe(0);

    // And the yes still writes: what it did is said in the bar, clear of the editor.
    await setup.getByRole('button', { name: 'Preview' }).click();
    await setup.getByRole('button', { name: 'Set up' }).click();
    await expect(setup.getByRole('status')).toBeVisible();
    await expect.poll(() => overlap(setup, editor)).toBe(0);
  });
}
