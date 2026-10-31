import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost } from './host.ts';

// P13-02, moved by P16-02, one button since UI v2 slice 3a (#294): light or
// dark, a sun or a moon in the sidebar's foot, remembered per viewer. The look
// is UI v2's (docs/design/ui-v2-brief.md §3, issue #269): flat surfaces,
// pastel tints, the system font.

const openVault = async (page: Page) => {
  const vault = await createVault();
  await vault.write('note.md', '# Note\n\nBody.\n');
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByRole('navigation', { name: 'Vault' })).toBeVisible();
  return vault;
};

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset['theme']);

/** The one theme button, named for the theme it would switch to. */
const switchTo = (page: Page, theme: 'light' | 'dark') =>
  page.getByRole('button', { name: `Switch to ${theme} theme`, exact: true });

test('the switch turns the whole app over, and back', async ({ page }) => {
  await openVault(page);

  await switchTo(page, 'dark').click();
  expect(await theme(page)).toBe('dark');
  await expect(switchTo(page, 'light')).toBeVisible();
  await expect(switchTo(page, 'dark')).toHaveCount(0);

  await switchTo(page, 'light').click();
  expect(await theme(page)).toBe('light');
  await expect(switchTo(page, 'dark')).toBeVisible();
  await expect(switchTo(page, 'light')).toHaveCount(0);
});

test('the switch lives in the sidebar, beside Settings', async ({ page }) => {
  await openVault(page);
  const sidebar = page.getByRole('navigation', { name: 'Vault' });
  await expect(
    sidebar.getByRole('button', { name: /^Switch to (light|dark) theme$/ }),
  ).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
});

test('the choice survives a reload', async ({ page }) => {
  await openVault(page);
  await switchTo(page, 'dark').click();
  expect(await theme(page)).toBe('dark');

  // The host stub is installed on the page, not the document, so it survives a
  // reload — which is what makes this a real second visit.
  await page.reload();
  await expect(switchTo(page, 'light')).toBeVisible();

  expect(await theme(page)).toBe('dark');
});

/** Settings → Appearance → Match system, with Settings open. */
const matchSystem = (page: Page) =>
  page.getByRole('dialog', { name: 'Settings' }).getByRole('switch', { name: 'Match system' });

// UI v2 slice 13f (#315): nothing chosen means the app is light or dark as
// macOS is, and follows it; the sidebar's button makes a choice that holds
// whatever macOS does; Settings → Appearance → Match system clears it again.
test('Match system follows the system', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openVault(page);
  expect(await theme(page)).toBe('light');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => theme(page)).toBe('dark');
  await expect(switchTo(page, 'light')).toBeVisible();

  // A choice holds, whatever the system does.
  await switchTo(page, 'light').click();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(switchTo(page, 'dark')).toBeVisible();
  expect(await theme(page)).toBe('light');

  await page.keyboard.press('Meta+Comma');
  await expect(matchSystem(page)).toHaveAttribute('aria-checked', 'false');
  await matchSystem(page).click();
  await expect(matchSystem(page)).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => theme(page)).toBe('dark');
  // The sidebar's button agrees, once Settings is out of the way.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  await expect(switchTo(page, 'light')).toBeVisible();

  // Nothing is stored any more, so a second visit follows the system too.
  await page.reload();
  await expect(switchTo(page, 'light')).toBeVisible();
  expect(await theme(page)).toBe('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => theme(page)).toBe('light');
});

/** The design's statuses and button kinds, each with tokens the palette must carry. */
const STATUS_TONES = ['inbox', 'backlog', 'next', 'doing', 'waiting', 'review', 'done'] as const;
const BUTTON_KINDS = ['primary', 'positive', 'destructive', 'secondary', 'ghost'] as const;

/**
 * WCAG 2.1 contrast, computed in the page from the tokens as they actually
 * resolve rather than from the values written in the stylesheet. A tint or a
 * button's fill may be translucent (a dark tint is its dot at 16%), so each
 * colour is laid over the surface before it is measured.
 */
const ratios = (page: Page, pairs: readonly (readonly [string, string])[]) =>
  page.evaluate((wanted) => {
    type Rgba = [number, number, number, number];
    const root = getComputedStyle(document.documentElement);
    const parse = (token: string): Rgba => {
      const value = root.getPropertyValue(token).trim();
      if (value === 'transparent') return [0, 0, 0, 0];
      const fn = value.match(/^rgba?\(([^)]+)\)$/);
      if (fn) {
        const [r = NaN, g = NaN, b = NaN, a = 1] = (fn[1] ?? '').split(',').map(Number);
        return [r, g, b, a];
      }
      // The build minifies colours: `#ffffff` arrives as `#fff`, and a
      // translucent tint as eight hex digits, whose last pair is its alpha.
      const hex = value.replace('#', '');
      const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
      const [r = NaN, g = NaN, b = NaN, a = 255] = [0, 2, 4, 6]
        .filter((i) => i < full.length)
        .map((i) => parseInt(full.slice(i, i + 2), 16));
      return [r, g, b, a / 255];
    };
    const over = ([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba => [
      r * a + br * (1 - a),
      g * a + bg * (1 - a),
      b * a + bb * (1 - a),
      1,
    ];
    const luminance = ([r, g, b]: Rgba) => {
      const [lr, lg, lb] = [r, g, b].map((value) => {
        const scaled = value / 255;
        return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    };
    const surface = parse('--surface');
    return wanted.map(([fore, back]) => {
      const ground = over(parse(back), surface);
      const [lighter, darker] = [luminance(over(parse(fore), ground)), luminance(ground)].sort(
        (a, b) => b - a,
      ) as [number, number];
      return { pair: `${fore} on ${back}`, ratio: (lighter + 0.05) / (darker + 0.05) };
    });
  }, pairs);

/**
 * Mid-greys on a tinted ground are exactly where contrast slips, so every
 * text colour on every surface it is drawn on, each status's text on its own
 * tint and each button's text on its own fill are held to AA (4.5:1) by a
 * test rather than by having been checked once.
 */
test('text, status pills and buttons clear WCAG AA on both themes', async ({ page }) => {
  await openVault(page);
  const pairs = [
    ...['--ink', '--ink-2', '--ink-3'].flatMap((ink) =>
      ['--bg', '--surface', '--well'].map((ground) => [ink, ground] as const),
    ),
    ...STATUS_TONES.map((tone) => [`--status-${tone}-ink`, `--status-${tone}-tint`] as const),
    ...BUTTON_KINDS.map((kind) => [`--btn-${kind}-ink`, `--btn-${kind}-bg`] as const),
  ];

  for (const named of ['light', 'dark'] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset['theme'] = value;
    }, named);
    const measured = await ratios(page, pairs);
    expect(measured).toHaveLength(pairs.length);
    for (const { pair, ratio } of measured) {
      expect(ratio, `${named}: ${pair}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

// Content runs edge to edge on the surface and flat — no panel shadow, no
// rounded corners — with the sidebar the one grey beside it, in both themes.
test('the work sits flat on the surface; the sidebar is the grey beside it', async ({ page }) => {
  await openVault(page);
  const surfaces = () =>
    page.evaluate(() => {
      const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
      return {
        shell: style('.shell').backgroundColor,
        sidebar: style('.shell__sidebar').backgroundColor,
        panel: style('.panel').backgroundColor,
        radius: style('.panel').borderTopLeftRadius,
        shadow: style('.panel').boxShadow,
      };
    });

  expect(await surfaces()).toEqual({
    shell: 'rgb(255, 255, 255)',
    sidebar: 'rgb(246, 246, 247)',
    panel: 'rgb(255, 255, 255)',
    radius: '0px',
    shadow: 'none',
  });

  await switchTo(page, 'dark').click();
  expect(await surfaces()).toEqual({
    shell: 'rgb(24, 24, 27)',
    sidebar: 'rgb(17, 17, 19)',
    panel: 'rgb(24, 24, 27)',
    radius: '0px',
    shadow: 'none',
  });
});

test('the app is set in the system font, with nothing fetched', async ({ page }) => {
  const fetched: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('http://localhost') || request.resourceType() === 'font') fetched.push(url);
  });
  await openVault(page);

  const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(family).toContain('-apple-system');
  expect(family).toContain('system-ui');
  expect(family).not.toContain('Manrope');
  // The stack is the system's, so the page declares no face of its own: a
  // bundled font would show up here before it showed up as a request.
  expect(await page.evaluate(() => document.fonts.size)).toBe(0);
  expect(fetched).toEqual([]);
});
