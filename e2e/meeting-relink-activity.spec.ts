import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, emitVaultChanged, expectFile, installHost, type FakeVault } from './host.ts';

/**
 * #192: Activity shows a meeting's import and linking lines under the
 * meeting, and the "After a meeting" rule's dry run names a meeting whose
 * linking failed as not linked, writing nothing. Every claim about a file
 * reads the disk.
 */

const shipped = (path: string) =>
  readFileSync(new URL(`../vault/${path}`, import.meta.url), 'utf8');

const MEETING = 'Inbox/Meetings/2026-10-06 Payroll sync.md';
const header = (extra: readonly string[] = []) => [
  '---',
  'type: meeting',
  'atlas_import: meeting/v1',
  "title: 'Payroll sync'",
  "date: '2026-10-06'",
  "start: '09:30'",
  'provider: gemini',
  "external_id: 'gemini-5b1d0e77'",
  'attendees:',
  '  - name: Mara Quill',
  '    email: mara@larkspur.example',
  ...extra,
  '---',
  '',
  '## Summary',
  '',
  'Larkspur Payroll go-live moves a week.',
  '',
];

const AFTER_A_MEETING = [
  '---',
  'atlas: automation',
  'name: After a meeting',
  'enabled: false',
  'when: a meeting is created',
  'which: FROM meeting',
  'do: claude',
  'prompt: .atlas/prompts/after-a-meeting.md',
  'output: meeting-digest',
  'apply: mine',
  'id: After a meeting',
  '---',
  '',
].join('\n');

async function openVault(page: Page, files: Record<string, string> = {}): Promise<FakeVault> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const vault = await createVault();
  for (const folder of ['.atlas/types', '.atlas/automations', 'Inbox/Meetings', 'People']) {
    await vault.mkdir(folder);
  }
  for (const type of ['task', 'meeting', 'person', 'company', 'project', 'proposal']) {
    await vault.write(`.atlas/types/${type}.md`, shipped(`.atlas/types/${type}.md`));
  }
  await vault.write(
    'People/Mara Quill.md',
    '---\ntype: person\nemail: mara@larkspur.example\n---\n\n# Mara Quill\n',
  );
  for (const [path, text] of Object.entries(files)) await vault.write(path, text);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

const goTo = (page: Page) => page.getByRole('list', { name: 'Go to' });

test('Activity shows an arriving meeting’s import and linking lines under the meeting', async ({
  page,
}) => {
  const vault = await openVault(page);
  await vault.write(MEETING, header().join('\n'));
  await emitVaultChanged(page, [MEETING]);
  await expectFile(vault, MEETING).toContain('atlas_import_outcome: imported');

  await goTo(page).getByRole('button', { name: 'Activity', exact: true }).click();
  const activity = page.getByRole('article', { name: 'Activity' });
  const meeting = activity.getByRole('listitem', { name: 'Meeting 2026-10-06 Payroll sync' });
  await expect(meeting).toBeVisible();
  const under = meeting
    .getByRole('list', { name: 'Lines about 2026-10-06 Payroll sync' })
    .getByRole('listitem');
  await expect(under.filter({ hasText: 'linked Mara Quill' })).toHaveCount(1);
  await expect(under).toHaveCount(2);

  // Its heading opens the meeting.
  await meeting
    .locator('.activity-group__head')
    .getByRole('button', { name: /Open 2026-10-06 Payroll sync/ })
    .click();
  await expect(page.getByRole('region', { name: 'Properties' })).toBeVisible();
});

test('the "After a meeting" dry run names a meeting whose linking failed, and writes nothing', async ({
  page,
}) => {
  const marked = header(['atlas_import_outcome: imported', 'atlas_links: failed']).join('\n');
  const vault = await openVault(page, {
    [MEETING]: marked,
    '.atlas/automations/After a meeting.md': AFTER_A_MEETING,
  });

  await goTo(page).getByRole('button', { name: 'Automations', exact: true }).click();
  const screen = page.getByRole('article', { name: 'Automations' });
  await screen
    .getByRole('list', { name: 'All automations' })
    .getByRole('button', { name: 'After a meeting', exact: true })
    .click();
  const editor = screen.getByRole('region', { name: 'Automation' });
  await editor.getByRole('button', { name: 'Dry run' }).click();

  const dryRun = editor.getByRole('region', { name: 'Dry run' });
  await expect(dryRun.getByText(/1 meeting is not linked: Run now links it first\./)).toBeVisible();
  const notLinked = dryRun.getByRole('list', { name: 'Meetings not linked' });
  await expect(notLinked.getByRole('button')).toHaveText(['2026-10-06 Payroll sync'], {
    useInnerText: true,
  });
  expect(await vault.read(MEETING)).toBe(marked);
});
