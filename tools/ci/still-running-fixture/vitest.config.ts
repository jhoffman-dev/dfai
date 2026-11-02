import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Threads, so the hung worker ends with the run. The run still-running-reporter.test.ts starts and stops: one file that never ends.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: { include: ['never-ends.fixture.ts'], pool: 'threads' },
});
