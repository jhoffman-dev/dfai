import { dirname, relative } from 'node:path';
import type { FullConfig, TestCase } from '@playwright/test/reporter';

/*
 * How the CI reporters name a Playwright test: its file from the repository's
 * root, its title under its `describe`s, and its project.
 */

/**
 * Where paths start: the config file's folder, the repository's root. Not
 * `config.rootDir`, which is the test folder (`e2e`): keyed from there, no
 * file matched its recorded duration and every file cost the same (#716).
 */
export function repositoryRoot(config: FullConfig): string {
  return config.configFile === undefined ? process.cwd() : dirname(config.configFile);
}

/** `file` from `root`, with forward slashes. */
export function pathFrom(root: string, file: string): string {
  return relative(root, file).split('\\').join('/');
}

/** The test's title under its `describe`s, as the list reporter prints it. */
export function titleOf(test: TestCase): string {
  const titles = [test.title];
  for (let suite = test.parent; suite.type === 'describe'; suite = suite.parent!) {
    titles.unshift(suite.title);
  }
  return titles.join(' › ');
}

/** The Playwright project the test ran in: `webkit`, `ipad` or `phone`. */
export const projectOf = (test: TestCase): string => test.parent.project()?.name ?? '';
