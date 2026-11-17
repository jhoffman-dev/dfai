import { readFileSync } from 'node:fs';
import { logPathFor, newLogText, type LogEntry } from '../packages/domain/src/index.ts';
import { expect, test } from './fixtures.ts';
import { createVault, emitVaultChanged, installHost } from './host.ts';

/**
 * #813: with both meeting presets on and their hours spent, "After a
 * meeting" — held by its thirty asks — reads as waiting, says why and when,
 * and offers nothing to turn off (the extraction does not spend its asks);
 * the extraction — held by twenty runs that all failed — reads as failing,
 * with the count, the last reason and when it tries again. The logs are
 * written as spent ten minutes ago, so a meeting arriving now finds both held.
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

/** A run set off by a meeting that failed at `at`. */
const failed = (at: string): LogEntry => ({
  kind: 'failed',
  at,
  trigger: 'note',
  problem: 'Claude could not be reached.',
});

test('a held rule shows as waiting with why and when, and one whose runs failed shows as failing (#813)', async ({
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

  // Each spent its hour ten minutes ago: thirty asks, and twenty runs that failed.
  const spentAt = new Date(Date.now() - 10 * 60_000);
  const at = localTime(spentAt);
  const until = localTime(new Date(spentAt.getTime() + 60 * 60_000)).slice(11, 16);
  await vault.write(logPathFor(after), newLogText(after, [asked(at, 30)]));
  await vault.write(
    logPathFor(extraction),
    newLogText(
      extraction,
      Array.from({ length: 20 }, () => failed(at)),
    ),
  );

  // A meeting arrives, as a pull brings one: both hear it, and both are held.
  const meeting = 'Inbox/Meetings/Larkspur sync.md';
  await vault.write(meeting, VALID.replace(/^external_id: .*$/m, "external_id: 'gemini-eeee0005'"));
  await emitVaultChanged(page, [meeting]);

  const rowOf = (name: string) =>
    list.getByRole('listitem').filter({ has: page.getByRole('button', { name, exact: true }) });

  // Waiting: the pill, why, when, nothing to do — and no turn-off, which would not free it.
  const row = rowOf(after);
  const waiting = row.getByRole('status', { name: `${after} is waiting` });
  await expect(waiting).toBeVisible();
  await expect(waiting.locator('.status-pill[data-tone="waiting"]')).toHaveText('Waiting');
  await expect(waiting).toContainText(
    'Not broken: it has asked Claude 30 times this hour, and 30 is its most ' +
      '(an ask is one question; a long meeting takes a few). ' +
      `It runs next at ${until}, on what arrived meanwhile; nothing to do.`,
  );
  await expect(row.getByText('Next run').locator('..')).toContainText(until);
  await expect(row.locator('.automation-card__notice')).toHaveCount(0);
  await expect(waiting.getByRole('button')).toHaveCount(0);

  // The row grows to hold all of its reason.
  const bottomOf = async (locator: typeof row) => {
    const box = await locator.boundingBox();
    return box === null ? Number.NaN : box.y + box.height;
  };
  await expect
    .poll(async () => (await bottomOf(row)) - (await bottomOf(waiting.locator('p'))))
    .toBeGreaterThanOrEqual(0);

  // Failing: the warning notice, the count, its last reason and when it tries again; never waiting.
  const failing = rowOf(extraction);
  await expect(failing.locator('.automation-card__notice')).toHaveText(
    'It failed all 20 times it ran this hour. The last failure: Claude could not be reached. ' +
      `It has used up its hourly limit, so it tries again at ${until}.`,
  );
  await expect(failing.getByRole('status', { name: `${extraction} is waiting` })).toHaveCount(0);
  expect(await vault.exists(meeting)).toBe(true);
});
