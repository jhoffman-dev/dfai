import { describe, expect, it } from 'vitest';
import { failed, OK, said, scriptedGit, type GitScript } from '../testing/fake-git.ts';
import { jsonMarkdown } from '../testing/settings-vault.ts';
import { automationsOnGitHub } from './automations-on-github.ts';

const markdown = jsonMarkdown();
const STUDIO = '---\n{"automationsMac":"mac-studio","automationsMacName":"Studio"}\n---\n';

/** GitHub, as the last fetch left it, holds the branch and the note, unless a test says otherwise. */
const read = (script: GitScript) =>
  automationsOnGitHub({
    git: scriptedGit({
      script: {
        remoteBranchExists: said('f'.repeat(40)),
        remoteSettingsExist: OK,
        remoteSettings: said(STUDIO),
        ...script,
      },
    }).git,
    markdown,
  });

describe('automationsOnGitHub: who GitHub’s settings name, as the last fetch left them (#630 attack)', () => {
  it('reads the one settings blob of origin/<branch checked out>, listing no tree', async () => {
    const { git, called } = scriptedGit({
      script: {
        currentBranch: said('notes\n'),
        remoteBranchExists: said('f'.repeat(40)),
        remoteSettingsExist: OK,
        remoteSettings: said(STUDIO),
      },
    });

    await expect(automationsOnGitHub({ git, markdown })).resolves.toEqual({
      automationsMac: 'mac-studio',
      automationsMacName: 'Studio',
    });
    expect(called('remoteSettings').map((call) => call.args)).toEqual(['notes']);
    expect(called('tree')).toEqual([]);
  });

  it('names no Mac when GitHub holds no settings note, by git’s exit code, whatever its words (#630 round 2)', async () => {
    const { git, called } = scriptedGit({
      script: {
        remoteBranchExists: said('f'.repeat(40)),
        // A git in another language says it in its own words.
        remoteSettingsExist: failed('fatal: le chemin n’existe pas', 128),
      },
    });
    await expect(automationsOnGitHub({ git, markdown })).resolves.toEqual({
      automationsMac: null,
      automationsMacName: null,
    });
    expect(called('remoteSettings')).toEqual([]);
  });

  it('throws when the branch is not on GitHub yet: an unpushed branch is a read that failed', async () => {
    await expect(read({ remoteBranchExists: failed('', 1) })).rejects.toThrow();
  });

  it('throws when the blob cannot be read, though git said it was there', async () => {
    await expect(
      read({ remoteSettings: failed("fatal: path '.atlas/settings.md' does not exist", 128) }),
    ).rejects.toThrow();
  });

  it('throws when the branch, the blob or its frontmatter cannot be read', async () => {
    await expect(read({ currentBranch: said('') })).rejects.toThrow();
    await expect(
      read({ remoteSettings: failed("fatal: invalid object name 'origin/main'.", 128) }),
    ).rejects.toThrow();
    await expect(
      read({ remoteSettings: failed('not the branch checked out', 1) }),
    ).rejects.toThrow();
    await expect(read({ remoteSettings: said('---\n{ not json\n---\n') })).rejects.toThrow(
      /can't be read/,
    );
  });
});
