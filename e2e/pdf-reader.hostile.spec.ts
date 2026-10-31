import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, type FakeVault } from './host.ts';
import { lanternFixturePdf } from '../tools/pdf/fixture-pdf.ts';
import { hugePagePdf, linkedPdf, passwordPdf } from '../tools/pdf/hostile-pdf.ts';

/*
 * Regression tests for the PDF reader (#504, review of PR #515), end to end in WebKit:
 * hostile PDFs put in the vault by hand and opened from Pages, and the
 * reader's pdf.js workers across tabs opened and closed.
 */

async function openVault(page: Page, files: Record<string, Buffer>): Promise<FakeVault> {
  const vault = await createVault();
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(vault.root, path, '..'), { recursive: true });
    await writeFile(join(vault.root, path), contents);
  }
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  return vault;
}

async function openFromPages(page: Page, name: string): Promise<void> {
  const row = page.getByRole('treeitem', { name });
  if (!(await row.isVisible())) await page.getByRole('treeitem', { name: 'Papers' }).click();
  await row.click();
}

test('a PDF locked with a password says so, rather than drawing nothing', async ({ page }) => {
  await openVault(page, { 'Papers/locked.pdf': passwordPdf() });
  await openFromPages(page, 'locked.pdf');
  await expect(page.getByRole('alert')).toContainText('locked with a password');
});

test('links and JavaScript in a PDF open nothing, on opening or on a click', async ({ page }) => {
  const opened: string[] = [];
  page.on('popup', (popup) => opened.push(`popup ${popup.url()}`));
  page.on('dialog', (dialog) => {
    opened.push(`dialog ${dialog.message()}`);
    void dialog.dismiss();
  });
  page.on('request', (request) => {
    if (
      !request.url().startsWith('http://localhost') &&
      !request.url().startsWith('http://127.0.0.1')
    )
      opened.push(`request ${request.url()}`);
  });
  await openVault(page, { 'Papers/linked.pdf': linkedPdf() });
  await openFromPages(page, 'linked.pdf');
  const first = page.locator('[data-pdf-page="1"]');
  await expect(first.locator('.pdf-text__run').first()).toBeVisible();
  const at = page.url();
  const box = await first.boundingBox();
  if (box === null) throw new Error('page 1 is not on screen');
  // The four links sit over the line, 100pt each from 72pt in, 52–92pt from the top.
  for (const left of [122, 222, 322, 422]) {
    await page.mouse.click(box.x + (left / 612) * box.width, box.y + (72 / 792) * box.height);
  }
  expect(page.url()).toBe(at);
  expect(opened).toEqual([]);
});

test('a page 200 inches square is drawn at a canvas WebKit can hold, zoomed in', async ({
  page,
}) => {
  await openVault(page, { 'Papers/huge.pdf': hugePagePdf() });
  await openFromPages(page, 'huge.pdf');
  const canvas = page.locator('[data-pdf-page="1"] canvas');
  await expect(canvas).toBeVisible();
  for (let step = 0; step < 4; step += 1)
    await page.getByRole('button', { name: 'Zoom in' }).click();
  // WebKit draws nothing into a canvas past 16384 × 16384 pixels.
  await expect
    .poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width * element.height))
    .toBeGreaterThan(0);
  const area = await canvas.evaluate(
    (element: HTMLCanvasElement) => element.width * element.height,
  );
  expect(area).toBeLessThanOrEqual(16384 * 16384);
});

test('closing PDF tabs lets their pdf.js workers go', async ({ page }) => {
  await page.addInitScript(() => {
    const Original = window.Worker;
    const live = new Set<Worker>();
    (window as unknown as { liveWorkers: () => number }).liveWorkers = () => live.size;
    window.Worker = class extends Original {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        live.add(this);
      }
      override terminate() {
        live.delete(this);
        super.terminate();
      }
    };
  });
  await openVault(page, { 'Papers/lanterns.pdf': lanternFixturePdf() });
  const liveWorkers = () =>
    page.evaluate(() => (window as unknown as { liveWorkers: () => number }).liveWorkers());
  const before = await liveWorkers();
  for (let round = 0; round < 4; round += 1) {
    await openFromPages(page, 'lanterns.pdf');
    await expect(page.locator('[data-pdf-page="1"] .pdf-text__run').first()).toBeVisible();
    // The open PDF has a worker of its own: what is counted is real.
    expect(await liveWorkers()).toBeGreaterThan(before);
    await page.locator('.pdf-reader__pages').click({ position: { x: 4, y: 4 } });
    await page.keyboard.press('Meta+w');
    await expect(page.locator('.pdf-reader')).toHaveCount(0);
  }
  await expect.poll(liveWorkers).toBeLessThanOrEqual(before + 1);
});
