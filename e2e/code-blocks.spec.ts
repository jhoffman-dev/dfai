import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page, type Route } from './fixtures.ts';
import { createVault, installHost, sidebarSection, type FakeVault } from './host.ts';

/*
 * Code blocks highlighted on first use (#265): no grammar is fetched until a
 * shown block names its language, each is fetched once, a block is its plain
 * text until then and is coloured where it stands, and a grammar whose chunk
 * failed (in the style of `on-first-use.readers-560.spec.ts`) leaves the code
 * plain until the note is shown again, when it is fetched afresh.
 */

type ManifestChunk = { file: string; src?: string; isDynamicEntry?: boolean };

/** Each grammar's chunk, by the grammar's name: read from the build. */
function grammarChunks(): ReadonlyMap<string, string> {
  const manifest = JSON.parse(
    readFileSync(join('apps', 'desktop', 'dist', '.vite', 'manifest.json'), 'utf8'),
  ) as Record<string, ManifestChunk>;
  const grammar = /highlight\.js\/(?:es|lib)\/languages\/([a-z]+)\.js$/;
  return new Map(
    Object.values(manifest).flatMap((chunk) => {
      const name = chunk.isDynamicEntry === true ? grammar.exec(chunk.src ?? '')?.[1] : undefined;
      return name === undefined ? [] : [[name, chunk.file] as const];
    }),
  );
}

const GRAMMAR_CHUNKS = grammarChunks();
const grammarOf = (url: string | URL): string | null => {
  const path = new URL(url).pathname;
  for (const [name, file] of GRAMMAR_CHUNKS) if (path.endsWith(file)) return name;
  return null;
};

const FENCES = [
  ['ts', 'const harvest: number = 55;'],
  ['python', 'def lantern(rows):\n    return 42'],
  ['rust', 'fn granary() -> u32 {\n    12\n}'],
  ['sql', "SELECT name FROM meadow WHERE kind = 'heron';"],
  ['yml', 'orchard:\n  rows: 4'],
] as const;
const fence = (language: string, code: string) => `\`\`\`${language}\n${code}\n\`\`\``;
const FIVE = ['# Five Languages', ...FENCES.map(([l, c]) => fence(l, c)), fence('', 'plain words')];

async function openVault(page: Page, files: Record<string, string>): Promise<FakeVault> {
  const vault = await createVault();
  for (const [path, contents] of Object.entries(files)) await vault.write(path, contents);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

/** The grammars the page fetches, in order, each time it asks. */
function grammarRequests(page: Page): string[] {
  const asked: string[] = [];
  page.on('request', (request) => {
    const name = grammarOf(request.url());
    if (name !== null) asked.push(name);
  });
  return asked;
}

async function openNote(page: Page, name: string) {
  await sidebarSection(page, 'userSpace').getByRole('treeitem', { name, exact: true }).click();
  await expect(
    page.locator('.pane__tab:not([hidden])').getByRole('article', { name }),
  ).toBeVisible();
}

const codeBlocks = (page: Page) =>
  page.locator('.pane__tab:not([hidden]) .editor[aria-label="Note"] pre code');
const colouredIn = (block: Locator) => block.locator('[class*="hljs-"]');

test('the build splits each grammar into a chunk of its own', () => {
  expect([...GRAMMAR_CHUNKS.keys()].sort()).toEqual([
    'bash',
    'css',
    'json',
    'markdown',
    'python',
    'rust',
    'sql',
    'typescript',
    'xml',
    'yaml',
  ]);
});

test('a note of code in five languages fetches only those grammars, once, and colours each block', async ({
  page,
}) => {
  const asked = grammarRequests(page);
  await openVault(page, {
    'Five Languages.md': `${FIVE.join('\n\n')}\n`,
    'More Rust.md': `# More Rust\n\n${fence('rs', 'let kiln = 3;')}\n`,
    'Journal.md': '# Journal\n\nToday.\n',
  });
  await openNote(page, 'Journal');
  expect(asked, 'no grammar before a code block is shown').toEqual([]);

  await openNote(page, 'Five Languages');
  const blocks = codeBlocks(page);
  await expect(blocks).toHaveCount(6);
  for (let at = 0; at < FENCES.length; at += 1) {
    await expect(colouredIn(blocks.nth(at)).first()).toBeAttached();
  }
  // A block that names no language is its plain text.
  await expect(blocks.nth(5)).toHaveText('plain words');
  await expect(colouredIn(blocks.nth(5))).toHaveCount(0);
  expect([...asked].sort()).toEqual(['python', 'rust', 'sql', 'typescript', 'yaml']);

  // Another note in a grammar already here fetches nothing more.
  await openNote(page, 'More Rust');
  await expect(colouredIn(codeBlocks(page).first()).first()).toBeAttached();
  expect(asked).toHaveLength(5);
});

test('a block is its plain text until the grammar arrives, and nothing moves when it is coloured', async ({
  page,
}) => {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => grammarOf(url) === 'python',
    async (route: Route) => {
      await released;
      await route.continue();
    },
  );
  await openVault(page, {
    'Lanterns.md': `# Lanterns\n\n${fence('py', 'def lantern(rows):\n    return 42')}\n\nAfter the code.\n`,
  });
  await openNote(page, 'Lanterns');
  const block = codeBlocks(page).first();
  await expect(block).toHaveText('def lantern(rows):\n    return 42');
  await expect(colouredIn(block)).toHaveCount(0);
  const plain = await block.boundingBox();
  const after = await page.getByText('After the code.').boundingBox();
  const font = await block.evaluate((code) => getComputedStyle(code).fontFamily);

  release();
  await expect(colouredIn(block).first()).toBeAttached();
  expect(await block.boundingBox()).toEqual(plain);
  expect(await page.getByText('After the code.').boundingBox()).toEqual(after);
  expect(await block.evaluate((code) => getComputedStyle(code).fontFamily)).toBe(font);
  const fonts = await colouredIn(block).evaluateAll((spans) => [
    ...new Set(spans.map((span) => getComputedStyle(span).fontFamily)),
  ]);
  expect(fonts).toEqual([font]);
});

test('a code block shown in another note is coloured there', async ({ page }) => {
  await openVault(page, {
    'Kiln.md': `# Kiln\n\n${fence('sh', 'echo "firing"')}\n^kiln01\n`,
    'Journal.md': '# Journal\n\n![[Kiln#^kiln01]]\n',
  });
  await openNote(page, 'Journal');
  const shown = page.getByRole('group', { name: 'Embedded block from Kiln' });
  await expect(shown.locator('pre code')).toHaveText('echo "firing"');
  await expect(colouredIn(shown.locator('pre code')).first()).toBeAttached();
});

for (const failure of ['abort', 'truncate'] as const) {
  test(`a grammar whose chunk failed (${failure}) leaves the code plain, and is fetched afresh when the note is shown again`, async ({
    page,
  }) => {
    let failing = true;
    await page.route(
      (url) => grammarOf(url) === 'rust',
      async (route: Route) => {
        if (!failing) return route.continue();
        if (failure === 'abort') return route.abort();
        const response = await route.fetch();
        const body = await response.text();
        // A download interrupted halfway: the module fails to parse.
        return route.fulfill({ response, body: body.slice(0, Math.floor(body.length / 2)) });
      },
    );
    const asked = grammarRequests(page);
    await openVault(page, {
      'Granary.md': `# Granary\n\n${fence('rust', 'fn granary() -> u32 { 12 }')}\n`,
      'Journal.md': '# Journal\n\nToday.\n',
    });
    await openNote(page, 'Granary');
    await expect.poll(() => asked.length).toBe(1);
    const block = codeBlocks(page).first();
    await expect(block).toHaveText('fn granary() -> u32 { 12 }');
    await expect(colouredIn(block)).toHaveCount(0);

    failing = false;
    await openNote(page, 'Journal');
    await openNote(page, 'Granary');
    await expect(colouredIn(codeBlocks(page).first()).first()).toBeAttached();
    expect(asked).toEqual(['rust', 'rust']);
  });
}
