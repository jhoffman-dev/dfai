/**
 * Typing straight after clicking into a note (#140).
 *
 * Twice in CI, keys typed after a click into a note's text landed at the start
 * of the note. The app was reading the vault again on every render, without
 * end, so the window was never idle; ProseMirror puts its own cursor back when
 * a click's selection has not reached it 20ms after the focus, and its own
 * cursor in a note nobody has clicked into is the start of the note.
 *
 * So: a note left alone goes quiet, and what is read after a note opens — its
 * linked pages, its backlinks, its properties' choices — lands around a cursor
 * without moving it.
 */
import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection, type FakeVault } from './host.ts';
import { caretAtLineEnd } from './caret.ts';

const front = (lines: string[], body: string) => ['---', ...lines, '---', '', body, ''].join('\n');

const PERSON_TYPE = front(['name: person', 'label: Person', 'properties:', '  role: text'], '');
const MEETING_TYPE = front(
  [
    'name: meeting',
    'label: Meeting',
    'properties:',
    '  date: date',
    '  people:',
    '    kind: relation',
    '    target: person',
    '    many: true',
  ],
  '',
);

const MARA = 'People/Mara Quill.md';
const MARA_FRONT = ['type: person', 'role: Controller'];
const MARA_BODY = 'Runs payroll at Larkspur. Prefers mornings.';
const TODAY = new Date().toLocaleDateString('en-CA');

interface HostCalls {
  /** Every command the app has sent the host. */
  sent: number;
  /** Commands waiting behind the hold, and those of them the host has since answered. */
  held: number;
  answered: number;
  holding: boolean;
  release: () => void;
}

/**
 * Counts what the app asks the host, and can keep the answers back.
 *
 * Reading the note's own file is never held: the note has to open for there to
 * be a cursor to place while everything else is still on its way.
 */
async function watchHostCalls(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const calls: HostCalls = { sent: 0, held: 0, answered: 0, holding: false, release: () => {} };
    let hold: Promise<void> = Promise.resolve();
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (...args: unknown[]) => Promise<unknown> };
      }
    ).__TAURI_INTERNALS__;
    const invoke = internals.invoke;
    internals.invoke = (command, ...rest) => {
      if (typeof command !== 'string' || command.startsWith('plugin:event')) {
        return invoke(command, ...rest);
      }
      calls.sent += 1;
      if (!calls.holding || command === 'read_text_file') return invoke(command, ...rest);
      calls.held += 1;
      return hold
        .then(() => invoke(command, ...rest))
        .finally(() => {
          calls.answered += 1;
        });
    };
    Object.assign(window, {
      __hostCalls: calls,
      __holdHost: () => {
        calls.holding = true;
        hold = new Promise<void>((resolve) => {
          calls.release = resolve;
        });
      },
      __releaseHost: () => {
        calls.holding = false;
        calls.release();
      },
    });
  });
}

const hostCalls = (page: Page): Promise<HostCalls> =>
  page.evaluate(() => (window as unknown as { __hostCalls: HostCalls }).__hostCalls);

async function openVault(page: Page): Promise<FakeVault> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'People', 'Meetings']) await vault.mkdir(folder);
  await vault.write('.atlas/types/person.md', PERSON_TYPE);
  await vault.write('.atlas/types/meeting.md', MEETING_TYPE);
  await vault.write(MARA, front(MARA_FRONT, MARA_BODY));
  await vault.write(
    'Meetings/Kickoff.md',
    front(
      ['type: meeting', `date: ${TODAY}`, 'people: ["[[Mara Quill]]"]'],
      'With [[Mara Quill]].',
    ),
  );
  await installHost(page, vault);
  await watchHostCalls(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'People' }).click();
  return vault;
}

const maraRow = (page: Page) =>
  sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Mara Quill', exact: true });

test('an open note left alone stops asking the host for anything', async ({ page }) => {
  await openVault(page);
  await maraRow(page).click();
  await expect(page.getByRole('article', { name: 'Mara Quill' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Meetings', exact: true })).toContainText(
    'Kickoff',
  );

  // How many commands went to the host since the last look: none, once the
  // app has read what it needs. Reading the vault again on every render never
  // gets there.
  let seen = 0;
  const sentSinceLastLook = async () => {
    const { sent } = await hostCalls(page);
    const since = sent - seen;
    seen = sent;
    return since;
  };
  expect(await sentSinceLastLook()).toBeGreaterThan(0);
  await expect.poll(sentSinceLastLook, { timeout: 15_000 }).toBe(0);
});

test('what a note reads after it opens lands around the cursor without moving it', async ({
  page,
}) => {
  const vault = await openVault(page);

  await page.evaluate(() => (window as unknown as { __holdHost: () => void }).__holdHost());
  await maraRow(page).click();
  await expect(page.getByRole('article', { name: 'Mara Quill' })).toBeVisible();

  // Clicked into and typed in while the linked pages, the backlinks and the
  // index have not answered yet.
  await caretAtLineEnd(page.getByLabel('Note', { exact: true }).getByText(MARA_BODY));
  await page.keyboard.type(' One');
  const waiting = await hostCalls(page);
  expect(waiting.held).toBeGreaterThan(waiting.answered);
  // Her meetings are one of the answers still to come; the same locator finds them below.
  const meetings = page.getByRole('region', { name: 'Meetings', exact: true });
  await expect(meetings).toBeHidden();

  // They all land, and draw above the text being typed.
  await page.evaluate(() => (window as unknown as { __releaseHost: () => void }).__releaseHost());
  await expect(meetings).toContainText('Kickoff');
  await expect
    .poll(async () => {
      const { held, answered } = await hostCalls(page);
      return held - answered;
    })
    .toBe(0);

  await page.keyboard.type(' two.');
  await expect(page.getByLabel('Note', { exact: true })).toHaveText(`${MARA_BODY} One two.`);
  await expectFile(vault, MARA).toBe(front(MARA_FRONT, `${MARA_BODY} One two.`));
});
