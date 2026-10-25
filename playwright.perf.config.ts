import { defineConfig, devices } from '@playwright/test';
import e2e from './playwright.config.ts';

/**
 * The app's response times on the 2,000-note fixture vault (#217), with the
 * e2e config's per-checkout port and server, one test at a time so nothing
 * else shares the main thread with the one being timed.
 *
 * - `latency` (`pnpm perf`): timed in WebKit, the engine the app ships in, and
 *   held to the budgets. This is what CI runs.
 * - `profile` (`pnpm perf:profile`): the same actions under Chromium's CPU
 *   profiler, which WebKit lacks, to name where the time went.
 * - `renders` (`pnpm perf:renders`): in WebKit, how many components each
 *   action draws again, beside its time and longest frame.
 * - `budgets` (`pnpm perf:budgets`): in WebKit, the work each action makes the
 *   app do, as counts, held to `tools/perf/budgets.json`. CI runs it too.
 * - `semantic` (`pnpm perf:semantic`): in WebKit, the first build of the cache
 *   of meanings over 50,000 blocks, held to no frame over 50 ms, and a search
 *   by meaning over them, timed (P32-02). Minutes long; run by hand.
 */
export default defineConfig({
  ...e2e,
  testDir: './tools/perf',
  fullyParallel: false,
  workers: 1,
  projects: [
    { name: 'latency', testMatch: 'ui-latency.spec.ts', use: { ...devices['Desktop Safari'] } },
    { name: 'profile', testMatch: 'profile.spec.ts', use: { ...devices['Desktop Chrome'] } },
    { name: 'renders', testMatch: 'renders.spec.ts', use: { ...devices['Desktop Safari'] } },
    { name: 'budgets', testMatch: 'budgets.spec.ts', use: { ...devices['Desktop Safari'] } },
    { name: 'semantic', testMatch: 'semantic.spec.ts', use: { ...devices['Desktop Safari'] } },
  ],
});
