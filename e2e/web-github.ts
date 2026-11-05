import type { BrowserContext, Page, Route } from '@playwright/test';
import { FakeGitHub } from '../packages/adapters/src/testing/github.ts';
import { recordStubBug } from './stub-bugs.ts';

/**
 * The web build (#667) as the iPad opens it, served by its own server, with
 * the two things it reaches past its page answered in the test: the sign-in
 * function's routes, as `pnpm dev` answers them (tools/vite/dev-sign-in.ts),
 * and GitHub's API, by the stand-in the adapters' tests use. Nothing leaves
 * the machine: both are fulfilled in the browser before any request is sent.
 */
export const WEB_URL = process.env.DFAI_WEB_E2E_URL ?? '';
const DEV_TOKEN = 'dev-only-token';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface WebVaultOnGitHub {
  readonly github: FakeGitHub;
  /** GitHub out of reach: every request, or only the commits ('writes'). */
  readonly unreachable: (cut: boolean | 'writes') => void;
  /** The sign-in function out of reach, as GitHub may be: the session then waits on the network. */
  readonly signInUnreachable: (cut: boolean) => void;
}

export async function webVaultOnGitHub(
  page: Page,
  files: Readonly<Record<string, string>>,
): Promise<WebVaultOnGitHub> {
  const github = new FakeGitHub({ files });
  github.tokens.add(DEV_TOKEN);
  let cut: boolean | 'writes' = false;
  let signInCut = false;
  await refuseLeavingTheMachine(page.context());
  await answerSignIn(page.context(), () => signInCut);
  await page.context().route('https://api.github.com/**', async (route) => {
    // GitHub out of reach while the browser still says online: a captive Wi-Fi, say.
    const asked = route.request();
    // 'writes': GitHub answers who is signed in and what is there, but no commit gets through.
    if (cut === true || (cut === 'writes' && asked.method() !== 'GET'))
      return route.abort('internetdisconnected');
    await answerAsGitHub(route, github);
  });
  return {
    github,
    unreachable: (off) => (cut = off),
    signInUnreachable: (off) => (signInCut = off),
  };
}

/**
 * Any request for a host past this machine, other than GitHub's API (which
 * the fake answers), is a bug in the test's set-up or the app: it is refused
 * and recorded, so the test fails (fixtures.ts) rather than reaching out.
 * Registered first, so the routes after it take what they answer.
 */
async function refuseLeavingTheMachine(context: BrowserContext) {
  await context.route(
    (url) => !LOOPBACK.has(url.hostname),
    async (route) => {
      recordStubBug(new Error(`a request left the machine: ${route.request().url()}`));
      await route.abort('blockedbyclient');
    },
  );
}

/** The API's routes the fake answers; a request for any other is a stub bug, not GitHub's 404. */
const GITHUB_ROUTES = [
  /^\/user$/,
  /^\/user\/installations$/,
  /^\/user\/installations\/\d+\/repositories$/,
  /^\/repos\/[^/]+\/[^/]+\/git\/(ref|refs)\/heads\/.+$/,
  /^\/repos\/[^/]+\/[^/]+\/git\/(blobs|trees|commits)(\/[0-9a-f]+)?$/,
];

/**
 * GitHub's answer, from the fake, with a refusal in the shape GitHub sends
 * one: its message, where the docs are, and the status as a string. A crash
 * in the fake is recorded as a stub bug and the request fails, as a request
 * the fake has no route for does.
 */
async function answerAsGitHub(route: Route, github: FakeGitHub) {
  const asked = route.request();
  const { pathname } = new URL(asked.url());
  if (!GITHUB_ROUTES.some((known) => known.test(pathname))) {
    recordStubBug(new Error(`the fake GitHub has no route for ${asked.method()} ${pathname}`));
    return route.abort('failed');
  }
  try {
    const body = asked.postData();
    const answer = await github.fetch(asked.url(), {
      method: asked.method(),
      headers: await asked.allHeaders(),
      ...(body !== null && { body }),
    });
    await route.fulfill({
      status: answer.status,
      headers: Object.fromEntries(answer.headers),
      body: answer.ok ? await answer.text() : asGitHubRefuses(answer.status, await answer.text()),
    });
  } catch (thrown) {
    recordStubBug(thrown instanceof Error ? thrown : new Error(String(thrown)));
    await route.abort('failed');
  }
}

/** A refusal as GitHub's REST API words it: `{ message, documentation_url, status }`. */
function asGitHubRefuses(status: number, body: string): string {
  const { message } = JSON.parse(body) as { message: string };
  return JSON.stringify({
    message,
    documentation_url: 'https://docs.github.com/rest',
    status: String(status),
  });
}

async function answerSignIn(context: BrowserContext, unreachable: () => boolean) {
  let signedIn = false;
  const grant = { accessToken: DEV_TOKEN, expiresIn: 8 * 60 * 60 };
  // On whichever loopback server the page is: the shared one, or a test's own (web-test.ts).
  const isSignIn = (url: URL) =>
    LOOPBACK.has(url.hostname) && url.pathname.startsWith('/api/auth/');
  await context.route(isSignIn, async (route) => {
    if (unreachable()) return route.abort('internetdisconnected');
    const url = new URL(route.request().url());
    const asked = `${route.request().method()} ${url.pathname}`;
    if (asked === 'GET /api/auth/start') {
      const back = new URLSearchParams({ code: 'dev', state: url.searchParams.get('state') ?? '' });
      // Straight back, as GitHub would after a yes; WebKit fulfils no redirect, so a refresh says it.
      const to = `/auth/callback?${back.toString().replaceAll('&', '&amp;')}`;
      await route.fulfill({
        contentType: 'text/html',
        body: `<meta http-equiv="refresh" content="0;url=${to}">`,
      });
    } else if (
      asked === 'POST /api/auth/token' ||
      (asked === 'POST /api/auth/refresh' && signedIn)
    ) {
      signedIn = true;
      await route.fulfill({ status: 200, json: grant });
    } else if (asked === 'POST /api/auth/signout') {
      signedIn = false;
      await route.fulfill({ status: 204 });
    } else await route.fulfill({ status: 401, json: { error: 'no-session' } });
  });
}

/** Opens the web build (at `url`, the shared server's by default) and signs in, by touch, landing on the vault. */
export async function signInOnTheWeb(page: Page, url = WEB_URL) {
  await page.goto(url);
  await page.getByRole('button', { name: 'Sign in with GitHub' }).tap();
  await page.getByRole('button', { name: 'Sign out' }).waitFor();
}
