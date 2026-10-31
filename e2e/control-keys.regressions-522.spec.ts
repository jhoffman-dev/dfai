import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection, type FakeVault } from './host.ts';
import { caretAtLineEnd } from './caret.ts';
import { lanternFixturePdf } from '../tools/pdf/fixture-pdf.ts';

/*
 * Regressions for PR #522 (#506): keys pressed on a link drawn inside an
 * embed — its name, a transcluded highlight's chip — are the link's, and none
 * leaves the note or edits it. The embed is a React node view, whose
 * stopEvent hands every key inside it past ProseMirror, so a plugin's
 * handleDOMEvents never sees them: Backspace there sent WebKit Back (the app
 * unloaded to the page before), and ⌘Z there was WebKit's own undo, which
 * moved the page's selection into the text, so Backspace then joined the
 * heading to the next line, and that was saved.
 */

const PDF = 'Library/the-lantern-keepers.pdf';

const marker = `<!-- atlas:highlight ${JSON.stringify({
  v: 1,
  mark: 'highlight',
  color: 'yellow',
  kind: 'pdf',
  page: 3,
  exact: 'The last lamp was lit',
  prefix: 'Chapter Three. ',
  suffix: ' in the year',
  rects: [[0.2, 0.1, 0.3, 0.02]],
})} -->`;

const JOURNAL = '# Journal\n\nToday.\n\n![[Plans#^plan01]]\n\n![[The Lantern Keepers#^lamp03]]\n';

const FILES: Record<string, string | Buffer> = {
  [PDF]: lanternFixturePdf(),
  'Library/The Lantern Keepers.md':
    `---\ntype: literature\nkind: pdf\ntitle: "The Lantern Keepers"\nfile: "[[${PDF}]]"\n---\n` +
    `> The last lamp was lit\n> ${marker}\n\n^lamp03\n`,
  'Plans.md': '# Plans\n\nThe summer, roughly. ^plan01\n',
  'Journal.md': JOURNAL,
};

/** Where the page notes whether WebKit's own answer to the last Backspace was prevented. */
const LAST_BACKSPACE = '__lastBackspacePrevented';

/** Journal open, with a page behind it in history for Back to go to. */
async function openJournal(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  for (const [path, contents] of Object.entries(FILES)) {
    await mkdir(join(vault.root, path, '..'), { recursive: true });
    await writeFile(join(vault.root, path), contents);
  }
  await installHost(page, vault);
  await page.goto('/?before');
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Journal', exact: true })
    .click();
  await expect(page.getByRole('article', { name: 'Journal' })).toBeVisible();
  // Last in the bubble, after the editor and React have had the key.
  await page.evaluate((key) => {
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Backspace') Object.assign(window, { [key]: event.defaultPrevented });
    });
  }, LAST_BACKSPACE);
  return vault;
}

const embedName = (page: Page) => page.locator('.block-embed__name', { hasText: 'Plans' });
const highlightChip = (page: Page) =>
  page.getByRole('link', { name: 'Open The Lantern Keepers, p. 3 in the reader' });

/**
 * Backspace left to WebKit on a control goes Back: the app unloads to the
 * page before. Read as whether its default was prevented, which is decided
 * while the key is dispatched, rather than as a navigation that may or may
 * not have begun by the time the test looks. A page already gone Back has
 * no answer, and fails too.
 */
async function expectBackspaceKeptFromWebKit(page: Page) {
  expect(
    await page.evaluate(
      (key) => (window as unknown as Record<string, unknown>)[key],
      LAST_BACKSPACE,
    ),
  ).toBe(true);
  await expect(page.getByRole('article', { name: 'Journal' })).toBeVisible();
}

async function focusOn(control: Locator) {
  await expect(control).toBeVisible();
  await control.focus();
  await expect(control).toBeFocused();
}

test("Backspace on an embed's focused name does not send the app Back", async ({ page }) => {
  await openJournal(page);
  await focusOn(embedName(page));
  await page.keyboard.press('Backspace');
  await expectBackspaceKeptFromWebKit(page);
});

test("Backspace on a transcluded highlight's focused chip does not send the app Back", async ({
  page,
}) => {
  await openJournal(page);
  await focusOn(highlightChip(page));
  await page.keyboard.press('Backspace');
  await expectBackspaceKeptFromWebKit(page);
});

test("⌘Z then Backspace on an embed's focused name leave the note's heading as it is", async ({
  page,
}) => {
  const vault = await openJournal(page);
  await caretAtLineEnd(page.getByLabel('Note', { exact: true }).getByText('Today.'));
  await page.keyboard.type(' More.');
  await expectFile(vault, 'Journal.md').toContain('Today. More.');
  await focusOn(embedName(page));
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Backspace');
  // The heading's text changes the moment a key edits it; on disk it follows with the autosave.
  const heading = page.getByLabel('Note', { exact: true }).getByRole('heading', { level: 1 });
  await expect(heading).toHaveText('Journal');
});
