import type { MarkdownPort } from '../notes/ports.ts';
import { settingsOfText } from '../settings/index.ts';
import { currentBranch, expectOk } from './git-steps.ts';
import type { GitPort } from './ports.ts';
import { syncSettingsOf } from './sync-settings.ts';

/** Who the vault's settings on GitHub name, as the last fetch brought them. */
export interface AutomationsOnGitHub {
  /** The Mac named, by id; null when GitHub's settings name none, or GitHub has no settings note. */
  readonly automationsMac: string | null;
  /** That Mac's name, to show. */
  readonly automationsMacName: string | null;
}

/** The git steps the read takes: all local, on what the last fetch left in `refs/remotes/origin/<branch>`. */
export type GitHubSettingsGit = Pick<
  GitPort,
  'currentBranch' | 'remoteBranchExists' | 'remoteSettingsExist' | 'remoteSettings'
>;

/**
 * What the settings note on GitHub says of who runs the automations, as the
 * last fetch left `origin/<branch>` (#630 attack): the other Mac's last word,
 * which a claim written here and not pushed has not changed. One blob, read
 * by the host's narrow `cat-file blob refs/remotes/origin/<branch>:.atlas/settings.md`,
 * never a listing of the tree. Read from git, so it holds across a restart
 * and a vault switch. Throws when it cannot be read; the gates then count a
 * claim as not shared.
 */
export async function automationsOnGitHub({
  git,
  markdown,
}: {
  git: GitHubSettingsGit;
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'frontmatterProblem'>;
}): Promise<AutomationsOnGitHub> {
  const branch = await currentBranch(git);
  // A branch not on GitHub yet has no word from the other Mac: a read that failed, not "none named".
  expectOk('find this branch on GitHub', await git.remoteBranchExists(branch));
  // Asked by exit code, so a git that speaks another language is read the same (#630 round 2).
  if ((await git.remoteSettingsExist(branch)).code !== 0) {
    return { automationsMac: null, automationsMacName: null };
  }
  const text = expectOk('read the settings GitHub holds', await git.remoteSettings(branch));
  const { automationsMac, automationsMacName } = syncSettingsOf(settingsOfText(markdown, text));
  return { automationsMac, automationsMacName };
}
