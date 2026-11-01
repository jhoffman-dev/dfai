/**
 * Attack on #334 (UI v2 slice 4, #296): the table's 34px rows against long
 * and many-valued cells, the footer and the last row at the window's foot, the view bar and
 * its save notice, contrast in both themes, and the editing input's ring.
 */
import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';

const ROW_HEIGHT = 34;
const LONG_TEXT = `Collect the seed trays from the north shed and ${'sort them by bed '.repeat(18)}end`;

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, doing, done]',
  '  due: date',
  '  points: number',
  '  notes: text',
  '  project:',
  '    kind: relation',
  '    target: project',
  '    multiple: true',
  '---',
  '',
].join('\n');

const PROJECTS = ['Garden', 'Orchard', 'Henhouse', 'Pond', 'Greenhouse', 'Beehives', 'Meadow'];

async function openVault(page: Page, { width = 1440, tasks = 40 } = {}) {
  const vault = await createVault();
  for (const folder of ['.atlas/types', '.atlas/views', 'Tasks', 'Projects']) {
    await vault.mkdir(folder);
  }
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/types/project.md', '---\nname: project\nlabel: Project\n---\n');
  for (const name of PROJECTS) {
    await vault.write(`Projects/${name}.md`, `---\ntype: project\n---\n\n# ${name}\n`);
  }
  await vault.write(
    '.atlas/views/Chores.md',
    [
      '---',
      'atlas: view',
      'type: task',
      'layout: table',
      'groupBy: status',
      'columns: [status, due, points, notes, project]',
      '---',
      '',
    ].join('\n'),
  );
  const statuses = ['backlog', 'doing', 'done'];
  for (let at = 1; at <= tasks; at += 1) {
    await vault.write(
      `Tasks/Chore ${String(at).padStart(2, '0')}.md`,
      [
        '---',
        'type: task',
        `status: ${statuses[at % 3]}`,
        'due: 2026-10-20',
        `points: ${at}`,
        '---',
        '',
      ].join('\n'),
    );
  }
  await vault.write(
    'Tasks/A long note.md',
    ['---', 'type: task', 'status: backlog', `notes: "${LONG_TEXT}"`, '---', ''].join('\n'),
  );
  await vault.write(
    'Tasks/A huge number.md',
    [
      '---',
      'type: task',
      'status: backlog',
      'points: 123456789012345678901234567890',
      '---',
      '',
    ].join('\n'),
  );
  await vault.write(
    'Tasks/A multi-line note.md',
    [
      '---',
      'type: task',
      'status: backlog',
      'notes: |',
      '  First line of the plan',
      '  Second line of the plan',
      '  Third line of the plan',
      '---',
      '',
    ].join('\n'),
  );
  await vault.write(
    'Tasks/A busy chore.md',
    [
      '---',
      'type: task',
      'status: backlog',
      `project: "${PROJECTS.map((name) => `[[${name}]]`).join(', ')}"`,
      '---',
      '',
    ].join('\n'),
  );
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 30_000 });
  await sidebarSection(page, 'views').getByRole('button', { name: 'Chores', exact: true }).click();
  await expect(page.locator('.table__row').first()).toBeVisible();
  // Opened wide, then sized: under 944px the sidebar is a drawer (#658).
  await page.setViewportSize({ width, height: 900 });
  return vault;
}

const rowOf = (page: Page, name: string) =>
  page.locator('tr.table__row', { has: page.getByRole('button', { name, exact: true }) });

test.describe('34px rows hold whatever their cells hold', () => {
  const HOLDS: Record<string, RegExp> = {
    'A long note': /sort them by bed sort them by bed/,
    'A huge number': /e\+29|123456789/,
    'A multi-line note': /Second line of the plan/,
    'A busy chore': /Garden.*Orchard.*Henhouse.*Pond.*Greenhouse.*Beehives.*Meadow/,
  };
  for (const [name, holds] of Object.entries(HOLDS)) {
    test(`"${name}" is drawn 34px tall`, async ({ page }) => {
      await openVault(page);
      const row = rowOf(page, name);
      await expect(row).toBeVisible();
      // Proven to match: the row holds the value under test.
      await expect(row).toHaveText(holds);
      expect((await row.boundingBox())!.height).toBeCloseTo(ROW_HEIGHT, 0);
    });
  }

  test('a long value is cut short in its cell rather than widening the table past the sheet', async ({
    page,
  }) => {
    await openVault(page);
    await expect(rowOf(page, 'A long note')).toBeVisible();
    const overflow = await page
      .locator('.table__sheet')
      .evaluate((sheet) => sheet.scrollWidth - sheet.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe('the footer and the last row, at the foot of the window', () => {
  test('every part of the footer is on top where it is drawn: nothing sits over it', async ({
    page,
  }) => {
    await openVault(page);
    const covered = await page.locator('.table__footer').evaluate((footer) => {
      const found: string[] = [];
      for (const part of footer.children) {
        const box = part.getBoundingClientRect();
        for (const x of [box.left + 2, (box.left + box.right) / 2, box.right - 2]) {
          const hit = document.elementFromPoint(x, (box.top + box.bottom) / 2);
          if (!hit || !part.contains(hit)) {
            found.push(`${part.className} at x=${Math.round(x)} is under ${hit?.className}`);
          }
        }
      }
      return { found, parts: footer.children.length };
    });
    expect(covered.parts).toBeGreaterThan(2);
    expect(covered.found).toEqual([]);
  });

  test('with the sheet scrolled to its end, the last row’s last cell is under nothing', async ({
    page,
  }) => {
    await openVault(page, { tasks: 80 });
    await page.locator('.table__sheet').evaluate((sheet) => {
      sheet.scrollTop = sheet.scrollHeight;
    });
    await expect
      .poll(() =>
        page.locator('.table__sheet tbody').evaluate((body) => {
          const last = [...body.querySelectorAll('tr[data-index]')].at(-1)!;
          const cell = last.lastElementChild!.getBoundingClientRect();
          const hit = document.elementFromPoint(cell.right - 20, (cell.top + cell.bottom) / 2);
          return hit !== null && last.contains(hit) ? 'reachable' : `under ${hit?.className}`;
        }),
      )
      .toBe('reachable');
  });
});

test.describe('the view bar and the save notice', () => {
  const unsaved = (page: Page) => page.getByRole('group', { name: 'Unsaved view changes' });

  test('the notice sits above the bar, and Reset → Save as new → Save view is the Tab order', async ({
    page,
  }) => {
    await openVault(page);
    await page.getByRole('button', { name: 'Due', exact: true }).click();
    await expect(unsaved(page)).toBeVisible();
    const notice = (await unsaved(page).boundingBox())!;
    const bar = (await page.locator('.view-toolbar').boundingBox())!;
    expect(notice.y + notice.height).toBeLessThanOrEqual(bar.y + 0.5);

    await unsaved(page).getByRole('button', { name: 'Reset' }).focus();
    // Option-Tab: WebKit's plain Tab skips buttons, as macOS does by default.
    await page.keyboard.press('Alt+Tab');
    await expect(page.getByRole('button', { name: 'Save as new view…' })).toBeFocused();
    await page.keyboard.press('Alt+Tab');
    await expect(unsaved(page).getByRole('button', { name: 'Save view' })).toBeFocused();
  });

  test('Save as new writes a new view and leaves the open one’s note as it was', async ({
    page,
  }) => {
    const vault = await openVault(page);
    const before = await vault.read('.atlas/views/Chores.md');
    await page.getByRole('button', { name: 'Due', exact: true }).click();
    await unsaved(page).getByRole('button', { name: 'Save as new view…' }).click();
    const name = page.getByRole('textbox', { name: 'New view name' });
    await name.fill('Chores by due');
    await name.press('Enter');
    await expect.poll(() => vault.exists('.atlas/views/Chores by due.md')).toBe(true);
    expect(await vault.read('.atlas/views/Chores by due.md')).toContain('due');
    expect(await vault.read('.atlas/views/Chores.md')).toBe(before);
  });

  for (const width of [1100, 900]) {
    test(`at ${width}px every action on the bar is inside the window, none cut off`, async ({
      page,
    }) => {
      await openVault(page, { width });
      await page.getByRole('button', { name: 'Due', exact: true }).click();
      await expect(unsaved(page)).toBeVisible();
      const outside = await page.locator('.view-toolbar__actions, .view-save').evaluateAll((bars) =>
        bars.flatMap((bar) =>
          [...bar.querySelectorAll('button')].flatMap((button) => {
            const box = button.getBoundingClientRect();
            const hit = document.elementFromPoint(
              box.left + box.width / 2,
              box.top + box.height / 2,
            );
            return box.right > window.innerWidth || box.left < 0 || !hit || !button.contains(hit)
              ? [
                  `${button.textContent?.trim() || button.getAttribute('aria-label')} at ${Math.round(box.left)}–${Math.round(box.right)}`,
                ]
              : [];
          }),
        ),
      );
      expect(outside).toEqual([]);
    });

    test(`at ${width}px with the bar wrapped the sticky header still meets the sheet’s top`, async ({
      page,
    }) => {
      await openVault(page, { width, tasks: 80 });
      await page.getByRole('button', { name: 'Due', exact: true }).click();
      await expect(unsaved(page)).toBeVisible();
      await page.locator('.table__sheet').evaluate((sheet) => {
        sheet.scrollTop = 400;
      });
      const gap = await page.locator('.table__sheet').evaluate((sheet) => {
        const head = sheet.querySelector('thead th')!.getBoundingClientRect();
        return head.top - sheet.getBoundingClientRect().top;
      });
      expect(Math.abs(gap)).toBeLessThanOrEqual(0.5);
    });
  }
});

type Rgb = [number, number, number];

/** WCAG contrast of an element's text against the opaque ground behind it. */
function contrastOf(page: Page, selector: string) {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      const parse = (colour: string): [number, number, number, number] => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = '#000';
        context.fillStyle = colour;
        context.fillRect(0, 0, 1, 1);
        const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
        return [r, g, b, a / 255];
      };
      const over = (top: number[], under: Rgb): Rgb =>
        [0, 1, 2].map((at) => top[at]! * top[3]! + under[at]! * (1 - top[3]!)) as Rgb;
      const layers: [number, number, number, number][] = [];
      for (let at: Element | null = element; at; at = at.parentElement) {
        const fill = parse(getComputedStyle(at).backgroundColor);
        if (fill[3] > 0) layers.push(fill);
        if (fill[3] >= 1) break;
      }
      let ground: Rgb = [255, 255, 255];
      for (const layer of layers.reverse()) ground = over(layer, ground);
      const ink = over(parse(getComputedStyle(element).color), ground);
      const luminance = (rgb: Rgb) =>
        rgb
          .map((value) => value / 255)
          .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((sum, v, at) => sum + v * [0.2126, 0.7152, 0.0722][at]!, 0);
      const [hi, lo] = [luminance(ink), luminance(ground)].sort((p, q) => q - p) as [
        number,
        number,
      ];
      return (hi + 0.05) / (lo + 0.05);
    });
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: headings, cells, the footer and the notice read at 4.5:1 or better`, async ({
    page,
  }) => {
    await openVault(page);
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((wanted) => {
      document.documentElement.dataset['theme'] = wanted;
    }, theme);
    await page.getByRole('button', { name: 'Due', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Unsaved view changes' })).toBeVisible();
    await page.evaluate(() =>
      Promise.allSettled(document.getAnimations().map((running) => running.finished)),
    );
    const low: string[] = [];
    for (const selector of [
      '.table__heading',
      '.table__heading--sorted',
      '.table__link',
      'td .table__cell',
      '.table__group-label',
      '.table__group-count',
      '.table__count',
      '.table__total',
      '.table__arrangement',
      '.view-save__text',
    ]) {
      const ratio = await contrastOf(page, selector);
      expect(ratio, `${selector} measured`).toBeGreaterThan(1);
      if (ratio < 4.5) low.push(`${selector}: ${ratio.toFixed(2)}`);
    }
    expect(low).toEqual([]);
  });
}

test('the input a cell edits in shows its whole ring inside the 34px row', async ({ page }) => {
  await openVault(page);
  const row = rowOf(page, 'Chore 03');
  // A text cell: since #300 a status opens its picker rather than a field.
  await row.locator('[data-cell-stop="notes"]').click();
  const input = row.locator('input.table__input');
  await expect(input).toBeFocused();
  const fits = await input.evaluate((element) => {
    const ring =
      parseFloat(getComputedStyle(element).boxShadow.match(/(\d+(?:\.\d+)?)px\s*$/)?.[1] ?? '0') ||
      1.5;
    const box = element.getBoundingClientRect();
    const problems: string[] = [];
    for (
      let at = element.parentElement;
      at && !at.classList.contains('table__sheet');
      at = at.parentElement
    ) {
      const style = getComputedStyle(at);
      if (style.overflow === 'visible') continue;
      const clip = at.getBoundingClientRect();
      if (
        box.top - ring < clip.top ||
        box.bottom + ring > clip.bottom ||
        box.left - ring < clip.left ||
        box.right + ring > clip.right
      ) {
        problems.push(`clipped by ${at.tagName}.${at.className}`);
      }
    }
    const line = element.closest('tr')!.getBoundingClientRect();
    if (box.top - ring < line.top || box.bottom + ring > line.bottom)
      problems.push('ring outside the row');
    return problems;
  });
  expect(fits).toEqual([]);
  expect((await row.boundingBox())!.height).toBeCloseTo(ROW_HEIGHT, 0);
});
