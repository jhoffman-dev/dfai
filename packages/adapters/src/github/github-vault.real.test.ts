import { createVaultPath as p } from '@dfai/domain';
import { isChangedOnDiskRefusal } from '@dfai/application';
import { describe, expect, it } from 'vitest';
import { gitHubApi } from './github-api.ts';
import { gitBranch } from './git-branch.ts';
import { gitHubVaultFs } from './github-vault-fs.ts';

/**
 * #664: the GitHub vault against real GitHub, on a throwaway private
 * repository. It runs only in the `github-vault-real` workflow, started by
 * hand, where the secret DFAI_TEST_VAULT_TOKEN (a fine-grained token with
 * Contents read and write on that one repository) and the variable
 * DFAI_TEST_VAULT_REPO (`owner/repo`) are set. Everywhere else, the gate
 * and agents included, it is skipped and nothing leaves the machine.
 */
const token = process.env.DFAI_TEST_VAULT_TOKEN ?? '';
const [owner = '', repo = ''] = (process.env.DFAI_TEST_VAULT_REPO ?? '').split('/');
const branch = process.env.DFAI_TEST_VAULT_BRANCH || 'main';

describe.skipIf(token === '' || owner === '' || repo === '')(
  'the GitHub vault on real GitHub',
  () => {
    it(
      'creates, saves, refuses a stale save, moves and trashes, each a commit',
      { timeout: 120_000 },
      async () => {
        const api = gitHubApi({
          fetch: globalThis.fetch,
          token: {
            tokenForRequest: async () => token,
            rejected: async () => {
              throw new Error('the test token was refused');
            },
          },
          clock: { now: () => Date.now() },
        });
        const vault = 'github:test';
        const fs = gitHubVaultFs({ branch: gitBranch(api, { owner, repo, branch }), vault });
        const folder = `dfai-real-run-${process.env.GITHUB_RUN_ID ?? 'local'}`;
        const note = p(`${folder}/Larkspur.md`);
        await fs.createFolder({ vault, path: p(folder) });
        const text = '﻿# Larkspur\r\nCRLF kept\r\nno last newline';
        const created = await fs.createNote({ vault, path: note, contents: text });
        expect(await fs.readTextFile(note)).toEqual({ text, modified: created });
        const saved = await fs.writeTextFile({
          vault,
          path: note,
          contents: `${text}\n`,
          expectedModified: created,
        });
        const stale = await fs
          .writeTextFile({ vault, path: note, contents: 'stale', expectedModified: created })
          .catch((error: unknown) => error);
        expect(isChangedOnDiskRefusal(stale)).toBe(true);
        expect((await fs.readTextFile(note)).modified).toBe(saved);
        await fs.moveEntry({ vault, from: p(folder), to: p(`${folder}-moved`) });
        expect((await fs.readTextFile(p(`${folder}-moved/Larkspur.md`))).text).toBe(`${text}\n`);
        await fs.trashEntry({ vault, path: p(`${folder}-moved`) });
        await expect(fs.listDirectory(p(`${folder}-moved`))).rejects.toThrow('no such entry');
      },
    );
  },
);
