import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  emitVaultChanged,
  installHost,
  type FakeHost,
  type FakeVault,
} from './host.ts';

/**
 * Attack on #130 (PR #283), in WebKit. The PR holds the Inbox's rows until its
 * five offers are read (or 1 s passes), then keeps any later offer for the
 * next open. The invariant under attack: once a row is on screen, nothing
 * arriving late moves it, and the rows stay reachable whatever is still read.
 */

const ROWS = 4;

const PROPOSAL = [
  '---',
  'type: proposal',
  'kind: task',
  'state: open',
  'confidence: high',
  'made_by: after-meeting · run 1',
  'payload:',
  '  title: Send Tobias the file',
  '---',
  '',
  'Mara Quill asked for it.',
  '',
].join('\n');

/** A settings note whose frontmatter does not parse, so the Inbox warns that it is unreadable. */
const BROKEN_SETTINGS = ['---', 'name: [Mara Quill', 'quickAdd: [task', '---', ''].join('\n');

const inboxButton = (page: Page) => page.getByRole('button', { name: /^Inbox/ });
const inboxArticle = (page: Page) => page.getByRole('article', { name: 'Inbox' });
/** The row's title button found by markup, so it is found while held (hidden, inert) too. */
const drawnRow = (page: Page, n: number) =>
  page.locator('.inbox__grid button').filter({ hasText: new RegExp(`^Item ${n}$`) });
const row = (page: Page, n: number) =>
  inboxArticle(page).getByRole('button', { name: `Item ${n}`, exact: true });

async function vaultWithRows(): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('Inbox');
  for (let n = 1; n <= ROWS; n++) await vault.write(`Inbox/Item ${n}.md`, `Body of item ${n}.\n`);
  return vault;
}

/**
 * Opens the vault. With `hold`, the tidy's read of that loose note is held
 * from the start (the fix round reads the offers as soon as the index is
 * ready, before the Inbox opens), except within the index's own read of
 * every note, which reads the first row's note too.
 */
async function openVault(
  page: Page,
  vault: FakeVault,
  hold?: string,
): Promise<{ host: FakeHost; release: () => void }> {
  const host = await installHost(page, vault);
  const release =
    hold === undefined ? () => {} : host.holdReads(hold, { except: 'Inbox/Item 1.md' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 60_000 });
  return { host, release };
}

/**
 * Stops the page's timers until `heldUntil` lets them go. The Inbox holds its
 * rows for its offers only until a timer runs out (`INBOX_OFFERS_WAIT_MS`),
 * and its rows are read as it opens: on a loaded runner they came after the
 * limit, already shown, and a test of the hold found nothing held (Linux CI,
 * run 41209303574). With the timer stopped the rows always come while held.
 */
async function timersStopped(page: Page): Promise<() => Promise<void>> {
  await page.clock.install();
  // The page's own time, not this process's, with room for the call to land:
  // a time the page has passed is refused (run 41223511320). The jump comes
  // before the Inbox opens, so the hold's own timer is not among those it fires.
  const pageNow = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(pageNow + 1_000);
  return () => page.clock.resume();
}

/**
 * Clicks the Inbox button in the page and reads the row titled `title` the
 * moment it is first put in the page — before the hold can run out (its
 * timer is set only after that commit is painted): whether it is hidden,
 * inside something inert, and whether a script's focus() lands on it.
 */
function heldAtMount(
  page: Page,
  title: string,
): Promise<{ hidden: boolean; inert: boolean; tookFocus: boolean }> {
  return inboxButton(page)
    .first()
    .evaluate(
      (button: HTMLElement, title) =>
        new Promise((resolve) => {
          const find = () =>
            [...document.querySelectorAll<HTMLElement>('.inbox__grid button')].find(
              (button) => button.textContent?.trim() === title,
            );
          const look = () => {
            const found = find();
            if (found === undefined) return false;
            observer.disconnect();
            found.focus();
            resolve({
              // Not seen, however it is hidden: hidden itself, or under a transparent block.
              hidden: (function unseen(element: Element | null): boolean {
                if (element === null) return false;
                const style = getComputedStyle(element);
                return (
                  style.visibility === 'hidden' ||
                  style.opacity === '0' ||
                  unseen(element.parentElement)
                );
              })(found),
              inert: found.closest('[inert]') !== null,
              tookFocus: document.activeElement === found,
            });
            return true;
          };
          const observer = new MutationObserver(() => void look());
          observer.observe(document.body, { childList: true, subtree: true });
          button.click();
        }),
      title,
    );
}

/** How far, at most, the Inbox row titled `title` moved over the next `frames` frames. */
function largestMove(page: Page, title: string, frames: number): Promise<number> {
  return page.evaluate(
    async ({ title, frames }) => {
      const find = () =>
        [...document.querySelectorAll('.inbox__grid button')].find(
          (button) => button.textContent?.trim() === title,
        );
      const at = () => find()?.getBoundingClientRect().top ?? Number.NaN;
      const start = at();
      let largest = 0;
      for (let frame = 0; frame < frames; frame++) {
        await new Promise((done) => requestAnimationFrame(done));
        const now = at();
        largest = Math.max(largest, Number.isNaN(now) ? Infinity : Math.abs(now - start));
      }
      return largest;
    },
    { title, frames },
  );
}

/**
 * Clicks the Inbox button in the page and counts, frame by frame, how long
 * until the row titled `title` is both drawn and visible.
 */
function msUntilRowVisible(page: Page, title: string): Promise<number> {
  // The button found by role, so Playwright waits for the sidebar to draw it.
  return inboxButton(page)
    .first()
    .evaluate(async (button: HTMLElement, title) => {
      const visible = () => {
        const found = [...document.querySelectorAll('.inbox__grid button')].find(
          (b) => b.textContent?.trim() === title,
        );
        return found !== undefined && getComputedStyle(found).visibility === 'visible';
      };
      const start = performance.now();
      button.click();
      while (!visible()) {
        await new Promise((done) => requestAnimationFrame(done));
        if (performance.now() - start > 10_000) return Infinity;
      }
      return performance.now() - start;
    }, title);
}

test('on a vault with nothing to offer, the rows show without waiting out the 1 s hold (#130 attack)', async ({
  page,
}) => {
  const vault = await vaultWithRows();
  await openVault(page, vault);
  const ms = await msUntilRowVisible(page, 'Item 1');
  test.info().annotations.push({ type: 'hold-ms', description: ms.toFixed(0) });
  console.warn(`#130 attack: Inbox open → rows visible in ${ms.toFixed(0)} ms`);
  expect(ms).toBeLessThan(1000);
});

/**
 * The row is where it was. Within half a pixel: the page lays out in
 * fractions of a pixel, and a scroller is scrolled by whole ones, so holding
 * a row still across a 46.625px arrival leaves it at most that far off.
 */
function expectSteady(now: number, before: number): void {
  expect(Math.abs(now - before)).toBeLessThanOrEqual(0.5);
}

/** Where the row's top edge is now, in the viewport. */
async function topOf(page: Page, n: number): Promise<number> {
  const box = await row(page, n).boundingBox();
  if (box === null) throw new Error(`Item ${n} is not laid out`);
  return box.y;
}

test('a settings-note warning that arrives after the rows are drawn does not move them (#130 attack)', async ({
  page,
}) => {
  const vault = await vaultWithRows();
  await openVault(page, vault);
  await inboxButton(page).click();
  await expect(row(page, 3)).toBeVisible();
  const before = await topOf(page, 3);

  // The settings note turns unreadable while the Inbox is open (a sync, an edit elsewhere).
  await vault.mkdir('.atlas');
  await vault.write('.atlas/settings.md', BROKEN_SETTINGS);
  await emitVaultChanged(page, ['.atlas/settings.md']);
  await expect(
    page.getByRole('alert', { name: 'Meetings and automations are paused' }),
  ).toBeVisible();
  expectSteady(await topOf(page, 3), before);
});

test('a proposals section that arrives after the rows are drawn does not move them (#130 attack)', async ({
  page,
}) => {
  const vault = await vaultWithRows();
  await openVault(page, vault);
  await inboxButton(page).click();
  await expect(row(page, 3)).toBeVisible();
  const before = await topOf(page, 3);

  // An automation leaves a proposal while the Inbox is open.
  await vault.mkdir('Inbox/Proposals');
  await vault.write('Inbox/Proposals/Send Tobias the file.md', PROPOSAL);
  await emitVaultChanged(page, ['Inbox/Proposals/Send Tobias the file.md']);
  await expect(page.getByRole('region', { name: 'Proposals' })).toBeVisible({ timeout: 10_000 });
  expectSteady(await topOf(page, 3), before);
});

test('an offer that never resolves: the rows show at the limit, work, and the offer comes on the next open (#130 attack)', async ({
  page,
}) => {
  const vault = await vaultWithRows();
  await vault.write('Loose idea.md', 'A thought.\n');
  const { release } = await openVault(page, vault, 'Loose idea.md');
  const heldUntil = await timersStopped(page);
  // Held, not missing: drawn but not visible until the limit.
  const held = await heldAtMount(page, 'Item 2');
  expect(held.hidden).toBe(true);
  await heldUntil();
  await expect(drawnRow(page, 2)).toBeAttached();
  await expect(row(page, 2)).toBeVisible({ timeout: 3_000 });
  await row(page, 2).click();
  await expect(page.getByText('Body of item 2.')).toBeVisible();

  release();
  await inboxButton(page).click();
  await expect(page.getByRole('region', { name: 'Tidy the vault' })).toBeVisible();
});

test('Tab pressed while the rows are held never focuses a hidden row, and a row takes focus once shown (#130 attack)', async ({
  page,
}) => {
  const vault = await vaultWithRows();
  await vault.write('Loose idea.md', 'A thought.\n');
  const { release } = await openVault(page, vault, 'Loose idea.md');
  const heldUntil = await timersStopped(page);
  // Drawn but held: in the page, not seen, and not even a script's focus() lands on it.
  const held = await heldAtMount(page, 'Item 1');
  expect(held).toEqual({ hidden: true, inert: true, tookFocus: false });
  await expect(drawnRow(page, 1)).toBeAttached();
  for (let n = 0; n < 8; n++) {
    await page.keyboard.press('Tab');
    const inHidden = await page.evaluate(() => {
      const active = document.activeElement;
      return active !== null && active.closest('[inert]') !== null;
    });
    expect(inHidden).toBe(false);
  }
  await heldUntil();
  await expect(row(page, 1)).toBeVisible({ timeout: 3_000 });
  // Once shown, the inert is lifted: a row takes focus.
  await row(page, 1).focus();
  await expect(row(page, 1)).toBeFocused();
  release();
});

test('leaving the Inbox and coming back at once: rows still steady when the held offer lands (#130 attack)', async ({
  page,
}) => {
  const vault = await vaultWithRows();
  await vault.write('Loose idea.md', 'A thought.\n');
  await vault.write('Plan.md', '# Plan\n');
  const { release } = await openVault(page, vault, 'Loose idea.md');
  await inboxButton(page).click();
  await expect(inboxArticle(page)).toBeVisible();
  // Away and back within a frame or two.
  await page.getByRole('treeitem', { name: 'Plan', exact: true }).click();
  await inboxButton(page).click();
  await expect(row(page, 3)).toBeVisible({ timeout: 3_000 });

  release();
  expect(await largestMove(page, 'Item 3', 60)).toBe(0);
});
