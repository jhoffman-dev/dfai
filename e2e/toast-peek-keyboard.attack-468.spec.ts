// Attack on PR #468 (UI v2 slice 15): Make task's Undo moved from the
// pane's bar into the window's toast, and the toast was lifted over the
// peek so it can be pressed. With the peek's focus trapped, it must still
// be reachable from the keyboard, as the bar's Undo was.
import { expect, test, type Locator, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection } from './host.ts';
import { toastSaying } from './toasts.ts';
import { expectFocusIn, focusOn } from './typing.ts';

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, in-progress, archive]',
  '    done: archive',
  '  source: text',
  '---',
  '',
].join('\n');
const PLAN = ['---', 'type: task', 'status: in-progress', '---', '', '- [ ] Order chairs', ''].join(
  '\n',
);
const PATH = 'tasks/Plan the launch.md';

async function promoteInPeek(page: Page) {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'tasks']) await vault.mkdir(folder);
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write(PATH, PLAN);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'types')
    .getByRole('button', { name: /^Task, \d+ notes?$/ })
    .click();
  await page.locator('.table__row .table__link', { hasText: 'Plan the launch' }).click();
  const peek = page.getByRole('dialog', { name: 'Plan the launch' });
  await expect(peek).toBeVisible();
  await peek.getByLabel('Note', { exact: true }).getByText('Order chairs').last().click();
  await peek.getByRole('button', { name: 'Make this line a task' }).click();
  await expectFile(vault, PATH).toContain('[[Order chairs]]');
  const said = toastSaying(page, 'is a task now');
  await expect(said).toBeVisible();
  return { vault, peek, said };
}

test('the Undo of a task made in the peek can be reached by Tab while the peek is open', async ({
  page,
}) => {
  const { peek, said } = await promoteInPeek(page);
  // The toast waits while the focus is in it, so reaching it is enough; the
  // peek's own controls number far fewer than this.
  const undo = said.getByRole('button', { name: 'Undo' });
  // Held under the pointer, so it cannot time out while the keys go round.
  await said.hover();
  // From the peek's own Close, out of the editor, where Tab would indent.
  await focusOn(peek.getByRole('button', { name: 'Close' }));
  const reached = await tabTo(page, undo);
  await expect(peek).toBeVisible();
  await expect(said).toBeVisible();
  expect(reached, 'Tab reaches the toast’s Undo').toBe(true);
});

/** Presses Tab until `target` holds the focus; false when forty presses never reach it. */
async function tabTo(page: Page, target: Locator): Promise<boolean> {
  for (let press = 0; press < 40; press += 1) {
    await page.keyboard.press('Tab');
    const reached = await target
      .evaluate((element) => element === document.activeElement)
      .catch(() => false);
    if (reached) return true;
  }
  return false;
}

/** A warning toast in the peek's place: the Undo of the promoted line, refused. */
async function refusedInPeek(page: Page) {
  const { vault, peek, said } = await promoteInPeek(page);
  // Another program edits the note after the line was promoted, so the Undo is refused: a warning.
  await vault.write(PATH, `${await vault.read(PATH)}\nRing the hire shop first.\n`);
  await said.getByRole('button', { name: 'Undo' }).click();
  const refused = page.locator('.toast-stack .toast').filter({
    has: page.locator('.toast__dot--warning'),
  });
  await expect(refused).toHaveCount(1);
  // In the peek's place for toasts, inside its focus trap (#468).
  await expect(peek.locator('.toast')).toHaveCount(1);
  return { peek, refused, words: refused.locator('.toast__details') };
}

// #815: a warning's details, opened from a toast drawn in the peek's place.
// The popup is its own layer above the peek, so its Escape is its own.
test('details opened from a toast in the peek close on Esc alone, and the focus goes back to the toast’s words', async ({
  page,
}) => {
  const { peek, refused, words } = await refusedInPeek(page);

  await words.click();
  const details = page.getByRole('dialog', { name: 'Warning details' });
  await expect(details).toBeVisible();
  await expect(details.getByText(/changed since/)).toBeVisible();
  await expectFocusIn(details);

  // A fake clock from here, so the warning's five seconds are stepped below, not waited for.
  // In before the popup closes: the toast is held while it is read, and its timer starts after.
  await page.clock.install();
  await page.keyboard.press('Escape');

  await expect(details).toHaveCount(0);
  await expect(peek).toBeVisible();
  // On the words that were pressed: not just somewhere in the peek, and never on the body.
  await expect(refused).toHaveCount(1);
  await expect(words).toBeFocused();

  // That focus was put there, not brought: with the pointer off it, the warning has its five
  // seconds again and goes — and hands the focus to the toasts' column, still inside the peek.
  await peek.locator('.peek__head').hover();
  await page.clock.runFor(6000);
  await expect(refused).toHaveCount(0);
  await expect(peek).toBeVisible();
  const column = peek.locator('.toast-stack');
  await expect(column).toBeFocused();
  // Empty, the column still has a box for the focus ring to show on (WCAG 2.4.7).
  const box = await column.boundingBox();
  expect(box?.width ?? 0, 'the focused column is wide enough to see').toBeGreaterThanOrEqual(24);
  expect(box?.height ?? 0, 'the focused column is tall enough to see').toBeGreaterThanOrEqual(4);
  await expect(column).toHaveCSS('box-shadow', /rgb/);
});

test('a toast’s details in the peek open from the keyboard, and Copy and Close leave the peek up', async ({
  page,
}) => {
  const { peek, refused, words } = await refusedInPeek(page);
  // Held under the pointer, so it cannot time out while the keys go round.
  await refused.hover();
  await focusOn(peek.getByRole('button', { name: 'Close' }));
  expect(await tabTo(page, words), 'Tab reaches the toast’s words').toBe(true);

  await page.keyboard.press('Enter');
  const details = page.getByRole('dialog', { name: 'Warning details' });
  await expect(details).toBeVisible();
  await expect(words).toHaveAttribute('aria-expanded', 'true');
  await expectFocusIn(details);

  // Copy says how it went, either way, and closes nothing.
  await details.getByRole('button', { name: 'Copy' }).click();
  await expect(details.getByText(/^Copied$|^Could not copy\.$/)).toBeVisible();
  await expect(details).toBeVisible();
  // By its class: under the open details the peek is hidden from a role's reach, not from the eye.
  await expect(page.locator('.peek')).toBeVisible();

  await details.getByRole('button', { name: 'Close' }).click();
  await expect(details).toHaveCount(0);
  await expect(peek).toBeVisible();
  await expect(refused).toHaveCount(1);
  await expect(words).toBeFocused();

  // And again by the keys alone: Enter opens them, Escape closes them and nothing else.
  await page.keyboard.press('Enter');
  await expect(details).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
  await expect(peek).toBeVisible();
  await expect(words).toBeFocused();
});
