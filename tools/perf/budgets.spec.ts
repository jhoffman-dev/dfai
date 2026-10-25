/*
 * `pnpm perf:budgets` — the work budgets: how much each action makes the app
 * do, on the 2,008-note fixture vault, held to `budgets.json`. Counts, not
 * times: React commits, component renders and host commands by name.
 *
 * Every action is done twice, each time on a fresh page:
 * - **Counted**, on the work clock (`work-clock.ts`): virtual time, and the
 *   host's answers handed over one at a time in the order they were asked, so
 *   the same build makes the same counts on every run and every machine. A
 *   count over budget is the app doing more work, never a slow runner.
 * - **Timed**, in real time, for input→ready and the longest frame. Printed
 *   beside the counts and in the CI job summary, and never failed on.
 *
 * Built without minifying, so components keep their names. Each pass does
 * every action in `BUDGETED_ACTIONS`' order, each from where the last left it.
 *
 * `PERF_BUDGETS=write` writes the counts into `budgets.json` instead of
 * failing, and only ever lowers a budget (`lowered`). Raising one is James's
 * call, made by hand.
 */
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Browser, type Locator, type Page } from '../../e2e/fixtures.ts';
import { installHost, sidebarSection, type FakeVault } from '../../e2e/host.ts';
import { literatureNote } from '../../e2e/research-notes.ts';
import { installRenderCounter } from '../../packages/ui/src/testing/render-counter.ts';
import { BUDGETED_ACTIONS, type BudgetedAction } from './budgeted-actions.ts';
import type { FixtureFile } from './fixture-vault.ts';
import { installProbe, measure, waitForQuiet } from './probe.ts';
import { RESEARCH_SOURCES, HIGHLIGHTS_PER_SOURCE, researchVault } from './research-vault.ts';
import { EVERY_NOTE_INDEXED, writeFixtureVault, writeVault } from './session.ts';
import { longFixturePdf } from '../pdf/fixture-pdf.ts';
import { LONG_BOOK_PHRASE, longFixtureEpub } from '../epub/fixture-epub.ts';
import {
  installWorkClock,
  oneInput,
  runUntil,
  startCounting,
  stopCounting,
  type WorkClockOptions,
} from './work-clock.ts';
import {
  breachesOf,
  budgetFor,
  describeBreaches,
  differencesBetween,
  looksMinified,
  lowered,
  reportTable,
  type ActionBudget,
  type BudgetsFile,
  type Measurement,
  type RunTolerance,
  type Work,
} from './work-budgets.ts';

const BUDGETS_FILE = join('tools', 'perf', 'budgets.json');
const WRITING = process.env.PERF_BUDGETS === 'write';
/** `PERF_BUDGETS_ALLOW_DROP=1`: a count may fall past its floor, the work having really gone. */
const ALLOW_DROP = process.env.PERF_BUDGETS_ALLOW_DROP === '1';
/** `PERF_BUDGETS_ALLOW_RENAME=1`: `write` may drop a budget whose action is no longer measured. */
const ALLOW_RENAME = process.env.PERF_BUDGETS_ALLOW_RENAME === '1';
/** How many times the counted pass runs; more than one fails on any count that differs between runs. */
const COUNTED_RUNS = countedRuns(process.env.PERF_BUDGETS_RUNS);

function countedRuns(given: string | undefined): number {
  if (given === undefined || given === '') return 1;
  const runs = Number(given);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(
      `PERF_BUDGETS_RUNS must be a whole number of runs, 1 or more; it is "${given}"`,
    );
  }
  return runs;
}

/** A fixed day, in UTC, so Today shows the same tasks on every run and every machine. */
const STARTS_AT = Date.UTC(2026, 5, 15, 9);
/** How long the page is watched doing nothing. */
const IDLE_MS = 3_000;

/**
 * The hard per-row rules: ticking or deciding one row draws the rows whose
 * content or focus changed, never the list.
 */
const ROW_RULES: Partial<Record<BudgetedAction, ActionBudget['rows']>> = {
  'Tick a task on Today': { TaskRow: 1 },
  'Decide an Inbox row': { InboxRow: 2 },
};

/**
 * The actions allowed to differ between two counted runs, and by how much:
 * the drag counted 98 commits on one CI run and 96 on the next (#240), each
 * component in the board three renders apart. Host calls matched. What in the
 * drag still runs on the wall clock is not found yet (#243). Opening the
 * vault indexes 2,000 notes: on CI it counted 121 commits on one run and 122
 * on the next, each component one render apart, host calls the same (#130).
 * Every other action must match exactly.
 */
const RUN_TOLERANCE: Partial<Record<BudgetedAction, RunTolerance>> = {
  'Open a vault': { commits: 2, rendersEach: 2 },
  'Drag a board card': { commits: 2, rendersEach: 3 },
};

/** A board of the fixture's 48 projects, all active, by status: what "drag a board card" drags on. */
const PROJECT_BOARD: FixtureFile = {
  path: '.atlas/views/Project board.md',
  contents: [
    '---',
    'atlas: view',
    'type: project',
    'layout: board',
    'groupBy: status',
    'columns: [status]',
    'limit: 100',
    '---',
    '',
    '# Project board',
    '',
  ].join('\n'),
};

/** One step of an action: the input, and how the page says it is done. */
interface Phase {
  readonly act: () => Promise<void>;
  readonly ready: (arg: never) => boolean;
  readonly arg: unknown;
  /** Real milliseconds the work clock waits, time held still, for work it does not hold: a book's archive read from a `Blob`. */
  readonly untrackedMs?: number;
}

/** A phase, its predicate's argument type checked here and erased in the list. */
const phase = <Arg>(
  act: () => Promise<void>,
  ready: (arg: Arg) => boolean,
  arg: Arg,
  untrackedMs = 0,
): Phase => ({
  act,
  ready: ready as (arg: never) => boolean,
  arg,
  untrackedMs,
});

/** How a pass does an action: counted on the work clock, or timed against the wall. */
interface Pass {
  readonly page: Page;
  readonly vault: FakeVault;
  /** Does `step` uncounted: getting the app to where the next action starts. */
  setUp(step: Phase): Promise<void>;
  /**
   * Does an action's phases, and keeps what it took. It first puts the
   * pointer at rest, and lets the work before it finish, unless `settleFirst`
   * is false: the autosave is that work, and is the action.
   */
  budgeted(
    action: BudgetedAction,
    phases: readonly Phase[],
    options?: { readonly settleFirst?: boolean },
  ): Promise<void>;
  /** Watches the page do nothing for `IDLE_MS`. */
  idle(action: BudgetedAction): Promise<void>;
  /** Gives one key or pointer move, and lets the page take it in before the next, as a person's hand does. */
  input(give: () => Promise<void>): Promise<void>;
  /** Waits, inside an action, until the page shows `ready`: what a person looks for before going on. */
  until(step: Omit<Phase, 'act'>): Promise<void>;
}

const counted = new Map<string, Work>();
const timed = new Map<string, { inputToReady: number; longestFrame: number }>();

test('the app does no more work than its budget', async ({ browser }) => {
  test.setTimeout(900_000);
  const budgets = JSON.parse(await readFile(BUDGETS_FILE, 'utf8')) as BudgetsFile;

  await test.step('counted, on the work clock', async () => {
    const pass = await countedPass(browser, counted);
    await everyAction(pass);
    await pass.page.close();
    await everyResearchAction(await countedPass(browser, counted, RESEARCH));
    await everyLongNoteAction(await countedPass(browser, counted, LONG_NOTE));
  });
  for (let again = 2; again <= COUNTED_RUNS; again += 1) {
    await test.step(`counted again (${again} of ${COUNTED_RUNS}), to show the counts repeat`, async () => {
      const recount = new Map<string, Work>();
      const pass = await countedPass(browser, recount);
      await everyAction(pass);
      await pass.page.close();
      await everyResearchAction(await countedPass(browser, recount, RESEARCH));
      await everyLongNoteAction(await countedPass(browser, recount, LONG_NOTE));
      for (const action of BUDGETED_ACTIONS) {
        const [first, now] = [counted.get(action), recount.get(action)];
        expect.soft(first, `"${action}" was not counted on run 1`).toBeDefined();
        expect.soft(now, `"${action}" was not counted on run ${again}`).toBeDefined();
        if (first === undefined || now === undefined) continue;
        const changed = differencesBetween(first, now, RUN_TOLERANCE[action]);
        expect.soft(changed, `"${action}" counted differently on run ${again}`).toEqual([]);
      }
    });
  }
  // Held to the budgets as they were even when writing: a regression is red either way.
  for (const action of BUDGETED_ACTIONS) holdToBudget(action, budgets.actions[action]);
  const names = [...new Set([...counted.values()].flatMap((work) => Object.keys(work.renders)))];
  expect(
    looksMinified(names),
    'the components have no names: build without minifying (pnpm perf:budgets does)',
  ).toBe(false);

  try {
    await test.step('timed, against the wall clock (reported, not gated)', async () => {
      const pass = await timedPass(browser);
      await everyAction(pass);
      await pass.page.close();
      await everyResearchAction(await timedPass(browser, RESEARCH));
      await everyLongNoteAction(await timedPass(browser, LONG_NOTE));
    });
  } finally {
    await report(budgets);
  }
  if (WRITING) await writeBudgets(budgets);
});

function holdToBudget(action: BudgetedAction, budget: ActionBudget | undefined): void {
  const work = counted.get(action);
  expect.soft(work, `"${action}" was not counted`).toBeDefined();
  expect.soft(budget, `"${action}" has no budget in ${BUDGETS_FILE}`).toBeDefined();
  if (work === undefined || budget === undefined) return;
  const breaches = breachesOf(work, budget, { allowDrop: ALLOW_DROP });
  expect.soft(breaches, describeBreaches(action, work, breaches)).toEqual([]);
}

/** Which vault a pass opens, and whether opening it is the budgeted 'Open a vault' or only set-up. */
interface PassFixture {
  readonly write: () => Promise<FakeVault>;
  readonly openIsBudgeted: boolean;
  /** What the status reads once every note is indexed; the main fixture's by default. */
  readonly indexed?: RegExp;
}

/** The 2,008-note fixture, with the project board the drag measures on and the long PDF the reader opens. */
const MAIN: PassFixture = {
  write: async () => {
    const vault = await writeFixtureVault([PROJECT_BOARD]);
    await writeLongPdf(vault);
    await writeLongEpub(vault);
    return vault;
  },
  openIsBudgeted: true,
};

/** The research views' fixture (#507): its open is set-up; the views' opens are what is counted. */
const RESEARCH: PassFixture = { write: () => writeVault(researchVault()), openIsBudgeted: false };

/**
 * One literature note of 500 highlights (#534): each is drawn as its quote with
 * a comment to type in, so opening it and saving a comment in it are what is
 * counted. Alone in its vault, so the other fixtures' counts do not move.
 */
const LONG_NOTE_TITLE = 'The Long Crossing';
const LONG_NOTE_HIGHLIGHTS = 500;
const LONG_NOTE: PassFixture = {
  write: () =>
    writeVault([
      {
        path: `Library/${LONG_NOTE_TITLE}.md`,
        contents: literatureNote({
          title: LONG_NOTE_TITLE,
          author: 'Mara Quill',
          kind: 'pdf',
          highlights: Array.from({ length: LONG_NOTE_HIGHLIGHTS }, (_, at) => ({
            id: `h${at.toString(36).padStart(5, '0')}`,
            quote: `Passage ${at + 1} of the long crossing.`,
            ...(at % 2 === 0 && { comment: `Comment ${at + 1}.` }),
            at: at + 1,
          })),
        }),
      },
    ]),
  openIsBudgeted: false,
  indexed: /^\d+ notes? indexed/,
};

/** A fresh page on a fixture, its time and host held by the work clock from the first script. */
async function countedPass(
  browser: Browser,
  into: Map<string, Work>,
  fixture: PassFixture = MAIN,
): Promise<Pass> {
  const page = await newPage(browser);
  const vault = await fixture.write();
  // And with the watcher's echo of every write, as the real host sends it.
  await installHost(page, vault, { echoWrites: true });
  await page.addInitScript(installRenderCounter);
  await page.addInitScript(installWorkClock, clockAt({ virtual: true }));
  await page.goto('/');
  const pass: Pass = {
    page,
    vault,
    async setUp({ act, ready, arg }) {
      await act();
      await runUntil(page, { ready, arg: arg as never });
    },
    async budgeted(action, phases, { settleFirst = true } = {}) {
      await restThePointer(page);
      if (settleFirst) await runUntil(page, {});
      await expectPointerAtRest(page, action);
      await startCounting(page);
      for (const { act, ready, arg, untrackedMs } of phases) {
        await act();
        await runUntil(page, { ready, arg: arg as never, untrackedMs: untrackedMs ?? 0 });
      }
      into.set(action, await stopCounting(page));
    },
    async idle(action) {
      await restThePointer(page);
      await runUntil(page, {});
      await expectPointerAtRest(page, action);
      await startCounting(page);
      await runUntil(page, { settleMs: IDLE_MS });
      into.set(action, await stopCounting(page));
    },
    async input(give) {
      await oneInput(page, give);
    },
    async until({ ready, arg }) {
      await runUntil(page, { ready, arg: arg as never, settleMs: 0 });
    },
  };
  // After the app has started and settled, so what its start does is not counted as the open.
  if (fixture.openIsBudgeted) await pass.budgeted('Open a vault', [OPEN_THE_VAULT(page)]);
  else await pass.setUp(OPEN_THE_VAULT(page, fixture.indexed));
  return pass;
}

/**
 * What under the pointer would draw again as it comes or goes: a note and its
 * links, a control, a dialog. An action that starts with the pointer over one
 * counts where the last action left the pointer, not its own work (#359).
 */
const REACTS_TO_POINTER =
  'main, [role="dialog"], a, button, input, select, textarea, [role="treeitem"], [role="tab"], [contenteditable]';

/**
 * The sidebar's top corner, where the pointer starts: over none of
 * `REACTS_TO_POINTER` in any view the actions reach.
 */
const POINTER_REST = { x: 0, y: 0 };

/**
 * Moves the pointer off whatever the last action clicked, so every action
 * starts from the same place. The settle after it lets what drew on the way
 * out, a link's "…" going, land before the count.
 */
const restThePointer = (page: Page) => page.mouse.move(POINTER_REST.x, POINTER_REST.y);

/** Fails the action if the pointer it starts from is over anything in `REACTS_TO_POINTER`. */
async function expectPointerAtRest(page: Page, action: BudgetedAction): Promise<void> {
  const under = await page.evaluate((reacts) => {
    const hovered = [...document.querySelectorAll(':hover')].at(-1);
    const reacting = hovered?.closest(reacts);
    if (reacting === null || reacting === undefined) return null;
    const label = reacting.getAttribute('aria-label');
    return `${reacting.tagName.toLowerCase()}${label === null ? '' : `[aria-label="${label}"]`}`;
  }, REACTS_TO_POINTER);
  expect.soft(under, `"${action}" began with the pointer over ${under}`).toBeNull();
}

/**
 * Choosing the fixture's folder, until the whole vault is indexed — not the
 * first count the status shows — and then the settle every action is given,
 * in which the Inbox's offers are read ahead (#130).
 */
const OPEN_THE_VAULT = (page: Page, indexed: RegExp = EVERY_NOTE_INDEXED): Phase =>
  phase(
    () => page.getByRole('button', { name: 'Choose folder…' }).click(),
    (source) => new RegExp(source, 'm').test(document.body.innerText),
    indexed.source,
  );

/** A fresh page on a fixture in real time, with only its date fixed, for the times. */
async function timedPass(browser: Browser, fixture: PassFixture = MAIN): Promise<Pass> {
  const page = await newPage(browser);
  await page.addInitScript(installWorkClock, clockAt({ virtual: false }));
  const vault = await fixture.write();
  await installHost(page, vault, { echoWrites: true });
  await installProbe(page);
  await page.goto('/');
  const time = async (
    action: BudgetedAction,
    phases: readonly Phase[],
    { settleFirst = true }: { readonly settleFirst?: boolean } = {},
  ) => {
    await restThePointer(page);
    if (settleFirst) await waitForQuiet(page);
    let inputToReady = 0;
    let longestFrame = 0;
    for (const { act, ready, arg } of phases) {
      const run = await measure(page, { act, ready, arg: arg as never });
      inputToReady += run.inputToReady;
      longestFrame = Math.max(longestFrame, run.longestFrame);
    }
    timed.set(action, { inputToReady, longestFrame });
  };
  if (fixture.openIsBudgeted) await time('Open a vault', [OPEN_THE_VAULT(page)]);
  else {
    const { act, ready, arg } = OPEN_THE_VAULT(page, fixture.indexed);
    await act();
    await page.waitForFunction(ready, arg as never, { timeout: 180_000 });
  }
  await waitForQuiet(page);
  return {
    page,
    vault,
    async setUp({ act, ready, arg }) {
      await act();
      await page.waitForFunction(ready, arg as never, { timeout: 60_000 });
      await waitForQuiet(page);
    },
    budgeted: time,
    idle: (action) =>
      time(action, [
        phase(
          () => Promise.resolve(),
          (ms) => {
            const { armedAt } = (window as unknown as { __perf: { armedAt: number | null } })
              .__perf;
            return armedAt !== null && performance.now() - armedAt >= ms;
          },
          IDLE_MS,
        ),
      ]),
    input: (give) => give(),
    async until({ ready, arg }) {
      await page.waitForFunction(ready, arg as never, { timeout: 60_000 });
    },
  };
}

const clockAt = ({ virtual }: Pick<WorkClockOptions, 'virtual'>): WorkClockOptions => ({
  startsAt: STARTS_AT,
  virtual,
  // A slower host, to show the counts do not move with it.
  hostDelayMs: Number(process.env.PERF_HOST_DELAY_MS ?? 0) || 0,
});

const newPage = (browser: Browser) =>
  browser.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: 'UTC', locale: 'en-US' });

// The note pickers suggest notes as you type (#465): fields, not selects.
const INBOX_PICKERS = 'article[aria-label="Inbox"] div.inbox__clarify input.inbox__file';
const SUGGESTIONS = '[role="listbox"][aria-label="Suggested notes"] [role="option"]';
const TODAY_TICKS = 'article[aria-label="Today"] input.done-check:not([disabled])';
const SETTINGS = '[role="dialog"][aria-label="Settings"]';
const SEARCH_BOX = 'input[aria-label="Search the vault"]';
const TASK_TABLE = /^Task, \d+ notes?$/;
const TYPED = 'ledger 10.';

const editorOf = (title: string) =>
  `article[aria-label="${title}"] .ProseMirror[contenteditable="true"]`;
/** The editor of a note whose tab is the shown one: a hidden tab's editor stays in the page. */
const shownEditorOf = (title: string) => `.pane__tab:not([hidden]) ${editorOf(title)}`;
const PANE_1 = 'section[aria-label="Pane 1"]';
const PANE_2 = 'section[aria-label="Pane 2"]';

const exists = (selector: string) => document.querySelector(selector) !== null;
const gone = (selector: string) => document.querySelector(selector) === null;

/** Every budgeted action, in order, each from where the one before left the app. */
async function everyAction(pass: Pass): Promise<void> {
  const { page } = pass;
  const [first = '', second = ''] = await toggleFolder(pass, 'Notes');
  await pass.budgeted('Click a sidebar note', [openNote(pass, first)]);
  await pass.budgeted('Switch notes', [openNote(pass, second)]);
  // The first note again, in a tab beside the second: two editors in the pane.
  await pass.budgeted('Open in a new tab', [openInNewTab(pass, first)]);
  // Back to the second's tab: its editor was kept, hidden, and is shown again.
  await pass.budgeted('Switch tabs', [switchToTab(pass, second)]);
  // Typed with the first note's editor waiting behind this one.
  await typeAndSave(pass, second);
  await pass.idle('Idle 3 s with a note open');
  await pass.budgeted('Split the window', [
    phase(() => page.keyboard.press('Shift+Meta+Backslash'), exists, PANE_2),
  ]);
  await pass.budgeted('Focus the other pane', [
    phase(
      () => page.locator(`${PANE_1} ${editorOf(second)}`).click(),
      exists,
      `${PANE_1}.pane--focused`,
    ),
  ]);
  // The focused pane, with its two tabs, closes; the other keeps the second note.
  await pass.budgeted('Close a pane', [
    phase(() => page.keyboard.press('Shift+Meta+Backslash'), gone, PANE_2),
  ]);

  await pass.budgeted('Open Settings', [
    phase(
      () => page.getByRole('button', { name: 'Settings', exact: true }).click(),
      exists,
      SETTINGS,
    ),
  ]);
  await pass.setUp(phase(() => page.keyboard.press('Escape'), gone, SETTINGS));

  await pass.budgeted('Open Today', [
    phase(() => sidebarButton(page, /^Today/).click(), exists, TODAY_TICKS),
  ]);
  await pass.idle('Idle 3 s on Today');
  await tickATask(pass);

  await pass.budgeted('Open the Inbox', [
    phase(
      () => sidebarButton(page, /^Inbox/).click(),
      (selector) => document.querySelector<HTMLInputElement>(selector)?.disabled === false,
      INBOX_PICKERS,
    ),
  ]);
  await decideARow(pass);

  await toggleFolder(pass, 'Notes');
  const [person = ''] = await toggleFolder(pass, 'People');
  await pass.budgeted("Open a person's page", [openNote(pass, person)]);

  await pass.budgeted('Open the 420-row table', [
    phase(
      () => sidebarSection(page, 'types').getByRole('button', { name: TASK_TABLE }).click(),
      () =>
        [...document.querySelectorAll('.table__count')].some((count) =>
          /tasks?/.test(count.textContent ?? ''),
        ),
      null,
    ),
  ]);
  await searchOverTheTable(pass);
  await dragACard(pass);
  await runALongSqlQuery(pass);
  await runALongAtlasQuery(pass);
  await readALongPdf(pass);
  await openAsk(pass);
  // Back to the long PDF, whatever Ask left shown: a click on it in the tree shows it in place of
  // Ask, and does nothing when it is shown already. The long EPUB is opened from there, where
  // its budget was set.
  await pass.setUp(
    phase(
      () =>
        sidebarSection(page, 'userSpace')
          .getByRole('treeitem', { name: 'A Long Crossing.pdf', exact: true })
          .click(),
      ({ pdf, ask }) =>
        document.querySelector(pdf) !== null && document.querySelector(ask) === null,
      {
        pdf: '.pane__tab:not([hidden]) [data-pdf-page] .pdf-text__run',
        ask: '.pane__tab:not([hidden]) .ask',
      },
    ),
  );
  await readALongEpub(pass);
}

const sidebarButton = (page: Page, name: RegExp) => page.getByRole('button', { name }).first();

/** How many sources the research fixture holds, and highlights between them, as the pages count them. */
const LIBRARY_COUNT = `${RESEARCH_SOURCES.toLocaleString('en-US')} sources`;
const HIGHLIGHTS_COUNT = `${(RESEARCH_SOURCES * HIGHLIGHTS_PER_SOURCE).toLocaleString('en-US')} highlights`;
/** At most this many rows of a research list are drawn: a screenful and the overscan, never the list. */
const RESEARCH_MOST_DRAWN = 80;

/** Opens a research page from the sidebar; ready once it counts every row and draws its first. */
const openResearchPage = (
  { page }: Pass,
  { row, list, count }: { row: string; list: string; count: string },
) =>
  phase(
    () =>
      page
        .getByRole('list', { name: 'Go to' })
        .getByRole('button', { name: row, exact: true })
        .click(),
    ({ list: name, count: text }) =>
      document.querySelector(`ul[aria-label="${name}"] > li[data-index]`) !== null &&
      [...document.querySelectorAll('.page-bar__count')].some(
        (each) => each.textContent?.trim() === text,
      ),
    { list, count },
  );

/** The research views (#507), on their own fixture: the Library, then All highlights. */
async function everyResearchAction(pass: Pass): Promise<void> {
  const { page } = pass;
  await pass.budgeted('Open the Library (2,000 sources)', [
    openResearchPage(pass, { row: 'Library', list: 'Sources', count: LIBRARY_COUNT }),
  ]);
  await expectFewDrawn(page, 'Sources');
  await pass.budgeted('Open All highlights (20,000)', [
    openResearchPage(pass, { row: 'All highlights', list: 'Highlights', count: HIGHLIGHTS_COUNT }),
  ]);
  await expectFewDrawn(page, 'Highlights');
  await page.close();
}

/** Opening the literature note of 500 highlights, then saving a comment typed in the first. */
async function everyLongNoteAction(pass: Pass): Promise<void> {
  const { page } = pass;
  await toggleFolder(pass, 'Library');
  const fields = '[data-highlight-block] textarea';
  await pass.budgeted('Open a 500-highlight literature note', [
    phase(
      () =>
        sidebarSection(page, 'userSpace')
          .getByRole('treeitem', { name: LONG_NOTE_TITLE, exact: true })
          .click(),
      (selector) => document.querySelectorAll(selector).length === 500,
      fields,
    ),
  ]);
  const comment = page.locator(fields).first();
  await comment.click();
  await comment.fill('Typed in place.');
  await pass.budgeted('Save a comment in a 500-highlight note', [
    phase(
      () => page.keyboard.press('Meta+Enter'),
      (selector) => {
        const field = document.querySelector<HTMLTextAreaElement>(selector);
        return field !== null && !field.readOnly && field.value === 'Typed in place.';
      },
      fields,
    ),
  ]);
  await page.close();
}

/** The list is virtualised: some rows are drawn, and never more than a screenful's worth. */
async function expectFewDrawn(page: Page, list: string): Promise<void> {
  const drawn = await page.locator(`ul[aria-label="${list}"] > li[data-index]`).count();
  expect(drawn, `${drawn} rows of ${list} drawn`).toBeGreaterThan(0);
  expect(drawn, `${drawn} rows of ${list} drawn`).toBeLessThanOrEqual(RESEARCH_MOST_DRAWN);
}

/** Opens a note from the sidebar's tree; ready once its editor is there to type in. */
const openNote = ({ page }: Pass, title: string) =>
  phase(
    () =>
      sidebarSection(page, 'userSpace').getByRole('treeitem', { name: title, exact: true }).click(),
    exists,
    editorOf(title),
  );

/** ⌘-clicks a note in the tree; ready once its editor is the one shown, in a second tab. */
const openInNewTab = ({ page }: Pass, title: string) =>
  phase(
    () =>
      sidebarSection(page, 'userSpace')
        .getByRole('treeitem', { name: title, exact: true })
        .click({ modifiers: ['Meta'] }),
    // Evaluated in the page, so the selectors come in as the argument.
    ({ editor, tabs, pane }) =>
      document.querySelector(editor) !== null &&
      document.querySelectorAll(`${pane} [role="tab"]`).length === tabs,
    { editor: shownEditorOf(title), tabs: 2, pane: PANE_1 },
  );

/** Clicks a tab in the first pane's strip; ready once that note's editor is the one shown. */
const switchToTab = ({ page }: Pass, title: string) =>
  phase(
    () =>
      page.getByRole('tablist', { name: 'Pane 1 tabs' }).getByRole('tab', { name: title }).click(),
    exists,
    shownEditorOf(title),
  );

/** Opens or shuts a top-level folder in the tree, and names the notes it then shows. */
async function toggleFolder(pass: Pass, name: string): Promise<string[]> {
  const tree = sidebarSection(pass.page, 'userSpace');
  const folder = tree.getByRole('treeitem', { name, exact: true });
  const opening = (await folder.getAttribute('aria-expanded')) !== 'true';
  await pass.setUp(
    phase(
      () => folder.click(),
      ({ title, open }) =>
        document
          .querySelector(`[role="treeitem"][aria-level="1"][aria-label="${title}"]`)
          ?.getAttribute('aria-expanded') === String(open),
      { title: name, open: opening },
    ),
  );
  if (!opening) return [];
  return tree
    .locator('[role="treeitem"][aria-level="2"]:not([aria-expanded])')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label') ?? ''));
}

/** Ten keys at the end of the note, one at a time; then the autosave, and the watcher telling of it. */
async function typeAndSave(pass: Pass, title: string): Promise<void> {
  const { page } = pass;
  // Focused rather than clicked: a click lands on whatever is in the middle, a link included.
  await page.locator(editorOf(title)).focus();
  await page.keyboard.press('Meta+ArrowDown');
  await pass.budgeted('Type 10 characters in a note', [
    phase(
      async () => {
        for (const key of TYPED) {
          await pass.input(() => page.keyboard.type(key));
        }
      },
      ({ selector, text }) =>
        document
          .querySelector(selector)
          ?.textContent?.replace(/\u00a0/g, ' ')
          .includes(text) === true,
      { selector: editorOf(title), text: TYPED },
    ),
  ]);

  const path = `Notes/${title}.md`;
  // Ready once the host was asked for these commands since the action began: work
  // the action itself caused, not a state that was already true. On the work clock
  // the counted calls tell; in real time, the probe's calls since the phase began.
  const caused = (wanted: Record<string, number>) => {
    const clock = (window as unknown as { __workClock?: { callsSoFar(): Record<string, number> } })
      .__workClock;
    const sent: Record<string, number> = {};
    if (clock !== undefined) Object.assign(sent, clock.callsSoFar());
    else {
      const probe = (window as unknown as { __perf: { calls: { command: string }[] } }).__perf;
      for (const { command } of probe.calls) sent[command] = (sent[command] ?? 0) + 1;
    }
    const saved = [...document.querySelectorAll('[role="status"]')].some(
      (each) => each.textContent === 'Saved',
    );
    return (
      saved && Object.entries(wanted).every(([command, least]) => (sent[command] ?? 0) >= least)
    );
  };
  const echoesBefore = await echoesSent(page);
  // Not settled first: the autosave due 1.2 s after the last key is this action.
  await pass.budgeted(
    'One autosave and its watcher echo',
    [
      phase(() => Promise.resolve(), caused, { write_text_file: 1 }),
      // What the host's watcher sends once the save is on disk (`echoWrites`).
      phase(
        () => Promise.resolve(),
        (before) =>
          ((window as unknown as { __atlasEchoesSent?: number }).__atlasEchoesSent ?? 0) > before,
        echoesBefore,
      ),
    ],
    { settleFirst: false },
  );
  expect(await pass.vault.read(path)).toContain(TYPED);
}

const echoesSent = (page: Page) =>
  page.evaluate(() => (window as unknown as { __atlasEchoesSent?: number }).__atlasEchoesSent ?? 0);

async function tickATask(pass: Pass): Promise<void> {
  const tick = pass.page.locator(TODAY_TICKS).first();
  const label = (await tick.getAttribute('aria-label')) ?? '';
  await pass.budgeted('Tick a task on Today', [
    phase(
      () => tick.click(),
      (ticked) => document.querySelector(`input[aria-label="${CSS.escape(ticked)}"]`) === null,
      label,
    ),
  ]);
}

/**
 * The pick alone is the action, as a select's change was: the picker is
 * opened and its first suggestion made active beforehand, uncounted —
 * opening a picker is not deciding a row.
 */
async function decideARow(pass: Pass): Promise<void> {
  const picker = pass.page.locator(INBOX_PICKERS).first();
  const label = (await picker.getAttribute('aria-label')) ?? '';
  await pass.setUp(
    phase(
      async () => {
        await picker.click();
        await picker.press('ArrowDown');
      },
      (selector) => document.querySelector(`${selector}[aria-selected="true"]`) !== null,
      SUGGESTIONS,
    ),
  );
  await pass.budgeted('Decide an Inbox row', [
    phase(
      () => picker.press('Enter'),
      ({ filed, selector }) => {
        const all = [...document.querySelectorAll<HTMLInputElement>(selector)];
        return (
          all[0]?.disabled === false &&
          all.every((each) => each.getAttribute('aria-label') !== filed)
        );
      },
      { filed: label, selector: INBOX_PICKERS },
    ),
  ]);
}

async function searchOverTheTable(pass: Pass): Promise<void> {
  const { page } = pass;
  const query = 'tobia';
  await pass.budgeted('⌘K + 5 keys over the table', [
    phase(
      async () => {
        await pass.input(() => page.keyboard.press('Meta+k'));
        // A person types once the box has the caret, not before.
        await pass.until(
          phase(
            () => Promise.resolve(),
            (selector) => document.activeElement?.matches(selector) === true,
            SEARCH_BOX,
          ),
        );
        for (const key of query) {
          await pass.input(() => page.keyboard.type(key));
        }
      },
      ({ text, selector }) =>
        document.querySelector<HTMLInputElement>(selector)?.value === text &&
        document.querySelector('[role="option"]') !== null,
      { text: query, selector: SEARCH_BOX },
    ),
  ]);
  await pass.setUp(phase(() => page.keyboard.press('Escape'), gone, SEARCH_BOX));
}

/**
 * Drags the first active project onto the paused column by the pointer, in a
 * fixed number of moves, each taken in before the next: the same events on
 * every run. (`dragWithPointer` in `e2e/drag.ts` re-aims until a scrolling
 * target settles; this board does not scroll.)
 */
async function dragACard(pass: Pass): Promise<void> {
  const { page } = pass;
  await pass.setUp(
    phase(
      () =>
        sidebarSection(page, 'views')
          .getByRole('button', { name: 'Project board', exact: true })
          .click(),
      exists,
      '.board .board__card',
    ),
  );
  const board = page.locator('.board');
  const card = board
    .getByRole('region', { name: 'Active', exact: true })
    .locator('.board__card')
    .first();
  const cardPath = (await card.getAttribute('data-path')) ?? '';
  const start = await centreOf(card);
  const end = await centreOf(board.getByRole('region', { name: 'Paused', exact: true }));
  const hop = { x: start.x + 8, y: start.y + 8 };
  const announced = (text: string) =>
    [...document.querySelectorAll('[id^="DndLiveRegion"]')].some((region) =>
      (region.textContent ?? '').includes(text),
    );
  await pass.budgeted('Drag a board card', [
    phase(
      async () => {
        await page.mouse.move(start.x, start.y);
        await pass.input(() => page.mouse.down());
        // The short hop that turns a press into a drag, then the way across.
        for (const [from, to, steps] of [
          [start, hop, 4],
          [hop, end, 20],
        ] as const) {
          for (let step = 1; step <= steps; step += 1) {
            const along = step / steps;
            await pass.input(() =>
              page.mouse.move(from.x + (to.x - from.x) * along, from.y + (to.y - from.y) * along),
            );
          }
        }
      },
      announced,
      'is over Paused.',
    ),
    // The board's own word once the card has landed.
    phase(
      () => page.mouse.up(),
      (text) =>
        [...document.querySelectorAll('[role="status"]')].some((each) =>
          (each.textContent ?? '').endsWith(text),
        ),
      'moved to Paused.',
    ),
  ]);
  await expect.poll(() => pass.vault.read(cardPath)).toMatch(/^status: paused$/m);
}

const SQL_EDITOR = 'textarea[aria-label="SQL"]';
const SQL_ROWS = 2000;
/** Numbers 1 to 2,000, made by SQLite itself: a result as long as the fixture's notes. */
const SQL_NUMBERS = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${SQL_ROWS})
SELECT 'Row ' || i AS title, i AS number FROM n`;

/** Opens a new SQL query with a 2,000-row statement typed in; runs it, ready once the count is shown (#401). */
async function runALongSqlQuery(pass: Pass): Promise<void> {
  const { page } = pass;
  // One step at a time: the page runs on the work clock, which moves only between steps.
  await pass.setUp(
    phase(
      () => page.getByRole('button', { name: 'New in Views' }).click(),
      exists,
      '[role="menuitem"]',
    ),
  );
  await pass.setUp(
    phase(
      () => page.getByRole('menuitem', { name: 'New query' }).click(),
      exists,
      '[role="radiogroup"][aria-label="Query language"]',
    ),
  );
  await pass.setUp(
    phase(
      () =>
        page
          .getByRole('radiogroup', { name: 'Query language' })
          .getByRole('radio', { name: 'SQL' })
          .click(),
      exists,
      SQL_EDITOR,
    ),
  );
  await pass.setUp(
    phase(
      () => page.locator(SQL_EDITOR).fill(SQL_NUMBERS),
      ({ selector, sql }) => document.querySelector<HTMLTextAreaElement>(selector)?.value === sql,
      { selector: SQL_EDITOR, sql: SQL_NUMBERS },
    ),
  );
  await pass.budgeted('Run a 2,000-row SQL query', [
    phase(
      () => page.locator(SQL_EDITOR).press('Meta+Enter'),
      (text) => document.querySelector('.query__count')?.textContent === text,
      `${SQL_ROWS} rows`,
    ),
  ]);
}

const ATLAS_EDITOR = 'textarea[aria-label="Query"]';
/** Every typed note in the fixture: its areas, projects, people, tasks and meetings. */
const ATLAS_ROWS = 920;
/** Far fewer than the result, and more than a tall screen's rows plus overscan. */
const ATLAS_MOST_DRAWN = 120;
const ATLAS_EVERY_TYPED = `FROM area, project, person, task, meeting SORT BY title LIMIT 2000`;

/** Opens a new query as text; types in one over every typed note, ready once it has run and counted them (#427). */
async function runALongAtlasQuery(pass: Pass): Promise<void> {
  const { page } = pass;
  // One step at a time: the page runs on the work clock, which moves only between steps.
  await pass.setUp(
    phase(
      () => page.getByRole('button', { name: 'New in Views' }).click(),
      exists,
      '[role="menuitem"]',
    ),
  );
  await pass.setUp(
    phase(
      () => page.getByRole('menuitem', { name: 'New query' }).click(),
      exists,
      '[role="radiogroup"][aria-label="Query language"]',
    ),
  );
  // DFAI, whichever language the query before this one left the page in.
  await pass.setUp(
    phase(
      () =>
        page
          .getByRole('radiogroup', { name: 'Query language' })
          .getByRole('radio', { name: 'DFAI query' })
          .click(),
      exists,
      '[role="radiogroup"][aria-label="Edit the query as"]',
    ),
  );
  await pass.setUp(
    phase(
      () =>
        page
          .getByRole('radiogroup', { name: 'Edit the query as' })
          .getByRole('radio', { name: 'Text' })
          .click(),
      exists,
      ATLAS_EDITOR,
    ),
  );
  // The text runs once it settles: typing it is running it.
  await pass.budgeted('Run a 920-row DFAI query', [
    phase(
      () => page.locator(ATLAS_EDITOR).fill(ATLAS_EVERY_TYPED),
      (text) => document.querySelector('.query__count')?.textContent === text,
      `${ATLAS_ROWS} notes`,
    ),
  ]);
  // The rows are plain cells, not components, so the counted renders cannot
  // see them all being drawn: the window is checked here instead.
  const drawn = await page.locator('.qresult__sheet .qresult__title').count();
  expect(drawn, `${drawn} of ${ATLAS_ROWS} rows drawn`).toBeGreaterThan(0);
  expect(drawn, `${drawn} of ${ATLAS_ROWS} rows drawn`).toBeLessThanOrEqual(ATLAS_MOST_DRAWN);
}

/** The 500-page PDF the reader is held to (#504): a file in the vault, no note of its own, so nothing else counts it. */
const LONG_PDF = 'Areas/A Long Crossing.pdf';
const LONG_PDF_PAGES = 500;
/** The most pages the reader may have drawn at once: the ones on screen and a couple either side. */
const PDF_MOST_DRAWN = 8;

/** Written beside the fixture's notes; a PDF is not a note, so opening the vault does not read it. */
async function writeLongPdf(vault: FakeVault): Promise<void> {
  await writeFile(join(vault.root, LONG_PDF), longFixturePdf(LONG_PDF_PAGES));
}

/**
 * pdf.js's worker module, loaded onto the page's own thread before the PDF
 * opens. pdf.js then parses there rather than in a worker of its own, so
 * its work is the page's and the work clock holds it like the rest: a
 * worker's answers come in on the wall clock, which the counts must not
 * depend on. The work counted is the app's, which is the same either way.
 */
async function pdfWorkerOnThePage(page: Page): Promise<void> {
  const assets = join('apps', 'desktop', 'dist', 'assets');
  const worker = (await readdir(assets)).find((name) => /^pdf\.worker\.min-.*\.mjs$/.test(name));
  if (worker === undefined) throw new Error(`no pdf.js worker in ${assets}: build first`);
  await page.evaluate(async (address) => {
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import(
      /* @vite-ignore */ address
    );
  }, `/assets/${worker}`);
}

/** Opens the long PDF from Pages, ready once its first page's words are there; then scrolls to its middle. */
async function readALongPdf(pass: Pass): Promise<void> {
  const { page } = pass;
  const tree = sidebarSection(page, 'userSpace');
  await pdfWorkerOnThePage(page);
  await pass.setUp(
    phase(
      () => tree.getByRole('treeitem', { name: 'Areas', exact: true }).click(),
      exists,
      '[role="treeitem"][aria-label="A Long Crossing.pdf"]',
    ),
  );
  await pass.budgeted('Open a 500-page PDF', [
    phase(
      () => tree.getByRole('treeitem', { name: 'A Long Crossing.pdf', exact: true }).click(),
      exists,
      '[data-pdf-page="1"] .pdf-text__run',
    ),
  ]);
  await pass.budgeted('Scroll a 500-page PDF to its middle', [
    phase(
      () =>
        page.locator('.pdf-reader__pages').evaluate((pages) => {
          pages.scrollTop = pages.scrollHeight / 2;
        }),
      exists,
      `[data-pdf-page="${LONG_PDF_PAGES / 2 + 1}"] .pdf-text__run`,
    ),
  ]);
  const drawn = await page.locator('.pdf-page').count();
  expect(drawn, `${drawn} of ${LONG_PDF_PAGES} pages drawn`).toBeGreaterThan(0);
  expect(drawn, `${drawn} of ${LONG_PDF_PAGES} pages drawn`).toBeLessThanOrEqual(PDF_MOST_DRAWN);
}

/** The 1,000-chapter EPUB the book reader is held to (#505): a file in the vault, no note of its own, like the long PDF. */
const LONG_EPUB = 'Areas/A Long Voyage.epub';
const LONG_EPUB_CHAPTERS = 1000;
/** What find in the long book says once it has read every chapter: its phrase is in every hundredth. */
const LONG_EPUB_FOUND = `1 of ${LONG_EPUB_CHAPTERS / 100}`;

/**
 * How long the work clock waits on the wall clock for the long book's own
 * reads: zip.js reads the archive from a `Blob`, which the clock does not
 * hold, so a phase that reads chapters waits for them with time held still.
 */
const EPUB_UNTRACKED_MS = 120_000;

async function writeLongEpub(vault: FakeVault): Promise<void> {
  await writeFile(join(vault.root, LONG_EPUB), longFixtureEpub({ chapters: LONG_EPUB_CHAPTERS }));
}

/** The book reader's page once chapter `section` is on screen and taking marks. */
const shownSection = (section: string) =>
  document.querySelector(`.epub-reader__page[data-shown-section="${section}"]`) !== null;

/** Opens the long EPUB from Pages, ready once its first chapter is shown; turns a chapter; finds in the whole book. */
async function readALongEpub(pass: Pass): Promise<void> {
  const { page } = pass;
  const tree = sidebarSection(page, 'userSpace');
  await pass.setUp(
    phase(async () => undefined, exists, '[role="treeitem"][aria-label="A Long Voyage.epub"]'),
  );
  await pass.budgeted('Open a 1,000-chapter EPUB', [
    phase(
      () => tree.getByRole('treeitem', { name: 'A Long Voyage.epub', exact: true }).click(),
      shownSection,
      '0',
      EPUB_UNTRACKED_MS,
    ),
  ]);
  await pass.budgeted('Turn a chapter of a 1,000-chapter EPUB', [
    phase(
      () => page.getByRole('button', { name: 'Next chapter' }).click(),
      shownSection,
      '1',
      EPUB_UNTRACKED_MS,
    ),
  ]);
  await pass.budgeted('Find in a 1,000-chapter EPUB', [
    phase(
      async () => {
        await page.getByRole('button', { name: 'Find', exact: true }).click();
        await page.getByRole('searchbox', { name: 'Find in document' }).fill(LONG_BOOK_PHRASE);
      },
      (found: string) =>
        (document.querySelector('.epub-reader [role="search"]')?.textContent ?? '').includes(found),
      LONG_EPUB_FOUND,
      EPUB_UNTRACKED_MS,
    ),
  ]);
}

/** ⌘J (#37): Ask, until its question box holds the keys. */
async function openAsk(pass: Pass): Promise<void> {
  await pass.budgeted('Open Ask (⌘J)', [
    phase(
      () => pass.page.keyboard.press('Meta+j'),
      (selector) => document.activeElement?.matches(selector) === true,
      '.ask textarea',
    ),
  ]);
}

async function centreOf(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('drag target is not on screen');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Prints the run beside the budgets, keeps it as JSON, and adds it to the CI job's summary. */
async function report(budgets: BudgetsFile): Promise<void> {
  const rows: Measurement[] = BUDGETED_ACTIONS.flatMap((action) => {
    const work = counted.get(action);
    if (work === undefined) return [];
    const times = timed.get(action);
    return [
      {
        action,
        work,
        budget: budgets.actions[action],
        inputToReady: times?.inputToReady ?? Number.NaN,
        longestFrame: times?.longestFrame ?? Number.NaN,
      },
    ];
  });
  const table = reportTable(rows);
  const folder = join('test-results', 'perf');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'budgets.json'), `${JSON.stringify(rows, null, 2)}\n`);
  process.stdout.write(`\nWork budgets (counts gated, times reported only):\n\n${table}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== '') {
    await appendFile(
      summary,
      `## Work budgets\n\nCounts are held to \`tools/perf/budgets.json\`; times are reported only.\n\n${table}\n`,
    );
  }
}

/** Writes this run's counts into `budgets.json`, lowering each budget and never raising one. */
async function writeBudgets(budgets: BudgetsFile): Promise<void> {
  const gone = Object.keys(budgets.actions).filter(
    (action) => !(BUDGETED_ACTIONS as readonly string[]).includes(action),
  );
  if (gone.length > 0 && !ALLOW_RENAME) {
    throw new Error(
      `budgets.json holds actions the harness no longer measures (${gone.join(', ')}). ` +
        'A renamed action would start again from whatever it counts now; carry its numbers over ' +
        'by hand, or set PERF_BUDGETS_ALLOW_RENAME=1 to drop them.',
    );
  }
  const actions: Record<string, ActionBudget> = {};
  for (const action of BUDGETED_ACTIONS) {
    const work = counted.get(action);
    const was = budgets.actions[action];
    if (work !== undefined) {
      actions[action] = lowered(was, budgetFor(work, ROW_RULES[action]), { allowDrop: ALLOW_DROP });
    } else if (was !== undefined) actions[action] = was;
  }
  const next: BudgetsFile = { $comment: budgets.$comment, actions };
  await writeFile(BUDGETS_FILE, `${JSON.stringify(next, null, 2)}\n`);
}
