// Undo on every change (#320): a change is said in the window's toast, whose
// Undo writes back the very bytes the note held — and is refused, said as a
// warning that also lands in Activity, once the note has moved on since.
import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection, type FakeVault } from './host.ts';
import { toastSaying } from './toasts.ts';

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '  completed: date',
  '  due: date',
  '---',
  '',
].join('\n');

const VIEW = [
  '---',
  'atlas: view',
  'type: task',
  'columns: [status, due]',
  '---',
  '',
  '# Larkspur tasks',
  '',
].join('\n');

/** Written by hand: a comment, quoting and spacing a fresh write would not keep. */
const TASK = [
  '---',
  'type: task',
  "status:   'in-progress'   # since the kickoff with Mara Quill",
  'due: 2026-10-13',
  '---',
  '',
  '# Send the Larkspur invoice',
  '',
  'Body text that stays exactly as written.',
  '',
].join('\n');
const PATH = 'Tasks/Send the Larkspur invoice.md';

/** 2026-10-13, midday where the test runs. */
const NOW = new Date(2026, 9, 13, 12, 0, 0);

async function openVault(page: Page) {
  const vault = await createVault();
  for (const folder of ['.atlas/types', '.atlas/views', 'Tasks']) await vault.mkdir(folder);
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Larkspur tasks.md', VIEW);
  await vault.write(PATH, TASK);
  await installHost(page, vault);
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

const goTo = (page: Page) => page.getByRole('list', { name: 'Go to' });
const today = (page: Page) => page.getByRole('article', { name: 'Today' });

async function openTable(page: Page) {
  await sidebarSection(page, 'views')
    .getByRole('button', { name: 'Larkspur tasks', exact: true })
    .click();
  const status = page.locator('.table [data-cell-stop="status"]').first();
  await expect(status).toBeVisible();
  return status;
}

/** Sets the row's status to Waiting from its picker, by the option's number key. */
async function setWaiting(page: Page, vault: FakeVault) {
  const status = await openTable(page);
  await status.click();
  await expect(page.getByRole('dialog', { name: 'Set Status' })).toBeVisible();
  await page.keyboard.press('5');
  await expectFile(vault, PATH).toMatch(/^status: +'waiting'/m);
}

test('ticking a task on Today is said in a toast, and its Undo gives the file back to the byte', async ({
  page,
}) => {
  const vault = await openVault(page);
  await goTo(page).getByRole('button', { name: 'Today' }).click();
  await expect(today(page)).toBeVisible();

  await today(page).getByRole('checkbox', { name: 'Mark Send the Larkspur invoice done' }).click();
  await expectFile(vault, PATH).toMatch(/^status: +'archive'/m);

  const said = toastSaying(page, 'Finished “Send the Larkspur invoice”.');
  await expect(said).toBeVisible();
  // The toast is the window's, outside the page, and never took the focus.
  await expect(today(page).locator('.toast')).toHaveCount(0);
  await expect(said.locator(':focus')).toHaveCount(0);

  await said.getByRole('button', { name: 'Undo' }).click();

  await expectFile(vault, PATH).toBe(TASK);
  await expect(said).toHaveCount(0);
});

test('a cell edited in a table is said in a toast whose Undo puts the exact bytes back', async ({
  page,
}) => {
  const vault = await openVault(page);
  await setWaiting(page, vault);

  const said = toastSaying(page, 'Changed “Send the Larkspur invoice”.');
  await expect(said).toBeVisible();
  await said.getByRole('button', { name: 'Undo' }).click();

  await expectFile(vault, PATH).toBe(TASK);
  await expect(page.locator('.table [data-cell-stop="status"]').first()).toHaveText(/In Progress/i);
});

test('an Undo after the note moved on is refused, said as a warning, and found later in Activity', async ({
  page,
}) => {
  const vault = await openVault(page);
  await setWaiting(page, vault);
  const said = toastSaying(page, 'Changed “Send the Larkspur invoice”.');
  await expect(said).toBeVisible();

  // Another program edits the note after the change, before the Undo.
  const edited = (await vault.read(PATH)).replace('due: 2026-10-13', 'due: 2026-10-20');
  await vault.write(PATH, edited);
  await said.getByRole('button', { name: 'Undo' }).click();

  const refused = toastSaying(page, 'has changed since');
  await expect(refused).toBeVisible();
  await expect(refused.locator('.toast__dot--warning')).toHaveCount(1);
  await expect(refused.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  expect(await vault.read(PATH)).toBe(edited);

  await goTo(page)
    .getByRole('button', { name: /^Activity/ })
    .click();
  const lines = page
    .getByRole('article', { name: 'Activity' })
    .getByRole('list', { name: 'Activity lines' })
    .getByRole('listitem');
  await expect(
    lines.filter({ hasText: '“Send the Larkspur invoice” has changed since' }),
  ).toHaveCount(1);
});

// Moved from the retired quick-add button's toast (UI v2, Q5): the window's
// toasts keep its corner, bottom right, where they sit on no control.
test('a toast sits bottom right, inside the window, over no control of the table under it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const vault = await openVault(page);
  await setWaiting(page, vault);
  const said = toastSaying(page, 'Changed “Send the Larkspur invoice”.');
  await expect(said).toBeVisible();

  const box = (await said.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(1280);
  expect(box.x + box.width).toBeGreaterThan(1280 - 60);
  expect(box.y + box.height).toBeLessThanOrEqual(800);
  expect(box.y, 'in the bottom quarter').toBeGreaterThan(800 - 200);
  await expect(async () => {
    const covered = await said.evaluate((toast) => {
      const over = toast.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>('button, input, select, [role="tab"]')]
        .filter((control) => !toast.contains(control))
        .filter((control) => {
          const at = control.getBoundingClientRect();
          if (at.width === 0 || at.height === 0) return false;
          const cx = at.left + at.width / 2;
          const cy = at.top + at.height / 2;
          return cx >= over.left && cx <= over.right && cy >= over.top && cy <= over.bottom;
        })
        .map((control) => control.getAttribute('aria-label') ?? control.textContent?.trim() ?? '');
    });
    expect(covered).toEqual([]);
  }).toPass();
});
