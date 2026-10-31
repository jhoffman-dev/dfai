/*
 * Whether a change touches nothing the tests or the build read, so the gate can
 * skip its slow jobs for it (.github/workflows/gate.yml, the `changes` job).
 *
 * A path is listed here only if no test, no build and no script opens it. That
 * is why this is narrower than "every Markdown file": the vault's types and
 * the fixtures are Markdown the tests read, and two folders of vault/docs are
 * pinned by tests of their own. Format still runs on a docs-only change.
 */

/** Read by tests: the API's route table and the meeting-import contract. */
const TESTED_DOCS = ['vault/docs/api/', 'vault/docs/contracts/'];

const DOCS_FOLDERS = ['docs/', 'vault/docs/', '.claude/agents/'];

const isRootMarkdown = (path: string) => !path.includes('/') && path.endsWith('.md');

function isDocs(path: string): boolean {
  if (TESTED_DOCS.some((folder) => path.startsWith(folder))) return false;
  if (path === 'LICENSE' || isRootMarkdown(path)) return true;
  return DOCS_FOLDERS.some((folder) => path.startsWith(folder));
}

/**
 * True when every changed path is documentation. A change with no paths is not
 * docs-only: nothing is known about it, so everything runs.
 */
export function isDocsOnlyChange(changedPaths: readonly string[]): boolean {
  return changedPaths.length > 0 && changedPaths.every(isDocs);
}
