/**
 * Attack pass on PR #387 (UI v2 slice 8b, the right sidebar wired). Each
 * test names the invariant it holds; the failing ones are the bugs found.
 * Fictional names only.
 */
import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  emitVaultChanged,
  expectFile,
  installHost,
  sidebarSection,
  splitWindow,
  type FakeHost,
  type FakeVault,
} from './host.ts';

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  owner: text',
  '  status:',
  '    kind: select',
  '    options: [next, done]',
  '---',
  '',
].join('\n');

const task = (title: string, owner: string) =>
  ['---', 'type: task', `owner: ${owner}`, 'status: next', '---', '', `# ${title}`, ''].join('\n');

async function openVault(
  page: Page,
  { width = 1440 }: { width?: number } = {},
): Promise<{ vault: FakeVault; host: FakeHost }> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('Ship it.md', task('Ship it', 'Mara Quill'));
  await vault.write('Plan.md', task('Plan', 'Tobias Fenn'));
  const host = await installHost(page, vault);
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

const aside = (page: Page) => page.getByRole('complementary', { name: 'Right sidebar' });
const toggle = (page: Page) =>
  page.getByRole('button', { name: 'Right sidebar', exact: true }).first();
const chat = (page: Page) => page.getByRole('complementary', { name: 'Claude' });
const pane = (page: Page, which: 1 | 2) => page.getByRole('region', { name: `Pane ${which}` });

async function openNote(page: Page, name: string) {
  await sidebarSection(page, 'userSpace').getByRole('treeitem', { name, exact: true }).click();
  await expect(page.getByRole('article', { name }).first()).toBeVisible();
}

const altCmdBackslash = async (page: Page) => {
  await page.keyboard.down('Meta');
  await page.keyboard.down('Alt');
  await page.keyboard.press('Backslash');
  await page.keyboard.up('Alt');
  await page.keyboard.up('Meta');
};

test.describe('narrow windows (attack #387)', () => {
  test('⇧⌘J in a 1000px window puts Claude on screen, as it did before the chat moved into the aside', async ({
    page,
  }) => {
    await openVault(page, { width: 1000 });
    await openNote(page, 'Ship it');
    await page.keyboard.press('Meta+Shift+KeyJ');
    await expect(chat(page)).toBeVisible();
  });

  test('the bar’s unpressed Right sidebar button, clicked in a 1000px window, puts the aside on screen', async ({
    page,
  }) => {
    await openVault(page, { width: 1000 });
    await openNote(page, 'Ship it');
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    await toggle(page).click();
    // The button says what is on screen: a click on it must change that.
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  });

  test('guard: at the window’s 720px minimum with the aside open, nothing overflows sideways and the left sidebar stays', async ({
    page,
  }) => {
    await openVault(page);
    await openNote(page, 'Ship it');
    await toggle(page).click();
    await expect(aside(page)).toBeVisible();
    for (const width of [1100, 1019, 1020, 900, 720]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(page.getByRole('navigation', { name: 'Vault' })).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
        .toBeLessThanOrEqual(0);
    }
  });
});

test.describe('wrong subject (attack #387)', () => {
  test('in a split window, the pane the aside is not following still shows its note’s properties somewhere', async ({
    page,
  }) => {
    await openVault(page);
    await openNote(page, 'Ship it');
    await splitWindow(page);
    await expect(pane(page, 2)).toBeVisible();
    await openNote(page, 'Plan');
    await expect(pane(page, 2).getByRole('article', { name: 'Plan' })).toBeVisible();
    const shipItsProperties = pane(page, 1)
      .getByRole('article', { name: 'Ship it' })
      .getByRole('region', { name: 'Properties' });
    // The locator matches while the aside is shut.
    await expect(shipItsProperties).toBeVisible();

    // By the keys, so the focus stays in pane 2: a click on pane 1's button would focus pane 1.
    await altCmdBackslash(page);
    await expect(aside(page).getByRole('heading', { name: 'Plan' })).toBeVisible();
    // Ship it in pane 1: the aside is on Plan, so Ship it's properties must stay in its body.
    await expect(shipItsProperties).toBeVisible();
  });

  test('guard: a property changed on disk under the shown note reaches the aside', async ({
    page,
  }) => {
    const { vault } = await openVault(page);
    await openNote(page, 'Ship it');
    await toggle(page).click();
    const owner = aside(page).getByRole('textbox', { name: 'Owner' });
    await expect(owner).toHaveValue('Mara Quill');
    await vault.write('Ship it.md', task('Ship it', 'Tobias Fenn'));
    await emitVaultChanged(page, ['Ship it.md']);
    await expect(owner).toHaveValue('Tobias Fenn');
  });

  test('guard: ⌥⌘\\ in the editor toggles the aside and types nothing into the note', async ({
    page,
  }) => {
    const { vault } = await openVault(page);
    await openNote(page, 'Ship it');
    await page.getByRole('article', { name: 'Ship it' }).getByText('Ship it').first().click();
    await altCmdBackslash(page);
    await expect(aside(page)).toBeVisible();
    await altCmdBackslash(page);
    await expect(aside(page)).toHaveCount(0);
    expect(await vault.read('Ship it.md')).not.toContain('«');
  });
});

test.describe('lost property edits (attack #387)', () => {
  // The row's writes are one at a time and coalesced (row-aside.tsx), so the
  // last key always lands; the deterministic proof is aside-container.attack-387.test.tsx.
  test('a focused row’s property typed key by key reaches the file whole', async ({ page }) => {
    const { vault } = await openVault(page);
    await sidebarSection(page, 'types')
      .getByRole('button', { name: /^Task, / })
      .click();
    const table = page.getByRole('article', { name: 'Task', exact: true });
    await expect(table.getByRole('button', { name: 'Plan' })).toBeVisible();
    await toggle(page).click();
    await table.getByRole('button', { name: 'Tobias Fenn' }).focus();
    const owner = aside(page).getByRole('textbox', { name: 'Owner' });
    await expect(owner).toHaveValue('Tobias Fenn');

    // Typed as a person types, a key at a time: each key is its own write today,
    // and those after the first are refused by the file's stamp and dropped.
    const typed = 'Mara Quill of Larkspur Payroll, Operations';
    await owner.fill('');
    await owner.pressSequentially(typed);
    await owner.press('Enter');
    await expectFile(vault, 'Plan.md').toMatch(new RegExp(`\\nowner: "?${typed}"?\\n`));
  });

  test('guard: a note’s property typed in the aside and the aside shut at once is in the file', async ({
    page,
  }) => {
    const { vault } = await openVault(page);
    await openNote(page, 'Ship it');
    await toggle(page).click();
    const owner = aside(page).getByRole('textbox', { name: 'Owner' });
    await owner.fill('Tobias Fenn');
    await altCmdBackslash(page);
    await expect(aside(page)).toHaveCount(0);
    await expectFile(vault, 'Ship it.md').toMatch(/\nowner: Tobias Fenn\n/);
  });
});

test.describe('the Claude tab (attack #387)', () => {
  test('guard: an answer started, then the aside shut mid-turn, is there when it reopens', async ({
    page,
  }) => {
    const { host } = await openVault(page);
    await openNote(page, 'Ship it');
    host.claude.reply(
      'Let me read it.<atlas_tool>{"name":"atlas_read_note","input":{"path":"Ship it.md"}}</atlas_tool>',
      'Ship it is owned by Mara Quill.',
    );
    await page.keyboard.press('Meta+Shift+KeyJ');
    const box = chat(page).getByRole('textbox', { name: 'Ask Claude' });
    await box.fill('Who owns this?');
    await box.press('Enter');
    await page.keyboard.press('Meta+Shift+KeyJ');
    await expect(aside(page)).toHaveCount(0);
    await host.claude.delivered();

    await page.keyboard.press('Meta+Shift+KeyJ');
    await expect(chat(page).getByText('Who owns this?')).toBeVisible();
    await expect(chat(page).getByText('Ship it is owned by Mara Quill.')).toBeVisible();
  });

  test('guard: switching to Properties mid-turn and back keeps the turn', async ({ page }) => {
    const { host } = await openVault(page);
    await openNote(page, 'Ship it');
    host.claude.reply('Plan comes first.');
    await page.keyboard.press('Meta+Shift+KeyJ');
    const box = chat(page).getByRole('textbox', { name: 'Ask Claude' });
    await box.fill('What first?');
    await box.press('Enter');
    await aside(page).getByRole('tab', { name: 'Properties' }).click();
    await expect(chat(page)).toHaveCount(0);
    await aside(page).getByRole('tab', { name: 'Claude' }).click();
    await expect(chat(page).getByText('Plan comes first.')).toBeVisible();
  });
});

test.describe('remembered state (attack #387)', () => {
  test('guard: a malformed remembered value opens shut, and the app still works', async ({
    page,
  }) => {
    await openVault(page);
    await openNote(page, 'Ship it');
    await page.evaluate(() => {
      for (let at = 0; at < window.localStorage.length; at += 1) {
        const key = window.localStorage.key(at);
        if (key?.startsWith('atlas.aside:') === true) window.localStorage.removeItem(key);
      }
    });
    await toggle(page).click();
    await expect(aside(page)).toBeVisible();
    await page.evaluate(() => {
      for (let at = 0; at < window.localStorage.length; at += 1) {
        const key = window.localStorage.key(at);
        if (key?.startsWith('atlas.aside:') === true)
          window.localStorage.setItem(key, '{"open":"yes","tab":"claude"');
      }
    });
    await page.reload();
    await expect(page.getByText(/notes indexed/)).toBeVisible();
    await expect(aside(page)).toHaveCount(0);
    await toggle(page).click();
    await expect(aside(page)).toBeVisible();
  });

  test('guard: storage that refuses writes leaves the toggle working for the session', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const real = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key.startsWith('atlas.aside:')) throw new DOMException('quota', 'QuotaExceededError');
        real.call(this, key, value);
      };
    });
    await openVault(page);
    await openNote(page, 'Ship it');
    await toggle(page).click();
    await expect(aside(page)).toBeVisible();
    await altCmdBackslash(page);
    await expect(aside(page)).toHaveCount(0);
  });
});
