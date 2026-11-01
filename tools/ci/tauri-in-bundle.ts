/**
 * What of Tauri reached a built bundle that must have none: the web build
 * (#656). ESLint keeps Tauri out of the shell's and the web's source; this
 * reads what the bundler actually emitted, so a path round the rule (a
 * barrel, a transitive import) is caught where it lands.
 */

/** Strings only Tauri's runtime or its IPC carry: its globals, its IPC host, its scheme. */
export const TAURI_MARKERS = ['__TAURI', 'ipc.localhost', 'tauri://'] as const;

export type TauriFinding = { readonly file: string; readonly marker: string };

/** Every marker found, by the file it was found in. */
export function tauriInBundle(
  sources: readonly { readonly file: string; readonly source: string }[],
): TauriFinding[] {
  return sources.flatMap(({ file, source }) =>
    TAURI_MARKERS.filter((marker) => source.includes(marker)).map((marker) => ({ file, marker })),
  );
}

/** What fails the web bundle: no script to check at all, which a check must never pass, or Tauri in one. */
export function webBundleProblems(
  sources: readonly { readonly file: string; readonly source: string }[],
): string[] {
  if (!sources.some(({ file }) => /\.m?js$/.test(file)))
    return ['The web build has no script to check: build it first (`pnpm build`).'];
  return tauriInBundle(sources).map(describeTauriFinding);
}

export function describeTauriFinding({ file, marker }: TauriFinding): string {
  return `${file} carries "${marker}": Tauri reached the web build (#656). Find the import that brought it in.`;
}
