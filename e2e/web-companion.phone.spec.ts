import { expect, test, type Page } from './fixtures.ts';
import { signInOnTheWeb, webVaultOnGitHub } from './web-github.ts';

/**
 * #672: the web build on a phone, by thumb. This spec runs only in the `phone`
 * project (playwright.config.ts): WebKit at 390×844 with a touch screen. The
 * bar along the bottom edge offers the day's three jobs — quick add, Today,
 * Notes; here quick add, which writes a note into the Inbox on GitHub. Made
 * offline it is refused for now — the save queue (#667) takes edits, not new
 * notes, a follow-up of its own — and the palette keeps the text and says
 * why, so nothing typed is lost. Which screens the bar holds, and at what
 * width, is the domain's (`shellLayoutFor`, held by its own test).
 *
 * Today and Notes read the vault's index, and the web's index lives in OPFS,
 * which Playwright's WebKit does not give an ephemeral context
 * (`navigator.storage.getDirectory()` fails with UnknownError). Those two
 * screens are driven on the stub host at the same width in
 * core-loop.phone.spec.ts, where the same rule draws the same bar.
 */

const PHONE = { width: 390, height: 844 };

const FILES: Record<string, string> = {
  'Garden plan.md': '# Garden plan\n\nFirst line.\n',
};

const bar = (page: Page) => page.getByRole('navigation', { name: 'Screens' });
const quickAdd = (page: Page) => bar(page).getByRole('button', { name: 'Quick add', exact: true });
const capture = (page: Page) => page.getByRole('dialog', { name: 'Capture a task' });
const captureField = (page: Page) =>
  capture(page).getByRole('textbox', { name: 'What needs doing' });

test('on a phone, the bar stands along the bottom edge with the three screens, each 44px or more to the thumb', async ({
  page,
}) => {
  await webVaultOnGitHub(page, FILES);
  await signInOnTheWeb(page);
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  expect(page.viewportSize()).toEqual(PHONE);

  const buttons = bar(page).getByRole('button');
  await expect(buttons).toHaveText(['Quick add', 'Today', 'Notes']);
  for (const button of await buttons.all()) {
    const box = await button.boundingBox();
    if (box === null) throw new Error('A screen’s button is not on the page.');
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    // Along the bottom edge, and inside the screen: nothing to reach for.
    expect(box.y + box.height).toBeGreaterThan(PHONE.height - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(PHONE.height);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
  }
  // The web's sign-out floats at the bottom-left corner; with the bar there it stands clear of it.
  const signOut = await page.getByRole('button', { name: 'Sign out' }).boundingBox();
  const firstScreen = await buttons.first().boundingBox();
  if (signOut === null || firstScreen === null) throw new Error('Sign out or the bar is missing.');
  expect(signOut.y + signOut.height).toBeLessThanOrEqual(firstScreen.y);
});

test('on a phone, quick add writes a note into the Inbox on GitHub, and stays up for another', async ({
  page,
}) => {
  const { github } = await webVaultOnGitHub(page, FILES);
  await signInOnTheWeb(page);

  await quickAdd(page).tap();
  await expect(capture(page)).toBeVisible();
  await captureField(page).fill('Call Tobias Fenn');
  await page.keyboard.press('Enter');

  await expect.poll(() => github.paths()).toContain('Inbox/Call Tobias Fenn.md');
  // Enter means "add, and add another": the field is clear and the palette still up.
  await expect(captureField(page)).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(capture(page)).toHaveCount(0);
  // The capture is open under where the palette was, to add to.
  await expect(page.getByRole('article', { name: 'Call Tobias Fenn' })).toBeVisible();
});

test('on a phone, a quick add refused offline keeps its text and says why; back online, Enter commits it', async ({
  page,
  context,
}) => {
  const { github } = await webVaultOnGitHub(page, FILES);
  await signInOnTheWeb(page);
  await expect(quickAdd(page)).toBeVisible();
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);

  await quickAdd(page).tap();
  await captureField(page).fill('Buy seed');
  await page.keyboard.press('Enter');
  const refusal = capture(page).getByRole('alert');
  await expect(refusal).toHaveText(/needs a connection/);
  await expect(captureField(page)).toHaveValue('Buy seed');
  expect(await github.paths()).not.toContain('Inbox/Buy seed.md');

  await context.setOffline(false);
  await page.keyboard.press('Enter');
  await expect.poll(() => github.paths()).toContain('Inbox/Buy seed.md');
  await expect(captureField(page)).toHaveValue('');
  await expect(refusal).toHaveCount(0);
});
