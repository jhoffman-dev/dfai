/**
 * Driving dnd-kit the way a person does: a real pointer, or a real keyboard.
 *
 * The board, calendar and timeline listen for pointer and key events, not for
 * HTML5 DragEvents, so these move the mouse and press keys rather than
 * dispatching anything synthetic.
 */
import { expect, type Locator, type Page } from '@playwright/test';

interface Point {
  x: number;
  y: number;
}

async function centreOf(target: Locator): Promise<Point> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('drag target is not on screen');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * What the drag last told a screen reader: where it is, in words. Each drag
 * surface has its own live region — Pages' tree has one beside any board — so
 * this is the one that has said something.
 */
export const dragAnnouncement = (page: Page) =>
  page.locator('[id^="DndLiveRegion"]').filter({ hasText: /\S/ });

/** Everything the drag surfaces' live regions say now. */
const announced = async (page: Page) =>
  (await page.locator('[id^="DndLiveRegion"]').allTextContents()).join('\n');

/**
 * Press on `source`, travel to `to` in small steps, and release once the drag
 * says it is where it was sent.
 *
 * The first short hop is what turns the press into a drag: dnd-kit waits for a
 * few pixels of travel so that a press that goes nowhere stays a click.
 *
 * `overText` is not decoration. Pointer moves are low-priority updates, and on
 * a loaded machine the render that works out what is under the item can lag
 * the last move; release before it lands and the drop goes where the item
 * *was*. A person lets go once they see the target light up. The announcement
 * is that same state, in words, and it changes in the same render as the
 * target the drop will read — so waiting for it is waiting for the state, not
 * for a moment.
 *
 * A target near the edge of a scrolling view (a board in a split pane) makes
 * dnd-kit scroll the view, and the target slides out from under the pointer.
 * So the pointer keeps re-aiming until the target has stopped moving and the
 * drag says it is over it — which is what a hand does.
 */
export async function dragWithPointer(
  page: Page,
  {
    from,
    to,
    overText,
  }: {
    /** What to press on, or exactly where: a timeline bar lands by where it was grabbed. */
    from: Locator | Point;
    to: Locator | Point;
    overText: string | RegExp;
  },
) {
  const start = 'x' in from ? from : await centreOf(from);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 8, start.y + 8, { steps: 4 });
  const first = 'x' in to ? to : await centreOf(to);
  await page.mouse.move(first.x, first.y, { steps: 20 });
  await expect(async () => {
    if (!('x' in to)) {
      const aim = await centreOf(to);
      await page.mouse.move(aim.x, aim.y, { steps: 2 });
      expect(await centreOf(to), 'the target is still scrolling').toEqual(aim);
    }
    await expect(dragAnnouncement(page)).toContainText(overText, { timeout: 250 });
  }).toPass({ timeout: 10_000 });
  await page.mouse.up();
  await pointerSensorReleased(page);
}

/**
 * After a pointer drop, dnd-kit keeps swallowing clicks and clearing the text
 * selection until a 50ms timer lets go (so the drop is not also a click): a
 * capture-phase listener on the document stops every click short of its
 * target. A person never clicks that soon; a test can, and its click into an
 * editor then vanishes.
 *
 * So this waits for the state itself — a click reaching its target again —
 * rather than out-sleeping the timer. The drop announcement and `aria-pressed`
 * are no use here: both change at the drop, before the timer has fired. The
 * probe click does not bubble, so nothing but the probe hears it arrive.
 */
async function pointerSensorReleased(page: Page) {
  const clickReachesItsTarget = () =>
    page.evaluate(() => {
      const probe = document.createElement('div');
      let reached = false;
      probe.addEventListener('click', () => {
        reached = true;
      });
      document.body.append(probe);
      probe.dispatchEvent(new MouseEvent('click', { bubbles: false }));
      probe.remove();
      return reached;
    });
  await expect
    .poll(clickReachesItsTarget, { message: 'dnd-kit is still swallowing clicks', intervals: [16] })
    .toBe(true);
}

/** A board card, found by its note's path, dragged by the pointer onto a column, named as its heading reads. */
export async function dragCardTo(page: Page, path: string, column: string) {
  await dragWithPointer(page, {
    from: page.locator(`.board__card[data-path="${path}"]`),
    to: page.locator('.board').getByRole('region', { name: column, exact: true }),
    overText: `is over ${column}.`,
  });
}

/**
 * Press Tab until `handle` has focus, the way a keyboard user reaches it, and
 * fail rather than loop forever if it never does.
 */
export async function tabTo(page: Page, handle: Locator, { limit = 80 } = {}) {
  await handle.waitFor();
  for (let presses = 0; presses < limit; presses += 1) {
    if (await handle.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(handle).toBeFocused();
}

/**
 * Tab to `handle`, Space to pick it up, each key in `moves`, then `finish` —
 * Space to drop, or Escape to cancel.
 */
export async function dragWithKeyboard(
  page: Page,
  handle: Locator,
  moves: readonly string[],
  { finish = 'Space' }: { finish?: 'Space' | 'Escape' } = {},
) {
  await tabTo(page, handle);
  await page.keyboard.press('Space');
  // Picked up: dnd-kit marks the handle pressed for as long as it is held.
  await expect(handle).toHaveAttribute('aria-pressed', 'true');
  // But not yet listening: dnd-kit's keyboard sensor adds its key listener from
  // a timer it sets at the pick-up, and on a loaded runner the timer can run
  // after the next key, which is then lost. Timers set with the same delay run
  // in the order they were set, so once one set now has run, the sensor's has.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)));
  for (const move of moves) {
    const before = await announced(page);
    await page.keyboard.press(move);
    // dnd-kit says where a move went once it has measured it; a key pressed
    // before then moves from the old place, and on a slower runner (Linux CI)
    // a second ArrowRight was lost that way. So each key waits, as a person's would.
    await expect.poll(() => announced(page)).not.toBe(before);
  }
  await page.keyboard.press(finish);
  await expect(handle).not.toHaveAttribute('aria-pressed', 'true');
}
