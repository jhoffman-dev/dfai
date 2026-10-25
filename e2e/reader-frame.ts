import type { Frame, Page } from '@playwright/test';

/** The chapter's frame, to run a script in as a test (the book's own never run). */
export async function frameOf(page: Page): Promise<Frame> {
  const frame = await (await page.locator('iframe.epub-frame').elementHandle())?.contentFrame();
  if (frame === null || frame === undefined) throw new Error('the reader shows no chapter');
  return frame;
}

/** The words each highlight of the frame's registry under `name` covers. */
export async function painted(page: Page, name: string): Promise<string[]> {
  const frame = await frameOf(page);
  return frame.evaluate((wanted) => {
    const highlight = CSS.highlights.get(wanted);
    return highlight === undefined ? [] : [...highlight].map((range) => range.toString());
  }, name);
}
