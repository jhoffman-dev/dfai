import { describe, expect, it } from 'vitest';
import {
  actionProblems,
  otherWorkflowProblems,
  scriptProblems,
  workflowProblems,
} from './web-hosting-workflow.ts';
import {
  KEY_EXPRESSION,
  LIVE_CHECK,
  PREVIEW_DEPLOY_USES,
  WORKFLOW,
  edited,
  withRun,
} from './web-hosting-workflow.test-support.ts';

describe('the deploy workflow allowlist', () => {
  it('passes the committed workflow', () => {
    expect(workflowProblems(WORKFLOW)).toEqual([]);
  });

  it('lets a step be renamed', () => {
    expect(workflowProblems(edited('- name: Build the web app', '- name: Build it', 2))).toEqual(
      [],
    );
  });

  it.each([
    ['a job of its own', withRun('echo hi'), 'job "extra" is not one of the deploy jobs'],
    ['no live job', edited('  live:\n', '  later:\n'), 'no job "live"'],
    [
      'a step more',
      edited(LIVE_CHECK, LIVE_CHECK.replace('\n\n', '\n\n      - run: echo extra\n\n')),
      'has 9 steps, not 8',
    ],
    [
      'a deploy to another target',
      edited('          target: web\n', '          target: site\n', 2),
      '"target":"site"',
    ],
    [
      'a preview that never expires',
      edited('          expires: 7d\n', '          expires: 30d\n'),
      '"expires":"30d"',
    ],
    [
      'a live deploy from any branch',
      edited('    branches: [main]\n', "    branches: ['**']\n"),
      'not pushes to main and pull requests',
    ],
    [
      'a manual trigger',
      edited('  pull_request:\n', '  workflow_dispatch:\n  pull_request:\n'),
      'not pushes to main and pull requests',
    ],
    [
      'the live job outside its environment',
      edited('    environment: web-live\n', ''),
      'deploys live outside the web-live environment',
    ],
    [
      'the check skipped on failure',
      edited(LIVE_CHECK, LIVE_CHECK.replace('\n\n', '\n        continue-on-error: true\n\n')),
      'deploys without first running exactly',
    ],
    [
      'a step name with an expression',
      edited('- name: Deploy live', '- name: Deploy ${{ github.ref }}'),
      'step name with an expression',
    ],
    [
      'the key in the job env',
      edited(
        '    environment: web-live\n',
        `    environment: web-live\n    env:\n      K: ${KEY_EXPRESSION}\n`,
      ),
      'jobs.live.env.K hands a secret',
    ],
    [
      'an action not on the list',
      edited(
        PREVIEW_DEPLOY_USES,
        PREVIEW_DEPLOY_USES.replace(
          /FirebaseExtended\S+/,
          'FirebaseExtended/action-hosting-deploy@v0',
        ),
      ),
      '"FirebaseExtended/action-hosting-deploy@v0" is not an allowed',
    ],
    ['a workflow env', `env:\n  A: b\n${WORKFLOW}`, 'sets "env" at the top level'],
    [
      'wider permissions',
      edited('permissions:\n  contents: read\n', 'permissions: write-all\n'),
      'permissions',
    ],
    ['text that is not YAML', 'jobs: [', 'does not parse'],
  ])('refuses %s', (_what, text, problem) => {
    expect(workflowProblems(text)).toContainEqual(expect.stringContaining(problem));
  });
});

describe('any workflow', () => {
  it.each([
    ['an unpinned action', 'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n'],
    [
      'a reusable workflow from elsewhere',
      'jobs:\n  a:\n    uses: someone/repo/.github/workflows/x.yml@main\n',
    ],
  ])('refuses %s', (_what, text) => {
    expect(actionProblems(text)).toEqual([expect.stringContaining('is not an allowed')]);
  });

  it('allows the pinned actions and the local gate', () => {
    const text =
      'jobs:\n  a:\n    uses: ./.github/workflows/gate.yml\n  b:\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n';
    expect(actionProblems(text)).toEqual([]);
  });
});

describe('a workflow other than web-hosting.yml', () => {
  it.each([
    ['runs firebase', 'jobs:\n  a:\n    steps:\n      - run: npx firebase-tools deploy\n'],
    [
      'reads the key',
      `jobs:\n  a:\n    steps:\n      - env:\n          K: ${KEY_EXPRESSION}\n        run: echo\n`,
    ],
    [
      'uses the deploy action',
      'jobs:\n  a:\n    steps:\n      - uses: x/action-hosting-deploy@1\n',
    ],
  ])('is refused when it %s', (_what, text) => {
    expect(otherWorkflowProblems('gate.yml', text)).toEqual([
      expect.stringContaining('only web-hosting.yml may'),
    ]);
  });

  it('passes one that never mentions Firebase', () => {
    expect(
      otherWorkflowProblems('gate.yml', 'jobs:\n  a:\n    steps:\n      - run: pnpm build\n'),
    ).toEqual([]);
  });
});

describe('package scripts', () => {
  it('refuses one that runs Firebase', () => {
    expect(
      scriptProblems('package.json', { scripts: { 'deploy:all': 'firebase deploy' } }),
    ).toEqual(['package.json script "deploy:all" runs Firebase']);
  });
});
