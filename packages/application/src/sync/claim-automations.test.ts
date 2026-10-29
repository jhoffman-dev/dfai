import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ClaimRefusal } from '@dfai/domain';
import { createSettingsWriter } from '../settings/settings-writer.ts';
import { fakeVaultFs } from '../testing/fake-ports.ts';
import { jsonMarkdown } from '../testing/settings-vault.ts';
import { claimAutomations } from './claim-automations.ts';

const PATH = '.atlas/settings.md';
const LAPTOP = { id: 'mac-laptop', name: 'Laptop' };
const markdown = jsonMarkdown();

/** A vault whose settings note holds `settings` (null: no note), behaving as the host does. */
function vaultHolding(settings: Record<string, unknown> | null) {
  const file = {
    text: settings === null ? null : `---\n${JSON.stringify(settings)}\n---\n`,
    modified: 1,
    writes: 0,
  };
  const fs = fakeVaultFs({
    readNotes: async (paths) =>
      file.text === null || !paths.includes(PATH)
        ? []
        : [{ path: PATH, text: file.text, modified: file.modified, size: 1 }],
    readTextFile: async () => ({ text: file.text ?? '', modified: file.modified }),
    writeTextFile: async ({ contents }) => {
      file.writes += 1;
      file.text = contents;
      file.modified += 1;
      return file.modified;
    },
    createNote: async ({ contents }) => {
      file.writes += 1;
      file.text = contents;
      return 0;
    },
  });
  const said = () => markdown.frontmatterProperties(file.text?.split('\n# ')[0] ?? null);
  return { fs, file, said, settings: createSettingsWriter({ fs, markdown }) };
}

const claim = (
  vault: ReturnType<typeof vaultHolding>,
  over: Partial<Parameters<typeof claimAutomations>[0]> = {},
) =>
  claimAutomations({
    ports: { settings: vault.settings, fs: vault.fs, markdown },
    mac: LAPTOP,
    syncs: true,
    stillOpen: () => true,
    ...over,
  });

const STUDIO_NAMED = { sync: 'github', automationsMac: 'mac-studio', automationsMacName: 'Studio' };

describe('claimAutomations (ADR-0035 part 2, #176)', () => {
  it('writes this Mac’s id and name through the settings writer, keeping every other setting', async () => {
    const vault = vaultHolding({ ...STUDIO_NAMED, syncInterval: 15 });

    // It says which Mac it took them from, for the banner's "not yet shared with Studio".
    await expect(claim(vault)).resolves.toEqual({ kind: 'claimed', was: 'Studio' });

    expect(vault.said()).toEqual({
      sync: 'github',
      syncInterval: 15,
      automationsMac: 'mac-laptop',
      automationsMacName: 'Laptop',
    });
    expect(vault.file.writes).toBe(1);
  });

  it('names this Mac in a vault whose settings named none', async () => {
    const vault = vaultHolding({ sync: 'github' });
    await expect(claim(vault)).resolves.toEqual({ kind: 'claimed', was: null });
    expect(vault.said()).toMatchObject({ automationsMac: 'mac-laptop' });
  });

  it('writes nothing when the settings already name this Mac, by id, though it was renamed since', async () => {
    const vault = vaultHolding({ automationsMac: 'mac-laptop', automationsMacName: 'Old laptop' });

    await expect(claim(vault)).resolves.toEqual({ kind: 'already-named' });

    expect(vault.file.writes).toBe(0);
    expect(vault.said()).toMatchObject({ automationsMacName: 'Old laptop' });
  });

  it('writes the claim though another Mac shares this one’s name: ids compare, never names', async () => {
    const vault = vaultHolding({ automationsMac: 'mac-other', automationsMacName: 'Laptop' });
    await expect(claim(vault)).resolves.toMatchObject({ kind: 'claimed' });
    expect(vault.said()).toMatchObject({ automationsMac: 'mac-laptop' });
  });

  describe('settings that cannot be read write nothing', () => {
    it('frontmatter that does not parse', async () => {
      const vault = vaultHolding(STUDIO_NAMED);
      vault.file.text = '---\n{ not json\n---\n';

      await expect(claim(vault)).resolves.toEqual({ kind: 'unreadable' });

      expect(vault.file.writes).toBe(0);
    });

    it('a synced vault with no settings note', async () => {
      const vault = vaultHolding(null);
      await expect(claim(vault)).resolves.toEqual({ kind: 'unreadable' });
      expect(vault.file.writes).toBe(0);
    });

    it('a read the host refuses', async () => {
      const vault = vaultHolding(STUDIO_NAMED);
      const fs = { ...vault.fs, readNotes: vi.fn().mockRejectedValue(new Error('denied')) };
      const outcome = await claimAutomations({
        ports: { settings: vault.settings, fs, markdown },
        mac: LAPTOP,
        syncs: true,
        stillOpen: () => true,
      });
      expect(outcome).toEqual({ kind: 'unreadable' });
      expect(vault.file.writes).toBe(0);
    });
  });

  it('says why a refused write named no Mac, and the settings stay as they were', async () => {
    const vault = vaultHolding(STUDIO_NAMED);
    const settings = { update: vi.fn().mockRejectedValue(new Error('the disk is full')) };

    const outcome = await claim(vault, { ports: { settings, fs: vault.fs, markdown } });

    expect(outcome).toEqual({ kind: 'write-failed', reason: 'the disk is full' });
    expect(vault.said()).toEqual(STUDIO_NAMED);
  });

  it('says a write that rejected with no Error as it was given', async () => {
    const vault = vaultHolding(STUDIO_NAMED);
    const settings = { update: vi.fn().mockRejectedValue('stale') };
    await expect(claim(vault, { ports: { settings, fs: vault.fs, markdown } })).resolves.toEqual({
      kind: 'write-failed',
      reason: 'stale',
    });
  });

  describe('"Process here" asks the gates first, and again right before the write', () => {
    it.each<ClaimRefusal>(['paused', 'failing', 'no-pull', 'pulling'])(
      'writes nothing while they say %s',
      async (why) => {
        const vault = vaultHolding(STUDIO_NAMED);
        const outcome = await claim(vault, { refusal: async () => why });
        expect(outcome).toEqual({ kind: 'refused', why });
        expect(vault.file.writes).toBe(0);
      },
    );

    it('is refused before the settings are read: a refusal is said, not settings it never read', async () => {
      const vault = vaultHolding(STUDIO_NAMED);
      vault.file.text = '---\n{ not json\n---\n';
      const outcome = await claim(vault, { refusal: async () => 'paused' });
      expect(outcome).toEqual({ kind: 'refused', why: 'paused' });
    });

    it('writes once they say nothing', async () => {
      const vault = vaultHolding(STUDIO_NAMED);
      const refusal = vi.fn(async (): Promise<ClaimRefusal | null> => null);
      await expect(claim(vault, { refusal })).resolves.toMatchObject({ kind: 'claimed' });
      expect(refusal).toHaveBeenCalledTimes(2);
    });

    it('writes nothing when a pull starts while the settings are read', async () => {
      const vault = vaultHolding(STUDIO_NAMED);
      const answers: (ClaimRefusal | null)[] = [null, 'pulling'];
      const outcome = await claim(vault, { refusal: async () => answers.shift() ?? null });
      expect(outcome).toEqual({ kind: 'refused', why: 'pulling' });
      expect(vault.file.writes).toBe(0);
    });

    it('is not asked at all for Settings → Sync, the person’s own move', async () => {
      const vault = vaultHolding(STUDIO_NAMED);
      await expect(claim(vault)).resolves.toMatchObject({ kind: 'claimed' });
    });
  });

  describe('a vault switched away from mid-claim writes nothing', () => {
    it('before the write is queued', async () => {
      const vault = vaultHolding(STUDIO_NAMED);
      let open = true;
      const refusal = async () => {
        open = false;
        return null;
      };
      const outcome = await claim(vault, { refusal, stillOpen: () => open });
      expect(outcome).toEqual({ kind: 'vault-closed' });
      expect(vault.file.writes).toBe(0);
    });

    it('while the write waits its turn behind another in the writer', async () => {
      const vault = vaultHolding(STUDIO_NAMED);
      let open = true;
      // A writer whose turn comes when the test says: the change is worked out then.
      let turn: (() => void) | null = null;
      const queued = {
        update: (change: Parameters<typeof vault.settings.update>[0]) =>
          new Promise<void>((resolve, reject) => {
            turn = () => {
              try {
                change({});
                resolve();
              } catch (cause) {
                reject(cause as Error);
              }
            };
          }),
      };
      const claimed = claim(vault, {
        ports: { settings: queued, fs: vault.fs, markdown },
        stillOpen: () => open,
      });
      await vi.waitFor(() => expect(turn).not.toBeNull());
      open = false;
      turn!();

      await expect(claimed).resolves.toEqual({ kind: 'vault-closed' });
      expect(vault.file.writes).toBe(0);
    });
  });

  it('two presses in a row write once and then find this Mac named', async () => {
    const vault = vaultHolding(STUDIO_NAMED);
    await expect(claim(vault)).resolves.toMatchObject({ kind: 'claimed' });
    await expect(claim(vault)).resolves.toEqual({ kind: 'already-named' });
    expect(vault.file.writes).toBe(1);
  });
});

describe('no other code path writes automationsMac (#176)', () => {
  const packagesRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const repoRoot = join(packagesRoot, '..');
  /** Every source file of the app's code, tests left out. */
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === 'node_modules' || name === 'dist' || name === 'src-tauri') return [];
      if (statSync(path).isDirectory()) return sources(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$|test-support|testing/.test(path) ? [path] : [];
    });
  /** The settings keys, as their constants or written out, or the set-up rule and the claim's keys. */
  const NAMES_A_MAC =
    /AUTOMATIONS_MAC_KEY|AUTOMATIONS_MAC_NAME_KEY|automationsHandover|claimedSettings\(|['"`]automationsMac(?:Name)?['"`]|\.(?:save|update)\([^;]*?\bautomationsMac(?:Name)?\s*:/s;
  const writers = [
    join(packagesRoot, 'domain/src'),
    join(packagesRoot, 'application/src'),
    join(packagesRoot, 'adapters/src'),
    join(packagesRoot, 'ui/src'),
    join(repoRoot, 'apps'),
  ]
    .flatMap(sources)
    .filter((path) => NAMES_A_MAC.test(readFileSync(path, 'utf8')))
    .map((path) => relative(repoRoot, path))
    .sort();

  it('catches the key written out, as an adapter or a save might write it (#630 review)', () => {
    expect(NAMES_A_MAC.test("settings.save({ 'automationsMac': id })")).toBe(true);
    expect(NAMES_A_MAC.test('settings.save({ automationsMac: id, x: 1 })')).toBe(true);
    expect(NAMES_A_MAC.test('await writer.update(() => ({\n  automationsMacName: name }))')).toBe(
      true,
    );
    expect(NAMES_A_MAC.test('settings.update({ automationsMacName: name })')).toBe(true);
    expect(NAMES_A_MAC.test('readonly automationsMac: string | null;')).toBe(false);
  });

  it('catches a save destructured off the settings, as use-sync.ts already calls it (PR #630 attack)', () => {
    // use-sync.ts: `const { save } = settings;` then `save({ pullIntervalMinutes: minutes })`.
    expect(NAMES_A_MAC.test('const { save } = settings;\nsave({ automationsMac: id })')).toBe(true);
    expect(NAMES_A_MAC.test('update(() => ({ automationsMacName: name }))')).toBe(true);
  });

  it('names the Mac only through the claim, and through set-up when no Mac is named yet', () => {
    expect(writers).toEqual([
      // The keys and the set-up rule are defined here, and only read by Settings → Sync.
      'packages/application/src/sync/claim-automations.ts',
      'packages/application/src/sync/set-up-sync.ts',
      'packages/application/src/sync/sync-settings.ts',
      'packages/domain/src/sync/automations-claim.ts',
      'packages/domain/src/sync/index.ts',
      'packages/domain/src/sync/sync-rules.ts',
    ]);
  });

  it('reads the keys in Settings → Sync, and never saves them', () => {
    const text = readFileSync(join(packagesRoot, 'application/src/sync/sync-settings.ts'), 'utf8');
    const save = text.slice(text.indexOf('export async function saveSyncSettings'));
    expect(save).not.toMatch(/AUTOMATIONS_MAC/);
  });
});
