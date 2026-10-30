import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, emitVaultChanged, expectFile, installHost, type FakeVault } from './host.ts';

/**
 * #191 (ADR-0036): in a vault where meetings are not post-processed yet, the
 * Inbox offers to process them when they arrive. The preview lists what one
 * yes writes; the yes writes the "After a meeting" rule, its prompt, the Task
 * type's `atlas_item` and the owner's addresses, and nothing before it. Then
 * a meeting dropped in gets the summary at its top and the owner's task,
 * from the e2e host's scripted Claude. Every claim about a file reads the disk.
 */

const shipped = (path: string) =>
  readFileSync(new URL(`../vault/${path}`, import.meta.url), 'utf8');

/** Today, as the app's own clock reads it: the rule takes meetings of the last 14 days. */
const TODAY = new Date().toLocaleDateString('en-CA');
const FIXTURE = readFileSync(
  new URL(
    '../packages/domain/src/meetings/fixtures/valid/gemini-platform-sync.md',
    import.meta.url,
  ),
  'utf8',
).replace("date: '2026-09-29'", `date: '${TODAY}'`);

const MEETING = `Inbox/Meetings/${TODAY} Platform weekly sync.md`;
const RULE = '.atlas/automations/After a meeting.md';
const PROMPT = '.atlas/prompts/after-a-meeting.md';
const SETTINGS = '.atlas/settings.md';
const TASK_TYPE = '.atlas/types/task.md';
const TASK = `Tasks/${TODAY.slice(0, 4)}/${TODAY.slice(5, 7)}/Write the rollout note.md`;

const ANSWER = JSON.stringify({
  summary: 'Mara Quill and Tobias Fenn agreed to ship the new cache behind a flag before Friday.',
  key_points: ['The new cache is ready'],
  open_questions: [],
  items: [
    {
      kind: 'task',
      title: 'Write the rollout note',
      owner: 'Mara Quill',
      source_block: 't0003',
      confidence: 'high',
    },
  ],
});

async function openVault(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'Inbox/Meetings', 'People']) await vault.mkdir(folder);
  for (const type of ['task', 'meeting', 'person', 'company', 'project', 'proposal', 'decision']) {
    await vault.write(`.atlas/types/${type}.md`, shipped(`.atlas/types/${type}.md`));
  }
  // Mara owns this vault by name; her addresses are typed in the setup.
  await vault.write(SETTINGS, '---\nprofileName: Mara Quill\n---\n');
  await vault.write(
    'People/Mara Quill.md',
    '---\ntype: person\nemail: mara.quill@example.com\n---\n',
  );
  await vault.write(
    'People/Tobias Fenn.md',
    '---\ntype: person\nemail: tobias.fenn@example.com\n---\n',
  );
  // Something waiting, so the sidebar has an Inbox to open before any meeting.
  await vault.write('Inbox/Call Tobias.md', '# Call Tobias\n');
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

async function arrive(page: Page, vault: FakeVault) {
  await vault.write(MEETING, FIXTURE);
  await emitVaultChanged(page, [MEETING]);
}

test('one previewed yes on the Inbox sets meetings up, and the next meeting gets its summary and the owner’s task', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  const taskTypeBefore = await vault.read(TASK_TYPE);
  expect(taskTypeBefore).not.toContain('atlas_item');

  await page.getByRole('button', { name: /^Inbox/ }).click();
  const offer = page.getByRole('region', { name: 'Process meetings when they arrive' });
  await expect(offer).toBeVisible();
  await offer.getByRole('button', { name: 'Preview' }).click();
  const written = offer.getByRole('list', { name: 'Written' });
  await expect(written).toContainText('The “After a meeting” rule');
  await expect(written).toContainText('output: meeting-digest, apply: mine');
  await expect(written).toContainText(`The prompt ${PROMPT}`);
  await expect(written).toContainText('The Task type: Gains atlas_item.');
  await expect(offer).toContainText('your Person note’s addresses');

  // Previewing wrote nothing.
  expect(await vault.exists(RULE)).toBe(false);
  expect(await vault.exists(PROMPT)).toBe(false);
  expect(await vault.read(TASK_TYPE)).toBe(taskTypeBefore);

  await offer.getByRole('textbox', { name: 'Your emails' }).fill('mara.quill@example.com');
  await offer.getByRole('button', { name: 'Set up' }).click();
  await expect(offer.getByRole('status')).toHaveText(/Meetings are processed when they arrive/);

  await expectFile(vault, RULE).toContain('apply: mine');
  await expectFile(vault, RULE).toContain('output: meeting-digest');
  await expectFile(vault, RULE).toContain('which: FROM meeting WHERE date >= @-14d');
  await expectFile(vault, PROMPT).toContain('Titles stand alone.');
  await expectFile(vault, TASK_TYPE).toContain('atlas_item');
  await expectFile(vault, SETTINGS).toContain('mara.quill@example.com');
  // Its own words about tasks are kept.
  expect(await vault.read(TASK_TYPE)).toContain("The type this project's own board uses.");

  host.claude.reply(ANSWER);
  await arrive(page, vault);

  await expectFile(vault, MEETING).toContain('<!-- atlas:summary v1 -->');
  await expectFile(vault, MEETING).toMatch(/\ntasks:\n {2}- "\[\[Write the rollout note\]\]"\n/);
  await expectFile(vault, TASK).toContain('atlas_item:');
});
