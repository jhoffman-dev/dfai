// The GitHub API stand-in and the vault over it, for tests outside this package:
// the two-Macs harness's web writer (#665). Test code; the app never loads it.
export {
  FAKE_TOKEN,
  FAKE_VAULT,
  FakeGitHub,
  memoryGitObjects,
} from '../github/fake-github.test-support.ts';
export type {
  Commit,
  CommitAuthor,
  Entries,
  GitObjects,
} from '../github/fake-github.test-support.ts';
export { vaultOver } from '../github/github-vault.test-support.ts';
