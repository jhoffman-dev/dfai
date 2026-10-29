import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection, type FakeHost } from './host.ts';

/**
 * The chat asks with a skill the person attached (#169, ADR-0050). The model
 * is the e2e host's stub Claude Code, so what is proved is DFAI's side: the
 * skill reaches the system prompt only once picked, framed after DFAI's own
 * rules; the chat note says it was used; taking the chip off takes it out of
 * the next turn; and a skill too long to hand over is refused before Claude
 * is asked.
 */

const INSTRUCTIONS = 'Group what Mara Quill finished by project, then list what slipped.';
const skillFile = (name: string, instructions: string) =>
  [
    '---',
    `name: ${name}`,
    'description: Reviews the week. Use on Fridays.',
    '---',
    '',
    instructions,
    '',
  ].join('\n');

async function openVault(
  page: Page,
): Promise<{ host: FakeHost; vault: Awaited<ReturnType<typeof createVault>> }> {
  const vault = await createVault();
  await vault.write('Plan.md', '# Plan\n\nThe plan.\n');
  await vault.mkdir('.atlas/skills/weekly-review');
  await vault.write(
    '.atlas/skills/weekly-review/SKILL.md',
    skillFile('weekly-review', INSTRUCTIONS),
  );
  await vault.mkdir('.atlas/skills/long-review');
  await vault.write(
    '.atlas/skills/long-review/SKILL.md',
    // Within the Skills page's 20,000 characters, an emoji one; over the run's, an emoji two.
    skillFile('long-review', '😀'.repeat(10_001)),
  );
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Plan', exact: true })
    .click();
  await expect(page.getByRole('article', { name: 'Plan' })).toBeVisible();
  return { host, vault };
}

const chat = (page: Page) => page.getByRole('complementary', { name: 'Claude' });

async function ask(page: Page, question: string): Promise<void> {
  await expect(chat(page).getByText('Claude is working…')).toHaveCount(0);
  const box = chat(page).getByRole('textbox', { name: 'Ask Claude' });
  await box.fill(question);
  await box.press('Enter');
}

const systemPrompts = (host: FakeHost) =>
  host.claude
    .runs()
    .filter((run) => run.args[0] === '-p')
    .map((run) => run.args[run.args.indexOf('--system-prompt') + 1] ?? '');

test('a skill picked by the box is asked with, noted in the chat, and gone once its chip is off', async ({
  page,
}) => {
  const { host, vault } = await openVault(page);
  host.claude.reply('Reviewed.', 'Plain answer.');

  await page.getByRole('button', { name: 'Claude' }).first().click();
  await chat(page).getByRole('button', { name: 'Use a skill' }).click();
  await chat(page)
    .getByRole('listbox', { name: 'Skills' })
    .getByRole('option', { name: 'weekly-review' })
    .click();
  const remove = chat(page).getByRole('button', {
    name: 'Remove the skill weekly-review from the chat',
  });
  await expect(remove).toBeVisible();

  await ask(page, 'Review my week');
  await expect(chat(page).getByText('Reviewed.')).toBeVisible();
  const [first] = systemPrompts(host);
  expect(first).toContain(`<chosen_skill name="weekly-review">\n${INSTRUCTIONS}\n</chosen_skill>`);
  expect(first?.indexOf('chosen_skill')).toBeGreaterThan(
    first?.indexOf('Your tools only read.') ?? 0,
  );
  await expect
    .poll(() => vault.read('Chats/Review my week.md'))
    .toContain('> Used the skill weekly-review');

  await remove.click();
  await expect(remove).toHaveCount(0);
  await ask(page, 'And without it?');
  await expect(chat(page).getByText('Plain answer.')).toBeVisible();
  expect(systemPrompts(host)[1]).not.toContain('chosen_skill');
});

test('/name attaches a skill, and one too long to hand over is refused before Claude is asked', async ({
  page,
}) => {
  const { host } = await openVault(page);
  host.claude.reply('Never sent.');

  await page.getByRole('button', { name: 'Claude' }).first().click();
  await ask(page, '/long-review What slipped?');

  const chip = chat(page).locator('.chat__skill');
  await expect(chip.locator('.chat__skill-problem')).toContainText(
    'The skill long-review cannot be used: Its instructions are 20002 characters as Claude is handed them',
  );
  await expect(chat(page).locator('.chat__error')).toContainText(
    'The skill long-review cannot be used',
  );
  expect(systemPrompts(host)).toHaveLength(0);
});
