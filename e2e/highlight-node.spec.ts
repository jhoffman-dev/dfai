import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import { caretAtLineEnd } from './caret.ts';
import {
  createVault,
  expectFile,
  installHost,
  saveNow,
  sidebarSection,
  type FakeVault,
} from './host.ts';

/*
 * A highlight in DFAI's editor (#523), end to end in WebKit: a literature
 * note shows each highlight as its quote, in its mark's colour, with the
 * comment under it to type in — the marker and a removed highlight's
 * tombstone never shown. A comment typed in place is written by the note's
 * own write, which changes only the comment's bytes, Windows line endings
 * kept; typing elsewhere in the note leaves every highlight's bytes as they
 * were; and an embed of the highlight shows the same quote, read-only.
 */

const marker = (anchor: Record<string, unknown>) =>
  `<!-- atlas:highlight ${JSON.stringify({ v: 1, mark: 'underline', color: 'pink', ...anchor })} -->`;

const TOMBSTONE =
  '<!-- atlas:highlight-removed {"v":1,"kind":"kindle","location":9,"annotationId":"A9","words":"3f2a"} -->';

const BRIGHTWATER = [
  '---',
  'type: literature',
  'kind: kindle',
  'title: "Brightwater"',
  'author: "Tobias Fenn"',
  '---',
  'My own paragraph.',
  '',
  '> The tide keeps its own hours.',
  `> ${marker({ kind: 'kindle', location: 41, locationEnd: 44 })}`,
  '>',
  '> Like [[Larkspur Payroll]]: 50%\\% sure.',
  '',
  '^kd0041',
  '',
  TOMBSTONE,
  '',
  '> Gulls argue over nothing.',
  `> ${marker({ kind: 'kindle', location: 60 })}`,
  '',
  '^kd0060',
  '',
].join('\r\n');

const READING = '# Reading notes\n\n![[Brightwater#^kd0041]]\n';

async function openVault(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  const files = { 'Library/Brightwater.md': BRIGHTWATER, 'Reading notes.md': READING };
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(vault.root, path, '..'), { recursive: true });
    await writeFile(join(vault.root, path), contents);
  }
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  return vault;
}

async function openBrightwater(page: Page) {
  await sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Library' }).click();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Brightwater', exact: true })
    .click();
  const note = page.getByRole('article', { name: 'Brightwater' });
  await expect(note).toBeVisible();
  return note;
}

const comments = (page: Page) => page.getByRole('textbox', { name: 'Comment on this highlight' });

test('a literature note shows its highlights as quotes with comments, never the marker', async ({
  page,
}) => {
  await openVault(page);
  const note = await openBrightwater(page);
  const editor = note.getByLabel('Note', { exact: true });
  const tide = editor.locator('[data-highlight-block="kd0041"]');
  await expect(tide.locator('blockquote')).toHaveText('The tide keeps its own hours.');
  await expect(tide.locator('.highlight-quote')).toHaveAttribute('data-mark', 'underline');
  await expect(tide.locator('.highlight-quote')).toHaveAttribute('data-color', 'pink');
  await expect(comments(page)).toHaveCount(2);
  await expect(comments(page).first()).toHaveValue('Like [[Larkspur Payroll]]: 50%\\% sure.');
  await expect(editor.locator('[data-highlight-block="kd0060"] blockquote')).toHaveText(
    'Gulls argue over nothing.',
  );
  await expect(editor).toContainText('My own paragraph.');
  // What a person sees: the hidden tombstone's text is in the page, but not shown.
  await expect(editor).not.toContainText('atlas:highlight', { useInnerText: true });
  // The tombstone is in the note, and hidden.
  await expect(editor.locator('pre.raw-block--hidden')).toHaveCount(1);
  await expect(editor.locator('pre.raw-block--hidden')).toBeHidden();
});

test("a comment typed in place changes only the comment's bytes", async ({ page }) => {
  const vault = await openVault(page);
  await openBrightwater(page);
  const comment = comments(page).first();
  await comment.click();
  await comment.fill('Like [[Larkspur Payroll]].\nA second thought.');
  await page.keyboard.press('Meta+Enter');
  await expectFile(vault, 'Library/Brightwater.md').toBe(
    BRIGHTWATER.replace(
      '> Like [[Larkspur Payroll]]: 50%\\% sure.',
      '> Like [[Larkspur Payroll]].\r\n> A second thought.',
    ),
  );
  // The note is read again, and the field shows what was written.
  await expect(comments(page).first()).toHaveValue('Like [[Larkspur Payroll]].\nA second thought.');

  // A comment added to a highlight that had none, by leaving the field.
  const gulls = comments(page).nth(1);
  await gulls.click();
  await gulls.fill('Every morning.');
  await page.keyboard.press('Tab');
  await expectFile(vault, 'Library/Brightwater.md').toContain(
    `> Gulls argue over nothing.\r\n> ${marker({ kind: 'kindle', location: 60 })}\r\n>\r\n> Every morning.\r\n\r\n^kd0060\r\n`,
  );
});

test("typing elsewhere in the note keeps every highlight's bytes", async ({ page }) => {
  const vault = await openVault(page);
  const note = await openBrightwater(page);
  await caretAtLineEnd(note.getByLabel('Note', { exact: true }).getByText('My own paragraph.'));
  await page.keyboard.type(' Edited.');
  await saveNow(page);
  await expectFile(vault, 'Library/Brightwater.md').toBe(
    BRIGHTWATER.replace('My own paragraph.', 'My own paragraph. Edited.'),
  );
});

test('an embed of a highlight shows its quote and comment, read-only, under its chip', async ({
  page,
}) => {
  await openVault(page);
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Reading notes', exact: true })
    .click();
  const embed = page.getByRole('group', { name: 'Embedded block from Brightwater' });
  await expect(embed.locator('blockquote')).toHaveText('The tide keeps its own hours.');
  await expect(embed).toContainText('Like [[Larkspur Payroll]]: 50%\\% sure.');
  await expect(embed).not.toContainText('atlas:highlight');
  await expect(embed.locator('textarea')).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Open Brightwater, loc. 41 in its note' }),
  ).toBeVisible();
});
