import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, type FakeVault } from './host.ts';
import { focusThenPress } from './typing.ts';

/**
 * Adversarial: the Proposals section by keyboard and screen reader, now that
 * an answered card leaves the list at once (#166) and cards carry boxes to
 * choose several (#168).
 */

const TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [next, doing, done]',
  '---',
  '',
].join('\n');

const proposal = (title: string) =>
  [
    '---',
    'type: proposal',
    'kind: task',
    'state: open',
    'confidence: high',
    'made_by: after-meeting · run 1',
    'payload:',
    `  title: ${title}`,
    '  properties:',
    '    status: next',
    '---',
    '',
    'Mara Quill asked for it.',
    '',
  ].join('\n');

const TITLES = ['Call Larkspur Payroll', 'Send Tobias the file', 'Book the room', 'Draft the memo'];

async function openProposals(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('Inbox/Proposals');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  for (const title of TITLES) await vault.write(`Inbox/Proposals/${title}.md`, proposal(title));
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /^Inbox/ }).click();
  return vault;
}

const cards = (page: Page) =>
  page.getByRole('list', { name: 'Open proposals' }).getByRole('region');

test('adversarial: the bar over chosen proposals is named for proposals, not notes', async ({
  page,
}) => {
  await openProposals(page);
  // By keyboard: the Inbox's offers are read once it opens and are drawn above
  // the proposals, so a click can land where the box was before they arrived.
  await focusThenPress(page.getByRole('checkbox', { name: 'Select all' }), 'Space');
  await expect(page.getByRole('toolbar', { name: /proposals/i })).toBeVisible();
});

test('adversarial: after Accept by keyboard, focus stays in the list for the next answer', async ({
  page,
}) => {
  await openProposals(page);
  await expect(cards(page)).toHaveCount(4);
  await focusThenPress(
    cards(page).first().getByRole('button', { name: 'Accept', exact: true }),
    'Enter',
  );
  await expect(cards(page)).toHaveCount(3);
  const focusedIn = await page.evaluate(() => {
    const active = document.activeElement;
    return active === null || active === document.body
      ? 'body'
      : active.closest('section[aria-label="Proposals"]') === null
        ? 'elsewhere'
        : 'proposals';
  });
  expect(focusedIn).toBe('proposals');
});
