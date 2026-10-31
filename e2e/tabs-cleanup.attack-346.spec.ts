import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';

/*
 * Attack on #346: opening and closing many tabs leaves nothing behind — no
 * editor past the limit, no listener on the window or document, no timer.
 * Counted by wrapping the browser's own registration functions before the
 * app loads.
 */

const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'] as const;

interface Counts {
  listeners: number;
  timers: number;
}

/** Wraps add/removeEventListener on window and document, and setTimeout/setInterval. */
const instrument = () => {
  const live = new Set<unknown>();
  const listeners = new Map<string, number>();
  const keyOf = (target: string, type: string) => `${target}:${type}`;
  for (const [name, target] of [
    ['window', window],
    ['document', document],
  ] as const) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    const held = new WeakMap<object, Set<string>>();
    target.addEventListener = ((type: string, listener: unknown, options?: unknown) => {
      if ((listener !== null && typeof listener === 'object') || typeof listener === 'function') {
        const capture =
          typeof options === 'boolean'
            ? options
            : Boolean((options as { capture?: boolean })?.capture);
        const id = `${type}|${capture}`;
        const set = held.get(listener as object) ?? new Set<string>();
        if (!set.has(id)) {
          set.add(id);
          held.set(listener as object, set);
          listeners.set(keyOf(name, type), (listeners.get(keyOf(name, type)) ?? 0) + 1);
        }
      }
      add(type, listener as EventListener, options as AddEventListenerOptions);
    }) as typeof target.addEventListener;
    target.removeEventListener = ((type: string, listener: unknown, options?: unknown) => {
      const capture =
        typeof options === 'boolean'
          ? options
          : Boolean((options as { capture?: boolean })?.capture);
      const id = `${type}|${capture}`;
      const set = listener === null ? undefined : held.get(listener as object);
      if (set?.delete(id) === true) {
        listeners.set(keyOf(name, type), (listeners.get(keyOf(name, type)) ?? 0) - 1);
      }
      remove(type, listener as EventListener, options as EventListenerOptions);
    }) as typeof target.removeEventListener;
  }
  const setT = window.setTimeout.bind(window);
  const clearT = window.clearTimeout.bind(window);
  const setI = window.setInterval.bind(window);
  const clearI = window.clearInterval.bind(window);
  window.setTimeout = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) => {
    const id = setT(
      (...args: unknown[]) => {
        live.delete(id);
        if (typeof handler === 'function') handler(...args);
      },
      ms,
      ...rest,
    );
    live.add(id);
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id?: number) => {
    live.delete(id);
    clearT(id);
  }) as typeof window.clearTimeout;
  window.setInterval = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) => {
    const id = setI(handler, ms, ...rest);
    live.add(`i${id}`);
    return id;
  }) as typeof window.setInterval;
  window.clearInterval = ((id?: number) => {
    live.delete(`i${id}`);
    clearI(id);
  }) as typeof window.clearInterval;
  (window as unknown as { __counts: () => unknown }).__counts = () => ({
    listeners: [...listeners.values()].reduce((sum, n) => sum + n, 0),
    timers: live.size,
  });
};

const counts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __counts: () => Counts }).__counts());

const row = (page: Page, name: string) =>
  sidebarSection(page, 'userSpace').getByRole('treeitem', { name, exact: true });
const pane = (page: Page) => page.getByRole('region', { name: 'Pane 1' });
const tabsOf = (page: Page) => page.getByRole('tablist', { name: 'Pane 1 tabs' }).getByRole('tab');

test('opening and closing fifty tabs leaves no editor, listener or timer behind', async ({
  page,
}) => {
  await page.addInitScript(instrument);
  const vault = await createVault();
  for (const name of NAMES) await vault.write(`${name}.md`, `# ${name}\n\nLine of ${name}.\n`);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await row(page, 'alpha').click();
  await expect(pane(page).getByRole('article', { name: 'alpha', exact: true })).toBeVisible();
  // One round first, so whatever a first tab switch sets up once is in the baseline.
  await row(page, 'beta').click({ modifiers: ['Meta'] });
  await expect(tabsOf(page)).toHaveCount(2);
  await page.keyboard.press('Meta+w');
  await expect(tabsOf(page)).toHaveCount(1);
  await expect(pane(page).locator('.pane__tab')).toHaveCount(1);
  const before = await counts(page);

  for (let round = 0; round < 50; round += 1) {
    const name = NAMES[1 + (round % (NAMES.length - 1))] as string;
    await row(page, name).click({ modifiers: ['Meta'] });
    await expect(pane(page).getByRole('article', { name, exact: true })).toBeVisible();
    // Every other round closes it at once; the rest pile up and close in a batch.
    if (round % 2 === 0) await page.keyboard.press('Meta+w');
    await expect(pane(page).locator('.pane__tab')).not.toHaveCount(6);
  }
  while ((await tabsOf(page).count()) > 1) {
    const at = await tabsOf(page).count();
    await page.keyboard.press('Meta+w');
    await expect(tabsOf(page)).toHaveCount(at - 1);
  }
  await expect(tabsOf(page)).toHaveText(['alpha']);
  await expect(pane(page).locator('.pane__tab')).toHaveCount(1);
  await expect
    .poll(async () => (await counts(page)).timers, { timeout: 10_000 })
    .toBeLessThanOrEqual(before.timers);
  expect((await counts(page)).listeners).toBeLessThanOrEqual(before.listeners);
});
