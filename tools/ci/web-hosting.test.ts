import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { minimatch } from 'minimatch';
import { describe, expect, it } from 'vitest';
import {
  cspHeaderProblems,
  firebaseJsonProblems,
  firebasercProblems,
  ignoreProblems,
  metaCsp,
  publicDirProblems,
  uploadedFiles,
} from './web-hosting.ts';
import {
  actionProblems,
  otherWorkflowProblems,
  scriptProblems,
  workflowProblems,
} from './web-hosting-workflow.ts';

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
const indexHtml = read('apps/web/index.html');

const WORKFLOWS = '.github/workflows';
const workflowFiles = readdirSync(join(ROOT, WORKFLOWS)).filter((file) => /\.ya?ml$/.test(file));

const packageFiles = [
  'package.json',
  ...['apps', 'packages'].flatMap((dir) =>
    readdirSync(join(ROOT, dir))
      .map((name) => `${dir}/${name}/package.json`)
      .filter((path) => existsSync(join(ROOT, path))),
  ),
];

const [web] = firebaseJson.hosting;
const header = (source: string, key: string) =>
  web?.headers.find((rule) => rule.source === source)?.headers.find((h) => h.key === key)?.value;
const rewritten = (path: string) =>
  (web?.rewrites ?? []).some((rule) => minimatch(path, rule.source));

const DIST = join(ROOT, 'apps/web/dist');

describe('the web build hosting config, as committed', () => {
  it('deploys only through the web target', () => {
    expect(firebaseJsonProblems(firebaseJson)).toEqual([]);
    expect(firebasercProblems(firebaserc)).toEqual([]);
  });

  it('deploys with exactly the allowed workflow', () => {
    expect(workflowProblems(read(`${WORKFLOWS}/web-hosting.yml`))).toEqual([]);
  });

  it('uses only pinned, allowed actions in every workflow', () => {
    expect(workflowFiles.length).toBeGreaterThan(1);
    expect(workflowFiles.flatMap((file) => actionProblems(read(`${WORKFLOWS}/${file}`)))).toEqual(
      [],
    );
  });

  it('touches Firebase from no other workflow, and from no package script', () => {
    const others = workflowFiles.filter((file) => file !== 'web-hosting.yml');
    expect(others.length).toBeGreaterThan(0);
    expect(
      others.flatMap((file) => otherWorkflowProblems(file, read(`${WORKFLOWS}/${file}`))),
    ).toEqual([]);
    expect(packageFiles.flatMap((file) => scriptProblems(file, JSON.parse(read(file))))).toEqual(
      [],
    );
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

  it('ignores dotfiles and dot-folders, with the one list checked against firebase-tools', () => {
    expect(ignoreProblems(web?.ignore ?? [])).toEqual([]);
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
    'uploads no built dotfile and holds no symlink (the deploy jobs run this after the build)',
    () => {
      expect(readdirSync(DIST)).toContain('index.html');
      expect(publicDirProblems(DIST, web?.ignore ?? [])).toEqual([]);
    },
  );
});

describe('the file listing', () => {
  it('ships a dot-folder\'s contents when only "**/.*" is ignored, as firebase-tools does', () => {
    expect(uploadedFiles(['.vite/node-builtins.json', '.env'], ['**/.*'])).toEqual([
      '.vite/node-builtins.json',
    ]);
  });

  it.each([
    ['a negation', ['**/.*', '**/.*/**', '!index.html'], 'dropped by firebase-tools'],
    ['a shorter list', ['**/.*'], 'not ["**/.*","**/.*/**"]'],
    ['another order', ['**/.*/**', '**/.*'], 'not ["**/.*","**/.*/**"]'],
  ])('refuses an ignore list with %s', (_what, ignore, problem) => {
    expect(ignoreProblems(ignore)).toContainEqual(expect.stringContaining(problem));
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
