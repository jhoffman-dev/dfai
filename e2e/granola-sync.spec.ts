import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, STUB_API_PORT, type FakeHost } from './host.ts';

/**
 * P28-12: Settings → Granola. The host's commands are stubbed (`host.ts`):
 * the key is kept per vault and every GET is answered with what a test
 * served at its path. The Keychain, the pinned origin and the key struck
 * from every answer are Rust's (`granola.rs`). The two meetings are made up.
 */

const KEY = 'grn_fictional0123456789abcdef';

/** A note as `GET /v1/notes/{id}?include=transcript` answers it. */
const note = (id: string, title: string, updatedAt: string) => ({
  id,
  object: 'note',
  title,
  owner: { name: 'Mara Quill', email: 'mara.quill@example.com' },
  created_at: '2026-10-06T16:58:00Z',
  updated_at: updatedAt,
  deleted_at: null,
  web_url: `https://notes.granola.ai/d/${id}`,
  calendar_event: null,
  attendees: [{ name: 'Tobias Fenn', email: 'tobias.fenn@example.com' }],
  folder_membership: [],
  summary_text: 'Larkspur Payroll go-live moves a week.',
  summary_markdown: null,
  private_notes_text: null,
  private_notes_markdown: null,
  transcript: [
    {
      speaker: { source: 'microphone', attribution: 'me' },
      text: 'Morning, Tobias.',
      start_time: '2026-10-06T17:00:00Z',
      end_time: '2026-10-06T17:00:04Z',
    },
    {
      speaker: { source: 'speaker', attribution: 'them' },
      text: 'Morning. Go-live moves a week.',
      start_time: '2026-10-06T17:00:05Z',
      end_time: '2026-10-06T17:00:09Z',
    },
  ],
});

const RENEWAL = note('not_e2eRenewal0001', 'Larkspur Payroll renewal', '2026-10-13T15:00:00Z');
const ONE_ON_ONE = note('not_e2eOneOnOne002', 'Tobias one on one', '2026-10-13T16:00:00Z');

/** A pulled meeting arrives in its month's folder (#214). */
const RENEWAL_FILE = 'Meetings/2026/10/2026-10-06 Larkspur Payroll renewal.md';
const ONE_ON_ONE_FILE = 'Meetings/2026/10/2026-10-06 Tobias one on one.md';

const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });

/** Granola's list of notes, and each note, as it holds them now. */
function serveNotes(host: FakeHost, notes: readonly ReturnType<typeof note>[]) {
  host.granola.serve(
    '/v1/notes',
    ok({
      notes: notes.map(({ id, title, updated_at }) => ({ id, object: 'note', title, updated_at })),
      hasMore: false,
      cursor: null,
    }),
  );
  for (const each of notes) host.granola.serve(`/v1/notes/${each.id}`, ok(each));
}

async function openSettings(
  page: Page,
  { watermark, settings }: { watermark?: string; settings?: string } = {},
) {
  const vault = await createVault();
  if (settings !== undefined) {
    await vault.mkdir('.atlas');
    await vault.write('.atlas/settings.md', settings);
  }
  const host = await installHost(page, vault);
  if (watermark !== undefined) {
    // This Mac's record of where its pulls of the vault left off.
    await page.addInitScript(({ key, record }) => window.localStorage.setItem(key, record), {
      key: `atlas.granola-pull:${vault.root}`,
      record: JSON.stringify({ watermark, lastPullAt: null }),
    });
  }
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  return { vault, host };
}

const card = (page: Page) =>
  page.getByRole('dialog', { name: 'Settings' }).getByRole('region', { name: 'Granola' });

test('a key is set, the meetings Granola holds are pulled in, and Sync now brings a new one', async ({
  page,
}) => {
  const { vault, host } = await openSettings(page);
  await expect(card(page).getByTestId('granola-key')).toHaveText('No key on this Mac');
  await expect(card(page).getByText('Granola → Settings → Connectors → API keys')).toBeVisible();
  await expect(card(page).getByRole('button', { name: 'Sync now' })).toBeDisabled();

  const indexed = page.getByText(/^\d+ notes indexed$/).first();
  const before = Number.parseInt((await indexed.textContent()) ?? '', 10);
  serveNotes(host, [RENEWAL]);
  await card(page).getByLabel('Granola API key', { exact: true }).fill(KEY);
  await card(page).getByRole('button', { name: 'Save', exact: true }).click();

  await expect(card(page).getByTestId('granola-key')).toHaveText('Key accepted');
  await expect(card(page).getByLabel('Granola API key', { exact: true })).toHaveValue('');
  expect(host.granola.hasKey()).toBe(true);
  // A key set where there was none pulls at once: the vault does not sync, so has nothing to wait for.
  await expectFile(vault, RENEWAL_FILE).toContain(`external_id: '${RENEWAL.id}'`);
  await expect(card(page).getByTestId('granola-pull')).toContainText('1 new, 0 already in DFAI');

  // The meeting written is in the index as soon as the pull has ended, as it would be from Sync.
  await expect(indexed).toHaveText(`${before + 1} notes indexed`);

  serveNotes(host, [RENEWAL, ONE_ON_ONE]);
  await card(page).getByRole('button', { name: 'Sync now' }).click();

  await expectFile(vault, ONE_ON_ONE_FILE).toContain(`external_id: '${ONE_ON_ONE.id}'`);
  await expect(card(page).getByTestId('granola-pull')).toContainText('1 new, 1 already in DFAI');
  // The meeting already in the vault was never fetched again.
  const fetched = host.granola.requests().filter(({ path }) => path === `/v1/notes/${RENEWAL.id}`);
  expect(fetched).toHaveLength(1);
});

/**
 * Each request to Granola, as which of them it was: the key's check asks for
 * one note; a pull on open or on the timer lists from the watermark; Sync now
 * lists everything.
 */
const requestKinds = (host: FakeHost) =>
  host.granola.requests().map(({ path, query }) => {
    if (path !== '/v1/notes') return path;
    if (query.page_size === '1') return 'key check';
    return 'updated_after' in query ? 'pull from the watermark' : 'Sync now';
  });

test('a key Granola refuses is said on the card, and nothing is pulled with it', async ({
  page,
}) => {
  // A watermark, so a pull that starts by itself is told apart from Sync now by what it asks.
  const { vault, host } = await openSettings(page, { watermark: '2026-10-01T00:00:00.000Z' });
  host.granola.serve('/v1/notes', { status: 401, body: '{"message":"Unauthorized"}' });

  await card(page).getByLabel('Granola API key', { exact: true }).fill(KEY);
  await card(page).getByRole('button', { name: 'Save', exact: true }).click();

  await expect(card(page).getByTestId('granola-key')).toHaveText('Granola refused this key');
  await expect(card(page).getByTestId('granola-pull')).toHaveText('Not pulled on this Mac yet');

  // Sync now asks Granola whatever its last answer was, and runs after any pull already under
  // way: once its listing has gone, a pull the refused key started by itself would have too.
  await card(page).getByRole('button', { name: 'Sync now' }).click();
  await expect.poll(() => requestKinds(host)).toContain('Sync now');
  const toast = page.locator('.toast');
  await expect(toast).toContainText('Granola refused the API key');
  // The remedy is the point of the toast, and it is long: the words wrap to
  // more than one line inside the toast rather than being cut off (#328).
  const message = toast.locator('.toast__message');
  await expect(message).toContainText('Create one in Granola');
  await expect(message).toContainText('paste it in Settings → Granola');
  expect(
    await message.evaluate((words) => ({
      fits: words.scrollWidth <= words.clientWidth && words.scrollHeight <= words.clientHeight,
      lines: Math.round(
        words.getBoundingClientRect().height / parseFloat(getComputedStyle(words).lineHeight),
      ),
    })),
  ).toEqual({ fits: true, lines: expect.any(Number) });
  const [words, whole] = [await message.boundingBox(), await toast.boundingBox()];
  expect(words!.height).toBeGreaterThan(30);
  expect(words!.x + words!.width).toBeLessThanOrEqual(whole!.x + whole!.width);
  expect(words!.y + words!.height).toBeLessThanOrEqual(whole!.y + whole!.height);
  expect(requestKinds(host)).toEqual(['key check', 'Sync now']);
  expect(await vault.read(RENEWAL_FILE)).toBe('');
});

test('a second Sync now that fails the same way, while its toast still shows, gets a full five seconds', async ({
  page,
}) => {
  const { host } = await openSettings(page, { watermark: '2026-10-01T00:00:00.000Z' });
  host.granola.serve('/v1/notes', { status: 401, body: '{"message":"Unauthorized"}' });
  await card(page).getByLabel('Granola API key', { exact: true }).fill(KEY);
  await card(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card(page).getByTestId('granola-key')).toHaveText('Granola refused this key');

  // A fake clock from here on, so the toast's five seconds are stepped, not
  // waited for. Real time still flows on an installed clock, and a slow runner
  // can spend seconds between two steps, so each step leaves room: the toast is
  // checked well short of its five seconds, and well past them.
  await page.clock.install();
  const toast = page.locator('.toast');
  const syncNowCount = () => requestKinds(host).filter((kind) => kind === 'Sync now').length;
  await card(page).getByRole('button', { name: 'Sync now' }).click();
  await expect.poll(syncNowCount).toBe(1);
  await expect(toast).toContainText('Granola refused the API key');

  await page.clock.runFor(4000);
  await expect(toast).toBeVisible();
  // The first toast says the same words, so they cannot show the second has
  // been drawn: the first is marked, and the second is waited for as a new toast.
  await toast.evaluate((first) => first.setAttribute('data-e2e-first', ''));
  await card(page).getByRole('button', { name: 'Sync now' }).click();
  await expect.poll(syncNowCount).toBe(2);
  await expect(page.locator('.toast:not([data-e2e-first])')).toContainText(
    'Granola refused the API key',
  );
  await expect(toast).toHaveCount(1);

  // 5.5 s or more after the first showing, 1.5 s after the second: still up —
  // gone, had the second not started the time afresh.
  await page.clock.runFor(1500);
  await expect(toast).toBeVisible();
  // 5.5 s or more after the second: its full time is up.
  await page.clock.runFor(4000);
  await expect(toast).toHaveCount(0);
});

test('a Sync now that fails says why as a toast', async ({ page }) => {
  const { host } = await openSettings(page);
  serveNotes(host, []);
  await card(page).getByLabel('Granola API key', { exact: true }).fill(KEY);
  await card(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card(page).getByTestId('granola-pull')).toContainText('nothing new');

  host.granola.serve('/v1/notes', { status: 503, body: '{"message":"Unavailable"}' });
  await card(page).getByRole('button', { name: 'Sync now' }).click();

  const toast = page.locator('.toast');
  await expect(toast).toContainText('Granola is having trouble (status 503).');
  await expect(card(page).getByRole('alert')).toContainText('Granola is having trouble');
});

test('the local API reads Granola’s status, never the key, and pulls once per 30 s (P28-13)', async ({
  page,
}) => {
  const { vault, host } = await openSettings(page);
  serveNotes(host, [RENEWAL]);
  await card(page).getByLabel('Granola API key', { exact: true }).fill(KEY);
  await card(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expectFile(vault, RENEWAL_FILE).toContain(`external_id: '${RENEWAL.id}'`);

  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('switch', { name: 'Local API' }).click();
  await expect(settings.getByTestId('api-status')).toHaveText(`Running on port ${STUB_API_PORT}`);

  const status = await host.api.send({ method: 'GET', path: '/v1/granola' });
  expect(status.status).toBe(200);
  expect(status.body).toMatchObject({ hasKey: true, lastPullAt: expect.any(Number) });

  serveNotes(host, [RENEWAL, ONE_ON_ONE]);
  const pulled = await host.api.send({ method: 'POST', path: '/v1/granola/pull' });
  expect(pulled.status).toBe(200);
  expect(pulled.body).toMatchObject({
    report: { mode: 'sync-now', ended: 'pulled', written: [ONE_ON_ONE_FILE], held: 1 },
  });
  await expectFile(vault, ONE_ON_ONE_FILE).toContain(`external_id: '${ONE_ON_ONE.id}'`);
  // The app's own Sync now ran: its card says what this pull did.
  await expect(card(page).getByTestId('granola-pull')).toContainText('1 new, 1 already in DFAI');

  const again = await host.api.send({ method: 'POST', path: '/v1/granola/pull' });
  expect(again.body).toMatchObject({ error: { code: 'conflict', retryAfter: expect.any(Number) } });

  for (const answer of [status, pulled, again]) expect(JSON.stringify(answer)).not.toContain(KEY);
});
