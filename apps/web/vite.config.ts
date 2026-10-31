import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { workspaceAliases } from '../../tools/vite/workspace-aliases.ts';

/**
 * The web build (#656): the shared shell, composed in `src/composition.ts`,
 * for a browser. A stub for now — what the desktop build adds for its own
 * host (pdf.js's files, the chunk table, the Node check) joins as the web
 * build needs it.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias: workspaceAliases() },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // An iPad's Safari, as the desktop's webview is Safari's engine (ADR-0051).
    target: 'safari17',
  },
  clearScreen: false,
});
