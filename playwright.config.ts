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
  projects: [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }],
  webServer: {
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
  },
});
