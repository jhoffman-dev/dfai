/**
 * A sync, or setting one up, cut off at every step it takes (A29-01): the app
 * quits, or another vault opens and the host stops answering for this one.
 * Whatever step it stopped at, the next sync must leave the vault exactly as
 * an uninterrupted one would have — this Mac's version in place, the other's
 * beside it, no markers, nothing held aside — and still reach GitHub.
 *
 * Real git, real disk, one bare remote (the two-Mac harness). A "quit" is a
 * step that never returns, so the sync is abandoned exactly there.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSettingsWriter,
  inspectSync,
  readVaultSettings,
  setUpSync,
  type GitFoldersPort,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import {
  bothChange,
  clock,
  expectNoMarkers,
  expectVersionsSurvive,
  intercepted,
  isolatedWorld,
  killPoint,
  macAt,
  must,
  sh,
  twoMacs,
  vaultFsOf,
  type Env,
  type Intercept,
  type Mac,
} from './two-macs.harness.ts';

const LONG = 600_000;

/** Records each step a run takes, by `<port>.<method>`. */
function recorder(): { steps: string[]; intercept: Intercept } {
  const steps: string[] = [];
  return {
    steps,
    intercept: (step) => {
      steps.push(step);
      return null;
    },
  };
}

/** Quits at the `at`-th step (from 0); `hit` settles once it has. */
function quitAt(at: number) {
  const kill = killPoint();
  let taken = 0;
  const intercept: Intercept = () => (taken++ === at ? kill.hang() : null);
  return { hit: kill.hit, intercept };
}

interface Scenario {
  readonly name: string;
  /** Two Macs, with Laptop about to sync over what Studio already pushed. */
  make(): Promise<{ studio: Mac; laptop: Mac }>;
  /** Both Macs' versions, which must each survive whole. */
  readonly versions: readonly string[];
  /** What stays at the path both changed: Laptop's own version, or GitHub's spelling's. */
  readonly inPlace: { readonly path: string; readonly text: string };
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'both Macs changed a note',
    make: () =>
      bothChange('Idea.md', {
        base: 'one\n',
        studio: 'one from Studio\n',
        laptop: 'one from Laptop\n',
      }),
    versions: ['one from Studio\n', 'one from Laptop\n'],
    inPlace: { path: 'Idea.md', text: 'one from Laptop\n' },
  },
  {
    name: 'both Macs changed a setting under .atlas',
    make: () =>
      bothChange('.atlas/settings.md', {
        base: '---\nsyncInterval: 5\n---\n',
        studio: '---\nsyncInterval: 10\n---\n',
        laptop: '---\nsyncInterval: 15\n---\n',
      }),
    versions: ['---\nsyncInterval: 10\n---\n', '---\nsyncInterval: 15\n---\n'],
    inPlace: { path: '.atlas/settings.md', text: '---\nsyncInterval: 15\n---\n' },
  },
  {
    name: 'both Macs made the same name in a different case',
    make: async () => {
      const world = await twoMacs({ 'Other.md': 'o\n' });
      await world.studio.write('Idea.md', 'Idea as Studio wrote it\n');
      await world.studio.sync();
      await world.laptop.write('idea.md', 'idea as Laptop wrote it\n');
      return world;
    },
    versions: ['Idea as Studio wrote it\n', 'idea as Laptop wrote it\n'],
    inPlace: { path: 'Idea.md', text: 'Idea as Studio wrote it\n' },
  },
];

/** Every file on the Mac, by path, as text, for comparing two outcomes. */
async function outcome(mac: Mac): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const [path, bytes] of await mac.files()) files[path] = bytes.toString('latin1');
  return files;
}

describe('a sync cut off at every step', () => {
  for (const scenario of SCENARIOS) {
    it(
      `ends as an uninterrupted sync would when ${scenario.name}`,
      async () => {
        const clean = await scenario.make();
        const { steps, intercept } = recorder();
        const cleanReport = await clean.laptop.sync({ intercept });
        await expectNoMarkers(clean.laptop);
        await expectVersionsSurvive(clean.laptop, scenario.versions);
        expect(await clean.laptop.read(scenario.inPlace.path)).toBe(scenario.inPlace.text);
        expect(cleanReport.conflicts).toHaveLength(1);
        const expected = await outcome(clean.laptop);
        expect(steps.length).toBeGreaterThan(5);

        for (let at = 0; at < steps.length; at += 1) {
          const step = `step ${at} (${steps[at]})`;
          const { studio, laptop } = await scenario.make();
          const quit = quitAt(at);
          void laptop.sync({ intercept: quit.intercept });
          await quit.hit;
          // The quit sync never said what it did; the next one says it all
          // (review A29-01 [M2]): every copy made is noted, once.
          await expect(laptop.sync(), `the sync after a quit at ${step}`).resolves.toMatchObject({
            conflicts: cleanReport.conflicts,
          });
          await expectNoMarkers(laptop);
          await expectVersionsSurvive(laptop, scenario.versions);
          expect(await outcome(laptop), `Laptop's files after a quit at ${step}`).toEqual(expected);
          await studio.sync();
          await expectNoMarkers(studio);
          await expectVersionsSurvive(studio, scenario.versions);
        }
      },
      LONG,
    );
  }
});

describe('setting up sync cut off at every step', () => {
  function folders(env: Env): GitFoldersPort {
    return {
      pickCloneFolder: async () => null,
      topLevelOf: (folder) => sh(folder, ['rev-parse', '--show-toplevel'], env),
      clone: async () => ({ code: 1, stdout: '', stderr: 'not in tests' }),
      onDisk: async () => {
        throw new Error('not in tests');
      },
      branchesAt: async () => ({ code: 1, stdout: '', stderr: 'not in tests' }),
    };
  }

  /** A vault with a note, to be connected to an empty repository on "GitHub". */
  async function freshVault() {
    const world = await isolatedWorld();
    await must(
      world.base,
      ['init', '--quiet', '--bare', '--initial-branch=main', world.bare],
      world.env,
    );
    const root = join(world.base, 'Studio', 'vault');
    await mkdir(join(root, '.atlas'), { recursive: true });
    await writeFile(join(root, 'Idea.md'), 'an idea\n');
    await writeFile(join(root, '.atlas', 'settings.md'), '---\ntheme: dark\n---\n');
    const studio = macAt({ name: 'Studio', root, env: world.env, trash: world.trash });
    return { ...world, root, studio };
  }

  function setUp(
    vault: Awaited<ReturnType<typeof freshVault>>,
    intercept?: Intercept,
  ): ReturnType<typeof setUpSync> {
    const { studio, env, root, bare } = vault;
    const settings = createSettingsWriter({ fs: vaultFsOf(studio), markdown: remarkMarkdown });
    return setUpSync({
      ports: {
        git: intercepted(studio.git, 'git', intercept),
        folders: intercepted(folders(env), 'folders', intercept),
        fs: intercepted(studio.fs, 'fs', intercept),
        files: intercepted(studio.syncFiles, 'files', intercept),
        markdown: remarkMarkdown,
        unsaved: { flushAll: async () => {} },
        activity: { record: () => {} },
        settings: intercepted(settings, 'settings', intercept),
        readSettings: () => readVaultSettings({ fs: studio.fs, markdown: remarkMarkdown }),
        readSettingsCopy: (path) =>
          readVaultSettings({ fs: studio.fs, markdown: remarkMarkdown, path }),
      },
      vaultRoot: root,
      remote: { kind: 'existing', url: bare },
      mac: { name: 'Studio', id: 'mac-studio' },
      clock,
    });
  }

  it(
    'sets up cleanly the next time, whatever step the first try stopped at',
    async () => {
      const clean = await freshVault();
      const { steps, intercept } = recorder();
      await setUp(clean, intercept);

      for (let at = 0; at < steps.length; at += 1) {
        const step = `step ${at} (${steps[at]})`;
        const vault = await freshVault();
        const quit = quitAt(at);
        void setUp(vault, quit.intercept);
        await quit.hit;
        // Whether this try has anything left to push depends on how far the
        // first got; that it succeeds, and what GitHub then holds, does not.
        await expect(
          setUp(vault),
          `setting up again after a stop at ${step}`,
        ).resolves.toMatchObject({ conflicts: [] });
        const pushed = await must(
          vault.base,
          ['--git-dir', vault.bare, 'ls-tree', '-r', '--name-only', 'main'],
          vault.env,
        );
        expect(pushed.split('\n'), `what reached GitHub after a stop at ${step}`).toContain(
          'Idea.md',
        );
        const setup = await inspectSync({
          git: vault.studio.git,
          folders: folders(vault.env),
          fs: vault.studio.fs,
          markdown: remarkMarkdown,
          vaultRoot: vault.root,
        });
        expect(setup.kind, `how the vault reads after a stop at ${step}`).toBe('set-up');
      }
    },
    LONG,
  );

  /**
   * What the app does after a stop, as it opens the vault again: a vault
   * that reads as set up is synced; one that does not is set up again, as
   * the person would from Settings.
   */
  async function reopen(vault: Awaited<ReturnType<typeof freshVault>>) {
    const setup = await inspectSync({
      git: vault.studio.git,
      folders: folders(vault.env),
      fs: vault.studio.fs,
      markdown: remarkMarkdown,
      vaultRoot: vault.root,
    });
    return setup.kind === 'set-up' ? vault.studio.sync() : setUp(vault);
  }

  // Review A29-01 [M1]: connecting to a repository that already holds the
  // same note stops on a conflict; cut off there, the vault read as not set
  // up, so nothing ever finished the merge and connecting again was refused.
  it(
    'connects to a repository holding the same note, whatever step the first try stopped at',
    async () => {
      const seeded = async () => {
        const vault = await freshVault();
        const other = join(vault.base, 'Old Mac', 'vault');
        await mkdir(dirname(other), { recursive: true });
        await must(dirname(other), ['clone', '--quiet', '--', vault.bare, 'vault'], vault.env);
        await writeFile(join(other, 'Idea.md'), 'an idea, as GitHub has it\n');
        await must(other, ['add', '--all'], vault.env);
        await must(
          other,
          ['-c', 'user.name=o', '-c', 'user.email=o@x', 'commit', '--quiet', '-m', 'old'],
          vault.env,
        );
        await must(other, ['push', '--quiet', 'origin', 'HEAD'], vault.env);
        return vault;
      };
      const versions = ['an idea\n', 'an idea, as GitHub has it\n'];
      const clean = await seeded();
      const { steps, intercept } = recorder();
      await setUp(clean, intercept);
      await expectNoMarkers(clean.studio);
      await expectVersionsSurvive(clean.studio, versions);

      for (let at = 0; at < steps.length; at += 1) {
        const step = `step ${at} (${steps[at]})`;
        const vault = await seeded();
        const quit = quitAt(at);
        void setUp(vault, quit.intercept);
        await quit.hit;
        await expect(reopen(vault), `opening again after a stop at ${step}`).resolves.toBeDefined();
        await expectNoMarkers(vault.studio);
        await expectVersionsSurvive(vault.studio, versions);
        const setup = await inspectSync({
          git: vault.studio.git,
          folders: folders(vault.env),
          fs: vault.studio.fs,
          markdown: remarkMarkdown,
          vaultRoot: vault.root,
        });
        expect(setup.kind, `how the vault reads after a stop at ${step}`).toBe('set-up');
      }
    },
    LONG,
  );
});

describe('a copy the person edited before the sync that made it finished', () => {
  // Review A29-01 [L4]: the half-made copy was taken for someone else's file,
  // and every sync after stopped at "save the other Mac's version".
  it(
    'keeps the edit, the other Mac’s version and this Mac’s, and syncs on',
    async () => {
      const { laptop } = await bothChange('Idea.md', {
        base: 'one\n',
        studio: 'one from Studio\n',
        laptop: 'one from Laptop\n',
      });
      const kill = killPoint();
      let written = false;
      void laptop.sync({
        intercept: (step) => {
          if (step === 'git.writeFromIndex') written = true;
          return written && step === 'git.hashFile' ? kill.hang() : null;
        },
      });
      await kill.hit;
      await laptop.write('Idea (conflict from Studio).md', 'one from Studio, and a thought\n');
      await expect(laptop.sync()).resolves.toMatchObject({ pushed: true });
      await expectNoMarkers(laptop);
      await expectVersionsSurvive(laptop, [
        'one from Laptop\n',
        'one from Studio\n',
        'one from Studio, and a thought\n',
      ]);
    },
    LONG,
  );
});
