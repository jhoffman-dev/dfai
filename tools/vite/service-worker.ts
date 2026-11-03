import { createHash } from 'node:crypto';
import { precacheList } from '../../apps/web/src/pwa/shell-rules.ts';

/**
 * Emits the web build's service worker beside its page (#668): the worker's
 * source is bundled on its own, handed the build's file list to precache and
 * a version that changes with it, and written to `sw.js` at the site's root.
 * Only a build has it; `pnpm dev` registers nothing.
 */

/** One build's shell, as a name: the same files give the same version, so a redeploy of the same build changes nothing. */
export function shellVersion(precache: readonly string[], page: string): string {
  return createHash('sha256')
    .update(JSON.stringify([...precache].sort()))
    .update(page)
    .digest('hex')
    .slice(0, 16);
}

/** Vite's `build`, handed in by the config: the tools are typechecked without Vite's types, as dev-sign-in.ts is. */
export type Bundler = (options: {
  configFile: false;
  logLevel: 'warn';
  define: Record<string, string>;
  build: {
    target: string;
    write: false;
    emptyOutDir: false;
    lib: { entry: string; formats: ['iife']; name: string; fileName: () => string };
  };
}) => Promise<unknown>;

/** The one chunk a worker build writes, as far as the plugin reads it. */
const builtCode = (result: unknown): string | null => {
  const first: unknown = Array.isArray(result) ? result[0] : result;
  if (typeof first !== 'object' || first === null || !('output' in first)) return null;
  const chunk: unknown = Array.isArray(first.output) ? first.output[0] : null;
  if (typeof chunk !== 'object' || chunk === null || !('code' in chunk)) return null;
  return typeof chunk.code === 'string' ? chunk.code : null;
};

/** What the plugin is handed by the build it runs in, as far as it reads. */
interface Bundle {
  readonly [fileName: string]: { readonly type: 'asset' | 'chunk'; readonly source?: unknown };
}

interface BuildPlugin {
  readonly name: string;
  readonly apply: 'build';
  readonly enforce: 'post';
  generateBundle(
    this: { emitFile(file: { type: 'asset'; fileName: string; source: string }): unknown },
    options: unknown,
    bundle: Bundle,
  ): Promise<void>;
}

/** The worker's source, with the build's list and version in place of its declared globals. */
export async function bundleWorker({
  entry,
  precache,
  version,
  target,
  bundle,
}: {
  entry: string;
  precache: readonly string[];
  version: string;
  target: string;
  bundle: Bundler;
}): Promise<string> {
  const result = await bundle({
    configFile: false,
    logLevel: 'warn',
    // Both as string literals: the bundler reads a list literal here as a value and writes it back joined.
    define: {
      __DFAI_PRECACHE__: JSON.stringify(JSON.stringify(precache)),
      __DFAI_SHELL_VERSION__: JSON.stringify(version),
    },
    build: {
      target,
      write: false,
      emptyOutDir: false,
      lib: { entry, formats: ['iife'], name: 'dfaiShellWorker', fileName: () => 'sw.js' },
    },
  });
  const code = builtCode(result);
  if (code === null) throw new Error('The service worker build wrote no code.');
  return code;
}

export function serviceWorker({
  entry,
  target,
  bundle,
}: {
  entry: string;
  target: string;
  bundle: Bundler;
}): BuildPlugin {
  return {
    name: 'dfai-web-service-worker',
    apply: 'build',
    // After Vite's own html plugin has emitted the page, so the version covers it.
    enforce: 'post',
    async generateBundle(_options, built) {
      const page = built['index.html'];
      const pageSource = page !== undefined && page.type === 'asset' ? String(page.source) : '';
      const precache = precacheList(Object.keys(built));
      const version = shellVersion(precache, pageSource);
      const source = await bundleWorker({ entry, precache, version, target, bundle });
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}
