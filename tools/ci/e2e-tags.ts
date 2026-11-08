/*
 * Which tagged end-to-end tests a run leaves out (playwright.config.ts).
 *
 * `@mac` tests check what only macOS WebKit does, so they run only on a Mac
 * (e2e/platform.ts). `@quarantine` tests are flaky ones with an open issue
 * (e2e/quarantine.ts, #799): the gate leaves them out, and the gate's
 * non-blocking `quarantine` job runs them alone, with `E2E_QUARANTINE=only`.
 */

export interface TagFilter {
  readonly grep?: RegExp;
  readonly grepInvert?: RegExp;
}

export const QUARANTINE_TAG = '@quarantine';

/** The config's `grep` and `grepInvert` for a run on `platform`: quarantined tests alone, or without them. */
export function tagFilter({
  platform,
  quarantinedOnly,
}: {
  readonly platform: NodeJS.Platform;
  readonly quarantinedOnly: boolean;
}): TagFilter {
  const left = [
    ...(platform === 'darwin' ? [] : ['@mac']),
    ...(quarantinedOnly ? [] : [QUARANTINE_TAG]),
  ];
  return {
    ...(quarantinedOnly ? { grep: new RegExp(`${QUARANTINE_TAG}\\b`) } : {}),
    ...(left.length === 0 ? {} : { grepInvert: new RegExp(`(${left.join('|')})\\b`) }),
  };
}
