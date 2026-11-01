import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, emitVaultChanged, expectFile, installHost, type FakeVault } from './host.ts';

/**
 * P29-05: meeting extraction. A meeting arrives where meeting files land; the
 * ready-made rule asks the e2e host's scripted model for its `meeting-items`;
 * and what it answers waits in the Inbox as proposals — one the owner's, one
 * waiting on a person, one decision, one nobody could be named for — each
 * citing its turn. An item citing a turn the meeting does not have is left
 * out and logged. Accepting the owner's task makes it in the Inbox, citing its
 * turn and linked from the meeting. Every claim about a file reads the disk.
 */

const shipped = (path: string) =>
  readFileSync(new URL(`../vault/${path}`, import.meta.url), 'utf8');
const FIXTURE = readFileSync(
  new URL(
    '../packages/domain/src/meetings/fixtures/valid/gemini-platform-sync.md',
    import.meta.url,
  ),
  'utf8',
);

const MEETING = 'Inbox/Meetings/2026-09-29 Platform weekly sync.md';
const TITLE = '2026-09-29 Platform weekly sync';
const RULE_NAME = 'Pull actions and decisions out of a new meeting';
const RULE = `.atlas/automations/${RULE_NAME}.md`;
const LOG = `.atlas/automations/log/${RULE_NAME}.md`;
const PROMPT = '.atlas/prompts/meeting-extraction.md';

/** The Task type as GTD has it: the statuses a mine / waiting-for split writes. */
const GTD_TASK = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '  waiting_on:',
  '    kind: relation',
  '    target: person',
  '  due: date',
  '  source: text',
  '---',
  '',
].join('\n');

const item = (fields: Record<string, unknown>) => ({ owner: '', confidence: 'high', ...fields });
const ANSWER = JSON.stringify({
  items: [
    item({
      kind: 'task',
      title: 'Write the rollout note',
      owner: 'Mara Quill',
      source_block: 't0003',
    }),
    item({
      kind: 'task',
      title: 'Flag the new cache',
      owner: 'Tobias Fenn',
      source_block: 't0002',
    }),
    item({ kind: 'decision', title: 'Ship the cache behind a flag', source_block: 't0003' }),
    item({
      kind: 'task',
      title: 'Tell the platform channel',
      owner: 'Unknown',
      source_block: 't0004',
    }),
    item({ kind: 'task', title: 'Order the cake', owner: 'You', source_block: 't0099' }),
  ],
});

async function openVault(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const vault = await createVault();
  for (const folder of ['.atlas/types', '.atlas/automations', 'Inbox/Meetings', 'People']) {
    await vault.mkdir(folder);
  }
  for (const type of ['meeting', 'person', 'company', 'project', 'proposal', 'decision', 'term']) {
    await vault.write(`.atlas/types/${type}.md`, shipped(`.atlas/types/${type}.md`));
  }
  await vault.write('.atlas/types/task.md', GTD_TASK);
  // Mara owns this vault: what she took on is hers, what Tobias did waits on him.
  await vault.write('.atlas/settings.md', '---\nprofileName: Mara Quill\n---\n');
  await vault.write(
    'People/Mara Quill.md',
    '---\ntype: person\nemail: mara.quill@example.com\n---\n',
  );
  await vault.write(
    'People/Tobias Fenn.md',
    '---\ntype: person\nemail: tobias.fenn@example.com\n---\n',
  );
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

/** Adds the ready-made rule from the Automations page, as a person would. */
async function addRule(page: Page, vault: FakeVault) {
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: RULE_NAME }).click();
  await page.getByRole('button', { name: 'Create automation' }).click();
  await expectFile(vault, RULE).toContain('output: meeting-items');
}

async function arrive(page: Page, vault: FakeVault) {
  await vault.write(MEETING, FIXTURE);
  await emitVaultChanged(page, [MEETING]);
}

const proposalFor = (title: string) => `Inbox/Proposals/${title}.md`;

/** An accepted task is made in the task type's home for today (#214). */
const TODAY = new Date().toLocaleDateString('en-CA');
const TASKS = `Tasks/${TODAY.slice(0, 4)}/${TODAY.slice(5, 7)}`;

test('a meeting arrives, the extraction rule proposes mine, a waiting-for and a decision, and accepting the task links it to the meeting', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  await addRule(page, vault);
  // Saving the rule wrote the prompt DFAI ships: the rule runs as saved.
  await expectFile(vault, PROMPT).toContain('**Only real commitments.**');
  await expectFile(vault, RULE).toContain(`prompt: ${PROMPT}`);
  host.claude.reply(ANSWER);

  await arrive(page, vault);

  // Mine: an Inbox task. Tobias's: Waiting on his Person note. A decision. Each cites its turn.
  const mine = proposalFor('Write the rollout note');
  await expectFile(vault, mine).toContain(`source: "[[${TITLE}#^t0003]]"`);
  expect(await vault.read(mine)).toMatch(/kind: task\n[\s\S]*status: inbox/);
  // The proposals are written one after another: wait for each before reading it (#719).
  const waitingPath = proposalFor('Flag the new cache');
  await expectFile(vault, waitingPath).toContain(`source: "[[${TITLE}#^t0002]]"`);
  const waiting = await vault.read(waitingPath);
  expect(waiting).toContain('status: waiting');
  expect(waiting).toContain('waiting_on: "[[Tobias Fenn]]"');
  const decisionPath = proposalFor('Ship the cache behind a flag');
  await expectFile(vault, decisionPath).toContain('kind: decision');
  expect(await vault.read(decisionPath)).toContain('property: decisions');
  // Nobody named: low confidence, whatever the model claimed.
  await expectFile(vault, proposalFor('Tell the platform channel')).toContain('confidence: low');

  // The item citing a turn the meeting does not have was left out, and the log says so.
  await expectFile(vault, LOG).toContain(
    `- dropped \`"Order the cake"\`: ${TITLE} has no transcript turn ^t0099 that Claude was shown.`,
  );
  expect(await vault.exists(proposalFor('Order the cake'))).toBe(false);
  expect(await vault.read(LOG)).toContain('Made 4 proposals. Left out 1 item');

  // Asked once, told who was there as data, with the prompt DFAI shipped.
  const asks = host.claude.runs().filter((run) => run.args[0] === '-p');
  expect(asks).toHaveLength(1);
  const told = asks[0]!.args.join('\n');
  expect(told).toContain('<vault_data about="who was in each meeting">');
  expect(told).toContain('written “You” in the transcript: Mara Quill');
  expect(told).toContain('**Only real commitments.**');

  // In the Inbox: each card says why, and the unsure one is marked.
  await page.getByRole('button', { name: /^Inbox/ }).click();
  // The Inbox reads its GTD offer once it is open, and the offer lands above the
  // proposals: a click aimed at a card before it lands falls where the card was (#130).
  await expect(page.getByRole('region', { name: 'Move tasks to GTD statuses' })).toBeVisible();
  const task = page.getByRole('region', { name: 'Task: Write the rollout note' });
  await expect(task).toBeVisible();
  await expect(task.getByText(`Yours, from ${TITLE}.`)).toBeVisible();
  await expect(task.getByRole('button', { name: /Platform weekly sync#\^t0003/ })).toBeVisible();
  const waits = page.getByRole('region', { name: 'Task: Flag the new cache' });
  await expect(
    waits.getByText(/Tobias Fenn took this on in .* so it waits on them\./),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Decision: Ship the cache behind a flag' }),
  ).toBeVisible();
  const unsure = page.getByRole('region', { name: 'Task: Tell the platform channel' });
  await expect(unsure.getByText('low confidence')).toBeVisible();
  await expect(unsure.getByText(/Claude could not tell whose this is\./)).toBeVisible();
  await expect(unsure).toHaveClass(/proposal-row--low/);
  await expect(task).not.toHaveClass(/proposal-row--low/);

  // Accept the owner's task: it exists at Inbox, cites the turn, and the meeting links it.
  await task.getByRole('button', { name: 'Accept' }).click();
  const made = `${TASKS}/Write the rollout note.md`;
  await expectFile(vault, made).toContain('status: inbox');
  expect(await vault.read(made)).toContain('type: task');
  expect(await vault.read(made)).toContain(`source: "[[${TITLE}#^t0003]]"`);
  // A bare name: a note in use outranks its archived proposal of the same name (ADR-0038 decision 6).
  await expectFile(vault, MEETING).toContain('\ntasks:\n  - "[[Write the rollout note]]"\n');
});

test('screenshots: the Inbox with extraction proposals and a low-confidence card', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  await addRule(page, vault);
  host.claude.reply(ANSWER);
  await arrive(page, vault);
  await expectFile(vault, proposalFor('Tell the platform channel')).toContain('confidence: low');
  await page.getByRole('button', { name: /^Inbox/ }).click();
  await expect(page.getByRole('region', { name: 'Move tasks to GTD statuses' })).toBeVisible();
  const unsure = page.getByRole('region', { name: 'Task: Tell the platform channel' });
  await expect(unsure).toBeVisible();
  await mkdir('design/out/shots', { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((chosen) => {
      document.documentElement.dataset['theme'] = chosen;
    }, theme);
    await page.screenshot({
      path: `design/out/shots/meeting-extraction-${theme}.png`,
      fullPage: true,
    });
    await unsure.screenshot({
      path: `design/out/shots/meeting-extraction-low-confidence-${theme}.png`,
    });
  }
});
