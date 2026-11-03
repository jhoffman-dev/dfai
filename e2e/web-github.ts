import type { BrowserContext, Page } from '@playwright/test';
import { FakeGitHub } from '../packages/adapters/src/testing/github.ts';

/**
 * The web build (#667) as the iPad opens it, served by its own server, with
 * the two things it reaches past its page answered in the test: the sign-in
 * function's routes, as `pnpm dev` answers them (tools/vite/dev-sign-in.ts),
 * and GitHub's API, by the stand-in the adapters' tests use. Nothing leaves
 * the machine: both are fulfilled in the browser before any request is sent.
 */
export const WEB_URL = process.env.DFAI_WEB_E2E_URL ?? '';
const DEV_TOKEN = 'dev-only-token';

export async function webVaultOnGitHub(
  page: Page,
  files: Readonly<Record<string, string>>,
): Promise<{ github: FakeGitHub; unreachable: (cut: boolean) => void }> {
  const github = new FakeGitHub({ files });
  github.tokens.add(DEV_TOKEN);
  let cut = false;
  await answerSignIn(page.context());
  await page.context().route('https://api.github.com/**', async (route) => {
    // GitHub out of reach while the browser still says online: a captive Wi-Fi, say.
    if (cut) return route.abort('internetdisconnected');
    const asked = route.request();
    const body = asked.postData();
    const answer = await github.fetch(asked.url(), {
      method: asked.method(),
      headers: await asked.allHeaders(),
      ...(body !== null && { body }),
    });
    await route.fulfill({
      status: answer.status,
      headers: Object.fromEntries(answer.headers),
      body: await answer.text(),
    });
  });
  return { github, unreachable: (off) => (cut = off) };
}

async function answerSignIn(context: BrowserContext) {
  let signedIn = false;
  const grant = { accessToken: DEV_TOKEN, expiresIn: 8 * 60 * 60 };
  await context.route(`${WEB_URL}/api/auth/**`, async (route) => {
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

/** Opens the web build and signs in, by touch, landing on the vault. */
export async function signInOnTheWeb(page: Page) {
  await page.goto(WEB_URL);
  await page.getByRole('button', { name: 'Sign in with GitHub' }).tap();
  await page.getByRole('button', { name: 'Sign out' }).waitFor();
}
