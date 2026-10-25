import type { Frame } from '@playwright/test';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost } from './host.ts';
import {
  ANT_AND_GRASSHOPPER,
  fixtureEpub,
  HARE_AND_TORTOISE,
  HOSTILE_ORIGIN,
} from '../tools/epub/fixture-epub.ts';

/*
 * Regressions from the attack on PR #536 (#505, ADR-0045), end to end in WebKit. The frame runs
 * only DFAI's script, but that script reads the frame's `document` — and an
 * HTML document's named properties shadow its own methods: `<img
 * name="createRange">` makes `document.createRange` that picture. The name
 * survives the reader's cleaning and the frame's builder, so a book can break
 * DFAI's own script in its frame: no highlight drawn, no place in the chapter
 * scrolled to. And the book's CSS, spelled in ways the
 * cleaning does not read, must still ask nothing of another site.
 */

async function openBook(page: Page, bytes: Buffer): Promise<{ hits: string[] }> {
  const hits: string[] = [];
  await page.route(`${HOSTILE_ORIGIN}/**`, (route) => {
    hits.push(route.request().url());
    return route.abort();
  });
  const vault = await createVault();
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await page.keyboard.press('Meta+k');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('Add EPUB');
  await page.getByRole('option', { name: 'Add EPUB…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add EPUB to Library' });
  await dialog
    .getByLabel('Choose EPUB')
    .setInputFiles({ name: 'clobbered.epub', mimeType: 'application/epub+zip', buffer: bytes });
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open note' })).toBeVisible();
  await expect(page.locator('.epub-reader__page[data-shown-section]')).toHaveCount(1);
  return { hits };
}

const text = (page: Page) => page.frameLocator('iframe.epub-frame').locator('body');

async function frameOf(page: Page): Promise<Frame> {
  const frame = await (await page.locator('iframe.epub-frame').elementHandle())?.contentFrame();
  if (frame === null || frame === undefined) throw new Error('the reader shows no chapter');
  return frame;
}

/** Selects `words` as a drag would, with a Range the book cannot shadow, and lets the press go. */
async function selectWords(frame: Frame, words: string): Promise<void> {
  await frame.evaluate((picked) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = (node.textContent ?? '').indexOf(picked);
      if (at === -1) continue;
      const range = new Range();
      range.setStart(node, at);
      range.setEnd(node, at + picked.length);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      node.parentElement?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return;
    }
    throw new Error(`"${picked}" is not in the chapter`);
  }, words);
}

test('a picture the book names createRange does not stop the reader drawing a highlight', async ({
  page,
}) => {
  const book = fixtureEpub({
    chapters: [
      {
        ...HARE_AND_TORTOISE,
        body: `${HARE_AND_TORTOISE.body}\n<img name="createRange" alt=""/>`,
      },
    ],
  });
  await openBook(page, book);
  await expect(text(page)).toContainText('Slow but steady wins the race.');
  await selectWords(await frameOf(page), 'Slow but steady wins the race.');
  await page
    .getByRole('toolbar', { name: 'Mark the selection' })
    .getByRole('button', { name: 'Highlight Green' })
    .click();
  await expect(
    page
      .getByRole('complementary', { name: 'Highlights' })
      .getByText('Slow but steady wins the race.'),
  ).toBeVisible();
  // The highlight is saved; the frame must also draw it.
  await expect
    .poll(async () =>
      (await frameOf(page)).evaluate(() => {
        const highlight = CSS.highlights.get('dfai-highlight-green');
        return highlight === undefined ? [] : [...highlight].map((range) => range.toString());
      }),
    )
    .toEqual(['Slow but steady wins the race.']);
});

test('a picture the book names getElementById does not stop a link to a place in the book scrolling there', async ({
  page,
}) => {
  const book = fixtureEpub({
    chapters: [
      {
        ...HARE_AND_TORTOISE,
        body: `<p><a id="far-link" href="grasshopper.xhtml#far">To the far end</a></p>\n${HARE_AND_TORTOISE.body}`,
      },
      {
        ...ANT_AND_GRASSHOPPER,
        body: `${ANT_AND_GRASSHOPPER.body}\n<img name="getElementById" alt=""/>\n<div style="height: 6000px"></div>\n<p id="far">The far end of the fable.</p>`,
      },
    ],
  });
  await openBook(page, book);
  await (await frameOf(page)).locator('#far-link').click();
  await expect(text(page)).toContainText('The far end of the fable.');
  await expect
    .poll(async () => (await frameOf(page)).evaluate(() => window.scrollY))
    .toBeGreaterThan(1000);
});

test('names that shadow the body, querySelector and a form’s members stop neither a highlight nor a link by name', async ({
  page,
}) => {
  const book = fixtureEpub({
    chapters: [
      {
        ...HARE_AND_TORTOISE,
        // The unclosed <br> is not well-formed XHTML: the reader parses this chapter as HTML.
        body: `<p><a id="far-link" href="grasshopper.xhtml#far">To the far end</a><br></p>
<img name="body" alt=""/><img name="querySelector" alt=""/>
<form name="getElementsByTagName"><input name="appendChild"/><input name="childNodes"/><input id="nodeType"/>
<p>The tortoise kept on, slow and steady.</p></form>
${HARE_AND_TORTOISE.body}`,
      },
      {
        ...ANT_AND_GRASSHOPPER,
        body: `${ANT_AND_GRASSHOPPER.body}\n<img name="querySelector" alt=""/>\n<div style="height: 6000px"></div>\n<p><a name="far">The far end of the fable.</a></p>`,
      },
    ],
  });
  await openBook(page, book);
  await expect(text(page)).toContainText('The tortoise kept on, slow and steady.');
  await selectWords(await frameOf(page), 'The tortoise kept on, slow and steady.');
  await page
    .getByRole('toolbar', { name: 'Mark the selection' })
    .getByRole('button', { name: 'Highlight Green' })
    .click();
  await expect
    .poll(async () =>
      (await frameOf(page)).evaluate(() => {
        const highlight = CSS.highlights.get('dfai-highlight-green');
        return highlight === undefined ? [] : [...highlight].map((range) => range.toString());
      }),
    )
    .toEqual(['The tortoise kept on, slow and steady.']);
  await (await frameOf(page)).locator('#far-link').click();
  await expect(text(page)).toContainText('The far end of the fable.');
  await expect
    .poll(async () => (await frameOf(page)).evaluate(() => window.scrollY))
    .toBeGreaterThan(1000);
});

test("the book's CSS, however it spells another site's address, asks nothing of it", async ({
  page,
}) => {
  const book = fixtureEpub({
    chapters: [
      {
        ...HARE_AND_TORTOISE,
        head: `<style>
@\\69mport "${HOSTILE_ORIGIN}/escaped-import.css";
h1 { background: u\\72l(${HOSTILE_ORIGIN}/escaped-url.png); }
p { background-image: image-set("${HOSTILE_ORIGIN}/image-set.png" 1x); }
.moral { filter: url(${HOSTILE_ORIGIN}/filter.svg#f); cursor: u\\72l(${HOSTILE_ORIGIN}/cursor.png), auto; }
h1 { border-image: url("${HOSTILE_ORIGIN.slice(0, 12)}\\
${HOSTILE_ORIGIN.slice(12)}/joined.png") 30; }
body { background-image: image-set(/* ) */ "${HOSTILE_ORIGIN}/paren.png" 1x); }
html { background-image: image-set(/*'#*/"${HOSTILE_ORIGIN}/quote.png" 1x/*'*/); }
</style>`,
      },
    ],
  });
  const { hits } = await openBook(page, book);
  const frame = await frameOf(page);
  await expect(text(page)).toContainText('Slow but steady wins the race.');
  // The cleaning takes these away, however they are spelled; the frame's policy stands behind it.
  expect(
    await frame.evaluate(() =>
      [...document.querySelectorAll('style')].map((s) => s.textContent).join(''),
    ),
  ).not.toContain('beacon.example.com');
  await frame.locator('.moral').hover();
  await page.waitForLoadState('networkidle');
  expect(hits).toEqual([]);
});

/** A picture of one pixel, and a font's first bytes: the book's own files its CSS names. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

test("the book's own fonts, pictures and colours in its CSS still style the chapter", async ({
  page,
}) => {
  const book = fixtureEpub({
    chapters: [
      {
        ...HARE_AND_TORTOISE,
        body: `${HARE_AND_TORTOISE.body}\n<p class="pictured" style="color: rgb(0, 128, 0); background-image: url(pics/pixel.png)">The picture.</p>`,
      },
    ],
    stylesheet: `@font-face { font-family: "Brightwater"; src: url("fonts/brightwater.woff2") format("woff2"); }
h1 { font-family: "Brightwater", serif; background-image: image-set("pics/pixel.png" 1x); }
@media screen { .pictured { border-left: 3px solid rgb(0, 0, 255); } }
p { text-indent: 1em; }
`,
    extra: [
      { name: 'OEBPS/pics/pixel.png', data: new Uint8Array(PIXEL) },
      { name: 'OEBPS/fonts/brightwater.woff2', data: new TextEncoder().encode('wOF2') },
    ],
  });
  const { hits } = await openBook(page, book);
  const frame = await frameOf(page);
  await expect(text(page)).toContainText('Slow but steady wins the race.');
  const styled = await frame.evaluate(() => {
    const p = document.querySelector('.pictured');
    const h1 = document.querySelector('h1');
    if (p === null || h1 === null) throw new Error('the chapter has no picture or title');
    return {
      css: [...document.querySelectorAll('style')].map((s) => s.textContent).join(''),
      colour: getComputedStyle(p).color,
      border: getComputedStyle(p).borderLeftColor,
      indent: getComputedStyle(p).textIndent,
      picture: getComputedStyle(p).backgroundImage,
      title: getComputedStyle(h1).backgroundImage,
      font: getComputedStyle(h1).fontFamily,
    };
  });
  expect(styled.css).toMatch(/@font-face[^}]*src: url\("data:font\/woff2;base64,[^"]+"\)/);
  expect(styled.colour).toBe('rgb(0, 128, 0)');
  expect(styled.border).toBe('rgb(0, 0, 255)');
  expect(styled.indent).not.toBe('0px');
  expect(styled.picture).toMatch(/^url\("data:image\/png;base64,/);
  expect(styled.title).toMatch(/image-set\(url\("data:image\/png;base64,/);
  expect(styled.font).toContain('Brightwater');
  expect(hits).toEqual([]);
});

// From the review of PR #536: WebKit writes out a shorthand built with var() as the book spelled
// it, with every longhand empty, so reading longhand by longhand never saw the address inside it.
test("the book's CSS asks nothing of another site through a var() inside a shorthand", async ({
  page,
}) => {
  const at = (name: string) => `"${HOSTILE_ORIGIN}/${name}.png"`;
  const book = fixtureEpub({
    chapters: [
      {
        ...HARE_AND_TORTOISE,
        head: `<style>
p { --bg: ${at('bg')}; background: image-set(var(--bg) 1x) red; }
h1 { --bi: ${at('border')}; border: 3px solid; border-image: image-set(var(--bi) 1x) 30 round; }
.moral { --ls: ${at('list')}; display: list-item; list-style: image-set(var(--ls) 1x) inside; }
body { --mask: ${at('mask')}; mask: image-set(var(--mask) 1x) no-repeat; -webkit-mask: image-set(var(--mask) 1x) no-repeat; }
html { --content: ${at('content')}; }
h1::before { content: image-set(var(--content) 1x); }
</style>`,
        body: `${HARE_AND_TORTOISE.body}\n<p style="--inline: ${at('inline').replaceAll('"', "'")}; background: -webkit-image-set(var(--inline) 1x) blue">Styled in place.</p>`,
      },
    ],
  });
  const { hits } = await openBook(page, book);
  const frame = await frameOf(page);
  await expect(text(page)).toContainText('Styled in place.');
  const css = await frame.evaluate(() =>
    [
      ...[...document.querySelectorAll('style')].map((s) => s.textContent),
      ...[...document.querySelectorAll('[style]')].map((e) => e.getAttribute('style')),
    ].join('\n'),
  );
  expect(css).not.toContain('beacon.example.com');
  await page.waitForLoadState('networkidle');
  expect(hits).toEqual([]);
});
