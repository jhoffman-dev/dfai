import type { Frame, Page } from '@playwright/test';
import { expect } from './fixtures.ts';

/*
 * The reader shows each chapter in a new frame and removes the last one
 * (packages/ui/src/reader/book-frame.ts), so a frame found a moment ago may
 * already be gone. These helpers read the frame on screen now, and say
 * "none yet" while the reader is between chapters instead of throwing, so a
 * poll asks again (#577).
 */

/** The chapter's frame on screen now, or null while the reader is between chapters. */
export async function shownFrame(page: Page): Promise<Frame | null> {
  // The newest is last: each chapter's frame is appended, and an older one still there is on its way out.
  const handle = (await page.locator('iframe.epub-frame').elementHandles()).at(-1);
  // An iframe removed since it was found has no frame any more.
  return handle === undefined ? null : handle.contentFrame();
}

/** The chapter's frame, to run a script in as a test (the book's own never run), once the reader shows one. */
export async function frameOf(page: Page): Promise<Frame> {
  const found: { frame: Frame | null } = { frame: null };
  await expect
    .poll(async () => (found.frame = await shownFrame(page)) !== null, {
      message: 'the reader shows a chapter',
    })
    .toBe(true);
  if (found.frame === null) throw new Error('the reader shows no chapter');
  return found.frame;
}

/** `read` of the chapter on screen, or `between` while there is none — for a poll, which then asks again. */
export async function readShownChapter<T>(
  page: Page,
  read: (frame: Frame) => Promise<T>,
  between: T,
): Promise<T> {
  const frame = await shownFrame(page);
  if (frame === null) return between;
  try {
    return await read(frame);
  } catch (error) {
    // Safe to answer `between` only when the frame read is no longer the one on screen: the reader moved on mid-read.
    if ((await shownFrame(page)) !== frame) return between;
    throw error;
  }
}

/** The words each highlight of the chapter's registry under `name` covers; none while there is no chapter. */
export async function painted(page: Page, name: string): Promise<string[]> {
  return readShownChapter(
    page,
    (frame) =>
      frame.evaluate((wanted) => {
        const highlight = CSS.highlights.get(wanted);
        return highlight === undefined ? [] : [...highlight].map((range) => range.toString());
      }, name),
    [],
  );
}
