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
 * The keys of the reads of GitHub the device keeps for offline (#667), in
 * the read cache's IndexedDB database (`READ_CACHE_DATABASE` in the
 * adapters). Never opened when absent: opening would make it, empty, under
 * the app's feet.
 */
function keysKeptOnTheDevice(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const name = 'dfai-read-cache';
    if (!(await indexedDB.databases()).some((database) => database.name === name)) return [];
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open(name);
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error ?? new Error(`${name} did not open`));
    });
    try {
      if (!database.objectStoreNames.contains('reads')) return [];
      const listing = database.transaction('reads').objectStore('reads').getAllKeys();
      return await new Promise<string[]>((resolve, reject) => {
        listing.onsuccess = () => resolve(listing.result.map(String));
        listing.onerror = () => reject(listing.error ?? new Error('the reads did not list'));
      });
    } finally {
      database.close();
    }
  });
}

/** How many reads of GitHub the device keeps for offline (#667). */
export async function readsKeptOnTheDevice(page: Page): Promise<number> {
  return (await keysKeptOnTheDevice(page)).length;
}

/**
 * Whether the device keeps the read of a note (`note`) or of a folder's
 * listing (`directory`, the root as ''), whoever it is kept for. A keep is
 * written after the read answers, so a spec that reloads to read it offline
 * waits for this first: the note on screen is a moment, this is the state.
 */
export async function readKeptOnTheDevice(
  page: Page,
  kind: 'note' | 'directory',
  asked: string,
): Promise<boolean> {
  const ending = `\u0000${kind}\u0000${asked}`;
  return (await keysKeptOnTheDevice(page)).some((key) => key.endsWith(ending));
}
