import { dirname } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import {
  copiedText,
  createVault,
  expectFile,
  expectSaved,
  installHost,
  saveStatus,
  sidebarSection,
  solidPng,
  STUB_API_PORT,
  type FakeHost,
  type FakeVault,
} from './host.ts';
import { caretAtLineEnd } from './caret.ts';

/**
 * P15-04: the local API, from the Settings switch to a request answered by the
 * running app. The stub host stands in for the Rust server: it emits
 * `api-request` as the server would and captures what `api_respond` sends back.
 * The server's own guards — the token check, Host and Origin, the port — are
 * Rust's and are tested in src-tauri.
 */

const TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, doing, done]',
  '---',
  '',
].join('\n');

const VIEW = [
  '---',
  'atlas: view',
  'type: task',
  'columns: [status]',
  '---',
  '',
  '# Tasks',
  '',
].join('\n');

// A task made through the API with no folder goes to its type's home for today (#214).
const TODAY = new Date().toLocaleDateString('en-CA');
const [YEAR, MONTH] = [TODAY.slice(0, 4), TODAY.slice(5, 7)];
const FRESH = `Tasks/${YEAR}/${MONTH}/Fresh.md`;

const FIRST = '---\ntype: task\nstatus: doing\n---\n\n# First\n\nThe work.\n';

async function openVault(
  page: Page,
  {
    files = {},
    feeds = {},
  }: { files?: Record<string, string>; feeds?: Record<string, string> } = {},
): Promise<{ vault: FakeVault; host: FakeHost }> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Tasks.md', VIEW);
  await vault.write('first.md', FIRST);
  for (const [path, text] of Object.entries(files)) {
    await vault.mkdir(dirname(path));
    await vault.write(path, text);
  }

  const host = await installHost(page, vault, { feeds });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
const apiStatus = (page: Page) => settings(page).getByTestId('api-status');

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings(page)).toBeVisible();
}

/** Settings → Connections → Local API on, then back to the vault. */
async function turnApiOn(page: Page, host: FakeHost): Promise<void> {
  await openSettings(page);
  await expect(apiStatus(page)).toHaveText('Off');
  await settings(page).getByRole('switch', { name: 'Local API' }).click();
  await expect(apiStatus(page)).toHaveText(`Running on port ${STUB_API_PORT}`);
  expect(host.api.enabled()).toBe(true);
  await settings(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(settings(page)).toHaveCount(0);
}

async function openFirstInPane(page: Page): Promise<void> {
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'first', exact: true })
    .click();
  await expect(page.getByRole('article', { name: 'First' })).toBeVisible();
}

const encoded = (path: string) => encodeURIComponent(path);

test('Settings turns the API on, off by default, and says where it is running', async ({
  page,
}) => {
  const { host } = await openVault(page);
  await openSettings(page);

  await expect(apiStatus(page)).toHaveText('Off');
  await expect(settings(page).getByRole('switch', { name: 'Local API' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  expect(host.api.enabled()).toBe(false);
  await expect(host.api.send({ method: 'GET', path: '/v1/status' })).rejects.toThrow(
    'the local API is off',
  );

  await settings(page).getByRole('switch', { name: 'Local API' }).click();

  await expect(apiStatus(page)).toHaveText(`Running on port ${STUB_API_PORT}`);
  expect(host.api.enabled()).toBe(true);
  await expect(settings(page).locator('.settings__file code')).toHaveText('/stub/api.json');

  // And the app answers once it is on.
  const status = await host.api.send({ method: 'GET', path: '/v1/status' });
  expect(status.status).toBe(200);
  expect(status.body).toMatchObject({ app: 'atlas', index: { ready: true } });
});

test('the MCP command names the server built beside this app, and copies exactly that', async ({
  page,
}) => {
  await openVault(page);
  await openSettings(page);

  const command = settings(page).locator('.settings__code');
  await expect(command).toHaveText(
    /^claude mcp add atlas -- node \/\S+\/apps\/mcp\/dist\/main\.js$/,
  );
  await settings(page).getByRole('button', { name: 'Copy MCP command', exact: true }).click();

  await expect(settings(page).getByText('MCP command copied', { exact: true })).toBeVisible();
  expect(await copiedText(page)).toEqual([await command.textContent()]);
});

test('a note created through the API shows up in the sidebar and in a view, unrefreshed', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  await turnApiOn(page, host);
  await sidebarSection(page, 'views').getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'first', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fresh', exact: true })).toHaveCount(0);

  const created = await host.api.send({
    method: 'POST',
    path: '/v1/notes',
    body: { name: 'Fresh', properties: { type: 'task', status: 'backlog' } },
  });

  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ note: { path: FRESH } });
  await expectFile(vault, FRESH).toContain('status: backlog');
  // In the sidebar, inside its home folder: each level opened in turn.
  const pages = sidebarSection(page, 'userSpace');
  for (const folder of ['Tasks', YEAR, MONTH]) {
    await pages.getByRole('treeitem', { name: folder, exact: true }).click();
  }
  await expect(pages.getByRole('treeitem', { name: 'Fresh', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fresh', exact: true })).toBeVisible();
});

test('a property set through the API reaches the pane holding the note, in one write', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  await turnApiOn(page, host);
  await openFirstInPane(page);
  const status = page.getByRole('region', { name: 'Properties' }).getByLabel('status');
  await expect(status).toHaveValue('doing');
  expect(host.writesTo('first.md')).toBe(0);

  const answer = await host.api.send({
    method: 'PATCH',
    path: `/v1/notes/${encoded('first.md')}/properties`,
    body: { set: { status: 'done' } },
  });

  expect(answer.status).toBe(200);
  expect(answer.body).toMatchObject({ note: { properties: { status: 'done' } } });
  await expect(status).toHaveValue('done');
  await expectFile(vault, 'first.md').toBe(FIRST.replace('status: doing', 'status: done'));
  await expectSaved(page);
  // Through the pane's own save, once: not the file written underneath the
  // pane and then the pane's older copy saved over it.
  expect(host.writesTo('first.md')).toBe(1);
});

test('a body write to a note with unsaved typing is refused, and the typing survives', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  await turnApiOn(page, host);
  await openFirstInPane(page);
  const read = await host.api.send({ method: 'GET', path: `/v1/notes/${encoded('first.md')}` });
  const { modified } = (read.body as { note: { modified: number } }).note;

  // The pane's save is held in flight, so its typing stays unsaved for as long
  // as this test needs rather than for as long as the autosave timer allows.
  const release = host.holdWrites('first.md');
  await caretAtLineEnd(page.getByText('The work.'));
  await page.keyboard.type(' Typed in DFAI.');
  await expect(saveStatus(page)).toHaveText('Unsaved');

  const refused = await host.api.send({
    method: 'PUT',
    path: `/v1/notes/${encoded('first.md')}/body`,
    body: { markdown: '# First\n\nWritten by another tool.\n', ifModified: modified },
  });

  expect(refused.status).toBe(409);
  expect(refused.body).toMatchObject({ error: { code: 'unsaved_in_app' } });
  expect(await vault.read('first.md')).toBe(FIRST);
  await expect(page.getByText('The work. Typed in DFAI.')).toBeVisible();

  release();
  await expectFile(vault, 'first.md').toContain('The work. Typed in DFAI.');
  expect(await vault.read('first.md')).not.toContain('Written by another tool.');
});

test('a body write naming the note in another case is refused while it has unsaved typing', async ({
  page,
}) => {
  // The stub host is a real directory, and macOS disks ignore case: FIRST.md
  // opens first.md, as it would for any tool calling the real API (R15-01).
  const { vault, host } = await openVault(page);
  await turnApiOn(page, host);
  await openFirstInPane(page);
  const read = await host.api.send({ method: 'GET', path: `/v1/notes/${encoded('FIRST.md')}` });
  const { path, modified } = (read.body as { note: { path: string; modified: number } }).note;
  expect(path).toBe('first.md');

  const release = host.holdWrites('first.md');
  await caretAtLineEnd(page.getByText('The work.'));
  await page.keyboard.type(' Typed in DFAI.');
  await expect(saveStatus(page)).toHaveText('Unsaved');

  const refused = await host.api.send({
    method: 'PUT',
    path: `/v1/notes/${encoded('FIRST.md')}/body`,
    body: { markdown: '# First\n\nWritten by another tool.\n', ifModified: modified },
  });

  expect(refused.body).toMatchObject({ error: { code: 'unsaved_in_app' } });
  expect(await vault.read('first.md')).toBe(FIRST);
  release();
  await expectFile(vault, 'first.md').toContain('The work. Typed in DFAI.');
});

test('rotating the token asks first, then replaces the one Copy token hands out', async ({
  page,
}) => {
  const { host } = await openVault(page);
  await openSettings(page);
  await settings(page).getByRole('button', { name: 'Copy token', exact: true }).click();
  await expect(settings(page).getByText('Token copied', { exact: true })).toBeVisible();
  expect(await copiedText(page)).toEqual(['token-1']);

  await settings(page).getByRole('button', { name: 'Rotate token…', exact: true }).click();
  expect(host.api.token()).toBe('token-1');
  await settings(page).getByRole('button', { name: 'Rotate', exact: true }).click();

  await expect(settings(page).getByText(/^Token rotated\./)).toBeVisible();
  expect(host.api.token()).toBe('token-2');
  await settings(page).getByRole('button', { name: 'Copy token', exact: true }).click();
  await expect(settings(page).getByText('Token copied', { exact: true })).toBeVisible();
  expect(await copiedText(page)).toEqual(['token-1', 'token-2']);
});

/*
 * The routes the API/MCP keeper added for U-12, U-13, U-14 and P12-06, each
 * answered by the running app with its own settings, index and host.
 */

test('an image sent through the API lands where Settings → Images puts it, and the note shows it', async ({
  page,
}) => {
  const { vault, host } = await openVault(page, { files: { 'Work/plan.md': '# Plan\n' } });
  await openSettings(page);
  await settings(page).getByRole('radio', { name: 'Beside the note' }).click();
  await page.keyboard.press('Escape');
  await expect(settings(page)).toHaveCount(0);
  await turnApiOn(page, host);
  const note = `/v1/notes/${encoded('Work/plan.md')}`;

  const saved = await host.api.send({
    method: 'PUT',
    path: `${note}/images/${encoded('dot.png')}`,
    body: { base64: solidPng(8, 8, [0, 120, 200]).toString('base64') },
  });

  expect(saved.status).toBe(201);
  expect(saved.body).toMatchObject({
    image: { path: 'Work/dot.png', src: 'dot.png', markdown: '![dot](dot.png)' },
  });
  expect(await vault.exists('Work/dot.png')).toBe(true);
  expect(await vault.exists('attachments')).toBe(false);

  const markdown = (saved.body as { image: { markdown: string } }).image.markdown;
  const appended = await host.api.send({
    method: 'POST',
    path: `${note}/append`,
    body: { markdown },
  });
  expect(appended.status).toBe(200);
  await expectFile(vault, 'Work/plan.md').toContain('![dot](dot.png)');
});

test('an image sent in chunks is staged in the cache and moved into place whole with its last', async ({
  page,
}) => {
  const { vault, host } = await openVault(page, { files: { 'Work/plan.md': '# Plan\n' } });
  await turnApiOn(page, host);
  const path = `/v1/notes/${encoded('Work/plan.md')}/images/${encoded('dot.png')}`;
  const png = solidPng(8, 8, [0, 120, 200]);
  const cut = 16;

  const first = await host.api.send({
    method: 'PUT',
    path,
    body: { base64: png.subarray(0, cut).toString('base64'), last: false },
  });
  expect(first.status).toBe(202);
  const { id } = (first.body as { upload: { id: string } }).upload;
  expect(await vault.exists('attachments/dot.png')).toBe(false);

  const last = await host.api.send({
    method: 'PUT',
    path,
    body: { base64: png.subarray(cut).toString('base64'), offset: cut, upload: id },
  });

  expect(last.status).toBe(201);
  expect(last.body).toMatchObject({ image: { path: 'attachments/dot.png', size: png.length } });
  expect(await vault.exists('attachments/dot.png')).toBe(true);
  expect(await vault.exists(`.atlas-cache/uploads/${id}`)).toBe(false);
});

const DATED_TASK = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, doing, done]',
  '  due:',
  '    kind: date',
  '---',
  '',
].join('\n');

const WEEK = [
  '---',
  'atlas: view',
  'type: task',
  'layout: calendar',
  'dateKey: due',
  'calendarRange: week',
  'columns: [status]',
  '---',
  '',
].join('\n');

test('a note quick-added through the API is on the calendar the API reads', async ({ page }) => {
  const { vault, host } = await openVault(page, {
    files: { '.atlas/types/task.md': DATED_TASK, '.atlas/views/Week.md': WEEK },
  });
  await turnApiOn(page, host);

  const offered = await host.api.send({ method: 'GET', path: '/v1/quick-add' });
  expect(offered.body).toEqual({
    types: [{ name: 'task', label: 'task', fields: ['status', 'due'] }],
  });

  const added = await host.api.send({
    method: 'POST',
    path: '/v1/quick-add',
    body: { type: 'task', name: 'Call Sam', values: { status: 'doing', due: '2026-09-23' } },
  });
  expect(added.status).toBe(201);
  const { path } = (added.body as { note: { path: string } }).note;
  await expectFile(vault, path).toContain('2026-09-23');

  const week = () =>
    host.api.send({
      method: 'POST',
      path: `/v1/views/${encoded('.atlas/views/Week.md')}/calendar`,
      body: { anchor: '2026-09-23' },
    });
  await expect
    .poll(async () => ((await week()).body as { events?: { title: string }[] }).events)
    .toEqual([
      {
        path,
        title: 'Call Sam',
        start: '2026-09-23',
        end: null,
        allDay: true,
        on: ['2026-09-23'],
      },
    ]);
  expect(((await week()).body as { days: string[] }).days[0]).toBe('2026-09-21');
});

const PEOPLE_FEED = 'https://people.example.com/team.json';
const PEOPLE_SOURCE = [
  '---',
  'atlas: source',
  'format: json',
  `url: ${PEOPLE_FEED}`,
  'into: People',
  'type: person',
  'key: id',
  'name: name',
  '---',
  '',
].join('\n');

test('a source refreshed through the API writes its notes and reports what it did', async ({
  page,
}) => {
  const { vault, host } = await openVault(page, {
    // A source writes into a folder that is there, as the app's own refresh does.
    files: { '.atlas/sources/People.md': PEOPLE_SOURCE, 'People/About.md': '# People\n' },
    feeds: { [PEOPLE_FEED]: JSON.stringify([{ id: '1', name: 'Ada' }]) },
  });
  await turnApiOn(page, host);

  const refreshed = await host.api.send({
    method: 'POST',
    path: `/v1/sources/${encoded('.atlas/sources/People.md')}/refresh`,
  });

  expect(refreshed.status).toBe(200);
  expect(refreshed.body).toMatchObject({
    report: { from: PEOPLE_FEED, records: 1, created: 1, error: null },
  });
  expect(host.secrets.requests()).toHaveLength(1);
  await expectFile(vault, 'People/1.md').toContain('title: Ada');
  await expect(
    sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'People', exact: true }),
  ).toBeVisible();
});

test('a day’s meetings from Google Calendar are read through the API from the event notes', async ({
  page,
}) => {
  const event = (title: string, date: string, extra: string[] = []) =>
    [
      '---',
      'type: event',
      `title: ${title}`,
      `date: ${date}`,
      `gcal_event_id: ev-${title.toLowerCase().replace(/ /g, '-')}`,
      'gcal_calendar: primary',
      ...extra,
      '---',
      '',
    ].join('\n');
  const { host } = await openVault(page, {
    files: {
      'Calendar/2026-10-24 Payroll standup.md': event('Payroll standup', '2026-10-24T09:00', [
        'ends: 2026-10-24T09:30',
        'gcal_response: accepted',
      ]),
      'Calendar/2026-10-24 Declined sync.md': event('Declined sync', '2026-10-24T11:00', [
        'gcal_response: declined',
      ]),
    },
  });
  await turnApiOn(page, host);

  const day = () =>
    host.api.send({ method: 'GET', path: '/v1/calendar/meetings', query: { day: '2026-10-24' } });
  await expect
    .poll(async () => (await day()).body)
    .toEqual({
      day: '2026-10-24',
      meetings: [
        {
          path: 'Calendar/2026-10-24 Payroll standup.md',
          title: 'Payroll standup',
          start: '09:00',
          end: '09:30',
          people: [],
          companies: [],
          meeting: null,
          unanswered: false,
        },
      ],
    });
  const missing = await host.api.send({ method: 'GET', path: '/v1/calendar/meetings' });
  expect(missing.status).toBe(400);
});
