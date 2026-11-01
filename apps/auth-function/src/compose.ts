import { readConfig } from './config.ts';
import { githubOAuth } from './github-oauth.ts';
import { authHandler } from './handler.ts';
import { nodeListener } from './node-listener.ts';

/**
 * The sign-in function, composed from the environment (#663). The Firebase
 * wrapper hands each request to what this returns; see the ADR-0052 to-do
 * for the one line that needs `firebase-functions`.
 */
export function authListener(
  env: Readonly<Record<string, string | undefined>>,
  fetch: typeof globalThis.fetch = globalThis.fetch,
) {
  const config = readConfig(env);
  const github = githubOAuth({
    fetch,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });
  return nodeListener(authHandler({ config, github }));
}
