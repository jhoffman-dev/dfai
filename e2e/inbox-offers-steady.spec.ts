import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, type FakeHost } from './host.ts';

/**
 * #130, in WebKit: the Inbox's offers are read once the index is ready, and
 * one that lands above rows already drawn used to push them down, so a click
 * aimed at a row fell on something else. Here the tidy's read of the one
 * loose note is held from the start; letting it go after the rows show must
 * not move them, and a click where a row was must open that row.
 */

const ROWS = 4;

/** Opens a vault of four Inbox notes and one loose note, the tidy's read of it held if asked. */
async function openVault(
  page: Page,
  { hold }: { hold: boolean },
): Promise<{ host: FakeHost; release: () => void }> {
  const vault = await createVault();
  await vault.mkdir('Inbox');
  for (let n = 1; n <= ROWS; n++) await vault.write(`Inbox/Item ${n}.md`, `Body of item ${n}.\n`);
  // Loose at the root, so the tidy offers to move it to Notes/<year>.
  await vault.write('Loose idea.md', 'A thought.\n');
  const host = await installHost(page, vault);
  // The index reads every note in one batch, the first row's too: that read goes ahead.
  const release = hold ? host.holdReads('Loose idea.md', { except: 'Inbox/Item 1.md' }) : () => {};
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 60_000 });
  return { host, release };
}

/** How far, at most, the Inbox row titled `title` moved up or down over the next `frames` frames. */
function largestMove(page: Page, title: string, frames: number): Promise<number> {
  return page.evaluate(
    async ({ title, frames }) => {
      const row = () =>
        [...document.querySelectorAll('.inbox__grid button')].find(
          (button) => button.textContent?.trim() === title,
        );
      const at = () => row()?.getBoundingClientRect().top ?? Number.NaN;
      const start = at();
      let largest = 0;
      for (let frame = 0; frame < frames; frame++) {
        await new Promise((done) => requestAnimationFrame(done));
        largest = Math.max(largest, Math.abs(at() - start));
      }
      return largest;
    },
    { title, frames },
  );
}

const inbox = (page: Page) => page.getByRole('article', { name: 'Inbox' });
const tidy = (page: Page) => page.getByRole('region', { name: 'Tidy the vault' });

test('the offers are known as the Inbox opens: they show above the rows, and nothing arrives after (#130)', async ({
  page,
}) => {
  await openVault(page, { hold: false });
  await page.getByRole('button', { name: /^Inbox/ }).click();
  const row = inbox(page).getByRole('button', { name: 'Item 1', exact: true });
  await expect(row).toBeVisible();
  await expect(tidy(page)).toBeVisible();
  const offer = (await tidy(page).boundingBox())!;
  await expect(async () =>
    expect(offer.y + offer.height).toBeLessThanOrEqual((await row.boundingBox())!.y),
  ).toPass();
  expect(await largestMove(page, 'Item 1', 30)).toBe(0);
  await expect(page.getByRole('button', { name: /New above/ })).toHaveCount(0);
});

test('an offer read after the rows are drawn does not move them, and a click hits the row aimed at (#130)', async ({
  page,
}) => {
  const { release } = await openVault(page, { hold: true });
  await page.getByRole('button', { name: /^Inbox/ }).click();
  const target = inbox(page).getByRole('button', { name: 'Item 3', exact: true });
  await expect(target).toBeVisible();
  await expect(tidy(page)).toHaveCount(0);
  const box = (await target.boundingBox())!;

  release();
  // The tidy's read is answered now; watch the row while the app takes it in.
  expect(await largestMove(page, 'Item 3', 60)).toBe(0);
  // It is shown, above the rows, at the top of the view: in sight, so nothing is "New above".
  // (Out of sight, deep in a long list, it is: inbox-anchor.attack-283b.spec.ts.)
  await expect(tidy(page)).toBeInViewport();
  await expect(page.getByRole('button', { name: /New above/ })).toHaveCount(0);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByText('Body of item 3.')).toBeVisible();
});

test('an offer read while the rows are held lands above them before they show (#130)', async ({
  page,
}) => {
  const { release } = await openVault(page, { hold: true });
  await page.getByRole('button', { name: /^Inbox/ }).click();
  await expect(inbox(page)).toBeVisible();
  release();
  const row = inbox(page).getByRole('button', { name: 'Item 1', exact: true });
  await expect(row).toBeVisible();
  await expect(tidy(page)).toBeVisible();
  // Below the offer whether it came before the rows showed or after; and they stay put.
  const offer = (await tidy(page).boundingBox())!;
  await expect(async () =>
    expect(offer.y + offer.height).toBeLessThanOrEqual((await row.boundingBox())!.y),
  ).toPass();
  expect(await largestMove(page, 'Item 1', 30)).toBe(0);
});

/** What DFAI records of the properties it added to built-in types: read only as the types are set up. */
const SHIPPED_RECORD = '.atlas/migrations/type-properties.md';
const NOTHING_RECORDED = [
  '---',
  'atlas: migration',
  '---',
  '',
  '# Properties added to built-in types',
  '',
  '```json',
  '{"settled":{},"added":{}}',
  '```',
  '',
].join('\n');

const typesOffer = (page: Page) =>
  inbox(page).getByRole('complementary', { name: 'Set your types up for the Inbox' });

test('the Inbox waits for the types offer’s read too: held, the rows wait; let go, it lands above them, and nothing is new above (#381)', async ({
  page,
}) => {
  const vault = await createVault();
  for (const folder of ['Inbox', '.atlas/migrations']) await vault.mkdir(folder);
  for (let n = 1; n <= ROWS; n++) await vault.write(`Inbox/Item ${n}.md`, `Body of item ${n}.\n`);
  await vault.write(SHIPPED_RECORD, NOTHING_RECORDED);
  await page.clock.install();
  const host = await installHost(page, vault);
  // Alone: the index reads it in a batch with every other note, and that read goes ahead.
  const release = host.holdReads(SHIPPED_RECORD, { alone: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 60_000 });

  // The page's time stands still, so the Inbox's short wait for its offers cannot run out on its own.
  await page.clock.pauseAt(Date.now() + 1_000);
  await page.getByRole('button', { name: /^Inbox/ }).click();
  await expect(inbox(page)).toBeVisible();
  await expect(inbox(page).locator('.inbox__held')).toHaveCount(1);
  await expect(inbox(page).getByRole('button', { name: 'Item 1', exact: true })).toHaveCount(0);

  release();
  const row = inbox(page).getByRole('button', { name: 'Item 1', exact: true });
  await expect(row).toBeVisible();
  await expect(typesOffer(page)).toBeVisible();
  const offer = (await typesOffer(page).boundingBox())!;
  await expect(async () =>
    expect(offer.y + offer.height).toBeLessThanOrEqual((await row.boundingBox())!.y),
  ).toPass();
  await page.clock.resume();
  expect(await largestMove(page, 'Item 1', 30)).toBe(0);
  await expect(page.getByRole('button', { name: /New above/ })).toHaveCount(0);
});
