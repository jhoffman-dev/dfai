import { describe, expect, it } from 'vitest';
import { failed, said, scriptedGit, type GitScript } from '../testing/fake-git.ts';
import { jsonMarkdown } from '../testing/settings-vault.ts';
import { automationsOnGitHub } from './automations-on-github.ts';

const OID = 'e'.repeat(40);
const markdown = jsonMarkdown();
const LISTED = said(
  [`100644 blob ${'f'.repeat(40)}\tInbox/a.md`, `100644 blob ${OID}\t.atlas/settings.md`, ''].join(
    '\0',
  ),
);

const read = (script: GitScript) =>
  automationsOnGitHub({ git: scriptedGit({ script }).git, markdown });

describe('automationsOnGitHub: who GitHub’s settings name, as the last fetch left them (#630 attack)', () => {
  it('reads the settings note from origin/<branch>, not from the work tree', async () => {
    const { git, called } = scriptedGit({
      script: {
        currentBranch: said('notes\n'),
        tree: LISTED,
        readBlob: said('---\n{"automationsMac":"mac-studio","automationsMacName":"Studio"}\n---\n'),
      },
    });

    await expect(automationsOnGitHub({ git, markdown })).resolves.toEqual({
      automationsMac: 'mac-studio',
      automationsMacName: 'Studio',
    });
    expect(called('tree').map((call) => call.args)).toEqual([{ kind: 'remote', branch: 'notes' }]);
    expect(called('readBlob').map((call) => call.args)).toEqual([OID]);
  });

  it('names no Mac when GitHub holds no settings note', async () => {
    await expect(read({ tree: said('') })).resolves.toEqual({
      automationsMac: null,
      automationsMacName: null,
    });
  });

  it('throws when the branch, the listing, the blob or its frontmatter cannot be read', async () => {
    await expect(read({ currentBranch: said('') })).rejects.toThrow();
    await expect(
      read({ tree: failed('fatal: not a valid object name origin/main', 128) }),
    ).rejects.toThrow();
    await expect(
      read({ tree: LISTED, readBlob: failed('fatal: bad object', 128) }),
    ).rejects.toThrow();
    await expect(read({ tree: LISTED, readBlob: said('---\n{ not json\n---\n') })).rejects.toThrow(
      /can't be read/,
    );
  });
});
