import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { expect, test, type Page } from './fixtures.ts';
import { signInOnTheWeb, webVaultOnGitHub } from './web-github.ts';
import { GARDEN_VAULT, PLAN } from './web-vault.ts';

/**
 * #774: on the web, Export hands the note over as a download — its `.md`
 * file alone, or a `.zip` with its pictures in `attachments/` — and offers
 * only the Markdown formats, PDF and Google Doc being the desktop's. Run in
 * the test's own ephemeral context (not `webTest`), so nothing is kept on
 * disk; the index lives in memory for the visit (#761).
 */

const SKETCH = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>';

const VAULT = {
  ...GARDEN_VAULT,
  'Bed layout.md': '# Bed layout\n\n![Sketch](sketch.svg)\n',
  'sketch.svg': SKETCH,
};

/** The note `name`, opened from the tree, and its Export dialog asked for from its menu. */
async function exportDialogFor(page: Page, name: string) {
  await page.getByRole('treeitem', { name, exact: true }).tap();
  await expect(page.getByRole('heading', { name }).first()).toBeVisible();
  await page.getByRole('button', { name: 'More' }).first().tap();
  await page.getByRole('menuitem', { name: /^Export…$/ }).tap();
  return page.getByRole('dialog', { name: `Export ${name}` });
}

/**
 * The name each download link the page clicks gives its file. WebKit on
 * Linux hands Playwright that name with its spaces made underscores
 * ("Garden_plan.md"), so what the page asked for is read from the link.
 */
const recordDownloadNames = (page: Page) =>
  page.addInitScript(() => {
    const named: string[] = [];
    Object.assign(window, { dfaiDownloadNames: named });
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.download !== '') named.push(this.download);
      click.call(this);
    };
  });

/** The name the page gave the download, and its bytes, for the dialog's Export…. */
async function downloadFrom(page: Page, dialog: ReturnType<Page['getByRole']>) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Export…' }).tap(),
  ]);
  const path = await download.path();
  const names = await page.evaluate(
    () => (window as unknown as { dfaiDownloadNames: string[] }).dfaiDownloadNames,
  );
  // The browser's own name for it, spaces aside, is the same.
  expect(download.suggestedFilename().replaceAll('_', ' ')).toBe(names.at(-1));
  return { name: names.at(-1), bytes: await readFile(path) };
}

test('on the web, Export downloads a note as its .md file, or a zip with its pictures', async ({
  page,
}) => {
  await recordDownloadNames(page);
  await webVaultOnGitHub(page, VAULT);
  await signInOnTheWeb(page);

  await test.step('the dialog offers the Markdown formats and nothing the desktop makes', async () => {
    const dialog = await exportDialogFor(page, 'Garden plan');
    await expect(dialog.getByRole('radio')).toHaveCount(2);
    await expect(dialog.getByRole('radio', { name: /^Markdown, as is/ })).toBeVisible();
    await expect(dialog.getByRole('radio', { name: /^Markdown, standalone/ })).toBeVisible();
    await expect(dialog.getByRole('radio', { name: /PDF|Google Doc/ })).toHaveCount(0);
  });

  await test.step('a note with no pictures downloads as its own .md file, as it is', async () => {
    const dialog = page.getByRole('dialog', { name: 'Export Garden plan' });
    await dialog.getByRole('radio', { name: /^Markdown, as is/ }).check();
    const file = await downloadFrom(page, dialog);
    expect(file.name).toBe('Garden plan.md');
    expect(file.bytes.toString('utf8')).toBe(PLAN);
    await expect(page.getByText('Exported 1 note as Markdown to Garden plan.md.')).toBeVisible();
  });

  await test.step('a note with a picture downloads as a zip, the picture in attachments/', async () => {
    const dialog = await exportDialogFor(page, 'Bed layout');
    await dialog.getByRole('radio', { name: /^Markdown, standalone/ }).check();
    const file = await downloadFrom(page, dialog);
    expect(file.name).toBe('Bed layout.zip');
    const inside = unzipSync(new Uint8Array(file.bytes));
    expect(Object.keys(inside).sort()).toEqual(['Bed layout.md', 'attachments/sketch.svg']);
    // Standalone, the note's link leads to the copy inside the zip.
    expect(new TextDecoder().decode(inside['Bed layout.md'])).toContain(
      '![Sketch](attachments/sketch.svg)',
    );
    expect(new TextDecoder().decode(inside['attachments/sketch.svg'])).toBe(SKETCH);
  });
});
