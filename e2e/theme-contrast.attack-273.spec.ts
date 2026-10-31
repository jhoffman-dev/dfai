import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';

/**
 * PR #273 (UI v2 slice 1) under attack: what the new palette *renders*, not
 * what its tokens hold. Text, focus rings, state indicators and the drag copy
 * are measured against the ground actually painted behind them, in light,
 * dark, and the system's dark (no `data-theme`, so the stylesheet's
 * `prefers-color-scheme` block is the one in force).
 */

const NOW = new Date(2026, 9, 13, 12, 0, 0);

const GTD = [
  'inbox',
  'backlog',
  'next-action',
  'in-progress',
  'waiting',
  'someday',
  'longterm',
  'archive',
] as const;

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  `    options: [${GTD.join(', ')}]`,
  '    done: archive',
  '  due: date',
  '  project:',
  '    kind: relation',
  '    target: project',
  '---',
  '',
].join('\n');

const view = (layout: string, extra: readonly string[] = []) =>
  ['---', 'atlas: view', 'type: task', `layout: ${layout}`, ...extra, 'limit: 100', '---', ''].join(
    '\n',
  );

const DASHBOARD = [
  '---',
  'atlas: dashboard',
  'widgets:',
  '  - title: Tasks',
  '    kind: number',
  '    type: task',
  '  - title: By status',
  '    kind: bar',
  '    type: task',
  '    groupBy: status',
  '  - title: Share of status',
  '    kind: donut',
  '    type: task',
  '    groupBy: status',
  '  - title: Open work',
  '    kind: list',
  '    type: task',
  '---',
  '',
  '# Progress',
  '',
].join('\n');

const NOTE = [
  '# Field notes',
  '',
  'Plain running text with `inline code`, a [[Plan]] link and **bold**.',
  '',
  '- [ ] an open box',
  '- [x] a ticked box',
  '',
  '> a quote',
  '',
  '```ts',
  'const answer = 42;',
  '```',
  '',
].join('\n');

const title = (status: string) => `Task ${status}`;

async function openVault(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const vault = await createVault();
  for (const folder of [
    '.atlas/types',
    '.atlas/views',
    '.atlas/dashboards',
    'Tasks',
    'Inbox',
    'Projects',
  ]) {
    await vault.mkdir(folder);
  }
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/types/project.md', '---\nname: project\nlabel: Project\n---\n');
  await vault.write('.atlas/views/Sheet.md', view('table', ['columns: [status, due]']));
  await vault.write(
    '.atlas/views/Board.md',
    view('board', ['groupBy: status', 'columns: [status]']),
  );
  await vault.write(
    '.atlas/views/Calendar.md',
    view('calendar', ['dateKey: due', 'columns: [due]']),
  );
  await vault.write('.atlas/dashboards/Progress.md', DASHBOARD);
  await vault.write('Projects/Garden.md', '---\ntype: project\n---\n\nBeds and seeds.\n');
  await vault.write('Field notes.md', NOTE);
  await vault.write('Plan.md', '# Plan\n\nThe plan.\n');
  for (const [at, status] of GTD.entries()) {
    const folder = status === 'inbox' ? 'Inbox' : 'Tasks';
    const project = status === 'next-action' ? ['project: "[[Garden]]"'] : [];
    const due = `due: 2026-10-${String(10 + at).padStart(2, '0')}`;
    await vault.write(
      `${folder}/${title(status)}.md`,
      ['---', 'type: task', `status: ${status}`, due, ...project, '---', '', 'A task.', ''].join(
        '\n',
      ),
    );
  }
  await installHost(page, vault);
  await page.addInitScript(installContrast);
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
}

type Mode = 'light' | 'dark' | 'system-dark';
const MODES: readonly Mode[] = ['light', 'dark', 'system-dark'];
const THEMES: readonly Mode[] = ['light', 'dark'];

async function setMode(page: Page, mode: Mode): Promise<void> {
  await page.emulateMedia({ colorScheme: mode === 'light' ? 'light' : 'dark' });
  await page.evaluate((wanted) => {
    if (wanted === 'system-dark') delete document.documentElement.dataset['theme'];
    else document.documentElement.dataset['theme'] = wanted;
  }, mode);
  await settle(page);
}

/** A theme change runs the colour transitions; measure where they land. */
const settle = (page: Page) =>
  page.evaluate(() =>
    Promise.allSettled(document.getAnimations().map((running) => running.finished)),
  );

type Rgba = [number, number, number, number];

/** The colour maths, installed in the page so every measurement shares it. */
interface Contrast {
  parse(colour: string): Rgba;
  over(top: Rgba, under: Rgba): Rgba;
  ratio(a: Rgba, b: Rgba): number;
  /** The opaque ground painted behind an element: its ancestors' fills, stacked. */
  groundOf(element: Element): Rgba | null;
  /** Every colour a box-shadow or outline draws on an element. */
  indicatorColours(element: Element): Rgba[];
}

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
  const groundOf = (element: Element): Rgba | null => {
    const layers: Rgba[] = [];
    for (let at: Element | null = element; at; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.backgroundImage !== 'none') return null;
      const fill = parse(style.backgroundColor);
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
  (globalThis as unknown as { attackContrast: Contrast }).attackContrast = {
    parse,
    over,
    ratio,
    groundOf,
    indicatorColours,
  };
}

/** A screenshot's pixels, read back in the page, as rows of RGBA. */
const pixelsOf = (page: Page, png: Buffer) =>
  page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const out: Rgba[] = [];
    for (let at = 0; at < pixels.length; at += 4) {
      out.push([pixels[at]!, pixels[at + 1]!, pixels[at + 2]!, 1]);
    }
    return out;
  }, png.toString('base64'));

const goTo = (page: Page) => page.getByRole('list', { name: 'Go to' });

const PAGES: Record<string, (page: Page) => Promise<void>> = {
  today: async (page) => {
    await goTo(page).getByRole('button', { name: 'Today' }).click();
    await expect(page.getByRole('article', { name: 'Today' })).toBeVisible();
  },
  inbox: async (page) => {
    await goTo(page)
      .getByRole('button', { name: /^Inbox/ })
      .click();
    await expect(page.getByRole('article', { name: 'Inbox' })).toBeVisible();
    // The rows are held back, out of reach, until the page's offers are read (#130).
    await expect(page.locator('.inbox__row').first()).toBeVisible();
  },
  table: async (page) => {
    await sidebarSection(page, 'views').getByRole('button', { name: 'Sheet', exact: true }).click();
    await expect(page.locator('.table__row').first()).toBeVisible();
  },
  board: async (page) => {
    await sidebarSection(page, 'views').getByRole('button', { name: 'Board', exact: true }).click();
    await expect(page.locator('.board__card').first()).toBeVisible();
  },
  calendar: async (page) => {
    await sidebarSection(page, 'views')
      .getByRole('button', { name: 'Calendar', exact: true })
      .click();
    await expect(page.locator('.calendar__grid')).toBeVisible();
  },
  dashboard: async (page) => {
    await sidebarSection(page, 'dashboards')
      .getByRole('button', { name: 'Progress', exact: true })
      .click();
    await expect(page.getByLabel('Dashboard', { exact: true })).toBeVisible();
  },
  note: async (page) => {
    await page
      .getByRole('navigation', { name: 'Vault' })
      .getByText('Field notes', { exact: true })
      .first()
      .click();
    await expect(page.locator('.editor code').first()).toBeVisible();
  },
  settings: async (page) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings' }).first()).toBeVisible();
  },
  palette: async (page) => {
    await page.keyboard.press('Meta+k');
    await expect(page.locator('.palette')).toBeVisible();
    await page.keyboard.type('Task');
    await expect(page.locator('.palette__place').first()).toBeVisible();
  },
};

/**
 * Faded on purpose, and as faint before this PR as after it (measured against
 * the pre-#273 tokens: a done card 3.1:1 then, 3.0–3.45 now; a day outside the
 * month 2.2–2.5 both times). Reported separately, so the sweep holds what
 * this PR changed.
 */
const PRE_EXISTING = '.board__card--done, .calendar__day--outside';

/** One run of text whose ink does not clear the bar on the ground behind it. */
type Failure = {
  where: string;
  text: string;
  ink: string;
  ground: string;
  ratio: number;
  needed: number;
};

/**
 * Every visible element with text of its own, measured axe-style: its ink,
 * faded by the opacity of everything it sits in, over its ancestors' fills.
 * Text over a gradient or an image is skipped rather than guessed at, and
 * disabled controls are exempt (WCAG 1.4.3).
 */
const sweep = (page: Page): Promise<Failure[]> =>
  page.evaluate((skip) => {
    const { parse, over, ratio, groundOf } = (globalThis as unknown as { attackContrast: Contrast })
      .attackContrast;
    const describe = (element: Element) => {
      const parts: string[] = [];
      for (let at: Element | null = element; at && parts.length < 3; at = at.parentElement) {
        const name = typeof at.className === 'string' ? at.className.split(' ')[0] : '';
        parts.unshift(name ? `.${name}` : at.tagName.toLowerCase());
      }
      return parts.join(' > ');
    };
    const failures: Failure[] = [];
    for (const element of document.body.querySelectorAll('*')) {
      const own = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join('')
        .trim();
      if (own === '') continue;
      if (element.closest(`[aria-hidden="true"], :disabled, [aria-disabled="true"], ${skip}`)) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = getComputedStyle(element);
      if (style.visibility !== 'visible') continue;
      let opacity = 1;
      for (let at: Element | null = element; at; at = at.parentElement) {
        opacity *= Number(getComputedStyle(at).opacity);
      }
      if (opacity === 0) continue;
      const ground = groundOf(element);
      if (ground === null) continue;
      const [r, g, b, a] = parse(style.color);
      const measured = ratio(over([r, g, b, a * opacity], ground), ground);
      const size = parseFloat(style.fontSize);
      const needed = size >= 24 || (Number(style.fontWeight) >= 700 && size >= 18.66) ? 3 : 4.5;
      if (measured < needed) {
        failures.push({
          where: describe(element),
          text: own.slice(0, 30),
          ink: style.color,
          ground: `rgb(${ground.slice(0, 3).map(Math.round).join(', ')})`,
          ratio: Math.round(measured * 100) / 100,
          needed,
        });
      }
    }
    return failures;
  }, PRE_EXISTING);

for (const [name, open] of Object.entries(PAGES)) {
  for (const mode of MODES) {
    test(`every text run on ${name} clears AA in ${mode}`, async ({ page }) => {
      await openVault(page);
      await open(page);
      await setMode(page, mode);
      const failures = await sweep(page);
      expect(failures, JSON.stringify(failures, null, 1)).toEqual([]);
    });
  }
}

/**
 * The strongest colour a focus indicator draws on the focused element (and,
 * for a row, on its first cell), against the ground behind the element.
 */
const indicatorContrast = (page: Page, selector: string) =>
  page.evaluate((wanted) => {
    const { over, ratio, groundOf, indicatorColours } = (
      globalThis as unknown as { attackContrast: Contrast }
    ).attackContrast;
    const element = document.querySelector(wanted);
    if (element === null) throw new Error(`nothing matches ${wanted}`);
    const ground = groundOf(element.parentElement ?? element) ?? [255, 255, 255, 1];
    const drawers = [element, element.firstElementChild].filter((at) => at !== null);
    const colours = drawers.flatMap((at) => indicatorColours(at));
    return Math.max(0, ...colours.map((colour) => ratio(over(colour, ground), ground)));
  }, selector);

/** A Tab first, so the programmatic focus after it counts as keyboard focus (`:focus-visible`). */
async function keyboardFocus(page: Page, selector: string): Promise<void> {
  await page.keyboard.press('Tab');
  await page.locator(selector).first().focus();
  await expect(page.locator(`${selector}:focus-visible`)).toHaveCount(1);
  await settle(page);
}

/** Where each focus indicator lives, and how to get there. */
const FOCUS_TARGETS: Record<string, { open: (page: Page) => Promise<void>; selector: string }> = {
  'a tree row': { open: async () => {}, selector: '.tree__row' },
  'an Inbox row': { open: (page) => PAGES['inbox']!(page), selector: '.inbox__row' },
  'a Today row': { open: (page) => PAGES['today']!(page), selector: '.today__link' },
  'a board card': { open: (page) => PAGES['board']!(page), selector: '.board__title' },
  'a table row name': { open: (page) => PAGES['table']!(page), selector: '.table__link' },
  // A 28px field, as the retired quick-add popover's were (UI v2, Q5): the Terms page's form.
  'a 28px field': {
    open: async (page) => {
      await page
        .getByRole('list', { name: 'Go to' })
        .getByRole('button', { name: 'Terms' })
        .click();
      await page.getByRole('button', { name: 'New term' }).click();
      await expect(page.locator('.terms__field input.field').first()).toBeVisible();
    },
    selector: '.terms__field input.field',
  },
};

for (const [name, { open, selector }] of Object.entries(FOCUS_TARGETS)) {
  for (const mode of THEMES) {
    test(`the focus indicator on ${name} is at least 3:1 against its ground in ${mode}`, async ({
      page,
    }) => {
      await openVault(page);
      await open(page);
      await setMode(page, mode);
      await keyboardFocus(page, selector);
      expect(await indicatorContrast(page, `${selector}:focus`)).toBeGreaterThanOrEqual(3);
    });
  }
}

for (const mode of THEMES) {
  test(`a chosen row's box in a table is filled at 3:1 against the table in ${mode}`, async ({
    page,
  }) => {
    // #255's Shift-range: a chosen row carries no highlight of its own, so the
    // ticked box is the only thing on screen that says it is in the selection.
    await openVault(page);
    await PAGES['table']!(page);
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    const box = page.getByRole('checkbox', { name: `Select ${title('backlog')}`, exact: true });
    await box.click();
    await expect(box).toBeChecked();
    await setMode(page, mode);
    const ground = await box.evaluate((element) =>
      (globalThis as unknown as { attackContrast: Contrast }).attackContrast.groundOf(
        element.parentElement!,
      )!,
    );
    const pixels = await pixelsOf(page, await box.screenshot());
    // The box's fill is its most common colour that is not the ground around
    // it; the tick is drawn in the ground's colour and drops out with it.
    const measured = await page.evaluate(
      ({ all, back }) => {
        const { ratio } = (globalThis as unknown as { attackContrast: Contrast }).attackContrast;
        const counts = new Map<string, number>();
        for (const colour of all) {
          if (ratio(colour, back) < 1.05) continue;
          const key = colour.slice(0, 3).join(',');
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const [top] = [...counts].sort((a, b) => b[1] - a[1]);
        if (top === undefined) return { fill: 'none', ratio: 1 };
        const fill = [...top[0].split(',').map(Number), 1] as Rgba;
        return { fill: `rgb(${top[0]})`, ratio: ratio(fill, back) };
      },
      { all: pixels, back: ground },
    );
    expect(measured.ratio, `fill ${measured.fill}`).toBeGreaterThanOrEqual(3);
  });

  test(`a switch that is on shows its knob at 3:1 against its track in ${mode}`, async ({
    page,
  }) => {
    await openVault(page);
    await PAGES['palette']!(page);
    const toggle = page.getByRole('switch', { name: 'Include archived' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await setMode(page, mode);
    const measured = await toggle.evaluate((element) => {
      const { parse, over, ratio, groundOf, indicatorColours } = (
        globalThis as unknown as { attackContrast: Contrast }
      ).attackContrast;
      const track = groundOf(element)!;
      const knob = element.firstElementChild!;
      const colours = [parse(getComputedStyle(knob).backgroundColor), ...indicatorColours(knob)];
      return Math.max(...colours.map((colour) => ratio(over(colour, track), track)));
    });
    expect(measured).toBeGreaterThanOrEqual(3);
  });

  test(`the calendar's today ring is at least 3:1 against the day in ${mode}`, async ({ page }) => {
    await openVault(page);
    await PAGES['calendar']!(page);
    await setMode(page, mode);
    const measured = await page.locator('.calendar__day--today').evaluate((element) => {
      const { over, ratio, groundOf, indicatorColours } = (
        globalThis as unknown as { attackContrast: Contrast }
      ).attackContrast;
      const day = groundOf(element)!;
      return Math.max(...indicatorColours(element).map((colour) => ratio(over(colour, day), day)));
    });
    expect(measured).toBeGreaterThanOrEqual(3);
  });

  test(`the active sidebar row's count clears AA on the selected fill in ${mode}`, async ({
    page,
  }) => {
    await openVault(page);
    await sidebarSection(page, 'types').getByRole('button', { name: /^Task/ }).click();
    await setMode(page, mode);
    const count = page.locator('.sidebar__item--on .sidebar__count').first();
    await expect(count).toBeVisible();
    // The selected fill may be drawn by the row or a layer under it, so read it
    // from the pixels just left of the count rather than from a style.
    const at = (await count.boundingBox())!;
    const [fill] = await pixelsOf(
      page,
      await page.screenshot({
        clip: { x: at.x - 6, y: at.y + at.height / 2, width: 1, height: 1 },
      }),
    );
    const measured = await count.evaluate((element, under) => {
      const { parse, ratio } = (globalThis as unknown as { attackContrast: Contrast })
        .attackContrast;
      return ratio(parse(getComputedStyle(element).color), under);
    }, fill!);
    expect(measured, `count on rgb(${fill!.slice(0, 3).join(', ')})`).toBeGreaterThanOrEqual(4.5);
  });
}

for (const mode of THEMES) {
  test(`the copy of a board card being dragged stands out from the cards at rest in ${mode}`, async ({
    page,
  }) => {
    await openVault(page);
    await PAGES['board']!(page);
    await setMode(page, mode);
    const card = page.locator(`[data-path="Tasks/${title('backlog')}.md"]`).first();
    const at = (await card.boundingBox())!;
    // From the card's middle: its done box, at the top left, swallows a press.
    const grab = { x: at.x + at.width / 2, y: at.y + at.height / 2 };
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x + 10, grab.y + 10, { steps: 3 });
    await page.mouse.move(grab.x + 200, grab.y + 120, { steps: 8 });
    const lifted = page.locator('.board__card--lifted');
    await expect(lifted).toBeVisible();
    // The column under the pointer is lit by a ring, not a fill: the text in
    // it keeps the contrast it has at rest, and the ring itself clears 3:1.
    const target = await page.locator('.board__column--over').evaluate((element) => {
      const { over, ratio, groundOf, indicatorColours } = (
        globalThis as unknown as { attackContrast: Contrast }
      ).attackContrast;
      const rest = document.querySelector('.board__column:not(.board__column--over)');
      const ground = groundOf(element)!;
      return {
        fill: getComputedStyle(element).backgroundColor,
        restFill: rest === null ? null : getComputedStyle(rest).backgroundColor,
        ring: Math.max(
          1,
          ...indicatorColours(element).map((colour) => ratio(over(colour, ground), ground)),
        ),
      };
    });
    expect(target.fill).toBe(target.restFill);
    expect(target.ring, `drop target ring ${target.ring.toFixed(2)}`).toBeGreaterThanOrEqual(3);
    // How strongly each one's edge (its ring, or a shadow) stands off the
    // board behind it.
    const edge = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((element) => {
          const { over, ratio, groundOf, indicatorColours } = (
            globalThis as unknown as { attackContrast: Contrast }
          ).attackContrast;
          const board = groundOf(element.parentElement ?? element)!;
          return Math.max(
            1,
            ...indicatorColours(element).map((colour) => ratio(over(colour, board), board)),
          );
        });
    const resting = await edge('.board__card:not(.board__card--lifted)');
    const carried = await edge('.board__card--lifted');
    await page.mouse.up();
    // The copy under the pointer has to stand out from the cards lying on the
    // board, not recede. A resting card is square with a 1px hairline and no
    // shadow (UI v2, slice 9), so the copy's cue is the focus ring round it.
    expect(
      carried,
      `carried ${carried.toFixed(2)} vs resting ${resting.toFixed(2)}`,
    ).toBeGreaterThan(resting);
  });
}

test('a Today group name is drawn at the height the list places it by (18px)', async ({ page }) => {
  await openVault(page);
  await PAGES['today']!(page);
  const name = page.locator('.today__group-name').first();
  await expect(name).toBeVisible();
  // packages/ui/src/today-page.tsx GROUP_NAME_HEIGHT, "as WebKit draws them":
  // a group measured at its estimate does not place the list again.
  expect((await name.boundingBox())!.height).toBeCloseTo(18, 1);
});

test('each of the eight GTD statuses wears its own label, in its tone, in a table', async ({
  page,
}) => {
  // Someday and Longterm share Backlog's grey, Archive Done's green: only the
  // label tells them apart, so every pill must carry it.
  const expected: Record<(typeof GTD)[number], [string, string]> = {
    inbox: ['Inbox', 'inbox'],
    backlog: ['Backlog', 'backlog'],
    'next-action': ['Next Action', 'next'],
    'in-progress': ['In Progress', 'doing'],
    waiting: ['Waiting', 'waiting'],
    someday: ['Someday', 'backlog'],
    longterm: ['Longterm', 'backlog'],
    archive: ['Archive', 'done'],
  };
  await openVault(page);
  await PAGES['table']!(page);
  for (const status of GTD) {
    const pill = page
      .locator('.table__row', { hasText: title(status) })
      .locator('[data-tone]')
      .first();
    const [label, tone] = expected[status];
    await expect(pill).toHaveText(label);
    await expect(pill).toHaveAttribute('data-tone', tone);
  }
});
