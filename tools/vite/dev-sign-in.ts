import type { IncomingMessage, ServerResponse } from 'node:http';

/*
 * `pnpm dev` of the web build only (#663): the sign-in function's four
 * routes, answered by the dev server, so the sign-in screen can be passed on
 * this machine without GitHub or a deployed function. The token it grants
 * reaches nothing. `apply: 'serve'` keeps it out of every build.
 */

const DEV_TOKEN = 'dev-only-token';
const COOKIE = '__session=dev';
const ATTRIBUTES = 'Path=/api/auth; HttpOnly; SameSite=Strict';

function json(res: ServerResponse, status: number, body: unknown, cookie?: string) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (cookie) res.setHeader('Set-Cookie', cookie);
  res.end(body === null ? '' : JSON.stringify(body));
}

const grant = { accessToken: DEV_TOKEN, expiresIn: 8 * 60 * 60 };

/** One request to /api/auth/*, as the function would answer it, minus GitHub. */
export function answerDevSignIn(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://dev.invalid');
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /api/auth/start') {
    // Straight back, as GitHub would after the person said yes.
    const back = new URLSearchParams({ code: 'dev', state: url.searchParams.get('state') ?? '' });
    res.statusCode = 302;
    res.setHeader('Location', `/auth/callback?${back}`);
    res.end();
  } else if (route === 'POST /api/auth/token') {
    json(res, 200, grant, `${COOKIE}; ${ATTRIBUTES}`);
  } else if (route === 'POST /api/auth/refresh') {
    const signedIn = (req.headers.cookie ?? '').split(/;\s*/).includes(COOKIE);
    if (signedIn) json(res, 200, grant);
    else json(res, 401, { error: 'no-session' });
  } else if (route === 'POST /api/auth/signout') {
    json(res, 204, null, `__session=; Max-Age=0; ${ATTRIBUTES}`);
  } else {
    json(res, 404, { error: 'refused' });
  }
}

/** The part of Vite's plugin shape this needs: tools/ has no Vite of its own to import. */
interface DevServerPlugin {
  readonly name: string;
  readonly apply: 'serve';
  configureServer(server: {
    middlewares: {
      use(handle: (req: IncomingMessage, res: ServerResponse, next: () => void) => void): unknown;
    };
  }): void;
}

export function devSignIn(): DevServerPlugin {
  return {
    name: 'dfai-web-dev-sign-in',
    apply: 'serve',
    configureServer: (server) => {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? '').startsWith('/api/auth/')) answerDevSignIn(req, res);
        else next();
      });
    },
  };
}
