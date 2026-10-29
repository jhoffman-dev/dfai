import { expect, test } from './fixtures.ts';
import { createVault, expectFile, installHost } from './host.ts';

/**
 * #169 (ADR-0050, ADR-0028's amendment): a rule's Claude step names a skill
 * in place of a prompt note. The editor shows the skill picked and no prompt
 * path; the dry run says what it would ask, asking Claude nothing and writing
 * nothing; Run now asks the e2e host's scripted model with the skill's
 * instructions and none of its frontmatter; the Skills page says the rule
 * uses the skill. Every claim about a file reads the disk.
 */

const MEETING_TYPE = ['---', 'name: meeting', 'properties:', '  kind: text', '---', ''].join('\n');

const RULE = [
  '---',
  'atlas: automation',
  'name: Meeting actions',
  'id: Meeting actions',
  'enabled: true',
  'when: manually',
  'which: FROM meeting',
  'do: claude',
  'skill: meeting-actions',
  'tools: [atlas_read_note]',
  'output: proposals',
  '---',
  '',
].join('\n');

const DESCRIPTION = 'Pulls the action items out of a meeting. Use after a standup.';
const SKILL = [
  '---',
  'name: meeting-actions',
  `description: ${DESCRIPTION}`,
  '---',
  '',
  'Find every action item Tobias Fenn took on and propose it as a task.',
  '',
].join('\n');

const STANDUP = [
  '---',
  'type: meeting',
  'kind: standup',
  '---',
  '',
  '**Mara Quill** Can you send me the payroll file by Friday? ^t0003',
  '',
].join('\n');

const ANSWER = JSON.stringify({
  proposals: [
    {
      kind: 'task',
      title: 'Send Mara the payroll file',
      source: '[[2026-10-01 Standup#^t0003]]',
      confidence: 'high',
      why: 'Mara asked for it on the call.',
    },
  ],
});

test('a rule that names a skill is dry-run asking no one, then asks with the skill’s instructions', async ({
  page,
}) => {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/automations');
  await vault.mkdir('.atlas/skills/meeting-actions');
  await vault.mkdir('Meetings');
  await vault.write('.atlas/types/meeting.md', MEETING_TYPE);
  await vault.write('.atlas/automations/Meeting actions.md', RULE);
  await vault.write('.atlas/skills/meeting-actions/SKILL.md', SKILL);
  await vault.write('Meetings/2026-10-01 Standup.md', STANDUP);
  const host = await installHost(page, vault);
  host.claude.reply(ANSWER);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();

  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  const screen = page.getByRole('article', { name: 'Automations' });
  const list = screen.getByRole('list', { name: 'All automations' });
  await expect(list.getByText(/^Ask Claude \(meeting-actions\) for proposals/)).toBeVisible();
  await list.getByRole('button', { name: 'Meeting actions', exact: true }).click();

  // The editor shows the skill picked, and no prompt path beside it.
  const editor = screen.getByRole('region', { name: 'Automation' });
  await expect(editor.getByRole('combobox', { name: 'Skill' })).toHaveValue('meeting-actions');
  await expect(editor.getByRole('textbox', { name: 'Prompt' })).toHaveCount(0);

  // The dry run says what it would ask about, and asks Claude nothing.
  await editor.getByRole('button', { name: 'Dry run' }).click();
  const dryRun = editor.getByRole('region', { name: 'Dry run' });
  await expect(dryRun.getByText('Would ask Claude about 1 note.')).toBeVisible();
  await expect(
    dryRun.getByRole('list', { name: 'Notes it would take' }).getByRole('button'),
  ).toHaveText(['2026-10-01 Standup'], { useInnerText: true });
  expect(host.claude.runs().filter((run) => run.args[0] === '-p')).toHaveLength(0);
  expect(await vault.exists('Inbox/Proposals/Send Mara the payroll file.md')).toBe(false);

  // Run now asks with the skill's instructions, its frontmatter left out.
  await editor.getByRole('button', { name: 'Run now' }).click();
  const proposal = 'Inbox/Proposals/Send Mara the payroll file.md';
  await expectFile(vault, proposal).toContain('made_by: Meeting actions');
  const turns = host.claude.runs().filter((run) => run.args[0] === '-p');
  expect(turns).toHaveLength(1);
  const told = turns[0]!.args.join('\n');
  expect(told).toContain('Find every action item Tobias Fenn took on');
  expect(told).not.toContain(DESCRIPTION);
  // The rule and the skill are read, never written.
  expect(await vault.read('.atlas/automations/Meeting actions.md')).toBe(RULE);
  expect(await vault.read('.atlas/skills/meeting-actions/SKILL.md')).toBe(SKILL);

  // The Skills page says the rule uses the skill.
  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Skills' }).click();
  const skills = page.getByRole('article', { name: 'Skills' });
  const row = skills
    .getByRole('region', { name: 'Skills' })
    .getByRole('button', { name: /^meeting-actions/ });
  await expect(row.getByText('Used by Meeting actions')).toBeVisible();
});
