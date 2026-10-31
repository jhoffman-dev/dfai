import { defineConfig } from '@playwright/test';
import e2e from './playwright.config.ts';

/**
 * `pnpm shots`: the app screenshotted for Phase 16's side-by-side judging
 * (design/README.md). The e2e config's per-checkout port, server and engine,
 * pointed at the shots specs, one per surface, which the e2e suite never runs.
 */
export default defineConfig({
  ...e2e,
  testDir: './tools/design/shots',
  testMatch: '*.shots.spec.ts',
  fullyParallel: false,
  workers: 1,
});
