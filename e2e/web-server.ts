import { spawn } from 'node:child_process';

/** How long the server has to say where it listens: it takes well under a second. */
const START_TIMEOUT_MS = 15_000;

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
  const stop = () =>
    new Promise<void>((resolve) => {
      // Already gone (it failed to start, or was stopped): there is no exit left to wait for.
      if (server.exitCode !== null || server.signalCode !== null) return resolve();
      server.once('exit', () => resolve());
      server.kill();
    });
  try {
    return { url: await listeningUrl(server), stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** The URL the server prints once it listens, read by whole lines: a chunk may end mid-line. */
function listeningUrl(server: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let pending = '';
    const timer = setTimeout(
      () => reject(new Error(`The web server did not start within ${START_TIMEOUT_MS} ms.`)),
      START_TIMEOUT_MS,
    );
    server.stdout?.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const port = /http:\/\/localhost:(\d+)/.exec(line)?.[1];
        if (port === undefined) continue;
        clearTimeout(timer);
        resolve(`http://localhost:${port}`);
      }
    });
    server.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`The web server exited with ${String(code)}.`));
    });
  });
}
