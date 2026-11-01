import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  emitVaultChanged,
  expectFile,
  installHost,
  type FakeHost,
  type FakeVault,
} from './host.ts';
import { gitIn, otherMac } from './git-host.ts';
import { makeTempFolder } from './temp-folders.ts';

/**
 * U-29: a vault synced between Macs through GitHub. The host's git is the
 * Mac's real git (e2e/git-host.ts), and "GitHub" a bare repository on disk,
 * so what a sync does to the files is what git does to them.
 */

const MARKERS = /^(<<<<<<<|=======|>>>>>>>)/m;
const SHOTS = join(process.cwd(), 'design/out/shots');

async function openVault(page: Page, vault: FakeVault): Promise<FakeHost> {
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return host;
}

const syncCard = (page: Page) => page.getByRole('region', { name: 'Sync' });

async function openSyncSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(syncCard(page)).toBeVisible();
}

/** Light or dark, through the sidebar's switch, as a person would. */
async function useTheme(page: Page, theme: 'light' | 'dark') {
  const current = () => page.evaluate(() => document.documentElement.dataset['theme']);
  // Written after the button renders (#695): wait for it before deciding to click.
  await expect(page.locator('html')).toHaveAttribute('data-theme', /^(light|dark)$/);
  if ((await current()) === theme) return;
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: `Switch to ${theme} theme`, exact: true }).click();
  await expect.poll(current).toBe(theme);
}

test('sets up sync with a private repository, then keeps both versions of a note two Macs changed', async ({
  page,
}) => {
  const vault = await createVault();
  await vault.write('Welcome.md', '# Welcome\n\nHello.\n');
  const host = await openVault(page, vault);
  await openSyncSettings(page);
  await expect(page.getByTestId('sync-status')).toHaveText('Not set up');
  await page.getByRole('button', { name: 'Set up sync with GitHub' }).click();
  await expect(page.getByTestId('sync-status')).toContainText('Synced at');

  // What reached "GitHub": the notes and the managed ignore file, named for this Mac.
  const remote = host.git.remote(basename(vault.root));
  const log = await gitIn(remote, ['log', '--format=%s', 'main'], host.git.env);
  expect(log.stdout).toContain('Atlas sync set up on Studio');
  await expectFile(vault, '.gitignore').toContain('.atlas-cache/');
  // DFAI's mark, and this Mac for the automations — by an id of its own, and its name to show.
  const settings = await readFile(join(vault.root, '.atlas/settings.md'), 'utf8');
  expect(settings).toContain('sync: github');
  expect(settings).toMatch(/^automationsMac: \S+$/m);
  expect(settings).toContain('automationsMacName: Studio');
  await expect(page.getByTestId('automations-mac')).toContainText('Studio runs them');

  // Another Mac and this one both change the note.
  const laptop = await otherMac(host.git, remote, 'Laptop');
  await writeFile(join(laptop.root, 'Welcome.md'), '# Welcome\n\nFrom the laptop.\n');
  await writeFile(join(laptop.root, 'Laptop only.md'), '# Laptop only\n');
  await laptop.commitAndPush('DFAI sync from Laptop 2026-09-28 10:00');
  await vault.write('Welcome.md', '# Welcome\n\nFrom the studio.\n');

  await syncCard(page).getByRole('button', { name: 'Sync now' }).click();
  const warning = syncCard(page).getByRole('status');
  await expect(warning).toContainText('Both Macs changed a file');
  await expect(warning).toContainText('Welcome (conflict from Laptop).md');

  // This Mac's version stays in place; the laptop's is beside it; no markers anywhere.
  await expectFile(vault, 'Welcome.md').toBe('# Welcome\n\nFrom the studio.\n');
  await expectFile(vault, 'Welcome (conflict from Laptop).md').toBe(
    '# Welcome\n\nFrom the laptop.\n',
  );
  await expectFile(vault, 'Laptop only.md').toBe('# Laptop only\n');
  for (const file of ['Welcome.md', 'Welcome (conflict from Laptop).md']) {
    expect(await vault.read(file)).not.toMatch(MARKERS);
  }
  // Settings is modal; behind it, the sidebar's light and the window's notice say the same.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Sync: 1 conflict' })).toBeVisible();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Both Macs changed Welcome.md' }),
  ).toBeVisible();

  // And the laptop gets both back.
  await laptop.pull();
  expect(await readFile(join(laptop.root, 'Welcome.md'), 'utf8')).toBe(
    '# Welcome\n\nFrom the studio.\n',
  );
  expect(await readFile(join(laptop.root, 'Welcome (conflict from Laptop).md'), 'utf8')).toBe(
    '# Welcome\n\nFrom the laptop.\n',
  );

  if (process.env['ATLAS_SHOTS'] === '1') {
    await mkdir(SHOTS, { recursive: true });
    for (const theme of ['light', 'dark'] as const) {
      await useTheme(page, theme);
      await openSyncSettings(page);
      await syncCard(page).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(SHOTS, `sync-conflict-${theme}.png`) });
      await syncCard(page).screenshot({ path: join(SHOTS, `sync-settings-${theme}.png`) });
    }
  }
});

test('refuses a vault inside another repository, and offers no way to set it up', async ({
  page,
}) => {
  const code = await makeTempFolder('atlas-e2e-code-');
  const init = await gitIn(code, ['init', '--quiet', '--initial-branch=main'], process.env);
  expect(init.code).toBe(0);
  const vault = await createVault();
  const inside = join(code, 'vault');
  await mkdir(inside);
  await writeFile(join(inside, 'Note.md'), '# Note\n');
  await openVault(page, { ...vault, root: inside });
  await openSyncSettings(page);
  await expect(page.getByTestId('sync-status')).toHaveText('Can’t sync this vault');
  await expect(syncCard(page).getByRole('alert')).toContainText('inside another git repository');
  await expect(page.getByRole('button', { name: 'Set up sync with GitHub' })).toHaveCount(0);
  expect(await readFile(join(inside, 'Note.md'), 'utf8')).toBe('# Note\n');
  expect((await gitIn(inside, ['status', '--porcelain'], process.env)).stdout).toContain('vault/');
});

test('opens a vault from GitHub into a folder of its name', async ({ page }) => {
  const vault = await createVault();
  await vault.write('Here.md', '# Here\n');
  const host = await openVault(page, vault);

  // A repository some other Mac filled.
  const seed = await makeTempFolder('atlas-e2e-seed-');
  const bare = join(seed, 'Team-Notes.git');
  await gitIn(seed, ['init', '--quiet', '--bare', '--initial-branch=main', bare], host.git.env);
  const laptop = await otherMac(host.git, bare, 'Laptop');
  await writeFile(join(laptop.root, 'From GitHub.md'), '# From GitHub\n');
  await laptop.commitAndPush('DFAI sync set up on Laptop');

  const parent = await makeTempFolder('atlas-e2e-clones-');
  host.offerFolder(parent);
  await page.getByRole('button', { name: basename(vault.root), exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open a vault from GitHub…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Open a vault from GitHub' });
  await dialog.getByRole('textbox', { name: 'Repository address' }).fill(bare);
  if (process.env['ATLAS_SHOTS'] === '1') {
    // Set directly: the sidebar's switch is behind the dialog, and the Escape
    // that `useTheme` presses would close it.
    await mkdir(SHOTS, { recursive: true });
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((chosen) => {
        document.documentElement.dataset['theme'] = chosen;
      }, theme);
      await page.screenshot({ path: join(SHOTS, `sync-open-from-github-${theme}.png`) });
    }
  }
  await dialog.getByRole('button', { name: 'Choose folder…' }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Team-Notes', exact: true })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'From GitHub' })).toBeVisible();
  expect(await readFile(join(parent, 'Team-Notes', 'From GitHub.md'), 'utf8')).toBe(
    '# From GitHub\n',
  );
});

// Issue #8: an empty repository "opened from GitHub" into the open vault became
// a folder inside it, and DFAI opened that empty folder in place of the vault.
test('refuses to copy a vault from GitHub into the vault that is open, and says where sync is set up', async ({
  page,
}) => {
  const vault = await createVault();
  await vault.write('Here.md', '# Here\n');
  const host = await openVault(page, vault);
  const seed = await makeTempFolder('atlas-e2e-seed-');
  const bare = join(seed, 'pkm-space.git');
  await gitIn(seed, ['init', '--quiet', '--bare', '--initial-branch=main', bare], host.git.env);

  host.offerFolder(vault.root);
  await page.getByRole('button', { name: basename(vault.root), exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open a vault from GitHub…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Open a vault from GitHub' });
  await dialog.getByRole('textbox', { name: 'Repository address' }).fill(bare);
  await dialog.getByRole('button', { name: 'Choose folder…' }).click();

  await expect(dialog.getByRole('alert')).toContainText('the vault you have open');
  await expect(dialog.getByRole('alert')).toContainText('Settings → Sync');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: basename(vault.root), exact: true })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'Here' })).toBeVisible();
  expect(await readdir(vault.root)).not.toContain('pkm-space');
});

/**
 * Closes Settings. Escape in the picker's search box clears the search
 * first, as a search field's Escape does; the next one closes the sheet.
 */
async function closeSettings(page: Page) {
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(async () => {
    await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0, { timeout: 500 });
  }).toPass();
}

/** The sidebar's sync light, whatever it says. */
const syncLight = (page: Page) => page.getByRole('button', { name: /^Sync: / });

/** The sidebar's light, cropped with the footer around it, in each theme. */
async function shootLight(page: Page, state: string) {
  if (process.env['ATLAS_SHOTS'] !== '1') return;
  await mkdir(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    await useTheme(page, theme);
    await page.locator('.sidebar-footer').screenshot({
      path: join(SHOTS, `sync-light-${state}-${theme}.png`),
    });
  }
}

test('picks a repository from the GitHub list, then sends and brings in changes by itself', async ({
  page,
}) => {
  const vault = await createVault();
  await vault.write('Welcome.md', '# Welcome\n\nHello.\n');
  const host = await installHost(page, vault);
  // Time the test moves on: the minute's look and the half-minute's send, without waiting.
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();

  // A repository James already has on GitHub, on master, that another Mac filled.
  const remote = await host.git.bareRepository('old-vault', 'master');
  const laptop = await otherMac(host.git, remote, 'Laptop');
  await writeFile(join(laptop.root, 'Kept for years.md'), '# Kept for years\n');
  await laptop.commitAndPush('notes from before DFAI');
  host.git.setRepositories([
    {
      name: 'notes-archive',
      nameWithOwner: 'james/notes-archive',
      defaultBranchRef: { name: 'main' },
      visibility: 'PUBLIC',
      url: host.git.remote('notes-archive'),
    },
    {
      name: 'old-vault',
      nameWithOwner: 'james/old-vault',
      defaultBranchRef: { name: 'master' },
      visibility: 'PRIVATE',
      url: remote,
    },
    {
      name: 'website',
      nameWithOwner: 'james/website',
      defaultBranchRef: { name: 'main' },
      visibility: 'PUBLIC',
      url: host.git.remote('website'),
    },
  ]);

  await openSyncSettings(page);
  const picker = syncCard(page).getByRole('region', { name: 'Your GitHub repositories' });
  await expect(picker.getByRole('listitem')).toHaveCount(3);
  await picker.getByRole('searchbox').fill('vault');
  await expect(picker.getByRole('listitem')).toHaveCount(1);
  await expect(picker.getByRole('listitem')).toContainText('james/old-vault');
  await expect(picker.getByRole('listitem')).toContainText('Private · master');
  if (process.env['ATLAS_SHOTS'] === '1') {
    await mkdir(SHOTS, { recursive: true });
    for (const theme of ['light', 'dark'] as const) {
      await closeSettings(page);
      await useTheme(page, theme);
      await openSyncSettings(page);
      await expect(picker.getByRole('listitem')).toHaveCount(3);
      await syncCard(page).screenshot({ path: join(SHOTS, `sync-picker-${theme}.png`) });
    }
    await picker.getByRole('searchbox').fill('vault');
  }
  await picker.getByRole('button', { name: 'Connect james/old-vault' }).click();
  await expect(page.getByTestId('sync-status')).toContainText('Synced at');

  // Connected on the repository's own branch: its notes came in, and this Mac's went up.
  await expectFile(vault, 'Kept for years.md').toBe('# Kept for years\n');
  expect((await gitIn(vault.root, ['symbolic-ref', '--short', 'HEAD'], host.git.env)).stdout).toBe(
    'master\n',
  );
  expect((await gitIn(remote, ['show', 'master:Welcome.md'], host.git.env)).stdout).toBe(
    '# Welcome\n\nHello.\n',
  );
  await closeSettings(page);
  await expect(syncLight(page)).toHaveAccessibleName('Sync: Synced');
  await shootLight(page, 'synced');

  // Another Mac pushes; within the minute this one looks, and brings it in by itself.
  await laptop.pull();
  await writeFile(join(laptop.root, 'From the laptop.md'), '# From the laptop\n');
  await laptop.commitAndPush('DFAI sync from Laptop 2026-09-28 10:00');
  await page.clock.fastForward('01:05');
  await expectFile(vault, 'From the laptop.md').toBe('# From the laptop\n');
  await expect(page.getByRole('treeitem', { name: 'From the laptop' })).toBeVisible();

  // This Mac changes a note; half a minute later it is on GitHub, sent by itself.
  await vault.write('Welcome.md', '# Welcome\n\nEdited on the studio.\n');
  await emitVaultChanged(page, ['Welcome.md']);
  // The edit counts from when the index has taken it, which can land after a
  // jump of the clock made at once (#238). So the clock moves on ten seconds a
  // look, at most four times: the push must come within 40 s of the app's time.
  let moved = 0;
  await expect
    .poll(
      async () => {
        if (moved < 4) {
          moved += 1;
          await page.clock.fastForward('00:10');
        }
        return (await gitIn(remote, ['show', 'master:Welcome.md'], host.git.env)).stdout;
      },
      { intervals: [250], timeout: 15_000 },
    )
    .toBe('# Welcome\n\nEdited on the studio.\n');

  // Behind: changes wait on GitHub while this Mac has typing not yet sent.
  await openSyncSettings(page);
  const sendWhen = syncCard(page).getByRole('combobox', { name: 'When to send changes' });
  await sendWhen.selectOption('300');
  // The delay is the vault's setting: written before anything is timed by it.
  await expectFile(vault, '.atlas/settings.md').toContain('syncPushDelay: 300');
  await closeSettings(page);
  await laptop.pull();
  await writeFile(join(laptop.root, 'Later.md'), '# Later\n');
  await laptop.commitAndPush('DFAI sync from Laptop 2026-09-28 10:05');
  await vault.write('Welcome.md', '# Welcome\n\nStill typing.\n');
  await emitVaultChanged(page, ['Welcome.md']);
  // Counted as typing not yet sent only once the index has taken it (#238):
  // a look made before then finds nothing waiting here and brings the change
  // in, sending the typing with it (run 41206753224). The vault's search
  // finding the new words is the index having taken them.
  await page.keyboard.press('Meta+k');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('Still typing');
  await expect(page.getByRole('option', { name: /Welcome/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.clock.fastForward('01:05');
  // Says what the repositories and the vault hold, should this miss.
  try {
    await expect(syncLight(page)).toHaveAccessibleName('Sync: 1 change to bring in');
  } catch (cause) {
    const run = async (at: string, args: string[]) =>
      (await gitIn(at, args, host.git.env)).stdout.trim();
    throw new Error(
      [
        String(cause),
        `remote: ${await run(remote, ['log', '--oneline', '-4', 'master'])}`,
        `vault: ${await run(vault.root, ['log', '--oneline', '-4'])}`,
        `vault status: ${await run(vault.root, ['status', '--porcelain'])}`,
        `vault Welcome.md: ${await vault.read('Welcome.md')}`,
        `vault has Later.md: ${await vault.exists('Later.md')}`,
        `light: ${await syncLight(page).getAttribute('aria-label')}`,
      ].join('\n'),
      { cause },
    );
  }
  await shootLight(page, 'behind');

  // Syncing: a sync under way, held at its fetch.
  const release = host.git.hold('fetch');
  await syncLight(page).click();
  await syncCard(page).getByRole('button', { name: 'Sync now' }).click();
  await closeSettings(page);
  await expect(syncLight(page)).toHaveAccessibleName('Sync: Syncing…');
  await shootLight(page, 'syncing');
  release();
  await expect(syncLight(page)).toHaveAccessibleName('Sync: Synced');
  await expectFile(vault, 'Later.md').toBe('# Later\n');

  // Failed: GitHub out of reach.
  await rename(remote, `${remote}.away`);
  await syncLight(page).click();
  await syncCard(page).getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('sync-status')).toContainText('Last sync failed');
  await closeSettings(page);
  await expect(syncLight(page)).toHaveAccessibleName('Sync: Sync failed');
  await shootLight(page, 'failed');
  await rename(`${remote}.away`, remote);

  // Paused on this Mac: nothing is sent or brought in by itself.
  await syncLight(page).click();
  await syncCard(page).getByRole('switch', { name: 'Pause sync on this Mac' }).click();
  await expect(page.getByTestId('sync-status')).toHaveText('Paused on this Mac');
  await closeSettings(page);
  await expect(syncLight(page)).toHaveAccessibleName('Sync: Sync paused');
  await shootLight(page, 'paused');
  const before = (await gitIn(remote, ['rev-parse', 'master'], host.git.env)).stdout;
  await vault.write('Welcome.md', '# Welcome\n\nWritten while paused.\n');
  await emitVaultChanged(page, ['Welcome.md']);
  await page.clock.fastForward('06:00');
  expect((await gitIn(remote, ['rev-parse', 'master'], host.git.env)).stdout).toBe(before);
});
