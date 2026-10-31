import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, type FakeHost, type FakeVault } from './host.ts';

/**
 * #81: what makes DFAI the daily driver — today's note from the built-in
 * Daily type, and quick capture from any app through the global shortcut.
 */

/** Midday local time, so the browser and this file read the same day. */
const NOW = new Date(2026, 9, 12, 12);
const today = NOW.toLocaleDateString('en-CA');

/** Where a new daily note is made: the daily type's home for its year (#214). */
const DAILY = `Daily/${today.slice(0, 4)}`;

const TASK_TYPE = ['---', 'name: task', 'properties:', '  due: date', '---', ''].join('\n');

/** A daily note as the Notion import writes it: named by its date, at the root. */
const IMPORTED = [
  '---',
  'type: daily',
  'notion_id: 0a1b2c3d',
  '---',
  '',
  '## What happened',
  '',
  'Walked the beds with Mara Quill; the seed swap moved to Saturday.',
  '',
].join('\n');

async function openVault(
  page: Page,
  files: Record<string, string> = {},
): Promise<{ vault: FakeVault; host: FakeHost }> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('Garden.md', '# Garden\n\nBeds and seeds.\n');
  for (const [path, text] of Object.entries(files)) {
    if (path.includes('/')) await vault.mkdir(path.slice(0, path.lastIndexOf('/')));
    await vault.write(path, text);
  }
  const host = await installHost(page, vault);
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

const todaysNote = (page: Page) => page.keyboard.press('ControlOrMeta+Shift+D');
const goTo = (page: Page) => page.getByRole('list', { name: 'Go to' });

test.describe("today's note", () => {
  // Its Task type is not on GTD, so the note starts without the day's blocks (#110).
  test('is made from the built-in Daily template in a vault that has none', async ({ page }) => {
    const { vault } = await openVault(page);

    await todaysNote(page);

    await expect(page.getByRole('article', { name: today })).toBeVisible();
    await expectFile(vault, `${DAILY}/${today}.md`).toMatch(
      /^---\ntype: daily\n---\n\n## What happened\n\n## What is next\n$/,
    );
  });

  test('opens a daily note the import wrote, leaving every byte of it alone', async ({ page }) => {
    const { vault, host } = await openVault(page, { [`${today}.md`]: IMPORTED });

    await todaysNote(page);

    const note = page.getByRole('article', { name: today });
    await expect(note).toBeVisible();
    await expect(note).toContainText('the seed swap moved to Saturday');
    expect(host.writesTo(`${today}.md`)).toBe(0);
    expect(await vault.read(`${today}.md`)).toBe(IMPORTED);
    expect(await vault.exists(`${today} 2.md`)).toBe(false);
    expect(await vault.exists(`${DAILY}/${today}.md`)).toBe(false);
  });

  test('is a note of the Daily type, which the Inbox offers to add', async ({ page }) => {
    // Something waiting, so the Inbox has a row to open it from.
    const { vault } = await openVault(page, { 'Inbox/Seed catalogue.md': '# Seed catalogue\n' });

    await goTo(page)
      .getByRole('button', { name: /^Inbox/ })
      .click();
    const offer = page
      .getByRole('article', { name: 'Inbox' })
      .getByRole('complementary', { name: 'Set your types up for the Inbox' });
    await expect(offer).toContainText('Daily');
    expect(await vault.exists('.atlas/types/daily.md')).toBe(false);

    await offer.getByRole('button', { name: 'Add to the types' }).click();

    await expectFile(vault, '.atlas/types/daily.md').toMatch(/^---\nname: daily\nlabel: Daily\n/);
  });
});

test.describe('quick capture from any app', () => {
  test('the shortcut the app starts with is ⌃⌥N, handed to the host', async ({ page }) => {
    const { host } = await openVault(page);
    await expect.poll(() => host.globalCapture.registered()).toBe('Control+Alt+KeyN');
  });

  test('a press opens quick capture, focused, and the line lands in the Inbox', async ({
    page,
  }) => {
    const { vault, host } = await openVault(page);
    // The window has settled on the vault, and the shortcut is the host's, before
    // capture is said not to be open yet.
    await expect(page.getByRole('treeitem', { name: 'Garden' })).toBeVisible();
    await expect.poll(() => host.globalCapture.registered()).toBe('Control+Alt+KeyN');
    await expect(page.getByRole('dialog', { name: 'Capture a task' })).toHaveCount(0);

    await host.globalCapture.press();

    const field = page.getByRole('textbox', { name: 'What needs doing' });
    await expect(field).toBeFocused();
    await field.fill('Order more seed trays');
    await field.press('Enter');
    await expect.poll(() => vault.exists('Inbox/Order more seed trays.md')).toBe(true);
  });

  test('a press with no vault open says one is needed, and opens nothing', async ({ page }) => {
    const vault = await createVault();
    const host = await installHost(page, vault);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Open a vault' })).toBeVisible();
    await expect.poll(() => host.globalCapture.registered()).not.toBeNull();

    await host.globalCapture.press();

    await expect(page.getByRole('alert')).toHaveText(
      'Quick capture needs a vault: open one, and what you capture lands in its Inbox.',
    );
    await expect(page.getByRole('dialog', { name: 'Capture a task' })).toHaveCount(0);
  });

  test('Settings records a new shortcut from the keys pressed, and the host registers it', async ({
    page,
  }) => {
    const { host } = await openVault(page);
    await page.keyboard.press('ControlOrMeta+Comma');
    const card = page.getByRole('region', { name: 'Quick capture from anywhere' });
    await expect(card).toContainText('⌃⌥N');

    await card.getByRole('button', { name: 'Change…' }).click();
    await page.keyboard.press('Alt+ControlOrMeta+KeyJ');

    await expect.poll(() => host.globalCapture.registered()).toBe('Alt+Super+KeyJ');
    await expect(card).toContainText('⌥⌘J');
    // Recording took the keys: Settings is still up.
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();

    await card.getByRole('button', { name: 'Turn off' }).click();
    await expect.poll(() => host.globalCapture.registered()).toBeNull();
    await expect(card).toContainText('Off');
  });
});
