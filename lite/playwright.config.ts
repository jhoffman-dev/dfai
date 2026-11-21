import { defineConfig, devices } from '@playwright/test';

/** One Chromium project against the built app, served as it ships (`vite preview` over `dist`). */
export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? 'line' : 'list',
  use: { baseURL: 'http://localhost:4791', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm exec vite preview',
    url: 'http://localhost:4791',
    // Never reuse: a server already on the port may be another worktree's build.
    reuseExistingServer: false,
  },
});
