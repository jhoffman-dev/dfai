import { spawn } from 'node:child_process';

/**
 * A server of the web build (#667) of the test's own, on a free port, that
 * the test can stop. Its own port is its own origin, so what the page keeps
 * in the origin's storage is the test's alone (web-test.ts); and stopping it
 * is "offline" where WebKit's emulation (`setOffline`) fails every load
 * before a service worker sees it (web-install.ipad.spec.ts).
 */
export async function ownWebServer(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = spawn('node', ['tools/serve-dist.mjs'], {
    env: { ...process.env, PORT: '0', DIST_APP: 'web' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    server.stdout.on('data', (chunk: Buffer) => {
      const port = /http:\/\/localhost:(\d+)/.exec(chunk.toString())?.[1];
      if (port !== undefined) resolve(`http://localhost:${port}`);
    });
    server.on('exit', (code) => reject(new Error(`The web server exited with ${String(code)}.`)));
  });
  return {
    url,
    stop: () =>
      new Promise((resolve) => {
        server.once('exit', () => resolve());
        server.kill();
      }),
  };
}
