import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost } from './host.ts';
import { sweep } from './today-sweep.ts';

/**
 * Adversarial pass on #644, in WebKit: the 500-row Tab sweeps record each stop
 * in the page. Some of what a focus sets off happens only at the next frame — a
 * CSS transition, a ResizeObserver callback — and a recorder that read a stop
 * at the next Tab, when that Tab changed nothing it watched, missed both, where
 * the per-press sweep it replaced (two frames after every key) caught them. So
 * every stop now waits out a frame. These stand in for such an app on a page
 * short enough that no Tab scrolls, so nothing else holds a Tab back.
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

/** A focus style that, a frame later, puts the control far below the screen. */
const slidAwayByTransition = (page: Page) =>
  page.addStyleTag({
    content: `${CONTROL}:focus { transform: translateY(3000px); transition: transform 0s 12ms; }`,
  });

/** A control that, once focused, a ResizeObserver moves off the screen. */
const movedByResizeObserver = (page: Page) =>
  page.evaluate((selector) => {
    document.addEventListener('focusin', (event) => {
      const control = event.target as HTMLElement;
      if (!control.matches(selector)) return;
      const watch = new ResizeObserver(() => {
        watch.disconnect();
        if (document.activeElement === control) control.style.transform = 'translateY(3000px)';
      });
      watch.observe(control);
    });
  }, CONTROL);

/** Focuses the control and reads, once its frames have run, whether it is wholly on screen. */
const focusedControlInView = (page: Page) =>
  page.evaluate(async (selector) => {
    const control = document.querySelector<HTMLElement>(selector)!;
    control.focus();
    for (let frames = 0; frames < 6; frames += 1) {
      await new Promise((done) => requestAnimationFrame(done));
    }
    const box = control.getBoundingClientRect();
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

    expect(await focusedControlInView(page)).toBe(false);
  });

  test(`a Tab sweep reports the control ${kind} moves off screen`, async ({ page }) => {
    const today = await openToday(page);
    await standIn(page);
    await today.locator('input.done-check').first().focus();

    const forward = await sweep(page, 'Tab', 200);

    expect(forward.rows.size).toBe(TASKS);
    expect(fromTheTarget(forward.offScreen)).not.toEqual([]);
  });
}
