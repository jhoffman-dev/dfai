import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  emitVaultChanged,
  expectFile,
  installHost,
  saveNow,
  type FakeVault,
} from './host.ts';
import { caretAtLineEnd } from './caret.ts';

/**
 * #135: indexing a vault must never take the window away. These build a vault
 * large enough that its index takes many batches, and act on the window while
 * the build is under way.
 *
 * `INDEX_E2E_NOTES` makes the vault any size, for measuring by hand: the
 * numbers are printed, and the issue's bar of 5,000 notes is run that way.
 */
const LARGE = Number(process.env.INDEX_E2E_NOTES ?? 1500);

/** The longest the main thread may go without running a timer while a vault is indexed. */
const LONGEST_TASK_MS = 200;

/**
 * The same bar when the notes are read in the window. That mode reads a note
 * per task and its measurement spans a click and a note opening, so the slower
 * CI runner comes close to the worker's cap (76 ms there against 48 ms here);
 * this one is still well under the 402 to 1,173 ms tasks the fix removed.
 */
const LONGEST_TASK_IN_WINDOW_MS = 500;

/** A note like the ones people keep: properties, links, tags, a checklist and a block id. */
function noteText(n: number, count: number): string {
  const paragraphs = Array.from(
    { length: 6 },
    (_, p) =>
      `Paragraph ${p} of note ${n} mentions [[Note ${(n * 7 + p) % count}]] and #topic${n % 40} with **bold**, \`code\` and a [link](https://example.com/${n}).`,
  );
  return [
    '---',
    `type: ${n % 5 === 0 ? 'task' : 'note'}`,
    `status: ${n % 3 === 0 ? 'next' : 'inbox'}`,
    `project: "[[Note ${(n + 1) % count}]]"`,
    `due: 2026-10-${String((n % 28) + 1).padStart(2, '0')}`,
    'tags: [alpha, beta]',
    '---',
    `# Note ${n}`,
    '',
    ...paragraphs.flatMap((paragraph) => [paragraph, '']),
    '- [ ] first thing',
    '- [x] second thing',
    '',
    `A block worth pointing at. ^blk${n}`,
    '',
  ].join('\n');
}

/** A vault of this many generated notes spread over folders, with one plain note at its root. */
async function largeVault({
  count,
  folders,
}: {
  count: number;
  folders: number;
}): Promise<FakeVault> {
  const vault = await createVault();
  for (let folder = 0; folder < folders; folder++) {
    await mkdir(join(vault.root, `Folder ${folder}`));
  }
  await Promise.all(
    Array.from({ length: count }, (_, n) =>
      writeFile(join(vault.root, `Folder ${n % folders}`, `Note ${n}.md`), noteText(n, count)),
    ),
  );
  await vault.write('Camping.md', 'Pack the tent.\n');
  return vault;
}

interface Watch {
  /** Every stretch the main thread could not run a timer for, longer than 50 ms. */
  stalls: number[];
  /** The longest the main thread went between two firings of the timer, during the build. */
  longestGap: number;
  /** Notes handed to a worker to be read for the index. */
  derivedInWorker: number;
  /** When the first notes were read for the index, and when the last row was written. */
  began: number | null;
  ended: number | null;
}

/**
 * Watches the window's main thread from inside it: a timer that should fire
 * every few milliseconds, and how late each firing was. Also counts the notes
 * that leave for a worker, and brackets the build by its host commands.
 */
async function watchMainThread(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const watch: Watch = {
      stalls: [],
      longestGap: 0,
      derivedInWorker: 0,
      began: null,
      ended: null,
    };
    (window as unknown as { __indexWatch: Watch }).__indexWatch = watch;

    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      if (watch.began !== null && watch.ended === null) {
        watch.longestGap = Math.max(watch.longestGap, now - last);
        if (now - last > 50) watch.stalls.push(now - last);
      }
      last = now;
    }, 4);

    const RealWorker = window.Worker;
    window.Worker = class extends RealWorker {
      override postMessage(message: unknown, ...rest: unknown[]) {
        const { kind, files } = message as { kind?: string; files?: unknown[] };
        if (kind === 'derive') watch.derivedInWorker += files?.length ?? 0;
        (super.postMessage as (...args: unknown[]) => void)(message, ...rest);
      }
    };

    type Invoke = (command: string, ...rest: unknown[]) => Promise<unknown>;
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } })
      .__TAURI_INTERNALS__;
    const invoke = internals.invoke;
    internals.invoke = (command, ...rest) => {
      // The build is from its first batch of notes to its count of what it holds.
      const paths = (rest[0] as { paths?: unknown[] } | undefined)?.paths;
      if (command === 'read_notes' && (paths?.length ?? 0) > 1) watch.began ??= performance.now();
      const answer = invoke(command, ...rest);
      if (command === 'index_stats') void answer.then(() => (watch.ended = performance.now()));
      return answer;
    };
  });
}

const watched = (page: Page) =>
  page.evaluate(() => (window as unknown as { __indexWatch: Watch }).__indexWatch);

test('the sidebar, Settings and an open note all answer while the vault is being indexed', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const count = 300;
  // Few folders, so the note at the root is a row on screen without scrolling.
  const vault = await largeVault({ count, folders: 3 });
  const host = await installHost(page, vault);
  const release = host.holdIndexAfter(2);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();

  // Two batches are in and the third is in flight: the build is under way, and stays so.
  const total = (count + 1).toLocaleString();
  // The line drawn at the foot of the window, not the status a screen reader hears.
  const underWay = page.locator('.index-progress', {
    hasText: new RegExp(`^Indexing \\d+ of ${total}…$`),
  });
  // That status says only that it started: one announcement, not one per batch.
  await expect(page.getByRole('status').filter({ hasText: /^Indexing…$/ })).toHaveCount(1);
  await expect(underWay).toBeVisible();

  // A sidebar row opens its note.
  await page.getByRole('treeitem', { name: 'Camping', exact: true }).click();
  const note = page.getByLabel('Note', { exact: true });
  await expect(note.getByText('Pack the tent.')).toBeVisible();

  // The note takes typing, and saves.
  await caretAtLineEnd(note.getByText('Pack the tent.'));
  await page.keyboard.type(' And the stove.');
  await expect(note.getByText('Pack the tent. And the stove.')).toBeVisible();
  await saveNow(page);
  await expectFile(vault, 'Camping.md').toBe('Pack the tent. And the stove.\n');
  // The host's watcher sees the save, as it sees any write, while the build is still running.
  await emitVaultChanged(page, ['Camping.md']);

  // A page that needs the index says it is waiting for it, rather than being empty or stuck.
  await page.getByRole('button', { name: 'Tags', exact: true }).click();
  await expect(page.getByText('Reading the tags…')).toBeVisible();

  // Settings opens, and says what the index is doing rather than waiting for it.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await expect(settings.getByText(new RegExp(`^Indexing \\d+ of ${total}…$`))).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Rebuild' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  // All of that happened during the build, not after it.
  await expect(underWay).toBeVisible();

  release();
  await expect(page.getByText(`${total} notes indexed`)).toBeVisible({ timeout: 60_000 });
  // And fills in once the index is there.
  await expect(page.getByText('Reading the tags…')).toBeHidden();
  await expect(page.getByRole('main').getByText('alpha', { exact: true })).toBeVisible();
  // The edit made during the build is not lost to it: the refresh the save
  // asked for runs once the build is done, and a search then finds the words.
  await page.keyboard.press('Meta+k');
  const palette = page.getByRole('dialog', { name: 'Search notes' });
  const search = page.getByRole('searchbox', { name: 'Search the vault' });
  await expect(async () => {
    await search.fill('');
    await search.fill('stove');
    await expect(palette.getByRole('option', { name: /Camping/ })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
});

test('indexing a large vault leaves the main thread free', async ({ page }) => {
  test.setTimeout(600_000);
  const vault = await largeVault({ count: LARGE, folders: 50 });
  await installHost(page, vault);
  await watchMainThread(page);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect.poll(async () => (await watched(page)).ended, { timeout: 500_000 }).not.toBeNull();

  const watch = await watched(page);
  const took = (watch.ended ?? 0) - (watch.began ?? 0);
  const stalled = watch.stalls.reduce((sum, stall) => sum + stall, 0);
  // Printed for a run by hand at any size; the assertions below are what a test run holds to.
  process.stdout.write(
    `[index-responsive] ${LARGE + 1} notes: built in ${Math.round(took)} ms; main thread ` +
      `stalled ${Math.round(stalled)} ms in ${watch.stalls.length} stretches over 50 ms; ` +
      `its longest task was ${Math.round(watch.longestGap)} ms\n`,
  );

  // Every note was read for the index somewhere other than the main thread.
  expect(watch.derivedInWorker).toBe(LARGE + 1);
  // And the main thread was the window's throughout. Read on it, the notes
  // were one task of half a second and more per batch; the issue asks for
  // none over about 50 ms, and it measures 12 to 14 ms here. The cap is well
  // above that, for a busy CI machine's worst frame, and well below what it
  // was.
  expect(watch.longestGap).toBeLessThan(LONGEST_TASK_MS);
});

test('with no worker to read the notes, the vault is still indexed and the window still answers', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const count = 600;
  const vault = await largeVault({ count, folders: 3 });
  const host = await installHost(page, vault);
  await watchMainThread(page);
  // The window refuses to start workers, as a webview might: after the watch,
  // so this is the `Worker` the app finds.
  await page.addInitScript(() => {
    if (window !== window.top) return;
    window.Worker = class {
      constructor() {
        throw new Error('workers are not allowed here');
      }
    } as unknown as typeof Worker;
  });
  const release = host.holdIndexAfter(2);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  const total = (count + 1).toLocaleString();
  const underWay = page.locator('.index-progress', {
    hasText: new RegExp(`^Indexing \\d+ of ${total}…$`),
  });
  await expect(underWay).toBeVisible();

  // Mid-build, the window is still the user's.
  await page.getByRole('treeitem', { name: 'Camping', exact: true }).click();
  await expect(page.getByLabel('Note', { exact: true }).getByText('Pack the tent.')).toBeVisible();
  await expect(underWay).toBeVisible();

  release();
  await expect(page.getByRole('status').filter({ hasText: `${total} notes indexed` })).toHaveCount(
    1,
    { timeout: 120_000 },
  );

  const watch = await watched(page);
  // Read in the window, a note at a time with a breath between: no worker saw one.
  expect(watch.derivedInWorker).toBe(0);
  expect(watch.longestGap).toBeLessThan(LONGEST_TASK_IN_WINDOW_MS);
  // And it is said, once, so a slow index has its reason on record. The line
  // is recorded as the build ends, with the status, but written a moment
  // later with whatever else came (ACTIVITY_WRITE_DELAY_MS): so the file is
  // waited on, not read once (#444).
  await expect
    .poll(() => host.activityLog().match(/Indexing in the window, which is slower/g) ?? [])
    .toHaveLength(1);
  expect(host.activityLog()).toContain('Workers are not allowed here.');
  process.stdout.write(
    `[index-responsive] ${count + 1} notes in the window: its longest task was ${Math.round(watch.longestGap)} ms\n`,
  );
});
