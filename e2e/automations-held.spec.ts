import { readFileSync } from 'node:fs';
import { logPathFor, newLogText, type LogEntry } from '../packages/domain/src/index.ts';
import { expect, test } from './fixtures.ts';
import { createVault, emitVaultChanged, installHost } from './host.ts';

/**
 * #813: "After a meeting", held by its hourly asks with both meeting presets
 * on, reads as waiting — not failed — and says why, when it runs and what
 * may be turned off. Its log is written as asking Claude thirty times ten
 * minutes ago, so a meeting arriving now finds the hour spent.
 */

const shipped = (path: string) =>
  readFileSync(new URL(`../vault/${path}`, import.meta.url), 'utf8');

const VALID = readFileSync(
  new URL(
    '../packages/domain/src/meetings/fixtures/valid/gemini-platform-sync.md',
    import.meta.url,
  ),
  'utf8',
);

const pad = (n: number) => String(n).padStart(2, '0');
/** A moment as the logs write it: local wall-clock time, to the second. */
const localTime = (at: Date) =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T` +
  `${pad(at.getHours())}:${pad(at.getMinutes())}:00`;

/** A run set off by a meeting that asked Claude `asks` times at `at`. */
const asked = (at: string, asks: number): LogEntry => ({
  kind: 'run',
  at,
  trigger: 'note',
  done: [],
  left: [],
  capped: false,
  claude: { model: 'claude-sonnet-5-5', ms: 10, asks },
});

test('a rule held by its hourly asks shows as waiting, says why and when, and offers the other preset off (#813)', async ({
  page,
}) => {
  const after = 'After a meeting';
  const extraction = 'Pull actions and decisions out of a new meeting';
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('Inbox/Meetings');
  await vault.write('.atlas/types/meeting.md', shipped('.atlas/types/meeting.md'));
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  const screen = page.getByRole('article', { name: 'Automations' });
  const list = screen.getByRole('list', { name: 'All automations' });

  for (const preset of [after, extraction]) {
    await page.getByRole('button', { name: preset, exact: true }).click();
    await screen
      .getByRole('region', { name: 'Automation' })
      .getByRole('button', { name: 'Create automation' })
      .click();
    await expect(list).toContainText(preset);
  }

  // Each spent its hour ten minutes ago: thirty asks, and twenty runs' worth.
  const spentAt = new Date(Date.now() - 10 * 60_000);
  const at = localTime(spentAt);
  const until = localTime(new Date(spentAt.getTime() + 60 * 60_000)).slice(11, 16);
  await vault.write(logPathFor(after), newLogText(after, [asked(at, 30)]));
  await vault.write(logPathFor(extraction), newLogText(extraction, [asked(at, 20)]));

  // A meeting arrives, as a pull brings one: both hear it, and both are held.
  const meeting = 'Inbox/Meetings/Larkspur sync.md';
  await vault.write(meeting, VALID.replace(/^external_id: .*$/m, "external_id: 'gemini-eeee0005'"));
  await emitVaultChanged(page, [meeting]);

  const row = list
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: after, exact: true }) });
  const waiting = row.getByRole('status', { name: `${after} is waiting` });
  await expect(waiting).toBeVisible();
  await expect(waiting.locator('.status-pill[data-tone="waiting"]')).toHaveText('Waiting');
  await expect(waiting).toContainText('Waiting, not broken: it has reached an hourly limit.');
  await expect(waiting).toContainText(
    'It may ask Claude 30 times an hour, and it has asked 30 times in the last hour.',
  );
  await expect(waiting).toContainText(`It runs next at ${until}, on what changed meanwhile.`);
  await expect(waiting).toContainText(`“${extraction}” reads every meeting too`);
  await expect(row.getByText('Next run').locator('..')).toContainText(until);
  await expect(row.locator('.automation-card__notice')).toHaveCount(0);

  // The turn-off it offers is the #793 one: only the extraction is turned off.
  const rule = `.atlas/automations/${extraction}.md`;
  await waiting.getByRole('button', { name: `Turn off “${extraction}”` }).click();
  await expect.poll(() => vault.read(rule)).toContain('\nenabled: false\n');
  expect(await vault.read(`.atlas/automations/${after}.md`)).toContain('\nenabled: true\n');
  expect(await vault.exists(meeting)).toBe(true);
});
