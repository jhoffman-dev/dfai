import { expect, test, type Page } from './fixtures.ts';
import { focusedRing, RINGED_PRIMITIVES } from './focus-ring.ts';
import { createVault, installHost, sidebarSection } from './host.ts';
import { TABLE_GROUP_HEIGHT, TABLE_ROW_HEIGHT, TODAY_ROW_HEIGHT } from './row-heights.ts';

/**
 * PR #328 (UI v2 slice 2, primitives) under attack, in WebKit, on the built
 * stylesheet: the pills and dots in every tone, the focus rings, the menu,
 * the toast's new place, and the rows the virtual lists place by estimate.
 */

const NOW = new Date(2026, 9, 13, 12, 0, 0);

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, archive]',
  '    done: archive',
  '  due: date',
  '---',
  '',
].join('\n');

const view = (layout: string, extra: readonly string[] = []) =>
  ['---', 'atlas: view', 'type: task', `layout: ${layout}`, ...extra, 'limit: 100', '---', ''].join(
    '\n',
  );

/** The seven tones a status can wear; `backlog` is the one with no `data-tone` rule of its own. */
const TONES = ['inbox', 'backlog', 'next', 'doing', 'waiting', 'review', 'done'] as const;
const THEMES = ['light', 'dark'] as const;

async function openVault(page: Page, { templates = 0 }: { templates?: number } = {}) {
  const vault = await createVault();
  for (const folder of ['.atlas/types', '.atlas/views', '.atlas/templates', 'Tasks', 'Inbox']) {
    await vault.mkdir(folder);
  }
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Sheet.md', view('table', ['columns: [status, due]']));
  await vault.write(
    '.atlas/views/Grouped.md',
    view('table', ['groupBy: status', 'columns: [status, due]']),
  );
  await vault.write('.atlas/views/Board.md', view('board', ['groupBy: status']));
  for (let at = 0; at < templates; at += 1) {
    await vault.write(`.atlas/templates/Template ${String(at).padStart(2, '0')}.md`, 'Body.\n');
  }
  // Due today, so Today lists them under "Due today", where a row says its status.
  for (const status of ['next-action', 'in-progress', 'waiting']) {
    await vault.write(
      `Tasks/Task ${status}.md`,
      ['---', 'type: task', `status: ${status}`, 'due: 2026-10-13', '---', '', 'A task.', ''].join(
        '\n',
      ),
    );
  }
  await vault.write('Field notes.md', '# Field notes\n\nA plain note.\n');
  await vault.write('Inbox/Captured.md', 'A captured line.\n');
  await installHost(page, vault);
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
}

async function setTheme(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((wanted) => {
    document.documentElement.dataset['theme'] = wanted;
  }, theme);
  await page.evaluate(() =>
    Promise.allSettled(document.getAnimations().map((running) => running.finished)),
  );
}

type Rgba = [number, number, number, number];

/** Colour maths in the page: a computed colour, laid over another, and the WCAG ratio. */
function installContrast(): void {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  let context: CanvasRenderingContext2D | null = null;
  const parse = (colour: string): Rgba => {
    context ??= canvas.getContext('2d', { willReadFrequently: true })!;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = '#000';
    context.fillStyle = colour;
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const over = ([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba => [
    r * a + br * (1 - a),
    g * a + bg * (1 - a),
    b * a + bb * (1 - a),
    1,
  ];
  const luminance = ([r, g, b]: Rgba) => {
    const [x, y, z] = [r, g, b].map((value) => {
      const scaled = value / 255;
      return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * x + 0.7152 * y + 0.0722 * z;
  };
  const ratio = (a: Rgba, b: Rgba) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  const groundOf = (element: Element): Rgba => {
    const layers: Rgba[] = [];
    for (let at: Element | null = element; at; at = at.parentElement) {
      const fill = parse(getComputedStyle(at).backgroundColor);
      if (fill[3] > 0) layers.push(fill);
      if (fill[3] >= 1) break;
    }
    let ground: Rgba = [255, 255, 255, 1];
    for (const layer of layers.reverse()) ground = over(layer, ground);
    return ground;
  };
  const COLOUR = /(?:rgba?|color|hsla?|oklch|oklab|lab|lch)\([^)]*\)|#[0-9a-f]{3,8}\b/gi;
  const indicatorColours = (element: Element): Rgba[] => {
    const style = getComputedStyle(element);
    const found: string[] = [...(style.boxShadow.match(COLOUR) ?? [])];
    if (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) {
      found.push(style.outlineColor);
    }
    return found.map(parse);
  };
  Object.assign(globalThis, { attack328: { parse, over, ratio, groundOf, indicatorColours } });
}

interface Contrast {
  parse(colour: string): Rgba;
  over(top: Rgba, under: Rgba): Rgba;
  ratio(a: Rgba, b: Rgba): number;
  groundOf(element: Element): Rgba;
  indicatorColours(element: Element): Rgba[];
}

/**
 * Lays the seven tones out as the app draws them — a pill and a bare dot on
 * the content surface, and a bare dot on the sidebar/board-well ground — and
 * returns, per tone, the pill's ink ratio and the dots' ratios.
 */
const measureTones = (page: Page) =>
  page.evaluate(
    (tones) => {
      const { parse, over, ratio, groundOf } = (globalThis as unknown as { attack328: Contrast })
        .attack328;
      document.getElementById('attack-328-tones')?.remove();
      const holder = document.createElement('div');
      holder.id = 'attack-328-tones';
      holder.innerHTML = ['surface', 'bg']
        .map(
          (ground) =>
            `<div data-ground="${ground}" style="background: var(--${ground}); padding: 8px">` +
            tones
              .map(
                (tone) =>
                  `<span class="status-pill" data-tone="${tone}"><span class="status-pill__dot"></span>${tone}</span>` +
                  `<span class="status-pill status-pill--dot" data-tone="${tone}" role="img" aria-label="${tone}"><span class="status-pill__dot"></span></span>`,
              )
              .join('') +
            '</div>',
        )
        .join('');
      document.body.append(holder);
      const results: { where: string; ratio: number }[] = [];
      for (const ground of holder.querySelectorAll<HTMLElement>('[data-ground]')) {
        const where = ground.dataset['ground']!;
        for (const pill of ground.querySelectorAll<HTMLElement>(
          '.status-pill:not(.status-pill--dot)',
        )) {
          const tone = pill.dataset['tone']!;
          const behind = groundOf(pill);
          const ink = over(parse(getComputedStyle(pill).color), behind);
          results.push({ where: `pill text ${tone} on ${where}`, ratio: ratio(ink, behind) });
        }
        for (const dotted of ground.querySelectorAll<HTMLElement>('.status-pill--dot')) {
          const tone = dotted.dataset['tone']!;
          const dot = dotted.querySelector('.status-pill__dot')!;
          const behind = groundOf(dotted);
          const fill = over(parse(getComputedStyle(dot).backgroundColor), behind);
          results.push({ where: `bare dot ${tone} on ${where}`, ratio: ratio(fill, behind) });
        }
      }
      holder.remove();
      return results;
    },
    TONES as unknown as string[],
  );

for (const theme of THEMES) {
  test(`every tone's pill text clears 4.5:1 on its tint in ${theme}`, async ({ page }) => {
    await page.addInitScript(installContrast);
    await openVault(page);
    await setTheme(page, theme);
    const measured = (await measureTones(page)).filter((one) => one.where.startsWith('pill'));
    expect(measured).toHaveLength(TONES.length * 2);
    const short = measured.filter((one) => one.ratio < 4.5);
    expect(short, JSON.stringify(short)).toEqual([]);
  });

  test(`every tone's bare dot clears 3:1 against its ground in ${theme}`, async ({ page }) => {
    await page.addInitScript(installContrast);
    await openVault(page);
    await setTheme(page, theme);
    const measured = (await measureTones(page)).filter((one) => one.where.startsWith('bare'));
    expect(measured).toHaveLength(TONES.length * 2);
    const short = measured
      .filter((one) => one.ratio < 3)
      .map((one) => `${one.where} ${one.ratio.toFixed(2)}`);
    expect(short).toEqual([]);
  });
}

/**
 * The 4px of a `--ring` (2px surface + 2px focus) drawn outside a control is
 * cut off when a scroller or a clipped box around it hugs the control's edge.
 * Returns each clipped side, if any, for the element that has the focus.
 */
const ringClipping = (page: Page) =>
  page.evaluate(() => {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || focused === document.body) return 'nothing focused';
    const spread = 4;
    // Where Tab scrolled it to is a moment, not the layout: centre it first so
    // only a box that hugs the control can clip its ring.
    focused.scrollIntoView({ block: 'center', inline: 'center' });
    const box = focused.getBoundingClientRect();
    const clipped: string[] = [];
    for (let at = focused.parentElement; at; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const edge = at.getBoundingClientRect();
      const name = `${at.tagName.toLowerCase()}.${[...at.classList].join('.')}`;
      if (box.left - spread < edge.left - 0.5) clipped.push(`left by ${name}`);
      if (box.right + spread > edge.right + 0.5) clipped.push(`right by ${name}`);
      if (box.top - spread < edge.top - 0.5) clipped.push(`top by ${name}`);
      if (box.bottom + spread > edge.bottom + 0.5) clipped.push(`bottom by ${name}`);
    }
    const label = `${focused.tagName.toLowerCase()}.${[...focused.classList].join('.')} "${(focused.getAttribute('aria-label') ?? focused.textContent ?? '').trim().slice(0, 30)}"`;
    return clipped.length === 0 ? null : `${label}: ${clipped.join(', ')}`;
  });

/**
 * Focuses each primitive on the surface in turn — inside the open dialog, or
 * the main panel — and returns how many took the focus, and each clipped ring.
 *
 * Focused from script, after one Tab so the focus counts as the keyboard's
 * (`:focus-visible`), rather than reached by tabbing: WebKit's Tab skips a
 * plain `<button>` with no `tabindex` of its own, which is what a `.btn` is,
 * so a Tab walk never lands on the controls this is about (#294 found the
 * walk's only stop had been the sidebar's old theme radios).
 */
async function focusEachAndCollectClipping(
  page: Page,
): Promise<{ seen: number; clipped: string[] }> {
  await page.keyboard.press('Tab');
  const count = await page.evaluate((primitives) => {
    const scope =
      document.querySelector('[role="dialog"]') ?? document.querySelector('.shell__main');
    const found = [...(scope?.querySelectorAll(primitives) ?? [])];
    (globalThis as { attack328Primitives?: Element[] }).attack328Primitives = found;
    return found.length;
  }, RINGED_PRIMITIVES);
  const found: string[] = [];
  let seen = 0;
  for (let at = 0; at < count; at += 1) {
    const took = await page.evaluate((index) => {
      const one = (globalThis as { attack328Primitives?: Element[] }).attack328Primitives?.[index];
      if (!(one instanceof HTMLElement)) return false;
      one.focus();
      return document.activeElement === one;
    }, at);
    // A primitive that cannot take the focus — hidden, or disabled — has no ring to clip.
    if (!took) continue;
    const focused = await focusedRing(page);
    if (focused === null) continue;
    seen += 1;
    const label = `${focused.tag}.${focused.classes.join('.')}`;
    // A ring that is clipped nowhere because it is drawn nowhere is no ring.
    if (!focused.visible) found.push(`${label}: not ${focused.ringedOn}`);
    if (focused.ring === 'none') found.push(`${label}: no ring drawn`);
    const clipped = await ringClipping(page);
    if (clipped !== null) found.push(clipped);
  }
  return { seen, clipped: [...new Set(found)] };
}

/** Surfaces whose primitives sit inside a dialog, a table or a scroller. */
const RING_SURFACES: Record<string, (page: Page) => Promise<void>> = {
  settings: async (page) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: 'Settings' }).locator('.field').first(),
    ).toBeVisible();
  },
  // The rows' own buttons, inside the list's scroller: opening a row would take them away.
  inbox: async (page) => {
    await page
      .getByRole('list', { name: 'Go to' })
      .getByRole('button', { name: /^Inbox/ })
      .click();
    await expect(page.locator('.inbox__row .btn').first()).toBeVisible();
  },
  today: async (page) => {
    await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Today' }).click();
    await expect(
      page.getByRole('article', { name: 'Today' }).locator('.status-pill').first(),
    ).toBeVisible();
  },
};

for (const theme of THEMES) {
  for (const [surface, open] of Object.entries(RING_SURFACES)) {
    test(`a focused primitive on ${surface} shows its whole ring in ${theme}`, async ({ page }) => {
      await openVault(page);
      await setTheme(page, theme);
      await open(page);
      const { seen, clipped } = await focusEachAndCollectClipping(page);
      expect(seen).toBeGreaterThan(0);
      expect(clipped).toEqual([]);
    });
  }

  test(`the focus ring on a primitive clears 3:1 against its ground in ${theme}`, async ({
    page,
  }) => {
    await page.addInitScript(installContrast);
    await openVault(page);
    await setTheme(page, theme);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    const weak: string[] = [];
    let seen = 0;
    for (let step = 0; step < 40; step += 1) {
      await page.keyboard.press('Tab');
      const result = await page.evaluate(() => {
        const focused = document.activeElement;
        if (!focused?.matches('.btn, .field, .chip, .segmented__option')) return null;
        const { ratio, groundOf, indicatorColours, over } = (
          globalThis as unknown as { attack328: Contrast }
        ).attack328;
        const ground = groundOf(focused.parentElement ?? focused);
        const best = Math.max(
          0,
          ...indicatorColours(focused).map((colour) => ratio(over(colour, ground), ground)),
        );
        return { name: `${focused.tagName}.${focused.className}`, best };
      });
      if (result === null) continue;
      seen += 1;
      if (result.best < 3) weak.push(`${result.name} ${result.best.toFixed(2)}`);
    }
    expect(seen).toBeGreaterThan(0);
    expect([...new Set(weak)]).toEqual([]);
  });
}

test('a long menu in a short window can be scrolled to its last item', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 420 });
  await openVault(page, { templates: 30 });
  await page.getByRole('button', { name: 'New note', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'New note from' });
  await expect(menu).toBeVisible();
  const last = menu.getByRole('menuitem', { name: 'Template 29' });
  await expect(last).toHaveCount(1);
  await last.scrollIntoViewIfNeeded();
  const box = (await last.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(420);
  // The menu's own box stays in the window: what is past its foot is
  // reached by scrolling it, not cut off by the window's edge.
  const menuBox = (await menu.boundingBox())!;
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(420);
});

for (const theme of THEMES) {
  test(`the keyboard-highlighted menu row is marked at 3:1 against the menu in ${theme}`, async ({
    page,
  }) => {
    await page.addInitScript(installContrast);
    await openVault(page, { templates: 3 });
    await setTheme(page, theme);
    await page.getByRole('button', { name: 'New note', exact: true }).focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'New note from' });
    await expect(menu).toBeVisible();
    await page.keyboard.press('ArrowDown');
    const highlighted = menu.locator('button[data-highlighted]');
    await expect(highlighted).toHaveCount(1);
    // The mark is the focus ring, and the menu moves focus to the row after it
    // marks it highlighted: read before then and there is no ring yet.
    await expect(highlighted).toBeFocused();
    const best = await highlighted.evaluate((row) => {
      const { parse, ratio, groundOf, indicatorColours, over } = (
        globalThis as unknown as { attack328: Contrast }
      ).attack328;
      const menuGround = groundOf(row.closest('.menu')!);
      const fill = over(parse(getComputedStyle(row).backgroundColor), menuGround);
      const marks = [fill, ...indicatorColours(row).map((colour) => over(colour, menuGround))];
      return Math.max(...marks.map((mark) => ratio(mark, menuGround)));
    });
    expect(best).toBeGreaterThanOrEqual(3);
  });
}

test('a flat table row with a status pill is drawn at the height the list places it by', async ({
  page,
}) => {
  await openVault(page);
  await sidebarSection(page, 'views').getByRole('button', { name: 'Sheet', exact: true }).click();
  const row = page
    .locator('.table__row')
    .filter({ has: page.locator('.status-pill') })
    .first();
  await expect(row).toBeVisible();
  expect((await row.boundingBox())!.height).toBeCloseTo(TABLE_ROW_HEIGHT, 0);
});

test('a status group row of a table is drawn at the height the list places it by', async ({
  page,
}) => {
  await openVault(page);
  await sidebarSection(page, 'views').getByRole('button', { name: 'Grouped', exact: true }).click();
  const group = page
    .locator('.table__group')
    .filter({ has: page.locator('.status-pill') })
    .first();
  await expect(group).toBeVisible();
  expect((await group.boundingBox())!.height).toBeCloseTo(TABLE_GROUP_HEIGHT, 0);
});

test('a Today row that says its status is drawn at the height the list places it by', async ({
  page,
}) => {
  await openVault(page);
  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Today' }).click();
  const pill = page.getByRole('article', { name: 'Today' }).locator('.status-pill').first();
  await expect(pill).toBeVisible();
  const height = await pill.evaluate((element) => {
    // The virtualised item: the nearest ancestor the list measures.
    const item = element.closest('[data-index]') ?? element.closest('li');
    return item?.getBoundingClientRect().height ?? -1;
  });
  expect(height).toBeCloseTo(TODAY_ROW_HEIGHT, 0);
});
