import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authListener } from './compose.ts';
import { ENV, readConfig } from './config.ts';

/** #663: what the function is told about where it runs, and that it deploys on its own. */

const GOOD = {
  [ENV.clientId]: 'Iv23liExample',
  [ENV.clientSecret]: 'not-a-real-secret',
  [ENV.origin]: 'https://dailyflowai-web.web.app',
};

describe('the function’s config', () => {
  it('reads the App and the site from the environment', () => {
    expect(readConfig(GOOD)).toEqual({
      clientId: 'Iv23liExample',
      clientSecret: 'not-a-real-secret',
      origin: 'https://dailyflowai-web.web.app',
    });
  });

  it('names every variable missing, and never prints the secret', () => {
    expect(() => readConfig({})).toThrow(
      /GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, DFAI_WEB_ORIGIN/,
    );
    const message = (() => {
      try {
        readConfig({ ...GOOD, [ENV.origin]: 'http://x' });
        return 'no error';
      } catch (error) {
        return String(error);
      }
    })();
    expect(message).toMatch(/DFAI_WEB_ORIGIN/);
    expect(message).not.toContain('not-a-real-secret');
  });

  it.each([
    'http://dailyflowai-web.web.app',
    'https://dailyflowai-web.web.app/',
    'https://dailyflowai-web.web.app/app',
    'https://user@dailyflowai-web.web.app',
    'dailyflowai-web.web.app',
  ])('refuses %s as the origin', (origin) => {
    expect(() => readConfig({ ...GOOD, [ENV.origin]: origin })).toThrow(/DFAI_WEB_ORIGIN/);
  });

  it('refuses a client id or secret with a space in it', () => {
    expect(() => readConfig({ ...GOOD, [ENV.clientSecret]: 'a b' })).toThrow(
      /GITHUB_APP_CLIENT_SECRET/,
    );
  });

  it('composes a listener only when configured', () => {
    expect(() => authListener({})).toThrow(/not configured/);
    expect(authListener(GOOD, async () => new Response())).toBeTypeOf('function');
  });
});

describe('the function’s package', () => {
  const root = join(import.meta.dirname, '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it('depends on no workspace package, so Firebase can install it on its own', () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.entries(all).filter(([, version]) => version.startsWith('workspace:'))).toEqual(
      [],
    );
    const shipped = readdirSync(join(root, 'src')).filter(
      (file) => file.endsWith('.ts') && !/\.test(-support)?\.ts$/.test(file),
    );
    expect(shipped.length).toBeGreaterThan(4);
    for (const file of shipped)
      expect([file, readFileSync(join(root, 'src', file), 'utf8')]).not.toEqual([
        file,
        expect.stringMatching(/from '@dfai\//),
      ]);
  });
});
