import { build, defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { nodeBuiltinsReport } from '../../tools/ci/node-builtins-report.ts';
import { devSignIn } from '../../tools/vite/dev-sign-in.ts';
import { serviceWorker } from '../../tools/vite/service-worker.ts';
import { workspaceAliases } from '../../tools/vite/workspace-aliases.ts';

/** What the build drew in of Node, for `pnpm check:node-builtins` (#53), as the desktop's does. */
const nodeBuiltins = nodeBuiltinsReport(fileURLToPath(new URL('../../', import.meta.url)));

/** An iPad's Safari, as the desktop's webview is Safari's engine (ADR-0051). */
const TARGET = 'safari17';

/** index.html's policy as it ships. */
const WEB_CSP =
  "script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://api.github.com; frame-src 'none'; object-src 'none'; base-uri 'none'";

/**
 * `pnpm dev` only: Vite's client runs an inline preamble for React's refresh
 * and talks to its server over a socket, which the shipped policy refuses.
 */
function devCsp(): Plugin {
  return {
    name: 'dfai-web-dev-csp',
    apply: 'serve',
    transformIndexHtml: (html) =>
      html.replace(
        WEB_CSP,
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self' https://api.github.com ws: wss:; frame-src 'none'; object-src 'none'; base-uri 'none'",
      ),
  };
}

/**
 * The web build (#656): the shared shell, composed in `src/composition.ts`,
 * for a browser. A stub for now — what the desktop build adds for its own
 * host (pdf.js's files, the chunk table) joins as the web build needs it.
 */
export default defineConfig(({ command }) => ({
  define: { __DFAI_WEB_BUILD__: JSON.stringify(command === 'build') },
  // `pnpm dev` answers the sign-in function's routes itself (#663); a build has none of it.
  plugins: [
    react(),
    devCsp(),
    devSignIn(),
    nodeBuiltins.window,
    // The app shell's service worker (#668), for the Home Screen and for opening offline.
    serviceWorker({
      entry: fileURLToPath(new URL('./src/pwa/service-worker.ts', import.meta.url)),
      target: TARGET,
      bundle: build,
    }),
  ],
  // The index worker is a module (#666/#667): SQLite's WebAssembly build loads as one, and Vite's
  // dependency prebundling would move its .wasm away from the script that fetches it.
  worker: { format: 'es', plugins: () => [nodeBuiltins.worker] },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  resolve: { alias: workspaceAliases() },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: TARGET,
  },
  clearScreen: false,
}));
