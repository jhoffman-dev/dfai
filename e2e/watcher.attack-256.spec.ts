import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  emitVaultChanged,
  expectFile,
  installHost,
  sidebarSection,
  type FakeHost,
  type FakeVault,
} from './host.ts';
import { dragCardTo } from './drag.ts';
import { pickSuggestion } from './link-suggest.ts';

/**
 * Attacks on PR #256 (#254): with the host echoing the app's own writes, as
 * the real watcher does, deciding an Inbox row and dragging a board card each
 * walk the vault no more often than with no echo at all, and a change from
 * outside after them still reaches the index.
 */

const note = (frontmatter: string[], body: string) =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n');

const GTD_TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '  project:',
  '    kind: relation',
  '    target: project',
  '---',
  '',
  '# Task',
  '',
].join('\n');

const PROJECT_TYPE = [
  '---',
  'name: project',
  'label: Project',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [planned, active, paused, done]',
  '    done: done',
  '---',
  '',
  '# Project',
  '',
].join('\n');

const BOARD_TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, doing, done]',
  '---',
  '',
].join('\n');

const BOARD = [
  '---',
  'atlas: view',
  'type: task',
  'layout: board',
  'groupBy: status',
  'columns: [status]',
  'limit: 50',
  '---',
  '',
  '# Board',
  '',
].join('\n');

const indexedCount = async (page: Page) =>
  Number(/^(\d+)/.exec((await page.getByText(/^\d+ notes indexed/).textContent()) ?? '')?.[1]);

/** Another program adds a note, and the watcher tells; resolves once the index holds it. */
async function addFromOutside(page: Page, vault: FakeVault, at: string) {
  const indexed = await indexedCount(page);
  await vault.write(at, note(['type: task', 'status: backlog'], 'From outside.'));
  await emitVaultChanged(page, [at]);
  await expect(page.getByText(new RegExp(`^${indexed + 1} notes indexed`))).toBeVisible();
}

/**
 * Records, in the page, each walk of the vault the app starts and each report
 * the watcher sends, in order, and how many host calls are still unanswered.
 */
async function recordWalksAndReports(page: Page) {
  await page.addInitScript(() => {
    type Internals = {
      invoke: (command: string, args: unknown, options?: unknown) => Promise<unknown>;
      transformCallback: (callback: (event: { payload: unknown }) => void) => number;
    };
    const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
    const invoke = internals.invoke;
    const seen = { order: [] as string[], unanswered: 0 };
    Object.assign(window, { __attack256: seen });
    internals.invoke = (command, args, options) => {
      if (command === 'list_notes') seen.order.push('walk');
      seen.unanswered += 1;
      const answered = invoke(command, args, options);
      void answered.then(
        () => void (seen.unanswered -= 1),
        () => void (seen.unanswered -= 1),
      );
      return answered;
    };
    const heard = internals.transformCallback(() => void seen.order.push('report'));
    void invoke('plugin:event|listen', { event: 'vault-changed', handler: heard });
  });
}

const seenSoFar = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __attack256: { order: string[]; unanswered: number } }).__attack256,
  );

/**
 * No host call is waiting, and no walk or report began over a frame, on two
 * looks in a row: whatever the app asked for has been asked and answered.
 * It assumes the app's own refresh starts with a host call, not a timer.
 */
async function quiet(page: Page) {
  let calmLooks = 0;
  await expect
    .poll(
      async () => {
        const before = await seenSoFar(page);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
        const after = await seenSoFar(page);
        const calm =
          before.unanswered === 0 &&
          after.unanswered === 0 &&
          after.order.length === before.order.length;
        calmLooks = calm ? calmLooks + 1 : 0;
        return calmLooks;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(2);
}

/**
 * Does `act`, lets the app finish the refresh it asks for its own writes, and
 * only then lets the watcher's echo of them through. Says how many walks of
 * the vault the app started after the echo arrived: none, when the echo is
 * known as the app's own.
 *
 * Held, because the watcher's 400 ms is no promise: on a slow runner a refresh
 * the app asked before the echo can still be waiting behind another walk when
 * the echo arrives, and would be counted as the echo's. That case is attacked
 * on its own, below, against a run with no echo at all.
 */
async function walksAfterTheEcho(page: Page, host: FakeHost, act: () => Promise<void>) {
  const echoesBefore = await host.echoesSent();
  const letEchoesGo = await host.holdEchoes();
  await act();
  await quiet(page);
  await letEchoesGo();
  await expect.poll(() => host.echoesSent()).toBeGreaterThan(echoesBefore);
  return walksSinceTheLastReport(page);
}

/** Once the app has answered the last report, the walks it started after it. */
async function walksSinceTheLastReport(page: Page) {
  // Settled: no host call is waiting, so whatever the report set off has been asked and answered.
  await expect.poll(async () => (await seenSoFar(page)).unanswered).toBe(0);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  await expect.poll(async () => (await seenSoFar(page)).unanswered).toBe(0);
  const { order } = await seenSoFar(page);
  return order.slice(order.lastIndexOf('report') + 1).filter((each) => each === 'walk').length;
}

/**
 * Opens the vault with every walk and report recorded. What the app writes as
 * it opens is echoed only once it has done all it asked for, `wroteAsItOpened`
 * included, for the reason `walksAfterTheEcho` gives.
 */
async function openedForCounting(
  page: Page,
  vault: FakeVault,
  wroteAsItOpened: () => Promise<void> = async () => {},
): Promise<FakeHost> {
  const host = await installHost(page, vault, { echoWrites: true });
  await recordWalksAndReports(page);
  await page.goto('/');
  const letEchoesGo = await host.holdEchoes();
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await wroteAsItOpened();
  await quiet(page);
  await letEchoesGo();
  return host;
}

/**
 * A GTD vault whose Inbox holds one task: the app writes the Block type into
 * it as it opens (P31-01).
 */
async function gtdVaultWithAnInbox(): Promise<FakeVault> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'Projects', 'Inbox']) await vault.mkdir(folder);
  await vault.write('.atlas/types/task.md', GTD_TASK_TYPE);
  await vault.write('.atlas/types/project.md', PROJECT_TYPE);
  await vault.write('Projects/DFAI.md', note(['type: project', 'status: active'], 'The app.'));
  await vault.write('Inbox/Renew the passport.md', note(['type: task', 'status: inbox'], 'Card.'));
  return vault;
}

test('the watcher’s echo of deciding an Inbox row is not refreshed for again (#254)', async ({
  page,
}) => {
  const vault = await gtdVaultWithAnInbox();
  // The app writes the Block type into a GTD vault as it opens (P31-01). The
  // host reports the new note's time, so its echo is known as the app's own:
  // nothing is walked for it (#258).
  const host = await openedForCounting(page, vault, () =>
    expectFile(vault, '.atlas/types/block.md').toContain('block'),
  );
  await expect.poll(() => host.echoesSent()).toBeGreaterThan(0);
  expect(await walksSinceTheLastReport(page)).toBe(0);
  await page
    .getByRole('list', { name: 'Go to' })
    .getByRole('button', { name: /^Inbox/ })
    .click();
  const inbox = page.getByRole('article', { name: 'Inbox' });
  await expect(inbox.getByRole('button', { name: 'Renew the passport' })).toBeVisible();

  const walks = await walksAfterTheEcho(page, host, async () => {
    await pickSuggestion(
      inbox.getByRole('combobox', { name: 'File Renew the passport under' }),
      'DFAI',
    );
    await inbox
      .getByRole('form', { name: 'Clarify Renew the passport' })
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect.poll(() => vault.exists('Inbox/Renew the passport.md')).toBe(false);
  });
  expect(walks).toBe(0);
  // And a change from outside after it is still heard.
  await addFromOutside(page, vault, 'From outside.md');
});

/**
 * Opens a GTD vault with its opening walk held until the Block type is
 * written — and, with `echoWrites`, until its echo has arrived — then says
 * how many walks of the vault the app made in all, once it has done.
 */
/** Where the app records the built-in properties it has added (`addShippedProperties`). */
const SHIPPED_PROPERTIES_RECORD = '.atlas/migrations/type-properties.md';

async function walksOpeningSlowly(page: Page, echoWrites: boolean): Promise<number> {
  const vault = await gtdVaultWithAnInbox();
  const host = await installHost(page, vault, { echoWrites });
  await recordWalksAndReports(page);
  const letTheWalkGo = host.holdIndexAfter(0);
  // A busy runner: the record of the built-in properties, the app's last
  // write as it opens, is still being written when the Block type is on disk.
  const letTheRecordGo = echoWrites ? () => {} : host.holdWrites(SHIPPED_PROPERTIES_RECORD);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expectFile(vault, '.atlas/types/block.md').toContain('block');
  if (echoWrites) await expect.poll(() => host.echoesSent()).toBeGreaterThan(0);
  letTheWalkGo();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  letTheRecordGo();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await quiet(page);
  return (await seenSoFar(page)).order.filter((each) => each === 'walk').length;
}

test('the Block type’s echo, heard while the opening walk is still under way, is not walked for (#258)', async ({
  page,
  browser,
}) => {
  // A slow runner: the opening walk outlasts the watcher's 400 ms, so the
  // echo of the Block type arrives while the refresh the app asked for it
  // still waits behind that walk. That refresh walks after the echo, as it
  // would with no echo at all; the echo itself adds none.
  const unheard = await browser.newPage();
  try {
    const withNoEcho = await walksOpeningSlowly(unheard, false);
    expect(withNoEcho).toBeGreaterThan(0);
    expect(await walksOpeningSlowly(page, true)).toBe(withNoEcho);
  } finally {
    await unheard.close();
  }
});

test('the watcher’s echo of dragging a board card is not refreshed for again (#254)', async ({
  page,
}) => {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', BOARD_TASK_TYPE);
  await vault.write('.atlas/views/Board.md', BOARD);
  await vault.write('first.md', note(['type: task', 'status: backlog'], '# First'));
  await vault.write('second.md', note(['type: task', 'status: doing'], '# Second'));
  const host = await openedForCounting(page, vault);
  await sidebarSection(page, 'views').getByRole('button', { name: 'Board', exact: true }).click();
  await page.locator('[data-path="first.md"]').waitFor();

  const walks = await walksAfterTheEcho(page, host, async () => {
    await dragCardTo(page, 'first.md', 'Done');
    await expectFile(vault, 'first.md').toContain('status: done');
  });
  expect(walks).toBe(0);
  await addFromOutside(page, vault, 'From outside.md');
});

test('another program’s write straight after a drag, before its echo, still reaches the board (#254)', async ({
  page,
}) => {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', BOARD_TASK_TYPE);
  await vault.write('.atlas/views/Board.md', BOARD);
  await vault.write('first.md', note(['type: task', 'status: backlog'], '# First'));
  await vault.write('second.md', note(['type: task', 'status: doing'], '# Second'));
  const host = await openedForCounting(page, vault);
  await sidebarSection(page, 'views').getByRole('button', { name: 'Board', exact: true }).click();
  await page.locator('[data-path="first.md"]').waitFor();
  const echoesBefore = await host.echoesSent();

  await dragCardTo(page, 'first.md', 'Done');
  await expectFile(vault, 'first.md').toContain('status: done');
  // A sync client brings the other machine's version, inside the echo's 400 ms.
  await vault.write('first.md', note(['type: task', 'status: doing'], '# First, from the laptop'));
  await emitVaultChanged(page, ['first.md']);
  await expect.poll(() => host.echoesSent()).toBeGreaterThan(echoesBefore);

  await expect(
    page.getByRole('region', { name: 'Doing' }).locator('[data-path="first.md"]'),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Done' }).locator('[data-path="first.md"]'),
  ).toHaveCount(0);
});

/** Opens the board vault, counting walks and reports, with the board in view. */
async function boardForCounting(page: Page) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', BOARD_TASK_TYPE);
  await vault.write('.atlas/views/Board.md', BOARD);
  await vault.write('first.md', note(['type: task', 'status: backlog'], '# First'));
  const host = await openedForCounting(page, vault);
  await sidebarSection(page, 'views').getByRole('button', { name: 'Board', exact: true }).click();
  await page.locator('[data-path="first.md"]').waitFor();
  return { vault, host };
}

/** Adds a card in `doing` from the board, and resolves to the path of the note it made. */
async function addCard(page: Page, title: string): Promise<string> {
  await page.getByRole('button', { name: 'Add to Doing' }).click();
  const input = page.getByRole('textbox', { name: 'New card in Doing' });
  await input.fill(title);
  await input.press('Enter');
  const card = page.getByRole('region', { name: 'Doing' }).locator(`[data-path$="${title}.md"]`);
  await card.waitFor();
  return (await card.getAttribute('data-path')) ?? '';
}

test('the watcher’s echo of adding a board card is not refreshed for again (#258)', async ({
  page,
}) => {
  const { vault, host } = await boardForCounting(page);

  const walks = await walksAfterTheEcho(page, host, async () => {
    const made = await addCard(page, 'A new card');
    await expectFile(vault, made).toContain('status: doing');
  });
  expect(walks).toBe(0);
  await addFromOutside(page, vault, 'From outside.md');
});

test('another program’s write straight after a new card, before its echo, still reaches the board (#258)', async ({
  page,
}) => {
  const { vault, host } = await boardForCounting(page);
  const echoesBefore = await host.echoesSent();

  const made = await addCard(page, 'A new card');
  // Written over at once, before the echo's 400 ms are up: likely the same millisecond's time.
  await vault.write(made, note(['type: task', 'status: backlog'], '# A new card, from the laptop'));
  await emitVaultChanged(page, [made]);
  await expect.poll(() => host.echoesSent()).toBeGreaterThan(echoesBefore);

  await expect(
    page.getByRole('region', { name: 'Backlog' }).locator(`[data-path="${made}"]`),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Doing' }).locator(`[data-path="${made}"]`),
  ).toHaveCount(0);
});
