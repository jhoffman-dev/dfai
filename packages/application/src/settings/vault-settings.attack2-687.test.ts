/**
 * Second attack on PR #687 (#683): a settings note whose frontmatter block
 * never closes is now refused on write — but read, it still says nothing, so
 * every setting in it quietly reads as its default.
 */
import { describe, expect, it } from 'vitest';
import { jsonMarkdown, vaultWith } from '../testing/settings-vault.ts';
import { UnclosedFrontmatterError } from '../query/set-property.ts';
import { readVaultSettings, saveVaultSettings } from './vault-settings.ts';

const PATH = '.atlas/settings.md';
/** The closing `---` deleted by hand: the block opens and never ends. */
const UNCLOSED = '---\n{"quickAdd": ["task"]}\n\n# Settings\n';

describe('a settings note whose block never closes (attack 2 on #687)', () => {
  it('refuses a write, leaving the file as it was', async () => {
    const { fs, written } = vaultWith({ [PATH]: UNCLOSED });
    await expect(
      saveVaultSettings({ fs, markdown: jsonMarkdown(), changes: { quickAdd: ['note'] } }),
    ).rejects.toThrow(UnclosedFrontmatterError);
    expect(written[PATH]).toBe(UNCLOSED);
  });

  // readVaultSettings documents that reading an unreadable file as empty "would quietly
  // put every setting in it back to its default" — an unclosed block did exactly that,
  // until #683 refused it as unreadable.
  it('names the settings note when it is read, rather than reading every setting as its default', async () => {
    const { fs } = vaultWith({ [PATH]: UNCLOSED });
    await expect(readVaultSettings({ fs, markdown: jsonMarkdown() })).rejects.toThrow(PATH);
  });

  it('refuses a required read too, as a vault that syncs needs its settings', async () => {
    const { fs } = vaultWith({ [PATH]: UNCLOSED });
    await expect(
      readVaultSettings({ fs, markdown: jsonMarkdown(), required: true }),
    ).rejects.toThrow(PATH);
  });
});
