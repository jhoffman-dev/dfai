import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { connectInMemoryMcp } from '../apps/mcp/src/testing/in-memory-mcp.ts';
import { expect, test, type Page } from './fixtures.ts';
import {
  type ApiCall,
  createVault,
  expectFile,
  installHost,
  STUB_API_PORT,
  type FakeHost,
  type FakeVault,
} from './host.ts';

/**
 * #103: a Slack message sent to the running app's local API under
 * capture/v1 arrives in the Inbox as a task, once however often it is sent.
 * The stub host stands in for the Rust server, as in local-api.spec.ts. All
 * names are made up.
 */

const PERMALINK = 'https://larkspur.slack.com/archives/C0LARK5PUR/p1793136000000100';
const PATH = 'Inbox/Captures/Send the Larkspur renewal by Friday (slack 2db9a3ee76a9e132).md';

const CAPTURE = {
  contract: 'capture/v1',
  kind: 'task',
  source: {
    provider: 'slack',
    channel: { id: 'C0LARK5PUR', name: 'larkspur-payroll' },
    ts: '1793136000.000100',
    url: PERMALINK,
    author: { id: 'U0MARAQ111', name: 'Mara Quill', email: 'mara.quill@example.com' },
  },
  text: 'Send the *Larkspur* renewal by Friday',
  thread: [{ ts: '1793136300.000200', author: { name: 'Tobias Fenn' }, text: 'On it.' }],
};

async function openVault(page: Page): Promise<{ host: FakeHost; vault: FakeVault }> {
  const vault = await createVault();
  await vault.write('first.md', '# First\n');
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { host, vault };
}

async function turnApiOn(page: Page): Promise<void> {
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings.getByRole('switch', { name: 'Local API' }).click();
  await expect(settings.getByTestId('api-status')).toHaveText(`Running on port ${STUB_API_PORT}`);
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(settings).toHaveCount(0);
}

test('a Slack message posted as a capture shows in the Inbox as a task, once', async ({ page }) => {
  const { host, vault } = await openVault(page);
  await turnApiOn(page);

  const first = await host.api.send({ method: 'POST', path: '/v1/captures', body: CAPTURE });
  expect(first.status).toBe(201);
  expect(first.body).toMatchObject({ capture: { path: PATH, outcome: 'written' } });
  await expectFile(vault, PATH).toContain(`source: '${PERMALINK}'`);

  await page
    .getByRole('list', { name: 'Go to' })
    .getByRole('button', { name: /^Inbox/ })
    .click();
  const inbox = page.getByRole('article', { name: 'Inbox' });
  const row = inbox.getByRole('button', {
    name: 'Send the Larkspur renewal by Friday (slack 2db9a3ee76a9e132)',
  });
  await expect(row).toBeVisible();
  await expect(inbox.getByText(/Captures/)).toBeVisible();

  const again = await host.api.send({ method: 'POST', path: '/v1/captures', body: CAPTURE });
  expect(again.status).toBe(200);
  expect(again.body).toMatchObject({ capture: { path: PATH, outcome: 'in-vault' } });
  await expect(row).toHaveCount(1);
});

test('a malformed capture is refused with its reasons, and nothing reaches the Inbox', async ({
  page,
}) => {
  const { host, vault } = await openVault(page);
  await turnApiOn(page);

  const refused = await host.api.send({
    method: 'POST',
    path: '/v1/captures',
    body: { ...CAPTURE, kind: 'memo', source: { ...CAPTURE.source, url: undefined } },
  });
  expect(refused.status).toBe(400);
  expect(JSON.stringify(refused.body)).toContain(
    'kind: \\"memo\\" is not \\"note\\" or \\"task\\"',
  );
  expect(JSON.stringify(refused.body)).toContain('source.url: missing');
  expect(await vault.exists(PATH)).toBe(false);
});

/**
 * #106: Claude, holding a message it read through a Slack connector, saves it
 * with `atlas_capture`. The MCP server's requests go to the stub host, so the
 * app's own router, use-case and vault write answer them.
 */
function throughHost(host: FakeHost): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const answer = await host.api.send({
      method: (init?.method ?? 'GET') as ApiCall['method'],
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
}

test('Claude saves a Slack message with atlas_capture once, however often it asks', async ({
  page,
}) => {
  const { host, vault } = await openVault(page);
  await turnApiOn(page);
  const mcp = await connectInMemoryMcp({ fetch: throughHost(host) });
  // The payload less what the tool fills in itself: the contract and the provider.
  const { channel, ts, url, author } = CAPTURE.source;
  const { kind, text, thread } = CAPTURE;
  const toolArguments = { kind, text, thread, source: { channel, ts, url, author } };
  const saveIt = async () => {
    const result = await mcp.callTool({
      name: 'atlas_capture',
      arguments: toolArguments,
    });
    expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
    const [first] = result.content as { text: string }[];
    return JSON.parse(first?.text ?? '') as unknown;
  };

  expect(await saveIt()).toEqual({ capture: { path: PATH, outcome: 'written' } });
  await expectFile(vault, PATH).toContain(`source: '${PERMALINK}'`);
  await page
    .getByRole('list', { name: 'Go to' })
    .getByRole('button', { name: /^Inbox/ })
    .click();
  // Any capture of this message, under any title or number, is a row starting so.
  const rows = page
    .getByRole('article', { name: 'Inbox' })
    .getByRole('button', { name: /^Send the Larkspur renewal by Friday \(slack / });
  await expect(rows).toHaveCount(1);

  expect(await saveIt()).toEqual({ capture: { path: PATH, outcome: 'in-vault' } });
  expect(host.writesTo(PATH)).toBe(1);
  // A backstop: a copy at a numbered path would already have failed the receipt above.
  expect(await readdir(join(vault.root, 'Inbox/Captures'))).toEqual([PATH.split('/').pop()]);
  // A note written after the second save reaching the Inbox means anything it wrote would
  // have too: only then is one row a state rather than a moment.
  const later = await host.api.send({
    method: 'POST',
    path: '/v1/notes',
    body: { folder: 'Inbox', name: 'Written after the second save' },
  });
  expect(later.status).toBe(201);
  await expect(
    page.getByRole('article', { name: 'Inbox' }).getByRole('button', {
      name: /^Written after the second save/,
    }),
  ).toBeVisible();
  await expect(rows).toHaveCount(1);
  await mcp.close();
});
