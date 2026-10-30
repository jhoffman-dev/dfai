import { test as base } from '@playwright/test';
import { stubBugsRecorded, stubBugsSince } from './stub-bugs.ts';
import { removeTempFolders, tempFoldersMade } from './temp-folders.ts';

export { expect, type Browser, type Locator, type Page } from '@playwright/test';

/**
 * Playwright's `test`, which removes the temp folders the host helpers made: a
 * test's own once it has finished, passed or failed, and those a `beforeAll`
 * made for the tests after it once the worker ends. It also fails a test during
 * which the stub host went wrong (stub-bugs.ts). Specs import it from here.
 */
export const test = base.extend<
  { removesTestTempFolders: void; failsOnStubBugs: void },
  { removesWorkerTempFolders: void }
>({
  removesTestTempFolders: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern; it has none.
    async ({}, use) => {
      const before = tempFoldersMade();
      await use();
      await removeTempFolders(before);
    },
    { auto: true },
  ],
  failsOnStubBugs: [
    // eslint-disable-next-line no-empty-pattern -- as above.
    async ({}, use) => {
      const before = stubBugsRecorded();
      await use();
      const bugs = stubBugsSince(before);
      if (bugs !== null) throw new Error(bugs);
    },
    { auto: true },
  ],
  removesWorkerTempFolders: [
    // eslint-disable-next-line no-empty-pattern -- as above.
    async ({}, use) => {
      await use();
      await removeTempFolders();
    },
    { scope: 'worker', auto: true },
  ],
});
