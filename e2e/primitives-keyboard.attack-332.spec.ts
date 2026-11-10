import { expect, test, type Page } from './fixtures.ts';
import { focusedRing } from './focus-ring.ts';
import { createVault, installHost } from './host.ts';
import { inboxRowsInReach } from './inbox.ts';

// Attack on #332: the rewrite of #328's ring tests focuses each primitive from
// script. These walk the real keyboard path instead — Option+Tab, which in
// WebKit (and Safari, and the Tauri window) is what reaches a plain <button>
// — and require that what it reaches shows its ring, unclipped.

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
    await inboxRowsInReach(page);
    await expect(page.locator('.inbox__row .btn').first()).toBeVisible();
  },
  today: async (page) => {
    await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Today' }).click();
    await expect(
      page.getByRole('article', { name: 'Today' }).locator('.status-pill').first(),
    ).toBeVisible();
  },
};

/** The primitives Option+Tab lands on in `steps` presses, and what each looked like. */
async function optionTabWalk(page: Page, steps: number) {
  const landed: { label: string; visible: boolean; ring: string }[] = [];
  const clipped: string[] = [];
  for (let step = 0; step < steps; step += 1) {
    await page.keyboard.press('Alt+Tab');
    const now = await focusedRing(page);
    if (now === null) continue;
    landed.push({
      label: `${now.classes.join('.')} "${now.name.slice(0, 24)}"`,
      visible: now.visible,
      ring: now.ring,
    });
    const cut = await ringClipping(page);
    if (cut !== null) clipped.push(cut);
  }
  return { landed, clipped };
}

for (const theme of THEMES) {
  for (const [surface, open] of Object.entries(RING_SURFACES)) {
    test(`Option+Tab reaches a primitive on ${surface} and it shows its whole ring in ${theme}`, async ({
      page,
    }) => {
      await openVault(page);
      await setTheme(page, theme);
      await open(page);
      const { landed, clipped } = await optionTabWalk(page, 40);
      expect(landed.length, 'primitives Option+Tab reached').toBeGreaterThan(0);
      const unringed = landed.filter((one) => !one.visible || one.ring === 'none');
      expect(unringed, 'reached but drawn without a ring').toEqual([]);
      expect(clipped).toEqual([]);
    });
  }
}
