/**
 * Two simulated Macs sharing one bare remote, synced by the real `syncNow`
 * running the Mac's real git (with the host's fixed prefix and ceiling) over
 * the real disk. The invariant under attack (U-29): no note, attachment or
 * setting is ever lost or left holding conflict markers, and every divergent
 * version survives somewhere visible.
 *
 * Deterministic: a fixed clock, fixed Mac names, an isolated HOME, no sleeps.
 * A "kill" is a step that never returns: the sync is abandoned there, exactly
 * as a quit would leave it, and a fresh sync is run over what it left.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  isolatedWorld,
  killPoint,
  macAt,
  MARKERS,
  must,
  realFs,
  realGit,
  refuseFilesOverGitHubsLimit,
  sh,
  texts,
  TIMEOUT,
  twoMacs,
  vaultFsOf,
  type Env,
} from './two-macs.harness.ts';

describe('two Macs, one remote: what already holds', () => {
  it(
    'keeps both versions of a line both Macs changed, with no markers, on the Mac that merges',
    async () => {
      const { laptop } = await bothChange('Idea.md', {
        base: 'one\n',
        studio: 'one from Studio\n',
        laptop: 'one from Laptop\n',
      });
      const report = await laptop.sync();
      expect(report.conflicts).toHaveLength(1);
      await expectNoMarkers(laptop);
      await expectVersionsSurvive(laptop, ['one from Studio\n', 'one from Laptop\n']);
      expect(await laptop.read('Idea.md')).toBe('one from Laptop\n');
    },
    TIMEOUT,
  );

  it(
    'keeps both when one Mac turned a note to CRLF with a BOM and the other edited it in LF',
    async () => {
      const crlf = '﻿one\r\ntwo\r\n';
      const { laptop } = await bothChange('Idea.md', {
        base: 'one\ntwo\n',
        studio: crlf,
        laptop: 'one\ntwo changed\n',
      });
      await laptop.sync();
      await expectNoMarkers(laptop);
      await expectVersionsSurvive(laptop, [crlf, 'one\ntwo changed\n']);
    },
    TIMEOUT,
  );

  it(
    'keeps an edited note the other Mac deleted, both ways round',
    async () => {
      const world = await twoMacs({ 'A.md': 'a\n', 'B.md': 'b\n' });
      await world.studio.remove('A.md');
      await world.studio.write('B.md', 'b edited on Studio\n');
      await world.studio.sync();
      await world.laptop.write('A.md', 'a edited on Laptop\n');
      await world.laptop.remove('B.md');
      await world.laptop.sync();
      await expectNoMarkers(world.laptop);
      await expectVersionsSurvive(world.laptop, ['a edited on Laptop\n', 'b edited on Studio\n']);
    },
    TIMEOUT,
  );

  it(
    'carries an edit onto a note the other Mac renamed',
    async () => {
      const world = await twoMacs({ 'Old.md': 'first\nsecond\nthird\n' });
      await world.studio.move('Old.md', 'New.md');
      await world.studio.sync();
      await world.laptop.write('Old.md', 'first\nsecond edited\nthird\n');
      await world.laptop.sync();
      expect(await world.laptop.read('New.md')).toBe('first\nsecond edited\nthird\n');
    },
    TIMEOUT,
  );

  it(
    'keeps both versions of a binary attachment, byte for byte',
    async () => {
      const mine = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
      const theirs = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]);
      const { laptop } = await bothChange('Attachments/p.png', {
        base: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]),
        studio: mine,
        laptop: theirs,
      });
      await laptop.sync();
      await expectVersionsSurvive(laptop, [mine, theirs]);
    },
    TIMEOUT,
  );

  it(
    'keeps both versions of the settings, the copy out of .atlas',
    async () => {
      const { laptop } = await bothChange('.atlas/settings.md', {
        base: '---\nsyncInterval: 5\n---\n',
        studio: '---\nsyncInterval: 10\n---\n',
        laptop: '---\nsyncInterval: 15\n---\n',
      });
      await laptop.sync();
      await expectNoMarkers(laptop);
      await expectVersionsSurvive(laptop, [
        '---\nsyncInterval: 10\n---\n',
        '---\nsyncInterval: 15\n---\n',
      ]);
      const paths = [...(await laptop.files()).keys()];
      expect(paths.filter((p) => p.startsWith('.atlas/'))).toEqual(['.atlas/settings.md']);
    },
    TIMEOUT,
  );

  it(
    'keeps both notes when two Macs create the same accented name, one composed and one decomposed',
    async () => {
      const world = await twoMacs({ 'Other.md': 'o\n' });
      await world.studio.write('Café.md', 'decomposed, from Studio\n');
      await world.studio.sync();
      await world.laptop.write('Café.md', 'composed, from Laptop\n');
      await world.laptop.sync();
      await expectNoMarkers(world.laptop);
      await expectVersionsSurvive(world.laptop, [
        'decomposed, from Studio\n',
        'composed, from Laptop\n',
      ]);
    },
    TIMEOUT,
  );

  it(
    'settles a conflict on a conflict copy both Macs already had',
    async () => {
      const copy = 'Idea (conflict from Old Mac).md';
      const { laptop } = await bothChange(copy, {
        base: 'x\n',
        studio: 'x from Studio\n',
        laptop: 'x from Laptop\n',
      });
      await laptop.sync();
      await expectNoMarkers(laptop);
      await expectVersionsSurvive(laptop, ['x from Studio\n', 'x from Laptop\n']);
    },
    TIMEOUT,
  );

  it(
    'resumes a sync the app quit between the merge and settling it',
    async () => {
      const { laptop } = await bothChange('Idea.md', {
        base: 'one\n',
        studio: 'one from Studio\n',
        laptop: 'one from Laptop\n',
      });
      const kill = killPoint();
      void laptop.sync({ git: { remoteSubject: () => kill.hang() } });
      await kill.hit;
      await laptop.sync();
      await expectNoMarkers(laptop);
      await expectVersionsSurvive(laptop, ['one from Studio\n', 'one from Laptop\n']);
    },
    TIMEOUT,
  );

  it(
    'recovers once a push that failed (the network gone) can reach the remote again',
    async () => {
      const world = await twoMacs({ 'A.md': 'a\n' });
      await world.studio.write('A.md', 'a on Studio\n');
      await expect(
        world.studio.sync({
          git: { push: async () => ({ code: 128, stdout: '', stderr: 'fatal: unable to access' }) },
        }),
      ).rejects.toThrow();
      await world.studio.sync();
      await world.laptop.sync();
      expect(await world.laptop.read('A.md')).toBe('a on Studio\n');
    },
    TIMEOUT,
  );
});

describe('two Macs, one remote: what breaks', () => {
  it(
    'keeps both notes when two Macs create the same name in a different case',
    async () => {
      const world = await twoMacs({ 'Other.md': 'o\n' });
      await world.studio.write('Idea.md', 'Idea as Studio wrote it\n');
      await world.studio.sync();
      await world.laptop.write('idea.md', 'idea as Laptop wrote it\n');
      await world.laptop.sync();
      await world.laptop.sync();
      await expectVersionsSurvive(world.laptop, [
        'Idea as Studio wrote it\n',
        'idea as Laptop wrote it\n',
      ]);
    },
    TIMEOUT,
  );

  it(
    'takes a case-only rename on one Mac to the other',
    async () => {
      const world = await twoMacs({ 'note.md': 'n\n' });
      await world.studio.move('note.md', 'Note.md');
      await world.studio.sync();
      await world.laptop.sync();
      const names = await readdir(world.laptop.root);
      expect(names).toContain('Note.md');
    },
    TIMEOUT,
  );

  it(
    'leaves no hold file and no markers after a quit while this Mac’s note was held aside',
    async () => {
      const { laptop } = await bothChange('Idea.md', {
        base: 'one\n',
        studio: 'one from Studio\n',
        laptop: 'one from Laptop\n',
      });
      const kill = killPoint();
      void laptop.sync({ git: { checkout: () => kill.hang() } });
      await kill.hit;
      await laptop.sync().catch(() => undefined);
      await expectNoMarkers(laptop);
      expect(await laptop.read('Idea.md').catch(() => null)).toBe('one from Laptop\n');
      await expectVersionsSurvive(laptop, ['one from Studio\n', 'one from Laptop\n']);
    },
    TIMEOUT,
  );

  it(
    'still syncs after a quit while this Mac’s note was held aside',
    async () => {
      const { laptop } = await bothChange('Idea.md', {
        base: 'one\n',
        studio: 'one from Studio\n',
        laptop: 'one from Laptop\n',
      });
      const kill = killPoint();
      void laptop.sync({ git: { checkout: () => kill.hang() } });
      await kill.hit;
      await expect(laptop.sync()).resolves.toMatchObject({ pushed: true });
    },
    TIMEOUT,
  );

  it(
    'keeps this Mac’s version in place after a quit between writing the other side and moving it to its copy',
    async () => {
      const { laptop } = await bothChange('Idea.md', {
        base: 'one\n',
        studio: 'one from Studio\n',
        laptop: 'one from Laptop\n',
      });
      // A29-01 settles from git's index: the other side is staged under the
      // copy's name, then written from there. The quit is between the two —
      // the point the first version of this test reached as the second move
      // of the file it used to hold aside, a step the settle no longer takes.
      const kill = killPoint();
      void laptop.sync({ git: { writeFromIndex: () => kill.hang() } });
      await kill.hit;
      await laptop.sync();
      await expectNoMarkers(laptop);
      expect(await laptop.read('Idea.md')).toBe('one from Laptop\n');
      await expectVersionsSurvive(laptop, ['one from Studio\n', 'one from Laptop\n']);
    },
    TIMEOUT,
  );

  it(
    'keeps what was typed below the markers a quit left in a note',
    async () => {
      const { laptop } = await bothChange('Idea.md', {
        base: 'one\n',
        studio: 'one from Studio\n',
        laptop: 'one from Laptop\n',
      });
      const kill = killPoint();
      void laptop.sync({ git: { remoteSubject: () => kill.hang() } });
      await kill.hit;
      const marked = await laptop.read('Idea.md');
      expect(marked).toMatch(MARKERS);
      // The app reopens on the note as it is, and the person adds a paragraph.
      await laptop.write('Idea.md', `${marked}\nTyped after the restart.\n`);
      await laptop.sync();
      const all = [...(await texts(laptop)).values()].join('\n');
      expect(all).toContain('Typed after the restart.');
    },
    TIMEOUT,
  );

  it(
    'leaves no markers in a text attachment that is not UTF-8',
    async () => {
      const latin1 = (text: string) => Buffer.from(text, 'latin1');
      const { laptop } = await bothChange('Data/prices.csv', {
        base: latin1('item,price\ncafé,1\n'),
        studio: latin1('item,price\ncafé,2\n'),
        laptop: latin1('item,price\ncafé,3\n'),
      });
      await laptop.sync();
      await expectNoMarkers(laptop);
      await expectVersionsSurvive(laptop, [
        latin1('item,price\ncafé,2\n'),
        latin1('item,price\ncafé,3\n'),
      ]);
    },
    TIMEOUT,
  );

  it(
    'leaves no markers in a note larger than the host reads as text',
    async () => {
      const body = 'a line of a long imported transcript\n'.repeat(300_000); // ~11 MB
      const { laptop } = await bothChange('Transcript.md', {
        base: `head\n${body}`,
        studio: `head from Studio\n${body}`,
        laptop: `head from Laptop\n${body}`,
      });
      await laptop.sync();
      await expectNoMarkers(laptop);
      expect((await laptop.read('Transcript.md')).startsWith('head from Laptop\n')).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'settles a conflict on a file whose name holds a backslash',
    async () => {
      const { laptop } = await bothChange('Yes\\No.md', {
        base: 'x\n',
        studio: 'x from Studio\n',
        laptop: 'x from Laptop\n',
      });
      await laptop.sync().catch(() => undefined);
      await expectNoMarkers(laptop);
      await expectVersionsSurvive(laptop, ['x from Studio\n', 'x from Laptop\n']);
    },
    TIMEOUT,
  );

  // A29-01 decided a folder that is a repository of its own is left out, with
  // a warning: git would commit it as a bare pointer (a gitlink) the other Mac
  // cannot open, and `add` refuses the files inside it one by one. The first
  // version of this test asked for its notes to sync, which git cannot do.
  it(
    'leaves a folder of the vault that is a git repository of its own out of sync, says so, and syncs the rest',
    async () => {
      const world = await twoMacs({ 'A.md': 'a\n' });
      await world.studio.write('Projects/site/readme.md', 'the site project notes\n');
      // A project cloned into the vault: a repository with history of its own.
      const site = join(world.studio.root, 'Projects/site');
      await must(site, ['init', '--quiet'], world.env);
      await must(site, ['add', '--all'], world.env);
      await must(
        site,
        ['-c', 'user.name=s', '-c', 'user.email=s@x', 'commit', '--quiet', '-m', 's'],
        world.env,
      );
      await world.studio.write('A.md', 'a, beside the project\n');
      await expect(world.studio.sync()).resolves.toMatchObject({ pushed: true });
      expect(world.studio.activity.join('\n')).toMatch(/warning: .*Projects\/site/);
      const pushed = await must(
        world.base,
        ['--git-dir', world.bare, 'ls-tree', '-r', 'main'],
        world.env,
      );
      expect(pushed).not.toContain('Projects/site');
      expect(pushed).not.toMatch(/^160000 /m);
      await world.laptop.sync();
      expect(await world.laptop.read('A.md')).toBe('a, beside the project\n');
      await expectVersionsSurvive(world.studio, ['the site project notes\n']);
    },
    TIMEOUT,
  );

  it(
    'never commits a file over GitHub’s size limit, says so, and syncs the rest',
    async () => {
      const world = await twoMacs({ 'A.md': 'a\n' });
      await refuseFilesOverGitHubsLimit(world.bare);
      await world.studio.write('Attachments/talk.mov', new Uint8Array(101 * 1024 * 1024));
      await world.studio.write('A.md', 'a, written the same day\n');
      await expect(world.studio.sync()).resolves.toMatchObject({ pushed: true });
      expect(world.studio.activity.join('\n')).toMatch(/warning: .*Attachments\/talk\.mov/);
      await world.laptop.sync();
      expect(await world.laptop.read('A.md')).toBe('a, written the same day\n');
      expect([...(await world.laptop.files()).keys()]).not.toContain('Attachments/talk.mov');
      // Still on the Mac it was made on: not synced is not deleted.
      expect([...(await world.studio.files()).keys()]).toContain('Attachments/talk.mov');
      // And the next sync, with nothing new, is quiet about it and still works.
      await expect(world.studio.sync()).resolves.toMatchObject({ committed: false });
    },
    TIMEOUT,
  );

  it(
    'recovers a vault whose unpushed history already holds a file over GitHub’s limit',
    async () => {
      const world = await twoMacs({ 'A.md': 'a\n' });
      await refuseFilesOverGitHubsLimit(world.bare);
      // Committed before Atlas kept such files out (or by hand), and never pushed.
      await world.studio.write('Attachments/talk.mov', new Uint8Array(101 * 1024 * 1024));
      await world.studio.write('A.md', 'a, written the same day\n');
      await must(world.studio.root, ['add', '--all'], world.env);
      await must(
        world.studio.root,
        ['-c', 'user.name=o', '-c', 'user.email=o@x', 'commit', '--quiet', '-m', 'big'],
        world.env,
      );
      await expect(world.studio.sync()).resolves.toMatchObject({ pushed: true });
      expect(world.studio.activity.join('\n')).toMatch(/warning: .*Attachments\/talk\.mov/);
      await world.laptop.sync();
      expect(await world.laptop.read('A.md')).toBe('a, written the same day\n');
      expect([...(await world.laptop.files()).keys()]).not.toContain('Attachments/talk.mov');
      expect([...(await world.studio.files()).keys()]).toContain('Attachments/talk.mov');
    },
    TIMEOUT,
  );

  it(
    'keeps the last synced version of a file that grew past GitHub’s limit',
    async () => {
      const world = await twoMacs({ 'A.md': 'a\n', 'Data/dump.bin': 'small\n' });
      await refuseFilesOverGitHubsLimit(world.bare);
      await world.studio.write('Data/dump.bin', new Uint8Array(101 * 1024 * 1024));
      await world.studio.write('A.md', 'a, written the same day\n');
      await expect(world.studio.sync()).resolves.toMatchObject({ pushed: true });
      expect(world.studio.activity.join('\n')).toMatch(/warning: .*Data\/dump\.bin/);
      await world.laptop.sync();
      expect(await world.laptop.read('A.md')).toBe('a, written the same day\n');
      expect(await world.laptop.read('Data/dump.bin')).toBe('small\n');
    },
    TIMEOUT,
  );

  it(
    'keeps a note’s line endings byte for byte on a Mac whose git turns CRLF to LF',
    async () => {
      const mixed = 'first\r\nsecond\nthird\r\n';
      const world = await twoMacs({ 'A.md': 'a\n' }, { gitconfig: '[core]\n\tautocrlf = true\n' });
      await world.studio.write('Mixed.md', mixed);
      await world.studio.sync();
      await world.laptop.sync();
      expect((await world.laptop.files()).get('Mixed.md')?.toString('latin1')).toBe(mixed);
    },
    TIMEOUT,
  );

  it(
    'syncs a file the Mac’s own excludes file (core.excludesFile) names',
    async () => {
      const world = await twoMacs(
        { 'A.md': 'a\n' },
        { gitconfig: '[core]\n\texcludesFile = ~/.my-ignores\n' },
      );
      await writeFile(join(world.home, '.my-ignores'), '*.pdf\nPapers/\n');
      await world.studio.write('Papers/reading.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      await world.studio.sync();
      await world.laptop.sync();
      expect([...(await world.laptop.files()).keys()]).toContain('Papers/reading.pdf');
    },
    TIMEOUT,
  );

  it(
    'syncs an attachment the Mac’s global gitignore names',
    async () => {
      const world = await twoMacs({ 'A.md': 'a\n' });
      // A developer's everyday global ignore (~/.config/git/ignore), which git reads with no setting.
      await mkdir(join(world.home, '.config', 'git'), { recursive: true });
      await writeFile(join(world.home, '.config', 'git', 'ignore'), '*.log\n*.zip\n*.sqlite\n');
      await world.studio.write('Attachments/export.zip', new Uint8Array([0x50, 0x4b, 3, 4]));
      await world.studio.write('Logs/2026-09.log', 'what happened in September\n');
      await world.studio.sync();
      await world.laptop.sync();
      const paths = [...(await world.laptop.files()).keys()];
      expect(paths).toEqual(expect.arrayContaining(['Attachments/export.zip', 'Logs/2026-09.log']));
    },
    TIMEOUT,
  );

  it(
    'syncs on a Mac whose git signs every commit',
    async () => {
      const world = await twoMacs(
        { 'A.md': 'a\n' },
        { gitconfig: '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /nonexistent/gpg\n' },
      );
      await world.studio.write('A.md', 'a edited\n');
      await expect(world.studio.sync()).resolves.toMatchObject({ committed: true, pushed: true });
    },
    TIMEOUT,
  );

  it(
    'merges the other Mac’s changes on a Mac whose git only fast-forwards',
    async () => {
      const world = await twoMacs(
        { 'A.md': 'a\n', 'B.md': 'b\n' },
        { gitconfig: '[merge]\n\tff = only\n' },
      );
      await world.studio.write('A.md', 'a on Studio\n');
      await world.studio.sync();
      await world.laptop.write('B.md', 'b on Laptop\n');
      await expect(world.laptop.sync()).resolves.toMatchObject({ pulled: true, pushed: true });
    },
    TIMEOUT,
  );

  it(
    'merges the other Mac’s changes as DFAI on a Mac whose git has no identity and cannot guess one (#87)',
    async () => {
      // A Mac's hostname makes git's guess work; `useConfigOnly` stands in for
      // a domainless host, where git refuses to guess, without leaning on this one's.
      const world = await twoMacs(
        { 'A.md': 'a\n', 'B.md': 'b\n' },
        { gitconfig: '[user]\n\tuseConfigOnly = true\n' },
      );
      await world.studio.write('A.md', 'a on Studio\n');
      await world.studio.sync();
      await world.laptop.write('B.md', 'b on Laptop\n');
      await expect(world.laptop.sync()).resolves.toMatchObject({ pulled: true, pushed: true });
      const merge = await must(
        world.laptop.root,
        ['log', '-1', '--merges', '--format=%an <%ae>%x00%cn <%ce>'],
        world.env,
      );
      const atlas = 'DFAI on Laptop <dfai@laptop.local>';
      expect(merge.trim().split('\0')).toEqual([atlas, atlas]);
    },
    TIMEOUT,
  );
});

describe('setting up and inspecting sync against real repositories', () => {
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

  it(
    'brings in the notes of an existing repository whose branch is master',
    async () => {
      const { base, env, bare, trash } = await isolatedWorld();
      await must(base, ['init', '--quiet', '--bare', '--initial-branch=master', bare], env);
      const old = join(base, 'Old Mac', 'vault');
      await mkdir(old, { recursive: true });
      await must(old, ['init', '--quiet', '--initial-branch=master'], env);
      await writeFile(join(old, 'Kept for years.md'), 'notes from before DFAI\n');
      await must(old, ['add', '--all'], env);
      await must(
        old,
        ['-c', 'user.name=o', '-c', 'user.email=o@x', 'commit', '--quiet', '-m', 'old'],
        env,
      );
      await must(old, ['remote', 'add', 'origin', bare], env);
      await must(old, ['push', '--quiet', '-u', 'origin', 'HEAD'], env);

      const root = join(base, 'Studio', 'vault');
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'New.md'), 'new\n');
      const studio = macAt({ name: 'Studio', root, env, trash });
      const settings = createSettingsWriter({ fs: vaultFsOf(studio), markdown: remarkMarkdown });
      await setUpSync({
        ports: {
          git: studio.git,
          folders: folders(env),
          fs: studio.fs,
          files: studio.syncFiles,
          markdown: remarkMarkdown,
          unsaved: { flushAll: async () => {} },
          activity: { record: () => {} },
          settings,
          readSettings: () => readVaultSettings({ fs: studio.fs, markdown: remarkMarkdown }),
          readSettingsCopy: (path) =>
            readVaultSettings({ fs: studio.fs, markdown: remarkMarkdown, path }),
        },
        vaultRoot: root,
        remote: { kind: 'existing', url: bare },
        mac: { name: 'Studio', id: 'mac-studio' },
        clock,
      });
      const paths = [...(await studio.files()).keys()];
      expect(paths).toContain('Kept for years.md');
      expect(await must(root, ['symbolic-ref', '--short', 'HEAD'], env)).toBe('master\n');
      // Set up by DFAI, it reads as set up, and the next sync still works.
      const setup = await inspectSync({
        git: studio.git,
        folders: folders(env),
        fs: studio.fs,
        markdown: remarkMarkdown,
        vaultRoot: root,
      });
      expect(setup.kind).toBe('set-up');
      await expect(studio.sync()).resolves.toMatchObject({ pushed: true });
      const pushed = await must(base, ['--git-dir', bare, 'ls-tree', '--name-only', 'master'], env);
      expect(pushed.split('\n')).toEqual(expect.arrayContaining(['Kept for years.md', 'New.md']));
    },
    TIMEOUT,
  );

  it(
    'does not take a repository DFAI never set up for a synced vault just because it has an origin',
    async () => {
      // A code project, or an Obsidian vault kept with obsidian-git, opened as a
      // vault. Saying it is set up makes DFAI commit everything in it and push,
      // on open, with nobody having asked.
      const { base, env, bare } = await isolatedWorld();
      await must(base, ['init', '--quiet', '--bare', '--initial-branch=main', bare], env);
      const root = join(base, 'project');
      await mkdir(root);
      await must(root, ['init', '--quiet', '--initial-branch=main'], env);
      await must(root, ['remote', 'add', 'origin', bare], env);
      await writeFile(join(root, 'README.md'), 'work in progress\n');
      const setup = await inspectSync({
        git: realGit(root, env),
        folders: folders(env),
        fs: realFs(root, base),
        markdown: remarkMarkdown,
        vaultRoot: root,
      });
      expect(setup.kind).not.toBe('set-up');
    },
    TIMEOUT,
  );

  it(
    'does not take an obsidian-git vault with its own .gitignore and settings for one DFAI set up',
    async () => {
      const { base, env, bare } = await isolatedWorld();
      await must(base, ['init', '--quiet', '--bare', '--initial-branch=main', bare], env);
      const root = join(base, 'Obsidian vault');
      await mkdir(join(root, '.atlas'), { recursive: true });
      await must(root, ['init', '--quiet', '--initial-branch=main'], env);
      await must(root, ['remote', 'add', 'origin', bare], env);
      await writeFile(join(root, '.gitignore'), '.obsidian/workspace.json\n');
      await writeFile(join(root, '.atlas', 'settings.md'), '---\ntheme: dark\n---\n');
      const setup = await inspectSync({
        git: realGit(root, env),
        folders: folders(env),
        fs: realFs(root, base),
        markdown: remarkMarkdown,
        vaultRoot: root,
      });
      expect(setup.kind).toBe('not-set-up');
    },
    TIMEOUT,
  );

  // Review A29-01 [H1]: creating a new repository committed everything before
  // anything was left out, so a large file stopped every push, for good.
  it(
    'creates a new repository without files over GitHub’s limit or folders that are repositories of their own',
    async () => {
      const { base, env, trash } = await isolatedWorld();
      const root = join(base, 'Studio', 'vault');
      await mkdir(join(root, 'Projects', 'site'), { recursive: true });
      await writeFile(join(root, 'Idea.md'), 'an idea\n');
      await writeFile(join(root, 'talk.mov'), new Uint8Array(101 * 1024 * 1024));
      await writeFile(join(root, 'Projects', 'site', 'readme.md'), 'the site\n');
      await must(join(root, 'Projects', 'site'), ['init', '--quiet'], env);
      const github = join(base, 'github');
      const studio = macAt({ name: 'Studio', root, env, trash, github });
      const settings = createSettingsWriter({ fs: vaultFsOf(studio), markdown: remarkMarkdown });
      await expect(
        setUpSync({
          ports: {
            git: studio.git,
            folders: folders(env),
            fs: studio.fs,
            files: studio.syncFiles,
            markdown: remarkMarkdown,
            unsaved: { flushAll: async () => {} },
            activity: { record: (line) => studio.activity.push(`${line.level}: ${line.message}`) },
            settings,
            readSettings: () => readVaultSettings({ fs: studio.fs, markdown: remarkMarkdown }),
            readSettingsCopy: (path) =>
              readVaultSettings({ fs: studio.fs, markdown: remarkMarkdown, path }),
          },
          vaultRoot: root,
          remote: { kind: 'new-github', name: 'vault' },
          mac: { name: 'Studio', id: 'mac-studio' },
          clock,
        }),
      ).resolves.toMatchObject({ notSynced: expect.arrayContaining(['talk.mov']) });
      const bare = join(github, 'vault.git');
      const pushed = await must(base, ['--git-dir', bare, 'ls-tree', '-r', 'main'], env);
      expect(pushed).toContain('Idea.md');
      expect(pushed).not.toContain('talk.mov');
      expect(pushed).not.toContain('Projects/site');
      expect(studio.activity.join('\n')).toMatch(/warning: talk\.mov is over GitHub/);
      await writeFile(join(root, 'Idea.md'), 'an idea, later\n');
      await expect(studio.sync()).resolves.toMatchObject({ pushed: true });
    },
    TIMEOUT,
  );
});
