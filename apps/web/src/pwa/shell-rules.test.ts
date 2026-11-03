import { describe, expect, it } from 'vitest';
import {
  fetchPlan,
  offersUpdate,
  precacheList,
  SHELL_CACHE_PREFIX,
  shellCacheName,
  staleShellCaches,
} from './shell-rules.ts';

const ORIGIN = 'https://app.example.com';
const precached = new Set(['/assets/index-abc123.js', '/assets/index-def456.css', '/index.html']);
const get = (url: string, mode = 'cors') => ({ url, method: 'GET', mode });
const plan = (asked: { url: string; method: string; mode: string }) =>
  fetchPlan(asked, { origin: ORIGIN, precached });

describe('what the service worker answers (#668)', () => {
  it('serves a built file from the shell cache, by its hashed name', () => {
    expect(plan(get(`${ORIGIN}/assets/index-abc123.js`, 'no-cors'))).toBe('shell');
    expect(plan(get(`${ORIGIN}/assets/index-def456.css`))).toBe('shell');
  });

  it('serves a page load network-first, whatever path the app is opened at', () => {
    expect(plan(get(`${ORIGIN}/`, 'navigate'))).toBe('page');
    expect(plan(get(`${ORIGIN}/auth/callback?code=x&state=y`, 'navigate'))).toBe('page');
    expect(plan(get(`${ORIGIN}/index.html`))).toBe('page');
  });

  it("never touches the sign-in function's routes, even as a page load", () => {
    expect(plan(get(`${ORIGIN}/api/auth/start?state=x`, 'navigate'))).toBe('bypass');
    expect(plan(get(`${ORIGIN}/api/auth/token`))).toBe('bypass');
    expect(plan({ url: `${ORIGIN}/api/auth/refresh`, method: 'POST', mode: 'cors' })).toBe(
      'bypass',
    );
  });

  it("never touches GitHub's API, or any other origin, however the path looks", () => {
    expect(
      plan(get('https://api.github.com/repos/mara-quill/vault/contents/Garden%20plan.md')),
    ).toBe('bypass');
    expect(plan(get('https://api.github.com/index.html', 'navigate'))).toBe('bypass');
    expect(plan(get('https://evil.example.com/assets/index-abc123.js'))).toBe('bypass');
  });

  it('leaves alone what the build did not write: the manifest, the icons, the worker, an unknown asset', () => {
    expect(plan(get(`${ORIGIN}/manifest.webmanifest`))).toBe('bypass');
    expect(plan(get(`${ORIGIN}/icons/icon-192.png`))).toBe('bypass');
    expect(plan(get(`${ORIGIN}/sw.js`))).toBe('bypass');
    expect(plan(get(`${ORIGIN}/assets/not-built-999.js`))).toBe('bypass');
  });

  it('leaves alone anything but a GET, as a write is never a shell file', () => {
    expect(plan({ url: `${ORIGIN}/assets/index-abc123.js`, method: 'POST', mode: 'cors' })).toBe(
      'bypass',
    );
    expect(plan({ url: `${ORIGIN}/`, method: 'POST', mode: 'navigate' })).toBe('bypass');
  });
});

describe('the shell caches (#668)', () => {
  it('names a cache by the build, under the one prefix', () => {
    expect(shellCacheName('93ed3f68')).toBe(`${SHELL_CACHE_PREFIX}93ed3f68`);
  });

  it("deletes every other build's shell cache and nothing that is not a shell cache", () => {
    const names = [
      'dfai-shell-old1',
      'dfai-shell-new',
      'dfai-shell-old2',
      'dfai-read-cache',
      'other',
    ];
    expect(staleShellCaches(names, 'dfai-shell-new')).toEqual([
      'dfai-shell-old1',
      'dfai-shell-old2',
    ]);
  });

  it('precaches the hashed assets and the page, sorted, and not the worker, manifest or icons', () => {
    const built = [
      'index.html',
      'sw.js',
      'manifest.webmanifest',
      'icons/icon-192.png',
      'assets/index-abc.js',
      'assets/worker-def.js',
      'assets/sqlite3-ghi.wasm',
      'assets/index-jkl.css',
    ];
    expect(precacheList(built)).toEqual([
      '/assets/index-abc.js',
      '/assets/index-jkl.css',
      '/assets/sqlite3-ghi.wasm',
      '/assets/worker-def.js',
      '/index.html',
    ]);
  });

  it('precaches a file whose name needs encoding as the browser asks for it, so the two match', () => {
    const list = precacheList(['assets/my file-abc.js', 'assets/ünïcode-def.css']);
    expect(list).toEqual([
      '/assets/%C3%BCn%C3%AFcode-def.css',
      '/assets/my%20file-abc.js',
      '/index.html',
    ]);
    const precached = new Set(list);
    const asked = { url: `${ORIGIN}/assets/my%20file-abc.js`, method: 'GET', mode: 'cors' };
    expect(fetchPlan(asked, { origin: ORIGIN, precached })).toBe('shell');
  });
});

describe('when the app says Update ready (#668)', () => {
  it('offers once a worker is waiting behind the one controlling the page', () => {
    expect(offersUpdate({ controlled: true, waiting: true })).toBe(true);
  });

  it('never on the first visit, where the first worker installs with nothing to update from', () => {
    expect(offersUpdate({ controlled: false, waiting: true })).toBe(false);
  });

  it('never while the new worker is still installing', () => {
    expect(offersUpdate({ controlled: true, waiting: false })).toBe(false);
  });
});
