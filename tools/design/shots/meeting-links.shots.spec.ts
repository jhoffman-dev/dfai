// `pnpm shots`: a meeting linked to its people and company. What the shots specs
// share, and why they assert nothing, is in kit.ts.
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../e2e/fixtures.ts';
import type { Page } from '@playwright/test';
import { createVault, emitVaultChanged, installHost, type FakeVault } from '../../../e2e/host.ts';
import { VAULT, THEME_KEY, openVault, useTheme, shoot } from './kit.ts';

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

/**
 * P29-04: a meeting let in by the import, linked to its people and company,
 * and the attendee nobody knew waiting in the Inbox as a person proposal.
 */
const LINKED_MEETING = 'Inbox/Meetings/2026-10-06 Payroll sync.md';

async function meetingLinksVault(): Promise<FakeVault> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'Inbox/Meetings', 'People', 'Companies', 'Projects']) {
    await vault.mkdir(folder);
  }
  for (const type of ['task', 'meeting', 'person', 'company', 'project', 'proposal']) {
    await cp(
      join(VAULT, '.atlas/types', `${type}.md`),
      join(vault.root, '.atlas/types', `${type}.md`),
    );
  }
  await vault.write(
    'People/Mara Quill.md',
    '---\ntype: person\nemail: mara@larkspur.example\n---\n',
  );
  await vault.write('People/Tobias Fenn.md', '---\ntype: person\naliases:\n  - Toby\n---\n');
  await vault.write(
    'Companies/Larkspur Payroll.md',
    '---\ntype: company\ndomains:\n  - larkspur.example\n---\n',
  );
  await vault.write(
    'Projects/Ledger migration.md',
    '---\ntype: project\nstatus: active\nowner: "[[Mara Quill]]"\n---\n',
  );
  return vault;
}

const LINKED_MEETING_TEXT = [
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
  '  - name: Ada Venn',
  '    email: ada@larkspur.example',
  '  - name: payroll-team',
  '    email: payroll-team@larkspur.example',
  '    group: true',
  '---',
  '',
  '## Summary',
  '',
  'Larkspur Payroll go-live moves a week.',
  '',
  '## Transcript',
  '',
  '**Mara Quill** [~00:00:05] Morning, Toby. ^t0001',
  '',
  '**Tobias Fenn** [~00:00:09] Morning. ^t0002',
  '',
].join('\n');

async function shootMeetingLinks(page: Page, vault: FakeVault, theme: string): Promise<void> {
  await vault.write(LINKED_MEETING, LINKED_MEETING_TEXT);
  await emitVaultChanged(page, [LINKED_MEETING]);
  const inbox = page.getByRole('button', { name: /^Inbox/ });
  await expect.poll(() => vault.read(LINKED_MEETING), { timeout: 15_000 }).toContain('companies:');
  await expect(inbox).toContainText('3');
  await inbox.click();
  await page.getByRole('main').getByText('Payroll sync', { exact: true }).click();
  await page.getByRole('region', { name: 'Properties' }).getByText('Larkspur Payroll').waitFor();
  await shoot(page, `meeting-links-meeting-${theme}`);
  await inbox.click();
  const card = page.getByRole('region', { name: 'Person: Ada Venn' });
  await card.waitFor();
  await card.scrollIntoViewIfNeeded();
  await shoot(page, `meeting-links-proposal-${theme}`);
}

for (const theme of ['light', 'dark'] as const) {
  test(`meeting links shots, ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: THEME_KEY,
      value: theme,
    });
    const vault = await meetingLinksVault();
    await installHost(page, vault);
    await page.goto('/');
    await openVault(page);
    await useTheme(page, theme);
    await shootMeetingLinks(page, vault, theme);
  });
}
