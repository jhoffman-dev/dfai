import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { uploadedFiles, workflowProblems } from './web-hosting.ts';

/*
 * Adversarial probes of PR #700 (#662): the hosting checks against what
 * firebase-tools 15.28.2 actually uploads (lib/listFiles.js: glob `**\/*`,
 * dot + follow + nodir, its ignore list) and against workflows that deploy
 * or leak the key in ways the checker does not see. `it.fails` marks a hole:
 * the check passes something it exists to stop. The plain `it`s are probes
 * that held.
 */

const IGNORE = ['**/.*', '**/.*/**'];

describe('the file listing, against firebase-tools listFiles', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // The same walk the committed test's distFiles() does over apps/web/dist.
  const walk = (root: string) =>
    readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((path) => statSync(join(root, path)).isFile())
      .map((path) => path.split(sep).join('/'));

  it.fails(
    'catches a dot-folder shipped through a symlink to it (listFiles follows symlinks)',
    () => {
      // listFiles uploads `vitelink/m.json`: the bytes of `.vite/m.json` under a name with no dot.
      dir = mkdtempSync(join(tmpdir(), 'attack-700-'));
      mkdirSync(join(dir, '.vite'));
      writeFileSync(join(dir, '.vite', 'm.json'), '{}');
      writeFileSync(join(dir, 'index.html'), '');
      symlinkSync('.vite', join(dir, 'vitelink'));
      const uploaded = uploadedFiles(walk(dir), IGNORE);
      expect(uploaded).not.toContain('vitelink/m.json');
    },
  );

  it.fails('catches a symlink out of dist (listFiles uploads what it points at)', () => {
    dir = mkdtempSync(join(tmpdir(), 'attack-700-'));
    mkdirSync(join(dir, 'outside'));
    writeFileSync(join(dir, 'outside', 'id_rsa'), 'k');
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'index.html'), '');
    symlinkSync(join(dir, 'outside'), join(dir, 'dist', 'outlink'));
    const uploaded = uploadedFiles(walk(join(dir, 'dist')), IGNORE);
    expect(uploaded).not.toContain('outlink/id_rsa');
  });

  it.fails('reports a dotfile as uploaded when a negated ignore pattern is configured', () => {
    // glob drops `!` patterns from its ignore list, so listFiles uploads `.env`;
    // minimatch reads `!index.html` as "anything but index.html" and calls it skipped.
    expect(uploadedFiles(['index.html', '.env', '.vite/m.json'], ['!index.html'])).toEqual([
      'index.html',
      '.env',
      '.vite/m.json',
    ]);
  });

  it.fails('agrees with listFiles that "**/.*/**" alone also skips the dotfile itself', () => {
    // glob's ignore treats `x/**` as covering `x`; listFiles uploads neither `.env` nor `.vite/m.json`.
    expect(uploadedFiles(['index.html', '.env', '.vite/m.json'], ['**/.*/**'])).toEqual([
      'index.html',
    ]);
  });

  it('agrees with listFiles on the committed ignore for __MACOSX, .DS_Store, .env, maps and unicode', () => {
    const listing = [
      'index.html',
      '.DS_Store',
      '.env',
      '.hidden.map',
      'assets/i.js',
      'assets/i.js.map',
      '__MACOSX/x',
      '__MACOSX/assets/._i.js',
      'a/.git/config',
      'sub/firebase-debug.1.log',
      'ünï.txt',
    ];
    // What listFiles returned for the same tree on disk.
    expect(uploadedFiles(listing, IGNORE)).toEqual([
      'index.html',
      'assets/i.js',
      'assets/i.js.map',
      '__MACOSX/x',
      'ünï.txt',
    ]);
  });
});

describe('the workflow checker, against deploys it should refuse', () => {
  const CHECK = '      - run: pnpm exec vitest run tools/ci/web-hosting.test.ts\n';
  const step = (uses: string, extra = '') =>
    `      - uses: ${uses}\n        with:\n          firebaseServiceAccount: \${{ secrets.KEY }}\n          projectId: dailyflowai-app\n          target: web\n${extra}`;
  const DEPLOY = 'FirebaseExtended/action-hosting-deploy@abc';
  const preview = `  preview:\n    runs-on: ubuntu-latest\n    steps:\n${CHECK}${step(DEPLOY)}`;
  const live = `  live:\n    runs-on: ubuntu-latest\n    environment: web-live\n    steps:\n${CHECK}${step(DEPLOY, '          channelId: live\n')}`;
  const good = `jobs:\n${preview}${live}`;
  const withJob = (body: string) => `${good}  extra:\n    runs-on: ubuntu-latest\n${body}`;
  const withRun = (command: string) => withJob(`    steps:\n      - run: ${command}\n`);

  it('passes the good workflow (control)', () => {
    expect(workflowProblems(good)).toEqual([]);
  });

  it.each([
    ['two spaces', 'firebase  deploy'],
    ['a tab', 'firebase\tdeploy'],
    ['pnpm dlx', 'pnpm dlx firebase-tools deploy'],
  ])('refuses a bare deploy spelled with %s', (_what, command) => {
    expect(workflowProblems(withRun(command))).not.toEqual([]);
  });

  it.fails.each([
    ['a global flag before the verb', 'firebase --non-interactive deploy'],
    ['a quoted verb', 'firebase "deploy"'],
    ['a variable for the binary', '$FIREBASE deploy'],
    ['a line continuation', 'firebase \\\n          deploy'],
    ['a second --only, which wins', 'firebase deploy --only hosting:web --only hosting'],
    ['a script that deploys', 'pnpm run deploy:everything'],
  ])('refuses a bare deploy spelled with %s', (_what, command) => {
    expect(workflowProblems(withRun(command))).not.toEqual([]);
  });

  it.fails('refuses a command that takes down the project default site', () => {
    expect(
      workflowProblems(withRun('firebase hosting:disable --site dailyflowai-app')),
    ).not.toEqual([]);
  });

  it.fails('refuses a live deploy outside web-live when channelId is quoted', () => {
    const job = `    steps:\n${CHECK}${step(DEPLOY, '          channelId: "live"\n')}`;
    expect(workflowProblems(withJob(job))).toEqual([expect.stringContaining('web-live')]);
  });

  it.fails('refuses a live deploy outside web-live when channelId carries a comment', () => {
    const job = `    steps:\n${CHECK}${step(DEPLOY, '          channelId: live # go\n')}`;
    expect(workflowProblems(withJob(job))).toEqual([expect.stringContaining('web-live')]);
  });

  it.fails(
    'refuses a job that deploys live through a YAML alias of the live step, unchecked',
    () => {
      const anchored = live.replace('      - uses:', '      - &deploy\n        uses:');
      const text = `jobs:\n${preview}${anchored}  sneaky:\n    runs-on: ubuntu-latest\n    steps:\n      - *deploy\n`;
      expect(workflowProblems(text)).not.toEqual([]);
    },
  );

  it.fails('refuses a check that is only named, never run, before the deploy', () => {
    const job = `    environment: web-live\n    steps:\n      - name: pnpm exec vitest run tools/ci/web-hosting.test.ts\n        run: echo skipped\n${step(DEPLOY)}`;
    expect(workflowProblems(withJob(job))).toEqual([
      expect.stringContaining('without first running'),
    ]);
  });

  it.fails('refuses a check whose failure is ignored', () => {
    const job = `    steps:\n      - run: pnpm exec vitest run tools/ci/web-hosting.test.ts || true\n${step(DEPLOY)}`;
    expect(workflowProblems(withJob(job))).toEqual([
      expect.stringContaining('without first running'),
    ]);
  });

  it.fails(
    'refuses the key handed to an action-hosting-deploy that is not FirebaseExtended',
    () => {
      const job = `    steps:\n${CHECK}${step('attacker/action-hosting-deploy@v1')}`;
      expect(workflowProblems(withJob(job))).not.toEqual([]);
    },
  );

  it.fails('refuses the key handed to an unrelated action as firebaseServiceAccount', () => {
    const job = `    steps:\n      - uses: some/other-action@v1\n        with:\n          firebaseServiceAccount: \${{ secrets.KEY }}\n`;
    expect(workflowProblems(withJob(job))).toEqual([expect.stringContaining('hands a secret')]);
  });
});

describe('the workflow checker, against the key reaching a run step', () => {
  const good =
    'jobs:\n  preview:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm exec vitest run tools/ci/web-hosting.test.ts\n      - uses: FirebaseExtended/action-hosting-deploy@abc\n        with:\n          firebaseServiceAccount: ${{ secrets.KEY }}\n          projectId: dailyflowai-app\n          target: web\n';
  const runWithEnv = (envLine: string) =>
    `${good}  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm install\n        env:\n          ${envLine}\n`;

  it('refuses the key by name in a run step env (control)', () => {
    expect(workflowProblems(runWithEnv('KEY: ${{ secrets.KEY }}'))).toEqual([
      expect.stringContaining('hands a secret'),
    ]);
  });

  it.fails.each([
    ['toJSON(secrets)', 'ALL: ${{ toJSON(secrets) }}'],
    ['index syntax', "KEY: ${{ secrets['KEY'] }}"],
    ['an env var named firebaseServiceAccount', 'firebaseServiceAccount: ${{ secrets.KEY }}'],
  ])('refuses the key in a run step env through %s', (_what, envLine) => {
    expect(workflowProblems(runWithEnv(envLine))).toEqual([
      expect.stringContaining('hands a secret'),
    ]);
  });

  it.fails('refuses toJSON(secrets) in workflow-level env', () => {
    const text = `env:\n  ALL: \${{ toJSON(secrets) }}\n${good}`;
    expect(workflowProblems(text)).toEqual([expect.stringContaining('hands a secret')]);
  });
});
