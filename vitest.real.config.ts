import { defineConfig } from 'vitest/config';
import root from './vitest.config.ts';

/**
 * The tests against real GitHub (#664), which the root config leaves out:
 * run only by the hand-started `github-vault-real` workflow, with its secret.
 */
export default defineConfig({
  ...root,
  test: {
    ...root.test,
    include: ['packages/*/src/**/*.real.test.ts'],
    exclude: [],
    coverage: { enabled: false },
  },
});
