import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost } from './host.ts';
import { macOnly } from './platform.ts';

/**
 * Attack on PR #371 (UI v2 slice 13f): Settings' list of sections in a narrow
 * window, a row's scroll, quick Match system toggling in WebKit, and the
 * theme on first paint.
 */

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
const list = (page: Page) => settings(page).getByRole('navigation', { name: 'Settings sections' });
const matchSystem = (page: Page) => settings(page).getByRole('switch', { name: 'Match system' });
const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset['theme']);

async function openVault(page: Page): Promise<void> {
  const vault = await createVault();
  await vault.write('note.md', '# Note\n\nBody.\n');
  await vault.write('other.md', '# Other\n\nBody.\n');
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
}

/** By its key: at the narrow widths here the sidebar, with its Settings button, is a drawer (#658). */
async function openSettings(page: Page): Promise<void> {
  await page.keyboard.press('Meta+Comma');
  await expect(settings(page)).toBeVisible();
  await expect(settings(page).getByRole('heading', { name: 'Sync', exact: true })).toHaveCount(1);
}

/** Whether a row's title runs past what its list shows: the nav's edge, inside its border. */
function titleCut(button: HTMLElement): boolean {
  const text = [...button.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
  if (text === undefined) return false;
  const nav = button.closest('nav')!;
  const range = document.createRange();
  range.selectNodeContents(text);
  const visibleRight =
    nav.getBoundingClientRect().right - parseFloat(getComputedStyle(nav).borderRightWidth);
  return range.getBoundingClientRect().right > visibleRight;
}

test(
  'at the narrowest window, no row in the list of sections is cut off',
  macOnly('laid out in macOS’s system font; Linux WebKit falls back to a wider one'),
  async ({ page }) => {
    // tauri.conf.json's minWidth.
    await page.setViewportSize({ width: 720, height: 480 });
    await openVault(page);
    await openSettings(page);

    const rows = await list(page)
      .getByRole('button')
      .evaluateAll((buttons, cut) => {
        const isCut = new Function(`return (${cut})`)() as (button: HTMLElement) => boolean;
        return buttons.map((button) => ({
          text: button.textContent,
          cut: isCut(button as HTMLElement),
        }));
      }, titleCut.toString());
    expect(rows.length).toBeGreaterThan(4);
    expect(rows.filter((row) => row.cut)).toEqual([]);

    // The measure can see a cut title: one far longer than the list is wide.
    const longCut = await list(page)
      .getByRole('button')
      .first()
      .evaluate((button, cut) => {
        const isCut = new Function(`return (${cut})`)() as (button: HTMLElement) => boolean;
        const clone = button.cloneNode(true) as HTMLElement;
        clone.lastChild!.textContent += ' and a title much too long for the list of sections';
        button.parentElement!.append(clone);
        const result = isCut(clone);
        clone.remove();
        return result;
      }, titleCut.toString());
    expect(longCut).toBe(true);
  },
);

test('the list of sections does not overflow sideways: its rows stay inside it', async ({
  page,
}) => {
  await openVault(page);
  await openSettings(page);
  const geometry = await list(page).evaluate((nav) => {
    const style = getComputedStyle(nav);
    const inner =
      nav.getBoundingClientRect().right -
      parseFloat(style.borderRightWidth) -
      parseFloat(style.paddingRight);
    const rows = [...nav.querySelectorAll('button')].map(
      (row) => row.getBoundingClientRect().right,
    );
    return {
      scrollWidth: nav.scrollWidth,
      clientWidth: nav.clientWidth,
      overrun: Math.max(...rows) - inner,
    };
  });
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.overrun).toBeLessThanOrEqual(0.5);
});

test('at the narrowest window, the dialog fits and the last row can be reached', async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 480 });
  await openVault(page);
  await openSettings(page);

  const box = await settings(page).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(720);
  expect(box!.y + box!.height).toBeLessThanOrEqual(480);

  const last = list(page).getByRole('button', { name: 'Sync', exact: true });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await last.click();
  await expect(settings(page).getByRole('heading', { name: 'Sync', exact: true })).toBeFocused();
});

test('a row scrolls the sections, not the dialog’s head out of sight', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 520 });
  await openVault(page);
  await openSettings(page);

  await list(page).getByRole('button', { name: 'Claude', exact: true }).click();

  await expect(
    settings(page).getByRole('heading', { name: 'Claude', exact: true }),
  ).toBeInViewport();
  await expect(
    settings(page).getByRole('heading', { name: 'Settings', exact: true }),
  ).toBeInViewport();
  await expect(settings(page).getByRole('button', { name: 'Close' })).toBeInViewport();
  await expect(
    list(page).getByRole('button', { name: 'Appearance', exact: true }),
  ).toBeInViewport();
});

test('Match system toggled quickly ends where the switch says, and storage agrees', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openVault(page);
  await openSettings(page);
  await expect(matchSystem(page)).toHaveAttribute('aria-checked', 'true');

  for (let i = 0; i < 5; i += 1) await matchSystem(page).click({ delay: 0 });

  // Five flips from on: off, with what was showing (dark) chosen.
  await expect(matchSystem(page)).toHaveAttribute('aria-checked', 'false');
  expect(await page.evaluate(() => window.localStorage.getItem('atlas.theme'))).toBe('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => theme(page)).toBe('dark');
});

test('Match system survives storage refusing every write, for the session', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    Storage.prototype.removeItem = () => {
      throw new DOMException('denied', 'SecurityError');
    };
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await openVault(page);
  await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  await expect.poll(() => theme(page)).toBe('dark');
  await openSettings(page);
  await expect(matchSystem(page)).toHaveAttribute('aria-checked', 'false');
  await matchSystem(page).click();
  await expect(matchSystem(page)).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => theme(page)).toBe('light');
});

test('a malformed stored theme reads as Match system on, and follows the system', async ({
  page,
}) => {
  await page.addInitScript(() => window.localStorage.setItem('atlas.theme', 'DARK'));
  await page.emulateMedia({ colorScheme: 'light' });
  await openVault(page);
  expect(await theme(page)).toBe('light');
  await openSettings(page);
  await expect(matchSystem(page)).toHaveAttribute('aria-checked', 'true');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => theme(page)).toBe('dark');
});

test('a stored choice against the system is in force before the app first paints', async ({
  page,
}) => {
  // Records the root's theme as the document finishes parsing — before React's
  // first commit, which is when the hook's effect writes `data-theme`.
  await page.addInitScript(() => {
    window.localStorage.setItem('atlas.theme', 'dark');
    document.addEventListener('DOMContentLoaded', () => {
      (window as unknown as { atFirstParse: string }).atFirstParse =
        getComputedStyle(document.documentElement).colorScheme +
        '|' +
        (document.documentElement.dataset['theme'] ?? 'unset');
    });
  });
  await installHost(page, await createVault());
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect.poll(() => theme(page)).toBe('dark');
  const atFirstParse = await page.evaluate(
    () => (window as unknown as { atFirstParse: string }).atFirstParse,
  );
  expect(atFirstParse.split('|')[1]).toBe('dark');
});
