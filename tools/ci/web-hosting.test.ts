import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { minimatch } from 'minimatch';
import { describe, expect, it } from 'vitest';
import {
  cspHeaderProblems,
  firebaseJsonProblems,
  firebasercProblems,
  isDotPath,
  metaCsp,
  uploadedFiles,
  workflowProblems,
} from './web-hosting.ts';

/*
 * The web build's hosting config (#662), as committed, and the checks that
 * hold it to its one site. The deploy jobs in .github/workflows/web-hosting.yml
 * run this file after the build with WEB_DIST_REQUIRED=1, so the files it
 * would upload are checked too, before anything is deployed.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

interface Hosting {
  public: string;
  ignore: string[];
  rewrites: { source: string; destination: string }[];
  headers: { source: string; headers: { key: string; value: string }[] }[];
}

const firebaseJson = JSON.parse(read('firebase.json')) as { hosting: Hosting[] };
const firebaserc = JSON.parse(read('.firebaserc'));
const workflow = read('.github/workflows/web-hosting.yml');
const indexHtml = read('apps/web/index.html');

const [web] = firebaseJson.hosting;
const header = (source: string, key: string) =>
  web?.headers.find((rule) => rule.source === source)?.headers.find((h) => h.key === key)?.value;
const rewritten = (path: string) =>
  (web?.rewrites ?? []).some((rule) => minimatch(path, rule.source));

const DIST = join(ROOT, 'apps/web/dist');
const distFiles = () =>
  readdirSync(DIST, { recursive: true, encoding: 'utf8' })
    .filter((path) => statSync(join(DIST, path)).isFile())
    .map((path) => path.split(sep).join('/'));

describe('the web build hosting config, as committed', () => {
  it('deploys only through the web target', () => {
    expect(firebaseJsonProblems(firebaseJson)).toEqual([]);
    expect(firebasercProblems(firebaserc)).toEqual([]);
  });

  it('deploys only the web target, after the checks, with the key in the deploy action alone', () => {
    expect(workflowProblems(workflow)).toEqual([]);
  });

  it('serves the web build as a single-page app, but lets a missing asset 404', () => {
    expect(web?.public).toBe('apps/web/dist');
    expect(web?.rewrites.every((rule) => rule.destination === '/index.html')).toBe(true);
    expect(['/notes', '/notes/a/b', '/today'].filter(rewritten)).toEqual([
      '/notes',
      '/notes/a/b',
      '/today',
    ]);
    // Rewritten, the page would be served under the assets' year-long cache.
    expect(['/assets/index-gone.js', '/assets/a/b.css'].filter(rewritten)).toEqual([]);
  });

  it("serves the page's own CSP as a header, plus frame-ancestors", () => {
    const meta = metaCsp(indexHtml);
    expect(meta).toBeDefined();
    expect(cspHeaderProblems(header('**', 'Content-Security-Policy') ?? '', meta ?? '')).toEqual(
      [],
    );
  });

  it('revalidates the page and keeps hashed assets for good, the assets rule last so it wins', () => {
    expect(header('**', 'Cache-Control')).toBe('no-cache');
    expect(header('/assets/**', 'Cache-Control')).toMatch(/immutable/);
    expect(web?.headers.map((rule) => rule.source)).toEqual(['**', '/assets/**']);
  });

  it('uploads no dotfile and nothing inside a dot-folder', () => {
    const listing = [
      'index.html',
      'assets/index-abc.js',
      '.vite/node-builtins.json',
      '.vite/deep/manifest.json',
      'assets/.DS_Store',
      '.well-known/a/b',
      'firebase-debug.log',
    ];
    expect(uploadedFiles(listing, web?.ignore ?? [])).toEqual([
      'index.html',
      'assets/index-abc.js',
    ]);
  });

  it.skipIf(!existsSync(DIST) && process.env.WEB_DIST_REQUIRED !== '1')(
    'uploads none of the built dotfiles (the deploy jobs run this after the build)',
    () => {
      const files = distFiles();
      expect(files).toContain('index.html');
      expect(uploadedFiles(files, web?.ignore ?? []).filter(isDotPath)).toEqual([]);
    },
  );
});

describe('the file listing', () => {
  it('ships a dot-folder\'s contents when only "**/.*" is ignored, as firebase-tools does', () => {
    expect(uploadedFiles(['.vite/node-builtins.json', '.env'], ['**/.*'])).toEqual([
      '.vite/node-builtins.json',
    ]);
  });
});

describe('firebase.json', () => {
  it.each([
    [
      'names the default site',
      { hosting: { target: 'web', site: 'dailyflowai-app' } },
      'names site "dailyflowai-app"',
    ],
    ['has a second target', { hosting: [{ target: 'web' }, { target: 'other' }] }, '"other"'],
    ['has no target', { hosting: [{ public: 'x' }] }, 'target "undefined"'],
    ['configures functions too', { hosting: { target: 'web' }, functions: {} }, '"functions"'],
    ['has no hosting', {}, 'no hosting entry'],
    ['has an empty hosting list', { hosting: [] }, 'empty hosting list'],
  ])('fails when it %s', (_what, config, problem) => {
    expect(firebaseJsonProblems(config)).toEqual([expect.stringContaining(problem)]);
  });
});

describe('.firebaserc', () => {
  const good = {
    projects: { default: 'dailyflowai-app' },
    targets: { 'dailyflowai-app': { hosting: { web: ['dailyflowai-web'] } } },
  };
  const hosting = (map: Record<string, string[]>) => ({
    ...good,
    targets: { 'dailyflowai-app': { hosting: map } },
  });

  it.each([
    [
      'maps the target to the default site',
      hosting({ web: ['dailyflowai-app'] }),
      'maps to ["dailyflowai-app"]',
    ],
    [
      'maps the target to two sites',
      hosting({ web: ['dailyflowai-web', 'dailyflowai-app'] }),
      'maps to ["dailyflowai-web","dailyflowai-app"]',
    ],
    ['points at another project', { ...good, projects: { default: 'gcal-timeblocking' } }, 'gcal'],
    [
      'adds a second project',
      { ...good, projects: { default: 'dailyflowai-app', games: 'student-games-be188' } },
      'student-games-be188',
    ],
    [
      'has targets in another project',
      { ...good, targets: { ...good.targets, other: { hosting: { web: ['dailyflowai-web'] } } } },
      'targets in project "other"',
    ],
    ['maps no target', { ...good, targets: {} }, 'does not map target "web"'],
  ])('fails when it %s', (_what, rc, problem) => {
    expect(firebasercProblems(rc)).toEqual([expect.stringContaining(problem)]);
  });

  it('fails when it adds a target, naming the target and its site', () => {
    expect(
      firebasercProblems(hosting({ web: ['dailyflowai-web'], site: ['dailyflowai-app'] })),
    ).toEqual([
      expect.stringContaining('hosting target "site"'),
      expect.stringContaining('"site" maps to ["dailyflowai-app"]'),
    ]);
  });

  it('passes the one mapping', () => {
    expect(firebasercProblems(good)).toEqual([]);
  });
});

describe('the CSP header', () => {
  const meta = "script-src 'self'; connect-src 'self'; frame-src 'none'";

  it.each([
    [
      'drops a directive',
      "script-src 'self'; frame-src 'none'; frame-ancestors 'none'",
      "lacks the page's \"connect-src 'self'\"",
    ],
    ['lacks frame-ancestors', meta, "lacks frame-ancestors 'none'"],
    ['adds one the page lacks', `${meta}; frame-ancestors 'none'; img-src *`, 'adds "img-src *"'],
  ])('fails when it %s', (_what, served, problem) => {
    expect(cspHeaderProblems(served, meta)).toEqual([expect.stringContaining(problem)]);
  });

  it('fails when it loosens one, as both a loss and an addition', () => {
    const served = `script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'`;
    expect(cspHeaderProblems(served, meta)).toEqual([
      expect.stringContaining(`lacks the page's "script-src 'self'"`),
      expect.stringContaining(`adds "script-src 'self' 'unsafe-inline'"`),
    ]);
  });

  it('passes the page policy plus frame-ancestors, whatever the spacing', () => {
    const served =
      "script-src  'self';connect-src 'self'; frame-src 'none'; frame-ancestors 'none';";
    expect(cspHeaderProblems(served, meta)).toEqual([]);
  });
});

describe('the workflow', () => {
  const CHECK = '      - run: pnpm exec vitest run tools/ci/web-hosting.test.ts\n';
  const DEPLOY = '      - uses: FirebaseExtended/action-hosting-deploy@abc\n        with:\n';
  const KEY = '          firebaseServiceAccount: ${{ secrets.KEY }}\n';
  const job = (name: string, body: string) => `  ${name}:\n    runs-on: ubuntu-latest\n${body}`;
  const preview = job(
    'preview',
    `    steps:\n${CHECK}${DEPLOY}${KEY}          projectId: dailyflowai-app\n          target: web\n`,
  );
  const live = job(
    'live',
    `    environment: web-live\n    steps:\n${CHECK}${DEPLOY}${KEY}          projectId: dailyflowai-app\n          target: web\n          channelId: live\n`,
  );
  const good = `jobs:\n${preview}${live}`;
  const withRun = (command: string) =>
    `${good}${job('extra', `    steps:\n      - run: ${command}\n`)}`;

  it('passes a preview job and a live job in its environment, each checking first', () => {
    expect(workflowProblems(good)).toEqual([]);
  });

  it('ignores comments', () => {
    expect(workflowProblems(`# never a bare firebase deploy\n${good}`)).toEqual([]);
  });

  it.each([
    ['a bare firebase deploy', 'npx firebase deploy', 'is not --only hosting:web'],
    ['a bare firebase-tools deploy', 'npx firebase-tools deploy', 'is not --only hosting:web'],
    ['a pinned firebase-tools deploy', 'npx firebase-tools@15 deploy', 'is not --only hosting:web'],
    ['every hosting site', 'firebase deploy --only hosting', 'is not --only hosting:web'],
    ['another target', 'firebase deploy --only hosting:web-old', 'is not --only hosting:web'],
    ['the web target and functions', 'firebase deploy --only hosting:web,functions', 'is not'],
    [
      'a channel deploy of every target',
      'firebase hosting:channel:deploy pr1',
      'is not --only web',
    ],
    [
      'another project',
      'firebase deploy --only hosting:web --project gcal-timeblocking',
      'names a project other than dailyflowai-app',
    ],
    [
      'another project by alias',
      'firebase deploy --only hosting:web -P student-games-be188',
      'names a project other than dailyflowai-app',
    ],
  ])('fails on %s', (_what, command, problem) => {
    expect(workflowProblems(withRun(command))).toEqual([expect.stringContaining(problem)]);
  });

  it('passes deploys limited to the web target and the project', () => {
    expect(
      workflowProblems(
        withRun(
          'firebase deploy --only hosting:web --project dailyflowai-app && firebase hosting:channel:deploy pr1 --only web',
        ),
      ),
    ).toEqual([]);
  });

  it.each([
    ['a deploy job that does not check first', preview.replace(CHECK, ''), 'without first running'],
    ['a deploy job that checks after', preview.replace(CHECK, '') + CHECK, 'without first running'],
    ['a step without a target', preview.replace('          target: web\n', ''), 'target: web'],
    ['a step with another target', preview.replace('target: web', 'target: site'), 'target: web'],
    [
      'a step without the project',
      preview.replace('          projectId: dailyflowai-app\n', ''),
      'projectId',
    ],
    [
      'a live deploy outside its environment',
      live.replace('    environment: web-live\n', ''),
      'web-live',
    ],
    [
      'the key in a job env',
      preview.replace('    steps:\n', '    env:\n      KEY: ${{ secrets.KEY }}\n    steps:\n'),
      'hands a secret',
    ],
    [
      'the key in the build step env',
      preview.replace(CHECK, `${CHECK}        env:\n          KEY: \${{ secrets.KEY }}\n`),
      'hands a secret',
    ],
  ])('fails on %s', (_what, changed, problem) => {
    // Each case changes one job; the other stays as it should be.
    const text = `jobs:\n${changed.includes('  live:') ? preview : live}${changed}`;
    expect(workflowProblems(text)).toEqual([expect.stringContaining(problem)]);
  });

  it('fails when nothing deploys', () => {
    expect(workflowProblems('jobs:\n  build:\n    steps:\n      - run: echo\n')).toEqual([
      'the workflow never uses action-hosting-deploy',
    ]);
  });
});
