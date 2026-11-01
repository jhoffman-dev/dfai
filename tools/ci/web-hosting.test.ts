import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cspHeaderProblems,
  firebaseJsonProblems,
  firebasercProblems,
  metaCsp,
  workflowProblems,
} from './web-hosting.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const firebaseJson = JSON.parse(read('firebase.json')) as {
  hosting: {
    public: string;
    rewrites: { source: string; destination: string }[];
    headers: { source: string; headers: { key: string; value: string }[] }[];
  }[];
};
const firebaserc = JSON.parse(read('.firebaserc'));
const workflow = read('.github/workflows/web-hosting.yml');
const indexHtml = read('apps/web/index.html');

const [web] = firebaseJson.hosting;
const header = (source: string, key: string) =>
  web?.headers.find((rule) => rule.source === source)?.headers.find((h) => h.key === key)?.value;

describe('the web build hosting config, as committed', () => {
  it('deploys only through the web target', () => {
    expect(firebaseJsonProblems(firebaseJson)).toEqual([]);
    expect(firebasercProblems(firebaserc)).toEqual([]);
  });

  it('never runs a bare firebase deploy', () => {
    expect(workflowProblems(workflow)).toEqual([]);
  });

  it('serves the web build as a single-page app', () => {
    expect(web?.public).toBe('apps/web/dist');
    expect(web?.rewrites).toEqual([{ source: '**', destination: '/index.html' }]);
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
});

describe('firebase.json', () => {
  it.each([
    ['names the default site', { hosting: { site: 'dailyflowai-app', public: 'x' } }],
    ['names the site beside the target', { hosting: { target: 'web', site: 'dailyflowai-web' } }],
    ['has a second target', { hosting: [{ target: 'web' }, { target: 'other' }] }],
    ['has no target', { hosting: [{ public: 'x' }] }],
    ['configures functions too', { hosting: { target: 'web' }, functions: {} }],
    ['has no hosting', {}],
  ])('fails when it %s', (_what, config) => {
    expect(firebaseJsonProblems(config)).not.toEqual([]);
  });
});

describe('.firebaserc', () => {
  const good = {
    projects: { default: 'dailyflowai-app' },
    targets: { 'dailyflowai-app': { hosting: { web: ['dailyflowai-web'] } } },
  };

  it.each([
    [
      'maps the target to the default site',
      { ...good, targets: { 'dailyflowai-app': { hosting: { web: ['dailyflowai-app'] } } } },
    ],
    [
      'maps the target to two sites',
      {
        ...good,
        targets: {
          'dailyflowai-app': { hosting: { web: ['dailyflowai-web', 'dailyflowai-app'] } },
        },
      },
    ],
    [
      'adds a target',
      {
        ...good,
        targets: {
          'dailyflowai-app': { hosting: { web: ['dailyflowai-web'], site: ['dailyflowai-app'] } },
        },
      },
    ],
    ['points at another project', { ...good, projects: { default: 'gcal-timeblocking' } }],
    [
      'adds a second project',
      { ...good, projects: { default: 'dailyflowai-app', games: 'student-games-be188' } },
    ],
    [
      'has targets in another project',
      { ...good, targets: { ...good.targets, other: { hosting: { web: ['dailyflowai-web'] } } } },
    ],
    ['maps no target', { ...good, targets: {} }],
  ])('fails when it %s', (_what, rc) => {
    expect(firebasercProblems(rc)).not.toEqual([]);
  });

  it('passes the one mapping', () => {
    expect(firebasercProblems(good)).toEqual([]);
  });
});

describe('the CSP header', () => {
  const meta = "script-src 'self'; connect-src 'self'; frame-src 'none'";

  it.each([
    ['drops a directive', "script-src 'self'; frame-src 'none'; frame-ancestors 'none'"],
    [
      'loosens one',
      "script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'",
    ],
    ['lacks frame-ancestors', meta],
    ['adds one the page lacks', `${meta}; frame-ancestors 'none'; img-src *`],
  ])('fails when it %s', (_what, served) => {
    expect(cspHeaderProblems(served, meta)).not.toEqual([]);
  });

  it('passes the page policy plus frame-ancestors, whatever the spacing', () => {
    expect(
      cspHeaderProblems(
        "script-src  'self';connect-src 'self'; frame-src 'none'; frame-ancestors 'none';",
        meta,
      ),
    ).toEqual([]);
  });
});

describe('the workflow', () => {
  const step = (lines: string) =>
    `steps:\n  - uses: FirebaseExtended/action-hosting-deploy@abc\n${lines}`;
  const good = step('    with:\n      projectId: dailyflowai-app\n      target: web\n');

  it('passes a step naming the project and the target', () => {
    expect(workflowProblems(good)).toEqual([]);
  });

  it.each([
    ['a bare firebase deploy', `${good}  - run: npx firebase deploy\n`],
    ['a deploy of every hosting site', `${good}  - run: firebase deploy --only hosting\n`],
    ['a deploy of another target', `${good}  - run: firebase deploy --only hosting:web-old\n`],
    [
      'a deploy of the web target and functions',
      `${good}  - run: firebase deploy --only hosting:web,functions\n`,
    ],
    ['a deploy step without a target', step('    with:\n      projectId: dailyflowai-app\n')],
    [
      'a deploy step with another target',
      step('    with:\n      projectId: dailyflowai-app\n      target: site\n'),
    ],
    ['a deploy step without the project', step('    with:\n      target: web\n')],
    ['no deploy step at all', 'steps:\n  - run: echo\n'],
  ])('fails on %s', (_what, text) => {
    expect(workflowProblems(text)).not.toEqual([]);
  });

  it('passes a deploy limited to the web target, and ignores comments', () => {
    expect(
      workflowProblems(
        `# never a bare firebase deploy\n${good}  - run: firebase deploy --only hosting:web\n`,
      ),
    ).toEqual([]);
  });
});
