import type { Locator, Page } from './fixtures.ts';

/**
 * The vault the web build's core-loop specs (#669) sign in to, and the steps
 * they share, by touch on the iPad and by keyboard on the desktop.
 */

const note = (frontmatter: string[], body: string) =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n');

/** The Task type, as core-loop.ipad.spec.ts has it: signing in adds `chosen` to it, in commits of its own. */
const TASK_TYPE = note(
  [
    'name: task',
    'label: Task',
    'properties:',
    '  status:',
    '    kind: select',
    '    options: [inbox, next-action, in-progress, archive]',
    '    done: archive',
    '  completed: date',
  ],
  '# Task',
);

export const PLAN = '# Garden plan\n\nFirst line.\n';

export const GARDEN_VAULT: Readonly<Record<string, string>> = {
  '.atlas/types/task.md': TASK_TYPE,
  'Tasks/Sow the beans.md': note(['type: task', 'status: next-action'], 'A task.'),
  'Inbox/Seed swap idea.md': note(
    ['type: task', 'status: inbox'],
    'Ask about the sourdough starter.',
  ),
  'Garden plan.md': PLAN,
};

/**
 * Opens the web build at `url` and signs in by `press`ing the sign-in button
 * (a tap, or Enter), landing on the vault once the browser's index has read it.
 */
export async function signedInOnTheWeb(
  page: Page,
  { url, press }: { url: string; press: (button: Locator) => Promise<void> },
) {
  await page.goto(url);
  await press(page.getByRole('button', { name: 'Sign in with GitHub' }));
  await page.getByRole('button', { name: 'Sign out' }).waitFor();
  await page.getByText(/^\d+ notes indexed$/).waitFor();
}

export const saveStatus = (page: Page) =>
  page.getByRole('status').filter({ hasText: /Sav|Not saved/ });

/**
 * How many reads of GitHub the device keeps for offline (#667), in the read
 * cache's IndexedDB database (`READ_CACHE_DATABASE` in the adapters). Never
 * opened when absent: opening would make it, empty, under the app's feet.
 */
export function readsKeptOnTheDevice(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const name = 'dfai-read-cache';
    if (!(await indexedDB.databases()).some((database) => database.name === name)) return 0;
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open(name);
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error ?? new Error(`${name} did not open`));
    });
    try {
      if (!database.objectStoreNames.contains('reads')) return 0;
      const counting = database.transaction('reads').objectStore('reads').count();
      return await new Promise<number>((resolve, reject) => {
        counting.onsuccess = () => resolve(counting.result);
        counting.onerror = () => reject(counting.error ?? new Error('the reads did not count'));
      });
    } finally {
      database.close();
    }
  });
}
