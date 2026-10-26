import { expect, test } from './fixtures.ts';
import { painted } from './reader-frame.ts';

/*
 * The reader shows each chapter in a new frame and removes the last one
 * (#577), so a test reading the chapter on screen can find a frame that is
 * on its way out. Here each frame is swapped out as soon as it has painted,
 * so the reads keep landing in a swap, as a slow runner sees a chapter
 * change. Every read must answer rather than throw: a throw inside
 * `expect.poll` fails the test at once instead of asking again.
 */

const CHAPTER = `<!doctype html><body><p>The Grasshopper had no food</p><script>
  const range = document.createRange();
  range.selectNodeContents(document.querySelector('p'));
  CSS.highlights.set('probe', new Highlight(range));
  parent.postMessage('painted', '*');
</script></body>`;

test('reading the painted marks while the chapter frame is swapped answers every time', async ({
  page,
}) => {
  await page.setContent('<main></main>');
  await page.evaluate((srcdoc) => {
    const host = document.querySelector('main') as HTMLElement;
    const swap = () => {
      host.querySelector('iframe')?.remove();
      const frame = document.createElement('iframe');
      frame.className = 'epub-frame';
      frame.srcdoc = srcdoc;
      host.append(frame);
    };
    // The frame sets the pace, not the clock: each one paints before it is swapped, however slow the runner,
    // and stays a moment after so that some reads find it painted.
    window.addEventListener('message', () => setTimeout(swap, 20));
    swap();
  }, CHAPTER);

  const seen: string[][] = [];
  for (let read = 0; read < 300; read += 1) seen.push(await painted(page, 'probe'));

  expect(seen).toContainEqual(['The Grasshopper had no food']);
  for (const marks of seen) expect([[], ['The Grasshopper had no food']]).toContainEqual(marks);
});
