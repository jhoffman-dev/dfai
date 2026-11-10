// Attack on PR #468 (UI v2 slice 15): Make task's Undo moved from the
// pane's bar into the window's toast, and the toast was lifted over the
// peek so it can be pressed. With the peek's focus trapped, it must still
// be reachable from the keyboard, as the bar's Undo was.
import { expect, test, type Page } from './fixtures.ts';
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
  let reached = false;
  for (let press = 0; press < 40 && !reached; press += 1) {
    await page.keyboard.press('Tab');
    reached = await undo.evaluate((button) => button === document.activeElement).catch(() => false);
  }
  await expect(peek).toBeVisible();
  await expect(said).toBeVisible();
  expect(reached, 'Tab reaches the toast’s Undo').toBe(true);
});

// #815: a warning's details, opened from a toast drawn in the peek's place.
// The popup is its own layer above the peek, so its Escape is its own.
test('details opened from a toast in the peek close on Esc alone, and the focus stays in the peek', async ({
  page,
}) => {
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

  await refused.locator('.toast__details').click();
  const details = page.getByRole('dialog', { name: 'Warning details' });
  await expect(details).toBeVisible();
  await expect(details.getByText(/changed since/)).toBeVisible();
  await expectFocusIn(details);

  await page.keyboard.press('Escape');

  await expect(details).toHaveCount(0);
  await expect(peek).toBeVisible();
  await expectFocusIn(peek);
});
