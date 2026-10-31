import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection, type FakeHost } from './host.ts';

/**
 * Ask (#37): ⌘J opens a page where a question starts, and every answer is
 * read for its citations. The model is the e2e host's stub Claude Code, so
 * what is proved is DFAI's side: the page, the tools it runs for the model,
 * a citation followed to its block, and a paragraph that cites nothing marked.
 */

const PLANS = `# Plans\n\n${'Filler.\n\n'.repeat(40)}The bank file needs a rollback plan. ^t1\n`;

const READ =
  'Let me read it.<atlas_tool>{"name":"atlas_read_note","input":{"path":"Plans.md"}}</atlas_tool>';
const ANSWER =
  'The bank file needs a rollback plan [[Plans#^t1]].\n\nIt will probably slip a week.';

async function openJournal(page: Page): Promise<FakeHost> {
  const vault = await createVault();
  await vault.write('Plans.md', PLANS);
  await vault.write('Journal.md', '# Journal\n\nToday.\n');
  await vault.mkdir('Chats');
  await vault.write(
    'Chats/What is open for Larkspur.md',
    '---\ntype: chat\n---\n\n## You\n\nWhat is open for Larkspur\n',
  );
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Journal', exact: true })
    .click();
  await expect(page.getByRole('article', { name: 'Journal' })).toBeVisible();
  return host;
}

const ask = (page: Page) => page.getByRole('article', { name: 'Ask' });

test('⌘J opens Ask with the keys in its box, and goes back to the note from it', async ({
  page,
}) => {
  await openJournal(page);

  await page.keyboard.press('Meta+j');
  await expect(ask(page)).toBeVisible();
  await expect(ask(page).getByRole('textbox', { name: 'Ask Claude' })).toBeFocused();
  // The questions asked before, from Chats/.
  await expect(
    ask(page).getByRole('navigation', { name: 'Recent questions' }).getByRole('button'),
  ).toHaveText(['What is open for Larkspur']);

  await page.keyboard.press('Meta+j');
  await expect(page.getByRole('article', { name: 'Journal' })).toBeVisible();
  await expect(ask(page)).toHaveCount(0);

  // Ask is a place of its own in the sidebar too.
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(ask(page)).toBeVisible();
});

test('a question reads a note, the answer cites it, the citation opens the block, and the uncited paragraph is marked', async ({
  page,
}) => {
  const host = await openJournal(page);
  host.claude.reply(READ, ANSWER);

  await page.keyboard.press('Meta+j');
  const box = ask(page).getByRole('textbox', { name: 'Ask Claude' });
  await box.fill('What is left on the bank file?');
  await box.press('Enter');

  await expect(ask(page).getByText('Read Plans.md')).toBeVisible();
  const answer = ask(page).getByRole('region', { name: 'Answer' }).last();
  await expect(answer).toContainText('It will probably slip a week.');

  // The model was offered the assistant's tools, and asked to cite.
  const turns = host.claude.runs().filter((run) => run.args[0] === '-p');
  const system = turns[0]?.args[turns[0].args.indexOf('--system-prompt') + 1] ?? '';
  expect(system).toContain('atlas_brief');
  expect(system).toContain('atlas_open_loops');
  expect(system).toContain('atlas_meeting_quotes');
  expect(system).toContain('marked "not cited"');

  // What the model said on its way to the tool is shown, and not judged.
  await expect(ask(page).getByRole('region', { name: 'Answer' }).first()).toHaveText(
    /Let me read it\./,
  );
  await expect(ask(page).locator('[data-uncited]')).toHaveCount(1);

  // The paragraph that cites nothing is kept, and marked; the cited one is not.
  const uncited = answer.locator('[data-uncited]');
  await expect(uncited).toHaveCount(1);
  await expect(uncited).toContainText('It will probably slip a week.');
  await expect(uncited.getByText('not cited')).toBeVisible();
  await expect(answer.getByText('1 paragraph not cited')).toBeVisible();

  // The citation opens its note at the block, here.
  await answer.getByRole('button', { name: 'Plans' }).click();
  await expect(page.getByRole('article', { name: 'Plans' })).toBeVisible();
  const revealed = page.locator('.editor .is-revealed');
  await expect(revealed).toHaveText('The bank file needs a rollback plan.');
  await expect(revealed).toBeInViewport();
});

test('⌘-click on a citation opens the block in a new tab, and Ask stays', async ({ page }) => {
  const host = await openJournal(page);
  host.claude.reply(ANSWER);

  await page.keyboard.press('Meta+j');
  const box = ask(page).getByRole('textbox', { name: 'Ask Claude' });
  await box.fill('What is left?');
  await box.press('Enter');
  const cite = ask(page)
    .getByRole('region', { name: 'Answer' })
    .getByRole('button', { name: 'Plans' });
  await cite.click({ modifiers: ['Meta'] });

  await expect(page.getByRole('article', { name: 'Plans' })).toBeVisible();
  await expect(page.locator('.editor .is-revealed')).toHaveText(
    'The bank file needs a rollback plan.',
  );
  await expect(page.getByRole('tab', { name: 'Ask' })).toBeVisible();
});

test('a recent question opens its chat again', async ({ page }) => {
  await openJournal(page);
  await page.keyboard.press('Meta+j');
  await ask(page).getByRole('button', { name: 'What is open for Larkspur' }).click();
  await expect(ask(page).getByRole('heading', { name: 'What is open for Larkspur' })).toBeVisible();
});
