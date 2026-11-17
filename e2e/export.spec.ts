import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, pageCommand, sidebarSection, type FakeHost } from './host.ts';

/**
 * #501: a note exported from its "…" menu — as Markdown as it is (the file's
 * bytes, unchanged), as standalone Markdown (its links made plain), and as a
 * PDF — through the host's save dialog and the system's PDF, which the fake
 * host stands in for. Exporting never changes the note.
 */

const KICKOFF = [
  '---',
  'title: Kickoff with Larkspur',
  'owner: "[[Mara Quill]]"',
  '---',
  '',
  'Met with [[Mara Quill]] about the rollout.\r',
  '',
  '**Mara Quill** [~00:00:00] Morning. Shall we start? ^t0001',
  '',
].join('\n');

async function openVault(page: Page): Promise<{ host: FakeHost; root: string }> {
  const vault = await createVault();
  await vault.write('Kickoff.md', KICKOFF);
  await vault.write('Mara Quill.md', 'Works at Larkspur Payroll.\n');
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: /Kickoff/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Kickoff with Larkspur' }).first()).toBeVisible();
  return { host, root: vault.root };
}

async function exportAs(page: Page, format: RegExp) {
  await pageCommand(page, /^Export…$/);
  const dialog = page.getByRole('dialog', { name: /Export Kickoff/ });
  await dialog.getByRole('radio', { name: format }).check();
  await dialog.getByRole('button', { name: 'Export…' }).click();
  return dialog;
}

const exported = (host: FakeHost, name: string) =>
  expect.poll(async () =>
    (await readdir(host.exports.root).catch((): string[] => [])).includes(name),
  );

test('exports a note as Markdown as it is: the same bytes, the note unchanged', async ({
  page,
}) => {
  const { host, root } = await openVault(page);
  const dialog = await exportAs(page, /Markdown, as is/);
  await exported(host, 'Kickoff with Larkspur.md').toBe(true);
  await expect(dialog).toBeHidden();

  const written = await readFile(join(host.exports.root, 'Kickoff with Larkspur.md'));
  expect(written.equals(Buffer.from(KICKOFF, 'utf8'))).toBe(true);
  expect(await readFile(join(root, 'Kickoff.md'), 'utf8')).toBe(KICKOFF);
  await expect(
    page.getByText(/Exported 1 note as Markdown to .*Kickoff with Larkspur\.md/),
  ).toBeVisible();
});

test('exports standalone Markdown with its links made plain', async ({ page }) => {
  const { host } = await openVault(page);
  await exportAs(page, /Markdown, standalone/);
  await exported(host, 'Kickoff with Larkspur.md').toBe(true);

  const written = await readFile(join(host.exports.root, 'Kickoff with Larkspur.md'), 'utf8');
  // The frontmatter is kept as it is, by default; the body's links are words.
  const [, frontmatter = '', body = ''] = /^(---\n[\s\S]*?\n---\n)([\s\S]*)$/.exec(written) ?? [];
  expect(frontmatter).toBe('---\ntitle: Kickoff with Larkspur\nowner: "[[Mara Quill]]"\n---\n');
  expect(body).toContain('Met with Mara Quill about the rollout.');
  expect(body).toContain('**Mara Quill** [~00:00:00] Morning. Shall we start?');
  expect(body).not.toContain('[[');
  expect(body).not.toContain('^t0001');
});

test('exports a PDF of the note’s page', async ({ page }) => {
  const { host } = await openVault(page);
  await exportAs(page, /^PDF/);
  await exported(host, 'Kickoff with Larkspur.pdf').toBe(true);

  const pdf = await readFile(join(host.exports.root, 'Kickoff with Larkspur.pdf'));
  expect(pdf.byteLength).toBeGreaterThan(0);
  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const [made] = host.exports.pdfPages();
  expect(made).toContain('<h1 class="export__title">Kickoff with Larkspur</h1>');
  expect(made).toContain('<th scope="row">owner</th><td>Mara Quill</td>');
  expect(made).toContain('Mara Quill');
});

test('cancelling the save dialog writes nothing and keeps the question open', async ({ page }) => {
  const { host } = await openVault(page);
  host.exports.cancelNext();
  const dialog = await exportAs(page, /^PDF/);
  await expect(dialog.getByRole('button', { name: 'Export…' })).toBeEnabled();
  await expect(dialog).toBeVisible();
  expect(await readdir(host.exports.root).catch(() => [])).toEqual([]);
  expect(host.exports.pdfPages()).toEqual([]);
});
