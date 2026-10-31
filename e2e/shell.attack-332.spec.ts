import { join } from 'node:path';
import { expect, test, type Locator, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection, splitWindow, type FakeVault } from './host.ts';

// Attack on #332 (UI v2 slice 3a, #294): truncation in the 224px sidebar, the
// one theme button, and the 40px nav bar in narrow panes.

const LONG_VAULT = 'Larkspur Payroll quarterly operations archive for the northern region';
const LONG_TYPE = 'Extraordinarily detailed reconciliation worksheet';
const LONG_VIEW = 'Every open reconciliation worksheet awaiting a second review';
const LONG_DESCRIPTION =
  'Every worksheet still open at the quarter end, by region, with the reviewer who holds it.';
const LONG_FOLDER = 'Quarterly reviews prepared for Mara Quill and Tobias Fenn';
const LONG_NOTE = 'Notes from the long planning session about the spring garden beds';
const MANY = 1234;

/** A vault whose folder — and so whose shown name — is long. */
async function longNamedVault(): Promise<FakeVault> {
  const outer = await createVault();
  await outer.mkdir(LONG_VAULT);
  const inside = (path: string) => `${LONG_VAULT}/${path}`;
  return {
    root: join(outer.root, LONG_VAULT),
    write: (path, contents) => outer.write(inside(path), contents),
    mkdir: (path) => outer.mkdir(inside(path)),
    read: (path) => outer.read(inside(path)),
    exists: (path) => outer.exists(inside(path)),
    isFolder: (path) => outer.isFolder(inside(path)),
  };
}

async function openVault(page: Page, { many = false } = {}): Promise<FakeVault> {
  const vault = await longNamedVault();
  for (const folder of ['.atlas/types', '.atlas/views', 'Sheets', 'Archive', LONG_FOLDER]) {
    await vault.mkdir(folder);
  }
  // A task type puts Today in "Go to"; an archived note puts the Archive in the tree.
  await vault.write(
    '.atlas/types/task.md',
    ['---', 'name: task', 'label: Task', 'properties:', '  status: select', '---', ''].join('\n'),
  );
  await vault.write('Archive/Old plan.md', '# Old plan\n\nDone with.\n');
  await vault.write(
    '.atlas/types/sheet.md',
    ['---', 'name: sheet', `label: ${LONG_TYPE}`, 'properties: {}', '---', ''].join('\n'),
  );
  await vault.write(
    `.atlas/views/${LONG_VIEW}.md`,
    [
      '---',
      'atlas: view',
      'type: sheet',
      'layout: table',
      `description: ${LONG_DESCRIPTION}`,
      '---',
      '',
    ].join('\n'),
  );
  const sheets = many ? MANY : 3;
  for (let at = 1; at <= sheets; at += 1) {
    await vault.write(`Sheets/Sheet ${at}.md`, `---\ntype: sheet\n---\n\n# Sheet ${at}\n`);
  }
  await vault.write(`${LONG_FOLDER}/${LONG_NOTE}.md`, `# ${LONG_NOTE}\n\nBody.\n`);
  await vault.write('Plain.md', '# Plain\n\nA plain note.\n');
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Vault' });
const themeButton = (page: Page) =>
  nav(page).getByRole('button', { name: /^Switch to (light|dark) theme$/ });
const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset['theme']);

/** Whether `inner`'s box lies wholly inside `outer`'s, horizontally. */
async function horizontallyInside(inner: Locator, outer: Locator) {
  const a = await inner.boundingBox();
  const b = await outer.boundingBox();
  if (a === null || b === null) throw new Error('nothing to measure');
  return a.x >= b.x - 0.5 && a.x + a.width <= b.x + b.width + 0.5;
}

/** Whether an ellipsised label is clipped (so its ellipsis shows) and still has room. */
const clippedLabel = (label: Locator) =>
  label.evaluate((element) => ({
    clipped: element.scrollWidth > element.clientWidth,
    roomy: element.clientWidth >= 40,
  }));

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
});

test('a long vault name ellipsises inside the 224px sidebar', async ({ page }) => {
  await openVault(page);
  const name = nav(page).locator('.vault-header__name');
  await expect(name).toBeVisible();
  const label = name.locator('.vault-header__label, span').last();
  const clip = await name.evaluate((element) => {
    const candidates = [element, ...element.querySelectorAll('*')];
    return candidates.some((one) => one.scrollWidth > one.clientWidth + 0.5);
  });
  expect(clip, 'some part of the vault name is clipped to an ellipsis').toBe(true);
  expect(await horizontallyInside(name, nav(page))).toBe(true);
  expect(await horizontallyInside(label, nav(page))).toBe(true);
});

test('long type and view names ellipsise rather than overflow', async ({ page }) => {
  await openVault(page);
  const typeRow = sidebarSection(page, 'types').locator('.sidebar__item').first();
  const viewRow = sidebarSection(page, 'views').locator('.sidebar__item').first();
  for (const row of [typeRow, viewRow]) {
    await expect(row).toBeVisible();
    expect(await clippedLabel(row.locator('.sidebar__name'))).toEqual({
      clipped: true,
      roomy: true,
    });
    expect(await horizontallyInside(row, nav(page))).toBe(true);
  }
});

test('a type count in the thousands stays whole and leaves the label room', async ({ page }) => {
  await openVault(page, { many: true });
  const row = sidebarSection(page, 'types').locator('.sidebar__item').first();
  const count = row.locator('.sidebar__count');
  await expect(count).toHaveText(String(MANY), { timeout: 20_000 });
  const fits = await count.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const host = element.closest('.sidebar__item')!.getBoundingClientRect();
    return {
      whole: element.scrollWidth <= element.clientWidth + 0.5,
      inside: box.right <= host.right,
    };
  });
  expect(fits).toEqual({ whole: true, inside: true });
  expect(await clippedLabel(row.locator('.sidebar__name'))).toEqual({ clipped: true, roomy: true });
});

test('the sidebar has no sideways scroll with long names everywhere', async ({ page }) => {
  await openVault(page);
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: LONG_FOLDER, exact: true })
    .click();
  await expect(
    sidebarSection(page, 'userSpace').getByRole('treeitem', { name: LONG_NOTE, exact: true }),
  ).toBeVisible();
  const widths = await nav(page).evaluate((root) => {
    const area = root.querySelector('.sidebar__scroll')!;
    return {
      nav: root.scrollWidth - root.clientWidth,
      scroller: area.scrollWidth - area.clientWidth,
    };
  });
  expect(widths).toEqual({ nav: 0, scroller: 0 });
});

test('the theme button keeps focus and flips its name when pressed from the keyboard', async ({
  page,
}) => {
  await openVault(page);
  const button = themeButton(page);
  await page.keyboard.press('Tab');
  await button.focus();
  const before = await theme(page);
  const other = before === 'dark' ? 'light' : 'dark';
  await expect(button).toHaveAccessibleName(`Switch to ${other} theme`);

  await page.keyboard.press('Enter');
  await expect.poll(() => theme(page)).toBe(other);
  await expect(button).toBeFocused();
  await expect(button).toHaveAccessibleName(`Switch to ${before} theme`);

  await page.keyboard.press('Space');
  await expect.poll(() => theme(page)).toBe(before);
  await expect(button).toBeFocused();
  await expect(button).toHaveAccessibleName(`Switch to ${other} theme`);
});

test('the theme button shows its focus ring after a keyboard press', async ({ page }) => {
  await openVault(page);
  const button = themeButton(page);
  await page.keyboard.press('Tab');
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(button).toBeFocused();
  const ring = await button.evaluate((element) => getComputedStyle(element).boxShadow);
  expect(ring, 'the focus ring is drawn').not.toBe('none');
});

/** WCAG contrast between two tokens, as they resolve on the root now. */
const contrastOf = (page: Page, fore: string, back: string) =>
  page.evaluate(
    ([a, b]) => {
      const probe = document.createElement('div');
      document.body.append(probe);
      const rgb = (token: string) => {
        probe.style.color = `var(${token})`;
        const parts = getComputedStyle(probe)
          .color.match(/[\d.]+/g)!
          .map(Number);
        return parts.slice(0, 3);
      };
      const lum = ([r, g, bl]: number[]) => {
        const lin = (c: number) => {
          const s = c / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(bl!);
      };
      const one = lum(rgb(a));
      const two = lum(rgb(b));
      probe.remove();
      return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
    },
    [fore, back] as const,
  );

for (const wanted of ['light', 'dark'] as const) {
  test(`the focus ring clears 3:1 on the sidebar ground and on the selected fill in ${wanted}`, async ({
    page,
  }) => {
    await openVault(page);
    if ((await theme(page)) !== wanted) await themeButton(page).click();
    await expect.poll(() => theme(page)).toBe(wanted);
    expect(await contrastOf(page, '--focus', '--bg'), 'ring on the sidebar').toBeGreaterThanOrEqual(
      3,
    );
    expect(
      await contrastOf(page, '--focus', '--selected'),
      'ring on the selected row',
    ).toBeGreaterThanOrEqual(3);
    expect(
      await contrastOf(page, '--ink-2', '--selected'),
      'the active row’s count',
    ).toBeGreaterThanOrEqual(4.5);
  });
}

const tree = (page: Page) => sidebarSection(page, 'userSpace');

async function openLongNote(page: Page) {
  await tree(page).getByRole('treeitem', { name: LONG_FOLDER, exact: true }).click();
  await tree(page).getByRole('treeitem', { name: LONG_NOTE, exact: true }).click();
  await expect(page.locator('.page-head__title').first()).toHaveText(LONG_NOTE);
}

test('Back and Forward are named and reachable once there is somewhere to go', async ({ page }) => {
  await openVault(page);
  await tree(page).getByRole('treeitem', { name: 'Plain', exact: true }).click();
  await expect(page.locator('.page-head__title').first()).toHaveText('Plain');
  await openLongNote(page);
  const back = page.getByRole('button', { name: 'Back', exact: true });
  await expect(back).toBeEnabled();
  await back.focus();
  await expect(back).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.page-head__title').first()).toHaveText('Plain');
  const forward = page.getByRole('button', { name: 'Forward', exact: true });
  await expect(forward).toBeEnabled();
  await forward.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.page-head__title').first()).toHaveText(LONG_NOTE);
});

/** Every control in a pane's nav bar, boxed. */
const barBoxes = (bar: Locator) =>
  bar.evaluate((element) => {
    const row = element.querySelector('.page-bar__row') ?? element;
    const rowBox = row.getBoundingClientRect();
    const parts = [
      ...row.querySelectorAll(
        '.page-bar__button, .star, .page-bar__crumbs, .page-bar__name, .page-bar__status',
      ),
    ]
      .filter((one) => getComputedStyle(one).display !== 'none')
      .map((one) => {
        const box = one.getBoundingClientRect();
        return {
          what: one.getAttribute('aria-label') ?? one.className,
          left: box.left,
          right: box.right,
          width: box.width,
        };
      })
      .filter((one) => one.width > 1);
    return { row: { left: rowBox.left, right: rowBox.right }, parts };
  });

async function expectTidyBar(bar: Locator) {
  const { row, parts } = await barBoxes(bar);
  const problems: string[] = [];
  for (const part of parts) {
    if (part.left < row.left - 0.5 || part.right > row.right + 0.5) {
      problems.push(
        `${part.what} is outside the bar (${part.left}–${part.right} of ${row.left}–${row.right})`,
      );
    }
  }
  // Controls (not the crumb, which holds the name) never overlap one another.
  const controls = parts.filter((one) => !/page-bar__(crumbs|name)/.test(one.what));
  for (let a = 0; a < controls.length; a += 1) {
    for (let b = a + 1; b < controls.length; b += 1) {
      const one = controls[a]!;
      const two = controls[b]!;
      if (one.left < two.right - 0.5 && two.left < one.right - 0.5) {
        problems.push(`${one.what} overlaps ${two.what}`);
      }
    }
  }
  const name = parts.find((one) => /page-bar__name/.test(one.what));
  if (name === undefined) problems.push('the page’s name is not shown');
  else if (name.width < 24) problems.push(`the page’s name is ${name.width}px wide`);
  expect(problems).toEqual([]);
}

test('a long breadcrumb ellipsises and keeps the name in view', async ({ page }) => {
  await openVault(page);
  await openLongNote(page);
  const bar = page.locator('.page-bar').first();
  await expectTidyBar(bar);
  const parent = bar.locator('.page-bar__parent');
  const name = bar.locator('.page-bar__name');
  await expect(name).toBeVisible();
  const [parentWidth, nameWidth] = [
    (await parent.boundingBox())?.width ?? 0,
    (await name.boundingBox())?.width ?? 0,
  ];
  expect(nameWidth, 'the name keeps more room than the folder').toBeGreaterThan(parentWidth);
});

test('a view’s description in the bar gives way before its name', async ({ page }) => {
  await openVault(page);
  await sidebarSection(page, 'views').locator('.sidebar__item').first().click();
  const bar = page.locator('.page-bar').first();
  await expect(bar.locator('.page-bar__count')).toHaveText(LONG_DESCRIPTION);
  await splitWindow(page);
  // Split with the sidebar shown, each pane is short of room by more than the
  // description is wide; hidden, by less — where a count that only shrank in
  // proportion would still show beside a name already cut.
  for (const sidebar of ['shown', 'hidden'] as const) {
    if (sidebar === 'hidden') {
      await page.getByRole('button', { name: 'Hide sidebar' }).click();
      await expect(nav(page)).toBeHidden();
    }
    for (const which of [1, 2] as const) {
      const paneBar = page.getByRole('region', { name: `Pane ${which}` }).locator('.page-bar');
      const name = paneBar.locator('.page-bar__name');
      await expect(name).toBeVisible();
      await expectTidyBar(paneBar);
      const [nameWidth, descriptionWidth] = [
        (await name.boundingBox())?.width ?? 0,
        (await paneBar.locator('.page-bar__count').boundingBox())?.width ?? 0,
      ];
      expect(
        nameWidth,
        `pane ${which}, sidebar ${sidebar}: the name keeps more room than its description`,
      ).toBeGreaterThan(descriptionWidth);
      const clipped = await name.evaluate((one) => one.scrollWidth > one.clientWidth + 0.5);
      if (clipped) {
        expect(
          descriptionWidth,
          `pane ${which}, sidebar ${sidebar}: the description is gone before the name is cut`,
        ).toBeLessThan(1);
      }
    }
  }
});

/**
 * Pages with buttons of their own in the bar, each opened from the sidebar.
 * Only a note is a pane that splits; Today, the Archive and a type's page are
 * squeezed by the window alone, so they are measured at its 720px minimum.
 */
const OPENERS: Record<string, (page: Page) => Promise<void>> = {
  'a long note': openLongNote,
  Today: (page) =>
    page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Today' }).click(),
  Archive: (page) =>
    sidebarSection(page, 'userSpace')
      .getByRole('treeitem', { name: 'Archive', exact: true })
      .click(),
  Automations: (page) =>
    page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Automations' }).click(),
  // "Edit … type" from elsewhere opens the type's own page; at 720px the
  // right sidebar that holds its editor is folded, so the page is all there is.
  'a type page': async (page) => {
    await page.keyboard.press('Meta+k');
    await page.getByRole('searchbox', { name: 'Search the vault' }).fill(`edit ${LONG_TYPE} type`);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('article', { name: LONG_TYPE, exact: true })).toBeVisible();
  },
};

for (const sidebar of ['shown', 'hidden'] as const) {
  for (const [which, openPage] of Object.entries(OPENERS)) {
    const splits = which === 'a long note';
    test(`at the minimum window width, ${which}${splits ? ', split' : ''}, sidebar ${sidebar}: each nav bar stays tidy`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 720, height: 480 });
      await openVault(page);
      await openPage(page);
      if (splits) {
        await splitWindow(page);
        await expect(page.getByRole('region', { name: 'Pane 2' })).toBeVisible();
      }
      if (sidebar === 'hidden') {
        await page.getByRole('button', { name: 'Hide sidebar' }).click();
        await expect(nav(page)).toBeHidden();
      }
      const panes = splits
        ? ([1, 2] as const).map((at) => page.getByRole('region', { name: `Pane ${at}` }))
        : [page.locator('main')];
      for (const [at, pane] of panes.entries()) {
        const bar = pane.locator('.page-bar').first();
        await expect(bar).toBeVisible();
        await expectTidyBar(bar);
        expect(await horizontallyInside(bar, pane), `pane ${at + 1}'s bar inside it`).toBe(true);
      }
      const sideways = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(sideways, 'the window does not scroll sideways').toBe(0);
    });
  }
}

test('⌘\\ hides the sidebar and brings it back at 224px', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 480 });
  await openVault(page);
  await tree(page).getByRole('treeitem', { name: 'Plain', exact: true }).click();
  await expect(nav(page)).toBeVisible();
  await page.locator('.page-head__title').first().click();
  await page.keyboard.press('Meta+Backslash');
  await expect(nav(page)).toBeHidden();
  await page.keyboard.press('Meta+Backslash');
  await expect(nav(page)).toBeVisible();
  const width = await nav(page).evaluate((element) => element.getBoundingClientRect().width);
  expect(width).toBe(224);
});

/**
 * Every visible button in a bar's actions slot, with its width, its font's em,
 * whether it shows an icon, and its title.
 */
const barButtons = (bar: Locator) =>
  bar.evaluate((element) =>
    [...element.querySelectorAll<HTMLElement>('.page-bar__actions button')]
      .filter((one) => getComputedStyle(one).display !== 'none')
      .map((one) => ({
        name: one.getAttribute('aria-label') ?? one.textContent?.trim() ?? '',
        width: one.getBoundingClientRect().width,
        em: parseFloat(getComputedStyle(one).fontSize),
        icon: one.querySelector('svg') !== null,
        title: one.getAttribute('title')?.trim() ?? '',
      })),
  );

// A narrowed button is still told apart: it is at least 4em wide, or it shows
// its icon and names itself in its title.
for (const which of ['Today', 'Automations', 'Archive', 'a type page'] as const) {
  for (const width of [720, 600] as const) {
    test(`${which} at ${width}px: every bar button is 4em wide, or an icon with a title`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 600 });
      await openVault(page);
      await OPENERS[which]!(page);
      const bar = page.locator('main').locator('.page-bar').first();
      await expect(bar.locator('.page-bar__actions')).toBeVisible();
      const buttons = await barButtons(bar);
      // The Archive's one action is its search field, which is never narrowed to a stub.
      if (which === 'Archive') await expect(bar.getByRole('searchbox')).toBeVisible();
      else expect(buttons.length).toBeGreaterThan(0);
      const stubs = buttons.filter(
        (one) => one.width < 4 * one.em - 0.5 && !(one.icon && one.title !== ''),
      );
      expect(stubs).toEqual([]);
    });
  }
}
