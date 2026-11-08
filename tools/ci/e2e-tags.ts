/*
 * Which tagged end-to-end tests a run leaves out (playwright.config.ts).
 *
 * `@mac` tests check what only macOS WebKit does, so they run only on a Mac
 * (e2e/platform.ts). `@quarantine` tests are flaky ones with an open issue
 * (e2e/quarantine.ts, #799): the gate leaves them out, and the gate's
 * non-blocking `quarantine` job runs them alone. A test tagged both runs in
 * the macOS nightly's quarantine step, and the Linux job lists it with
 * `--list` to check its issue, so it is never left out everywhere.
 */

export interface TagFilter {
  readonly grep?: RegExp;
  readonly grepInvert?: RegExp;
}

export const QUARANTINE_TAG = '@quarantine';

/**
 * `leave-out`: the gate's run, without quarantined tests. `only`: the
 * quarantined tests this platform can run. `list`: every quarantined test,
 * every platform's, for `--list` alone: it would run `@mac` ones off a Mac.
 */
export type QuarantineMode = 'leave-out' | 'only' | 'list';

/** The mode `E2E_QUARANTINE` asks for: `only`, `list`, or anything else for the gate's. */
export function quarantineMode(fromEnv: string | undefined): QuarantineMode {
  return fromEnv === 'only' || fromEnv === 'list' ? fromEnv : 'leave-out';
}

/** The config's `grep` and `grepInvert` for a run on `platform` in `quarantine` mode. */
export function tagFilter({
  platform,
  quarantine,
}: {
  readonly platform: NodeJS.Platform;
  readonly quarantine: QuarantineMode;
}): TagFilter {
  const left = [
    ...(platform === 'darwin' || quarantine === 'list' ? [] : ['@mac']),
    ...(quarantine === 'leave-out' ? [QUARANTINE_TAG] : []),
  ];
  return {
    ...(quarantine === 'leave-out' ? {} : { grep: new RegExp(`${QUARANTINE_TAG}\\b`) }),
    ...(left.length === 0 ? {} : { grepInvert: new RegExp(`(${left.join('|')})\\b`) }),
  };
}
