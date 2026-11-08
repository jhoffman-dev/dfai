/**
 * Quarantines a flaky test until `issue` is fixed (#799): the gate's e2e
 * shards leave it out (playwright.config.ts), and the gate's non-blocking
 * `quarantine` job runs it alone and lists it, with its issue, in the job's
 * summary. That job goes red when a quarantined test names no issue, or one
 * that is closed, so a test cannot be quarantined and forgotten.
 *
 *   test('saves a note', quarantined(812), async ({ page }) => { ... });
 *
 * Remove it with the fix, in the same change that closes the issue.
 */
export const quarantined = (issue: number) => ({
  tag: '@quarantine',
  annotation: { type: 'quarantine', description: `#${issue}` },
});
