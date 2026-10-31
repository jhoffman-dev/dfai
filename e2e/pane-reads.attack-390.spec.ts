import { rename, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  emitVaultChanged,
  installHost,
  sidebarSection,
  splitWindow,
  type FakeVault,
} from './host.ts';
import { suggestion } from './link-suggest.ts';

/**
 * Attack on PR #390 (Performance 9, #325): each pane reads again only for
 * news of what it shows. These try to make a pane show stale data after
 * another program changes what it shows. The first three fail on the PR's
 * head; the rest guard what it got right.
 */

const GTD_TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '  waiting_on:',
  '    kind: relation',
  '    target: person',
  '  project:',
  '    kind: relation',
  '    targets: [project, area]',
  '  defer: date',
  '  due: date',
  '---',
  '',
  '# Task',
  '',
].join('\n');

const note = (frontmatter: string[], body: string) =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n');

/** "Café" as typed on a keyboard (NFC), and as a Cocoa app may name its file (NFD). */
const CAFE_TYPED = 'Café';
const CAFE_ON_DISK = 'Café';
const CAFE_PATH = `${CAFE_ON_DISK}.md`;

const PLANS = '# Plans\n\nThe summer, roughly.\n\nPack the tent ^p1\n';

async function open(page: Page, vault: FakeVault): Promise<void> {
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 20_000 });
}

async function notesVault(): Promise<FakeVault> {
  const vault = await createVault();
  await vault.write('Plans.md', PLANS);
  await vault.write(CAFE_PATH, `# ${CAFE_TYPED}\n\nOpen late ^p1\n`);
  await vault.write('Journal.md', '# Journal\n\nToday.\n\n![[Plans#^p1]]\n');
  await vault.write('Visits.md', `# Visits\n\nWhere to go.\n\n![[${CAFE_TYPED}#^p1]]\n`);
  await vault.write('Far.md', '# Far\n\nThe edge.\n');
  await vault.write('Elsewhere.md', '# Elsewhere\n\nNothing to do with it.\n');
  return vault;
}

/** A vault of two tasks filed under `filedUnder`: a note of its `type`, or of none for null. */
async function gtdVault(filedUnder: { path: string; type: string | null }): Promise<FakeVault> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'Projects', 'Areas', 'Notes', 'Tasks', 'Inbox']) {
    await vault.mkdir(folder);
  }
  await vault.write('.atlas/types/task.md', GTD_TASK_TYPE);
  await vault.write(
    filedUnder.path,
    filedUnder.type === null
      ? 'Where it goes.\n'
      : note([`type: ${filedUnder.type}`], 'Where it goes.'),
  );
  const name = filedUnder.path.slice(filedUnder.path.lastIndexOf('/') + 1, -3);
  await vault.write(
    'Tasks/Weed the beds.md',
    note(['type: task', 'status: next-action', `project: "[[${name}]]"`], 'Before May.'),
  );
  await vault.write(
    'Inbox/Call the bank.md',
    note(['type: task', 'status: inbox', `project: "[[${name}]]"`], 'About the loan.'),
  );
  return vault;
}

const pane = (page: Page, which: 1 | 2) => page.getByRole('region', { name: `Pane ${which}` });
const tabsOf = (page: Page, which: 1 | 2) =>
  page.getByRole('tablist', { name: `Pane ${which} tabs` }).getByRole('tab');
const goTo = (page: Page) => page.getByRole('list', { name: 'Go to' });

async function openNote(page: Page, name: string | RegExp, which: 1 | 2) {
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name, exact: typeof name === 'string' })
    .click();
  await expect(pane(page, which).getByRole('article', { name })).toBeVisible();
}

/** Another program writes `path`, and the host's watcher says so. */
async function writeOutside(page: Page, vault: FakeVault, path: string, text: string) {
  await vault.write(path, text);
  await emitVaultChanged(page, [path]);
}

/** Another program moves a file (Finder, `mv`), and the host's watcher says so. */
async function moveOutside(page: Page, vault: FakeVault, from: string, to: string) {
  await mkdir(join(vault.root, to, '..'), { recursive: true });
  await rename(join(vault.root, from), join(vault.root, to));
  await emitVaultChanged(page, [from, to]);
}

async function deleteOutside(page: Page, vault: FakeVault, path: string) {
  await unlink(join(vault.root, path));
  await emitVaultChanged(page, [path]);
}

const embedIn = (page: Page, which: 1 | 2) =>
  pane(page, which).getByLabel('Embedded block', { exact: true });

test.describe('attack-390: stale panes (failing on the PR head)', () => {
  test('an embed whose source file name is decomposed (NFD) shows another program’s edit to it', async ({
    page,
  }) => {
    const vault = await notesVault();
    await open(page, vault);
    await openNote(page, 'Visits', 1);
    await expect(embedIn(page, 1)).toHaveText('Open late');
    await splitWindow(page);
    await openNote(page, /^Caf/, 2);

    await writeOutside(page, vault, CAFE_PATH, `# ${CAFE_TYPED}\n\nOpen early ^p1\n`);
    // The index has the edit: the pane on the source note itself shows it.
    await expect(pane(page, 2).getByLabel('Note', { exact: true })).toContainText('Open early');
    // So must the embed of it: `![[Café#^p1]]` resolves to the NFD file (resolveWikiLinkTarget
    // composes), but `notePaneScope`'s linkedNames do not, so the pane is never told.
    await expect(embedIn(page, 1)).toHaveText('Open early');
  });

  test('an Inbox row’s File under picker follows its project moved by another program', async ({
    page,
  }) => {
    const vault = await gtdVault({ path: 'Projects/DFAI.md', type: 'project' });
    await open(page, vault);
    await goTo(page)
      .getByRole('button', { name: /^Inbox/ })
      .click();
    const inbox = page.getByRole('article', { name: 'Inbox' });
    const fileUnder = inbox.getByRole('combobox', { name: 'File Call the bank under' });
    // The field shows the project the row holds by its title (#465).
    await expect(fileUnder).toHaveValue('DFAI');

    await moveOutside(page, vault, 'Projects/DFAI.md', 'Projects/Active/DFAI.md');
    // The choices heard it (INBOX_CHOICES_SCOPE holds project): DFAI is offered where it is now.
    await fileUnder.click();
    await expect(suggestion(fileUnder, 'DFAI')).toHaveAttribute('aria-label', /Active/);
    await fileUnder.press('Escape');
    // `[[DFAI]]` now resolves there, and the row holds the project where it is.
    await expect(fileUnder).toHaveValue('DFAI');
  });

  test('Today drops a next action’s area group when another program deletes the area', async ({
    page,
  }) => {
    const vault = await gtdVault({ path: 'Areas/Garden.md', type: 'area' });
    await open(page, vault);
    await goTo(page).getByRole('button', { name: 'Today' }).click();
    const nextActions = page
      .getByRole('article', { name: 'Today' })
      .getByRole('region', { name: 'Next actions', exact: true });
    await expect(nextActions.getByRole('group', { name: 'Garden' })).toHaveCount(1);

    await deleteOutside(page, vault, 'Areas/Garden.md');
    // REVIEW_SCOPE holds task, meeting and project, not area: no task's bytes changed.
    await expect(nextActions.getByRole('group', { name: 'Garden' })).toHaveCount(0);
  });
});

test.describe('attack-390: guards (passing on the PR head)', () => {
  test('Today drops a next action’s project group when another program deletes the project', async ({
    page,
  }) => {
    const vault = await gtdVault({ path: 'Projects/Garden.md', type: 'project' });
    await open(page, vault);
    await goTo(page).getByRole('button', { name: 'Today' }).click();
    const nextActions = page
      .getByRole('article', { name: 'Today' })
      .getByRole('region', { name: 'Next actions', exact: true });
    await expect(nextActions.getByRole('group', { name: 'Garden' })).toHaveCount(1);

    await deleteOutside(page, vault, 'Projects/Garden.md');
    await expect(nextActions.getByRole('group', { name: 'Garden' })).toHaveCount(0);
  });

  test('a hidden tab’s embed shows another program’s edit to its source once the tab is shown', async ({
    page,
  }) => {
    const vault = await notesVault();
    await open(page, vault);
    await openNote(page, 'Journal', 1);
    await expect(embedIn(page, 1)).toHaveText('Pack the tent');

    await page.keyboard.press('Meta+t');
    await expect(tabsOf(page, 1)).toHaveCount(2);
    await openNote(page, 'Elsewhere', 1);

    await writeOutside(
      page,
      vault,
      'Plans.md',
      PLANS.replace('Pack the tent', 'Pack the big tent'),
    );
    await tabsOf(page, 1).first().click();
    await expect(pane(page, 1).getByRole('article', { name: 'Journal' })).toBeVisible();
    await expect(embedIn(page, 1)).toHaveText('Pack the big tent');
  });

  test('a hidden tab shows another program’s edit to its own note once the tab is shown', async ({
    page,
  }) => {
    const vault = await notesVault();
    await open(page, vault);
    await openNote(page, 'Journal', 1);
    await page.keyboard.press('Meta+t');
    await expect(tabsOf(page, 1)).toHaveCount(2);
    await openNote(page, 'Elsewhere', 1);

    await writeOutside(page, vault, 'Journal.md', '# Journal\n\nTomorrow.\n\n![[Plans#^p1]]\n');
    await tabsOf(page, 1).first().click();
    await expect(pane(page, 1).getByRole('article', { name: 'Journal' })).toContainText(
      'Tomorrow.',
    );
  });

  test('two panes on the same note both show another program’s edit to its embed', async ({
    page,
  }) => {
    const vault = await notesVault();
    await open(page, vault);
    await openNote(page, 'Journal', 1);
    await splitWindow(page);
    await openNote(page, 'Journal', 2);
    await expect(embedIn(page, 1)).toHaveText('Pack the tent');
    await expect(embedIn(page, 2)).toHaveText('Pack the tent');

    await writeOutside(
      page,
      vault,
      'Plans.md',
      PLANS.replace('Pack the tent', 'Pack the big tent'),
    );
    await expect(embedIn(page, 1)).toHaveText('Pack the big tent');
    await expect(embedIn(page, 2)).toHaveText('Pack the big tent');
  });

  test('an embed whose source note is moved by another program still shows it', async ({
    page,
  }) => {
    const vault = await notesVault();
    await open(page, vault);
    await openNote(page, 'Journal', 1);
    await expect(embedIn(page, 1)).toHaveText('Pack the tent');

    await vault.write('Plans.md', PLANS.replace('Pack the tent', 'Pack the big tent'));
    await moveOutside(page, vault, 'Plans.md', 'Trips/Plans.md');
    await expect(embedIn(page, 1)).toHaveText('Pack the big tent');
  });

  test('a backlink another program adds shows in the shown note’s links', async ({ page }) => {
    const vault = await notesVault();
    await open(page, vault);
    await openNote(page, 'Far', 1);
    const toggle = page
      .getByRole('region', { name: 'Links', exact: true })
      .getByRole('button', { name: /^Links/ });
    await expect(toggle).toContainText('No links yet');

    await writeOutside(page, vault, 'Elsewhere.md', '# Elsewhere\n\nSee [[Far]].\n');
    await expect(toggle).toContainText('1 linked here');

    await writeOutside(page, vault, 'Elsewhere.md', '# Elsewhere\n\nNo link now.\n');
    await expect(toggle).toContainText('No links yet');
  });
});

test.describe('#392: Today hears the untyped note a task is filed under', () => {
  const nextActionsOf = (page: Page) =>
    page
      .getByRole('article', { name: 'Today' })
      .getByRole('region', { name: 'Next actions', exact: true });

  test('drops the group when another program deletes the note', async ({ page }) => {
    const vault = await gtdVault({ path: 'Notes/Garden plan.md', type: null });
    await open(page, vault);
    await goTo(page).getByRole('button', { name: 'Today' }).click();
    const nextActions = nextActionsOf(page);
    await expect(nextActions.getByRole('group', { name: 'Garden plan' })).toHaveCount(1);

    await deleteOutside(page, vault, 'Notes/Garden plan.md');
    // No task's bytes changed and the note has no type: only its own path names it.
    await expect(nextActions.getByRole('group', { name: 'Garden plan' })).toHaveCount(0);
  });

  test('drops the group when another program renames the note, and the link no longer finds it', async ({
    page,
  }) => {
    const vault = await gtdVault({ path: 'Notes/Garden plan.md', type: null });
    await open(page, vault);
    await goTo(page).getByRole('button', { name: 'Today' }).click();
    const nextActions = nextActionsOf(page);
    await expect(nextActions.getByRole('group', { name: 'Garden plan' })).toHaveCount(1);

    await moveOutside(page, vault, 'Notes/Garden plan.md', 'Notes/Vegetable plan.md');
    await expect(nextActions.getByRole('group', { name: 'Garden plan' })).toHaveCount(0);
  });

  test('groups the task when another program makes the note its link names, none until then', async ({
    page,
  }) => {
    const vault = await gtdVault({ path: 'Notes/Garden plan.md', type: null });
    await unlink(join(vault.root, 'Notes/Garden plan.md'));
    await open(page, vault);
    await goTo(page).getByRole('button', { name: 'Today' }).click();
    const nextActions = nextActionsOf(page);
    await expect(nextActions.getByText('Weed the beds')).toBeVisible();
    await expect(nextActions.getByRole('group', { name: 'Garden plan' })).toHaveCount(0);

    // The link resolves only once the note is there: no task's bytes changed.
    await writeOutside(page, vault, 'Notes/Garden plan.md', 'Where it goes.\n');
    await expect(nextActions.getByRole('group', { name: 'Garden plan' })).toHaveCount(1);
  });
});
