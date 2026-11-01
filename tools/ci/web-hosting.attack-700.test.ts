import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ignoreProblems, publicDirProblems, uploadedFiles } from './web-hosting.ts';
import { workflowProblems } from './web-hosting-workflow.ts';
import {
  KEY_EXPRESSION,
  LIVE_CHECK,
  PREVIEW_DEPLOY_USES,
  WORKFLOW,
  edited,
  withJob,
  withRun,
} from './web-hosting-workflow.test-support.ts';

/*
 * Adversarial probes of PR #700 (#662): the hosting checks against what
 * firebase-tools 15.28.2 actually uploads (lib/listFiles.js: glob `**\/*`,
 * dot + follow + nodir, its ignore list) and against workflows that deploy
 * or leak the key in ways a text search does not see. Each was a hole in the
 * pattern-matching checker; the workflow is now held to an allowlist over its
 * parsed YAML, and each probe is the real workflow with the attack's edit.
 */

const IGNORE = ['**/.*', '**/.*/**'];

describe('the file listing, against firebase-tools listFiles', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('refuses a symlink to a dot-folder (listFiles follows symlinks)', () => {
    // listFiles uploads `vitelink/m.json`: the bytes of `.vite/m.json` under a name with no dot.
    dir = mkdtempSync(join(tmpdir(), 'attack-700-'));
    mkdirSync(join(dir, '.vite'));
    writeFileSync(join(dir, '.vite', 'm.json'), '{}');
    writeFileSync(join(dir, 'index.html'), '');
    symlinkSync('.vite', join(dir, 'vitelink'));
    expect(publicDirProblems(dir, IGNORE)).toEqual([
      '"vitelink" is a symlink, which firebase-tools would follow',
    ]);
  });

  it('refuses a symlink out of dist (listFiles uploads what it points at)', () => {
    dir = mkdtempSync(join(tmpdir(), 'attack-700-'));
    mkdirSync(join(dir, 'outside'));
    writeFileSync(join(dir, 'outside', 'id_rsa'), 'k');
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'index.html'), '');
    symlinkSync(join(dir, 'outside'), join(dir, 'dist', 'outlink'));
    expect(publicDirProblems(join(dir, 'dist'), IGNORE)).toEqual([
      '"outlink" is a symlink, which firebase-tools would follow',
    ]);
  });

  it('reports a dotfile as uploaded when a negated ignore pattern is configured', () => {
    // glob drops `!` patterns from its ignore list, so listFiles uploads `.env`.
    expect(uploadedFiles(['index.html', '.env', '.vite/m.json'], ['!index.html'])).toEqual([
      'index.html',
      '.env',
      '.vite/m.json',
    ]);
    expect(ignoreProblems(['!index.html'])).toContainEqual(
      expect.stringContaining('dropped by firebase-tools'),
    );
  });

  it('agrees with listFiles that "**/.*/**" alone also skips the dotfile itself', () => {
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

const refused = (text: string, problem: string) =>
  expect(workflowProblems(text)).toContainEqual(expect.stringContaining(problem));

describe('the workflow checker, against deploys it should refuse', () => {
  it('passes the committed workflow (control)', () => {
    expect(workflowProblems(WORKFLOW)).toEqual([]);
  });

  // Any `run:` outside the two jobs' exact steps is a job the allowlist does not have.
  it.each([
    ['two spaces', 'firebase  deploy'],
    ['a tab', 'firebase\tdeploy'],
    ['pnpm dlx', 'pnpm dlx firebase-tools deploy'],
    ['a global flag before the verb', 'firebase --non-interactive deploy'],
    ['a quoted verb', 'firebase "deploy"'],
    ['a variable for the binary', '$FIREBASE deploy'],
    ['a second --only, which wins', 'firebase deploy --only hosting:web --only hosting'],
    ['a script that deploys', 'pnpm run deploy:everything'],
    [
      'a command that takes down the default site',
      'firebase hosting:disable --site dailyflowai-app',
    ],
  ])('refuses a bare deploy spelled with %s', (_what, command) => {
    refused(withRun(command), 'job "extra" is not one of the deploy jobs');
  });

  it('refuses a bare deploy spelled with a line continuation, inside a deploy job', () => {
    const text = edited(
      LIVE_CHECK,
      LIVE_CHECK.replace(
        '\n\n',
        '\n\n      - run: |\n          firebase \\\n            deploy\n\n',
      ),
    );
    refused(text, 'job "live" has 9 steps, not 8');
  });

  it('refuses a live deploy outside web-live when channelId is quoted', () => {
    refused(
      edited('          expires: 7d\n', '          channelId: "live"\n'),
      'job "preview" deploys live outside the web-live environment',
    );
  });

  it('refuses a live deploy outside web-live when channelId carries a comment', () => {
    refused(
      edited('          expires: 7d\n', '          channelId: live # go\n'),
      'job "preview" deploys live outside the web-live environment',
    );
  });

  it('refuses a job that deploys live through a YAML alias of the live step, unchecked', () => {
    const anchored = edited(
      '      - name: Deploy live\n',
      '      - &deploy\n        name: Deploy live\n',
    );
    refused(
      withJob('sneaky', '    steps:\n      - *deploy\n', anchored),
      'job "sneaky" is not one',
    );
  });

  it('refuses a check that is only named, never run, before the deploy', () => {
    const text = edited(LIVE_CHECK, '        run: echo skipped\n\n      - name: Deploy live\n');
    refused(text, 'job "live" deploys without first running exactly');
  });

  it('refuses a check whose failure is ignored', () => {
    const text = edited(
      LIVE_CHECK,
      LIVE_CHECK.replace('web-hosting.test.ts\n', 'web-hosting.test.ts || true\n'),
    );
    refused(text, 'job "live" deploys without first running exactly');
  });

  it('refuses the key handed to an action-hosting-deploy that is not FirebaseExtended', () => {
    const text = edited(
      PREVIEW_DEPLOY_USES,
      PREVIEW_DEPLOY_USES.replace(/FirebaseExtended\S+/, 'attacker/action-hosting-deploy@v1'),
    );
    refused(text, '"attacker/action-hosting-deploy@v1" is not an allowed');
    refused(text, 'jobs.preview.steps.7.with.firebaseServiceAccount hands a secret');
  });

  it('refuses the key handed to an unrelated action as firebaseServiceAccount', () => {
    const text = withJob(
      'extra',
      `    steps:\n      - uses: some/other-action@v1\n        with:\n          firebaseServiceAccount: ${KEY_EXPRESSION}\n`,
    );
    refused(text, 'jobs.extra.steps.0.with.firebaseServiceAccount hands a secret');
  });
});

describe('the workflow checker, against the key reaching a run step', () => {
  const runWithEnv = (envLine: string) =>
    withJob('build', `    steps:\n      - run: pnpm install\n        env:\n          ${envLine}\n`);

  it.each([
    ['by name (control)', `KEY: ${KEY_EXPRESSION}`],
    ['toJSON(secrets)', 'ALL: ${{ toJSON(secrets) }}'],
    ['index syntax', "KEY: ${{ secrets['FIREBASE_SERVICE_ACCOUNT_DAILYFLOWAI_APP'] }}"],
    ['an env var named firebaseServiceAccount', `firebaseServiceAccount: ${KEY_EXPRESSION}`],
  ])('refuses the key in a run step env through %s', (_what, envLine) => {
    refused(runWithEnv(envLine), 'jobs.build.steps.0.env.');
    refused(runWithEnv(envLine), 'hands a secret');
  });

  it('refuses toJSON(secrets) in workflow-level env', () => {
    const text = `env:\n  ALL: \${{ toJSON(secrets) }}\n${WORKFLOW}`;
    refused(text, 'env.ALL hands a secret');
  });
});
