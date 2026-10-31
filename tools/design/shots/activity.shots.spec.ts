// `pnpm shots`: the Activity log. What the shots specs share, and why they assert
// nothing, is in kit.ts.
import { test } from '../../../e2e/fixtures.ts';
import type { Page } from '@playwright/test';
import { createVault, installHost, type FakeHost, type FakeVault } from '../../../e2e/host.ts';
import { THEME_KEY, openVault, useTheme, shoot } from './kit.ts';

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

/** U-28: a vault with one automation to run, and earlier lines in its Activity log. */
async function activityVault(): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/automations');
  await vault.mkdir('Tasks');
  await vault.mkdir('Sources');
  await vault.mkdir('Projects');
  await vault.write(
    '.atlas/types/task.md',
    '---\nname: task\nproperties:\n  status:\n    kind: select\n    options: [doing, done]\n---\n',
  );
  await vault.write(
    '.atlas/automations/Tidy tasks.md',
    '---\natlas: automation\nname: Tidy tasks\nenabled: true\nwhen: manually\nwhich: FROM task WHERE status = done\ndo: archive\nid: Tidy tasks\n---\n',
  );
  await vault.write('Tasks/Ship the log.md', '---\ntype: task\nstatus: done\n---\n');
  await vault.write('Projects/DFAI.md', '# DFAI\n');
  await vault.write('Sources/GitHub issues.md', '# GitHub issues\n');
  return vault;
}

/** Earlier lines, of every kind and level, as a past session kept them. */
function earlierActivity(): string {
  const now = Date.now();
  const hour = 3_600_000;
  const line = (
    ago: number,
    level: string,
    kind: string,
    message: string,
    subject: { kind: string; path: string } | null = null,
  ) => `${JSON.stringify({ at: now - ago * hour, level, kind, message, subject })}\n`;
  const atlas = { kind: 'note', path: 'Projects/DFAI.md' };
  const github = { kind: 'source', path: 'Sources/GitHub issues.md' };
  const tidy = { kind: 'rule', path: '.atlas/automations/Tidy tasks.md' };
  return [
    line(40, 'info', 'index', 'Rebuilt the index: 412 notes.'),
    line(30, 'info', 'source', 'GitHub issues: Refreshed. 38 records, 3 new, 5 updated.', github),
    line(26, 'error', 'source', 'GitHub issues: Refresh failed. HTTP 502 from the server.', github),
    line(5, 'info', 'api', 'PATCH v1/notes/{path}/properties — DFAI', atlas),
    line(4, 'warning', 'api', 'PUT v1/notes/{path}/body refused for DFAI (conflict).', atlas),
    line(2, 'info', 'chat', 'Edited DFAI, as Claude proposed.', atlas),
    line(
      1,
      'warning',
      'automation',
      'Tidy tasks: Ran on schedule. Archived 2 notes. Left 1 alone.',
      tidy,
    ),
  ].join('');
}

async function shootActivity(page: Page, theme: string, host: FakeHost): Promise<void> {
  const goTo = page.getByRole('list', { name: 'Go to' });
  // A run by hand, and a create that fails: a line each, and a red notice.
  await goTo.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'Run Tidy tasks now' }).click();
  // The run writes its own log; the failure is meant for the note made after it.
  await page
    .getByText(/Archived 1 note/)
    .first()
    .waitFor();
  host.failNext('create_note', 'the disk is full');
  await page.getByRole('button', { name: 'New note' }).click();
  await page.getByRole('menuitem', { name: 'Blank note' }).click();
  await goTo.getByRole('button', { name: /^Activity, \d+ new errors?$/ }).waitFor();
  await shoot(page, `activity-badge-${theme}`);
  await goTo.getByRole('button', { name: /^Activity/ }).click();
  await page.getByRole('list', { name: 'Activity lines' }).waitFor();
  await shoot(page, `activity-${theme}`);
  await page.getByRole('radio', { name: 'Errors only' }).click();
  await shoot(page, `activity-errors-${theme}`);
}

for (const theme of ['light', 'dark'] as const) {
  test(`activity shots, ${theme}`, async ({ page }) => {
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: THEME_KEY,
      value: theme,
    });
    const vault = await activityVault();
    const host = await installHost(page, vault);
    host.seedActivity(vault.root, earlierActivity());
    await page.goto('/');
    await openVault(page);
    await useTheme(page, theme);
    await shootActivity(page, theme, host);
  });
}
