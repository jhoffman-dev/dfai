import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost } from './host.ts';
import { sweep } from './today-sweep.ts';

/**
 * Adversarial pass on #644, in WebKit: the 500-row Tab sweeps record each stop
 * in the page. Some of what a focus sets off happens only later — a CSS
 * transition, a ResizeObserver callback — and a recorder that read a stop at
 * the next Tab, when that Tab changed nothing it watched, missed both. These
 * stand in for such an app on a page short enough that no Tab scrolls, so
 * nothing else holds a Tab back.
 *
 * Neither is a matter of frames. A transition's delay is the page's to set, and
 * when an engine calls a ResizeObserver back is its own: on Linux, and on a
 * loaded Mac, not within a few frames (PR #649). So the transition here waits
 * far longer than any count of frames would cover, and the recorder is held
 * until what it watches has finished, not for a number of frames.
 */

const NOW = new Date(2026, 9, 13, 12, 0, 0);
const TASKS = 8;
const TARGET = 'Task 004';

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '---',
  '',
].join('\n');

async function openToday(page: Page) {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'Tasks']) await vault.mkdir(folder);
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  for (let n = 1; n <= TASKS; n += 1) {
    await vault.write(
      `Tasks/Task ${String(n).padStart(3, '0')}.md`,
      '---\ntype: task\nstatus: next-action\n---\n\nA task.\n',
    );
  }
  await installHost(page, vault);
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Today' }).click();
  const today = page.getByRole('article', { name: 'Today' });
  await expect(today.locator(`tr[data-today-row*="${TARGET}"]`)).toBeVisible();
  return today;
}

// One control in the middle of a row: the Tab to it moves within the row, so
// the page draws nothing again and the recorder holds nothing back.
const CONTROL = `tr[data-today-row*="${TARGET}"] [aria-label^="Choose"]`;

/** A focus style that, a quarter of a second later, puts the control far below the screen. */
const slidAwayByTransition = (page: Page) =>
  page.addStyleTag({
    content: `${CONTROL}:focus { transform: translateY(3000px); transition: transform 0s 250ms; }`,
  });

/** A control that, once focused, a ResizeObserver moves off the screen. */
const movedByResizeObserver = (page: Page) =>
  page.evaluate((selector) => {
    document.addEventListener('focusin', (event) => {
      const control = event.target as HTMLElement;
      if (!control.matches(selector)) return;
      // Moved on the answer its focus asked for, whatever has the focus as it
      // comes: on Linux CI the engine once called back while the focus was off
      // the control for a moment, and a stand-in that checked for it moved nothing.
      const watch = new ResizeObserver(() => {
        watch.disconnect();
        control.style.transform = 'translateY(3000px)';
      });
      watch.observe(control);
    });
  }, CONTROL);

/** Whether the control is wholly on screen. */
const controlInView = (page: Page) =>
  page.evaluate((selector) => {
    const box = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= window.innerHeight;
  }, CONTROL);

const fromTheTarget = (labels: string[]) => labels.filter((label) => label.includes(TARGET));

for (const [kind, standIn] of [
  ['a focus transition', slidAwayByTransition],
  ['a ResizeObserver', movedByResizeObserver],
] as const) {
  test(`the stand-in for ${kind} carries the focused control off screen`, async ({ page }) => {
    await openToday(page);
    await standIn(page);
    // In view before the focus, so that it is the stand-in that takes it away.
    await page.locator(CONTROL).scrollIntoViewIfNeeded();
    expect(await controlInView(page)).toBe(true);

    await page.locator(CONTROL).focus();

    await expect.poll(() => controlInView(page)).toBe(false);
  });

  test(`a Tab sweep reports the control ${kind} moves off screen`, async ({ page }) => {
    const today = await openToday(page);
    await standIn(page);
    await today.locator('input.done-check').first().focus();

    const forward = await sweep(page, 'Tab', 200);

    expect(forward.rows.size).toBe(TASKS);
    expect(
      fromTheTarget(forward.offScreen),
      `the stops around the target, as the recorder saw them:\n${fromTheTarget(forward.trace).join('\n')}`,
    ).not.toEqual([]);
  });
}

test('a sweep is not held by an observer that stops watching before it answers', async ({
  page,
}) => {
  const today = await openToday(page);
  // A hook that observes on focus and lets go at once, as one re-observing on every render does.
  await page.evaluate((selector) => {
    document.addEventListener('focusin', (event) => {
      const control = event.target as HTMLElement;
      if (!control.matches(selector)) return;
      const first = new ResizeObserver(() => {});
      first.observe(control);
      first.unobserve(control);
      const second = new ResizeObserver(() => {});
      second.observe(control);
      second.disconnect();
    });
  }, CONTROL);
  await today.locator('input.done-check').first().focus();

  const forward = await sweep(page, 'Tab', 200);

  expect(forward.rows.size).toBe(TASKS);
});
