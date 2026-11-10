import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from './fixtures.ts';
import {
  createVault,
  installHost,
  solidPng,
  STUB_API_PORT,
  STUB_THUMBNAIL,
  type FakeHost,
  type FakeVault,
} from './host.ts';

/**
 * U-11: an artifact's thumbnail is made for it. Saving a copy has the host
 * picture it (stubbed here to answer with `STUB_THUMBNAIL`; the real picture
 * is `page_snapshot.rs`'s, tested there), the picture is kept in the copy, and
 * the gallery and the note show it — never over a cover somebody set by hand.
 */

const REPO_ATLAS = new URL('../vault/.atlas/', import.meta.url);
const PAGE =
  '<!doctype html><html><head><title>Q3</title></head><body><h1>Q3 numbers</h1></body></html>';
const THUMBNAIL_WIDTH = STUB_THUMBNAIL.readUInt32BE(16);

async function openVault(
  page: Page,
  setUp: (vault: FakeVault) => Promise<void> = async () => {},
): Promise<{ vault: FakeVault; host: FakeHost }> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', '.atlas/templates', '.atlas/views']) {
    await vault.mkdir(folder);
  }
  for (const file of ['types/artifact.md', 'templates/Artifact.md', 'views/Artifacts.md']) {
    await vault.write(`.atlas/${file}`, await readFile(new URL(file, REPO_ATLAS), 'utf8'));
  }
  await setUp(vault);
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

/** An artifact note with its copy beside it, as saving leaves one. */
async function savedArtifact(vault: FakeVault, { cover }: { cover?: string } = {}) {
  await vault.mkdir('artifacts/q3');
  await vault.write('artifacts/q3/index.html', PAGE);
  await vault.write(
    'artifacts/Q3.md',
    `---\ntype: artifact\nkind: page\nsaved: artifacts/q3\nsaved_at: 2026-09-25\n${
      cover === undefined ? '' : `cover: ${cover}\n`
    }---\n`,
  );
}

async function openGallery(page: Page): Promise<Locator> {
  await page
    .getByRole('region', { name: 'Views' })
    .getByRole('button', { name: 'Artifacts', exact: true })
    .click();
  return page.getByRole('list', { name: 'Notes' });
}

/** Resolves to an image's natural width once it has loaded: 0 while it is broken. */
const naturalWidth = (image: Locator) =>
  image.evaluate((element) => (element as HTMLImageElement).naturalWidth);

const thumbnailRow = (page: Page) =>
  page.getByRole('region', { name: 'Properties' }).locator('.thumbnail-value');

test('a page saved from the dialog is pictured, and the gallery and the note show the picture', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);

  await page.getByRole('button', { name: 'New note', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Claude artifact…' }).click();
  const dialog = page.getByRole('dialog', { name: 'New artifact' });
  const transfer = await page.evaluateHandle((html) => {
    const data = new DataTransfer();
    data.items.add(new File([html], 'Q3.html', { type: 'text/html' }));
    return data;
  }, PAGE);
  await dialog
    .getByRole('group', { name: 'Drop the page here' })
    .dispatchEvent('drop', { dataTransfer: transfer });
  await dialog.getByRole('button', { name: 'Save artifact' }).click();

  await expect
    .poll(() => vault.read('artifacts/Q3.md'))
    .toMatch(/^cover: q3\/atlas-thumbnail\.png$/m);
  expect(await readFile(`${vault.root}/artifacts/q3/atlas-thumbnail.png`)).toEqual(STUB_THUMBNAIL);
  // What was pictured is the page as the frame shows it: policy first, files written in.
  const [pictured] = host.snapshots.pages();
  expect(pictured).toContain('<h1>Q3 numbers</h1>');
  expect(pictured?.indexOf('Content-Security-Policy')).toBeLessThan(
    pictured?.indexOf('<h1>') ?? -1,
  );

  // The note's Thumbnail row is the picture, not the path it is kept at.
  const preview = thumbnailRow(page).getByRole('img');
  await expect(preview).toBeVisible();
  await expect.poll(() => naturalWidth(preview)).toBe(THUMBNAIL_WIDTH);
  await expect(page.getByRole('textbox', { name: 'Thumbnail' })).toHaveCount(0);

  const gallery = await openGallery(page);
  const card = gallery.getByRole('listitem').filter({ hasText: 'Q3' });
  const cover = card.locator('img.card-cover');
  await expect(cover).toBeVisible();
  await expect.poll(() => naturalWidth(cover)).toBe(THUMBNAIL_WIDTH);
  await expect(card.locator('.artifact-face')).toHaveCount(0);
  await expect(async () => {
    const ratio = await cover.evaluate((element) => element.clientWidth / element.clientHeight);
    expect(ratio).toBeCloseTo(16 / 10, 1);
  }).toPass();
});

test('"Generate missing thumbnails" pictures copies with no cover, saying so on each card meanwhile', async ({
  page,
}) => {
  const { vault, host } = await openVault(page, (vault) => savedArtifact(vault));
  const gallery = await openGallery(page);
  const card = gallery.getByRole('listitem').filter({ hasText: 'Q3' });
  await expect(card.locator('.artifact-face')).toBeVisible();

  const release = host.snapshots.hold();
  await page.getByRole('button', { name: 'Generate missing thumbnails' }).click();
  await expect(page.getByRole('button', { name: 'Generating thumbnails… 1 left' })).toBeDisabled();
  await expect(card.getByText('Generating thumbnail…')).toBeVisible();

  release();
  const cover = card.locator('img.card-cover');
  await expect(cover).toBeVisible();
  await expect.poll(() => naturalWidth(cover)).toBe(THUMBNAIL_WIDTH);
  await expect(page.getByRole('status').filter({ hasText: 'Made 1 thumbnail' })).toBeVisible();
  await expect.poll(() => vault.read('artifacts/Q3.md')).toContain('cover: q3/atlas-thumbnail.png');
});

test('a cover set by hand is kept by the automatic thumbnail, and replaced only when asked', async ({
  page,
}) => {
  const { vault, host } = await openVault(page, async (vault) => {
    // A picture of the person's own, beside the note, which the cover names.
    await vault.mkdir('artifacts/photos');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${vault.root}/artifacts/photos/me.png`, solidPng(40, 25, [20, 120, 40]));
    await savedArtifact(vault, { cover: 'photos/me.png' });
  });

  // Asked for as a save from Claude asks for it, once the copy is in.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('switch', { name: 'Local API' }).click();
  await expect(settings.getByTestId('api-status')).toHaveText(`Running on port ${STUB_API_PORT}`);
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  const answer = await host.api.send({
    method: 'POST',
    path: `/v1/artifacts/${encodeURIComponent('artifacts/Q3.md')}/thumbnail`,
    body: null,
  });
  expect(answer.status).toBe(200);
  expect(answer.body['note']).toMatchObject({ properties: { cover: 'photos/me.png' } });
  expect(host.snapshots.pages()).toEqual([]);
  expect(await vault.exists('artifacts/q3/atlas-thumbnail.png')).toBe(false);

  // The gallery shows the hand-set picture.
  const gallery = await openGallery(page);
  const card = gallery.getByRole('listitem').filter({ hasText: 'Q3' });
  await expect.poll(() => naturalWidth(card.locator('img.card-cover'))).toBe(40);

  // "Generate missing thumbnails" passes it over too: it has a cover.
  await page.getByRole('button', { name: 'Generate missing thumbnails' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Every artifact with a copy has a thumbnail' }),
  ).toBeVisible();
  expect(host.snapshots.pages()).toEqual([]);

  // A picture that cannot be made says why and leaves the cover alone…
  await card.getByRole('button', { name: 'Q3' }).click();
  host.snapshots.failWith('thumbnails are made on macOS only');
  await thumbnailRow(page).getByRole('button', { name: 'Regenerate' }).click();
  await expect(thumbnailRow(page).getByRole('alert')).toHaveText(
    'No thumbnail: thumbnails are made on macOS only',
  );
  expect(await vault.read('artifacts/Q3.md')).toContain('cover: photos/me.png');

  // …and Regenerate, asked for, replaces it.
  host.snapshots.failWith(null);
  await thumbnailRow(page).getByRole('button', { name: 'Regenerate' }).click();
  await expect.poll(() => vault.read('artifacts/Q3.md')).toContain('cover: q3/atlas-thumbnail.png');
  await expect.poll(() => naturalWidth(thumbnailRow(page).getByRole('img'))).toBe(THUMBNAIL_WIDTH);

  // Clear takes it off for good — cleared, not empty, so no run fills it —
  // leaving the row to make one again.
  await thumbnailRow(page).getByRole('button', { name: 'Clear' }).click();
  await expect.poll(() => vault.read('artifacts/Q3.md')).toContain('cover: false');
  await expect(thumbnailRow(page).getByText('None yet')).toBeVisible();
  await expect(thumbnailRow(page).getByRole('button', { name: 'Generate' })).toBeVisible();
});
