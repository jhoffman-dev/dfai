// Attack on PR #468 (UI v2 slice 15): Alt+Cmd+N now opens capture, and the
// toasts were lifted to z-index 50, above the dialogs and the menus. Neither
// may open a capture that has no vault to land in, nor hide a control of
// the dialog the person is working in.
import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection } from './host.ts';
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
  '---',
  '',
].join('\n');
const VIEW = [
  '---',
  'atlas: view',
  'type: task',
  'columns: [status]',
  '---',
  '',
  '# Tasks',
  '',
].join('\n');
const PATH = 'Tasks/Send the invoice.md';
const TASK = ['---', 'type: task', 'status: in-progress', '---', '', '# Send the invoice', ''].join(
  '\n',
);

async function openVault(page: Page) {
  const vault = await createVault();
  for (const folder of ['.atlas/types', '.atlas/views', 'Tasks']) await vault.mkdir(folder);
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Tasks.md', VIEW);
  await vault.write(PATH, TASK);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

/** Makes a change whose toast stays up: the table's status set to Waiting. */
async function changeWithToast(page: Page, vault: Awaited<ReturnType<typeof openVault>>) {
  await sidebarSection(page, 'views').getByRole('button', { name: 'Tasks', exact: true }).click();
  const status = page.locator('.table [data-cell-stop="status"]').first();
  await status.click();
  await expect(page.getByRole('dialog', { name: 'Set Status' })).toBeVisible();
  await page.keyboard.press('5');
  await expectFile(vault, PATH).toMatch(/^status: +'?waiting/m);
  const said = toastSaying(page, 'Changed “Send the invoice”.');
  await expect(said).toBeVisible();
  // Held up while the pointer is on it, so it is still there when the dialog opens.
  await said.hover();
  return said;
}

test('Alt+Cmd+N with no vault open opens no capture, as the global shortcut does not', async ({
  page,
}) => {
  const vault = await createVault();
  await installHost(page, vault);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Open a vault' })).toBeVisible();

  await page.keyboard.press('Alt+Meta+n');

  await expect(page.getByRole('dialog', { name: 'Capture a task' })).toHaveCount(0);
});

test('a toast left up hides no control of the Settings dialog opened over it', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  const vault = await openVault(page);
  const said = await changeWithToast(page, vault);

  await page.keyboard.press('Meta+Comma');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await expect(said).toBeVisible();

  const hidden = await settings.evaluate((dialog) =>
    [...dialog.querySelectorAll<HTMLElement>('button, input, select, a[href], [role="tab"]')]
      .filter((control) => {
        const at = control.getBoundingClientRect();
        if (at.width === 0 || at.height === 0) return false;
        const cx = at.left + at.width / 2;
        const cy = at.top + at.height / 2;
        if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return false;
        const hit = document.elementFromPoint(cx, cy);
        return hit !== null && hit.closest('.toast') !== null;
      })
      .map((control) => control.getAttribute('aria-label') ?? control.textContent?.trim() ?? ''),
  );
  expect(hidden).toEqual([]);
});
