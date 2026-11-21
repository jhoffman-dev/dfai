import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/** UI tests run in jsdom; everything else in plain Node, which is quicker and keeps the DOM out of the rules. */
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
          exclude: ['src/ui/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['src/ui/**/*.test.{ts,tsx}'],
          setupFiles: ['./vitest.setup.ts'],
        },
      },
    ],
  },
});
