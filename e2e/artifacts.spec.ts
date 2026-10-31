import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, STUB_API_PORT, type FakeHost, type FakeVault } from './host.ts';

/**
 * P17-07: Claude artifacts, saved and organised. A link pasted into the
 * palette becomes a note; a dropped page becomes a copy shown in a sandboxed
 * frame; a Claude session saves one over the local API; and the Artifacts
 * gallery shows each as a card. The type, template and view are the repo
 * vault's own, so this is what a vault gets.
 */

const REPO_ATLAS = new URL('../vault/.atlas/', import.meta.url);
const LINK = 'https://claude.ai/artifact/0f6c1f1e-q3';
const PAGE = [
  '<!doctype html><html><head><title>Q3</title>',
  '<link rel="stylesheet" href="app.css"></head>',
  '<body><h1 id="headline">Quarterly numbers</h1>',
  '<script>document.getElementById("headline").dataset.ran = "yes";</script>',
  '</body></html>',
].join('');

async function openVault(page: Page): Promise<{ vault: FakeVault; host: FakeHost }> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', '.atlas/templates', '.atlas/views']) {
    await vault.mkdir(folder);
  }
  for (const file of ['types/artifact.md', 'templates/Artifact.md', 'views/Artifacts.md']) {
    await vault.write(`.atlas/${file}`, await readFile(new URL(file, REPO_ATLAS), 'utf8'));
  }
  await vault.write('.atlas/types/project.md', '---\nname: project\n---\n');
  await vault.write('DFAI.md', '---\ntype: project\n---\n');

  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'New artifact' });
const frame = (page: Page) => page.getByTitle(/^Saved copy of /);

async function dropFile(page: Page, name: string, contents: string): Promise<void> {
  const transfer = await page.evaluateHandle(
    ([fileName, text]) => {
      const data = new DataTransfer();
      data.items.add(new File([text], fileName, { type: 'text/html' }));
      return data;
    },
    [name, contents] as const,
  );
  await dialog(page)
    .getByRole('group', { name: 'Drop the page here' })
    .dispatchEvent('drop', { dataTransfer: transfer });
}

test('a pasted claude.ai link becomes an artifact note in artifacts/, with only its link', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);

  await page.keyboard.press('Meta+k');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill(LINK);
  await page.getByRole('option', { name: 'Save this link as an artifact' }).click();

  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole('textbox', { name: 'Link' })).toHaveValue(LINK);
  await expect(
    dialog(page).getByText(
      'Only the link is saved. Ask Claude to save a copy, or drop the HTML file here.',
    ),
  ).toBeVisible();
  await dialog(page).getByRole('textbox', { name: 'Title' }).fill('Q3 review');
  await dialog(page).getByRole('combobox', { name: 'Project' }).selectOption('DFAI');
  await dialog(page).getByRole('button', { name: 'Save artifact' }).click();

  await expect.poll(() => vault.read('artifacts/Q3 review.md')).toContain(`url: ${LINK}`);
  const note = await vault.read('artifacts/Q3 review.md');
  expect(note).toContain('type: artifact');
  expect(note).toMatch(/^project: ["']\[\[DFAI\]\]["']$/m);
  expect(note).not.toMatch(/^saved: \S/m);

  // The note opens, and says there is no copy yet — with the link one click away.
  const viewer = page.getByRole('region', { name: 'Saved copy' });
  await expect(viewer.getByText('Only the link is saved')).toBeVisible();
  await expect(frame(page)).toHaveCount(0);
  await viewer.getByRole('button', { name: 'Open link' }).first().click();
  expect(host.openedLinks()).toEqual([LINK]);
});

test('a dropped page is saved beside its note and shown in a sandboxed frame', async ({ page }) => {
  const { vault } = await openVault(page);

  await page.getByRole('button', { name: 'New note', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Claude artifact…' }).click();
  await dropFile(page, 'Quarterly.html', PAGE);
  await expect(dialog(page).getByText(/Saving a copy/)).toBeVisible();
  // The title comes from the page's name until one is typed.
  await expect(dialog(page).getByRole('textbox', { name: 'Title' })).toHaveValue('Quarterly');
  await dialog(page).getByRole('button', { name: 'Save artifact' }).click();

  await expect.poll(() => vault.read('artifacts/quarterly/index.html')).toBe(PAGE);
  await expect
    .poll(() => vault.read('artifacts/Quarterly.md'))
    .toContain('saved: artifacts/quarterly');

  // Pages shows the note, not the machinery behind it.
  const pages = page.getByRole('tree');
  await pages.getByRole('treeitem', { name: 'artifacts' }).click();
  await expect(pages.getByRole('treeitem', { name: 'Quarterly' })).toBeVisible();
  await expect(pages.getByRole('treeitem', { name: 'quarterly', exact: true })).toHaveCount(0);

  await expect(frame(page)).toHaveAttribute('sandbox', 'allow-scripts');
  const inside = page.frameLocator('iframe[title="Saved copy of Quarterly"]');
  await expect(inside.getByRole('heading', { name: 'Quarterly numbers' })).toBeVisible();
  // Its own script ran, under the policy DFAI put first in its head.
  await expect(inside.locator('#headline')).toHaveAttribute('data-ran', 'yes');
  await expect(inside.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1);

  // The frame is a different, opaque origin: no IPC, and no reach into the app.
  const copy = page.frames().find((candidate) => candidate !== page.mainFrame());
  expect(copy).toBeDefined();
  const reach = await copy?.evaluate(() => {
    const own = window as unknown as Record<string, unknown>;
    let parent = 'reachable';
    try {
      void window.parent.document.title;
    } catch {
      parent = 'blocked';
    }
    return {
      internals: typeof own['__TAURI_INTERNALS__'],
      tauri: typeof own['__TAURI__'],
      origin: window.origin,
      parent,
    };
  });
  expect(reach).toEqual({
    internals: 'undefined',
    tauri: 'undefined',
    origin: 'null',
    parent: 'blocked',
  });
  // The app itself still has its IPC: the absence above is the frame's, not the stub's.
  expect(
    await page.evaluate(
      () => typeof (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'],
    ),
  ).toBe('object');
});

test('an artifact saved over the API gets its note and copy, and a card in the gallery', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('switch', { name: 'Local API' }).click();
  await expect(settings.getByTestId('api-status')).toHaveText(`Running on port ${STUB_API_PORT}`);
  await settings.getByRole('button', { name: 'Close', exact: true }).click();

  const answer = await host.api.send({
    method: 'POST',
    path: '/v1/artifacts',
    body: { title: 'Launch deck', url: LINK, kind: 'deck', tags: ['launch'], html: PAGE },
  });
  expect(answer.status).toBe(201);
  expect(answer.body['note']).toMatchObject({ path: 'artifacts/Launch deck.md', type: 'artifact' });
  await expect.poll(() => vault.read('artifacts/launch-deck/index.html')).toBe(PAGE);

  const chunk = await host.api.send({
    method: 'PUT',
    path: `/v1/artifacts/${encodeURIComponent('artifacts/Launch deck.md')}/files/app.css`,
    body: { text: 'h1 { color: rgb(1, 2, 3); }' },
  });
  expect(chunk).toEqual({
    status: 201,
    body: { file: { path: 'artifacts/launch-deck/app.css', size: 27 } },
  });

  await page
    .getByRole('region', { name: 'Views' })
    .getByRole('button', { name: 'Artifacts', exact: true })
    .click();
  const gallery = page.getByRole('region', { name: 'deck' });
  const card = gallery.getByRole('listitem').filter({ hasText: 'Launch deck' });
  await expect(card).toBeVisible();
  await expect(card.locator('.artifact-face[data-kind="deck"]')).toBeVisible();
  // The tag is its own pill, written as it was given, in its colour (#413).
  const tag = card.locator('.status-pill', { hasText: /^launch$/ });
  await expect(tag).toBeVisible();
  await expect(tag).toHaveAttribute('data-hue', /^[a-z]+$/);

  await card.getByRole('button', { name: 'Launch deck' }).click();
  const inside = page.frameLocator('iframe[title="Saved copy of Launch deck"]');
  await expect(inside.getByRole('heading', { name: 'Quarterly numbers' })).toHaveCSS(
    'color',
    'rgb(1, 2, 3)',
  );
});
