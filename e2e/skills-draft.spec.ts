import { expect, test } from './fixtures.ts';
import { createVault, expectFile, installHost } from './host.ts';

/**
 * #169 (ADR-0050): Ask Claude on the Skills page drafts an improvement to a
 * skill, asking the e2e host's scripted model with no tools and the skill
 * fenced as data. The draft is a preview; Accept only fills the editor, and
 * the file changes only when Save is pressed. Every claim about it reads the disk.
 */

const SKILL_PATH = '.atlas/skills/weekly-review/SKILL.md';
const WEEKLY = [
  '---',
  'name: weekly-review',
  'description: Reviews the week with Mara Quill.',
  '---',
  '',
  'Read the week’s notes.',
  'List every meeting Tobias Fenn was in.',
  '',
].join('\n');

const DRAFT = JSON.stringify({
  name: 'weekly-review',
  description: 'Reviews the week.',
  instructions: 'Read the week’s notes.',
});

test('Ask Claude previews a draft; Accept fills the editor, and only Save writes it', async ({
  page,
}) => {
  const vault = await createVault();
  await vault.write('Plain.md', '# Plain\n');
  await vault.mkdir('.atlas/skills/weekly-review');
  await vault.mkdir('.atlas/prompts');
  await vault.write(SKILL_PATH, WEEKLY);
  const host = await installHost(page, vault);
  host.claude.reply('```json\n' + DRAFT + '\n```');
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();

  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Skills' }).click();
  const skills = page.getByRole('article', { name: 'Skills' });
  await skills
    .getByRole('region', { name: 'Skills' })
    .getByRole('button', { name: /^weekly-review/ })
    .click();
  const editor = skills.getByRole('form', { name: 'Skill weekly-review' });
  await editor.getByRole('button', { name: 'Ask Claude…' }).click();
  await editor.getByRole('textbox', { name: 'What should Claude do?' }).fill('Make this shorter');
  await editor.getByRole('button', { name: 'Ask', exact: true }).click();

  const draft = editor.getByRole('region', { name: 'Claude’s draft' });
  await expect(draft.getByRole('group', { name: 'Instructions' })).toContainText(
    'Removed: List every meeting Tobias Fenn was in.',
  );
  // One run, the request as the question and the skill fenced as data.
  const turns = host.claude.runs().filter((run) => run.args[0] === '-p');
  expect(turns).toHaveLength(1);
  const system = turns[0]?.args[turns[0].args.indexOf('--system-prompt') + 1] ?? '';
  expect(system).toContain('<vault_data kind="skill">');
  expect(system).toContain('List every meeting Tobias Fenn was in.');
  expect(turns[0]?.stdin).toContain('Make this shorter');
  await expect(editor.getByRole('textbox', { name: /^Description/ })).toHaveValue(
    'Reviews the week with Mara Quill.',
  );

  await draft.getByRole('button', { name: 'Accept' }).click();
  await expect(editor.getByRole('textbox', { name: /^Description/ })).toHaveValue(
    'Reviews the week.',
  );
  await expect(editor.getByRole('textbox', { name: /^Instructions/ })).toHaveValue(
    'Read the week’s notes.',
  );
  // Accepted, not saved: the file is as it was.
  await expectFile(vault, SKILL_PATH).toBe(WEEKLY);

  await editor.getByRole('button', { name: 'Save' }).click();
  await expectFile(vault, SKILL_PATH).toBe(
    [
      '---',
      'name: weekly-review',
      'description: Reviews the week.',
      '---',
      '',
      'Read the week’s notes.',
      '',
    ].join('\n'),
  );
});
