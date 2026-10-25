import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection, type FakeHost } from './host.ts';

/**
 * Attack on PR #557 (#548): the sidebar chat draws answers with AskAnswer,
 * and Past chats says when a chat is gone. Fake model and a temp vault of
 * fictional notes only.
 */

const PLAN = '# Plan\n\nOriginal paragraph.\n';
const chatNote = (question: string, answer: string) =>
  `---\ntype: chat\n---\n\n## You\n\n${question}\n\n## Claude\n\n${answer}\n`;
const KICKOFF = 'Chats/Larkspur kickoff.md';
const ROLLOUT = 'Chats/Quill rollout.md';

async function openPlan(page: Page): Promise<FakeHost> {
  const vault = await createVault();
  await vault.write('Plan.md', PLAN);
  await vault.write('Rollback.md', '# Rollback\n\nMara Quill owns the rollback plan. ^r1\n');
  await vault.mkdir('Chats');
  await vault.write(KICKOFF, chatNote('Larkspur kickoff', 'Mara Quill owns the kickoff.'));
  await vault.write(ROLLOUT, chatNote('Quill rollout', 'Tobias Fenn owns the rollout.'));
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Plan', exact: true })
    .click();
  await expect(page.getByRole('article', { name: 'Plan' })).toBeVisible();
  await page.getByRole('button', { name: 'Claude' }).first().click();
  return host;
}

const chat = (page: Page) => page.getByRole('complementary', { name: 'Claude' });
const pastChats = (page: Page) => chat(page).getByRole('navigation', { name: 'Past chats' });

async function ask(page: Page, question: string): Promise<void> {
  await expect(chat(page).getByText('Claude is working…')).toHaveCount(0);
  const box = chat(page).getByRole('textbox', { name: 'Ask Claude' });
  await box.fill(question);
  await box.press('Enter');
}

test('Past chats says so when the list of chats cannot be read', async ({ page }) => {
  const host = await openPlan(page);
  const toggle = chat(page).getByRole('button', { name: 'Past chats' });
  // Read once first: start-up lists the vault's root too, and would take the failure meant here.
  await toggle.click();
  await expect(pastChats(page).getByRole('button', { name: 'Quill rollout' })).toBeVisible();
  await toggle.click();
  host.failNext('list_directory', 'Operation not permitted (os error 1)');
  await toggle.click();

  // An unreadable Chats/ is not "No chats yet": the person's chats are there.
  await expect(pastChats(page).getByRole('alert')).toBeVisible();
  await expect(pastChats(page)).not.toContainText('No chats yet');
});

test('reopening Past chats after a failed read reads the list once more, not in a loop', async ({
  page,
}) => {
  const host = await openPlan(page);
  host.failNext('list_directory', 'Operation not permitted (os error 1)');
  const toggle = chat(page).getByRole('button', { name: 'Past chats' });
  await toggle.click();
  await expect(pastChats(page)).toBeVisible();
  await toggle.click();
  await expect(pastChats(page)).toHaveCount(0);

  const before = host.callsTo('list_directory');
  await toggle.click();
  await expect(pastChats(page).getByRole('button', { name: 'Quill rollout' })).toBeVisible();
  await toggle.click();
  await toggle.click();
  await expect(pastChats(page).getByRole('button', { name: 'Quill rollout' })).toBeVisible();
  // Two openings, each one listing of the vault's root and one of Chats/.
  expect(host.callsTo('list_directory') - before).toBeLessThanOrEqual(4);
});

test('the chat picked last is the one shown, when an earlier pick is read more slowly', async ({
  page,
}) => {
  const host = await openPlan(page);
  const releaseKickoff = host.holdReads(KICKOFF, { alone: true });
  const toggle = chat(page).getByRole('button', { name: 'Past chats' });

  await toggle.click();
  await pastChats(page).getByRole('button', { name: 'Larkspur kickoff' }).click();
  await toggle.click();
  await pastChats(page).getByRole('button', { name: 'Quill rollout' }).click();
  const log = chat(page).getByRole('log', { name: 'Conversation' });
  await expect(log).toContainText('Tobias Fenn owns the rollout.');

  releaseKickoff();
  // A round trip to the host after the release: the held read has landed by its end.
  await toggle.click();
  await expect(pastChats(page).getByRole('button', { name: 'Quill rollout' })).toBeVisible();
  await toggle.click();
  // The slow read of the first pick landing must not replace the second.
  await expect(log).not.toContainText('Mara Quill owns the kickoff.');
  await expect(log).toContainText('Tobias Fenn owns the rollout.');
});

test('a right-to-left override in a link label does not reverse the host drawn beside it', async ({
  page,
}) => {
  const host = await openPlan(page);
  host.claude.reply('Pay here: [Larkspur billing\u202E](https://moc.elgoog.evil.example/pay).');
  await ask(page, 'Where do I pay?');

  const shown = chat(page).getByRole('region', { name: 'Answer' }).locator('.ask__host');
  await expect(shown).toContainText('moc.elgoog.evil.example');
  // Where the host's first and last letters are drawn: left to right, as it opens.
  const order = await shown.evaluate((span) => {
    // React may split " (", the host and ")" into text nodes of their own.
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode() as Text | null;
    while (text !== null && !text.data.includes('moc.')) text = walker.nextNode() as Text | null;
    if (text === null) throw new Error('the host is not drawn');
    const value = text.data;
    const at = (index: number) => {
      const range = document.createRange();
      range.setStart(text, index);
      range.setEnd(text, index + 1);
      return range.getBoundingClientRect().x;
    };
    return { first: at(value.indexOf('moc.')), last: at(value.lastIndexOf('e')) };
  });
  expect(order.first).toBeLessThan(order.last);
});

test('a long unbreakable word, address and code in an answer stay in the sidebar column', async ({
  page,
}) => {
  const host = await openPlan(page);
  const word = 'larkspur'.repeat(40);
  host.claude.reply(
    `${word}\n\nSee https://example.com/${'q'.repeat(300)} and \`${'x'.repeat(300)}\`.\n\n` +
      `\`\`\`\n${'y'.repeat(300)}\n\`\`\``,
  );
  await ask(page, 'Long words?');
  await expect(chat(page).getByRole('region', { name: 'Answer' })).toContainText('larkspur');
  const log = chat(page).getByRole('log', { name: 'Conversation' });
  expect(await log.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
});

test('a long unbreakable question stays in the sidebar column', async ({ page }) => {
  const host = await openPlan(page);
  host.claude.reply('Noted.');
  await ask(page, 'tobiasfenn'.repeat(40));
  await expect(chat(page).getByRole('region', { name: 'Answer' })).toContainText('Noted.');
  const log = chat(page).getByRole('log', { name: 'Conversation' });
  expect(await log.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
});

/** The chunk the sidebar chat now lives in (#552). */
const LATER_PARTS = '**/assets/later-parts-*.js';

test('the sidebar chat whose chunk failed draws a cited answer once Reload brings it back', async ({
  page,
}) => {
  let failing = true;
  await page.route(LATER_PARTS, (route) => (failing ? route.abort() : route.continue()));
  const host = await openPlan(page);
  const unloaded = chat(page).getByRole('alert').filter({ hasText: 'couldn’t load' });
  await expect(unloaded).toHaveCount(1);

  failing = false;
  await unloaded.getByRole('button', { name: 'Reload' }).click();
  await expect(chat(page).getByRole('textbox', { name: 'Ask Claude' })).toBeVisible();
  host.claude.reply('Mara Quill owns it [[Plan]].');
  await ask(page, 'Who owns it?');
  await expect(
    chat(page).getByRole('region', { name: 'Answer' }).getByRole('button', { name: 'Plan' }),
  ).toBeVisible();
  await expect(unloaded).toHaveCount(0);
});

test('the sidebar chat whose chunk failed can be closed', async ({ page }) => {
  await page.route(LATER_PARTS, (route) => route.abort());
  await openPlan(page);
  await expect(chat(page).getByRole('alert').filter({ hasText: 'couldn’t load' })).toHaveCount(1);
  await chat(page).getByRole('button', { name: 'Close' }).click();
  await expect(chat(page)).toHaveCount(0);
});

const askPage = (page: Page) => page.getByRole('article', { name: 'Ask' });

test('a question asked in Ask is drawn, cited, in the sidebar showing the same chat', async ({
  page,
}) => {
  const host = await openPlan(page);
  await expect(chat(page).getByRole('textbox', { name: 'Ask Claude' })).toBeVisible();
  await page.keyboard.press('Meta+j');
  await expect(askPage(page)).toBeVisible();
  host.claude.reply('Mara Quill owns it [[Plan]].');
  const box = askPage(page).getByRole('textbox', { name: 'Ask Claude' });
  await box.fill('Who owns it?');
  await box.press('Enter');

  await expect(askPage(page).getByRole('region', { name: 'Answer' })).toContainText('Mara Quill');
  const sidebarAnswer = chat(page).getByRole('region', { name: 'Answer' });
  await expect(sidebarAnswer).toContainText('Mara Quill owns it');
  await expect(sidebarAnswer.getByRole('button', { name: 'Plan' })).toBeVisible();
});

test('a past chat picked in the sidebar while Ask is open is the chat Ask shows', async ({
  page,
}) => {
  await openPlan(page);
  await page.keyboard.press('Meta+j');
  await expect(askPage(page)).toBeVisible();
  await chat(page).getByRole('button', { name: 'Past chats' }).click();
  await pastChats(page).getByRole('button', { name: 'Quill rollout' }).click();

  await expect(chat(page).getByRole('log', { name: 'Conversation' })).toContainText(
    'Tobias Fenn owns the rollout.',
  );
  await expect(askPage(page)).toContainText('Tobias Fenn owns the rollout.');
});

test('⌘-click on a chip in the sidebar, with the box focused, opens the note in a new tab', async ({
  page,
}) => {
  const host = await openPlan(page);
  host.claude.reply('Mara Quill owns it [[Rollback#^r1]].');
  await ask(page, 'Who owns the rollback?');
  const chip = chat(page).getByRole('region', { name: 'Answer' }).getByRole('button', {
    name: 'Rollback',
  });
  await expect(chat(page).getByRole('textbox', { name: 'Ask Claude' })).toBeFocused();
  await chip.click({ modifiers: ['Meta'] });

  await expect(page.getByRole('article', { name: 'Rollback' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Plan' })).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'Rollback' })).toHaveCount(1);
});

test('a plain click on a chip in the sidebar opens the note in place of the one shown', async ({
  page,
}) => {
  const host = await openPlan(page);
  host.claude.reply('Mara Quill owns it [[Rollback#^r1]].');
  await ask(page, 'Who owns the rollback?');
  await chat(page)
    .getByRole('region', { name: 'Answer' })
    .getByRole('button', { name: 'Rollback' })
    .click();

  await expect(page.getByRole('article', { name: 'Rollback' })).toBeVisible();
  await expect(page.locator('.editor .is-revealed')).toHaveText(
    'Mara Quill owns the rollback plan.',
  );
  await expect(page.getByRole('tab', { name: 'Plan' })).toHaveCount(0);
});

test('many chips in one line stay in the sidebar column in a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 700 });
  const host = await openPlan(page);
  host.claude.reply(`Owners: ${Array.from({ length: 30 }, () => '[[Rollback#^r1]]').join('')}.`);
  await ask(page, 'Who owns what?');
  const answer = chat(page).getByRole('region', { name: 'Answer' });
  await expect(answer.getByRole('button', { name: 'Rollback' })).toHaveCount(30);
  const log = chat(page).getByRole('log', { name: 'Conversation' });
  expect(await log.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
});
