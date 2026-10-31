// `pnpm shots`: the Inbox, clarifying a task on its row. What the shots specs
// share, and why they assert nothing, is in kit.ts.
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from '../../../e2e/fixtures.ts';
import type { Page } from '@playwright/test';
import { createVault, installHost, type FakeVault } from '../../../e2e/host.ts';
import { pickSuggestion } from '../../../e2e/link-suggest.ts';
import { VAULT, THEME_KEY, openVault, useTheme, shoot } from './kit.ts';

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

/**
 * #112: the Inbox with a task being clarified on its row — Waiting picked, so
 * the row asks who — beside a task that lives outside the Inbox folder, a
 * meeting and a plain note.
 */
async function inboxClarifyVault(): Promise<FakeVault> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'Inbox/Meetings', 'People', 'Projects', 'Areas', 'Tasks']) {
    await vault.mkdir(folder);
  }
  for (const type of ['meeting', 'person', 'project']) {
    await cp(
      join(VAULT, '.atlas/types', `${type}.md`),
      join(vault.root, '.atlas/types', `${type}.md`),
    );
  }
  await vault.write(
    '.atlas/types/task.md',
    [
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
      '  project:',
      '    kind: relation',
      '    targets: [project, area]',
      '  defer: date',
      '  due: date',
      '---',
      '',
    ].join('\n'),
  );
  await vault.write('.atlas/types/area.md', '---\nname: area\nlabel: Area\n---\n');
  await vault.write('People/Mara Quill.md', '---\ntype: person\n---\n');
  await vault.write('People/Tobias Fenn.md', '---\ntype: person\n---\n');
  await vault.write('Projects/Ledger migration.md', '---\ntype: project\nstatus: active\n---\n');
  await vault.write('Areas/Household.md', '---\ntype: area\n---\n');
  const task = (more: string[] = []) => ['---', 'type: task', 'status: inbox', ...more, '---', ''];
  await vault.write('Inbox/Chase the Larkspur quote.md', task().join('\n'));
  await vault.write('Inbox/Renew the passport.md', task(['due: 2026-11-02']).join('\n'));
  await vault.write('Tasks/Book the hall.md', task().join('\n'));
  await vault.write('Inbox/Meetings/2026-10-09 Payroll sync.md', '---\ntype: meeting\n---\n');
  await vault.write('Inbox/An idea about seed trays.md', 'Stack them.\n');
  // Frontmatter no YAML reader can read: made a task, it is refused on its row.
  await vault.write(
    'Inbox/Notes from the Larkspur call.md',
    '---\ntitle: [unclosed\n---\nCall back.\n',
  );
  return vault;
}

async function shootInboxClarify(page: Page, theme: string): Promise<void> {
  await page.getByRole('button', { name: /^Inbox/ }).click();
  const inbox = page.getByRole('article', { name: 'Inbox' });
  const status = inbox.getByRole('combobox', { name: 'Status of Chase the Larkspur quote' });
  await status.waitFor();
  await status.selectOption({ label: 'Waiting' });
  await pickSuggestion(
    inbox.getByRole('combobox', { name: 'Who Chase the Larkspur quote waits on' }),
    'Mara Quill',
  );
  await pickSuggestion(
    inbox.getByRole('combobox', { name: 'File Chase the Larkspur quote under' }),
    'Ledger migration',
  );
  await shoot(page, `inbox-clarify-${theme}`);
  // A refusal on its row. Waiting with nobody picked is no longer one (#202):
  // a note whose frontmatter cannot be read, made a task, is.
  await inbox
    .getByRole('row')
    .filter({
      has: page.getByRole('button', { name: 'Notes from the Larkspur call', exact: true }),
    })
    .getByRole('button', { name: 'Make task' })
    .click();
  await inbox.getByRole('alert').filter({ hasText: 'frontmatter could not be read' }).waitFor();
  await shoot(page, `inbox-clarify-refused-${theme}`);
}

for (const theme of ['light', 'dark'] as const) {
  test(`inbox clarify shots, ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: THEME_KEY,
      value: theme,
    });
    await installHost(page, await inboxClarifyVault());
    await page.goto('/');
    await openVault(page);
    await useTheme(page, theme);
    await shootInboxClarify(page, theme);
  });
}
