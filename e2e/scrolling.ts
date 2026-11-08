/**
 * Scrolling a list the app draws only in part, and waiting until it has drawn
 * the rows for where it was scrolled to (#798).
 *
 * A virtualised list measures and places its rows over the frames after a
 * scroll. Waiting a fixed time for that is too short under load and too long
 * otherwise (`e2e-flake/no-wait-for-timeout`, tools/eslint/e2e-flake/), so
 * these wait for the list itself: until neither its rows nor its scroll have
 * changed for a few frames running.
 */
import type { Locator } from '@playwright/test';

/** Frames running in which nothing may change for the list to count as drawn. */
const QUIET_FRAMES = 5;
/** Frames after which a list that never stops changing fails the test. */
const MOST_FRAMES = 600;

/** Scroll `scroller` with `scroll`, run in the page, and wait until its rows are drawn there. */
export async function scrollThenSettle(
  scroller: Locator,
  scroll: (element: HTMLElement) => void,
): Promise<void> {
  await scroller.evaluate(scroll);
  await settled(scroller);
}

/**
 * Scroll `scroller` to its very end. Each row it draws there can make the list
 * taller, so it scrolls again until, once drawn, it is still at the end.
 */
export async function scrollToEnd(scroller: Locator): Promise<void> {
  // An element that cannot scroll is "at its end" at once: say so, rather than pass having scrolled nothing.
  const scrolls = await scroller.evaluate((element) => element.scrollHeight > element.clientHeight);
  if (!scrolls) throw new Error('scrollToEnd: the element has nothing to scroll');
  for (let tries = 0; tries < 50; tries += 1) {
    await scrollThenSettle(scroller, (element) => {
      element.scrollTop = element.scrollHeight;
    });
    const atEnd = await scroller.evaluate(
      (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
    );
    if (atEnd) return;
  }
  throw new Error('the list never reached its end');
}

/** Wait until neither the rows in `scroller` nor its scroll change for QUIET_FRAMES frames. */
async function settled(scroller: Locator): Promise<void> {
  const quiet = await scroller.evaluate(
    async (element, { quietFrames, mostFrames }) => {
      let changed = false;
      const watcher = new MutationObserver(() => {
        changed = true;
      });
      watcher.observe(element, { childList: true, subtree: true, attributes: true });
      const place = () => `${element.scrollTop}/${element.scrollHeight}`;
      let last = place();
      let still = 0;
      for (let frame = 0; frame < mostFrames && still < quietFrames; frame += 1) {
        await new Promise((done) => requestAnimationFrame(done));
        const now = place();
        still = changed || now !== last ? 0 : still + 1;
        changed = false;
        last = now;
      }
      watcher.disconnect();
      return still >= quietFrames;
    },
    { quietFrames: QUIET_FRAMES, mostFrames: MOST_FRAMES },
  );
  if (!quiet) throw new Error(`the list was still changing after ${MOST_FRAMES} frames`);
}
