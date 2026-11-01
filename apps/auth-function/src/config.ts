/*
 * What the sign-in function is told about where it runs (#663, ADR-0052).
 * The client secret arrives from Secret Manager as an environment variable
 * at run time; nothing here is committed but the variables' names.
 */

export interface AuthFunctionConfig {
  /** The GitHub App's client id. Public, but kept here so the web build holds no GitHub settings. */
  readonly clientId: string;
  /** The GitHub App's client secret. Never logged, never sent anywhere but GitHub. */
  readonly clientSecret: string;
  /** The web build's origin, e.g. https://dailyflowai-web.web.app: the only one it answers. */
  readonly origin: string;
}

export const ENV = {
  clientId: 'GITHUB_APP_CLIENT_ID',
  clientSecret: 'GITHUB_APP_CLIENT_SECRET',
  origin: 'DFAI_WEB_ORIGIN',
} as const;

/** The page GitHub sends the person back to, on the web build's origin. */
export const CALLBACK_PATH = '/auth/callback';

const NO_SPACE = /^\S+$/;

/** An https origin and nothing more: no path, no query, no credentials. */
function isOrigin(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.origin === text;
  } catch {
    return false;
  }
}

/** The config from the environment, or an error naming every variable missing or wrong. */
export function readConfig(env: Readonly<Record<string, string | undefined>>): AuthFunctionConfig {
  const clientId = env[ENV.clientId] ?? '';
  const clientSecret = env[ENV.clientSecret] ?? '';
  const origin = env[ENV.origin] ?? '';
  const wrong = [
    NO_SPACE.test(clientId) ? null : ENV.clientId,
    NO_SPACE.test(clientSecret) ? null : ENV.clientSecret,
    isOrigin(origin) ? null : `${ENV.origin} (an https origin, no path)`,
  ].filter((name): name is string => name !== null);
  if (wrong.length > 0)
    throw new Error(`the sign-in function is not configured: ${wrong.join(', ')}`);
  return { clientId, clientSecret, origin };
}
