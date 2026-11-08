/*
 * The end-to-end spec files a pull request adds or changes, which the gate's
 * `e2e-new` job runs ten times over before they merge (#799): a new test that
 * fails one time in ten is caught while its author is still on it, not weeks
 * later on someone else's pull request.
 *
 * Only spec files: a change to a helper in e2e/ reaches too many specs to
 * repeat them all. The specs keep to the Playwright projects that match them
 * (playwright.config.ts), so an `.ipad.spec.ts` repeats on the iPad's screen.
 */

const SPEC = /^e2e\/.+\.spec\.ts$/;

/**
 * The changed paths that are e2e spec files and still exist, in order, once
 * each. `exists` answers for the checkout: a deleted spec has nothing to run.
 */
export function changedSpecs(
  changedPaths: readonly string[],
  exists: (path: string) => boolean,
): string[] {
  return [...new Set(changedPaths)].filter((path) => SPEC.test(path) && exists(path));
}
