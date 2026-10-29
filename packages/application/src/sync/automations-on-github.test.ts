import { describe, expect, it } from 'vitest';
import { failed, said, scriptedGit, type GitScript } from '../testing/fake-git.ts';
import { jsonMarkdown } from '../testing/settings-vault.ts';
import { automationsOnGitHub } from './automations-on-github.ts';

const markdown = jsonMarkdown();
const STUDIO = '---\n{"automationsMac":"mac-studio","automationsMacName":"Studio"}\n---\n';

const read = (script: GitScript) =>
  automationsOnGitHub({ git: scriptedGit({ script }).git, markdown });

describe('automationsOnGitHub: who GitHub’s settings name, as the last fetch left them (#630 attack)', () => {
  it('reads the one settings blob of origin/<branch checked out>, listing no tree', async () => {
    const { git, called } = scriptedGit({
      script: { currentBranch: said('notes\n'), remoteSettings: said(STUDIO) },
    });

    await expect(automationsOnGitHub({ git, markdown })).resolves.toEqual({
      automationsMac: 'mac-studio',
      automationsMacName: 'Studio',
    });
    expect(called('remoteSettings').map((call) => call.args)).toEqual(['notes']);
    expect(called('tree')).toEqual([]);
  });

  it('names no Mac when GitHub holds no settings note', async () => {
    const missing = failed("fatal: path '.atlas/settings.md' does not exist in 'origin/main'", 128);
    await expect(read({ remoteSettings: missing })).resolves.toEqual({
      automationsMac: null,
      automationsMacName: null,
    });
    const onlyHere = failed(
      "fatal: path '.atlas/settings.md' exists on disk, but not in 'origin/main'",
      128,
    );
    await expect(read({ remoteSettings: onlyHere })).resolves.toEqual({
      automationsMac: null,
      automationsMacName: null,
    });
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
