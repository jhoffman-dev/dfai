import type { VaultLocation } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { IndexPorts, NotePorts, OnHost, VaultPorts } from '@dfai/shell';
import { SESSION_VAULT, sessionVaultFs } from './session-vault.ts';
import { sessionIndex, sessionVaultStore } from './session-stores.ts';

/**
 * The web stub's vault (#656): a few notes held for the page's session, so
 * the shell draws a real vault with no host behind it. The GitHub vault
 * (#664) and the browser's index (#666) take its place.
 */

export const SAMPLE_LOCATION: VaultLocation = { absolutePath: SESSION_VAULT, name: 'Sample vault' };

export const SAMPLE_NOTES: Readonly<Record<string, string>> = {
  'Welcome.md': '# Welcome\n\nThis is DFAI in a browser, on a vault held in memory.\n',
  'Larkspur garden.md': '# Larkspur garden\n\n- [ ] Ask Mara Quill about the seed order\n',
};

/** Every port the shell reads the vault through, on one copy of the sample notes. */
export function sampleVault(): {
  vault: OnHost<VaultPorts>;
  notes: OnHost<NotePorts>;
  index: OnHost<IndexPorts>;
} {
  const fs = sessionVaultFs(SAMPLE_NOTES);
  return {
    vault: {
      fs,
      picker: { pickDirectory: async () => SAMPLE_LOCATION },
      store: sessionVaultStore(SAMPLE_LOCATION),
      // Nothing but the page writes the session's vault, so there is nothing to watch for.
      watch: { start: async () => {}, onChange: async () => () => {} },
    },
    notes: { fs, markdown: remarkMarkdown },
    // On the window's thread: a sample this small needs no worker, and the browser's index brings its own (#666).
    index: { fs, index: sessionIndex(), markdown: remarkMarkdown },
  };
}
