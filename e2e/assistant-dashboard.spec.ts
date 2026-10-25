import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection, type FakeHost } from './host.ts';

/**
 * P32-05: "build me a dashboard of X" as a proposal. The model is the e2e
 * host's stub; what is proved is DFAI's side: `make_dashboard` checks the
 * spec and leaves a proposal in the Inbox, nothing reaches `.atlas` until
 * the Inbox's Accept writes the dashboard, and Reject writes nothing.
 */

const TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, next-action, done]',
  '---',
  '',
].join('\n');

const DASHBOARD = '.atlas/dashboards/Task board.md';
const PROPOSAL = 'Inbox/Proposals/Task board.md';

const MAKE_DASHBOARD =
  '<atlas_tool>{"name":"make_dashboard","input":{"spec":{"kind":"dashboard","name":"Task board",' +
  '"description":"Every task by status","widgets":[' +
  '{"kind":"donut","title":"By status","type":"task","groupBy":"status"},' +
  '{"kind":"number","title":"All tasks","type":"task"}]}}}</atlas_tool>';

const chat = (page: Page) => page.getByRole('complementary', { name: 'Claude' });

async function askForADashboard(
  page: Page,
): Promise<{ host: FakeHost; vault: Awaited<ReturnType<typeof createVault>> }> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('Plan.md', '# Plan\n');
  const host = await installHost(page, vault);
  host.claude.reply(MAKE_DASHBOARD, 'I proposed a Task board dashboard.');
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Plan', exact: true })
    .click();

  await page.keyboard.press('Meta+Shift+KeyJ');
  const box = chat(page).getByRole('textbox', { name: 'Ask Claude' });
  await box.fill('Build me a dashboard of my tasks by status');
  await box.press('Enter');
  await expect(chat(page).getByText('Proposed the dashboard “Task board”')).toBeVisible();
  await expect(chat(page).getByText('I proposed a Task board dashboard.')).toBeVisible();

  // Proposed, not made: the proposal waits in the Inbox and .atlas has no dashboard.
  await expectFile(vault, PROPOSAL).toContain('kind: dashboard');
  expect(await vault.exists(DASHBOARD)).toBe(false);

  await page.getByRole('button', { name: /^Inbox/ }).click();
  const card = page.getByRole('region', { name: 'Dashboard: Task board' });
  await expect(card).toBeVisible();
  await expect(card.getByText('Accepting makes it in .atlas/dashboards.')).toBeVisible();
  return { host, vault };
}

test('a dashboard Claude was asked for is written into .atlas only on Accept', async ({ page }) => {
  const { vault } = await askForADashboard(page);
  expect(await vault.exists(DASHBOARD)).toBe(false);

  await page
    .getByRole('region', { name: 'Dashboard: Task board' })
    .getByRole('button', { name: 'Accept' })
    .click();

  await expectFile(vault, DASHBOARD).toContain('atlas: dashboard');
  const written = await vault.read(DASHBOARD);
  expect(written).toContain('description: Every task by status');
  expect(written).toContain('groupBy: status');
  expect(written).toContain('# Task board');
  await expect.poll(() => vault.exists(PROPOSAL)).toBe(false);
  // The dashboard is one the sidebar lists, like any other.
  const listed = sidebarSection(page, 'dashboards').getByRole('button', {
    name: 'Task board',
    exact: true,
  });
  await expect(listed).toBeVisible();

  // One step back: Undo takes the dashboard out of .atlas and the proposal waits again.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => vault.exists(DASHBOARD)).toBe(false);
  await expectFile(vault, PROPOSAL).toContain('state: open');
  await expect(listed).toHaveCount(0);
});

test('a rejected dashboard writes nothing into .atlas', async ({ page }) => {
  const { vault } = await askForADashboard(page);

  await page
    .getByRole('region', { name: 'Dashboard: Task board' })
    .getByRole('button', { name: 'Reject' })
    .click();

  await expectFile(vault, `Archive/${PROPOSAL}`).toContain('state: rejected');
  expect(await vault.exists(DASHBOARD)).toBe(false);
  expect(await vault.exists('.atlas/dashboards')).toBe(false);
});
