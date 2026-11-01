import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  emitVaultChanged,
  expectFile,
  installHost,
  sidebarSection,
  splitWindow,
  type FakeVault,
} from './host.ts';
import { caretAtLineEnd } from './caret.ts';

/**
 * Attack on PR #705 (#658): under 944px the sidebar is a drawer and one pane
 * shows, the others kept mounted but hidden. These try to lose typing in a
 * hidden pane, misdirect an action into one, or strand the person with no way
 * back to the sidebar. `test.fail` marks a finding: the test states what
 * should hold and currently does not.
 */

const IPAD_PORTRAIT = { width: 820, height: 1180 };
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

const TODAY = ['# Today', '', 'First paragraph with [[Another Note]].', ''].join('\n');
const ANOTHER = ['# Another Note', '', 'The target.', ''].join('\n');

async function openVault(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('Notes');
  await vault.write('Notes/today.md', TODAY);
  await vault.write('Notes/Another Note.md', ANOTHER);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

const drawer = (page: Page) => page.getByRole('dialog', { name: 'Vault' });
const sidebarNav = (page: Page) => page.getByRole('navigation', { name: 'Vault' });
const showSidebar = (page: Page) => page.getByRole('button', { name: 'Show sidebar' });
const pane = (page: Page, which: 1 | 2) => page.getByRole('region', { name: `Pane ${which}` });
const row = (page: Page, name: string) =>
  sidebarSection(page, 'userSpace').getByRole('treeitem', { name, exact: true });

/**
 * On a desktop window: today in pane 1, Another Note in pane 2 with
 * " Typed in B." typed at the end of its body. The focus is left in pane 2.
 */
async function splitWithTypingInB(page: Page): Promise<FakeVault> {
  await page.setViewportSize(DESKTOP);
  const vault = await openVault(page);
  await sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Notes' }).click();
  await row(page, 'today').click();
  await expect(pane(page, 1).getByRole('article', { name: 'today' })).toBeVisible();
  await splitWindow(page);
  await expect(pane(page, 2)).toBeVisible();
  await pane(page, 2).click();
  await row(page, 'Another Note').click();
  await expect(pane(page, 2).getByRole('article', { name: 'Another Note' })).toBeVisible();
  await caretAtLineEnd(pane(page, 2).getByText('The target.'));
  await page.keyboard.type(' Typed in B.');
  await expect(pane(page, 2).getByText('The target. Typed in B.')).toBeVisible();
  return vault;
}

/** Pane 1 takes the focus, then the window goes narrow: pane 2 is hidden. */
async function focusAThenNarrow(page: Page): Promise<void> {
  await pane(page, 1).getByText('First paragraph').click();
  await page.setViewportSize(IPAD_PORTRAIT);
  await expect(pane(page, 1)).toBeVisible();
  await expect(page.locator('section.pane[hidden]')).toHaveCount(1);
}

test.describe('a split folded to one pane', () => {
  test.fail(
    'the way to the sidebar is on screen when the pane left showing is the second one',
    async ({ page }) => {
      // Finding: `onShowSidebar` is handed to pane 0 only (note-pane-container.tsx:405,
      // page-tab.tsx:72). With pane 2 focused, pane 1 is the hidden one, and the
      // only "Show sidebar" button is inside it: a touch screen has no way in.
      await splitWithTypingInB(page);
      await page.setViewportSize(IPAD_PORTRAIT);
      await expect(pane(page, 2)).toBeVisible();
      await expect(pane(page, 1)).toBeHidden();
      await expect(showSidebar(page)).toBeVisible();
    },
  );

  test("the hidden pane's typing reaches the file while it is hidden", async ({ page }) => {
    const vault = await splitWithTypingInB(page);
    await focusAThenNarrow(page);
    await expectFile(vault, 'Notes/Another Note.md').toContain('The target. Typed in B.');
  });

  test("the same note opened in the shown pane carries the hidden pane's typing", async ({
    page,
  }) => {
    const vault = await splitWithTypingInB(page);
    await focusAThenNarrow(page);
    await showSidebar(page).first().click();
    await expect(drawer(page)).toBeVisible();
    await row(page, 'Another Note').click();
    await expect(drawer(page)).toHaveCount(0);
    await expect(pane(page, 1).getByText('The target. Typed in B.')).toBeVisible();
    await caretAtLineEnd(pane(page, 1).getByText('The target. Typed in B.'));
    await page.keyboard.type(' And in A.');
    await expectFile(vault, 'Notes/Another Note.md').toContain('The target. Typed in B. And in A.');
    await page.setViewportSize(DESKTOP);
    await expect(pane(page, 2).getByText('The target. Typed in B. And in A.')).toBeVisible();
  });

  test("⌘W on the shown pane's last tab brings the hidden pane back, typing whole", async ({
    page,
  }) => {
    const vault = await splitWithTypingInB(page);
    await focusAThenNarrow(page);
    await page.keyboard.press('Meta+w');
    await expect(pane(page, 1).getByText('The target. Typed in B.')).toBeVisible();
    await expect(page.locator('section.pane[hidden]')).toHaveCount(0);
    await expectFile(vault, 'Notes/Another Note.md').toContain('The target. Typed in B.');
  });

  test('an outside change to the hidden note shows when the window is wide again', async ({
    page,
  }) => {
    const vault = await splitWithTypingInB(page);
    await focusAThenNarrow(page);
    await expectFile(vault, 'Notes/Another Note.md').toContain('Typed in B.');
    await vault.write(
      'Notes/Another Note.md',
      ['# Another Note', '', 'The target. Typed in B.', '', 'From outside.', ''].join('\n'),
    );
    await emitVaultChanged(page, ['Notes/Another Note.md']);
    await page.setViewportSize(DESKTOP);
    await expect(pane(page, 2).getByText('From outside.')).toBeVisible();
    await expect(pane(page, 2).getByText('The target. Typed in B.')).toBeVisible();
  });

  test('a hidden pane is out of the accessibility tree', async ({ page }) => {
    await splitWithTypingInB(page);
    await focusAThenNarrow(page);
    await expect(pane(page, 2)).toHaveCount(0);
    await expect(page.getByRole('article', { name: 'Another Note' })).toHaveCount(0);
  });
});

test.describe('flapping across 944px', () => {
  test('typing between resizes lands in the editor, in order', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const vault = await openVault(page);
    await sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Notes' }).click();
    await row(page, 'today').click();
    await caretAtLineEnd(pane(page, 1).getByText('First paragraph'));
    for (let step = 0; step < 6; step += 1) {
      await page.setViewportSize(step % 2 === 0 ? IPAD_PORTRAIT : DESKTOP);
      await page.keyboard.type(` s${step}`);
    }
    await expectFile(vault, 'Notes/today.md').toContain(
      'First paragraph with [[Another Note]]. s0 s1 s2 s3 s4 s5',
    );
  });

  test.fail(
    'a drawer left open on a narrow window does not reopen over typing after a trip wide',
    async ({ page }) => {
      // Finding: `drawerOpen` is not reset when the window goes wide (app.tsx
      // ~1005). Open the drawer, widen, type in the editor, narrow again: the
      // drawer comes back unasked, modal over the note being typed in. (In
      // this run the keystrokes that followed still reached the note.)
      await page.setViewportSize(IPAD_PORTRAIT);
      const vault = await openVault(page);
      await showSidebar(page).click();
      await sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Notes' }).click();
      await row(page, 'today').click();
      await expect(drawer(page)).toHaveCount(0);
      await showSidebar(page).click();
      await expect(drawer(page)).toBeVisible();

      await page.setViewportSize(DESKTOP);
      await expect(sidebarNav(page)).toBeVisible();
      await caretAtLineEnd(pane(page, 1).getByText('First paragraph'));
      await page.keyboard.type(' wide');
      await page.setViewportSize(IPAD_PORTRAIT);
      await page.keyboard.type(' narrow');
      await expect(drawer(page)).toHaveCount(0);
      await expectFile(vault, 'Notes/today.md').toContain(
        'First paragraph with [[Another Note]]. wide narrow',
      );
    },
  );
});

test.describe('the drawer', () => {
  test.use({ viewport: IPAD_PORTRAIT, hasTouch: true });

  test('a tap on the scrim closes it', async ({ page }) => {
    await openVault(page);
    await showSidebar(page).tap();
    await expect(drawer(page)).toBeVisible();
    await page.touchscreen.tap(IPAD_PORTRAIT.width - 20, IPAD_PORTRAIT.height / 2);
    await expect(drawer(page)).toHaveCount(0);
  });

  test('navigating from it keeps the typing in the note left behind', async ({ page }) => {
    const vault = await openVault(page);
    await showSidebar(page).click();
    await sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Notes' }).click();
    await row(page, 'today').click();
    await caretAtLineEnd(pane(page, 1).getByText('First paragraph'));
    await page.keyboard.type(' Left behind.');
    await showSidebar(page).click();
    await row(page, 'Another Note').click();
    await expect(pane(page, 1).getByRole('article', { name: 'Another Note' })).toBeVisible();
    await expectFile(vault, 'Notes/today.md').toContain('[[Another Note]]. Left behind.');
  });

  test('⌘\\ from the editor, then Escape: the focus goes back and typing carries on', async ({
    page,
  }) => {
    const vault = await openVault(page);
    await showSidebar(page).click();
    await sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Notes' }).click();
    await row(page, 'today').click();
    await caretAtLineEnd(pane(page, 1).getByText('First paragraph'));
    await page.keyboard.type(' one');
    await page.keyboard.press('Meta+\\');
    await expect(drawer(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);
    await page.keyboard.type(' two');
    await expectFile(vault, 'Notes/today.md').toContain('[[Another Note]]. one two');
  });

  test('⌘\\ with the palette up does not open the drawer under it', async ({ page }) => {
    await openVault(page);
    await page.keyboard.press('Meta+k');
    const palette = page.getByRole('dialog').filter({ hasNot: page.locator('.shell__drawer') });
    await expect(palette).toHaveCount(1);
    await page.keyboard.press('Meta+\\');
    await expect(drawer(page)).toHaveCount(0);
  });
});

test.describe('one pane only', () => {
  test.use({ viewport: IPAD_PORTRAIT });

  test.fail('the peek does not offer "Open in split" where no split can show', async ({ page }) => {
    // Finding: peek-container.tsx:114 always passes onOpenInSplit; on a narrow
    // window openPlace turns it into a new tab, so the button says one thing
    // and does another.
    await openVault(page);
    await showSidebar(page).click();
    await sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Notes' }).click();
    await row(page, 'today').click();
    await pane(page, 1).getByText('Another Note', { exact: true }).click();
    const peek = page.getByRole('dialog', { name: 'Another Note' });
    await expect(peek).toBeVisible();
    await expect(peek.getByRole('button', { name: 'Open in new tab' })).toBeVisible();
    await expect(peek.getByRole('button', { name: 'Open in split' })).toHaveCount(0);
  });
});

test('a phone: the drawer and the page bar fit, nothing off screen', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openVault(page);
  await showSidebar(page).click();
  await sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Notes' }).click();
  await row(page, 'today').click();
  const offscreen = await page.evaluate((width) => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('button, [role="tab"]')) {
      const box = el.getBoundingClientRect();
      if (box.width === 0) continue;
      if (box.right > width + 0.5 || box.left < -0.5)
        out.push(el.getAttribute('aria-label') ?? el.textContent ?? '?');
    }
    return out;
  }, PHONE.width);
  expect(offscreen).toEqual([]);
});
