import { expect, test, type Locator, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection, splitWindow } from './host.ts';

// Attack on #335 (UI v2 slice 3b, #295): every page headed by its nav bar,
// one h1 each, the count and the page's buttons in the bar under squeeze,
// the Today group name at 600, and the new type sizes' contrast.

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
];
const LONG_VIEW = 'Every open reconciliation worksheet awaiting a second review';
const LONG_DESCRIPTION =
  'Every worksheet still open at the quarter end, by region, with the reviewer who holds it.';
// Sorts first, so the Today list draws it among the groups it places first.
const LONG_PROJECT =
  'A Larkspur Payroll northern region quarterly reconciliation and second review programme';
const PROJECTS = [LONG_PROJECT, ...Array.from({ length: 11 }, (_, at) => `Garden bed ${at + 1}`)];

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

const DASHBOARD = [
  '---',
  'atlas: dashboard',
  'widgets:',
  '  - title: Tasks',
  '    kind: number',
  '    type: task',
  '---',
  '',
].join('\n');

const AUTOMATION = [
  '---',
  'atlas: automation',
  'name: File standups',
  'id: File standups',
  'enabled: true',
  'when: a meeting is created',
  'which: FROM meeting WHERE kind = Standup',
  'do: archive',
  '---',
  '',
].join('\n');

async function openVault(page: Page): Promise<void> {
  const vault = await createVault();
  for (const folder of [
    '.atlas/types',
    '.atlas/views',
    '.atlas/dashboards',
    '.atlas/templates',
    '.atlas/automations',
    'Tasks',
    'Inbox',
    'Projects',
    'Terms',
    'Archive',
  ]) {
    await vault.mkdir(folder);
  }
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/types/project.md', '---\nname: project\nlabel: Project\n---\n');
  await vault.write(
    `.atlas/views/${LONG_VIEW}.md`,
    [
      '---',
      'atlas: view',
      'type: task',
      'layout: table',
      'columns: [status, due]',
      `description: ${LONG_DESCRIPTION}`,
      '---',
      '',
    ].join('\n'),
  );
  await vault.write('.atlas/dashboards/Progress.md', DASHBOARD);
  await vault.write('.atlas/templates/Task.md', '---\ntype: task\nstatus: inbox\n---\n');
  await vault.write('.atlas/automations/File standups.md', AUTOMATION);
  await vault.write('Terms/Larkspur.md', '---\ntype: term\nvariants:\n  - lark spur\n---\n');
  await vault.write('Archive/Old plan.md', '# Old plan\n\nDone with.\n');
  // No `#` heading in the body: the page's own h1 is what is under test.
  await vault.write('Garden plan.md', '# Garden plan\n\nBeds and seeds.\n');
  await vault.write('Field notes.md', 'Some words. #garden\n\n## Beds\n\nMore words.\n');
  for (const [at, name] of PROJECTS.entries()) {
    await vault.write(`Projects/${name}.md`, '---\ntype: project\n---\n\nA project.\n');
    await vault.write(
      `Tasks/Step ${at + 1}.md`,
      ['---', 'type: task', 'status: next-action', `project: "[[${name}]]"`, '---', ''].join('\n'),
    );
  }
  for (const [at, status] of GTD.entries()) {
    const folder = status === 'inbox' ? 'Inbox' : 'Tasks';
    const due = `due: 2026-10-${String(10 + at).padStart(2, '0')}`;
    await vault.write(
      `${folder}/Task ${status}.md`,
      ['---', 'type: task', `status: ${status}`, due, '---', '', 'A task.', ''].join('\n'),
    );
  }
  await installHost(page, vault);
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
}

const goTo = (page: Page) => page.getByRole('list', { name: 'Go to' });

const PAGES: Record<string, (page: Page) => Promise<void>> = {
  Today: (page) => goTo(page).getByRole('button', { name: 'Today' }).click(),
  Inbox: (page) =>
    goTo(page)
      .getByRole('button', { name: /^Inbox/ })
      .click(),
  Review: (page) => goTo(page).getByRole('button', { name: 'Weekly review' }).click(),
  Archive: (page) =>
    sidebarSection(page, 'userSpace')
      .getByRole('treeitem', { name: 'Archive', exact: true })
      .click(),
  Templates: (page) => goTo(page).getByRole('button', { name: 'Templates' }).click(),
  Terms: (page) => goTo(page).getByRole('button', { name: 'Terms' }).click(),
  Activity: (page) => goTo(page).getByRole('button', { name: 'Activity', exact: true }).click(),
  Automations: (page) =>
    goTo(page).getByRole('button', { name: 'Automations', exact: true }).click(),
  Graph: (page) => goTo(page).getByRole('button', { name: 'Graph' }).click(),
  Query: async (page) => {
    await page.getByRole('button', { name: 'New in Views' }).click();
    await page.getByRole('menuitem', { name: 'New query' }).click();
  },
  Tags: (page) => page.getByRole('button', { name: 'Tags', exact: true }).click(),
  // A type opens on its views (ADR-0023); "Edit Task type" from elsewhere
  // opens its own page, with the editor in the right sidebar (slice 12),
  // which is put away so the page's own head is what is measured.
  'a type page': async (page) => {
    await page.keyboard.press('Meta+k');
    await page.getByRole('searchbox', { name: 'Search the vault' }).fill('edit task type');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('article', { name: 'Task', exact: true })).toBeVisible();
    const hide = page.getByRole('button', { name: 'Hide right sidebar' });
    if (await hide.isVisible()) await hide.click();
  },
  'a view': (page) =>
    sidebarSection(page, 'views').getByRole('button', { name: LONG_VIEW, exact: true }).click(),
  'a dashboard': (page) =>
    sidebarSection(page, 'dashboards')
      .getByRole('button', { name: 'Progress', exact: true })
      .click(),
  'a note': (page) =>
    sidebarSection(page, 'userSpace')
      .getByRole('treeitem', { name: 'Field notes', exact: true })
      .click(),
  'a template': async (page) => {
    await goTo(page).getByRole('button', { name: 'Templates' }).click();
    await page
      .getByRole('article', { name: 'Templates' })
      .getByRole('button', { name: 'Task', exact: true })
      .click();
  },
};

const main = (page: Page) => page.locator('main');

/** Opens a page and waits for its bar to name it. */
async function open(page: Page, which: string): Promise<Locator> {
  await PAGES[which]!(page);
  const name = main(page).locator('.page-bar__name').first();
  await expect(name).toBeVisible();
  return name;
}

/** Every heading's level, in document order, inside `scope`. */
const headingLevels = (scope: Locator) =>
  scope.evaluate((root) =>
    [...root.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')].map((one) =>
      one.hasAttribute('aria-level')
        ? Number(one.getAttribute('aria-level'))
        : Number(one.tagName.slice(1)),
    ),
  );

/** The first place a heading jumps more than one level down, or null. */
function firstSkip(levels: readonly number[]): string | null {
  if (levels[0] !== 1) return `the first heading is h${levels[0] ?? '-'}`;
  for (let at = 1; at < levels.length; at += 1) {
    if (levels[at]! > levels[at - 1]! + 1)
      return `h${levels[at - 1]} is followed by h${levels[at]}`;
  }
  return null;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

for (const which of Object.keys(PAGES)) {
  test(`${which}: the page has exactly one h1`, async ({ page }) => {
    await openVault(page);
    await open(page, which);
    await expect(main(page).locator('h1')).toHaveCount(1);
  });

  test(`${which}: the h1 is the breadcrumb's name`, async ({ page }) => {
    await openVault(page);
    const name = await open(page, which);
    await expect(main(page).locator('h1')).toHaveText((await name.textContent()) ?? '');
  });

  test(`${which}: headings start at h1 and never skip a level`, async ({ page }) => {
    await openVault(page);
    await open(page, which);
    await expect(main(page).locator('h1')).toHaveCount(1);
    expect(firstSkip(await headingLevels(main(page)))).toBeNull();
  });
}

for (const which of ['a view', 'a note', 'a dashboard'] as const) {
  test(`split on ${which}: each pane has its own single h1`, async ({ page }) => {
    await openVault(page);
    await open(page, which);
    await splitWindow(page);
    for (const pane of [1, 2] as const) {
      const region = page.getByRole('region', { name: `Pane ${pane}` });
      await expect(region).toBeVisible();
      await expect(region.locator('h1'), `pane ${pane}`).toHaveCount(1);
    }
  });
}

// ---- the bar under squeeze ------------------------------------------------

/** Every visible box in a bar's row — its own controls and every button in the actions slot. */
const barParts = (bar: Locator) =>
  bar.evaluate((element) => {
    const row = element.querySelector('.page-bar__row') ?? element;
    const rowBox = row.getBoundingClientRect();
    const host = element.closest('section, main') ?? document.body;
    const hostBox = host.getBoundingClientRect();
    const selector = [
      '.page-bar__row > .page-bar__button',
      '.page-bar__row > .star',
      '.page-bar__row > button',
      '.page-bar__history',
      '.page-bar__crumbs',
      '.page-bar__actions button',
      '.page-bar__actions input',
      '.page-bar__actions [role="radio"]',
      '.page-bar__status',
    ].join(', ');
    const parts = [...row.querySelectorAll(selector)]
      .filter((one) => getComputedStyle(one).display !== 'none')
      .map((one) => {
        const box = one.getBoundingClientRect();
        return {
          what: one.getAttribute('aria-label') ?? one.textContent?.trim() ?? one.className,
          inActions: one.closest('.page-bar__actions') !== null,
          left: box.left,
          right: box.right,
          width: box.width,
        };
      })
      .filter((one) => one.width > 1);
    return {
      row: {
        left: Math.max(rowBox.left, hostBox.left),
        right: Math.min(rowBox.right, hostBox.right),
      },
      parts,
    };
  });

/** What is wrong with a bar: anything outside it, any two controls overlapping. */
async function barProblems(bar: Locator): Promise<string[]> {
  const { row, parts } = await barParts(bar);
  const problems: string[] = [];
  for (const part of parts) {
    if (part.left < row.left - 0.5 || part.right > row.right + 0.5) {
      problems.push(
        `${part.what} is outside the bar (${part.left}–${part.right} of ${row.left}–${row.right})`,
      );
    }
  }
  const controls = parts.filter((one) => !/page-bar__crumbs/.test(one.what) && one.what !== '');
  for (let a = 0; a < controls.length; a += 1) {
    for (let b = a + 1; b < controls.length; b += 1) {
      const one = controls[a]!;
      const two = controls[b]!;
      const meet = one.left < two.right - 0.5 && two.left < one.right - 0.5;
      // Back and Forward sit inside their group's box: a box holding another is not an overlap.
      const nested =
        (one.left >= two.left && one.right <= two.right) ||
        (two.left >= one.left && two.right <= one.right);
      if (meet && !nested) problems.push(`${one.what} overlaps ${two.what}`);
    }
  }
  return problems;
}

/** The name's drawn width against 4em of its own font, and whether the count still shows. */
const nameAndCount = (bar: Locator) =>
  bar.evaluate((element) => {
    const name = element.querySelector<HTMLElement>('.page-bar__name');
    const count = element.querySelector<HTMLElement>('.page-bar__count');
    const crumbs = element.querySelector<HTMLElement>('.page-bar__crumbs');
    if (name === null || crumbs === null) return null;
    const em = parseFloat(getComputedStyle(name).fontSize);
    const nameBox = name.getBoundingClientRect();
    const crumbsBox = crumbs.getBoundingClientRect();
    // What of the name is actually seen: the crumb clips what overflows it.
    const seen = Math.max(0, Math.min(nameBox.right, crumbsBox.right) - nameBox.left);
    const countShown =
      count !== null &&
      getComputedStyle(count).display !== 'none' &&
      count.getBoundingClientRect().width > 1;
    return {
      seen,
      fourEm: 4 * em,
      nameClipped: name.scrollWidth > name.clientWidth + 0.5 || seen < nameBox.width - 0.5,
      countShown,
    };
  });

/** `counted`: the page has a count in this vault, so it is measured only once that is drawn. */
const SQUEEZED: readonly { which: string; width: number; split: boolean; counted: boolean }[] = [
  // The type page is not a pane, so it never splits: the window's minimum is its narrowest.
  { which: 'a type page', width: 720, split: false, counted: false },
  { which: 'a view', width: 720, split: true, counted: true },
  { which: 'Today', width: 720, split: false, counted: true },
  { which: 'Archive', width: 720, split: false, counted: true },
  { which: 'Graph', width: 720, split: false, counted: true },
  { which: 'Templates', width: 720, split: false, counted: true },
  { which: 'Automations', width: 720, split: false, counted: true },
];

for (const { which, width, split, counted } of SQUEEZED) {
  const where = `${which} at ${width}px${split ? ', split' : ''}`;

  /** Each bar on screen once the page is open at that width. */
  async function bars(page: Page): Promise<Locator[]> {
    await page.setViewportSize({ width, height: 700 });
    await openVault(page);
    await open(page, which);
    if (counted) await expect(main(page).locator('.page-bar__count').first()).not.toBeEmpty();
    if (!split) return [main(page).locator('.page-bar').first()];
    await splitWindow(page);
    const both = [1, 2].map((pane) =>
      page.getByRole('region', { name: `Pane ${pane}` }).locator('.page-bar'),
    );
    for (const bar of both) await expect(bar).toBeVisible();
    return both;
  }

  test(`${where}: the bar's actions stay inside it and overlap nothing`, async ({ page }) => {
    for (const bar of await bars(page)) expect(await barProblems(bar)).toEqual([]);
  });

  // Measured until it holds: a page's buttons can land after its name does,
  // and the bar is laid out again when they do.
  test(`${where}: the name keeps at least 4em in view`, async ({ page }) => {
    for (const bar of await bars(page)) {
      await expect
        .poll(async () => {
          const measured = await nameAndCount(bar);
          return measured === null ? null : measured.seen - measured.fourEm;
        })
        .toBeGreaterThanOrEqual(-0.5);
    }
  });

  test(`${where}: the count is gone before the name is clipped`, async ({ page }) => {
    for (const bar of await bars(page)) {
      await expect
        .poll(async () => {
          const measured = await nameAndCount(bar);
          return measured === null ? null : !measured.nameClipped || !measured.countShown;
        })
        .toBe(true);
    }
  });

  test(`${where}: the window never scrolls sideways`, async ({ page }) => {
    await bars(page);
    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(sideways).toBe(0);
  });
}

test('a view with a long description at 1440px: the count is gone before the name is clipped', async ({
  page,
}) => {
  await openVault(page);
  await open(page, 'a view');
  await splitWindow(page);
  for (const pane of [1, 2] as const) {
    const bar = page.getByRole('region', { name: `Pane ${pane}` }).locator('.page-bar');
    const measured = await nameAndCount(bar);
    expect(measured).not.toBeNull();
    if (measured!.nameClipped) expect(measured!.countShown, `pane ${pane}`).toBe(false);
  }
});

/** Whether any ancestor that clips its overflow cuts into the focus ring drawn around `element`. */
const ringClippedBy = (element: Locator) =>
  element.evaluate((target) => {
    const style = getComputedStyle(target);
    const spreads = [...style.boxShadow.matchAll(/(-?[\d.]+)px/g)].map((m) => Number(m[1]));
    // box-shadow: x y blur spread — take the widest reach any layer draws.
    let reach = 0;
    for (let at = 0; at + 3 < spreads.length; at += 4) {
      reach = Math.max(reach, Math.abs(spreads[at]!) + spreads[at + 2]! / 2 + spreads[at + 3]!);
    }
    if (style.outlineStyle !== 'none') {
      reach = Math.max(reach, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
    }
    const box = target.getBoundingClientRect();
    const ring = {
      left: box.left - reach,
      right: box.right + reach,
      top: box.top - reach,
      bottom: box.bottom + reach,
    };
    const clips: string[] = [];
    for (let at = target.parentElement; at; at = at.parentElement) {
      const over = getComputedStyle(at);
      if ([over.overflowX, over.overflowY].every((value) => value === 'visible')) continue;
      const clip = at.getBoundingClientRect();
      if (
        ring.left < clip.left - 0.5 ||
        ring.right > clip.right + 0.5 ||
        ring.top < clip.top - 0.5 ||
        ring.bottom > clip.bottom + 0.5
      ) {
        clips.push(at.className || at.tagName);
      }
    }
    return { reach, clips };
  });

const FOCUSED: readonly {
  which: string;
  control: (page: Page) => Locator;
  /** What draws the ring, when it is not the control itself. */
  ring?: (page: Page) => Locator;
}[] = [
  {
    which: 'Today',
    control: (page) => main(page).locator('.page-bar__actions button').first(),
  },
  {
    which: 'Templates',
    control: (page) => main(page).getByRole('button', { name: 'New template' }),
  },
  {
    which: 'a type page',
    control: (page) => main(page).getByRole('button', { name: 'Edit template' }),
  },
  {
    which: 'Archive',
    control: (page) => main(page).locator('.page-bar__actions input').first(),
    ring: (page) => main(page).locator('.page-bar__actions .archive__search').first(),
  },
];

for (const { which, control, ring } of FOCUSED) {
  test(`${which}: a bar action's focus ring is drawn whole`, async ({ page }) => {
    await openVault(page);
    await open(page, which);
    const target = control(page);
    await expect(target).toBeVisible();
    // Tabbed to, as a keyboard user reaches it, so it is drawn as keyboard focus.
    await page.locator('body').focus();
    for (let presses = 0; presses < 80; presses += 1) {
      if (await target.evaluate((element) => element === document.activeElement)) break;
      // WebKit on macOS tabs to buttons only with Option held, as Safari does.
      await page.keyboard.press('Alt+Tab');
    }
    await expect(target).toBeFocused();
    const { reach, clips } = await ringClippedBy(ring?.(page) ?? target);
    expect(reach, 'a ring is drawn').toBeGreaterThan(0);
    expect(clips).toEqual([]);
  });
}

// ---- the Today group name at 600 --------------------------------------------

const GROUP_NAME_HEIGHT = 18;

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1440, 720] as const) {
    test(`Today, ${theme}, ${width}px: every group name, long ones too, is ${GROUP_NAME_HEIGHT}px tall`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await openVault(page);
      await page.evaluate((wanted) => {
        document.documentElement.dataset['theme'] = wanted;
      }, theme);
      await open(page, 'Today');
      const names = main(page).locator('.today__group-name');
      await expect(names.filter({ hasText: LONG_PROJECT })).toBeVisible();
      const heights = await names.evaluateAll((all) =>
        all.map((one) => ({
          name: one.textContent ?? '',
          height: Math.round(one.getBoundingClientRect().height * 100) / 100,
          weight: getComputedStyle(one).fontWeight,
        })),
      );
      expect(heights.length).toBeGreaterThan(1);
      const wrong = heights.filter((one) => Math.abs(one.height - GROUP_NAME_HEIGHT) > 0.1);
      expect(wrong).toEqual([]);
      expect(new Set(heights.map((one) => one.weight))).toEqual(new Set(['600']));
    });
  }
}

// ---- contrast ----------------------------------------------------------------

/** WCAG contrast of an element's text against the opaque ground painted behind it. */
const contrastOf = (element: Locator) =>
  element.evaluate((target) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const parse = (colour: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#000';
      context.fillStyle = colour;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255] as const;
    };
    const over = (
      [r, g, b, a]: readonly number[],
      [br, bg, bb]: readonly number[],
    ): readonly number[] => [
      r! * a! + br! * (1 - a!),
      g! * a! + bg! * (1 - a!),
      b! * a! + bb! * (1 - a!),
      1,
    ];
    const layers: (readonly number[])[] = [];
    for (let at: Element | null = target; at; at = at.parentElement) {
      const fill = parse(getComputedStyle(at).backgroundColor);
      if (fill[3] > 0) layers.push(fill);
      if (fill[3] >= 1) break;
    }
    let ground: readonly number[] = [255, 255, 255, 1];
    for (const layer of layers.reverse()) ground = over(layer, ground);
    const ink = over(parse(getComputedStyle(target).color), ground);
    const lum = (c: readonly number[]) => {
      const [x, y, z] = c.slice(0, 3).map((v) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * x + 0.7152 * y + 0.0722 * z;
    };
    const [hi, lo] = [lum(ink), lum(ground)].sort((p, q) => q - p) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  });

const READ: readonly { what: string; which: string; selector: string }[] = [
  { what: 'the 24/600 note title', which: 'a note', selector: '.page-head__title' },
  { what: 'the bar count', which: 'Templates', selector: '.page-bar__count' },
  { what: 'a review section title', which: 'Review', selector: '.review__heading' },
  { what: 'a review section count', which: 'Review', selector: '.review__count' },
];

for (const theme of ['light', 'dark'] as const) {
  for (const { what, which, selector } of READ) {
    test(`${theme}: ${what} clears 4.5:1`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await openVault(page);
      await page.evaluate((wanted) => {
        document.documentElement.dataset['theme'] = wanted;
      }, theme);
      await open(page, which);
      const target = main(page).locator(selector).first();
      await expect(target).toBeVisible();
      await page.evaluate(() =>
        Promise.allSettled(document.getAnimations().map((running) => running.finished)),
      );
      expect(await contrastOf(target)).toBeGreaterThanOrEqual(4.5);
    });
  }
}
