// `pnpm shots` — screenshots the built app, on a copy of this repo's vault, for
// side-by-side comparison with the mockups (see design/README.md). Not part of
// `pnpm e2e`: it asserts nothing about behaviour, and a surface that cannot be
// found is skipped with a warning, because the shell is being restyled under it.
//
// This file is what every shots spec shares: the vault they photograph,
// opening it, the theme and the camera. Each surface is a spec file of its own
// beside it (`<surface>.shots.spec.ts`), so a new surface adds a file (#134).
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '../../../e2e/fixtures.ts';
import type { Locator, Page } from '@playwright/test';
import { createVault, sidebarSection, type FakeVault } from '../../../e2e/host.ts';

export const OUT = join(import.meta.dirname, '..', '..', '..', 'design', 'out', 'shots');
export const VAULT = join(import.meta.dirname, '..', '..', '..', 'vault');
/** Where the theme choice lives — `packages/shell/src/theme/browser-theme-store.ts`. */
export const THEME_KEY = 'atlas.theme';
/** vault/tasks/A15-03.md, found by a word only its body has. */
export const NOTE_WORDS = 'compileViewQuery';
// Search lists it by its `title`, not its filename.
export const NOTE_TITLE = /^Leftovers from A15-02/;
/** Long enough for charts and the board to finish laying out; this is a camera, not a test. */
export const SETTLE_MS = 700;

/**
 * A note holding everything the editor draws, which the repo's own vault does
 * not: a callout, a table, code, a checklist and a link. No image: the fake
 * host's binary reads do not survive the trip into the page, so one would
 * only ever photograph as broken.
 */
export const SPECIMEN = [
  '# Specimen',
  '',
  'A paragraph of running text with **bold**, _emphasis_, `inline code` and a link to [[Untitled]].',
  '',
  'Tagged #design/system, #phase16 and #tag me# — tags stay text.',
  '',
  '> [!note] A callout',
  '> Callouts carry a tint and an icon, never a heavy rule.',
  '',
  '| Surface | Radius | Shadow |',
  '| ------- | ------ | ------ |',
  '| Panel   | 22     | panel  |',
  '| Card    | 16     | card   |',
  '',
  '```ts',
  'export function greet(name: string): string {',
  '  return `Hello, ${name}`; // a comment',
  '}',
  '```',
  '',
  '- [ ] Something to do',
  '- [x] Something done',
  '',
  '',
].join('\n');

/** A page an artifact's saved copy holds: styled, with a script, and no picture files. */
const ARTIFACT_PAGE = [
  '<!doctype html><html><head><title>Q3 sales</title><link rel="stylesheet" href="deck.css"></head>',
  '<body><main class="slide"><p class="kicker">Q3 review</p><h1>Revenue up <span id="growth">…</span></h1>',
  '<div class="bars"><i style="height:40%"></i><i style="height:55%"></i><i style="height:70%"></i><i style="height:92%"></i></div>',
  '<p>Four quarters of steady growth, led by the self-serve plan.</p></main>',
  '<script>document.getElementById("growth").textContent = "32%";</script></body></html>',
].join('');
const ARTIFACT_CSS = [
  'body{margin:0;font:16px/1.5 system-ui;background:linear-gradient(135deg,#0f2a6b,#1f6fd1);color:#fff;min-height:100vh;display:grid;place-items:center}',
  '.slide{max-width:640px;padding:48px}.kicker{text-transform:uppercase;letter-spacing:.12em;opacity:.7}',
  'h1{font-size:48px;margin:.2em 0}.bars{display:flex;gap:12px;align-items:end;height:160px;margin:24px 0}',
  '.bars i{flex:1;background:#5ee3f5;border-radius:8px 8px 0 0}',
].join('');

/** Three artifacts: two with saved copies, one with only its link. */
async function addArtifacts(vault: FakeVault): Promise<void> {
  await vault.mkdir('artifacts/q3-sales-deck');
  await vault.mkdir('artifacts/pricing-mockup');
  await vault.write('artifacts/q3-sales-deck/index.html', ARTIFACT_PAGE);
  await vault.write('artifacts/q3-sales-deck/deck.css', ARTIFACT_CSS);
  await vault.write('artifacts/pricing-mockup/index.html', '<h1>Pricing</h1>');
  const note = (fields: string, body: string) => `---\ntype: artifact\n${fields}---\n\n${body}\n`;
  await vault.write(
    'artifacts/Q3 sales deck.md',
    note(
      "url: https://claude.ai/artifact/q3-sales-deck\nkind: deck\nproject: '[[DFAI]]'\ntags: [sales, q3]\nsaved: artifacts/q3-sales-deck\nsaved_at: 2026-09-24\n",
      'Made for the board meeting; the numbers are from the September export.',
    ),
  );
  await vault.write(
    'artifacts/Pricing mockup.md',
    note(
      'url: https://claude.ai/artifact/pricing\nkind: design\ntags: [pricing]\nsaved: artifacts/pricing-mockup\nsaved_at: 2026-09-23\n',
      'Three tiers, annual toggle.',
    ),
  );
  await vault.write(
    'artifacts/Launch plan.md',
    note('url: https://claude.ai/artifact/launch-plan\nkind: doc\n', ''),
  );
}

/** Tasks around today, so the calendar's ranges and the roadmap have something to show. */
async function addCalendarTasks(vault: FakeVault): Promise<void> {
  // The shots run on the machine's clock, so the dates are taken from it: a
  // fixed month would empty the calendar the month after it was written.
  const day = (offset: number): string => {
    const at = new Date();
    at.setDate(at.getDate() + offset);
    return at.toLocaleDateString('en-CA');
  };
  const task = (title: string, fields: readonly string[]) =>
    ['---', 'type: task', `title: ${title}`, ...fields, '---', '', `${title}.`, ''].join('\n');
  const tasks: [string, readonly string[]][] = [
    [
      'Larkspur payroll import',
      ['id: S-01', 'status: doing', `scheduled: ${day(-6)}`, `due: ${day(-3)}T10:00`],
    ],
    [
      'Mara Quill onboarding call',
      [
        'id: S-02',
        'status: next',
        `scheduled: ${day(-3)}`,
        `due: ${day(-2)}T14:30`,
        `end: ${day(-2)}T15:30`,
        'blocked_by: [S-01]',
      ],
    ],
    [
      'Tobias Fenn contract review',
      [
        'id: S-03',
        'status: review',
        `scheduled: ${day(-2)}`,
        `due: ${day(2)}T09:00`,
        `end: ${day(2)}T10:30`,
        'blocked_by: [S-02]',
      ],
    ],
    [
      'Quarterly numbers',
      ['id: S-04', 'status: waiting', `scheduled: ${day(1)}`, `due: ${day(5)}`],
    ],
    [
      'Renew the office lease',
      ['id: S-05', 'status: backlog', `scheduled: ${day(3)}`, `due: ${day(3)}`],
    ],
    [
      'Ship the autumn release',
      ['id: S-06', 'status: next', `scheduled: ${day(4)}`, `due: ${day(12)}`, 'blocked_by: [S-03]'],
    ],
    [
      'Team lunch',
      [
        'id: S-07',
        'status: done',
        `scheduled: ${day(-4)}`,
        `due: ${day(-4)}T12:00`,
        `end: ${day(-4)}T13:00`,
      ],
    ],
    [
      'Write the weekly review',
      ['id: S-08', 'status: inbox', `scheduled: ${day(0)}`, `due: ${day(0)}T16:00`],
    ],
    ['Budget sign-off', ['id: S-09', 'status: doing', `scheduled: ${day(0)}`, `due: ${day(0)}`]],
    [
      'Plan the next sprint',
      ['id: S-10', 'status: next', `scheduled: ${day(8)}`, `due: ${day(10)}`],
    ],
  ];
  for (const [title, fields] of tasks) await vault.write(`tasks/${title}.md`, task(title, fields));
}

export async function prepareVault(): Promise<FakeVault> {
  const vault = await createVault();
  await cp(VAULT, vault.root, { recursive: true });
  await vault.write('Specimen.md', SPECIMEN);
  await addArtifacts(vault);
  await addCalendarTasks(vault);
  return vault;
}

export async function openVault(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 30_000 });
}

/** Sets the theme through whatever toggle the shell has today, since the key was preset before load. */
export async function useTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  const toggle = page
    .getByRole('switch', { name: /dark/i })
    .or(page.getByRole('button', { name: /dark theme/i }));
  const current = () => page.evaluate(() => document.documentElement.dataset['theme']);
  if ((await current()) !== theme && (await toggle.count()) > 0) await toggle.first().click();
  if ((await current()) !== theme) console.warn(`theme is ${await current()}, wanted ${theme}`);
}

export async function shoot(page: Page, name: string, clip?: Locator): Promise<void> {
  await page.waitForTimeout(SETTLE_MS);
  const path = join(OUT, `${name}.png`);
  const box = clip ? await clip.boundingBox() : null;
  await page.screenshot({
    path,
    animations: 'disabled',
    ...(box ? { clip: { x: 0, y: 0, width: box.x + box.width, height: 900 } } : {}),
  });
  console.log(path);
}

/** Clicks the first locator that matches, or warns and reports false. */
export async function open(surface: string, candidates: Locator[]): Promise<boolean> {
  for (const candidate of candidates) {
    if ((await candidate.count()) > 0) {
      await candidate.first().click();
      return true;
    }
  }
  console.warn(`${surface}: nothing to open it with — skipped`);
  return false;
}

/** The search palette, open, with `words` typed into it and its results in. */
export async function search(page: Page, words: string): Promise<Locator> {
  // Whatever the last surface left focused — a calendar cell, a board card —
  // must not swallow the shortcut, so the palette is waited for, not assumed.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+k');
  const palette = page.getByRole('dialog', { name: /search/i });
  // A palette that does not open is reported by the caller's `open`.
  await palette.waitFor({ timeout: 3_000 }).catch(() => undefined);
  if (!(await palette.isVisible())) {
    await page
      .getByRole('navigation', { name: 'Vault' })
      .getByRole('button', { name: /^Search/ })
      .first()
      .click();
    await palette.waitFor({ timeout: 5_000 }).catch(() => undefined);
  }
  // Filled rather than typed: keystrokes sent while the palette is still taking
  // the focus land wherever the focus was, and the search never hears them.
  await palette
    .getByLabel('Search the vault')
    .fill(words)
    .catch(() => console.warn(`search: the field was not there to fill with ${words}`));
  // A search that finds nothing is reported by the caller's `open`.
  await palette
    .getByRole('option')
    .first()
    .waitFor({ timeout: 10_000 })
    .catch(() => undefined);
  return palette;
}

/** Through the search palette: the sidebar tree is virtualized, so a row may not be there. */
export async function openBySearch(
  page: Page,
  { words, name }: { words: string; name: RegExp },
): Promise<boolean> {
  const palette = await search(page, words);
  if (!(await open(`${words} (search)`, [palette.getByRole('option', { name })]))) {
    await page.keyboard.press('Escape');
    return false;
  }
  // The page is up once its heading is; the camera waits for that state.
  await page
    .getByLabel('Note', { exact: true })
    .getByRole('heading', { level: 1 })
    .first()
    .waitFor({ timeout: 10_000 })
    .catch(() => console.warn(`${words}: opened, but its page never showed`));
  return true;
}

export function view(page: Page, name: string): Locator[] {
  return [
    sidebarSection(page, 'views').getByRole('button', { name, exact: true }),
    page.getByRole('navigation').getByRole('button', { name, exact: true }),
  ];
}
