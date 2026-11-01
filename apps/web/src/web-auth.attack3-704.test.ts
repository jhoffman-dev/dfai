import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeWebAuth } from './web-auth.ts';

/**
 * #663, PR #704's third attack: the web build's clock is
 * performance.timeOrigin + performance.now(). In Safari (iPadOS and macOS)
 * performance.now() does not advance while the device sleeps, so a page that
 * slept runs behind real time by as long as it slept. A fake page models
 * that: `wake(ms)` moves real time on and leaves performance.now() where it
 * was. No network: fetch is a fake of the sign-in function.
 */

const T0 = Date.UTC(2026, 10, 1, 21, 0, 0);
const HOUR = 60 * 60_000;

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    key: () => null,
    getItem: (key) => items.get(key) ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

interface Tab {
  page: Window;
  readonly posts: string[];
  /** Awake time: performance.now() and real time both move. */
  awake(ms: number): void;
  /** Asleep: real time moves, performance.now() does not (Safari). */
  sleep(ms: number): void;
  navigatedTo: string | null;
}

/** Real time is the wall clock (Date.now), faked; each tab's performance.now() is its own. */
const moveRealTime = (ms: number) => vi.setSystemTime(Date.now() + ms);

/** A Safari tab loaded at `loadedAt` real time, sharing `session` with the tab before it. */
function safariTab(loadedAt: number, session: Storage): Tab {
  vi.setSystemTime(loadedAt);
  let monotonic = 0;
  let tokens = 0;
  const tab: Tab = {
    posts: [],
    navigatedTo: null,
    awake: (ms) => {
      monotonic += ms;
      moveRealTime(ms);
    },
    sleep: moveRealTime,
    page: {} as Window,
  };
  const fetchFake = async (input: RequestInfo | URL) => {
    const path = String(input);
    tab.posts.push(path);
    tokens += 1;
    return new Response(JSON.stringify({ accessToken: `ghu_t${tokens}`, expiresIn: 8 * 3600 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  tab.page = {
    localStorage: memoryStorage(),
    sessionStorage: session,
    setTimeout: (go: () => void) => {
      go();
      return 0;
    },
    crypto: globalThis.crypto,
    fetch: fetchFake,
    location: { assign: (url: string) => (tab.navigatedTo = url) },
    navigator: { locks: { request: (_name: string, task: () => unknown) => task() } },
    performance: { timeOrigin: loadedAt, now: () => monotonic },
  } as unknown as Window;
  return tab;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.stubGlobal('BroadcastChannel', undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the web clock after an iPad sleeps (Safari pauses performance.now)', () => {
  it('does not hand out an 8-hour token as fresh after a 9-hour sleep', async () => {
    const tab = safariTab(T0, memoryStorage());
    const auth = composeWebAuth(tab.page);
    await auth.restore('');
    expect(auth.state().status).toBe('signed-in');
    expect(tab.posts).toEqual(['/api/auth/refresh']);

    tab.awake(10 * 60_000);
    tab.sleep(9 * HOUR); // Real time is now past the token's expiry.
    const token = await auth.tokenForRequest();

    // Observed: 'ghu_t1', the expired token, with no refresh asked for.
    expect(token).not.toBe('ghu_t1');
    expect(tab.posts).toEqual(['/api/auth/refresh', '/api/auth/refresh']);
  });

  it('redeems a callback that came back within a minute, after the tab had slept before Sign in was pressed', async () => {
    const session = memoryStorage();
    // Signed-out screen loaded in the evening; the iPad sleeps overnight; Sign in in the morning.
    const evening = safariTab(T0, session);
    evening.awake(60_000);
    evening.sleep(10 * HOUR);
    const morningAt = T0 + 60_000 + 10 * HOUR;
    await composeWebAuth(evening.page).signIn();
    const state = new URL(evening.navigatedTo ?? '', 'https://dfai.example.com').searchParams.get(
      'state',
    );
    expect(state).toBeTruthy();

    // GitHub sends the person back 30 s later, to a freshly loaded page.
    const callback = safariTab(morningAt + 30_000, session);
    const auth = composeWebAuth(callback.page);
    await auth.restore(`?code=abc123&state=${state}`);

    // Observed: the pending sign-in's startedAt is 10 h behind real time, so the callback is 'stale'.
    expect(callback.posts[0]).toBe('/api/auth/token');
    expect(auth.state()).toEqual({ status: 'signed-in' });
  });
});
