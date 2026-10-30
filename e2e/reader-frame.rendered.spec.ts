import { expect, test } from './fixtures.ts';
import { rendered } from './reader-frame.ts';
import { HOSTILE_ORIGIN } from '../tools/epub/fixture-epub.ts';

/*
 * The EPUB reader's no-other-site tests wait on `rendered` and then find no
 * request to the book's site. That proves something only if a request the CSS
 * did start is already recorded by then — so here, in the app's own window,
 * which the chapter frame's policy does not cover, it is.
 */

test('a load the CSS starts, and one a hover starts, are recorded once the frame has rendered', async ({
  page,
}) => {
  const hits: string[] = [];
  await page.route(`${HOSTILE_ORIGIN}/**`, (route) => {
    hits.push(new URL(route.request().url()).pathname);
    return route.abort();
  });
  await page.goto('/');
  await page.evaluate((origin) => {
    const style = document.createElement('style');
    style.textContent = `html { background-image: image-set("${origin}/background.png" 1x); }
#probe:hover { cursor: url(${origin}/cursor.png), auto; }`;
    const probe = document.createElement('div');
    probe.id = 'probe';
    probe.style.cssText =
      'position: fixed; inset: 0 auto auto 0; width: 80px; height: 80px; z-index: 2147483647';
    document.body.append(style, probe);
  }, HOSTILE_ORIGIN);
  await rendered(page.mainFrame());
  expect(hits).toEqual(['/background.png']);
  await page.locator('#probe').hover();
  await rendered(page.mainFrame());
  expect(hits).toEqual(['/background.png', '/cursor.png']);
});
