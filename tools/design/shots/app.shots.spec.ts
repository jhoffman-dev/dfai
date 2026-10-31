// `pnpm shots`: the shell, views, notes, overlays, pages, graph, tags and
// artifacts, in one session. What the shots specs share, and why they assert
// nothing, is in kit.ts.
import { join } from 'node:path';
import { test } from '../../../e2e/fixtures.ts';
import type { Page } from '@playwright/test';
import { installHost, sidebarSection } from '../../../e2e/host.ts';
import {
  OUT,
  THEME_KEY,
  NOTE_WORDS,
  NOTE_TITLE,
  SETTLE_MS,
  prepareVault,
  openVault,
  useTheme,
  shoot,
  open,
  search,
  openBySearch,
  view,
} from './kit.ts';

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

/**
 * The center peek over the table (slice 6b, FlowPeek.dc.html): a row's note,
 * with the preview card of the first link in it that has one.
 */
async function shootPeek(page: Page, theme: string): Promise<void> {
  await page.locator('.table__sheet').evaluate((sheet) => sheet.scrollTo(0, 0));
  if (!(await open('peek', [page.locator('.table__row .table__link')]))) return;
  const peek = page.locator('.peek');
  await peek.waitFor({ timeout: 5_000 }).catch(() => console.warn('peek: it never opened'));
  const link = peek.locator('[data-link-path], a.wikilink[data-wikilink]').first();
  if ((await link.count()) > 0) {
    await link.hover();
    await page
      .getByRole('tooltip')
      .waitFor({ timeout: 3_000 })
      .catch(() => console.warn('peek: no preview card came up'));
  } else console.warn('peek: its note has no link to preview');
  await shoot(page, `peek-${theme}`);
  await page.mouse.move(0, 0);
  await page.keyboard.press('Escape');
  await peek.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
}

async function shootViews(page: Page, theme: string): Promise<void> {
  const dashboards = sidebarSection(page, 'dashboards');
  if (
    await open('dashboard', [dashboards.getByRole('button', { name: 'Progress', exact: true })])
  ) {
    await shoot(page, `dashboard-${theme}`);
    // One bar chart read as a table: the toggle is per widget and not saved.
    const toggle = page.getByRole('button', { name: 'Show as table' }).first();
    if (await open('dashboard-table', [toggle])) {
      await shoot(page, `dashboard-table-${theme}`);
      await toggle.click();
    }
  }
  if (await open('board', view(page, 'Board'))) {
    await shoot(page, `board-${theme}`);
    const toolbar = page.locator('.view-toolbar');
    if (await open('filter', [toolbar.getByRole('button', { name: /^Filter/ })])) {
      await shoot(page, `filter-${theme}`);
      await page.keyboard.press('Escape');
    }
  }
  if (await open('all-tasks', view(page, 'All tasks'))) {
    await shoot(page, `all-tasks-${theme}`);
    // Scrolled to the last row: the header should still be at the top of the sheet.
    await page.locator('.table__sheet').evaluate((sheet) => sheet.scrollTo(0, sheet.scrollHeight));
    await shoot(page, `all-tasks-scrolled-${theme}`);
    await page.locator('.table__sheet').evaluate((sheet) => sheet.scrollTo(0, 0));
    // Editing in place (#300): the status picker open on the fifth row, against FlowTable.
    const fifth = page.locator('.table__sheet tbody tr').nth(4);
    if (await open('table-editing', [fifth.locator('[data-cell-stop="status"]')])) {
      await page
        .getByRole('dialog', { name: /^Set / })
        .waitFor({ timeout: 3_000 })
        .catch(() => console.warn('table-editing: the picker did not open'));
      await shoot(page, `table-editing-${theme}`);
      await page.keyboard.press('Escape');
    }
    await shootPeek(page, theme);
  }
  if (await open('calendar', view(page, 'Calendar'))) {
    await shoot(page, `calendar-${theme}`);
    const range = page.getByRole('radiogroup', { name: 'Calendar range' });
    for (const [name, label] of [
      ['week', 'Week'],
      ['agenda', 'Agenda'],
    ] as const) {
      if (await open(`calendar ${name}`, [range.getByRole('radio', { name: label })])) {
        await shoot(page, `calendar-${name}-${theme}`);
      }
    }
    await open('calendar month', [range.getByRole('radio', { name: 'Month' })]);
  }
  if (await open('timeline', view(page, 'Roadmap'))) await shoot(page, `timeline-${theme}`);
  const inbox = page.getByRole('navigation', { name: 'Vault' }).getByRole('button', {
    name: /^Inbox/,
  });
  if (await open('list', [inbox])) await shoot(page, `list-${theme}`);
  // The Inbox with one offer showing, judged against FlowInbox.dc.html's notice bar:
  // the repo's vault keeps a note at its root, so the tidy is offered.
  const offer = page.getByRole('region', { name: 'Tidy the vault' });
  // An Inbox with no offer is warned about just below.
  await offer.waitFor({ timeout: 5_000 }).catch(() => undefined);
  if (await offer.isVisible()) await shoot(page, `inbox-${theme}`);
  else console.warn('inbox: no offer showing — skipped');
  const types = sidebarSection(page, 'types');
  if (await open('type', [types.getByRole('button', { name: /^Task, / })])) {
    await shoot(page, `type-${theme}`);
    // One row lit: the type, not the note last opened before it.
    await shoot(page, `sidebar-type-${theme}`, page.getByRole('navigation', { name: 'Vault' }));
  }
}

/**
 * All tasks drawn every way the Layout menu offers (P17-05), switched from the
 * menu itself as a person would — on the copy of the vault, so nothing real
 * changes — and put back to a table afterwards.
 */
async function shootLayouts(page: Page, theme: string): Promise<void> {
  if (!(await open('layouts', view(page, 'All tasks')))) return;
  const choose = async (layout: string): Promise<boolean> => {
    if (!(await open('layout menu', [page.getByRole('button', { name: 'Layout', exact: true })]))) {
      return false;
    }
    const item = page.getByRole('menuitemradio', { name: new RegExp(`^${layout}`) });
    await item.waitFor({ timeout: 5_000 });
    await item.click();
    await page.locator(`.view-toolbar [data-layout="${layout.toLowerCase()}"]`).waitFor();
    return true;
  };

  const trigger = page.getByRole('button', { name: 'Layout', exact: true });
  // The view's toolbar is drawn once its query has run.
  await trigger.waitFor({ timeout: 10_000 }).catch(() => undefined);
  if (await open('layout menu', [trigger])) {
    await shoot(page, `layout-menu-${theme}`);
    await page.keyboard.press('Escape');
  }
  for (const layout of ['Feed', 'Gallery', 'List']) {
    if (await choose(layout)) await shoot(page, `layout-${layout.toLowerCase()}-${theme}`);
  }
  await choose('Table');
}

async function shootNotes(page: Page, theme: string): Promise<void> {
  if (await openBySearch(page, { words: NOTE_WORDS, name: NOTE_TITLE }))
    await shoot(page, `note-${theme}`);
  if (await openBySearch(page, { words: 'Callouts', name: /^Specimen/ })) {
    await shoot(page, `specimen-${theme}`);
    await shootEditorPopups(page, theme);
  }
  if (await openBySearch(page, { words: 'milestone', name: /Sources/ }))
    await shoot(page, `source-${theme}`);
  // An ADR with no `title`, listed by the heading it opens with.
  if (await openBySearch(page, { words: 'widget query drawing', name: /widget is a query/i }))
    await shoot(page, `adr-${theme}`);
}

/** The slash menu and the wikilink suggestions, typed at the end of the specimen. */
async function shootEditorPopups(page: Page, theme: string): Promise<void> {
  const editor = page.locator('.ProseMirror').first();
  if ((await editor.count()) === 0) return console.warn('editor: not found — popups skipped');
  await editor.click();
  await page.keyboard.press('Meta+ArrowUp');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('/');
  await shoot(page, `slash-${theme}`);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('[[Unt');
  await shoot(page, `wikilink-${theme}`);
  await page.keyboard.press('Escape');
  for (let typed = 0; typed < '[[Unt'.length; typed += 1) await page.keyboard.press('Backspace');
  await page.keyboard.type('#de');
  await shoot(page, `tag-suggest-${theme}`);
  await page.keyboard.press('Escape');
}

/** The tags page, on the specimen's nested tag, then its rename preview. */
async function shootTags(page: Page, theme: string): Promise<void> {
  await page.keyboard.press('Escape');
  const tagsRow = page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Tags' });
  if (!(await open('tags', [tagsRow]))) return;
  const tree = page.getByRole('list', { name: 'Tags', exact: true });
  if (!(await open('a tag', [tree.getByRole('button', { name: /^system \d/ })]))) return;
  await shoot(page, `tags-${theme}`);
  await page.getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('New name').fill('design/tokens');
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.getByText(/will become/).waitFor({ timeout: 5_000 });
  await shoot(page, `tags-rename-${theme}`);
}

async function shootOverlays(page: Page, theme: string): Promise<void> {
  const palette = await search(page, 'view');
  if (await palette.isVisible()) await shoot(page, `search-${theme}`);
  else console.warn('search: the palette did not open — skipped');
  await page.keyboard.press('Escape');

  await page.keyboard.press('Shift+Meta+n');
  const capture = page.getByRole('dialog', { name: /capture/i });
  // A palette that never opens is warned about just below.
  await capture.waitFor({ timeout: 3_000 }).catch(() => undefined);
  if (await capture.isVisible()) await shoot(page, `capture-${theme}`);
  else console.warn('capture: the palette did not open — skipped');
  await page.keyboard.press('Escape');

  if (await open('new-note', [page.getByRole('button', { name: 'New note', exact: true })])) {
    await shoot(page, `new-note-${theme}`);
    await page.keyboard.press('Escape');
  }
  if (await open('settings', [page.getByRole('button', { name: 'Settings', exact: true })])) {
    await shoot(page, `settings-${theme}`);
    await shootProfile(page, theme);
    await page.keyboard.press('Escape');
  }
}

/** Settings → Profile with no name, then with one; the name is cleared again after. */
async function shootProfile(page: Page, theme: string): Promise<void> {
  const profile = page.getByRole('region', { name: 'Profile' });
  if ((await profile.count()) === 0) {
    console.warn('profile: no Profile section in Settings');
    return;
  }
  const name = profile.getByRole('textbox', { name: 'Full name' });
  await profile.scrollIntoViewIfNeeded();
  await page.waitForTimeout(SETTLE_MS);
  await profile.screenshot({
    path: join(OUT, `profile-empty-${theme}.png`),
    animations: 'disabled',
  });
  await name.fill('James Hoffman');
  await name.press('Enter');
  await profile.getByText('What Claude writes for you').waitFor();
  await page.waitForTimeout(SETTLE_MS);
  await profile.screenshot({ path: join(OUT, `profile-${theme}.png`), animations: 'disabled' });
  await name.fill('');
  await name.press('Enter');
  await profile.getByText(/Not set/).waitFor();
}

/** Pages' row menu, and the folder picker and the delete question it opens — nothing is moved or deleted. */
async function shootPages(page: Page, theme: string): Promise<void> {
  await page.keyboard.press('Escape');
  const pages = sidebarSection(page, 'userSpace');
  const folder = pages.getByRole('treeitem', { name: 'docs', exact: true });
  if ((await folder.count()) === 0) return console.warn('pages: no docs folder — skipped');
  const menu = async (): Promise<boolean> => {
    await folder.hover();
    return open('row menu', [pages.getByRole('button', { name: 'Options for docs' })]);
  };
  if (!(await menu())) return;
  await shoot(page, `pages-menu-${theme}`);
  if (await open('move picker', [page.getByRole('menuitem', { name: /^Move to…/ })])) {
    await page.getByRole('dialog', { name: /^Move docs to/ }).waitFor({ timeout: 5_000 });
    await shoot(page, `move-picker-${theme}`);
    await page.keyboard.press('Escape');
  }
  if (!(await menu())) return;
  if (await open('delete dialog', [page.getByRole('menuitem', { name: /^Delete…/ })])) {
    await page.getByRole('alertdialog').waitFor({ timeout: 5_000 });
    await shoot(page, `delete-dialog-${theme}`);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
  }
}

/** The graph of the whole vault, the graph around one note, and a note's Links opened (P17-06). */
async function shootGraph(page: Page, theme: string): Promise<void> {
  await page.keyboard.press('Escape');
  const graphRow = page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Graph' });
  if (await open('graph', [graphRow])) {
    await page.locator('.graph__node').first().waitFor({ timeout: 10_000 });
    await shoot(page, `graph-${theme}`);
  }
  if (!(await openBySearch(page, { words: 'documents', name: /^DFAI/ }))) return;
  const links = page.getByRole('region', { name: 'Links', exact: true });
  await links.getByRole('button', { name: /^Links/ }).click();
  await links.scrollIntoViewIfNeeded();
  await shoot(page, `links-${theme}`);
  await page.getByRole('button', { name: 'More' }).first().click();
  const showInGraph = page.getByRole('menuitem', { name: /^Show in graph/ });
  // A menu that never shows is reported by `open` below, as a skipped surface.
  await showInGraph.waitFor({ timeout: 5_000 }).catch(() => undefined);
  if (await open('local graph', [showInGraph])) {
    await page.locator('.graph__node--centre').waitFor({ timeout: 10_000 });
    await shoot(page, `graph-local-${theme}`);
  }
}

async function shootSplit(page: Page, theme: string): Promise<void> {
  if (!(await open('split board', view(page, 'Board')))) return;
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+Meta+\\');
  await shoot(page, `split-${theme}`);
  await page.keyboard.press('Shift+Meta+\\');
}

/** New artifact with a pasted link, an artifact's note with its copy, and the gallery. */
async function shootArtifacts(page: Page, theme: string): Promise<void> {
  await page.keyboard.press('Escape');
  const palette = await search(page, 'https://claude.ai/artifact/9c2f-onboarding-flow');
  if (await open('new artifact', [palette.getByRole('option', { name: /as an artifact/ })])) {
    const dialog = page.getByRole('dialog', { name: 'New artifact' });
    await dialog.getByRole('textbox', { name: 'Title' }).fill('Onboarding flow');
    await shoot(page, `new-artifact-${theme}`);
    await page.keyboard.press('Escape');
  }
  if (await openBySearch(page, { words: 'board meeting September', name: /Q3 sales deck/ })) {
    await page
      .frameLocator('iframe[title="Saved copy of Q3 sales deck"]')
      .getByText('32%')
      .waitFor({ timeout: 10_000 })
      .catch(() => console.warn('artifact: the saved copy never drew'));
    await shoot(page, `artifact-note-${theme}`);
  }
  if (await open('artifacts gallery', view(page, 'Artifacts'))) {
    await shoot(page, `artifacts-gallery-${theme}`);
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`shots, ${theme}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: THEME_KEY,
      value: theme,
    });
    const vault = await prepareVault();
    await installHost(page, vault);
    await page.goto('/');
    await shoot(page, `welcome-${theme}`);
    await openVault(page);
    await useTheme(page, theme);

    await shoot(page, `empty-${theme}`);
    await shoot(page, `sidebar-${theme}`, page.getByRole('navigation', { name: 'Vault' }));
    await shootViews(page, theme);
    await shootLayouts(page, theme);
    await shootNotes(page, theme);
    await shootSplit(page, theme);
    await shootOverlays(page, theme);
    await shootPages(page, theme);
    await shootGraph(page, theme);
    await shootTags(page, theme);
    await shootArtifacts(page, theme);
  });
}
