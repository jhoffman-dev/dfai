import { expect, test, type Page } from './fixtures.ts';
import { createVault, emitVaultChanged, expectFile, installHost } from './host.ts';

/**
 * Issue #169, ADR-0050: the Skills page lists the skills in `.atlas/skills`
 * and the prompt notes beside them, and makes, edits and deletes a skill —
 * every rule the domain's, every write held to the file as it was read.
 */

const SKILL_PATH = '.atlas/skills/weekly-review/SKILL.md';
const WEEKLY = [
  '---',
  'name: weekly-review',
  'description: Reviews the week.',
  '---',
  '',
  'Read the week’s notes.',
  '',
].join('\n');

async function openVault(page: Page, files: Readonly<Record<string, string>> = {}) {
  const vault = await createVault();
  await vault.write('Plain.md', '# Plain\n');
  // The stand-in host refuses a missing folder with an Error where Tauri hands
  // over a string, so a vault with no skills folder at all is the unit tests'
  // (application/skills); here the folders are there, empty or not.
  await vault.mkdir('.atlas/skills');
  await vault.mkdir('.atlas/prompts');
  for (const [path, text] of Object.entries(files)) {
    await vault.mkdir(path.slice(0, path.lastIndexOf('/')));
    await vault.write(path, text);
  }
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

async function openSkills(page: Page) {
  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Skills' }).click();
  const skills = page.getByRole('article', { name: 'Skills' });
  await expect(skills.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible();
  return skills;
}

const skillRow = (skills: ReturnType<Page['getByRole']>, name: string) =>
  skills
    .getByRole('region', { name: 'Skills' })
    .getByRole('button', { name: new RegExp(`^${name}`) });

test('a skill is made on the Skills page, and an invalid name is refused before Save', async ({
  page,
}) => {
  const { vault } = await openVault(page);
  const skills = await openSkills(page);
  await expect(skills.getByText('No skills yet.', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'New skill' }).click();
  const editor = skills.getByRole('form', { name: 'New skill' });
  const save = editor.getByRole('button', { name: 'Save' });
  await expect(save).toBeDisabled();

  await editor.getByRole('textbox', { name: 'Name' }).fill('Weekly Review');
  await expect(editor.getByText(/lowercase letters, digits and single hyphens/)).toBeVisible();
  await editor.getByRole('textbox', { name: 'Name' }).fill('ask-claude');
  await expect(editor.getByText('A skill’s name cannot hold “claude”.')).toBeVisible();

  await editor.getByRole('textbox', { name: 'Name' }).fill('meeting-notes');
  await editor.getByRole('textbox', { name: /Description/ }).fill('Tidies a meeting’s notes.');
  await expect(editor.getByLabel('25 of 1024 characters')).toHaveText('25/1024');
  await editor.getByRole('textbox', { name: /Instructions/ }).fill('Tidy them.');
  await expect(save).toBeEnabled();
  await save.click();

  await expectFile(vault, '.atlas/skills/meeting-notes/SKILL.md').toBe(
    [
      '---',
      'name: meeting-notes',
      'description: Tidies a meeting’s notes.',
      '---',
      '',
      'Tidy them.',
      '',
    ].join('\n'),
  );
  await expect(skillRow(skills, 'meeting-notes')).toContainText('Tidies a meeting’s notes.');
  await expect(skills.getByRole('form', { name: 'Skill meeting-notes' })).toBeVisible();
});

test('a skill is edited, keeping every byte it did not change', async ({ page }) => {
  const { vault } = await openVault(page, {
    [SKILL_PATH]: WEEKLY,
    '.atlas/prompts/morning-brief.md': 'Brief me.\n',
  });
  const skills = await openSkills(page);
  const prompts = skills.getByRole('region', { name: 'Automation prompts' });
  await expect(prompts.getByRole('button', { name: 'Open morning-brief prompt' })).toBeVisible();

  await skillRow(skills, 'weekly-review').click();
  const editor = skills.getByRole('form', { name: 'Skill weekly-review' });
  await expect(editor.getByRole('textbox', { name: 'Name' })).not.toBeEditable();
  await editor
    .getByRole('textbox', { name: /Description/ })
    .fill('Reviews the week with Mara Quill.');
  await editor.getByRole('button', { name: 'Save' }).click();

  await expectFile(vault, SKILL_PATH).toBe(
    WEEKLY.replace('Reviews the week.', 'Reviews the week with Mara Quill.'),
  );
  await expect(skillRow(skills, 'weekly-review')).toContainText('with Mara Quill');
});

test('a skill changed on disk under typing offers Reload, which takes the change in', async ({
  page,
}) => {
  const { vault } = await openVault(page, { [SKILL_PATH]: WEEKLY });
  const skills = await openSkills(page);
  await skillRow(skills, 'weekly-review').click();
  const editor = skills.getByRole('form', { name: 'Skill weekly-review' });
  const instructions = editor.getByRole('textbox', { name: /Instructions/ });
  await expect(instructions).toHaveValue('Read the week’s notes.\n');
  await instructions.fill('Typed here.');

  await vault.write(SKILL_PATH, WEEKLY.replace('Reviews the week.', 'Reviewed elsewhere.'));
  await emitVaultChanged(page, [SKILL_PATH]);

  const changed = editor.getByRole('status');
  await expect(changed).toContainText('changed on disk');
  // What was typed is kept until Reload is chosen.
  await expect(instructions).toHaveValue('Typed here.');
  await changed.getByRole('button', { name: 'Reload' }).click();

  await expect(editor.getByRole('textbox', { name: /Description/ })).toHaveValue(
    'Reviewed elsewhere.',
  );
  await expect(instructions).toHaveValue('Read the week’s notes.\n');
  await expect(editor.getByRole('button', { name: 'Reload' })).toHaveCount(0);
});

test('a skill is deleted after asking, its whole folder to the Trash', async ({ page }) => {
  const { vault, host } = await openVault(page, {
    [SKILL_PATH]: WEEKLY,
    '.atlas/skills/weekly-review/scripts/run.sh': 'echo week\n',
  });
  const skills = await openSkills(page);
  await skillRow(skills, 'weekly-review').click();
  await skills
    .getByRole('form', { name: 'Skill weekly-review' })
    .getByRole('button', { name: 'Delete…' })
    .click();

  const question = page.getByRole('alertdialog', { name: 'Delete this skill?' });
  await expect(question).toContainText('1 other file: scripts/run.sh');
  await question.getByRole('button', { name: 'Cancel' }).click();
  await expect(question).toHaveCount(0);
  expect(host.trashed()).toEqual([]);

  await skills.getByRole('button', { name: 'Delete…' }).click();
  await page
    .getByRole('alertdialog', { name: 'Delete this skill?' })
    .getByRole('button', { name: 'Move to Trash' })
    .click();
  await expect.poll(() => host.trashed()).toEqual(['.atlas/skills/weekly-review']);
  await expect.poll(() => vault.exists(SKILL_PATH)).toBe(false);
  await expect(skillRow(skills, 'weekly-review')).toHaveCount(0);
  await expect(skills.getByText('No skills yet.', { exact: false })).toBeVisible();
});

test('the Skills page is in ⌘K', async ({ page }) => {
  await openVault(page, { [SKILL_PATH]: WEEKLY });
  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('Skills');
  await page
    .getByRole('dialog', { name: 'Search notes' })
    .getByRole('option', { name: /^Skills/ })
    .click();
  const skills = page.getByRole('article', { name: 'Skills' });
  await expect(skillRow(skills, 'weekly-review')).toBeVisible();
});
