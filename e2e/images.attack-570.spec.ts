import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  expectFile,
  expectSaved,
  installHost,
  saveNow,
  type FakeVault,
} from './host.ts';

/*
 * Adversarial checks on #568 (PR #570): a resize in a table cell, and Enter on
 * a selected image in a list, as they reach the saved file.
 */

/** A real PNG, as images.spec.ts draws one, so the webview decodes it. */
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

async function openNoteWithImage(page: Page, body: string): Promise<FakeVault> {
  const vault = await createVault();
  await vault.write('n.md', body);
  await vault.mkdir('attachments');
  await writeFile(join(vault.root, 'attachments', 'a.png'), png(360, 200));
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await page.getByRole('treeitem', { name: 'n', exact: true }).click();
  await expect(page.getByRole('article', { name: 'n' })).toBeVisible();
  const img = page.locator('.editor img.image__img');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((shown: HTMLImageElement) => shown.naturalWidth)).toBe(360);
  return vault;
}

test('a resize of an image in a table cell keeps the table, writing the width the cell can hold', async ({
  page,
}) => {
  const vault = await openNoteWithImage(
    page,
    'Intro.\n\n| Photo | Notes |\n| - | - |\n| ![shot](attachments/a.png) | kept |\n',
  );
  const img = page.locator('.editor img.image__img');
  await img.hover();
  const grip = (await page.locator('.editor .image__handle--right').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 100, grip.y + grip.height / 2, { steps: 4 });
  await page.mouse.up();

  await saveNow(page);
  await expectSaved(page);
  await expectFile(vault, 'n.md').toMatch(
    /^Intro\.\n\n\| Photo \| Notes \|\n\| - \| - \|\n\| !\[shot\\\|\d+\]\(attachments\/a\.png\) \| kept \|\n$/,
  );
});

test('Enter on a selected image in a list keeps the image in the saved note', async ({ page }) => {
  const vault = await openNoteWithImage(page, 'Intro.\n\n- ![shot](attachments/a.png)\n- Second\n');
  await page.locator('.editor img.image__img').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Typed');

  await saveNow(page);
  await expectSaved(page);
  await expectFile(vault, 'n.md').toContain('![shot](attachments/a.png)');
});
