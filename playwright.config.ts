import { defineConfig, devices } from '@playwright/test';

/**
 * The port this checkout's end-to-end server listens on.
 *
 * Agents work in git worktrees, and every worktree used to share 4173. Refusing
 * to reuse a running server stopped one checkout silently testing another's
 * build, but not the contention: a suite run against a busy port took nearly
 * eight minutes and failed six tests that pass in sixteen seconds on their own.
 *
 * So each checkout gets its own port, derived from where it lives on disk. The
 * same checkout always gets the same port, and two checkouts almost never share
 * one — and when they do, `reuseExistingServer: false` below makes that a loud
 * refusal to start rather than a quiet wrong answer. `E2E_PORT` overrides it.
 */
function portFor(checkout: string): number {
  const fromEnv = Number(process.env.E2E_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;

  let hash = 0x811c9dc5;
  for (const character of checkout) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0;
  }
  // 4173..4972: clear of the dev server on 1420 and the usual suspects.
  return 4173 + (hash % 800);
}

// `testDir` below is already relative to the working directory, which is the
// checkout's root when the suite runs, so the port is keyed on the same thing.
const PORT = portFor(process.cwd());
const BASE_URL = `http://localhost:${PORT}`;
/** The web build's own server (#667), next to the desktop's: its pages live at its origin's root. */
const WEB_PORT = PORT + 1;
process.env.DFAI_WEB_E2E_URL = `http://localhost:${WEB_PORT}`;

/** The specs the `ipad` project runs, and only it. */
const IPAD_SPECS = /\.ipad\.spec\.ts$/;
/** The specs the `phone` project runs, and only it (#672). */
const PHONE_SPECS = /\.phone\.spec\.ts$/;

/** The desktop build's server, which every spec but the web build's runs against. */
export const DESKTOP_SERVER = {
  // A plain Node server rather than `vite preview` behind a package-manager
  // wrapper: the wrapper's child outlives Playwright's teardown, and the CI
  // step then hangs after every test has already passed.
  command: 'node tools/serve-dist.mjs',
  url: BASE_URL,
  env: { PORT: String(PORT) },
  // Never reuse a server already on this port. Agents work in git worktrees
  // that share it, and a reused server serves *that* worktree's `dist` — so a
  // run silently tests someone else's build and fails in ways the code cannot
  // explain. This has cost hours. Refusing to start is the loud failure; the
  // server takes well under a second, so there is little to reuse.
  reuseExistingServer: false,
  timeout: 60_000,
};

/**
 * The core loop, driven in WebKit — the same engine the Tauri window uses on macOS.
 * Tauri's own WebDriver support does not cover macOS, so these tests run the real
 * built frontend against a stand-in host (see e2e/host.ts). The Rust half has its
 * own tests in apps/desktop/src-tauri.
 */
export default defineConfig({
  testDir: './e2e',
  // A temp folder of the run's own, removed when it ends (issue #397).
  globalSetup: './tools/temp-folder-per-run.ts',
  fullyParallel: true,
  // A test tagged `@mac` checks what only macOS WebKit does (its text system,
  // its editing keys), so it runs only there: on a Mac here, and in CI in the
  // nightly macOS run (e2e-macos-nightly.yml), not in the gate's Linux shards.
  ...(process.platform === 'darwin' ? {} : { grepInvert: /@mac\b/ }),
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      testIgnore: [IPAD_SPECS, PHONE_SPECS],
    },
    {
      // An iPad on its side (#661): WebKit with a touch screen, which is what
      // makes it answer `(pointer: coarse)`. Not `isMobile`: that starts a
      // worker of its own and changes what the viewport means (#659). It runs
      // only the `.ipad.spec.ts` smoke, so the gate's shards grow by one test.
      name: 'ipad',
      use: {
        ...devices['Desktop Safari'],
        viewport: { width: 1180, height: 820 },
        hasTouch: true,
        // The web specs answer GitHub and the sign-in function with routes, and WebKit's
        // routes never reach a page the web build's service worker (#668) controls: its
        // requests leave through the worker. So no worker here, except where a spec allows
        // one to test the worker itself (web-install.ipad.spec.ts).
        serviceWorkers: 'block',
      },
      testMatch: IPAD_SPECS,
    },
    {
      // A phone held upright (#672): WebKit at an iPhone's 390×844 with a touch
      // screen, as the `ipad` project above and for the same reasons — a coarse
      // pointer from `hasTouch`, no `isMobile`, no service worker. It runs only
      // the `.phone.spec.ts` specs, on the web build.
      name: 'phone',
      use: {
        ...devices['Desktop Safari'],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        serviceWorkers: 'block',
      },
      testMatch: PHONE_SPECS,
    },
  ],
  webServer: [
    DESKTOP_SERVER,
    {
      // The web build, for the `.ipad.spec.ts` and `.phone.spec.ts` specs that run it (#667, #672); as above in every way.
      command: 'node tools/serve-dist.mjs',
      url: `http://localhost:${WEB_PORT}`,
      env: { PORT: String(WEB_PORT), DIST_APP: 'web' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
