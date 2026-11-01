import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, type FakeVault } from './host.ts';
import { suggestion } from './link-suggest.ts';

/**
 * Attacks on PR #469 (#465), in the built app: the Inbox's project field.
 * Fictional names only. Every claim about a file reads the disk.
 */

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '  project:',
  '    kind: relation',
  '    target: [project, area]',
  '---',
  '',
  '# Task',
  '',
].join('\n');

const note = (frontmatter: string[], body: string) =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n');

const NOW = new Date(2026, 9, 14, 12);
const TODAY = NOW.toLocaleDateString('en-CA');
const FILED = `Tasks/${TODAY.slice(0, 4)}/${TODAY.slice(5, 7)}/Call the bank.md`;

/** An odd title: a colon, quotes, a hash-free emoji, an apostrophe. */
const ODD = 'Q3: “Rollout” plan 🚀 Mara’s';

async function vaultWith(projects: readonly string[]): Promise<FakeVault> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'Projects', 'Tasks', 'Inbox']) await vault.mkdir(folder);
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  for (const title of projects) {
    await vault.write(`Projects/${title}.md`, note(['type: project'], 'A project.'));
  }
  await vault.write('Inbox/Call the bank.md', note(['type: task', 'status: inbox'], 'The loan.'));
  return vault;
}

async function openInbox(page: Page, vault: FakeVault) {
  await page.clock.setFixedTime(NOW);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 20_000 });
  await page
    .getByRole('list', { name: 'Go to' })
    .getByRole('button', { name: /^Inbox/ })
    .click();
  const inbox = page.getByRole('article', { name: 'Inbox' });
  await expect(inbox.getByRole('table')).toBeVisible();
  return inbox;
}

test('↓ past the rows the list shows scrolls the active row into view', async ({ page }) => {
  const many = Array.from({ length: 20 }, (_, at) => `Larkspur ${String(at + 1).padStart(2, '0')}`);
  const vault = await vaultWith(many);
  const inbox = await openInbox(page, vault);
  const project = inbox.getByRole('combobox', { name: 'File Call the bank under' });
  await project.click();
  await page.keyboard.type('lark');
  await expect(suggestion(project, 'Larkspur 20')).toBeAttached();
  for (let step = 0; step < 15; step += 1) await page.keyboard.press('ArrowDown');
  const active = page
    .getByRole('listbox', { name: 'Suggested notes' })
    .locator('[role="option"][aria-selected="true"]');
  await expect(active).toHaveCount(1);
  // The list is 280px tall at most: row 16 of 20 is below its fold unless it scrolls.
  await expect(active).toBeInViewport();
});

test('a title with a colon, quotes and an emoji is written as a link that reads back to it', async ({
  page,
}) => {
  const vault = await vaultWith([ODD, 'Larkspur onboarding']);
  const inbox = await openInbox(page, vault);
  const project = inbox.getByRole('combobox', { name: 'File Call the bank under' });
  await project.click();
  await page.keyboard.type('q3');
  await suggestion(project, ODD).click();
  await inbox
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: 'Call the bank', exact: true }) })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expectFile(vault, FILED).toMatch(/^project: .*Q3/m);
  const line = (await vault.read(FILED))?.split('\n').find((each) => each.startsWith('project:'));
  // Valid YAML for the exact link: double-quoted, the title's bytes untouched inside `[[…]]`.
  expect(line).toBe(`project: "[[${ODD}]]"`);
});
