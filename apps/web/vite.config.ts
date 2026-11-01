import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { nodeBuiltinsReport } from '../../tools/ci/node-builtins-report.ts';
import { devSignIn } from '../../tools/vite/dev-sign-in.ts';
import { workspaceAliases } from '../../tools/vite/workspace-aliases.ts';

/** What the build drew in of Node, for `pnpm check:node-builtins` (#53), as the desktop's does. */
const nodeBuiltins = nodeBuiltinsReport(fileURLToPath(new URL('../../', import.meta.url)));

/** index.html's policy as it ships. */
const WEB_CSP =
  "script-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'";

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
        "script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-src 'none'; object-src 'none'; base-uri 'none'",
      ),
  };
}

/**
 * The web build (#656): the shared shell, composed in `src/composition.ts`,
 * for a browser. A stub for now — what the desktop build adds for its own
 * host (pdf.js's files, the chunk table) joins as the web build needs it.
 */
export default defineConfig({
  // `pnpm dev` answers the sign-in function's routes itself (#663); a build has none of it.
  plugins: [react(), devCsp(), devSignIn(), nodeBuiltins.window],
  worker: { plugins: () => [nodeBuiltins.worker] },
  resolve: { alias: workspaceAliases() },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // An iPad's Safari, as the desktop's webview is Safari's engine (ADR-0051).
    target: 'safari17',
  },
  clearScreen: false,
});
