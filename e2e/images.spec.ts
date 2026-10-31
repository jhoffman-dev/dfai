import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  expectFile,
  expectSaved,
  installHost,
  saveNow,
  sidebarSection,
  type FakeVault,
} from './host.ts';
import { caretAtLineEnd } from './caret.ts';

/**
 * A real PNG, `width` by `height`, drawn as a soft diagonal gradient, so the
 * webview decodes it and a screenshot shows something. Built by hand because
 * the suite has no image library, and a PNG is only a few chunks.
 */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      const t = (x / width + y / height) / 2;
      rows.set([Math.round(36 + 150 * t), Math.round(104 + 110 * t), Math.round(216 + 22 * t)], at);
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PICTURE = png(360, 200);

async function openVault(page: Page, notes: Record<string, string>): Promise<FakeVault> {
  const vault = await createVault();
  for (const [path, text] of Object.entries(notes)) {
    const folder = path.split('/').slice(0, -1).join('/');
    if (folder !== '') await vault.mkdir(folder);
    await vault.write(path, text);
  }
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  return vault;
}

async function openNote(page: Page, name: string) {
  await page.getByRole('treeitem', { name, exact: true }).click();
  await expect(page.getByRole('article', { name })).toBeVisible();
}

/** Clicks at the end of `text`, then onto a fresh line after it. */
async function newLineAfter(page: Page, text: string) {
  await caretAtLineEnd(page.getByText(text));
  await page.keyboard.press('Enter');
}

/** The names in a vault folder, or none when it is not there. */
const filesIn = (vault: FakeVault, folder: string) =>
  readdir(join(vault.root, folder)).catch(() => [] as string[]);

/**
 * Pastes `bytes` into the editor as a clipboard carrying one file — what a
 * screenshot on the clipboard is to a webview.
 */
async function pasteFile(page: Page, { bytes, name }: { bytes: Buffer; name: string }) {
  await page.locator('.editor').evaluate(
    (editor, { data, fileName }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(data)], fileName, { type: 'image/png' }));
      const event = new ClipboardEvent('paste', {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(event);
    },
    { data: [...bytes], fileName: name },
  );
}

/** Drops files onto the editor at the end of `target`, dragging over it first. */
async function dropFiles(
  page: Page,
  { bytes, names, target }: { bytes: Buffer; names: string[]; target: string },
) {
  const box = await page.getByText(target).boundingBox();
  if (box === null) throw new Error(`${target} is not on screen`);
  await page.locator('.editor').evaluate(
    (editor, { data, fileNames, x, y }) => {
      const transfer = new DataTransfer();
      for (const fileName of fileNames) {
        transfer.items.add(new File([new Uint8Array(data)], fileName, { type: 'image/png' }));
      }
      const init = {
        dataTransfer: transfer,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
      };
      const over = new DragEvent('dragover', init);
      editor.dispatchEvent(over);
      // The note must have taken the drag over, or the window refuses the drop.
      if (!over.defaultPrevented) throw new Error('the editor did not take the drag');
      editor.dispatchEvent(new DragEvent('drop', init));
    },
    { data: [...bytes], fileNames: names, x: box.x + box.width, y: box.y + box.height / 2 },
  );
}

/** An image in the note that the webview has actually decoded, not a broken one. */
async function expectDrawnImage(page: Page, count = 1) {
  const images = page.locator('.editor img.image__img');
  await expect(images).toHaveCount(count);
  for (let at = 0; at < count; at += 1) {
    await expect(images.nth(at)).toBeVisible();
    await expect
      .poll(() => images.nth(at).evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(360);
  }
}

test('a pasted screenshot is saved in attachments/ and written into the note as a markdown image', async ({
  page,
}) => {
  const vault = await openVault(page, { 'Work/plan.md': '# Plan\n\nThe first step.\n' });
  await page.getByRole('treeitem', { name: 'Work', exact: true }).click();
  await openNote(page, 'plan');
  await newLineAfter(page, 'The first step.');

  await pasteFile(page, { bytes: PICTURE, name: 'image.png' });

  await expectDrawnImage(page);
  const saved = await filesIn(vault, 'attachments');
  expect(saved).toHaveLength(1);
  const [name] = saved;
  expect(name).toMatch(/^Pasted image \d{14}\.png$/);
  expect(await readFile(join(vault.root, 'attachments', name!))).toEqual(PICTURE);

  await saveNow(page);
  await expectSaved(page);
  await expectFile(vault, 'Work/plan.md').toBe(
    `# Plan\n\nThe first step.\n\n![](../attachments/${encodeURIComponent(name!)})\n`,
  );
});

test('images dropped on the note are saved and go in where they were dropped, in order', async ({
  page,
}) => {
  const vault = await openVault(page, { 'trip.md': 'Before the photo.\n\nAfter the photo.\n' });
  await openNote(page, 'trip');

  await dropFiles(page, {
    bytes: PICTURE,
    names: ['Beach day.png', 'Dinner.png', 'Sunset.png'],
    target: 'Before the photo.',
  });

  await expectDrawnImage(page, 3);
  expect((await filesIn(vault, 'attachments')).sort()).toEqual([
    'Beach day.png',
    'Dinner.png',
    'Sunset.png',
  ]);
  await saveNow(page);
  await expectSaved(page);
  await expectFile(vault, 'trip.md').toBe(
    'Before the photo.![Beach day](attachments/Beach%20day.png)![Dinner](attachments/Dinner.png)![Sunset](attachments/Sunset.png)\n\nAfter the photo.\n',
  );
});

test('/image picks a file and puts it where /image was typed; the same name twice is numbered', async ({
  page,
}) => {
  const vault = await openVault(page, { 'log.md': 'Entry.\n' });
  await writeFile(join(vault.root, 'shot.png'), PICTURE);
  await vault.mkdir('attachments');
  await writeFile(join(vault.root, 'attachments', 'shot.png'), PICTURE);
  await openNote(page, 'log');
  await newLineAfter(page, 'Entry.');

  await page.keyboard.type('/image');
  const option = page
    .getByRole('listbox', { name: 'Insert block' })
    .getByRole('option', { name: /Image/ });
  await expect(option).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await (await chooser).setFiles({ name: 'shot.png', mimeType: 'image/png', buffer: PICTURE });

  await expectDrawnImage(page);
  expect((await filesIn(vault, 'attachments')).sort()).toEqual(['shot 2.png', 'shot.png']);
  await saveNow(page);
  await expectSaved(page);
  await expectFile(vault, 'log.md').toBe('Entry.\n\n![shot](attachments/shot%202.png)\n');
});

test('a file that is not really an image is refused where it was pasted, and nothing is saved', async ({
  page,
}) => {
  const vault = await openVault(page, { 'log.md': 'Entry.\n' });
  await openNote(page, 'log');
  await newLineAfter(page, 'Entry.');

  await pasteFile(page, { bytes: Buffer.from('not a png at all'), name: 'fake.png' });

  await expect(page.getByRole('alert')).toContainText('“fake.png” could not be read as an image.');
  await expect(page.locator('.editor img.image__img')).toHaveCount(0);
  expect(await filesIn(vault, 'attachments')).toEqual([]);
  await page.getByRole('alert').getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('with Images set to go beside the note, a paste lands in the note’s folder', async ({
  page,
}) => {
  const vault = await openVault(page, { 'Work/plan.md': 'Plan.\n' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('radio', { name: 'Beside the note' }).click();
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);

  await page.getByRole('treeitem', { name: 'Work', exact: true }).click();
  await openNote(page, 'plan');
  await newLineAfter(page, 'Plan.');
  await pasteFile(page, { bytes: PICTURE, name: 'Diagram.png' });

  await expectDrawnImage(page);
  expect(await filesIn(vault, 'attachments')).toEqual([]);
  expect((await filesIn(vault, 'Work')).sort()).toEqual(['Diagram.png', 'plan.md']);
  await saveNow(page);
  await expectFile(vault, 'Work/plan.md').toBe('Plan.\n\n![Diagram](Diagram.png)\n');
});

test('a note with images written elsewhere shows them, and saves them byte-identical', async ({
  page,
}) => {
  const lines = [
    '# Photos',
    '',
    '![](../attachments/Pasted%20image%2020230101093012.png)',
    '',
    '![A chart](<../attachments/my chart.png> "Q3")',
    '',
    '![[Pasted image 20230101093012.png]]',
    '',
    'Some text after.',
    '',
  ].join('\n');
  const vault = await openVault(page, { 'Trips/photos.md': lines });
  await vault.mkdir('attachments');
  await writeFile(join(vault.root, 'attachments', 'Pasted image 20230101093012.png'), PICTURE);
  await writeFile(join(vault.root, 'attachments', 'my chart.png'), PICTURE);

  await page.getByRole('treeitem', { name: 'Trips', exact: true }).click();
  await openNote(page, 'photos');
  await expectDrawnImage(page, 2);

  await caretAtLineEnd(page.getByText('Some text after.'));
  await page.keyboard.type(' Edited.');
  await saveNow(page);
  await expectSaved(page);
  await expectFile(vault, 'Trips/photos.md').toBe(
    lines.replace('Some text after.', 'Some text after. Edited.'),
  );
});

test('a selected image’s alt text is edited in place and written to the note', async ({ page }) => {
  const vault = await openVault(page, { 'n.md': 'Intro.\n\n![](attachments/a.png)\n' });
  await vault.mkdir('attachments');
  await writeFile(join(vault.root, 'attachments', 'a.png'), PICTURE);
  await openNote(page, 'n');
  await expectDrawnImage(page);

  // A click opens the image larger (#568); closing that leaves it selected, its alt text open.
  await page.locator('.editor img.image__img').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const alt = page.getByRole('textbox', { name: 'Alt text' });
  await expect(alt).toBeVisible();
  await alt.fill('A gradient');
  await alt.press('Enter');
  await expect(alt).toHaveCount(0);

  await saveNow(page);
  await expectSaved(page);
  await expectFile(vault, 'n.md').toBe('Intro.\n\n![A gradient](attachments/a.png)\n');
});

test('a pasted image still shows once its note is moved up to the vault root and its links updated', async ({
  page,
}) => {
  const vault = await openVault(page, { 'Work/Plans/q3.md': '# Q3\n\nThe goals.\n' });
  await page.getByRole('treeitem', { name: 'Work', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Plans', exact: true }).click();
  await openNote(page, 'q3');
  await newLineAfter(page, 'The goals.');
  await pasteFile(page, { bytes: PICTURE, name: 'image.png' });
  await expectDrawnImage(page);
  await saveNow(page);
  await expectSaved(page);
  const [name] = await filesIn(vault, 'attachments');
  const encoded = encodeURIComponent(name!);
  await expectFile(vault, 'Work/Plans/q3.md').toContain(`![](../../attachments/${encoded})`);

  const pages = sidebarSection(page, 'userSpace');
  await pages.getByRole('treeitem', { name: 'q3', exact: true }).hover();
  await pages.getByRole('button', { name: 'Options for q3', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Move to…/ }).click();
  await page.getByRole('searchbox', { name: 'Find a folder' }).fill('Pag');
  await page.keyboard.press('Enter');
  await expect.poll(() => vault.exists('q3.md')).toBe(true);

  await page.getByRole('button', { name: 'Update 1 link' }).click();
  await expectFile(vault, 'q3.md').toBe(`# Q3\n\nThe goals.\n\n![](attachments/${encoded})\n`);
  await expectDrawnImage(page);
});

/** A note that is an intro line and one image, `attachments/a.png`, open. */
async function openNoteWithImage(page: Page, line = '![](attachments/a.png)'): Promise<FakeVault> {
  const vault = await openVault(page, { 'n.md': `Intro.\n\n${line}\n` });
  await vault.mkdir('attachments');
  await writeFile(join(vault.root, 'attachments', 'a.png'), PICTURE);
  await openNote(page, 'n');
  await expectDrawnImage(page);
  return vault;
}

test('a pasted image opens larger on a click, zooms with ⌘+, and closes on Escape (#568)', async ({
  page,
}) => {
  await openVault(page, { 'plan.md': '# Plan\n\nThe first step.\n' });
  await openNote(page, 'plan');
  await newLineAfter(page, 'The first step.');
  await pasteFile(page, { bytes: PICTURE, name: 'image.png' });
  await expectDrawnImage(page);

  await page.locator('.editor img.image__img').click();
  const viewer = page.getByRole('dialog');
  await expect(viewer).toBeVisible();
  const shown = viewer.locator('img.lightbox__img');
  await expect(shown).toBeVisible();
  const zoom = viewer.getByRole('status', { name: 'Zoom' });
  await expect(zoom).toHaveText('100%');
  const before = (await shown.boundingBox())!.width;
  expect(before).toBeCloseTo(360, 0);

  await page.keyboard.press('ControlOrMeta+Equal');
  await expect(zoom).toHaveText('125%');
  await expect.poll(async () => (await shown.boundingBox())!.width).toBeCloseTo(450, 0);

  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(page.locator('.editor .image--selected')).toHaveCount(1);
  await expect(page.locator('.editor')).toBeFocused();
});

test('dragging an image’s handle resizes it, and the note saves only its width (#568)', async ({
  page,
}) => {
  const vault = await openNoteWithImage(page, "![A gradient](<attachments/a.png> 'Q3')");
  const img = page.locator('.editor img.image__img');
  const box = (await img.boundingBox())!;
  await img.hover();
  const handle = page.locator('.editor .image__handle--right');
  await expect(handle).toBeVisible();
  const grip = (await handle.boundingBox())!;

  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 50, grip.y + grip.height / 2, { steps: 4 });
  await page.mouse.move(grip.x + grip.width / 2 - 100, grip.y + grip.height / 2, { steps: 4 });
  await page.mouse.up();

  const width = Math.round(box.width - 100);
  await expect.poll(async () => Math.round((await img.boundingBox())!.width)).toBe(width);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await saveNow(page);
  await expectSaved(page);
  await expectFile(vault, 'n.md').toBe(
    `Intro.\n\n![A gradient|${width}](<attachments/a.png> 'Q3')\n`,
  );

  await handle.dblclick();
  await expect.poll(async () => Math.round((await img.boundingBox())!.width)).toBe(360);
  await saveNow(page);
  await expectFile(vault, 'n.md').toBe("Intro.\n\n![A gradient](<attachments/a.png> 'Q3')\n");
});

test('a note that ends in an image keeps an empty line under it to type on (#568)', async ({
  page,
}) => {
  const vault = await openNoteWithImage(page);
  // The kept line is the note's last, under the image's line, and holds nothing yet.
  const line = page.locator('.editor > p:last-child');
  await expect(line.locator('img')).toHaveCount(0);
  await expect(line).toHaveText('');

  await line.click();
  await page.keyboard.type('After the photo.');

  await saveNow(page);
  await expectSaved(page);
  await expectFile(vault, 'n.md').toBe('Intro.\n\n![](attachments/a.png)\n\nAfter the photo.\n');
});
