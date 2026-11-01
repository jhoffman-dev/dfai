import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  fakeGitHub,
  type FakeGitHub,
} from './fake-github.test-support.ts';
import { githubOAuth } from './github-oauth.ts';
import { authHandler } from './handler.ts';
import { nodeListener } from './node-listener.ts';

/** The web build's origin, as the function is configured for it in tests. */
export const ORIGIN = 'https://dailyflowai-web.web.app';

export interface ServedFunction {
  readonly base: string;
  readonly github: FakeGitHub;
  close(): Promise<void>;
}

/**
 * The sign-in function served over real HTTP on a loopback port, as Node
 * would run it, with GitHub faked: nothing leaves this machine.
 */
export async function serveFunction(): Promise<ServedFunction> {
  const github = fakeGitHub();
  const listener = nodeListener(
    authHandler({
      config: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, origin: ORIGIN },
      github: githubOAuth({
        fetch: github.fetch,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      }),
    }),
  );
  const server: Server = createServer((req, res) => void listener(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    github,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
