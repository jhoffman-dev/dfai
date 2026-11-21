import { expect, test, type Page } from '@playwright/test';
import {
  FAKE_REPO,
  FAKE_TOKEN,
  FakeGitHub,
} from '../src/adapters/github/fake-github.test-support.ts';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-expose-headers': '*',
};

/** Answers the app's GitHub calls from the in-test fake, so nothing reaches the network. */
async function serveGitHub(page: Page, github: FakeGitHub): Promise<void> {
  await page.route('https://api.github.com/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const body = request.postData();
    const answer = await github.fetch(request.url(), {
      method: request.method(),
      headers: request.headers(),
      ...(body === null ? {} : { body }),
    });
    await route.fulfill({
      status: answer.status,
      headers: {
        ...CORS,
        'content-type': answer.headers.get('content-type') ?? 'application/json',
      },
      body: await answer.text(),
    });
  });
}

async function connect(page: Page, token: string): Promise<void> {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('button', { name: 'Settings' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByLabel('GitHub repository').fill(`${FAKE_REPO.owner}/${FAKE_REPO.repo}`);
  await dialog.getByLabel('Branch').fill(FAKE_REPO.branch);
  await dialog.getByLabel('Personal access token').fill(token);
  await dialog.getByRole('button', { name: 'Save' }).click();
}

const noteText = (page: Page) => page.getByRole('textbox', { name: 'Note text' });

test('syncs a vault with GitHub: pull, push with the index, keep across a reload, pull again', async ({
  page,
}) => {
  const github = new FakeGitHub({
    'Welcome.md': 'Hello from the repository. #start\n',
    'Projects/Garden shed.md': 'A shed at the bottom of the garden.\n',
  });
  await serveGitHub(page, github);
  await connect(page, FAKE_TOKEN);

  // The remote's notes arrive, and the sample vault is gone.
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar.getByRole('tree', { name: 'Notes' })).toContainText('Welcome');
  await expect(
    page.getByText('Sample vault — connect a GitHub repository in Settings.'),
  ).toBeHidden();
  await expect(sidebar.getByRole('button', { name: /Sync status: Synced/ })).toBeVisible();

  // An edit here reaches GitHub as a commit, with the generated index beside it.
  await sidebar.getByRole('tree', { name: 'Notes' }).getByText('Welcome').click();
  await expect(noteText(page)).toContainText('Hello from the repository.');
  await noteText(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('Written on this device.');
  await expect
    .poll(() => github.files()['Welcome.md'], { timeout: 20_000 })
    .toContain('Written on this device.');
  expect(Object.keys(github.files())).toContain('_index/README.md');

  // The notes are kept in this browser: a reload opens them before any sync.
  await page.reload();
  await expect(noteText(page)).toContainText('Written on this device.');

  // A change made elsewhere arrives on Sync now.
  await github.commitOutside({ 'Inbox/From the laptop.md': 'Typed on the laptop.\n' });
  await sidebar.getByRole('button', { name: /Sync status/ }).click();
  await expect(sidebar.getByRole('tree', { name: 'Notes' })).toContainText('Inbox');
  await page.goto('/#/note/Inbox%2FFrom%20the%20laptop.md');
  await expect(noteText(page)).toContainText('Typed on the laptop.');
});

test('a token GitHub refuses ends in "needs sign-in", and Disconnect forgets it', async ({
  page,
}) => {
  const github = new FakeGitHub({ 'Welcome.md': 'Hello.\n' });
  await serveGitHub(page, github);
  await connect(page, 'github_pat_not-a-real-token');

  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar.getByRole('button', { name: /Sync status: Needs sign-in/ })).toBeVisible();
  await sidebar.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('status')).toContainText('GitHub refused the token');
  await expect(dialog).not.toContainText('github_pat_not-a-real-token');

  await dialog.getByRole('button', { name: 'Disconnect' }).click();
  await expect(
    page.getByText('Sample vault — connect a GitHub repository in Settings.'),
  ).toBeVisible();
});
