import { expect, test, type Page } from './fixtures.ts';
import { readdir } from 'node:fs/promises';
import { createVault, installHost, type FakeHost, type FakeVault } from './host.ts';

/**
 * Issue #5: the stub's `write_text_file` against two writes to one note at once.
 *
 * The Rust host's `write_text_file` is a synchronous command, so two of them
 * never interleave: the second sees the file the first wrote and is refused
 * when it names the time the note was read at before. The stub answers across
 * `await`s, and once let both writes pass that check and share one temporary
 * file — a write the host would refuse got through, and the note could end up
 * holding bytes neither writer sent. Every spec writes through this stub, so it
 * has to refuse exactly as the host does.
 */

const NOTE = 'race.md';
const FIRST = 'The first writer says a good deal more than the second one does.\n';
const SECOND = 'Second.\n';
const REFUSED = 'the note changed on disk since it was opened';

interface Settled {
  status: 'fulfilled' | 'rejected';
  message?: string;
}

async function openVault(page: Page): Promise<{ vault: FakeVault; host: FakeHost }> {
  const vault = await createVault();
  await vault.write(NOTE, 'As it was read.\n');
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

/**
 * Sends FIRST to `paths[0]` and SECOND to `paths[1]`, both naming the time the
 * note was read at, and lets them go together once both are inside the host.
 */
async function writeBothAtOnce(
  page: Page,
  host: FakeHost,
  paths: readonly [string, string],
): Promise<Settled[]> {
  const releases = [...new Set(paths)].map((path) => host.holdWrites(path));
  await page.evaluate(
    async ([[firstPath, secondPath], first, second]) => {
      const { invoke } = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__;
      const vaultRoot = ((await invoke('current_vault', {})) as { absolutePath: string })
        .absolutePath;
      const { modified } = (await invoke('read_text_file', { path: firstPath })) as {
        modified: number;
      };
      const write = (path: string, contents: string) =>
        invoke('write_text_file', { path, contents, expectedModified: modified, vault: vaultRoot });
      (window as unknown as { __race: Promise<unknown>[] }).__race = [
        write(firstPath, first),
        write(secondPath, second),
      ];
    },
    [paths, FIRST, SECOND] as const,
  );
  // Both are inside the host before either is let go, so neither has landed yet.
  await expect
    .poll(() => [...new Set(paths)].reduce((sum, path) => sum + host.writesTo(path), 0))
    .toBe(2);
  for (const release of releases) release();

  return page.evaluate(async () => {
    const results = await Promise.allSettled(
      (window as unknown as { __race: Promise<unknown>[] }).__race,
    );
    return results.map((result) =>
      result.status === 'fulfilled'
        ? { status: result.status }
        : // The host rejects with the string its `Err` held, as Tauri hands it over.
          { status: result.status, message: String(result.reason) },
    );
  });
}

/** One write landed whole, the other was refused as the host refuses it, and nothing was left behind. */
async function expectOneLandedOneRefused(vault: FakeVault, settled: readonly Settled[]) {
  const landed = settled.flatMap((result, index) =>
    result.status === 'fulfilled' ? [index === 0 ? FIRST : SECOND] : [],
  );
  const refusals = settled.filter((result) => result.status === 'rejected');
  expect(landed).toHaveLength(1);
  expect(refusals).toHaveLength(1);
  expect(refusals[0]?.message).toContain(REFUSED);
  expect(await vault.read(NOTE)).toBe(landed[0]);
  expect((await readdir(vault.root)).filter((name) => name.includes('atlas-tmp'))).toEqual([]);
}

test('two writes to one note at once: one lands whole, the other is refused', async ({ page }) => {
  const { vault, host } = await openVault(page);
  await expectOneLandedOneRefused(vault, await writeBothAtOnce(page, host, [NOTE, NOTE]));
});

test('two writes to one note under two spellings of its name: one is refused', async ({ page }) => {
  const { vault, host } = await openVault(page);
  // Only one file is under both names where the disk ignores case, as macOS's does by default.
  test.skip(!(await vault.exists('Race.md')), 'the temporary vault is on a case-sensitive disk');
  await expectOneLandedOneRefused(vault, await writeBothAtOnce(page, host, [NOTE, 'Race.md']));
});
